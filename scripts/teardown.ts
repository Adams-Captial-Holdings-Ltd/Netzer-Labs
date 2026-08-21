/**
 * Netzar OS Enterprise — teardown (IaC readiness plan, items 23–26).
 *
 * Orchestration only: every decision and mutation primitive lives in
 * scripts/lib/lifecycle/teardown-plan.ts with injected clients and unit
 * tests. This file wires real AWS clients, prompts, and ordering.
 *
 * Flags:
 *   --dry-run                 full plan + costed summary, ZERO mutations
 *   --export-first            actually run the printed DDB export commands
 *                             before anything is destroyed
 *   --cryptographic-erasure   allow KMS disable + ScheduleKeyDeletion for
 *                             keys with zero live encrypted dependents
 *   --delete-shared-prereqs   unlock deletion of the GitHub OIDC provider /
 *                             CodeBuild source credential AFTER a dependents
 *                             scan + extra typed confirmation
 *   --env=staging|prod        which .env file to load (deploy.ts rules)
 *
 * Execution order (item 23): DDB export offer → empty+delete versioned
 * buckets → schedule-delete secrets (7-day window) → delete runtime EB
 * schedules (BEFORE their CDK-owned group's stack) → cdk destroy --all /
 * direct DeleteStack for orphans → KMS decisions → final residual sweep,
 * with the bootstrap primitives (state bucket, lock table, ECR repo)
 * deleted last because teardown itself runs on them.
 */

import { existsSync, readFileSync } from 'node:fs';
import { hostname, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CloudFormation } from '@aws-sdk/client-cloudformation';
import { CloudWatchLogs } from '@aws-sdk/client-cloudwatch-logs';
import { DynamoDB, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { IAM } from '@aws-sdk/client-iam';
import { KMS } from '@aws-sdk/client-kms';
import { S3, S3Client } from '@aws-sdk/client-s3';
import { Scheduler } from '@aws-sdk/client-scheduler';
import { SecretsManager } from '@aws-sdk/client-secrets-manager';
import { STS } from '@aws-sdk/client-sts';
import { bold, dim, fail, gray, info, ok, red, section, warn, yellow } from './lib/ansi.js';
import { maybePrintHelp } from './lib/help.js';
import { envFileNameFor, parseEnvFile, resolveEnvFlag } from './lib/env-file.js';
import { ask, closePrompt } from './lib/prompt.js';
import { capture, run } from './lib/shell.js';
import { cloudBuildNames } from './lib/lifecycle/cloud-build.js';
import { resolveStateNames, type StateNames } from './lib/lifecycle/bootstrap-state.js';
import { readLatestManifest } from './lib/lifecycle/journal.js';
import {
  acquireLock,
  releaseLock,
  type AwsClientLike,
  type LockHandle,
} from './lib/lifecycle/lock.js';
import type { DeployManifest } from './lib/lifecycle/manifest.js';
import {
  buildTeardownPlan,
  checkTypedConfirmation,
  codebuildGithubProjects,
  confirmationString,
  createRunner,
  currentAppStackNames,
  ddbExportCommands,
  deleteOrphanStacks,
  deleteRuntimeSchedules,
  emptyAndDeleteVersionedBucket,
  eraseKmsKey,
  findKmsDependents,
  kmsDeletionDecision,
  listLiveStacks,
  MANUAL_TEARDOWN_CHECKLIST,
  oidcDependentRoles,
  parseCatalog,
  renderRetainedSummary,
  scheduleDeleteSecrets,
  wormResidualNotice,
  type CatalogEntry,
  type CfnClientLike,
  type EncryptedResourceInventory,
  type RetainedItem,
  type S3TeardownClientLike,
  type StepRunner,
  type TeardownPlan,
} from './lib/lifecycle/teardown-plan.js';
import { buildResourceNames, bucketName, TAGS } from '../infra/lib/constants.js';

type EnvBag = Record<string, string | undefined>;

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dir, '..');

// eslint-disable-next-line no-console
const log = (msg = ''): void => console.log(msg);

function loadEnv(argv: string[]): EnvBag {
  const flag = resolveEnvFlag(argv);
  const file = join(REPO_ROOT, envFileNameFor(flag));
  const fromFile = existsSync(file) ? parseEnvFile(readFileSync(file, 'utf8')) : {};
  // Real process env wins over the file, matching deploy.ts.
  return { ...fromFile, ...process.env };
}

function loadCatalog(): CatalogEntry[] {
  const path = join(REPO_ROOT, 'docs', 'out-of-band-catalog.json');
  return parseCatalog(readFileSync(path, 'utf8'));
}

// ─────────────────────────────────────────────────────────────────────
// Inventory gathering (read-only; feeds the plan + costed summary)
// ─────────────────────────────────────────────────────────────────────

interface Inventory {
  buckets: string[]; // app data buckets that exist (state + audit-lock handled separately)
  auditLockBucket: string | null;
  tables: string[];
  secrets: Array<{ name: string; kmsKeyRef?: string }>;
  logGroups: Array<{ name: string; kmsKeyRef?: string }>;
  ecrImageCount: number | null; // null = repo missing
  kmsKeys: Array<{ alias: string; keyId: string }>;
}

