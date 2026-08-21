/**
 * Rollback classes (IaC readiness plan items 18, 19, 21).
 *
 * Three rollback classes share one spine and diverge only in what they
 * mutate:
 *
 *   image  — clone the LIVE task definition, swap the orchestrator container
 *            to the target manifest's image BY DIGEST (never a tag), register
 *            a new revision, update-service, wait services-stable. Mirrors
 *            buildspec.yml's proven jq flow in TS.
 *   infra  — redeploy the ARCHIVED cloud assembly (deploys/<id>/cdk.out.zip):
 *            fetch, unzip, ALWAYS `cdk diff` as preview, then `cdk deploy
 *            --app <dir>` (a prebuilt assembly needs no synth env), so the
 *            rollback is reproducible from a fresh clone. Fallback, gated
 *            behind --rebuild-from-git: the OPERATOR checks out the recorded
 *            sha; the tool reconstructs the synth env from the manifest's
 *            allowlisted synthInputs + CCE_IMAGE_TAG and deploys from the
 *            current tree, warning loudly on a sha mismatch.
 *   config — move AWSCURRENT on every secret to the VersionId recorded in
 *            the target manifest (durable thanks to per-deploy staging
 *            labels, item 10), record the displaced version for
 *            re-roll-forward, then FORCE a new ECS deployment (secrets
 *            inject at task START) and wait for stability. Works from any
 *            machine via the API — no .env secret values needed.
 *
 * The shared spine: manifests come from the state bucket (latest.json =
 * current, deploys/<id>/manifest.json = target), parseManifest fails loud on
 * a schema-version mismatch, the lifecycle lock (operation 'rollback') is
 * mandatory with a heartbeat and released in a finally, every mutating step
 * is journaled, and SCHEMA-VERSION SAFETY (item 18) refuses a downgrade of
 * `appSchemaVersion` — rolling back code alone can strand the app on item
 * shapes it can't read — unless the operator pairs --accept-schema-downgrade
 * with a --migration-plan, which is recorded in the journal.
 *
 * Every class PREFLIGHTS before touching anything: image verifies every
 * manifest-referenced digest still exists in ECR (a pruned target fails
 * early naming the digest, not midway through a service roll); config
 * verifies every recorded secret VersionId still exists. --dry-run prints
 * the full plan and performs ZERO mutations (the lock itself is a write, so
 * dry-run never acquires it).
 *
 * All clients are injected so unit tests run on fakes with zero AWS calls;
 * scripts/rollback.ts is the thin CLI that wires real clients in.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import {
  DescribeSecretCommand,
  UpdateSecretVersionStageCommand,
} from '@aws-sdk/client-secrets-manager';
import { newDeployId } from './ids.js';
import {
  acquireLock,
  releaseLock,
  startHeartbeat,
  type AwsClientLike,
  type LockHandle,
} from './lock.js';
import {
  appendJournal,
  LATEST_MANIFEST_KEY,
  manifestKey,
  s3BodyToString,
} from './journal.js';
import { parseManifest, type DeployManifest } from './manifest.js';
import { resolveStateNames, type StateNames } from './bootstrap-state.js';
import { buildResourceNames } from '../../../infra/lib/constants.js';

// ─────────────────────────────────────────────────────────────────────
// Injected client shapes
// ─────────────────────────────────────────────────────────────────────

/**
 * ECR by method shape (the aggregated `ECR` class satisfies it structurally;
 * @aws-sdk/client-ecr is not a dependency, so the CLI wires an aws-CLI
 * adapter — same pattern as bootstrap-state's EcrClientLike).
 */
export interface EcrImagesClientLike {
  describeImages(input: {
    repositoryName: string;
    imageIds: Array<{ imageDigest: string }>;
  }): Promise<unknown>;
}

/** ECS by method shape; the CLI wires the real SDK client + waiter. */
export interface EcsClientLike {
  /** `aws ecs describe-task-definition --query taskDefinition` equivalent. */
  describeTaskDefinition(family: string): Promise<Record<string, unknown>>;
  registerTaskDefinition(def: Record<string, unknown>): Promise<{ revision: number }>;
  updateService(input: {
    cluster: string;
    service: string;
    /** family:revision; omitted for a pure force-roll (config class). */
    taskDefinition?: string;
  }): Promise<void>;
  waitServicesStable(input: { cluster: string; service: string }): Promise<void>;
}

/** CloudFormation stack-status probe (UPDATE_ROLLBACK_FAILED detection). */
export interface CfnClientLike {
  /** Returns the StackStatus, or null when the stack does not exist. */
  stackStatus(stackName: string): Promise<string | null>;
}

/**
 * Shell runner for the infra class (`unzip`, `npx cdk ...`, `git`). The
 * implementation MUST merge `opts.env` over process.env (the lib passes only
 * the overlay). `run` streams output and returns the exit code.
 */
