/**
 * bootstrap-state phase (IaC readiness plan, item 6).
 *
 * Runs FIRST, before Docker and CDK: create-or-validate the state PRIMITIVES
 * the lifecycle depends on, idempotently and OUTSIDE CDK:
 *
 *  1. the manifest/state bucket (versioned, SSE, public-access-blocked;
 *     the name embeds account + region + CCE_NAME_SUFFIX because S3 names
 *     are GLOBAL, and a create-time collision or 403 is treated as a
 *     cross-account collision that tells the operator to pick a fresh
 *     suffix rather than failing cryptically);
 *  2. the deploy-lock DynamoDB table (deterministic name, on-demand billing;
 *     it cannot live in the CDK stacks because the lock must be held before
 *     the first stack deploys);
 *  3. the private ECR repo (release-image import needs it before Compute
 *     synth).
 *
 * First-run concurrency is defined: create the primitives idempotently, wait
 * for the lock table to be ACTIVE, acquire the lifecycle lock, and only THEN
 * write account/region/tier/mode metadata via a conditional write, so two
 * racing first-time deploys fail loudly instead of half-initializing shared
 * state. All three primitives are tagged, cataloged, and owned by teardown.
 */

import {
  CreateTableCommand,
  DescribeTableCommand,
} from '@aws-sdk/client-dynamodb';
import {
  CreateBucketCommand,
  GetBucketEncryptionCommand,
  GetBucketVersioningCommand,
  GetObjectCommand,
  GetPublicAccessBlockCommand,
  HeadBucketCommand,
  PutBucketEncryptionCommand,
  PutBucketTaggingCommand,
  PutBucketVersioningCommand,
  PutObjectCommand,
  PutPublicAccessBlockCommand,
} from '@aws-sdk/client-s3';
import { acquireLock, type AwsClientLike, type LockHandle, type LockOperation } from './lock.js';
import { s3BodyToString } from './journal.js';

/** Tags carried by every bootstrap primitive (cataloged, owned by teardown). */
export const BOOTSTRAP_TAGS: ReadonlyArray<{ Key: string; Value: string }> = [
  { Key: 'app', Value: 'claudeclaw' },
  { Key: 'claudeclaw:component', Value: 'bootstrap-state' },
];

/** Key of the one-time state metadata object, written only under the lock. */
export const STATE_META_KEY = 'state/meta.json';

export interface StateNames {
  stateBucket: string;
  lockTable: string;
  ecrRepo: string;
}

export interface StateMeta {
  account: string;
  region: string;
  tier: number;
  mode: 'chat' | 'infra-only';
  createdAt: string;
}

/**
 * ECR is injected as a method-shaped client matching the SDK's aggregated
 * `ECR` class (@aws-sdk/client-ecr is not a dependency yet, so the send-based
 * Command classes cannot be imported here; the aggregated client satisfies
 * this interface structurally with no adapter).
 */
export interface EcrClientLike {
  describeRepositories(input: { repositoryNames: string[] }): Promise<unknown>;
  createRepository(input: Record<string, unknown>): Promise<unknown>;
  /**
   * Optional so existing adapters (deploy.ts's aws-CLI wrapper) keep
   * satisfying the interface; bootstrapState applies the retention policy
   * only when the injected client supports it.
   */
  putLifecyclePolicy?(input: {
    repositoryName: string;
    lifecyclePolicyText: string;
  }): Promise<unknown>;
}

export interface BootstrapClients {
  s3: AwsClientLike;
  ddb: AwsClientLike;
  ecr: EcrClientLike;
}

type Env = Record<string, string | undefined>;

const SUFFIX_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;

function errName(err: unknown): string {
  return (err as { name?: string } | null)?.name ?? '';
}

