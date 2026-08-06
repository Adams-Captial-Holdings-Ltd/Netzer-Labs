/**
 * Integration test: the I6 TTL tripwire against real (LocalStack) AWS.
 *
 * The mocked unit tests can prove decideTripwire's branching, but they cannot
 * prove the dispatch ACTUALLY deletes the S3 bucket and DynamoDB table it owns,
 * nor that the two safety fixes hold against real AWS semantics. This file wires
 * a REAL Destroyer (real @aws-sdk/client-s3 + @aws-sdk/client-dynamodb pointed at
 * LocalStack) and a REAL TripwireStore (a real DDB state table) into the real
 * exported runTripwire(), then asserts the actual side effects on real services.
 *
 * Three behaviors are proven end-to-end:
 *   1. EXPIRED + unverified -> the owned bucket and table are really deleted and
 *      the state row flips to 'destroyed'.
 *   2. VERIFIED -> the destroyer is never invoked; bucket + table survive and the
 *      status is unchanged (decideTripwire short-circuits on 'verified').
 *   3. EMPTY TARGETS (the fail-closed fix) -> expired+armed but no targets and an
 *      empty tag sweep returns action 'noop', leaves the row un-flipped, and
 *      touches nothing (an unrelated bucket survives).
 *
 * LocalStack-community caveats (community image localstack/localstack:3.8 with
 * SERVICES dynamodb,s3,sqs,kms,secretsmanager,iam,scheduler):
 *   - CloudFormation and ECR are NOT in scope, so the test Destroyer's
 *     deleteStack and deleteEcrRepo are no-ops returning nothing, mirroring the
 *     canonical createAwsWiring's intent for the parts community LocalStack does
 *     not cover. The typed target lists in these tests therefore carry only S3
 *     buckets and DDB tables, which ARE fully supported, so the destroy path that
 *     matters (real empty-then-delete-bucket, real delete-table) runs for real.
 *   - sweepByOwnerTag (resource-groups-tagging discovery) is also out of scope
 *     and returns [] here, matching the canonical handler which returns [] too.
 *     The empty-targets test deliberately exercises the [] sweep result.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  S3Client,
  CreateBucketCommand,
  HeadBucketCommand,
  PutObjectCommand,
  DeleteBucketCommand,
  ListObjectVersionsCommand,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';
import {
  DynamoDBClient,
  DescribeTableCommand,
  DeleteTableCommand,
} from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  ensureLocalStack,
  configureLocalAwsEnv,
  createDdbTable,
} from '../__test-utils__/localstack.js';
import {
  runTripwire,
  type TripwireState,
  type TripwireStatus,
  type TripwireStore,
  type Destroyer,
  type DestroyTargets,
  type RunTripwireDeps,
} from './ttl-tripwire.js';

const ENDPOINT = process.env.AWS_ENDPOINT_URL ?? 'http://localhost:4566';
const REGION = 'us-east-1';

// Deterministic, file-scoped names. The suite runs sequentially with
// fileParallelism:false, but names must still be unique across files.
const PREFIX = 'claudeclaw-integ-tripwire';
const STATE_TABLE = `${PREFIX}-state`;

// Per-test resource names so the three tests never collide.
const EXPIRED_BUCKET = `${PREFIX}-expired-bucket`;
const EXPIRED_TABLE = `${PREFIX}-expired-data`;
const VERIFIED_BUCKET = `${PREFIX}-verified-bucket`;
const VERIFIED_TABLE = `${PREFIX}-verified-data`;
const BYSTANDER_BUCKET = `${PREFIX}-bystander-bucket`;

const TTL_HOURS = 2;
// A fixed "now" well past any armedAt we set in the past.
const NOW_MS = Date.parse('2026-06-16T12:00:00.000Z');
// armedAt far enough in the past to be beyond the TTL window.
const ARMED_LONG_AGO = '2026-06-16T00:00:00.000Z'; // 12h ago, TTL is 2h -> expired

function s3Client(): S3Client {
  return new S3Client({
    endpoint: ENDPOINT,
    region: REGION,
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    // LocalStack S3 is happier with path-style addressing than the default
    // virtual-hosted style (bucket-name.localhost subdomains do not resolve).
    forcePathStyle: true,
  });
}

function ddbRawClient(): DynamoDBClient {
  return new DynamoDBClient({
    endpoint: ENDPOINT,
    region: REGION,
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });
}

function ddbDocClient(): DynamoDBDocumentClient {
  return DynamoDBDocumentClient.from(ddbRawClient());
}

/**
 * A REAL Destroyer for the test. emptyAndDeleteBucket and deleteTable issue
 * real AWS SDK calls against LocalStack (the empty-then-delete loop mirrors the
 * canonical createAwsWiring). deleteStack / deleteEcrRepo / sweepByOwnerTag are
 * no-ops because CloudFormation, ECR, and resource-groups-tagging discovery are
 * out of LocalStack-community scope; the no-ops also record that they were
 * called so a test can assert the destroyer was NEVER invoked on a verified
 * install. Each delete is idempotent (a not-found target is a success).
 */
