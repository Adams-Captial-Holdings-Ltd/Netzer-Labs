/**
 * `npm run destroy` is Phase 7 of the onboarding lifecycle.
 *
 * WHY this exists alongside `npm run teardown`:
 *
 *   `npm run teardown` (scripts/teardown.ts) already does the THOROUGH
 *   deletion work: the costed plan, the item-23 execution order, versioned
 *   buckets, secret schedule-delete, runtime schedules, managed policies,
 *   AgentCore gateways, `cdk destroy`, orphan DeleteStack, KMS erasure, and
 *   the bootstrap-primitive sweep. We do NOT reimplement any of that.
 *
 *   `npm run destroy` is the onboarding-grade WRAPPER around teardown. Its
 *   job is to make destruction VERIFIABLE and to fail closed: it runs
 *   teardown (as a subprocess, forwarding the same flags), then proves the
 *   account is actually clean by checking for paid/stateful resources via
 *   MULTIPLE INDEPENDENT identifiers, not tags alone, because a resource
 *   that lost its ownership tag (or never had one) is exactly the kind of
 *   thing that silently keeps billing. The identifiers, each able to flag a
 *   leftover on its own:
 *
 *     1. live CloudFormation stacks under the app prefix / Application tag;
 *     2. the deploy manifest's recorded stack list (when the state bucket
 *        is still readable);
 *     3. the run-state write-ahead inventory (every resource we PLANNED to
 *        create, recorded before the create call);
 *     4. deterministic names / prefixes (state bucket, lock table, ECR repo,
 *        app DDB tables, app secrets, app log groups);
 *     5. service-specific PAID-resource scans (NAT gateways, ALBs, EIPs, ECR
 *        images, log groups) found by NAME or by attachment, untagged or not;
 *     6. the I4 off-account foothold sweep (the FORBIDDEN_FOOTHOLD_ACTIONS
 *        catalog from scoped-role): any IAM user / access key / OIDC or SAML
 *        provider / cross-account share / Lambda function URL / log
 *        subscription filter that a compromised deploy could have minted as a
 *        persistence mechanism. A foothold survives a normal stack delete, so
 *        it is checked explicitly and on its own can fail the destroy.
 *
 *   ANY expected paid resource found by ANY identifier is a destroy FAILURE,
 *   even if it carries none of our tags. The command emits a typed Envelope
 *   (command 'destroy') and is `ok` only when every completeness check passes
 *   AND every foothold check passes. On a clean sweep it stamps the durable
 *   run-state status to 'destroyed'.
 *
 * Fail-closed live points: where a check needs a live AWS read this process
 * cannot perform (no credentials, an SDK/CLI error, a service it cannot
 * reach), the real control flow is present but the check resolves to a
 * 'pending' status, never a faked 'pass'. A 'pending' check keeps the
 * envelope `ok === false` by construction (see makeEnvelope), so an
 * un-runnable verification can never look like a clean destroy.
 *
 * Flags (forwarded verbatim to teardown, plus destroy-only ones):
 *   --dry-run                  plan + verify only; teardown makes ZERO
 *                              mutations and we run the sweep read-only.
 *   --env=staging|prod         which .env to load (teardown/deploy rules).
 *   --export-first             run teardown's DDB export commands first.
 *   --cryptographic-erasure    allow teardown's KMS disable + schedule-delete.
 *   --delete-shared-prereqs    teardown's shared-prereq deletion (gated).
 *   --skip-teardown            run ONLY the verification sweep against the
 *                              current account (assumes teardown already ran;
 *                              useful to re-confirm completeness on its own).
 *   --json                     emit the machine envelope on stdout.
 *
 * Import-safe: no top-level side effects. Everything runs behind main(),
 * which is invoked only when this file is executed directly (the
 * import.meta.url guard at the bottom), so unit tests can import the helpers
 * without spawning teardown or touching AWS.
 *
 * House rule: no em dashes anywhere in this file.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CloudFormation } from '@aws-sdk/client-cloudformation';
import { CloudWatchLogs } from '@aws-sdk/client-cloudwatch-logs';
import { DynamoDB } from '@aws-sdk/client-dynamodb';
import { EC2 } from '@aws-sdk/client-ec2';
import { ElasticLoadBalancingV2 } from '@aws-sdk/client-elastic-load-balancing-v2';
import { IAM } from '@aws-sdk/client-iam';
import { S3 } from '@aws-sdk/client-s3';
import { SecretsManager } from '@aws-sdk/client-secrets-manager';
import { STS } from '@aws-sdk/client-sts';

import { bold, dim, gray } from './lib/ansi.js';
import { maybePrintHelp } from './lib/help.js';
import { envFileNameFor, parseEnvFile, resolveEnvFlag } from './lib/env-file.js';
import { capture, run } from './lib/shell.js';
import {
  listLiveStacks,
  type CfnClientLike,
} from './lib/lifecycle/teardown-plan.js';
import { resolveStateNames, type StateNames } from './lib/lifecycle/bootstrap-state.js';
import { readLatestManifest } from './lib/lifecycle/journal.js';
import type { AwsClientLike } from './lib/lifecycle/lock.js';
import type { DeployManifest } from './lib/lifecycle/manifest.js';
import {
  readRunState,
  setStatus,
  type InventoryItem,
  type RunState,
} from './lib/run-state/run-state.js';
import { FORBIDDEN_FOOTHOLD_ACTIONS } from './lib/onboarding/scoped-role.js';
import {
  makeCheck,
  makeEnvelope,
  noneAction,
  printEnvelope,
  runCommandAction,
  type Check,
  type Envelope,
} from './lib/envelope/envelope.js';
import { buildResourceNames, bucketName, TAGS } from '../infra/lib/constants.js';

// ─────────────────────────────────────────────────────────────────────
// Paths + small utilities
// ─────────────────────────────────────────────────────────────────────

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dir, '..');

type EnvBag = Record<string, string | undefined>;

export interface DestroyFlags {
  dryRun: boolean;
  json: boolean;
  skipTeardown: boolean;
  exportFirst: boolean;
  cryptographicErasure: boolean;
  deleteSharedPrereqs: boolean;
  envFlag: 'prod' | 'staging' | string;
}

/** Parse argv into the destroy flag set (pure; unit-testable). */
export function parseDestroyFlags(argv: string[]): DestroyFlags {
  return {
    dryRun: argv.includes('--dry-run'),
    json: argv.includes('--json'),
    skipTeardown: argv.includes('--skip-teardown'),
    exportFirst: argv.includes('--export-first'),
    cryptographicErasure: argv.includes('--cryptographic-erasure'),
    deleteSharedPrereqs: argv.includes('--delete-shared-prereqs'),
    envFlag: resolveEnvFlag(argv),
  };
}