function httpStatus(err: unknown): number | undefined {
  return (err as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata?.httpStatusCode;
}

function crossAccountCollisionError(bucket: string): Error {
  return new Error(
    `S3 bucket "${bucket}" already exists in ANOTHER AWS account (S3 bucket names are global). ` +
      'This is a cross-account name collision, not a permissions bug on your side. ' +
      'Set a fresh CCE_NAME_SUFFIX in your env to get a unique name, then re-run.',
  );
}

/**
 * Deterministic names for the three bootstrap primitives. The bucket name
 * embeds account + region because S3 names are GLOBAL; the table and repo
 * are regional so the suffix alone disambiguates.
 */
export function resolveStateNames(env: Env): StateNames {
  const rawSuffix = env.CCE_NAME_SUFFIX ?? '';
  if (rawSuffix !== '' && !SUFFIX_RE.test(rawSuffix)) {
    throw new Error(
      `CCE_NAME_SUFFIX "${rawSuffix}" must be lowercase alphanumeric/hyphen (max 31 chars); ` +
        'it is embedded in S3 bucket and DynamoDB table names',
    );
  }
  const sfx = rawSuffix === '' ? '' : `-${rawSuffix}`;
  const lockTable = `claudeclaw${sfx}-deploy-lock`;
  const ecrRepo = env.ECR_REPO_NAME !== undefined && env.ECR_REPO_NAME !== ''
    ? env.ECR_REPO_NAME
    : `claudeclaw${sfx}-orchestrator`;
  if (env.DEPLOY_MANIFEST_BUCKET !== undefined && env.DEPLOY_MANIFEST_BUCKET !== '') {
    return { stateBucket: env.DEPLOY_MANIFEST_BUCKET, lockTable, ecrRepo };
  }
  const account = env.AWS_ACCOUNT_ID;
  const region = env.AWS_REGION;
  if (!account || !region) {
    throw new Error(
      'resolveStateNames needs AWS_ACCOUNT_ID and AWS_REGION (or an explicit ' +
        'DEPLOY_MANIFEST_BUCKET): S3 bucket names are global, so the default state-bucket ' +
        'name must embed account + region to avoid cross-account collisions',
    );
  }
  return { stateBucket: `claudeclaw${sfx}-deploy-${account}-${region}`, lockTable, ecrRepo };
}

async function applyBucketBaseline(s3: AwsClientLike, name: string): Promise<void> {
  await s3.send(
    new PutBucketVersioningCommand({
      Bucket: name,
      VersioningConfiguration: { Status: 'Enabled' },
    }),
  );
  await s3.send(
    new PutBucketEncryptionCommand({
      Bucket: name,
      ServerSideEncryptionConfiguration: {
        Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }],
      },
    }),
  );
  await s3.send(
    new PutPublicAccessBlockCommand({
      Bucket: name,
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        IgnorePublicAcls: true,
        BlockPublicPolicy: true,
        RestrictPublicBuckets: true,
      },
    }),
  );
}

async function validateAndFixBucket(s3: AwsClientLike, name: string): Promise<void> {
  // Versioning: rollback depends on durable manifest history.
  const versioning = await s3.send(new GetBucketVersioningCommand({ Bucket: name }));
  if ((versioning as { Status?: string })?.Status !== 'Enabled') {
    await s3.send(
      new PutBucketVersioningCommand({
        Bucket: name,
        VersioningConfiguration: { Status: 'Enabled' },
      }),
    );
  }
  // Encryption: fix up idempotently when the config is missing.
  try {
    await s3.send(new GetBucketEncryptionCommand({ Bucket: name }));
  } catch (err) {
    if (errName(err) === 'ServerSideEncryptionConfigurationNotFoundError' || httpStatus(err) === 404) {
      await s3.send(
        new PutBucketEncryptionCommand({
          Bucket: name,
          ServerSideEncryptionConfiguration: {
            Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }],
          },
        }),
      );
    } else {
      throw err;
    }
  }
  // Public access block: all four must be true.
  let pabOk = false;
  try {
    const pab = await s3.send(new GetPublicAccessBlockCommand({ Bucket: name }));
    const cfg = (pab as {
      PublicAccessBlockConfiguration?: Record<string, boolean | undefined>;
    })?.PublicAccessBlockConfiguration;
    pabOk =
      cfg?.BlockPublicAcls === true &&
      cfg?.IgnorePublicAcls === true &&
      cfg?.BlockPublicPolicy === true &&
      cfg?.RestrictPublicBuckets === true;
  } catch (err) {
    if (errName(err) !== 'NoSuchPublicAccessBlockConfiguration' && httpStatus(err) !== 404) {
      throw err;
    }
  }
  if (!pabOk) {
    await s3.send(
      new PutPublicAccessBlockCommand({
        Bucket: name,
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          IgnorePublicAcls: true,
          BlockPublicPolicy: true,
          RestrictPublicBuckets: true,
        },
      }),
    );
  }
}

/**
 * Create or validate the state bucket. A 403 on HeadBucket or a
 * BucketAlreadyExists on create means another account owns the name
 * (cross-account collision); the error says to pick a fresh suffix.
 */