async function gatherInventory(opts: {
  s3: S3;
  ddb: DynamoDB;
  secrets: SecretsManager;
  logs: CloudWatchLogs;
  kms: KMS;
  names: StateNames;
  app: string;
  account: string;
  region: string;
  suffix: string;
}): Promise<Inventory> {
  const rn = buildResourceNames(opts.suffix);
  const candidates = [
    rn.configBucket,
    rn.rawBucket,
    rn.curatedBucket,
    rn.vectorsStagingBucket,
    rn.logsBucket,
    rn.extensionsBucket,
  ].map((p) => bucketName(p, opts.account, opts.region));
  const auditLockName = bucketName(rn.auditLockBucket, opts.account, opts.region);

  const buckets: string[] = [];
  for (const b of candidates) {
    try {
      await opts.s3.headBucket({ Bucket: b });
      buckets.push(b);
    } catch {
      /* absent (or not ours) — skip */
    }
  }
  let auditLockBucket: string | null = null;
  try {
    await opts.s3.headBucket({ Bucket: auditLockName });
    auditLockBucket = auditLockName;
  } catch {
    /* tier < 2 deployments have no WORM bucket */
  }

  const tables: string[] = [];
  let lastTable: string | undefined;
  do {
    const page = await opts.ddb.listTables({ ExclusiveStartTableName: lastTable });
    for (const t of page.TableNames ?? []) {
      if (t.startsWith(`${opts.app}-`)) tables.push(t);
    }
    lastTable = page.LastEvaluatedTableName;
  } while (lastTable);

  const secrets: Array<{ name: string; kmsKeyRef?: string }> = [];
  let secretsToken: string | undefined;
  do {
    const page = await opts.secrets.listSecrets({ NextToken: secretsToken });
    for (const s of page.SecretList ?? []) {
      if (s.Name?.startsWith(`/${opts.app}/`)) {
        secrets.push({ name: s.Name, kmsKeyRef: s.KmsKeyId });
      }
    }
    secretsToken = page.NextToken;
  } while (secretsToken);

  const logGroups: Array<{ name: string; kmsKeyRef?: string }> = [];
  let logsToken: string | undefined;
  do {
    const page = await opts.logs.describeLogGroups({
      logGroupNamePrefix: `/${opts.app}`,
      nextToken: logsToken,
    });
    for (const g of page.logGroups ?? []) {
      if (g.logGroupName) logGroups.push({ name: g.logGroupName, kmsKeyRef: g.kmsKeyId });
    }
    logsToken = page.nextToken;
  } while (logsToken);

  let ecrImageCount: number | null = null;
  const imgs = await capture('aws', [
    'ecr', 'list-images', '--repository-name', opts.names.ecrRepo,
    '--region', opts.region, '--output', 'json',
  ]);
  if (imgs.code === 0 && imgs.stdout.trim()) {
    ecrImageCount = ((JSON.parse(imgs.stdout) as { imageIds?: unknown[] }).imageIds ?? []).length;
  }

  const kmsKeys: Array<{ alias: string; keyId: string }> = [];
  let aliasMarker: string | undefined;
  do {
    const page = await opts.kms.listAliases({ Marker: aliasMarker });
    for (const a of page.Aliases ?? []) {
      if (a.AliasName?.startsWith(`alias/${opts.app}-`) && a.TargetKeyId) {
        kmsKeys.push({ alias: a.AliasName, keyId: a.TargetKeyId });
      }
    }
    aliasMarker = page.NextMarker;
  } while (aliasMarker);

  return { buckets, auditLockBucket, tables, secrets, logGroups, ecrImageCount, kmsKeys };
}

async function encryptedInventory(opts: {
  s3: S3;
  ddb: DynamoDB;
  inv: Inventory;
}): Promise<EncryptedResourceInventory> {
  const buckets: EncryptedResourceInventory['buckets'] = [];
  for (const b of [...opts.inv.buckets, ...(opts.inv.auditLockBucket ? [opts.inv.auditLockBucket] : [])]) {
    try {
      const enc = await opts.s3.getBucketEncryption({ Bucket: b });
      const kmsKeyRef =
        enc.ServerSideEncryptionConfiguration?.Rules?.[0]?.ApplyServerSideEncryptionByDefault
          ?.KMSMasterKeyID;
      buckets.push({ name: b, kmsKeyRef });
    } catch {
      buckets.push({ name: b });
    }
  }
  const tables: EncryptedResourceInventory['tables'] = [];
  for (const t of opts.inv.tables) {
    try {
      const d = await opts.ddb.describeTable({ TableName: t });
      tables.push({ name: t, kmsKeyRef: d.Table?.SSEDescription?.KMSMasterKeyArn });
    } catch {
      tables.push({ name: t });
    }
  }
  return { buckets, tables, logGroups: opts.inv.logGroups, secrets: opts.inv.secrets };
}

