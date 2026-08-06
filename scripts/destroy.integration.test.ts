/**
 * Integration test: the Phase 7 `npm run destroy` COMPLETENESS sweep, run
 * against real (LocalStack) S3 / DynamoDB / Secrets Manager.
 *
 * `scripts/destroy.ts` is the onboarding-grade wrapper around teardown. Its
 * whole value is that it fails closed: ANY expected paid resource found by ANY
 * deterministic identifier is a destroy FAILURE, even if it carries none of our
 * tags. The mocked unit tests can stub the SDK to return whatever they like;
 * what they CANNOT prove is that the per-identifier check functions read REAL
 * AWS list/head semantics correctly. That is what this file does.
 *
 * We exercise the three checks whose backing services are in LocalStack
 * community scope (s3, dynamodb, secretsmanager):
 *
 *   checkBuckets   present app bucket  -> status 'fail'; gone -> 'pass'
 *   checkTables    present app table   -> status 'fail'; gone -> 'pass'
 *   checkSecrets   active app secret   -> status 'fail';
 *                  schedule-deleted    -> status 'warn' (7-day recovery window)
 *
 * We assert on the TYPED Check.status the real function returns, never on prose.
 *
 * Out of scope (LocalStack community does not cover these): the NAT-gateway,
 * load-balancer, Elastic-IP and IAM-foothold sweeps (EC2 NAT/EIP, ELBv2, and
 * IAM user/OIDC/SAML enforcement). Those checks (checkNatGateways,
 * checkLoadBalancers, checkEips, checkFootholdIam) are deliberately not
 * exercised here; see localstackCaveats in the orchestrator return.
 *
 * House rule: no em dashes anywhere in this file.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  S3Client,
  CreateBucketCommand,
  HeadBucketCommand,
  DeleteBucketCommand,
} from '@aws-sdk/client-s3';
import {
  DynamoDBClient,
  CreateTableCommand,
  DeleteTableCommand,
  DescribeTableCommand,
  ListTablesCommand,
} from '@aws-sdk/client-dynamodb';
import {
  SecretsManagerClient,
  CreateSecretCommand,
  DeleteSecretCommand,
  RestoreSecretCommand,
  ListSecretsCommand,
} from '@aws-sdk/client-secrets-manager';

import { ensureLocalStack, configureLocalAwsEnv } from '../src/__test-utils__/localstack.js';
import {
  checkBuckets,
  checkTables,
  checkSecrets,
  type S3HeadClientLike,
  type DdbListClientLike,
  type SecretsListClientLike,
} from './destroy.js';

// LocalStack endpoint + creds, built the SAME way dynamoClient() does.
const ENDPOINT = process.env.AWS_ENDPOINT_URL ?? 'http://localhost:4566';
const REGION = 'us-east-1';
const CREDS = { accessKeyId: 'test', secretAccessKey: 'test' } as const;

// Deterministic, file-unique identifiers so this file never collides with
// other integration files (the suite runs sequentially, but checkTables and
// checkSecrets scan the WHOLE account by prefix, so the prefixes must be unique
// to this file or another file's table/secret could pollute our pass/fail).
//
// bucketName(prefix, account, region) yields `<prefix>-<account>-<region>`; we
// hardcode a fake account so the bucket name is fully deterministic and unique
// to this file (and DNS/path-safe: lowercase, no underscores).
const BUCKET = 'claudeclaw-integ-destroy-config-000000000000-us-east-1';
const TABLE_PREFIX = 'claudeclaw-integ-destroy-tbl-';
const TABLE = `${TABLE_PREFIX}app`;
const SECRET_PREFIX = '/claudeclaw-integ-destroy-sec/';
const SECRET = `${SECRET_PREFIX}db-encryption`;
// A second prefix this file NEVER writes under, used to prove the clean `pass`
// path. See the secrets test for why the `pass` assertion does not reuse
// SECRET_PREFIX after a schedule-delete (LocalStack keeps a scheduled secret in
// listSecrets for its recovery window and refuses a follow-up force-purge).
const SECRET_PREFIX_CLEAN = '/claudeclaw-integ-destroy-sec-clean/';

// ── Real SDK clients pointed at LocalStack ──────────────────────────────
// forcePathStyle is REQUIRED for S3 on LocalStack: without it the SDK builds a
// virtual-hosted host `<bucket>.localhost` that fails DNS. This is a LocalStack
// client-config detail only; the function under test is unchanged.
const s3Sdk = new S3Client({ endpoint: ENDPOINT, region: REGION, forcePathStyle: true, credentials: CREDS });
const ddbSdk = new DynamoDBClient({ endpoint: ENDPOINT, region: REGION, credentials: CREDS });
const secretsSdk = new SecretsManagerClient({ endpoint: ENDPOINT, region: REGION, credentials: CREDS });

// ── Client-like adapters, matching each interface signature EXACTLY ─────
// (read from scripts/destroy.ts). The real aggregated SDK clients satisfy these
// structurally; we wrap the modular command clients to the same method shapes.
const s3: S3HeadClientLike = {
  headBucket: (input) => s3Sdk.send(new HeadBucketCommand(input)),
};
const ddb: DdbListClientLike = {
  listTables: (input) => ddbSdk.send(new ListTablesCommand(input)),
};
const secrets: SecretsListClientLike = {
  listSecrets: (input) => secretsSdk.send(new ListSecretsCommand(input)),
};

async function deleteBucketIfExists(name: string): Promise<void> {
  try {
    await s3Sdk.send(new DeleteBucketCommand({ Bucket: name }));
  } catch {
    // not present; nothing to delete
  }
}

async function deleteTableIfExists(name: string): Promise<void> {
  try {
    await ddbSdk.send(new DescribeTableCommand({ TableName: name }));
    await ddbSdk.send(new DeleteTableCommand({ TableName: name }));
    await new Promise((r) => setTimeout(r, 150));
  } catch {
    // not present; nothing to delete
  }
}

async function forceDeleteSecretIfExists(id: string): Promise<void> {
  // A prior aborted run may have left this secret SCHEDULED for deletion. On
  // LocalStack a force-delete of an already-scheduled secret is rejected
  // (InvalidRequestException), and CreateSecret on a scheduled name is rejected
  // too, so a stale scheduled secret would otherwise break a fresh run. Restore
  // first (no-op / harmless throw if it is active or absent), then force-delete.
  try {
    await secretsSdk.send(new RestoreSecretCommand({ SecretId: id }));
    await new Promise((r) => setTimeout(r, 150));
  } catch {
    // not scheduled (active or absent); nothing to restore
  }
  try {
    await secretsSdk.send(new DeleteSecretCommand({ SecretId: id, ForceDeleteWithoutRecovery: true }));
    await new Promise((r) => setTimeout(r, 150));
  } catch {
    // not present; nothing to delete
  }
}

beforeAll(async () => {
  configureLocalAwsEnv();
  await ensureLocalStack();
  // Start from a clean slate for all three resources this file touches, so a
  // leftover from a prior aborted run cannot flip an assertion.
  await deleteBucketIfExists(BUCKET);
  await deleteTableIfExists(TABLE);
  await forceDeleteSecretIfExists(SECRET);
});

describe('destroy completeness sweep (LocalStack S3/DynamoDB/SecretsManager)', () => {
  it('checkBuckets flags a present app bucket, then passes once it is gone', async () => {
    // Present: a real bucket with the deterministic name must FAIL the sweep,
    // because a surviving bucket bills for stored objects until emptied+deleted.
    await s3Sdk.send(new CreateBucketCommand({ Bucket: BUCKET }));
    const present = await checkBuckets(s3, [BUCKET]);
    expect(present.status).toBe('fail');
    // The leftover is reported inertly in data (never as an action), and the
    // failing identifier carries a re-run-destroy action, never a none-action.
    expect(present.data).toEqual([BUCKET]);
    expect(present.action.kind).toBe('run_command');

    // Clean: delete it; headBucket now 404s, which the function reads as gone.
    await s3Sdk.send(new DeleteBucketCommand({ Bucket: BUCKET }));
    const clean = await checkBuckets(s3, [BUCKET]);
    expect(clean.status).toBe('pass');
  });

  it('checkTables flags a present app-prefixed table, then passes once it is gone', async () => {
    // Present: a real DDB table under the app prefix must FAIL the sweep.
    await ddbSdk.send(
      new CreateTableCommand({
        TableName: TABLE,
        AttributeDefinitions: [{ AttributeName: 'PK', AttributeType: 'S' }],
        KeySchema: [{ AttributeName: 'PK', KeyType: 'HASH' }],
        BillingMode: 'PAY_PER_REQUEST',
      }),
    );
    const present = await checkTables(ddb, TABLE_PREFIX);
    expect(present.status).toBe('fail');
    // The real function paginates listTables and filters by prefix; the table
    // it found is reported inertly in data.
    expect(present.data).toEqual([TABLE]);

    // Clean: delete it; the prefix scan is then empty.
    await deleteTableIfExists(TABLE);
    const clean = await checkTables(ddb, TABLE_PREFIX);
    expect(clean.status).toBe('pass');
  });

  it('checkSecrets passes on a clean prefix, flags an active secret, then warns once it is schedule-deleted', async () => {
    // Clean: a prefix this file never wrote under has no secrets, so the check
    // passes. We prove the `pass` path on a separate, guaranteed-empty prefix
    // rather than by purging the scheduled secret below, because LocalStack
    // keeps a schedule-deleted secret in listSecrets for its recovery window and
    // REFUSES a follow-up ForceDeleteWithoutRecovery on an already-scheduled
    // secret (InvalidRequestException: secret is currently marked deleted). So
    // there is no supported way to drive a scheduled secret back to fully-gone
    // within a test; we assert `pass` on a never-written prefix instead.
    const clean = await checkSecrets(secrets, SECRET_PREFIX_CLEAN);
    expect(clean.status).toBe('pass');

    // Active: a secret with NO DeletedDate (never scheduled) is a real leftover
    // and must FAIL.
    await secretsSdk.send(new CreateSecretCommand({ Name: SECRET, SecretString: 'integ-test-value' }));
    const active = await checkSecrets(secrets, SECRET_PREFIX);
    expect(active.status).toBe('fail');
    expect(active.data).toEqual({ active: [SECRET], pendingDelete: [] });
    expect(active.action.kind).toBe('run_command');

    // Schedule-delete (the intended teardown behavior): the secret still EXISTS
    // with a DeletedDate during the 7-day recovery window, still bills $0.40/mo,
    // and is reported as a non-fatal WARN, not a fail and not a clean pass.
    // Probed against LocalStack 3.8: listSecrets keeps returning the secret with
    // DeletedDate set after a non-force DeleteSecret, exactly as the function
    // reasons about.
    await secretsSdk.send(new DeleteSecretCommand({ SecretId: SECRET }));
    await new Promise((r) => setTimeout(r, 250));
    const scheduled = await checkSecrets(secrets, SECRET_PREFIX);
    expect(scheduled.status).toBe('warn');
    expect(scheduled.data).toEqual([SECRET]);
    // A warn is an intended residual, so it does NOT carry a re-run action.
    expect(scheduled.action.kind).toBe('none');
  });
});