export async function ensureStateBucket(
  s3: AwsClientLike,
  name: string,
  region: string,
): Promise<void> {
  let exists = false;
  try {
    await s3.send(new HeadBucketCommand({ Bucket: name }));
    exists = true;
  } catch (err) {
    const status = httpStatus(err);
    const code = errName(err);
    if (status === 403 || code === 'Forbidden') throw crossAccountCollisionError(name);
    if (status !== 404 && code !== 'NotFound' && code !== 'NoSuchBucket') throw err;
  }
  if (!exists) {
    try {
      await s3.send(
        new CreateBucketCommand({
          Bucket: name,
          // us-east-1 rejects an explicit LocationConstraint.
          ...(region === 'us-east-1'
            ? {}
            : { CreateBucketConfiguration: { LocationConstraint: region as never } }),
        }),
      );
    } catch (err) {
      const code = errName(err);
      if (code === 'BucketAlreadyOwnedByYou') {
        // Lost a race with our own concurrent run; validate below.
        await validateAndFixBucket(s3, name);
        return;
      }
      if (code === 'BucketAlreadyExists') throw crossAccountCollisionError(name);
      throw err;
    }
    await applyBucketBaseline(s3, name);
    await s3.send(
      new PutBucketTaggingCommand({
        Bucket: name,
        Tagging: { TagSet: [...BOOTSTRAP_TAGS] },
      }),
    );
    return;
  }
  await validateAndFixBucket(s3, name);
}

export interface EnsureTableOptions {
  /** Poll interval while waiting for ACTIVE. */
  pollMs?: number;
  /** Give up after this long; the table is left for the operator to inspect. */
  timeoutMs?: number;
  /** Injectable sleeper for tests. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Create or validate the deploy-lock table, then wait until it is ACTIVE.
 * The lock must be held before the first stack deploys, which is exactly why
 * this table cannot live in the CDK stacks.
 */
export async function ensureLockTable(
  ddb: AwsClientLike,
  name: string,
  opts: EnsureTableOptions = {},
): Promise<void> {
  const pollMs = opts.pollMs ?? 2000;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const sleep = opts.sleep ?? defaultSleep;

  let created = false;
  try {
    const res = await ddb.send(new DescribeTableCommand({ TableName: name }));
    if ((res as { Table?: { TableStatus?: string } })?.Table?.TableStatus === 'ACTIVE') return;
  } catch (err) {
    if (errName(err) !== 'ResourceNotFoundException') throw err;
    await ddb.send(
      new CreateTableCommand({
        TableName: name,
        AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
        KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
        BillingMode: 'PAY_PER_REQUEST',
        Tags: [...BOOTSTRAP_TAGS],
      }),
    );
    created = true;
  }

  // Waiter: poll until ACTIVE so acquireLock never races table creation.
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await ddb.send(new DescribeTableCommand({ TableName: name }));
    const status = (res as { Table?: { TableStatus?: string } })?.Table?.TableStatus;
    if (status === 'ACTIVE') return;
    if (Date.now() >= deadline) {
      throw new Error(
        `deploy-lock table "${name}" is still ${status ?? 'unknown'} after ${timeoutMs}ms` +
          (created ? ' (just created)' : '') +
          '; re-run once it is ACTIVE, or check the table in the DynamoDB console',
      );
    }
    await sleep(pollMs);
  }
}

/**
 * Create or validate the private ECR repo, the third bootstrap primitive:
 * release-image import needs it before Compute synth.
 */
export async function ensureEcrRepo(ecr: EcrClientLike, name: string): Promise<void> {
  try {
    await ecr.describeRepositories({ repositoryNames: [name] });
    return;
  } catch (err) {
    if (errName(err) !== 'RepositoryNotFoundException') throw err;
  }
  try {
    await ecr.createRepository({
      repositoryName: name,
      imageScanningConfiguration: { scanOnPush: true },
      tags: [...BOOTSTRAP_TAGS],
    });
  } catch (err) {
    // Lost a race with our own concurrent run; the repo now exists.
    if (errName(err) !== 'RepositoryAlreadyExistsException') throw err;
  }
}

/**
 * ECR retention (IaC readiness plan, item 18).
 *
 * One rule: keep the newest 50 images of ANY tag status (imageCountMoreThan 50
 * expires the oldest beyond that).
 *
 * There is deliberately no untagged-image expiry rule. It rested on untagged
 * images never being rollback targets, and digest pinning breaks that: a
 * same-commit re-push moves the tag, so the digest a live or rollback revision
 * pins goes untagged and would be expired.
 *
 * The tradeoff, stated plainly: count-based retention keeps the last ~50
 * deploys rollback-able and intentionally prunes anything older. That makes
 * "manifest references a pruned digest" a real (if remote) state, which is
 * exactly why rollback preflight double-checks digest existence in ECR
 * (DescribeImages per digest) BEFORE touching anything: a pruned target
 * fails early with the digest named, never midway through a service roll.
 */