function makeRealDestroyer(): { destroyer: Destroyer; invoked: () => boolean } {
  const s3 = s3Client();
  const ddbRaw = ddbRawClient();
  let invokedFlag = false;

  const notFound = (err: unknown): boolean => {
    const e = err as
      | { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } }
      | null;
    const name = e?.name ?? '';
    return (
      name === 'ResourceNotFoundException' ||
      name === 'NoSuchBucket' ||
      name === 'NotFound' ||
      e?.Code === 'NoSuchBucket' ||
      e?.$metadata?.httpStatusCode === 404
    );
  };

  const destroyer: Destroyer = {
    async deleteStack(): Promise<void> {
      // CloudFormation is out of LocalStack-community scope. No-op, but record
      // the invocation so the verified-install test can assert non-invocation.
      invokedFlag = true;
    },
    async emptyAndDeleteBucket(bucket: string): Promise<void> {
      invokedFlag = true;
      try {
        let keyMarker: string | undefined;
        let versionIdMarker: string | undefined;
        do {
          const page = await s3.send(
            new ListObjectVersionsCommand({
              Bucket: bucket,
              KeyMarker: keyMarker,
              VersionIdMarker: versionIdMarker,
            }),
          );
          const objs = [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])]
            .filter((v) => v.Key)
            .map((v) => ({ Key: v.Key as string, VersionId: v.VersionId }));
          for (let i = 0; i < objs.length; i += 1000) {
            const batch = objs.slice(i, i + 1000);
            if (batch.length === 0) continue;
            await s3.send(
              new DeleteObjectsCommand({
                Bucket: bucket,
                Delete: { Objects: batch, Quiet: true },
              }),
            );
          }
          keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
          versionIdMarker = page.IsTruncated ? page.NextVersionIdMarker : undefined;
        } while (keyMarker !== undefined || versionIdMarker !== undefined);
        await s3.send(new DeleteBucketCommand({ Bucket: bucket }));
      } catch (err) {
        if (!notFound(err)) throw err;
      }
    },
    async deleteTable(table: string): Promise<void> {
      invokedFlag = true;
      try {
        await ddbRaw.send(new DeleteTableCommand({ TableName: table }));
      } catch (err) {
        if (!notFound(err)) throw err;
      }
    },
    async deleteEcrRepo(): Promise<void> {
      // ECR is out of LocalStack-community scope. No-op.
      invokedFlag = true;
    },
    async sweepByOwnerTag(): Promise<string[]> {
      // resource-groups-tagging discovery is out of LocalStack-community scope.
      // Returning [] matches the canonical handler's current behavior.
      invokedFlag = true;
      return [];
    },
  };

  return { destroyer, invoked: () => invokedFlag };
}

/**
 * A REAL TripwireStore backed by the real DDB state table. getState reads the
 * row by installId; setStatus writes the status field. This is the same shape
 * createAwsWiring builds, but pointed at LocalStack.
 */
function makeRealStore(): TripwireStore {
  const ddb = ddbDocClient();
  return {
    async getState(installId: string): Promise<TripwireState | null> {
      const out = await ddb.send(
        new GetCommand({ TableName: STATE_TABLE, Key: { installId } }),
      );
      return (out.Item as TripwireState | undefined) ?? null;
    },
    async setStatus(installId: string, status: TripwireStatus): Promise<void> {
      await ddb.send(
        new UpdateCommand({
          TableName: STATE_TABLE,
          Key: { installId },
          UpdateExpression: 'SET #s = :v',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: { ':v': status },
        }),
      );
    },
  };
}

/** Write (or overwrite) a full tripwire state row into the real state table. */
async function putStateRow(row: TripwireState): Promise<void> {
  const ddb = ddbDocClient();
  await ddb.send(new PutCommand({ TableName: STATE_TABLE, Item: row }));
}