export interface ShellLike {
  run(
    cmd: string,
    args: string[],
    opts?: { cwd?: string; env?: Record<string, string> },
  ): Promise<number>;
  capture(
    cmd: string,
    args: string[],
    opts?: { cwd?: string; env?: Record<string, string> },
  ): Promise<{ code: number; stdout: string; stderr: string }>;
}

export interface RollbackDeps {
  s3: AwsClientLike;
  ddb: AwsClientLike;
  secrets: AwsClientLike;
  ecr: EcrImagesClientLike;
  ecs: EcsClientLike;
  cfn: CfnClientLike;
  shell: ShellLike;
  /** Parsed env file overlaid on process.env (CLI builds it). */
  env: Record<string, string | undefined>;
  log?: (line: string) => void;
  /** Temp-dir + file-write seams so the infra class is testable on fakes. */
  mkTempDir?: (prefix: string) => string;
  writeFile?: (path: string, data: Uint8Array) => void;
  /** Called when the lock heartbeat loses the lease mid-rollback. */
  onLockLost?: (err: unknown) => void;
}

export type RollbackClass = 'image' | 'infra' | 'config';

export interface RollbackOptions {
  rollbackClass: RollbackClass;
  /** Target deployId, or 'previous' for the newest non-live deploy. */
  to: string;
  dryRun: boolean;
  acceptSchemaDowngrade: boolean;
  migrationPlan?: string;
  rebuildFromGit: boolean;
  /** Lock owner string (user@host#pid). */
  owner: string;
  /** --env flag value; resolves the CCE_NAME_SUFFIX default like deploy.ts. */
  envFlag: string;
  /** Repo root, cwd for cdk/git commands in the infra class. */
  repoRoot: string;
  leaseMs?: number;
  heartbeatMs?: number;
}

export interface RollbackResult {
  rollbackClass: RollbackClass;
  currentDeployId: string;
  targetDeployId: string;
  dryRun: boolean;
  /** Mutating actions actually performed, in order (empty on dry-run). */
  actions: string[];
}

// ─────────────────────────────────────────────────────────────────────
// Manifest resolution
// ─────────────────────────────────────────────────────────────────────

const DEPLOY_MANIFEST_KEY_RE = /^deploys\/(CCE-\d{14}-[0-9a-f]{12}-[0-9a-f]{4})\/manifest\.json$/;

/** List every promoted deployId in the state bucket, newest first (deployIds
 * embed a UTC timestamp, so a descending string sort is chronological). */
export async function listDeployIds(s3: AwsClientLike, bucket: string): Promise<string[]> {
  const ids: string[] = [];
  let token: string | undefined;
  do {
    const res = (await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: 'deploys/',
        ...(token ? { ContinuationToken: token } : {}),
      }),
    )) as {
      Contents?: Array<{ Key?: string }>;
      IsTruncated?: boolean;
      NextContinuationToken?: string;
    };
    for (const obj of res.Contents ?? []) {
      const m = DEPLOY_MANIFEST_KEY_RE.exec(obj.Key ?? '');
      if (m) ids.push(m[1]);
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return ids.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
}

/** `--to=previous`: the newest promoted deploy that is NOT the live one. */
export function pickPreviousDeployId(idsNewestFirst: string[], currentId: string): string {
  const prev = idsNewestFirst.find((id) => id !== currentId);
  if (!prev) {
    throw new Error(
      'no previous deploy found in the state bucket: every promoted manifest is the live ' +
        `deploy (${currentId}). Nothing to roll back to.`,
    );
  }
  return prev;
}

async function readManifestAt(
  s3: AwsClientLike,
  bucket: string,
  key: string,
): Promise<DeployManifest> {
  let res: { Body?: unknown };
  try {
    res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  } catch (err) {
    const e = err as { name?: string; $metadata?: { httpStatusCode?: number } } | null;
    if (e?.name === 'NoSuchKey' || e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404) {
      throw new Error(
        `no manifest at s3://${bucket}/${key} — ` +
          (key === LATEST_MANIFEST_KEY
            ? 'no deploy has ever been promoted; rollback requires the state store'
            : 'check the deployId (npm run deploy:rollback -- --list shows recent deploys)'),
      );
    }
    throw err;
  }
  return parseManifest(await s3BodyToString(res.Body));
}

// ─────────────────────────────────────────────────────────────────────
// Schema-version safety (item 18)
// ─────────────────────────────────────────────────────────────────────

/**
 * Refuse an application-schema downgrade unless the operator explicitly
 * paired --accept-schema-downgrade with a --migration-plan. Returns true
 * when an accepted downgrade is in play (so the plan text gets journaled).
 */