export const ECR_LIFECYCLE_POLICY = {
  rules: [
    {
      rulePriority: 2,
      description: 'keep only the newest 50 images (deploy tags are the only tags we push)',
      selection: {
        tagStatus: 'any',
        countType: 'imageCountMoreThan',
        countNumber: 50,
      },
      action: { type: 'expire' },
    },
  ],
} as const;

/**
 * Apply the retention policy to the private repo. PutLifecyclePolicy is a
 * full overwrite, so re-running is idempotent by construction. Returns
 * 'applied', or 'unsupported' when the injected client cannot set policies
 * (e.g. the aws-CLI adapter in deploy.ts) — callers may log that honestly.
 */
export async function ensureEcrLifecyclePolicy(
  ecr: EcrClientLike,
  repoName: string,
): Promise<'applied' | 'unsupported'> {
  if (typeof ecr.putLifecyclePolicy !== 'function') return 'unsupported';
  await ecr.putLifecyclePolicy({
    repositoryName: repoName,
    lifecyclePolicyText: JSON.stringify(ECR_LIFECYCLE_POLICY),
  });
  return 'applied';
}

export interface BootstrapOptions {
  owner: string;
  operation: LockOperation;
  /** Lease duration for the lifecycle lock; renew via heartbeat for long runs. */
  leaseMs?: number;
  /** Waiter tuning, passed through to ensureLockTable (tests). */
  table?: EnsureTableOptions;
}

export interface BootstrapResult {
  names: StateNames;
  lock: LockHandle;
}

/**
 * The whole bootstrap-state phase: ensure all three primitives idempotently,
 * wait for the lock table to be ACTIVE, acquire the lifecycle lock, and only
 * THEN write `state/meta.json` if absent (S3 conditional write). When the
 * meta object already exists it is read back and VALIDATED: an account or
 * region mismatch throws loudly, so two racing first-time deploys (or a
 * mispointed DEPLOY_MANIFEST_BUCKET) can never half-initialize shared state.
 */
export async function bootstrapState(
  clients: BootstrapClients,
  env: Env,
  opts: BootstrapOptions,
): Promise<BootstrapResult> {
  const account = env.AWS_ACCOUNT_ID;
  const region = env.AWS_REGION;
  if (!account || !region) {
    throw new Error('bootstrapState needs AWS_ACCOUNT_ID and AWS_REGION in the env');
  }
  const names = resolveStateNames(env);

  await ensureStateBucket(clients.s3, names.stateBucket, region);
  await ensureLockTable(clients.ddb, names.lockTable, opts.table);
  await ensureEcrRepo(clients.ecr, names.ecrRepo);
  // Retention (item 18): idempotent overwrite; no-op when the injected
  // client cannot set lifecycle policies.
  await ensureEcrLifecyclePolicy(clients.ecr, names.ecrRepo);

  const lock = await acquireLock(clients.ddb, names.lockTable, {
    owner: opts.owner,
    operation: opts.operation,
    leaseMs: opts.leaseMs ?? 5 * 60_000,
  });

  const meta: StateMeta = {
    account,
    region,
    tier: Number(env.CCE_TIER ?? env.DEPLOY_TIER ?? '0'),
    mode: env.CCE_DEPLOY_MODE === 'infra-only' ? 'infra-only' : 'chat',
    createdAt: new Date().toISOString(),
  };
  try {
    await clients.s3.send(
      new PutObjectCommand({
        Bucket: names.stateBucket,
        Key: STATE_META_KEY,
        Body: JSON.stringify(meta, null, 2) + '\n',
        ContentType: 'application/json',
        // Only the FIRST deploy initializes the metadata.
        IfNoneMatch: '*',
      }),
    );
  } catch (err) {
    if (errName(err) !== 'PreconditionFailed' && httpStatus(err) !== 412) throw err;
    // Already initialized: validate it belongs to THIS account + region.
    const res = await clients.s3.send(
      new GetObjectCommand({ Bucket: names.stateBucket, Key: STATE_META_KEY }),
    );
    const existing = JSON.parse(await s3BodyToString((res as { Body?: unknown }).Body)) as StateMeta;
    if (existing.account !== account || existing.region !== region) {
      throw new Error(
        `state bucket "${names.stateBucket}" was initialized for account ${existing.account} / ` +
          `region ${existing.region}, but this deploy targets ${account} / ${region}. ` +
          'Refusing to share lifecycle state across accounts or regions; set a fresh ' +
          'CCE_NAME_SUFFIX, or point DEPLOY_MANIFEST_BUCKET at the right bucket.',
      );
    }
  }

  return { names, lock };
}