/** Read just the status off the real state row. */
async function readStatus(installId: string): Promise<string | undefined> {
  const ddb = ddbDocClient();
  const out = await ddb.send(
    new GetCommand({ TableName: STATE_TABLE, Key: { installId } }),
  );
  return (out.Item as TripwireState | undefined)?.status;
}

/** Create an empty S3 bucket on LocalStack. */
async function createBucket(name: string): Promise<void> {
  const s3 = s3Client();
  await s3.send(new CreateBucketCommand({ Bucket: name }));
}

/** Put one object so the bucket is non-empty (proves empty-then-delete works). */
async function seedObject(bucket: string, key: string): Promise<void> {
  const s3 = s3Client();
  await s3.send(
    new PutObjectCommand({ Bucket: bucket, Key: key, Body: 'integ-test-payload' }),
  );
}

/** True if the bucket exists (HeadBucket succeeds), false on a NotFound error. */
async function bucketExists(name: string): Promise<boolean> {
  const s3 = s3Client();
  try {
    await s3.send(new HeadBucketCommand({ Bucket: name }));
    return true;
  } catch (err) {
    const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404) return false;
    if (e?.name === 'NoSuchBucket') return false;
    throw err;
  }
}

/** True if the table exists (DescribeTable succeeds), false on a NotFound. */
async function tableExists(name: string): Promise<boolean> {
  const ddb = ddbRawClient();
  try {
    await ddb.send(new DescribeTableCommand({ TableName: name }));
    return true;
  } catch (err) {
    const e = err as { name?: string };
    if (e?.name === 'ResourceNotFoundException') return false;
    throw err;
  }
}

beforeAll(async () => {
  configureLocalAwsEnv();
  await ensureLocalStack();

  // The state table the real TripwireStore reads/writes. PK = installId (S).
  await createDdbTable({
    name: STATE_TABLE,
    partitionKey: { name: 'installId', type: 'S' },
  });

  // Probe: confirm the S3 + DDB ops this file relies on actually work on this
  // LocalStack image. If S3 bucket create/head is unsupported, fail beforeAll
  // loudly rather than letting individual assertions report a confusing error.
  const probeBucket = `${PREFIX}-probe`;
  await createBucket(probeBucket);
  const ok = await bucketExists(probeBucket);
  if (!ok) {
    throw new Error(
      'LocalStack S3 HeadBucket did not confirm a freshly created bucket; ' +
        'S3 support looks broken on this image, cannot run the tripwire S3 tests',
    );
  }
  // Clean up the probe bucket so it does not linger.
  const s3 = s3Client();
  await s3.send(new DeleteBucketCommand({ Bucket: probeBucket }));
});