export function assertSchemaSafety(
  current: DeployManifest,
  target: DeployManifest,
  opts: Pick<RollbackOptions, 'acceptSchemaDowngrade' | 'migrationPlan'>,
): boolean {
  const cur = current.appSchemaVersion ?? 0;
  const tgt = target.appSchemaVersion ?? 0;
  if (tgt >= cur) return false;
  if (!opts.acceptSchemaDowngrade || !opts.migrationPlan?.trim()) {
    throw new Error(
      `REFUSED: target deploy ${target.deployId} has appSchemaVersion ${tgt}, the live deploy ` +
        `${current.deployId} has ${cur}. Rolling back code across a schema-version boundary can ` +
        'strand the app on DynamoDB item shapes / runtime-config keys / queue payloads it cannot ' +
        'read. If you have a reversible migration or a data-restore plan, re-run with BOTH ' +
        '--accept-schema-downgrade AND --migration-plan="<what reverses the schema change>". ' +
        'The plan text is recorded in the journal.',
    );
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────────
// Image class (item 18)
// ─────────────────────────────────────────────────────────────────────

/** Digests to verify in OUR private ECR before an image rollback. Public
 * registry sidecars (e.g. public.ecr.aws X-Ray) cannot be DescribeImages'd
 * in a private repo and are listed separately. */
export function collectPrivateEcrDigests(
  manifest: DeployManifest,
  privateRepoName: string,
): { toVerify: Array<{ repositoryName: string; digest: string }>; skippedPublic: string[] } {
  const seen = new Set<string>();
  const toVerify: Array<{ repositoryName: string; digest: string }> = [];
  const skippedPublic: string[] = [];
  const add = (repositoryName: string, digest: string): void => {
    const k = `${repositoryName}@${digest}`;
    if (seen.has(k)) return;
    seen.add(k);
    toVerify.push({ repositoryName, digest });
  };
  if (manifest.imageDigest) add(privateRepoName, manifest.imageDigest);
  for (const img of manifest.images ?? []) {
    // The Paperclip digest USED to be skipped here. That skip rested on one
    // premise - "no service consumes this image" - and Phase 4
    // (infra/lib/paperclip-stack.ts) ended it: the digest now pins the
    // running Paperclip task definition and its migration job. A rollback
    // target whose Paperclip image has been deleted out of ECR is genuinely
    // unrestorable, so it must fail loudly in preflight, before anything is
    // touched, rather than silently leave Paperclip on the newer image. The
    // repo has no lifecycle policy, so in practice the digest is present;
    // when it is not, that is real information.
    //
    // KNOWN GAP, named rather than hidden: `runImageClass` still re-points
    // only the orchestrator service, so this preflight verifies more than
    // that class restores. Rolling the Paperclip service back to a recorded
    // digest is its own path and is NOT built yet - today it is a
    // `cdk deploy` of the archived assembly (the infra class), which re-pins
    // the task definition through CCE_PAPERCLIP_IMAGE_DIGEST.
    if (img.repo.includes('.dkr.ecr.')) {
      // URI form: <acct>.dkr.ecr.<region>.amazonaws.com/<repo-name>
      const name = img.repo.split('/').slice(1).join('/') || privateRepoName;
      add(name, img.digest);
    } else if (img.repo.includes('/')) {
      // Non-private registry (public.ecr.aws etc.): not verifiable here.
      skippedPublic.push(`${img.repo}@${img.digest}`);
    } else {
      add(img.repo, img.digest);
    }
  }
  return { toVerify, skippedPublic };
}

/**
 * Image preflight: every manifest-referenced digest must still exist in ECR
 * BEFORE anything is touched. The count-based lifecycle policy (item 18,
 * bootstrap-state) makes pruning possible in principle; this check makes a
 * pruned target fail early, naming the digest, never midway.
 */
export async function preflightImageDigests(
  ecr: EcrImagesClientLike,
  manifest: DeployManifest,
  privateRepoName: string,
  log: (line: string) => void,
): Promise<void> {
  const { toVerify, skippedPublic } = collectPrivateEcrDigests(manifest, privateRepoName);
  if (toVerify.length === 0) {
    throw new Error(
      `target manifest ${manifest.deployId} records no private-ECR image digest; ` +
        'cannot perform an image rollback without one',
    );
  }
  const missing: string[] = [];
  for (const { repositoryName, digest } of toVerify) {
    try {
      await ecr.describeImages({ repositoryName, imageIds: [{ imageDigest: digest }] });
      log(`  ECR ok: ${repositoryName}@${digest}`);
    } catch (err) {
      const name = (err as { name?: string } | null)?.name ?? '';
      if (name === 'ImageNotFoundException' || /ImageNotFound/.test(String(err))) {
        missing.push(`${repositoryName}@${digest}`);
      } else {
        throw err;
      }
    }
  }
  for (const s of skippedPublic) {
    log(`  (public registry, not verifiable in private ECR: ${s})`);
  }
  if (missing.length > 0) {
    throw new Error(
      'image rollback preflight FAILED — these manifest-referenced digests no longer exist ' +
        `in ECR (pruned by the lifecycle policy or deleted by hand):\n  ${missing.join('\n  ')}\n` +
        'Pick a newer --to target (npm run deploy:rollback -- --list) or rebuild the image ' +
        'from the recorded gitSha and redeploy.',
    );
  }
}

/** Fields stripped before re-registering a cloned task definition — the
 * exact `del(...)` list from buildspec.yml's jq flow. */
export const TASK_DEF_STRIP_FIELDS = [
  'taskDefinitionArn',
  'revision',
  'status',
  'requiresAttributes',
  'compatibilities',
  'registeredAt',
  'registeredBy',
] as const;

/**
 * Clone of buildspec.yml's jq transform: strip the register-rejected fields
 * and swap ONLY the orchestrator container's image, preserving every other
 * container and all env (launch flags, voice, cost cap, ...).
 */
export function buildTaskDefForRegister(
  liveTaskDef: Record<string, unknown>,
  imageRef: string,
  containerName = 'orchestrator',
): Record<string, unknown> {
  const def: Record<string, unknown> = { ...liveTaskDef };
  for (const f of TASK_DEF_STRIP_FIELDS) delete def[f];
  const containers = def.containerDefinitions as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(containers)) {
    throw new Error('live task definition has no containerDefinitions array');
  }
  let swapped = false;
  def.containerDefinitions = containers.map((c) => {
    if (c.name === containerName) {
      swapped = true;
      return { ...c, image: imageRef };
    }
    return c;
  });
  if (!swapped) {
    throw new Error(
      `live task definition has no container named "${containerName}" — refusing to register ` +
        'a revision that would not change the image',
    );
  }
  return def;
}

// ─────────────────────────────────────────────────────────────────────
// Config class (item 21)
// ─────────────────────────────────────────────────────────────────────

interface SecretPreflightEntry {
  secretId: string;
  /** VersionId recorded in the target manifest (the rollback destination). */
  versionId: string;
  /** VersionId currently holding AWSCURRENT (the displaced version). */
  displacedVersionId?: string;
  alreadyCurrent: boolean;
}

/**
 * Config preflight: DescribeSecret each recorded secret and confirm the
 * recorded VersionId still exists (fail early, naming every pruned one),
 * capturing the current AWSCURRENT holder so the journal can record the
 * displaced version for re-roll-forward.
 */
export async function preflightSecretVersions(
  secrets: AwsClientLike,
  manifest: DeployManifest,
  log: (line: string) => void,
): Promise<SecretPreflightEntry[]> {
  const records = manifest.secretVersions ?? [];
  if (records.length === 0) {
    throw new Error(
      `target manifest ${manifest.deployId} records no secret versions; nothing for a config ` +
        'rollback to restore',
    );
  }
  const entries: SecretPreflightEntry[] = [];
  const problems: string[] = [];
  for (const rec of records) {
    let stagesByVersion: Record<string, string[]>;
    try {
      const desc = (await secrets.send(new DescribeSecretCommand({ SecretId: rec.secretId }))) as {
        VersionIdsToStages?: Record<string, string[]>;
      };
      stagesByVersion = desc.VersionIdsToStages ?? {};
    } catch (err) {
      problems.push(
        `${rec.secretId}: DescribeSecret failed (${err instanceof Error ? err.message : String(err)})`,
      );
      continue;
    }
    if (!(rec.versionId in stagesByVersion)) {
      problems.push(
        `${rec.secretId}: recorded VersionId ${rec.versionId} (label ${rec.label}) no longer ` +
          'exists — the version was pruned past the label-retention window',
      );
      continue;
    }
    let displaced: string | undefined;
    for (const [versionId, stages] of Object.entries(stagesByVersion)) {
      if (stages.includes('AWSCURRENT')) displaced = versionId;
    }
    const alreadyCurrent = displaced === rec.versionId;
    entries.push({
      secretId: rec.secretId,
      versionId: rec.versionId,
      ...(displaced !== undefined ? { displacedVersionId: displaced } : {}),
      alreadyCurrent,
    });
    log(
      `  secret ok: ${rec.secretId} → ${rec.versionId}` +
        (alreadyCurrent ? ' (already AWSCURRENT)' : ` (displaces ${displaced ?? 'none'})`),
    );
  }
  if (problems.length > 0) {
    throw new Error(
      'config rollback preflight FAILED — recorded secret versions are unavailable:\n  ' +
        problems.join('\n  ') +
        '\nPick a newer --to target, or re-enter the values and run a fresh deploy.',
    );
  }
  return entries;
}

// ─────────────────────────────────────────────────────────────────────
// The runner
// ─────────────────────────────────────────────────────────────────────

interface ResolvedTargets {
  names: StateNames;
  cluster: string;
  service: string;
  taskFamily: string;
}

function resolveEcsTargets(env: Record<string, string | undefined>, envFlag: string): ResolvedTargets {
  const names = resolveStateNames(env);
  const suffix = env.CCE_NAME_SUFFIX ?? (envFlag === 'prod' ? '' : envFlag);
  const rn = buildResourceNames(suffix);
  return {
    names,
    cluster: env.ECS_CLUSTER ?? rn.ecsCluster,
    service: env.ECS_SERVICE ?? rn.fargateService,
    taskFamily: env.TASK_FAMILY ?? rn.taskFamily,
  };
}

export async function runRollback(deps: RollbackDeps, opts: RollbackOptions): Promise<RollbackResult> {
  const log = deps.log ?? ((): void => {});
  const targets = resolveEcsTargets(deps.env, opts.envFlag);
  const { names } = targets;
  const bucket = names.stateBucket;

  // ── COMMON: current + target manifests from the state bucket ────────
  const current = await readManifestAt(deps.s3, bucket, LATEST_MANIFEST_KEY);
  let targetId: string;
  if (opts.to === 'previous') {
    const ids = await listDeployIds(deps.s3, bucket);
    targetId = pickPreviousDeployId(ids, current.deployId);
  } else {
    targetId = opts.to;
  }
  const target = await readManifestAt(deps.s3, bucket, manifestKey(targetId));
  log(`current deploy: ${current.deployId} (git ${current.gitSha.slice(0, 12)})`);
  log(`target deploy:  ${target.deployId} (git ${target.gitSha.slice(0, 12)})`);

  if (target.deployId === current.deployId && opts.rollbackClass !== 'config') {
    throw new Error(
      `target ${target.deployId} is already the live deploy — nothing to roll back ` +
        '(config rollback alone may target the live manifest, to re-pin hand-edited secrets)',
    );
  }
  if (target.deployId === current.deployId) {
    log('note: target == live deploy; re-pinning AWSCURRENT to the recorded versions');
  }

  // ── COMMON: schema-version safety (item 18) ─────────────────────────
  const downgradeAccepted = assertSchemaSafety(current, target, opts);
  if (downgradeAccepted) {
    log('!!! schema DOWNGRADE accepted by operator; migration plan will be journaled');
  }

  // ── Class preflight (read-only) + plan ──────────────────────────────
  log(`\nPreflight (${opts.rollbackClass}):`);
  let secretEntries: SecretPreflightEntry[] = [];
  let imageRef = '';
  if (opts.rollbackClass === 'image') {
    await preflightImageDigests(deps.ecr, target, names.ecrRepo, log);
    const orch = (target.images ?? []).find((i) => i.containerName === 'orchestrator');
    if (orch) {
      imageRef = `${orch.repo}@${orch.digest}`;
    } else if (target.imageDigest) {
      // Derive the repo URI from the LIVE task definition (read-only).
      const live = await deps.ecs.describeTaskDefinition(targets.taskFamily);
      const containers = (live.containerDefinitions ?? []) as Array<Record<string, unknown>>;
      const liveImage = String(containers.find((c) => c.name === 'orchestrator')?.image ?? '');
      const repoUri = liveImage.split('@')[0].replace(/:[^/]*$/, '');
      if (!repoUri) {
        throw new Error('cannot derive the ECR repo URI from the live task definition');
      }
      imageRef = `${repoUri}@${target.imageDigest}`;
    } else {
      throw new Error(`target manifest ${target.deployId} has no orchestrator image record`);
    }
    log(`  plan: ${targets.cluster}/${targets.service} → ${imageRef}`);
  } else if (opts.rollbackClass === 'config') {
    secretEntries = await preflightSecretVersions(deps.secrets, target, log);
    log(
      `  plan: move AWSCURRENT on ${secretEntries.length} secret(s) to the recorded versions, ` +
        `then force a new deployment of ${targets.cluster}/${targets.service} ` +
        '(secrets inject at task START) and wait for stability',
    );
  } else {
    log(
      target.cdkOutArchiveKey
        ? `  plan: fetch s3://${bucket}/${target.cdkOutArchiveKey}, unzip, cdk diff (always), ` +
            'then cdk deploy --app <archived assembly> --all'
        : '  plan: NO archived cdk.out on the target manifest — git-rebuild fallback ' +
            (opts.rebuildFromGit ? 'ENABLED (--rebuild-from-git)' : 'requires --rebuild-from-git'),
    );
  }

  // ── Dry-run: full plan printed above; zero mutations, no lock ────────
  if (opts.dryRun) {
    if (opts.rollbackClass === 'infra') {
      // The diff preview is part of the plan and is read-only.
      await infraDiffAndMaybeDeploy(deps, opts, target, bucket, { diffOnly: true, log });
    }
    log('\n--dry-run: nothing was mutated (the lifecycle lock was not even acquired).');
    log('Would end with: run `npm run verify`');
    return {
      rollbackClass: opts.rollbackClass,
      currentDeployId: current.deployId,
      targetDeployId: target.deployId,
      dryRun: true,
      actions: [],
    };
  }

  // ── MANDATORY lock + heartbeat + journal ─────────────────────────────
  const lock: LockHandle = await acquireLock(deps.ddb, names.lockTable, {
    owner: opts.owner,
    operation: 'rollback',
    leaseMs: opts.leaseMs ?? 5 * 60_000,
  });
  log(`\nrollback lock acquired by ${opts.owner} (fencing token ${lock.fencingToken})`);
  const stopHeartbeat = startHeartbeat(
    deps.ddb,
    names.lockTable,
    lock,
    opts.heartbeatMs ?? 60_000,
    deps.onLockLost ??
      ((err): void => {
        // Mirrors deploy.ts: a lost lease means another operation took over.
        // eslint-disable-next-line no-console
        console.error(
          'FATAL: rollback lock lost mid-operation: ' +
            (err instanceof Error ? err.message : String(err)) +
            ' — aborting all mutating work now.',
        );
        process.exit(1);
      }),
  );

  // Journal under a fresh operation id keyed to the TARGET's sha, so the
  // rollback leaves its own immutable audit trail in the state bucket.
  const opId = newDeployId(target.gitSha);
  let seq = 0;
  const journal = async (event: string, data?: Record<string, unknown>): Promise<void> => {
    await appendJournal(deps.s3, bucket, {
      deployId: opId,
      seq: seq++,
      event,
      at: new Date().toISOString(),
      fencingToken: lock.fencingToken,
      data,
    });
  };

  const actions: string[] = [];
  try {
    await journal('rollback-start', {
      class: opts.rollbackClass,
      from: current.deployId,
      to: target.deployId,
      ...(downgradeAccepted
        ? { schemaDowngradeAccepted: true, migrationPlan: opts.migrationPlan }
        : {}),
    });

    if (opts.rollbackClass === 'image') {
      await runImageClass(deps, targets, imageRef, journal, actions, log);
    } else if (opts.rollbackClass === 'config') {
      await runConfigClass(deps, targets, secretEntries, journal, actions, log);
    } else {
      await infraDiffAndMaybeDeploy(deps, opts, target, bucket, {
        diffOnly: false,
        journal,
        actions,
        log,
      });
    }

    await journal('rollback-complete', { class: opts.rollbackClass, to: target.deployId });
  } finally {
    stopHeartbeat();
    const released = await releaseLock(deps.ddb, names.lockTable, lock).catch(() => false);
    log(released ? 'rollback lock released' : 'rollback lock was already taken over (lease lapsed)');
  }

  log('\nRollback finished. Now confirm the system is healthy:');
  log('  run `npm run verify`');
  return {
    rollbackClass: opts.rollbackClass,
    currentDeployId: current.deployId,
    targetDeployId: target.deployId,
    dryRun: false,
    actions,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Class executors (mutating; called only under the held lock)
// ─────────────────────────────────────────────────────────────────────

type JournalFn = (event: string, data?: Record<string, unknown>) => Promise<void>;

async function runImageClass(
  deps: RollbackDeps,
  targets: ResolvedTargets,
  imageRef: string,
  journal: JournalFn,
  actions: string[],
  log: (line: string) => void,
): Promise<void> {
  // Mirror buildspec.yml: clone the LIVE task def (preserving every other
  // container + all env), swap only the orchestrator image — by DIGEST.
  const live = await deps.ecs.describeTaskDefinition(targets.taskFamily);
  const next = buildTaskDefForRegister(live, imageRef);
  const { revision } = await deps.ecs.registerTaskDefinition(next);
  if (!revision) {
    throw new Error(
      'register-task-definition returned no revision — service NOT rolled; aborting before ' +
        'update-service so nothing is half-applied',
    );
  }
  actions.push(`register-task-definition:${targets.taskFamily}:${revision}`);
  await journal('rollback-image-taskdef-registered', { family: targets.taskFamily, revision, imageRef });
  log(`registered ${targets.taskFamily} revision ${revision} (${imageRef})`);

  await deps.ecs.updateService({
    cluster: targets.cluster,
    service: targets.service,
    taskDefinition: `${targets.taskFamily}:${revision}`,
  });
  actions.push(`update-service:${targets.service}`);
  await journal('rollback-image-service-updated', { service: targets.service, revision });
  log(`update-service issued; waiting for ${targets.cluster}/${targets.service} to stabilize...`);

  await deps.ecs.waitServicesStable({ cluster: targets.cluster, service: targets.service });
  await journal('rollback-image-stable', { service: targets.service });
  log('service is stable on the rolled-back image');
}

async function runConfigClass(
  deps: RollbackDeps,
  targets: ResolvedTargets,
  entries: SecretPreflightEntry[],
  journal: JournalFn,
  actions: string[],
  log: (line: string) => void,
): Promise<void> {
  // 1. ALL stage moves first. Each journal entry records the displaced
  //    version so a re-roll-forward can restore it.
  for (const e of entries) {
    if (e.alreadyCurrent) {
      log(`  ${e.secretId}: recorded version is already AWSCURRENT — skipping`);
      await journal('rollback-secret-already-current', {
        secretId: e.secretId,
        versionId: e.versionId,
      });
      continue;
    }
    await deps.secrets.send(
      new UpdateSecretVersionStageCommand({
        SecretId: e.secretId,
        VersionStage: 'AWSCURRENT',
        MoveToVersionId: e.versionId,
        ...(e.displacedVersionId ? { RemoveFromVersionId: e.displacedVersionId } : {}),
      }),
    );
    actions.push(`stage-move:${e.secretId}`);
    await journal('rollback-secret-staged', {
      secretId: e.secretId,
      movedTo: e.versionId,
      displaced: e.displacedVersionId ?? null,
    });
    log(`  ${e.secretId}: AWSCURRENT → ${e.versionId} (displaced ${e.displacedVersionId ?? 'none'})`);
  }

  // 2. ONLY after every secret moved: force a new ECS deployment. Secrets
  //    inject at task START; restoring versions alone changes nothing for
  //    running tasks.
  await deps.ecs.updateService({ cluster: targets.cluster, service: targets.service });
  actions.push(`force-new-deployment:${targets.service}`);
  await journal('rollback-config-redeploy', { service: targets.service });
  log(`forced new deployment of ${targets.cluster}/${targets.service}; waiting for stability...`);

  await deps.ecs.waitServicesStable({ cluster: targets.cluster, service: targets.service });
  await journal('rollback-config-stable', { service: targets.service });
  log('service is stable on the restored secret versions');
}

interface InfraRunCtx {
  diffOnly: boolean;
  journal?: JournalFn;
  actions?: string[];
  log: (line: string) => void;
}

/** Documented recovery for UPDATE_ROLLBACK_FAILED — printed, never run. */
export function updateRollbackFailedGuidance(stackName: string): string {
  return [
    `Stack ${stackName} is in UPDATE_ROLLBACK_FAILED. CloudFormation is stuck and needs an`,
    'explicit operator decision; this tool will NOT attempt it automatically:',
    `  1. Inspect what blocked the rollback:`,
    `     aws cloudformation describe-stack-events --stack-name ${stackName} \\`,
    `       --query 'StackEvents[?ResourceStatus==\`UPDATE_FAILED\`]' --no-cli-pager`,
    '  2. Fix the blocking resource out-of-band if possible, then resume:',
    `     aws cloudformation continue-update-rollback --stack-name ${stackName}`,
    '  3. If a specific resource can never roll back (deleted out-of-band, retained name',
    '     conflict), skip it EXPLICITLY — you own reconciling it afterwards:',
    `     aws cloudformation continue-update-rollback --stack-name ${stackName} \\`,
    '       --resources-to-skip <LogicalResourceId> [<LogicalResourceId> ...]',
    '  4. Re-run this rollback once the stack reaches UPDATE_ROLLBACK_COMPLETE.',
  ].join('\n');
}

async function infraDiffAndMaybeDeploy(
  deps: RollbackDeps,
  opts: RollbackOptions,
  target: DeployManifest,
  bucket: string,
  ctx: InfraRunCtx,
): Promise<void> {
  const { log } = ctx;
  const stackPrefix = deps.env.CDK_STACK_NAME;
  if (!stackPrefix) {
    throw new Error('CDK_STACK_NAME is not set in the env file — required for an infra rollback');
  }
  const mkTempDir = deps.mkTempDir ?? ((prefix: string): string => mkdtempSync(join(tmpdir(), prefix)));
  const writeFile = deps.writeFile ?? ((p: string, d: Uint8Array): void => writeFileSync(p, d));

  // ── Preferred path: the archived, prebuilt cloud assembly ────────────
  let appDir: string | null = null;
  let archiveMissing = !target.cdkOutArchiveKey;
  if (target.cdkOutArchiveKey) {
    try {
      const res = (await deps.s3.send(
        new GetObjectCommand({ Bucket: bucket, Key: target.cdkOutArchiveKey }),
      )) as { Body?: unknown };
      const bytes = await s3BodyToBytes(res.Body);
      const tmp = mkTempDir('cce-rollback-infra-');
      const zipPath = join(tmp, 'cdk.out.zip');
      writeFile(zipPath, bytes);
      const unzipped = await deps.shell.run('unzip', ['-q', '-o', zipPath, '-d', tmp]);
      if (unzipped !== 0) throw new Error(`unzip exited ${unzipped}`);
      // deploy.ts zips from the repo root, so the archive contains cdk.out/.
      appDir = join(tmp, 'cdk.out');
      log(`archived cloud assembly unpacked → ${appDir}`);
    } catch (err) {
      const e = err as { name?: string; $metadata?: { httpStatusCode?: number } } | null;
      if (e?.name === 'NoSuchKey' || e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404) {
        archiveMissing = true;
        log(`!!! manifest points at s3://${bucket}/${target.cdkOutArchiveKey} but it is GONE`);
      } else {
        throw err;
      }
    }
  }

  let synthEnv: Record<string, string> | undefined;
  if (appDir === null) {
    // ── Fallback: rebuild from git, explicitly gated ───────────────────
    if (!archiveMissing) throw new Error('unreachable: no appDir but archive not missing');
    if (!opts.rebuildFromGit) {
      throw new Error(
        `target deploy ${target.deployId} has no usable archived cdk.out. The fallback ` +
          'synthesizes from source, which only reproduces the deploy if the working tree IS ' +
          `the recorded commit. That checkout is YOUR move:\n` +
          `  git checkout ${target.gitSha}\n` +
          'then re-run with --rebuild-from-git. The tool reconstructs the synth env from the ' +
          'manifest (allowlisted synthInputs + CCE_IMAGE_TAG) but never moves your git tree.',
      );
    }
    const head = await deps.shell.capture('git', ['rev-parse', 'HEAD'], { cwd: opts.repoRoot });
    const headSha = head.stdout.trim();
    if (headSha !== target.gitSha) {
      log('');
      log('!!! ─────────────────────────────────────────────────────────────');
      log(`!!! WARNING: HEAD is ${headSha || '(unknown)'}`);
      log(`!!!          but the target manifest records ${target.gitSha}.`);
      log('!!! Synthesizing from a DIFFERENT commit than the one being rolled');
      log('!!! back to — the deployed templates may not match the target.');
      log(`!!! Run: git checkout ${target.gitSha}  (then re-run) to be exact.`);
      log('!!! ─────────────────────────────────────────────────────────────');
    }
    // Reconstruct the synth env: allowlisted inputs + the recorded image
    // tag, so the Compute task def pins the rolled-back image, plus the
    // short-sha deploy marker compute-stack stamps (kept in sync so a
    // post-rollback `cdk diff` reads clean).
    synthEnv = {
      ...Object.fromEntries(
        Object.entries(target.synthInputs ?? {}).filter(([, v]) => v !== undefined),
      ),
      CCE_IMAGE_TAG: target.imageTag,
      DEPLOY_SHA: target.gitSha.slice(0, 7),
    };
    log(`rebuilding from git with synth env: ${Object.keys(synthEnv).join(', ')}`);
  }

  // ── ALWAYS preview with cdk diff ─────────────────────────────────────
  const diffArgs = appDir
    ? ['cdk', 'diff', '--app', appDir, `${stackPrefix}-*`]
    : ['cdk', 'diff', `${stackPrefix}-*`];
  log(`\npreview: npx ${diffArgs.join(' ')}`);
  await deps.shell.run('npx', diffArgs, {
    cwd: opts.repoRoot,
    ...(synthEnv ? { env: synthEnv } : {}),
  });
  // (cdk diff exits nonzero when differences exist — that is the expected
  // case for a rollback, so the exit code is informational only.)

  if (ctx.diffOnly) {
    log('--dry-run: stopping after the diff preview; no deploy was attempted.');
    return;
  }

  const journal = ctx.journal!;
  const actions = ctx.actions!;
  await journal('rollback-infra-deploy-start', {
    source: appDir ? 'archived-cdk-out' : 'rebuild-from-git',
    ...(appDir ? { archiveKey: target.cdkOutArchiveKey } : { gitSha: target.gitSha }),
  });
  const deployArgs = appDir
    ? ['cdk', 'deploy', '--app', appDir, '--all', '--require-approval', 'never']
    : ['cdk', 'deploy', '--all', '--require-approval', 'never'];
  log(`\nnpx ${deployArgs.join(' ')}`);
  const code = await deps.shell.run('npx', deployArgs, {
    cwd: opts.repoRoot,
    ...(synthEnv ? { env: synthEnv } : {}),
  });
  actions.push(`cdk-deploy:${appDir ? 'archive' : 'git'}`);

  // ── UPDATE_ROLLBACK_FAILED detection (documented recovery, never auto) ─
  const wedged: string[] = [];
  for (const stack of target.stacks ?? []) {
    const status = await deps.cfn.stackStatus(stack).catch(() => null);
    if (status === 'UPDATE_ROLLBACK_FAILED') wedged.push(stack);
  }
  for (const stack of wedged) {
    log('\n' + updateRollbackFailedGuidance(stack));
  }
  if (code !== 0) {
    await journal('rollback-infra-deploy-failed', { exitCode: code, wedgedStacks: wedged });
    throw new Error(
      `cdk deploy exited ${code}` +
        (wedged.length > 0
          ? ` and ${wedged.length} stack(s) are in UPDATE_ROLLBACK_FAILED — follow the printed recovery`
          : ' — see the CDK output above'),
    );
  }
  await journal('rollback-infra-deploy-complete', { wedgedStacks: wedged });
  if (wedged.length > 0) {
    throw new Error(
      `cdk deploy returned 0 but ${wedged.join(', ')} is in UPDATE_ROLLBACK_FAILED — ` +
        'follow the printed recovery before trusting this rollback',
    );
  }
  log('infra rollback deployed');
}

/** Binary-safe S3 body reader (the zip archive is not text). */
async function s3BodyToBytes(body: unknown): Promise<Uint8Array> {
  if (body instanceof Uint8Array) return body;
  const b = body as { transformToByteArray?: () => Promise<Uint8Array> } | null;
  if (b && typeof b.transformToByteArray === 'function') return b.transformToByteArray();
  if (typeof body === 'string') return new TextEncoder().encode(body);
  throw new Error('unsupported S3 body shape: expected bytes or transformToByteArray()');
}