async function retainedSummary(opts: {
  s3: S3;
  inv: Inventory;
  names: StateNames;
}): Promise<RetainedItem[]> {
  const items: RetainedItem[] = [];
  for (const b of opts.inv.buckets) {
    let qty: number | undefined;
    try {
      const page = await opts.s3.listObjectVersions({ Bucket: b });
      qty = (page.Versions?.length ?? 0) + (page.DeleteMarkers?.length ?? 0);
      if (page.IsTruncated) qty = undefined; // ">1000" — don't pretend precision
    } catch {
      /* counts are best-effort */
    }
    items.push({
      kind: 's3-bucket',
      name: b,
      quantity: qty,
      costNote: 'S3 storage until emptied + deleted',
    });
  }
  if (opts.inv.auditLockBucket) {
    items.push({
      kind: 's3-bucket',
      name: opts.inv.auditLockBucket,
      costNote: 'WORM/Object Lock — INTENTIONAL RESIDUAL, see notice below',
    });
  }
  for (const t of opts.inv.tables) {
    items.push({ kind: 'dynamodb-table', name: t, costNote: 'on-demand tables cost ~storage only when idle' });
  }
  for (const s of opts.inv.secrets) {
    items.push({ kind: 'secret', name: s.name, costNote: '$0.40/month each until the 7-day delete window lapses' });
  }
  for (const g of opts.inv.logGroups) {
    items.push({ kind: 'log-group', name: g.name, costNote: 'ingested-byte storage until retention/deletion' });
  }
  if (opts.inv.ecrImageCount !== null) {
    items.push({
      kind: 'ecr-image',
      name: opts.names.ecrRepo,
      quantity: opts.inv.ecrImageCount,
      costNote: '$0.10/GB-month for stored image layers',
    });
  }
  for (const k of opts.inv.kmsKeys) {
    items.push({ kind: 'kms-key', name: `${k.alias} (${k.keyId})`, costNote: '$1/month per key until scheduled deletion completes' });
  }
  return items;
}

// ─────────────────────────────────────────────────────────────────────
// Shared-prerequisite blast radius (--delete-shared-prereqs)
// ─────────────────────────────────────────────────────────────────────

async function sharedPrereqBlastRadius(iam: IAM, region: string): Promise<{
  providerArn: string | null;
  dependentRoles: string[];
  githubProjects: string[];
}> {
  let providerArn: string | null = null;
  const providers = await iam.listOpenIDConnectProviders({});
  for (const p of providers.OpenIDConnectProviderList ?? []) {
    if (p.Arn?.includes('token.actions.githubusercontent.com')) providerArn = p.Arn;
  }

  const dependentRoles: string[] = [];
  if (providerArn) {
    const roles: Array<{ roleName: string; assumeRolePolicyDocument?: string }> = [];
    let marker: string | undefined;
    do {
      const page = await iam.listRoles({ Marker: marker });
      for (const r of page.Roles ?? []) {
        if (r.RoleName) {
          roles.push({ roleName: r.RoleName, assumeRolePolicyDocument: r.AssumeRolePolicyDocument });
        }
      }
      marker = page.IsTruncated ? page.Marker : undefined;
    } while (marker);
    dependentRoles.push(...oidcDependentRoles(roles, providerArn));
  }

  // @aws-sdk/client-codebuild is not a dependency; the AWS CLI covers this
  // read-only scan (same pattern as the ECR adapter in deploy.ts).
  const githubProjects: string[] = [];
  const list = await capture('aws', ['codebuild', 'list-projects', '--region', region, '--output', 'json']);
  if (list.code === 0 && list.stdout.trim()) {
    const names = (JSON.parse(list.stdout) as { projects?: string[] }).projects ?? [];
    for (let i = 0; i < names.length; i += 100) {
      const batch = names.slice(i, i + 100);
      const got = await capture('aws', [
        'codebuild', 'batch-get-projects', '--names', ...batch, '--region', region, '--output', 'json',
      ]);
      if (got.code === 0 && got.stdout.trim()) {
        const projects = (JSON.parse(got.stdout) as {
          projects?: Array<{ name?: string; source?: { type?: string } }>;
        }).projects ?? [];
        githubProjects.push(
          ...codebuildGithubProjects(
            projects.map((p) => ({ name: p.name ?? '', sourceType: p.source?.type })),
          ),
        );
      }
    }
  }
  return { providerArn, dependentRoles, githubProjects };
}

// ─────────────────────────────────────────────────────────────────────
// Managed-policy teardown (detach everywhere, then delete)
// ─────────────────────────────────────────────────────────────────────

const LIVE_ATTACHED_POLICIES = [
  'CCE-IamCopilot',
  'CCE-Playground-NonAnthropicInvoke',
  'CCE-CostRemediation',
] as const;