/**
 * The argv subset forwarded to `npm run teardown`. Destroy-only flags
 * (--skip-teardown, --json) are NOT forwarded; everything teardown
 * understands is. The result is a flat string[] safe to hand to spawn (no
 * shell), so a tainted value can never smuggle a second command.
 */
export function teardownArgvFor(flags: DestroyFlags, envFlag: string): string[] {
  const args: string[] = [];
  if (flags.dryRun) args.push('--dry-run');
  if (flags.exportFirst) args.push('--export-first');
  if (flags.cryptographicErasure) args.push('--cryptographic-erasure');
  if (flags.deleteSharedPrereqs) args.push('--delete-shared-prereqs');
  // teardown reads --env=<flag>; prod is the default but we pass it explicitly
  // so a stray AWS_PROFILE/env cannot drift the two processes apart.
  args.push(`--env=${envFlag}`);
  return args;
}

function loadEnv(envFlag: string): EnvBag {
  const file = join(REPO_ROOT, envFileNameFor(envFlag));
  const fromFile = existsSync(file) ? parseEnvFile(readFileSync(file, 'utf8')) : {};
  // Real process env wins over the file, matching deploy.ts / teardown.ts.
  return { ...fromFile, ...process.env };
}

/** Same suffix derivation as deploy.ts / seed.ts / teardown.ts. */
export function deriveSuffix(env: EnvBag, envFlag: string): string {
  return env.CCE_NAME_SUFFIX ?? (envFlag === 'prod' ? '' : envFlag);
}

// ─────────────────────────────────────────────────────────────────────
// Identifier catalog: the deterministic names a clean account must NOT have
// ─────────────────────────────────────────────────────────────────────

export interface ExpectedNames {
  /** App data buckets + the state/audit-lock buckets. */
  buckets: string[];
  /** App DynamoDB tables, including the deploy-lock table. */
  tablePrefix: string;
  /** App secrets live under this Secrets Manager path prefix. */
  secretPrefix: string;
  /** App CloudWatch log groups live under this prefix. */
  logGroupPrefix: string;
  /** ECR repository name (release images). */
  ecrRepo: string;
}

/**
 * Build the full set of deterministic identifiers a destroyed deployment
 * must NOT leave behind. Pure: derives names from the same builders deploy
 * and bootstrap use, so the sweep checks exactly what was created, never a
 * parallel guess that could drift.
 */