describe('ttl-tripwire (LocalStack) — real destroy + safety fixes', () => {
  it('EXPIRED unverified install: deletes the owned bucket + table and flips status to destroyed', async () => {
    const installId = 'install-expired-unverified';

    // Real owned resources: a non-empty bucket and a data table.
    await createBucket(EXPIRED_BUCKET);
    await seedObject(EXPIRED_BUCKET, 'manifest.json');
    await createDdbTable({
      name: EXPIRED_TABLE,
      partitionKey: { name: 'PK', type: 'S' },
    });

    // Sanity: they exist before the fire.
    expect(await bucketExists(EXPIRED_BUCKET)).toBe(true);
    expect(await tableExists(EXPIRED_TABLE)).toBe(true);

    // Armed long ago, never verified -> decideTripwire returns 'destroy'.
    await putStateRow({
      installId,
      armedAt: ARMED_LONG_AGO,
      ttlHours: TTL_HOURS,
      status: 'armed',
    });

    const store = makeRealStore();
    const { destroyer } = makeRealDestroyer();
    const targets: DestroyTargets = {
      installId,
      region: REGION,
      stackNames: [], // CFN out of LocalStack scope; no stacks in this test.
      buckets: [EXPIRED_BUCKET],
      tables: [EXPIRED_TABLE],
      ecrRepos: [], // ECR out of LocalStack scope.
      ownerTagKey: 'claudeclaw:install-id',
    };
    const deps: RunTripwireDeps = {
      store,
      destroyer,
      resolveTargets: () => targets,
      nowMs: NOW_MS,
    };

    const state = await store.getState(installId);
    expect(state).not.toBeNull();
    const result = await runTripwire(state as TripwireState, deps);

    // The decision was to destroy, and the typed targets were swept.
    expect(result.action).toBe('destroy');
    expect(result.destroyed?.buckets).toEqual([EXPIRED_BUCKET]);
    expect(result.destroyed?.tables).toEqual([EXPIRED_TABLE]);

    // The real resources are GONE.
    expect(await bucketExists(EXPIRED_BUCKET)).toBe(false);
    expect(await tableExists(EXPIRED_TABLE)).toBe(false);

    // And the state row is now 'destroyed'.
    expect(await readStatus(installId)).toBe('destroyed');
  });

  it('VERIFIED install: never invokes the destroyer; bucket + table survive and status is unchanged', async () => {
    const installId = 'install-verified';

    await createBucket(VERIFIED_BUCKET);
    await seedObject(VERIFIED_BUCKET, 'manifest.json');
    await createDdbTable({
      name: VERIFIED_TABLE,
      partitionKey: { name: 'PK', type: 'S' },
    });

    // Same long-ago armedAt, but the row is already 'verified' -> inert forever.
    await putStateRow({
      installId,
      armedAt: ARMED_LONG_AGO,
      ttlHours: TTL_HOURS,
      status: 'verified',
    });

    const store = makeRealStore();
    const { destroyer, invoked } = makeRealDestroyer();
    const targets: DestroyTargets = {
      installId,
      region: REGION,
      stackNames: [],
      buckets: [VERIFIED_BUCKET],
      tables: [VERIFIED_TABLE],
      ecrRepos: [],
      ownerTagKey: 'claudeclaw:install-id',
    };
    const deps: RunTripwireDeps = {
      store,
      destroyer,
      resolveTargets: () => targets,
      nowMs: NOW_MS,
    };

    const state = await store.getState(installId);
    const result = await runTripwire(state as TripwireState, deps);

    // Decision short-circuited on 'verified': a no-op, destroyer untouched.
    expect(result.action).toBe('noop');
    expect(result.reason).toMatch(/verified/);
    expect(invoked()).toBe(false);

    // The real resources STILL EXIST.
    expect(await bucketExists(VERIFIED_BUCKET)).toBe(true);
    expect(await tableExists(VERIFIED_TABLE)).toBe(true);

    // Status is unchanged.
    expect(await readStatus(installId)).toBe('verified');
  });

  it('EMPTY TARGETS (the fail-closed fix): expired+armed but no targets stays armed and deletes nothing', async () => {
    const installId = 'install-empty-targets';

    // A pre-existing, unrelated bucket that must survive (proves nothing was
    // swept indiscriminately when the typed lists were empty).
    await createBucket(BYSTANDER_BUCKET);
    await seedObject(BYSTANDER_BUCKET, 'unrelated.txt');

    // Expired and armed -> decideTripwire WOULD say destroy...
    await putStateRow({
      installId,
      armedAt: ARMED_LONG_AGO,
      ttlHours: TTL_HOURS,
      status: 'armed',
    });

    const store = makeRealStore();
    const { destroyer, invoked } = makeRealDestroyer();
    // ...but every typed list is empty and the tag sweep returns [].
    const emptyTargets: DestroyTargets = {
      installId,
      region: REGION,
      stackNames: [],
      buckets: [],
      tables: [],
      ecrRepos: [],
      ownerTagKey: 'claudeclaw:install-id',
    };
    const deps: RunTripwireDeps = {
      store,
      destroyer,
      resolveTargets: () => emptyTargets,
      nowMs: NOW_MS,
    };

    const state = await store.getState(installId);
    const result = await runTripwire(state as TripwireState, deps);

    // The fail-closed guard: no proven sweep -> noop, NOT a false 'destroy'.
    expect(result.action).toBe('noop');
    expect(result.reason).toMatch(/no owned targets|stays armed|proven sweep/);

    // The destroyer's destructive methods deleted nothing (only sweepByOwnerTag
    // was consulted, which returned []). The bystander bucket is the real proof.
    expect(await bucketExists(BYSTANDER_BUCKET)).toBe(true);

    // The state row is NOT flipped to 'destroyed' — it stays 'armed' so the
    // schedule keeps firing.
    expect(await readStatus(installId)).toBe('armed');

    // Sanity that sweepByOwnerTag (the only destroyer method runTripwire calls
    // here) was reached; its [] return is what triggers the fail-closed branch.
    expect(invoked()).toBe(true);
  });
});