async function deleteManagedPolicies(
  iam: IAM,
  account: string,
  runner: StepRunner,
): Promise<void> {
  for (const name of LIVE_ATTACHED_POLICIES) {
    const arn = `arn:aws:iam::${account}:policy/${name}`;
    let exists = true;
    let attachedRoles: string[] = [];
    try {
      const entities = await iam.listEntitiesForPolicy({ PolicyArn: arn });
      attachedRoles = (entities.PolicyRoles ?? []).map((r) => r.RoleName ?? '').filter(Boolean);
    } catch {
      exists = false;
    }
    if (!exists) {
      runner.note(`managed policy ${name}: not present, skipping`);
      continue;
    }
    for (const role of attachedRoles) {
      await runner.mutate(`iam:DetachRolePolicy ${name} from ${role}`, () =>
        iam.detachRolePolicy({ RoleName: role, PolicyArn: arn }),
      );
    }
    // Non-default versions must go before the policy itself.
    await runner.mutate(`iam:DeletePolicy ${arn} (incl. non-default versions)`, async () => {
      const versions = await iam.listPolicyVersions({ PolicyArn: arn });
      for (const v of versions.Versions ?? []) {
        if (!v.IsDefaultVersion && v.VersionId) {
          await iam.deletePolicyVersion({ PolicyArn: arn, VersionId: v.VersionId });
        }
      }
      await iam.deletePolicy({ PolicyArn: arn });
    });
  }
}

// ─────────────────────────────────────────────────────────────────────
// AgentCore MCP gateways (CLI-created, never in CDK — see docs/mcp/)
// ─────────────────────────────────────────────────────────────────────

async function deleteAgentCoreGateways(region: string, runner: StepRunner): Promise<void> {
  const list = await capture('aws', [
    'bedrock-agentcore-control', 'list-gateways', '--region', region, '--output', 'json',
  ]);
  if (list.code !== 0 || !list.stdout.trim()) {
    runner.note('AgentCore gateways: none found (or service unavailable in this region)');
    return;
  }
  const gateways = (JSON.parse(list.stdout) as {
    items?: Array<{ gatewayId?: string; name?: string }>;
  }).items ?? [];
  const ours = gateways.filter((g) => g.name?.startsWith('cce-mcp-gateway') || g.name?.startsWith('cce-'));
  if (ours.length === 0) {
    runner.note('AgentCore gateways: none matching cce-* — nothing to delete');
    return;
  }
  for (const g of ours) {
    await runner.mutate(`bedrock-agentcore:DeleteGateway ${g.name} (${g.gatewayId})`, async () => {
      // Targets first; the gateway refuses deletion while targets exist.
      const targets = await capture('aws', [
        'bedrock-agentcore-control', 'list-gateway-targets',
        '--gateway-identifier', g.gatewayId ?? '', '--region', region, '--output', 'json',
      ]);
      if (targets.code === 0 && targets.stdout.trim()) {
        const items = (JSON.parse(targets.stdout) as { items?: Array<{ targetId?: string }> }).items ?? [];
        for (const t of items) {
          await capture('aws', [
            'bedrock-agentcore-control', 'delete-gateway-target',
            '--gateway-identifier', g.gatewayId ?? '', '--target-id', t.targetId ?? '',
            '--region', region,
          ]);
        }
      }
      await capture('aws', [
        'bedrock-agentcore-control', 'delete-gateway',
        '--gateway-identifier', g.gatewayId ?? '', '--region', region,
      ]);
    });
  }
}