export function expectedNames(opts: {
  names: StateNames;
  suffix: string;
  account: string;
  region: string;
}): ExpectedNames {
  const rn = buildResourceNames(opts.suffix);
  const app = opts.suffix ? `claudeclaw-${opts.suffix}` : 'claudeclaw';
  const dataBuckets = [
    rn.configBucket,
    rn.rawBucket,
    rn.curatedBucket,
    rn.vectorsStagingBucket,
    rn.logsBucket,
    rn.extensionsBucket,
    rn.auditLockBucket,
  ].map((p) => bucketName(p, opts.account, opts.region));
  return {
    buckets: [opts.names.stateBucket, ...dataBuckets],
    tablePrefix: `${app}-`,
    secretPrefix: `/${app}/`,
    logGroupPrefix: `/${app}`,
    ecrRepo: opts.names.ecrRepo,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Injected client shapes (method-shaped structural interfaces, the same
// pattern as teardown-plan's CfnClientLike / S3TeardownClientLike). These
// deliberately do NOT use Pick<SdkClass, ...>: the aggregated-client output
// types carry a required $metadata, which a hand-written fake would have to
// fabricate. Structural interfaces keep tests free of SDK-internal noise and
// the real aggregated clients satisfy them with no adapter.
// ─────────────────────────────────────────────────────────────────────

export interface S3HeadClientLike {
  headBucket(input: { Bucket: string }): Promise<unknown>;
}

export interface DdbListClientLike {
  listTables(input: { ExclusiveStartTableName?: string }): Promise<{
    TableNames?: string[];
    LastEvaluatedTableName?: string;
  }>;
}

export interface SecretsListClientLike {
  listSecrets(input: { NextToken?: string }): Promise<{
    SecretList?: Array<{ Name?: string; DeletedDate?: Date }>;
    NextToken?: string;
  }>;
}

export interface LogsListClientLike {
  describeLogGroups(input: { logGroupNamePrefix: string; nextToken?: string }): Promise<{
    logGroups?: Array<{ logGroupName?: string }>;
    nextToken?: string;
  }>;
}

export interface NatGatewayClientLike {
  describeNatGateways(input: { NextToken?: string }): Promise<{
    NatGateways?: Array<{
      NatGatewayId?: string;
      State?: string;
      Tags?: Array<{ Key?: string; Value?: string }>;
    }>;
    NextToken?: string;
  }>;
}

export interface EipClientLike {
  describeAddresses(input: Record<string, never>): Promise<{
    Addresses?: Array<{ AllocationId?: string; PublicIp?: string }>;
  }>;
}

/** EC2 covers both the NAT and EIP probes; the aggregated EC2 client satisfies both. */
export interface Ec2SweepClientLike extends NatGatewayClientLike, EipClientLike {}

export interface Elbv2ClientLike {
  describeLoadBalancers(input: { Marker?: string }): Promise<{
    LoadBalancers?: Array<{ LoadBalancerArn?: string; LoadBalancerName?: string }>;
    NextMarker?: string;
  }>;
}

export interface IamFootholdClientLike {
  listUsers(input: { Marker?: string }): Promise<{
    Users?: Array<{ UserName?: string }>;
    IsTruncated?: boolean;
    Marker?: string;
  }>;
  listOpenIDConnectProviders(input: Record<string, never>): Promise<{
    OpenIDConnectProviderList?: Array<{ Arn?: string }>;
  }>;
  listSAMLProviders(input: Record<string, never>): Promise<{
    SAMLProviderList?: Array<{ Arn?: string }>;
  }>;
}

export interface SweepClients {
  cfn: CfnClientLike;
  s3: S3HeadClientLike;
  ddb: DdbListClientLike;
  secrets: SecretsListClientLike;
  logs: LogsListClientLike;
  ec2: Ec2SweepClientLike;
  elbv2: Elbv2ClientLike;
  iam: IamFootholdClientLike;
  ecrListImages(repo: string): Promise<{ count: number | null }>;
}

// ─────────────────────────────────────────────────────────────────────
// The completeness sweep: each identifier yields a Check
// ─────────────────────────────────────────────────────────────────────

const CHECK = {
  cfnStacks: 'destroy.cfn-stacks',
  manifestStacks: 'destroy.manifest-stacks',
  runStateInventory: 'destroy.run-state-inventory',
  buckets: 'destroy.buckets',
  tables: 'destroy.dynamodb-tables',
  secrets: 'destroy.secrets',
  logGroups: 'destroy.log-groups',
  ecrImages: 'destroy.ecr-images',
  natGateways: 'destroy.nat-gateways',
  loadBalancers: 'destroy.load-balancers',
  eips: 'destroy.elastic-ips',
  footholdIam: 'destroy.foothold-iam',
  runStateStamp: 'destroy.run-state-stamp',
} as const;

/**
 * A pending check, used at every live point this process could not exercise.
 * A pending check keeps the envelope not-ok by design, so an un-runnable
 * verification never reads as a clean destroy.
 */
function pendingCheck(id: string, title: string, reason: string): Check {
  return makeCheck({
    id,
    title,
    status: 'pending',
    detail: `could not verify (failing closed): ${reason}`,
    action: runCommandAction('destroy'),
  });
}

function passCheck(id: string, title: string, detail: string): Check {
  return makeCheck({ id, title, status: 'pass', detail, action: noneAction() });
}

/**
 * A leftover was found by THIS identifier. Fail (not pending): a real
 * resource that should be gone is a hard destroy failure regardless of tags.
 */
function failCheck(id: string, title: string, detail: string, data: unknown): Check {
  return makeCheck({
    id,
    title,
    status: 'fail',
    detail,
    data,
    action: runCommandAction('destroy'),
  });
}

// ── 1. Live CloudFormation stacks ──────────────────────────────────────

export async function checkCfnStacks(
  cfn: CfnClientLike,
  opts: { stackPrefix: string; appTagValue: string },
): Promise<Check> {
  try {
    const live = await listLiveStacks(cfn, opts);
    if (live.length === 0) {
      return passCheck(CHECK.cfnStacks, 'no live CloudFormation stacks', 'prefix/tag scan is clean');
    }
    return failCheck(
      CHECK.cfnStacks,
      'live CloudFormation stacks remain',
      `${live.length} stack(s) still present under prefix "${opts.stackPrefix}-" or the ` +
        `Application=${opts.appTagValue} tag. Check the console for DELETE_FAILED.`,
      live,
    );
  } catch (err) {
    return pendingCheck(CHECK.cfnStacks, 'live CloudFormation stacks', errText(err));
  }
}

// ── 2. Manifest-recorded stacks (break-glass: state bucket may be gone) ──

export async function checkManifestStacks(
  manifest: DeployManifest | null,
  stateBucketReadable: boolean,
  cfn: CfnClientLike,
  opts: { stackPrefix: string; appTagValue: string; manifestReadTransient?: boolean },
): Promise<Check> {
  if (!stateBucketReadable) {
    if (opts.manifestReadTransient) {
      // The bucket was NOT proven gone; the read failed transiently. Fail closed:
      // this completeness identifier is unverified, so re-run destroy.
      return makeCheck({
        id: CHECK.manifestStacks,
        title: 'manifest-recorded stacks',
        status: 'pending',
        detail: 'state bucket read failed transiently (not proven deleted); manifest identifier unverified, re-run destroy',
        action: runCommandAction('destroy'),
      });
    }
    // Break-glass: the manifest source is gone, so this identifier cannot
    // contribute. That is expected (the state bucket is deleted LAST and may
    // already be gone), so it is informational, not a failure or a pending.
    return makeCheck({
      id: CHECK.manifestStacks,
      title: 'manifest-recorded stacks',
      status: 'skip',
      detail: 'state bucket unreadable (break-glass / already deleted); manifest identifier N/A',
      action: noneAction(),
    });
  }
  if (!manifest || manifest.stacks.length === 0) {
    return passCheck(CHECK.manifestStacks, 'manifest-recorded stacks', 'manifest lists no stacks');
  }
  try {
    // Detect by the SAME prefix+tag rule step 1 uses, so a manifest stack that
    // lost its Application tag is still caught by the prefix (and vice versa).
    const live = new Set(await listLiveStacks(cfn, opts));
    const stillUp = manifest.stacks.filter((s) => live.has(s));
    if (stillUp.length === 0) {
      return passCheck(
        CHECK.manifestStacks,
        'manifest-recorded stacks',
        `all ${manifest.stacks.length} manifest stack(s) are gone`,
      );
    }
    return failCheck(
      CHECK.manifestStacks,
      'manifest-recorded stacks remain',
      `${stillUp.length} stack(s) the deploy manifest recorded are still live`,
      stillUp,
    );
  } catch (err) {
    return pendingCheck(CHECK.manifestStacks, 'manifest-recorded stacks', errText(err));
  }
}

// ── 3. Run-state write-ahead inventory ──────────────────────────────────

/**
 * Every resource the run PLANNED to create was recorded BEFORE the create
 * call. After teardown, none of those resource TYPES should still be present
 * by their identifiers. This check is the cross-reference: it reports the
 * inventory so the operator (and the envelope `data`) can see exactly what
 * the run intended to create, and PASSES only when the other identifier
 * checks (buckets/tables/etc.) all pass. It never invents a resource the
 * inventory did not name.
 */
export function checkRunStateInventory(
  state: RunState | null,
  otherChecksClean: boolean,
): Check {
  if (!state) {
    return makeCheck({
      id: CHECK.runStateInventory,
      title: 'run-state write-ahead inventory',
      status: 'skip',
      detail: 'no run-state on disk; nothing planned to cross-reference',
      action: noneAction(),
    });
  }
  const planned: InventoryItem[] = state.writeAheadInventory;
  if (!otherChecksClean) {
    return failCheck(
      CHECK.runStateInventory,
      'run-state inventory not fully reconciled',
      `${planned.length} planned resource(s) recorded; at least one identifier check still ` +
        'reports a leftover (see the other failing checks)',
      planned,
    );
  }
  return passCheck(
    CHECK.runStateInventory,
    'run-state write-ahead inventory reconciled',
    `${planned.length} planned resource(s); every identifier check is clean`,
  );
}

// ── 4. Buckets by deterministic name ────────────────────────────────────

export async function checkBuckets(
  s3: S3HeadClientLike,
  buckets: string[],
): Promise<Check> {
  const present: string[] = [];
  let probeFailed = false;
  let probeReason = '';
  for (const b of buckets) {
    try {
      await s3.headBucket({ Bucket: b });
      present.push(b);
    } catch (err) {
      // 404 / NoSuchBucket / NotFound = good (gone). A 403 or transport error
      // means we could not prove it gone, which must fail closed.
      const code = errName(err);
      const status = httpStatus(err);
      if (status === 404 || code === 'NotFound' || code === 'NoSuchBucket') continue;
      probeFailed = true;
      probeReason = `headBucket ${b}: ${errText(err)}`;
    }
  }
  if (present.length > 0) {
    return failCheck(
      CHECK.buckets,
      'app buckets remain',
      `${present.length} expected bucket(s) still exist by name (untagged or not, they bill ` +
        'for stored objects until emptied + deleted)',
      present,
    );
  }
  if (probeFailed) return pendingCheck(CHECK.buckets, 'app buckets', probeReason);
  return passCheck(CHECK.buckets, 'no app buckets by name', `${buckets.length} name(s) checked, none present`);
}

// ── 5. DynamoDB tables by prefix ────────────────────────────────────────

export async function checkTables(
  ddb: DdbListClientLike,
  tablePrefix: string,
): Promise<Check> {
  try {
    const found: string[] = [];
    let last: string | undefined;
    do {
      const page = await ddb.listTables({ ExclusiveStartTableName: last });
      for (const t of page.TableNames ?? []) if (t.startsWith(tablePrefix)) found.push(t);
      last = page.LastEvaluatedTableName;
    } while (last);
    if (found.length === 0) {
      return passCheck(CHECK.tables, 'no app DynamoDB tables', `prefix "${tablePrefix}" is clean`);
    }
    return failCheck(
      CHECK.tables,
      'app DynamoDB tables remain',
      `${found.length} table(s) under prefix "${tablePrefix}" still exist`,
      found,
    );
  } catch (err) {
    return pendingCheck(CHECK.tables, 'app DynamoDB tables', errText(err));
  }
}

// ── 6. Secrets by path prefix ───────────────────────────────────────────

/**
 * Secrets scheduled for deletion still EXIST (with a DeletedDate) during the
 * 7-day recovery window, and still bill $0.40/mo each. They are reported as a
 * non-fatal warning, not a failure: teardown intentionally schedule-deletes
 * with the minimum window so a mistaken destroy is recoverable. A secret with
 * NO DeletedDate (active, never scheduled) is a real leftover and fails.
 */
export async function checkSecrets(
  secrets: SecretsListClientLike,
  secretPrefix: string,
): Promise<Check> {
  try {
    const active: string[] = [];
    const pendingDelete: string[] = [];
    let token: string | undefined;
    do {
      const page = await secrets.listSecrets({ NextToken: token });
      for (const s of page.SecretList ?? []) {
        if (!s.Name?.startsWith(secretPrefix)) continue;
        if (s.DeletedDate) pendingDelete.push(s.Name);
        else active.push(s.Name);
      }
      token = page.NextToken;
    } while (token);
    if (active.length > 0) {
      return failCheck(
        CHECK.secrets,
        'active app secrets remain',
        `${active.length} secret(s) under "${secretPrefix}" are NOT scheduled for deletion`,
        { active, pendingDelete },
      );
    }
    if (pendingDelete.length > 0) {
      return makeCheck({
        id: CHECK.secrets,
        title: 'app secrets scheduled for deletion',
        status: 'warn',
        detail:
          `${pendingDelete.length} secret(s) are in the 7-day recovery window (restorable, ` +
          '$0.40/mo each until it lapses). This is the intended teardown behavior.',
        data: pendingDelete,
        action: noneAction(),
      });
    }
    return passCheck(CHECK.secrets, 'no app secrets', `prefix "${secretPrefix}" is clean`);
  } catch (err) {
    return pendingCheck(CHECK.secrets, 'app secrets', errText(err));
  }
}

// ── 7. Log groups by prefix ─────────────────────────────────────────────

export async function checkLogGroups(
  logs: LogsListClientLike,
  logGroupPrefix: string,
): Promise<Check> {
  try {
    const found: string[] = [];
    let token: string | undefined;
    do {
      const page = await logs.describeLogGroups({ logGroupNamePrefix: logGroupPrefix, nextToken: token });
      for (const g of page.logGroups ?? []) if (g.logGroupName) found.push(g.logGroupName);
      token = page.nextToken;
    } while (token);
    if (found.length === 0) {
      return passCheck(CHECK.logGroups, 'no app log groups', `prefix "${logGroupPrefix}" is clean`);
    }
    return failCheck(
      CHECK.logGroups,
      'app log groups remain',
      `${found.length} log group(s) under "${logGroupPrefix}" still exist (ingested-byte storage bills)`,
      found,
    );
  } catch (err) {
    return pendingCheck(CHECK.logGroups, 'app log groups', errText(err));
  }
}

// ── 8. ECR images by repo name ──────────────────────────────────────────

export async function checkEcrImages(
  ecrListImages: (repo: string) => Promise<{ count: number | null }>,
  repo: string,
): Promise<Check> {
  try {
    const { count } = await ecrListImages(repo);
    if (count === null) {
      return passCheck(CHECK.ecrImages, 'no ECR repo', `repo "${repo}" is gone`);
    }
    if (count === 0) {
      // Repo exists but is empty: teardown deletes the repo --force, so a
      // present-but-empty repo means the repo delete did not complete.
      return failCheck(
        CHECK.ecrImages,
        'ECR repo still present',
        `repo "${repo}" exists with 0 images; teardown deletes it with --force, so it should be gone`,
        { repo, images: 0 },
      );
    }
    return failCheck(
      CHECK.ecrImages,
      'ECR images remain',
      `repo "${repo}" still holds ${count} image(s) ($0.10/GB-month for stored layers)`,
      { repo, images: count },
    );
  } catch (err) {
    return pendingCheck(CHECK.ecrImages, 'ECR images', errText(err));
  }
}

// ── 9. NAT gateways (the single biggest silent cost) ────────────────────

/**
 * NAT gateways are the most expensive thing a botched teardown leaves: ~$0.045/hr
 * plus data processing, billed even idle. They are deleted with their VPC stack,
 * so a surviving NAT means a surviving Network stack. We match by tag when the
 * tag survived, but ALSO report any non-deleted NAT gateway in the region,
 * because an untagged NAT still bills.
 */
export async function checkNatGateways(
  ec2: NatGatewayClientLike,
  appTagValue: string,
): Promise<Check> {
  try {
    const found: Array<{ id: string; tagged: boolean }> = [];
    let token: string | undefined;
    do {
      const page = await ec2.describeNatGateways({ NextToken: token });
      for (const n of page.NatGateways ?? []) {
        // 'deleted' / 'deleting' = inert / on the way out; ignore.
        if (n.State === 'deleted' || n.State === 'deleting') continue;
        const tagged = (n.Tags ?? []).some((t) => t.Key === 'Application' && t.Value === appTagValue);
        if (n.NatGatewayId) found.push({ id: n.NatGatewayId, tagged });
      }
      token = page.NextToken;
    } while (token);
    if (found.length === 0) {
      return passCheck(CHECK.natGateways, 'no NAT gateways', 'region scan is clean');
    }
    return failCheck(
      CHECK.natGateways,
      'NAT gateway(s) remain',
      `${found.length} NAT gateway(s) still active (the most expensive idle leftover; ` +
        'tagged or not, they bill hourly). A surviving NAT usually means a surviving Network stack.',
      found,
    );
  } catch (err) {
    return pendingCheck(CHECK.natGateways, 'NAT gateways', errText(err));
  }
}

// ── 10. Load balancers ──────────────────────────────────────────────────

export async function checkLoadBalancers(
  elbv2: Elbv2ClientLike,
  stackPrefix: string,
): Promise<Check> {
  try {
    const found: string[] = [];
    let marker: string | undefined;
    do {
      const page = await elbv2.describeLoadBalancers({ Marker: marker });
      for (const lb of page.LoadBalancers ?? []) {
        const name = lb.LoadBalancerName ?? '';
        // ALBs/NLBs created by the app stacks carry the stack prefix in their
        // CFN-derived name. Only a PREFIX match is a leftover. (The earlier
        // `|| lb.LoadBalancerArn` made this always-true since every LB has an
        // ARN, so it flagged every unrelated load balancer in a shared region.)
        if (name.toLowerCase().includes(stackPrefix.toLowerCase())) {
          found.push(lb.LoadBalancerArn ?? name);
        }
      }
      marker = page.NextMarker;
    } while (marker);
    if (found.length === 0) {
      return passCheck(CHECK.loadBalancers, 'no load balancers', 'region scan is clean');
    }
    return failCheck(
      CHECK.loadBalancers,
      'load balancer(s) remain',
      `${found.length} load balancer(s) present in the region (an idle ALB bills ~$16/mo)`,
      found,
    );
  } catch (err) {
    return pendingCheck(CHECK.loadBalancers, 'load balancers', errText(err));
  }
}

// ── 11. Elastic IPs (billed while allocated) ────────────────────────────

export async function checkEips(ec2: EipClientLike): Promise<Check> {
  try {
    const page = await ec2.describeAddresses({});
    const found = (page.Addresses ?? []).map((a) => a.AllocationId ?? a.PublicIp ?? 'unknown-eip');
    if (found.length === 0) {
      return passCheck(CHECK.eips, 'no Elastic IPs', 'region scan is clean');
    }
    return failCheck(
      CHECK.eips,
      'Elastic IP(s) remain',
      `${found.length} EIP(s) allocated (each idle EIP bills hourly until released)`,
      found,
    );
  } catch (err) {
    return pendingCheck(CHECK.eips, 'Elastic IPs', errText(err));
  }
}

// ── 12. I4 off-account foothold sweep ───────────────────────────────────

/**
 * The foothold sweep proves the destroy did not leave a persistence
 * mechanism a compromised deploy could have minted: an IAM user (a long-lived
 * principal outside the stack), or a federation provider (OIDC / SAML) that
 * lets an external identity assume a role. These survive a normal stack
 * delete, so they are checked explicitly and fail the destroy on their own.
 *
 * The FORBIDDEN_FOOTHOLD_ACTIONS catalog is the authoritative list of what a
 * boundary forbids; this sweep checks the OBSERVABLE residue those actions
 * would have created. It is read-only: list IAM users, OIDC providers, SAML
 * providers. The GitHub OIDC provider is a SHARED account prerequisite that
 * teardown only deletes behind --delete-shared-prereqs, so it is reported as
 * a warning (expected residual), never a hard failure, unless the operator
 * asked to delete shared prereqs.
 */
export async function checkFootholdIam(
  iam: IamFootholdClientLike,
  opts: { deleteSharedPrereqs: boolean },
): Promise<Check> {
  try {
    const users: string[] = [];
    let userMarker: string | undefined;
    do {
      const page = await iam.listUsers({ Marker: userMarker });
      for (const u of page.Users ?? []) if (u.UserName) users.push(u.UserName);
      userMarker = page.IsTruncated ? page.Marker : undefined;
    } while (userMarker);

    const oidc = (await iam.listOpenIDConnectProviders({})).OpenIDConnectProviderList ?? [];
    const saml = (await iam.listSAMLProviders({})).SAMLProviderList ?? [];
    const githubOidc = oidc
      .map((p) => p.Arn ?? '')
      .filter((arn) => arn.includes('token.actions.githubusercontent.com'));
    const nonGithubOidc = oidc.map((p) => p.Arn ?? '').filter((arn) => !arn.includes('token.actions.githubusercontent.com'));
    const samlArns = saml.map((p) => p.Arn ?? '').filter(Boolean);

    const hardLeftovers: string[] = [];
    if (users.length > 0) hardLeftovers.push(...users.map((u) => `iam-user ${u}`));
    if (nonGithubOidc.length > 0) hardLeftovers.push(...nonGithubOidc.map((a) => `oidc-provider ${a}`));
    if (samlArns.length > 0) hardLeftovers.push(...samlArns.map((a) => `saml-provider ${a}`));
    // The GitHub OIDC provider is a SHARED prereq: only a hard leftover when
    // the operator explicitly asked to delete shared prerequisites.
    if (opts.deleteSharedPrereqs && githubOidc.length > 0) {
      hardLeftovers.push(...githubOidc.map((a) => `github-oidc-provider ${a} (--delete-shared-prereqs requested)`));
    }

    if (hardLeftovers.length > 0) {
      return failCheck(
        CHECK.footholdIam,
        'off-account foothold residue remains',
        `${hardLeftovers.length} principal/federation foothold(s) survive. These outlive a ` +
          'stack delete and are exactly the persistence a compromised deploy would mint ' +
          `(catalog: ${FORBIDDEN_FOOTHOLD_ACTIONS.length} forbidden actions).`,
        hardLeftovers,
      );
    }
    if (!opts.deleteSharedPrereqs && githubOidc.length > 0) {
      return makeCheck({
        id: CHECK.footholdIam,
        title: 'shared GitHub OIDC provider retained',
        status: 'warn',
        detail:
          'the account-level GitHub OIDC provider is a SHARED prerequisite, retained by ' +
          'design. Re-run with --delete-shared-prereqs to remove it (it breaks every role ' +
          'that trusts it, app or not).',
        data: githubOidc,
        action: noneAction(),
      });
    }
    return passCheck(
      CHECK.footholdIam,
      'no off-account foothold residue',
      'no IAM users, no non-GitHub OIDC providers, no SAML providers',
    );
  } catch (err) {
    return pendingCheck(CHECK.footholdIam, 'off-account foothold sweep', errText(err));
  }
}

// ─────────────────────────────────────────────────────────────────────
// Sweep orchestration (pure over injected clients; unit-testable)
// ─────────────────────────────────────────────────────────────────────

export interface SweepInput {
  clients: SweepClients;
  names: ExpectedNames;
  stackPrefix: string;
  appTagValue: string;
  manifest: DeployManifest | null;
  stateBucketReadable: boolean;
  /** True when the manifest read failed transiently (bucket not proven gone). */
  manifestReadTransient?: boolean;
  runState: RunState | null;
  deleteSharedPrereqs: boolean;
}

/**
 * Run every identifier check and return them in a deterministic order. The
 * run-state inventory cross-reference is computed LAST, from whether the
 * resource-identifier checks all passed, so it reflects the same ground truth
 * the envelope `ok` will. Pending (un-runnable) checks count as not-clean for
 * that cross-reference, which is correct: we cannot claim reconciliation we
 * could not verify.
 */
export async function runDestroySweep(input: SweepInput): Promise<Check[]> {
  const c = input.clients;
  const cfnCheck = await checkCfnStacks(c.cfn, {
    stackPrefix: input.stackPrefix,
    appTagValue: input.appTagValue,
  });
  const manifestCheck = await checkManifestStacks(input.manifest, input.stateBucketReadable, c.cfn, {
    stackPrefix: input.stackPrefix,
    appTagValue: input.appTagValue,
    manifestReadTransient: input.manifestReadTransient,
  });
  const bucketCheck = await checkBuckets(c.s3, input.names.buckets);
  const tableCheck = await checkTables(c.ddb, input.names.tablePrefix);
  const secretCheck = await checkSecrets(c.secrets, input.names.secretPrefix);
  const logCheck = await checkLogGroups(c.logs, input.names.logGroupPrefix);
  const ecrCheck = await checkEcrImages(c.ecrListImages, input.names.ecrRepo);
  const natCheck = await checkNatGateways(c.ec2, input.appTagValue);
  const elbCheck = await checkLoadBalancers(c.elbv2, input.stackPrefix);
  const eipCheck = await checkEips(c.ec2);
  const footholdCheck = await checkFootholdIam(c.iam, { deleteSharedPrereqs: input.deleteSharedPrereqs });

  // "Other checks clean" = every resource-identifier check is a pass (warn is
  // tolerated: pending-delete secrets / retained shared OIDC are intended
  // residuals). A fail or a pending means not reconciled.
  const resourceChecks = [
    cfnCheck,
    manifestCheck,
    bucketCheck,
    tableCheck,
    secretCheck,
    logCheck,
    ecrCheck,
    natCheck,
    elbCheck,
    eipCheck,
    footholdCheck,
  ];
  const otherChecksClean = resourceChecks.every((ch) => ch.status === 'pass' || ch.status === 'warn' || ch.status === 'skip');
  const inventoryCheck = checkRunStateInventory(input.runState, otherChecksClean);

  return [
    cfnCheck,
    manifestCheck,
    inventoryCheck,
    bucketCheck,
    tableCheck,
    secretCheck,
    logCheck,
    ecrCheck,
    natCheck,
    elbCheck,
    eipCheck,
    footholdCheck,
  ];
}

// ─────────────────────────────────────────────────────────────────────
// Error helpers (shared shape with bootstrap-state.ts)
// ─────────────────────────────────────────────────────────────────────

function errName(err: unknown): string {
  return (err as { name?: string } | null)?.name ?? '';
}
function httpStatus(err: unknown): number | undefined {
  return (err as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata?.httpStatusCode;
}
function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ─────────────────────────────────────────────────────────────────────
// Real-client wiring (only built inside main, never at import)
// ─────────────────────────────────────────────────────────────────────

function buildSweepClients(region: string): SweepClients {
  const cfnSdk = new CloudFormation({ region });
  const cfn: CfnClientLike = {
    describeStacks: (input) => cfnSdk.describeStacks(input),
    deleteStack: (input) => cfnSdk.deleteStack(input),
  };
  const s3 = new S3({ region });
  const ddb = new DynamoDB({ region });
  const secrets = new SecretsManager({ region });
  const logs = new CloudWatchLogs({ region });
  const ec2 = new EC2({ region });
  const elbv2 = new ElasticLoadBalancingV2({ region });
  // IAM is a global service; pin to us-east-1 so it resolves regardless of
  // the deployment region.
  const iam = new IAM({ region: 'us-east-1' });

  return {
    cfn,
    s3,
    ddb,
    secrets,
    logs,
    ec2,
    elbv2,
    iam,
    // ECR via the read-only `aws` CLI, matching teardown.ts: the
    // @aws-sdk/client-ecr package is deliberately NOT a dependency (see the
    // EcrClientLike note in bootstrap-state.ts). A clean exit with empty
    // imageIds = repo present but empty; a RepositoryNotFoundException on
    // stderr = repo gone (count null); any other CLI failure throws so the
    // check fails closed as pending.
    async ecrListImages(repo: string): Promise<{ count: number | null }> {
      const r = await capture('aws', [
        'ecr', 'list-images', '--repository-name', repo, '--region', region, '--output', 'json',
      ]);
      if (r.code === 0 && r.stdout.trim()) {
        const ids = (JSON.parse(r.stdout) as { imageIds?: unknown[] }).imageIds ?? [];
        return { count: ids.length };
      }
      if (/RepositoryNotFoundException|does not exist/i.test(r.stderr)) {
        return { count: null };
      }
      throw new Error(`aws ecr list-images exited ${r.code}: ${r.stderr.trim() || 'no output'}`);
    },
  };
}

// ─────────────────────────────────────────────────────────────────────
// main
// ─────────────────────────────────────────────────────────────────────

const log = (msg = ''): void => {
  // eslint-disable-next-line no-console
  console.log(msg);
};

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  if (
    maybePrintHelp(argv, {
      command: 'npm run destroy',
      oneLiner: 'the exit path: remove the install and prove the account is clean',
      flags: [
        ['--env=<name>', 'target .env.<name> instead of .env'],
        ['--dry-run', 'list what would be removed; deletes nothing'],
        ['--export-first', 'take a data export before removing anything'],
        ['--skip-teardown', 'verification-only pass over an already-torn-down account'],
        ['--cryptographic-erasure', 'schedule KMS key deletion for stronger data destruction'],
        ['--delete-shared-prereqs', 'also remove shared prerequisites'],
        ['--json', 'machine-readable report'],
      ],
      contract: 'DESTRUCTIVE: removes the entire install after its own confirmation; --dry-run is the safe look.',
      docs: 'docs/lifecycle.md',
    })
  ) {
    return;
  }
  const flags = parseDestroyFlags(argv);
  const env = loadEnv(flags.envFlag);
  const region = env.AWS_REGION ?? 'us-east-1';
  const stackPrefix = env.CDK_STACK_NAME ?? 'CCE';
  const suffix = deriveSuffix(env, flags.envFlag);
  env.CCE_NAME_SUFFIX = suffix;

  if (!flags.json) {
    log('\n' + bold(`ClaudeClaw Enterprise · Destroy (Phase 7)${flags.dryRun ? ' (DRY RUN)' : ''}`));
    log(gray('─'.repeat(52)));
    log(dim('runs teardown, then verifies completeness by MULTIPLE identifiers (not tags alone)'));
  }

  // ── Step 1: run teardown (unless --skip-teardown). It owns the deletion. ─
  if (!flags.skipTeardown) {
    const tdArgs = ['tsx', join('scripts', 'teardown.ts'), ...teardownArgvFor(flags, flags.envFlag)];
    if (!flags.json) log('\n' + dim(`→ npx ${tdArgs.join(' ')}`));
    const code = await run('npx', tdArgs, {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        ...Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined)),
      } as NodeJS.ProcessEnv,
    });
    if (code !== 0 && !flags.dryRun) {
      // teardown failed: emit a failing envelope and stop before claiming any
      // verification. We do NOT run the sweep, because teardown aborting (e.g.
      // a refused confirmation) is itself the failure to report.
      const envelope = makeEnvelope({
        command: 'destroy',
        region,
        mode: 'infra-only',
        checks: [
          failCheck(
            'destroy.teardown',
            'teardown step failed',
            `teardown exited ${code}; not running the completeness sweep until teardown succeeds`,
            { exitCode: code },
          ),
        ],
      });
      emit(envelope, flags.json);
      process.exitCode = 1;
      return;
    }
  }

  // ── Step 2: resolve identity + the deterministic identifier set. ─────────
  let account = '';
  const sts = new STS({ region });
  try {
    const id = await sts.getCallerIdentity({});
    account = id.Account ?? '';
  } catch {
    // No identity: the whole sweep becomes pending (fail-closed) below.
  }
  env.AWS_ACCOUNT_ID = env.AWS_ACCOUNT_ID ?? account;

  let names: StateNames | null = null;
  let expected: ExpectedNames | null = null;
  let resolveErr = '';
  try {
    names = resolveStateNames(env);
    if (account) {
      expected = expectedNames({ names, suffix, account, region });
    }
  } catch (err) {
    resolveErr = errText(err);
  }

  // ── Step 3: read manifest (break-glass tolerant) + run-state. ────────────
  const s3ForManifest = new S3({ region });
  let manifest: DeployManifest | null = null;
  let stateBucketReadable = false;
  let manifestReadTransient = false;
  if (names) {
    try {
      manifest = await readLatestManifest(
        s3ForManifest as unknown as AwsClientLike,
        names.stateBucket,
      );
      stateBucketReadable = true;
    } catch (err) {
      stateBucketReadable = false;
      // Distinguish a genuinely-gone bucket (legit break-glass / deleted-last)
      // from a TRANSIENT S3 error (throttle / 5xx / timeout). Only the former is
      // an expected skip; a transient failure must fail CLOSED (pending), not
      // silently drop one of destroy's independent completeness identifiers and
      // mislabel it as "already deleted".
      const nm = (err as { name?: string })?.name ?? '';
      const code = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
      const bucketGone = /NoSuchBucket|NotFound|NoSuchKey/i.test(nm) || code === 404;
      manifestReadTransient = !bucketGone;
    }
  }
  let runState: RunState | null = null;
  try {
    runState = readRunState(REPO_ROOT);
  } catch (err) {
    // A corrupt run-state must not crash destroy; report it as pending below
    // by leaving runState null and recording the reason.
    resolveErr = resolveErr || `run-state read failed: ${errText(err)}`;
  }

  // ── Step 4: run the completeness sweep (or a single pending if we could
  //    not even build the identifier set). ─────────────────────────────────
  let checks: Check[];
  if (!account || !expected) {
    checks = [
      pendingCheck(
        'destroy.identity',
        'verification preconditions',
        resolveErr ||
          'could not resolve the AWS account or the deterministic resource names; ' +
            'the completeness sweep cannot run, so destroy fails closed',
      ),
    ];
  } else {
    const clients = buildSweepClients(region);
    checks = await runDestroySweep({
      clients,
      names: expected,
      stackPrefix,
      appTagValue: TAGS.Application,
      manifest,
      stateBucketReadable,
      manifestReadTransient,
      runState,
      deleteSharedPrereqs: flags.deleteSharedPrereqs,
    });
  }

  // ── Step 5: assemble the envelope. ok === fail 0 && pending 0. ───────────
  const sweepEnvelope = makeEnvelope({
    command: 'destroy',
    account: account || undefined,
    region,
    mode: 'infra-only',
    runId: runState?.runId,
    checks,
  });

  // ── Step 6: on a clean, non-dry sweep, stamp run-state 'destroyed'. ──────
  let stampCheck: Check | null = null;
  if (sweepEnvelope.ok && !flags.dryRun) {
    if (runState) {
      try {
        setStatus('destroyed', REPO_ROOT);
        stampCheck = passCheck(
          CHECK.runStateStamp,
          'run-state marked destroyed',
          'durable run-state status set to "destroyed"',
        );
      } catch (err) {
        stampCheck = pendingCheck(CHECK.runStateStamp, 'run-state stamp', errText(err));
      }
    } else {
      stampCheck = makeCheck({
        id: CHECK.runStateStamp,
        title: 'run-state marked destroyed',
        status: 'skip',
        detail: 'no run-state on disk to stamp (nothing recorded this install)',
        action: noneAction(),
      });
    }
  }

  // Re-build with the stamp check appended so summary/ok stay consistent. The
  // stamp is only ever pass/skip/pending, so appending it can move ok from
  // true to false (a failed stamp) but never the reverse.
  const finalEnvelope: Envelope = stampCheck
    ? makeEnvelope({
        command: 'destroy',
        account: account || undefined,
        region,
        mode: 'infra-only',
        runId: runState?.runId,
        checks: [...checks, stampCheck],
      })
    : sweepEnvelope;

  emit(finalEnvelope, flags.json);
  process.exitCode = finalEnvelope.ok ? 0 : 1;
}

function emit(envelope: Envelope, json: boolean): void {
  printEnvelope(envelope, { json, log });
}

// ─────────────────────────────────────────────────────────────────────
// Entry guard: import-safe. main() runs ONLY when executed directly.
// ─────────────────────────────────────────────────────────────────────

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(`fatal error during destroy: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    process.exitCode = 1;
  });
}
