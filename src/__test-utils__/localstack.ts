/**
 * LocalStack helpers for the integration test suite.
 *
 * Every integration test file imports `ensureLocalStack()` in a
 * top-level `beforeAll` so the LocalStack endpoint is verified before
 * any AWS SDK call. If LocalStack is not running, the suite skips
 * with a useful error rather than failing each individual assertion.
 *
 * Test files use the helpers `createDdbTable()` and `seedSecret()`
 * to provision the bits they need. Tables and buckets are created
 * with deterministic names per file so suites stay isolated.
 */

import {
  DynamoDBClient,
  CreateTableCommand,
  DescribeTableCommand,
  DeleteTableCommand,
  type AttributeDefinition,
  type KeySchemaElement,
  type GlobalSecondaryIndex,
} from '@aws-sdk/client-dynamodb';

const ENDPOINT = process.env.AWS_ENDPOINT_URL ?? 'http://localhost:4566';

/**
 * Wait for LocalStack to be reachable. Retries with 1s backoff up to
 * ~30s so a slow-starting container doesn't fail beforeAll. Throws
 * an informative error if LocalStack is unreachable; vitest reports
 * "all tests skipped because beforeAll threw" so the developer sees
 * the actual reason.
 */
export async function ensureLocalStack(timeoutSec = 30): Promise<void> {
  const deadline = Date.now() + timeoutSec * 1000;
  let lastErr: string | undefined;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`${ENDPOINT}/_localstack/health`);
      if (resp.ok) return;
      lastErr = `HTTP ${resp.status}`;
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(
    `LocalStack endpoint not reachable at ${ENDPOINT} after ${timeoutSec}s (${lastErr ?? 'no response'}). Start it with: docker compose -f docker-compose.test.yml up -d`,
  );
}

export function dynamoClient(): DynamoDBClient {
  return new DynamoDBClient({
    endpoint: ENDPOINT,
    region: process.env.AWS_REGION ?? 'us-east-1',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });
}

export interface TableSpec {
  name: string;
  partitionKey: { name: string; type: 'S' | 'N' };
  sortKey?: { name: string; type: 'S' | 'N' };
  gsis?: Array<{
    indexName: string;
    partitionKey: { name: string; type: 'S' | 'N' };
    sortKey?: { name: string; type: 'S' | 'N' };
  }>;
}

/**
 * Create a table on LocalStack, idempotent. If a previous test run
 * left the table around, delete it first so the test starts clean.
 */
export async function createDdbTable(spec: TableSpec): Promise<void> {
  const client = dynamoClient();
  // Delete-if-exists for clean state.
  try {
    await client.send(new DescribeTableCommand({ TableName: spec.name }));
    await client.send(new DeleteTableCommand({ TableName: spec.name }));
    // tiny wait for deletion to propagate; LocalStack is fast but not
    // synchronous on delete.
    await new Promise((r) => setTimeout(r, 100));
  } catch {
    // not found; nothing to delete
  }
  const attrs: AttributeDefinition[] = [
    { AttributeName: spec.partitionKey.name, AttributeType: spec.partitionKey.type },
  ];
  const keySchema: KeySchemaElement[] = [
    { AttributeName: spec.partitionKey.name, KeyType: 'HASH' },
  ];
  if (spec.sortKey) {
    attrs.push({
      AttributeName: spec.sortKey.name,
      AttributeType: spec.sortKey.type,
    });
    keySchema.push({ AttributeName: spec.sortKey.name, KeyType: 'RANGE' });
  }
  const gsis: GlobalSecondaryIndex[] = (spec.gsis ?? []).map((g) => {
    attrs.push({
      AttributeName: g.partitionKey.name,
      AttributeType: g.partitionKey.type,
    });
    const ks: KeySchemaElement[] = [
      { AttributeName: g.partitionKey.name, KeyType: 'HASH' },
    ];
    if (g.sortKey) {
      attrs.push({ AttributeName: g.sortKey.name, AttributeType: g.sortKey.type });
      ks.push({ AttributeName: g.sortKey.name, KeyType: 'RANGE' });
    }
    return {
      IndexName: g.indexName,
      KeySchema: ks,
      Projection: { ProjectionType: 'ALL' },
    };
  });
  // Dedupe attrs (composite keys + GSI keys overlap).
  const uniqueAttrs = Array.from(
    new Map(attrs.map((a) => [a.AttributeName, a])).values(),
  );
  await client.send(
    new CreateTableCommand({
      TableName: spec.name,
      AttributeDefinitions: uniqueAttrs,
      KeySchema: keySchema,
      BillingMode: 'PAY_PER_REQUEST',
      ...(gsis.length > 0 ? { GlobalSecondaryIndexes: gsis } : {}),
    }),
  );
}

/**
 * Configure the orchestrator's DDB doc client to point at LocalStack
 * instead of real AWS. Call this from beforeAll BEFORE any code that
 * touches the `ddb()` singleton.
 */
export function configureLocalAwsEnv(): void {
  process.env.AWS_ENDPOINT_URL = ENDPOINT;
  process.env.AWS_ACCESS_KEY_ID = 'test';
  process.env.AWS_SECRET_ACCESS_KEY = 'test';
  process.env.AWS_REGION ??= 'us-east-1';
}