// ─────────────────────────────────────────────────────────────────────
// main
// ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (
    maybePrintHelp(argv, {
      command: 'npm run teardown',
      oneLiner: 'inventoried, ordered destruction with a typed confirm (npm run destroy drives this)',
      flags: [
        ['--env=<name>', 'target .env.<name> instead of .env'],
        ['--dry-run', 'full plan + costed summary; ZERO mutations'],
        ['--export-first', 'run the DDB export commands before anything is destroyed'],
        ['--cryptographic-erasure', 'allow KMS disable + key-deletion scheduling for keys with no live dependents'],
        ['--delete-shared-prereqs', 'also delete the GitHub OIDC provider / CodeBuild credential after a dependents scan'],
      ],
      contract: 'DESTRUCTIVE after its typed confirmation; --dry-run is the safe look.',
      docs: 'docs/lifecycle.md',
    })
  ) {
    return;
  }
  const dryRun = argv.includes('--dry-run');
  const exportFirst = argv.includes('--export-first');
  const cryptographicErasure = argv.includes('--cryptographic-erasure');
  const deleteSharedPrereqs = argv.includes('--delete-shared-prereqs');

  log('\n' + bold(`Netzar OS Enterprise · Teardown${dryRun ? ' (DRY RUN — zero mutations)' : ''}`));
  log(gray('─'.repeat(44)));

  const env = loadEnv(argv);
  const region = env.AWS_REGION ?? 'us-east-1';
  const stackPrefix = env.CDK_STACK_NAME ?? 'CCE';
  // Same suffix derivation as deploy.ts/seed.ts: `--env=staging` implies
  // the `staging` suffix even when .env.staging never sets CCE_NAME_SUFFIX.
  // Without this, a staging teardown would scan and offer to destroy the
  // UNSUFFIXED (prod) retained tables, secrets, log groups, and buckets.
  const envFlag = resolveEnvFlag(argv);
  const suffix = env.CCE_NAME_SUFFIX ?? (envFlag === 'prod' ? '' : envFlag);
  env.CCE_NAME_SUFFIX = suffix;
  const app = suffix ? `claudeclaw-${suffix}` : 'claudeclaw';

  // ── Account echo (edge-case list: wrong-account protection) ───────
  const sts = new STS({ region });
  const identity = await sts.getCallerIdentity({});
  const account = identity.Account ?? '';
  if (!account) {
    log(fail('could not resolve the AWS account from STS — check credentials'));
    process.exitCode = 1;
    return;
  }
  log(info(`account ${bold(account)} · region ${region} · caller ${identity.Arn ?? 'unknown'}`));
  env.AWS_ACCOUNT_ID = env.AWS_ACCOUNT_ID ?? account;
  const names = resolveStateNames(env);

  // ── State bucket: manifest read, or break-glass (item 25) ─────────
  const s3Send = new S3Client({ region });
  let manifest: DeployManifest | null = null;
  let stateBucketAccessible = true;
  try {
    manifest = await readLatestManifest(s3Send as unknown as AwsClientLike, names.stateBucket);
  } catch {
    stateBucketAccessible = false;
  }

  // ── Lifecycle lock (operation 'teardown') when the table exists ───
  const ddbSend = new DynamoDBClient({ region });
  const ddb = new DynamoDB({ region });
  let lock: LockHandle | null = null;
  let lockTableExists = false;
  try {
    const t = await ddb.describeTable({ TableName: names.lockTable });
    lockTableExists = t.Table?.TableStatus === 'ACTIVE';
  } catch {
    lockTableExists = false;
  }
  if (lockTableExists && !dryRun) {
    const owner = `${userInfo().username}@${hostname()}#${process.pid}`;
    try {
      lock = await acquireLock(ddbSend, names.lockTable, {
        owner,
        operation: 'teardown',
        leaseMs: 30 * 60_000,
      });
      log(ok(`lifecycle lock acquired (operation: teardown, fencing token ${lock.fencingToken})`));
    } catch (err) {
      log(fail(err instanceof Error ? err.message : String(err)));
      process.exitCode = 1;
      return;
    }
  } else if (!lockTableExists) {
    // Loud, not fatal: teardown must never strand paid resources behind a
    // lost state store (item 25).
    log(warn(`lifecycle lock SKIPPED — lock table ${names.lockTable} is missing/inactive. ` +
      'Make sure no other operator is deploying right now.'));
  }

  // ── Inventory + plan ───────────────────────────────────────────────
  const cfnSdk = new CloudFormation({ region });
  const cfn: CfnClientLike = {
    describeStacks: (input) => cfnSdk.describeStacks(input),
    deleteStack: (input) => cfnSdk.deleteStack(input),
  };
  const liveStackNames = await listLiveStacks(cfn, {
    stackPrefix,
    appTagValue: TAGS.Application,
  });
  const catalog = loadCatalog();
  const plan: TeardownPlan = buildTeardownPlan({
    account,
    region,
    stateBucket: names.stateBucket,
    stateBucketAccessible,
    manifest: manifest ? { account: manifest.account, stacks: manifest.stacks } : null,
    liveStackNames,
    currentAppStacks: currentAppStackNames(stackPrefix, env),
    catalog,
    lockHeld: lock !== null || dryRun,
  });

  if (plan.banner) log('\n' + red(plan.banner));
  if (plan.accountWarning) log('\n' + yellow(plan.accountWarning));

  section('Destruction plan · CloudFormation stacks (live ∪ manifest, never a fresh synth)');
  for (const s of plan.stacks) {
    const origin = [s.live ? 'live' : 'gone', s.inManifest ? 'manifest' : null].filter(Boolean).join('+');
    log(`  ${s.method === 'skip-already-deleted' ? gray('skip   ') : s.method === 'cdk-destroy' ? 'destroy' : yellow('delete ')} ${s.name} ${dim(`[${origin}; ${s.method}]`)}`);
  }
  if (plan.stacks.length === 0) log(dim('  (no stacks found)'));

  section('Out-of-band resources (docs/out-of-band-catalog.json)');
  for (const e of plan.catalogAppOwned) {
    log(`  ${e.teardown === 'delete' ? 'delete ' : gray('report ')} ${e.id} ${dim(`(${e.kind})`)}`);
  }
  log(dim('  shared account prerequisites (report-only by default):'));
  for (const e of plan.catalogShared) log(`  ${gray('report ')} ${e.id} ${dim(`(${e.kind})`)}`);

  const s3 = new S3({ region });
  const secretsSdk = new SecretsManager({ region });
  const logs = new CloudWatchLogs({ region });
  const kms = new KMS({ region });
  const iam = new IAM({ region });
  const scheduler = new Scheduler({ region });
  const inv = await gatherInventory({
    s3, ddb, secrets: secretsSdk, logs, kms, names, app, account, region, suffix,
  });

  section('Costed summary of RETAINed leftovers');
  for (const line of renderRetainedSummary(await retainedSummary({ s3, inv, names }))) {
    log(`  ${line}`);
  }

  // ── DDB export offer (run only with --export-first) ───────────────
  section('DynamoDB final export (offer)');
  const exportCmds = ddbExportCommands({
    tables: inv.tables.filter((t) => t !== names.lockTable),
    account,
    region,
    bucket: names.stateBucket,
  });
  if (exportCmds.length === 0) {
    log(dim('  no app tables found'));
  } else {
    log(dim('  exports need PITR enabled on the table; run these (or pass --export-first):'));
    for (const cmd of exportCmds) log(dim(`  ${cmd}`));
  }

  // ── KMS preview (item 24) ──────────────────────────────────────────
  section('KMS keys (dependencies, not leftovers)');
  const encInv = await encryptedInventory({ s3, ddb, inv });
  const kmsDecisions = inv.kmsKeys.map((k) => {
    const dependents = findKmsDependents(k.keyId, encInv);
    return { key: k, dependents, decision: kmsDeletionDecision({
      keyRef: k.alias,
      cryptographicErasure,
      dependents,
    }) };
  });
  for (const d of kmsDecisions) {
    log(`  ${d.decision.allowed ? yellow('ERASE  ') : gray('keep   ')} ${d.key.alias}`);
    for (const line of d.decision.reason.split('\n')) log(dim(`      ${line}`));
  }
  if (kmsDecisions.length === 0) log(dim('  (no app KMS aliases found)'));

  // ── WORM notice (item 26) ──────────────────────────────────────────
  if (inv.auditLockBucket) {
    section('Object Lock / WORM');
    for (const line of wormResidualNotice(inv.auditLockBucket).split('\n')) log(`  ${line}`);
  }

  // ── Shared prerequisites: blast radius then extra confirmation ─────
  let sharedScan: Awaited<ReturnType<typeof sharedPrereqBlastRadius>> | null = null;
  if (deleteSharedPrereqs) {
    section('--delete-shared-prereqs · blast radius scan');
    sharedScan = await sharedPrereqBlastRadius(iam, region);
    log(`  GitHub OIDC provider: ${sharedScan.providerArn ?? dim('not found')}`);
    log(`    IAM roles trusting it (${sharedScan.dependentRoles.length}): ${sharedScan.dependentRoles.join(', ') || dim('none')}`);
    log(`  CodeBuild projects on the account GitHub credential (${sharedScan.githubProjects.length}): ${sharedScan.githubProjects.join(', ') || dim('none')}`);
    log(yellow('  Deleting these breaks EVERY listed dependent, including ones unrelated to this app.'));
    log(dim('  The CDK bootstrap stack (CDKToolkit) stays report-only even with this flag.'));
  }

  // ── Confirmations ──────────────────────────────────────────────────
  if (dryRun) {
    log('\n' + info('dry run: stopping before confirmation. No mutations were made.'));
  } else {
    log('');
    const typed = await ask(
      `Type "${confirmationString(account)}" to destroy this deployment:`,
    );
    if (!checkTypedConfirmation(typed, account)) {
      log(fail('confirmation did not match — aborting with no changes'));
      if (lock) await releaseLock(ddbSend, names.lockTable, lock);
      closePrompt();
      process.exitCode = 1;
      return;
    }
    if (plan.requireExtraAccountConfirmation) {
      const again = await ask(
        red('BREAK-GLASS mode: re-type the 12-digit account id to confirm the target account:'),
      );
      if (again.trim() !== account) {
        log(fail('account id did not match — aborting with no changes'));
        if (lock) await releaseLock(ddbSend, names.lockTable, lock);
        closePrompt();
        process.exitCode = 1;
        return;
      }
    }
    if (deleteSharedPrereqs && sharedScan) {
      const extra = await ask(
        red('Type "delete shared prerequisites" to ALSO delete the OIDC provider + CodeBuild credential:'),
      );
      if (extra.trim() !== 'delete shared prerequisites') {
        log(warn('shared prerequisites will be left in place (reported only)'));
        sharedScan = null;
      }
    }
  }

  // ── Execute (item 23 order) ────────────────────────────────────────
  const runner = createRunner(!dryRun);
  const s3Plan: S3TeardownClientLike = {
    listObjectVersions: (input) => s3.listObjectVersions(input),
    deleteObjects: (input) => s3.deleteObjects(input),
    deleteBucket: (input) => s3.deleteBucket(input),
  };

  if (exportFirst && !dryRun) {
    section('DDB export (running, --export-first)');
    for (const cmd of exportCmds) {
      const [bin, ...args] = cmd.split(' ');
      const r = await capture(bin, args);
      log(r.code === 0 ? ok(cmd) : fail(`${cmd}\n${r.stderr}`));
    }
  }

  section(dryRun ? 'Planned actions (dry run)' : 'Executing teardown');

  // 1. Empty + delete versioned app buckets (state bucket waits for the sweep).
  for (const b of inv.buckets) {
    const { versionsDeleted } = await emptyAndDeleteVersionedBucket(s3Plan, b, runner);
    log(ok(`${dryRun ? 'would empty+delete' : 'emptied+deleted'} s3://${b} (${versionsDeleted}${dryRun ? '+' : ''} versions)`));
  }

  // 2. Schedule-delete secrets (7-day recovery window, stated by the step).
  await scheduleDeleteSecrets(secretsSdk, inv.secrets.map((s) => s.name), runner);

  // 3. Runtime EB schedules BEFORE destroying the Messaging stack's group.
  const schedules = await deleteRuntimeSchedules(
    { listSchedules: (i) => scheduler.listSchedules(i), deleteSchedule: (i) => scheduler.deleteSchedule(i) },
    app,
    runner,
  );
  log(ok(`${schedules.length} runtime schedule(s) in group ${app} ${dryRun ? 'would be' : ''} deleted before the stack`));

  // 4. Managed policies + AgentCore gateways (catalog app-owned deletes).
  await deleteManagedPolicies(iam, account, runner);
  await deleteAgentCoreGateways(region, runner);

  // 5. cdk destroy --all for current-app stacks; direct DeleteStack orphans.
  const cdkStacks = plan.stacks.filter((s) => s.method === 'cdk-destroy');
  if (cdkStacks.length > 0) {
    await runner.mutate(`cdk destroy --all --force (${cdkStacks.length} stacks)`, async () => {
      const code = await run('npx', ['cdk', 'destroy', '--all', '--force'], {
        cwd: REPO_ROOT,
        env: { ...process.env, ...Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined)) } as NodeJS.ProcessEnv,
      });
      if (code !== 0) throw new Error(`cdk destroy exited ${code}`);
    });
  }
  await deleteOrphanStacks(cfn, plan.stacks, runner);

  // 6. Shared prerequisites (only past the extra typed confirmation).
  if (sharedScan && !dryRun) {
    if (sharedScan.providerArn) {
      const arn = sharedScan.providerArn;
      await runner.mutate(`iam:DeleteOpenIDConnectProvider ${arn}`, () =>
        iam.deleteOpenIDConnectProvider({ OpenIDConnectProviderArn: arn }),
      );
    }
    await runner.mutate('codebuild:DeleteSourceCredentials (GITHUB, account-level)', async () => {
      const creds = await capture('aws', ['codebuild', 'list-source-credentials', '--region', region, '--output', 'json']);
      if (creds.code === 0 && creds.stdout.trim()) {
        const infos = (JSON.parse(creds.stdout) as { sourceCredentialsInfos?: Array<{ arn?: string; serverType?: string }> }).sourceCredentialsInfos ?? [];
        for (const c of infos) {
          if (c.serverType === 'GITHUB' && c.arn) {
            await capture('aws', ['codebuild', 'delete-source-credentials', '--arn', c.arn, '--region', region]);
          }
        }
      }
    });
  }

  // 7. KMS (item 24): only ALLOWED decisions execute.
  for (const d of kmsDecisions) {
    if (d.decision.allowed) {
      await eraseKmsKey(
        { disableKey: (i) => kms.disableKey(i), scheduleKeyDeletion: (i) => kms.scheduleKeyDeletion(i) },
        d.key.keyId,
        d.decision,
        runner,
      );
    } else {
      runner.note(`KMS ${d.key.alias} kept: ${d.decision.reason.split('\n')[0]}`);
    }
  }

  // 8. Final residual sweep + bootstrap primitives LAST (they are what
  //    teardown itself ran on: manifest bucket, lock table, ECR repo).
  section('Final sweep · bootstrap primitives + residuals');
  // Cloud-build primitives (Docker-free installs): the CodeBuild project,
  // its IAM role, its role policy, and its log group are SDK-created next
  // to the ECR repo, so they are swept here next to it. Every delete
  // tolerates not-found.
  //
  // There are TWO cloud builds, one per ECR repo: the orchestrator's, and
  // the Paperclip image build added in Phase 1.5 (gated on
  // CCE_PAPERCLIP_ENABLED, so absent on unarmed installs). Sweeping only
  // the orchestrator repo would leave `claudeclaw[-suffix]-paperclip-cloud-build`,
  // its role, its role policy and its log group behind forever - the same
  // defect class as the ungated ECR repo (M23) and the catalog-reports-but-
  // does-not-delete gap (M24). The catalog row is a REPORT; this loop is
  // what actually deletes.
  for (const repoName of [names.ecrRepo, buildResourceNames(suffix).paperclipEcrRepo]) {
    const cb = cloudBuildNames(repoName);
    await runner.mutate(`codebuild:DeleteProject ${cb.project} (+ role ${cb.role} + logs)`, async () => {
      const p = await capture('aws', ['codebuild', 'delete-project', '--name', cb.project, '--region', region]);
      if (p.code !== 0 && !/ResourceNotFound/i.test(p.stderr)) throw new Error(p.stderr);
      const rp = await capture('aws', ['iam', 'delete-role-policy', '--role-name', cb.role, '--policy-name', cb.rolePolicy]);
      if (rp.code !== 0 && !/NoSuchEntity/i.test(rp.stderr)) throw new Error(rp.stderr);
      const r = await capture('aws', ['iam', 'delete-role', '--role-name', cb.role]);
      if (r.code !== 0 && !/NoSuchEntity/i.test(r.stderr)) throw new Error(r.stderr);
      const lg = await capture('aws', ['logs', 'delete-log-group', '--log-group-name', cb.logGroup, '--region', region]);
      if (lg.code !== 0 && !/ResourceNotFound/i.test(lg.stderr)) throw new Error(lg.stderr);
    });
  }
  if (inv.ecrImageCount !== null) {
    await runner.mutate(`ecr:DeleteRepository ${names.ecrRepo} --force (${inv.ecrImageCount} images)`, async () => {
      const r = await capture('aws', [
        'ecr', 'delete-repository', '--repository-name', names.ecrRepo, '--force', '--region', region,
      ]);
      if (r.code !== 0) throw new Error(r.stderr);
    });
  }
  // Paperclip work engine (ADR 0010): a SECOND repo, created by deploy
  // phase a only when CCE_PAPERCLIP_ENABLED=1, so it is absent on most
  // installs. It has to be deleted explicitly here: the out-of-band
  // catalog is a REPORT (printed above), not an executor, so a catalog
  // row alone would leave an armed install paying for an orphan repo.
  {
    const paperclipRepo = buildResourceNames(suffix).paperclipEcrRepo;
    await runner.mutate(`ecr:DeleteRepository ${paperclipRepo} --force (if present)`, async () => {
      const r = await capture('aws', [
        'ecr', 'delete-repository', '--repository-name', paperclipRepo, '--force', '--region', region,
      ]);
      if (r.code !== 0 && !/RepositoryNotFound/i.test(r.stderr)) throw new Error(r.stderr);
    });
  }
  // App DDB tables not deleted by stacks (RETAIN'd) — direct deletes.
  for (const t of inv.tables) {
    if (t === names.lockTable) continue;
    await runner.mutate(`dynamodb:DeleteTable ${t} (RETAIN'd by its stack)`, async () => {
      try {
        await ddb.deleteTable({ TableName: t });
      } catch (err) {
        if ((err as { name?: string }).name !== 'ResourceNotFoundException') throw err;
      }
    });
  }
  // Lock released, then its table deleted, then the state bucket last.
  if (lock) {
    const released = await releaseLock(ddbSend, names.lockTable, lock);
    log(released ? ok('lifecycle lock released') : warn('lock lease had lapsed (released by takeover)'));
    lock = null;
  }
  await runner.mutate(`dynamodb:DeleteTable ${names.lockTable} (bootstrap primitive)`, async () => {
    try {
      await ddb.deleteTable({ TableName: names.lockTable });
    } catch (err) {
      if ((err as { name?: string }).name !== 'ResourceNotFoundException') throw err;
    }
  });
  if (stateBucketAccessible) {
    const { versionsDeleted } = await emptyAndDeleteVersionedBucket(s3Plan, names.stateBucket, runner);
    log(ok(`state bucket ${names.stateBucket}: ${versionsDeleted}${dryRun ? '+' : ''} versions ${dryRun ? 'would be' : ''} removed (deleted LAST by design)`));
  } else {
    runner.note(`state bucket ${names.stateBucket} was inaccessible — verify in the console whether it exists`);
  }

  // Residual report: what's still alive after everything above.
  if (!dryRun) {
    const residualStacks = await listLiveStacks(cfn, { stackPrefix, appTagValue: TAGS.Application });
    if (residualStacks.length > 0) {
      log(warn(`stacks still present (check the CloudFormation console for DELETE_FAILED): ${residualStacks.join(', ')}`));
    } else {
      log(ok('no live stacks remain under the prefix/tag'));
    }
  }

  // ── Intentional residuals + manual checklist ───────────────────────
  if (inv.auditLockBucket) {
    section('Intentional residual (WORM)');
    for (const line of wormResidualNotice(inv.auditLockBucket).split('\n')) log(`  ${line}`);
  }
  section('Manual checklist — teardown cannot remove these');
  for (const item of MANUAL_TEARDOWN_CHECKLIST) log(`  ☐ ${item}`);

  if (dryRun) {
    section('Dry-run action list');
    for (const a of runner.actions) log(dim(`  ${a}`));
    log('\n' + ok(`dry run complete: ${runner.actions.length} planned actions, 0 mutations`));
  } else {
    log('\n' + ok('teardown complete (minus the intentional residuals and manual checklist above)'));
  }
  closePrompt();
}

main().catch((err) => {
  log(fail(err instanceof Error ? (err.stack ?? err.message) : String(err)));
  closePrompt();
  process.exitCode = 1;
});
