/**
 * Provision the local Floci emulator with everything the orchestrator expects
 * to already exist in AWS: the 32 DynamoDB tables, the S3 buckets, the config
 * invalidation SNS topic, and the scheduled fire SQS queue.
 *
 *   npm run local:provision
 *
 * Idempotent. Re-running against an already provisioned emulator is a no-op
 * and reports every resource as "exists". The dev launcher runs this on every
 * start because the emulator is in-memory by default, so a fresh container
 * always needs a fresh provision.
 *
 * Table schemas are NOT hand written here. They are synthesized from the real
 * CDK stack (see table-schemas.ts) so a new table in infra/ is provisioned
 * locally without anyone remembering to update this file.
 *
 * This script refuses to run unless the AWS isolation guard passes, so it can
 * never create resources in a real account.
 */

import {
  DynamoDBClient,
  CreateTableCommand,
  ListTablesCommand,
  type GlobalSecondaryIndex,
  type AttributeDefinition,
  type KeySchemaElement,
} from '@aws-sdk/client-dynamodb';
import {
  S3Client,
  CreateBucketCommand,
  ListBucketsCommand,
  PutBucketCorsCommand,
} from '@aws-sdk/client-s3';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { createHash } from 'node:crypto';
import { SNSClient, CreateTopicCommand } from '@aws-sdk/client-sns';
import { SQSClient, CreateQueueCommand } from '@aws-sdk/client-sqs';
import { buildResourceNames } from '../../infra/lib/constants.js';
import { deriveTableSchemas, type TableSchema } from './table-schemas.js';
import { runGuard, isMainModule } from './guard.js';

const region = process.env.AWS_REGION ?? 'us-east-1';

function toCreateTableInput(s: TableSchema) {
  const attrs = new Map<string, AttributeDefinition>();
  const add = (name: string, type: 'S' | 'N' | 'B') =>
    attrs.set(name, { AttributeName: name, AttributeType: type });

  add(s.partitionKey.name, s.partitionKey.type);
  const keySchema: KeySchemaElement[] = [{ AttributeName: s.partitionKey.name, KeyType: 'HASH' }];
  if (s.sortKey) {
    add(s.sortKey.name, s.sortKey.type);
    keySchema.push({ AttributeName: s.sortKey.name, KeyType: 'RANGE' });
  }

  const gsis: GlobalSecondaryIndex[] = s.gsis.map((g) => {
    add(g.partitionKey.name, g.partitionKey.type);
    const ks: KeySchemaElement[] = [{ AttributeName: g.partitionKey.name, KeyType: 'HASH' }];
    if (g.sortKey) {
      add(g.sortKey.name, g.sortKey.type);
      ks.push({ AttributeName: g.sortKey.name, KeyType: 'RANGE' });
    }
    return {
      IndexName: g.indexName,
      KeySchema: ks,
      Projection: { ProjectionType: 'ALL' as const },
    };
  });

  return {
    TableName: s.tableName,
    AttributeDefinitions: [...attrs.values()],
    KeySchema: keySchema,
    BillingMode: 'PAY_PER_REQUEST' as const,
    ...(gsis.length > 0 ? { GlobalSecondaryIndexes: gsis } : {}),
  };
}

async function provisionTables(): Promise<{ created: number; existed: number }> {
  const ddb = new DynamoDBClient({ region });
  const existing = new Set((await ddb.send(new ListTablesCommand({}))).TableNames ?? []);
  const schemas = deriveTableSchemas();

  let created = 0;
  let existed = 0;
  for (const s of schemas) {
    if (existing.has(s.tableName)) {
      existed += 1;
      continue;
    }
    await ddb.send(new CreateTableCommand(toCreateTableInput(s)));
    created += 1;
  }
  return { created, existed };
}

/**
 * The buckets the running orchestrator reads and writes. Deliberately excludes
 * AUDIT_LOCK_BUCKET: it relies on S3 Object Lock, which the emulator does not
 * reproduce, and the audit writer no-ops cleanly when the variable is unset.
 */
async function provisionBuckets(names: ReturnType<typeof buildResourceNames>) {
  const s3 = new S3Client({ region });
  const wanted = [
    names.configBucket,
    names.rawBucket,
    names.curatedBucket,
    names.vectorsStagingBucket,
  ];
  const existing = new Set(
    ((await s3.send(new ListBucketsCommand({}))).Buckets ?? []).map((b) => b.Name ?? ''),
  );

  let created = 0;
  let existed = 0;
  for (const bucket of wanted) {
    if (existing.has(bucket)) {
      existed += 1;
    } else {
      await s3.send(new CreateBucketCommand({ Bucket: bucket }));
      created += 1;
    }
  }

  // The vectors bucket is the only one a browser PUTs to directly, via a
  // presigned upload URL, so it needs CORS. Best effort: a CORS failure must
  // not fail the whole provision.
  try {
    await s3.send(
      new PutBucketCorsCommand({
        Bucket: names.vectorsStagingBucket,
        CORSConfiguration: {
          CORSRules: [
            {
              AllowedMethods: ['PUT', 'GET', 'HEAD'],
              // Any origin, because Vite increments its port when 5173 is
              // taken and pinning a single origin silently breaks uploads.
              // Safe here: this bucket exists only inside the local emulator.
              AllowedOrigins: ['*'],
              AllowedHeaders: ['*'],
              ExposeHeaders: ['ETag'],
            },
          ],
        },
      }),
    );
  } catch (err) {
    process.stdout.write(
      `  note: could not set CORS on ${names.vectorsStagingBucket} ` +
        `(${err instanceof Error ? err.message : String(err)}). Browser uploads may be blocked.\n`,
    );
  }

  return { created, existed, buckets: wanted };
}

/**
 * Ensure the DASHBOARD_TOKEN has a complete, active row in the tokens table.
 *
 * Why this exists: `authenticateDashboardToken` denies the env root token when
 * a row for its hash exists but is not `active`. `touchLastUsed` is a bare
 * UpdateItem, so it UPSERTS a stub row containing only `lastUsedAt` if the row
 * is missing, and `seedRootToken` is guarded by `attribute_not_exists(PK)` so
 * it can never repair that stub. The result is a permanent 401 with a correct
 * token.
 *
 * Locally this is easy to trigger: `local:reset` empties DynamoDB while the
 * orchestrator is still running, its in-process `rootSeeded` flag suppresses a
 * reseed, and the next request's fire-and-forget touch recreates the stub.
 *
 * Writing a complete row here (and overwriting an incomplete one) makes reset
 * self healing. Runs on every provision, so `npm run local` is always usable.
 */
async function ensureRootToken(tableName: string): Promise<string> {
  const token = process.env.DASHBOARD_TOKEN;
  if (!token || token === 'REPLACE_ME') return 'skipped (DASHBOARD_TOKEN unset)';

  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const key = { PK: `TOKEN#${tokenHash}`, SK: 'META' };

  const existing = (await doc.send(new GetCommand({ TableName: tableName, Key: key }))).Item;
  if (existing && existing.active === true) return 'already active';

  const now = new Date().toISOString();
  await doc.send(
    new PutCommand({
      TableName: tableName,
      Item: {
        ...key,
        tokenHash,
        label: 'Root token',
        createdAt: existing?.createdAt ?? now,
        lastUsedAt: existing?.lastUsedAt ?? now,
        createdBy: 'local-provision',
        active: true,
        role: 'admin',
      },
    }),
  );
  return existing ? 'repaired an incomplete row' : 'seeded';
}

async function provisionMessaging(names: ReturnType<typeof buildResourceNames>) {
  // Both are idempotent in the AWS API: creating an existing topic or queue
  // returns the existing ARN/URL rather than erroring.
  const topicArn =
    (await new SNSClient({ region }).send(
      new CreateTopicCommand({ Name: names.configInvalidationTopic }),
    )).TopicArn ?? '(unknown)';
  const queueUrl =
    (await new SQSClient({ region }).send(new CreateQueueCommand({ QueueName: names.scheduledFireQueue })))
      .QueueUrl ?? '(unknown)';
  return { topicArn, queueUrl };
}

async function main(): Promise<number> {
  const checks = await runGuard();
  if (!checks.every((c) => c.ok)) {
    process.stderr.write('\nRefusing to provision: AWS isolation is not confirmed.\n');
    for (const c of checks.filter((x) => !x.ok)) {
      process.stderr.write(`  FAIL  ${c.title}\n        ${c.detail}\n`);
    }
    process.stderr.write('\nRun `npm run local:verify` for the full report.\n\n');
    return 1;
  }

  const names = buildResourceNames();
  process.stdout.write(`\nProvisioning local emulator at ${process.env.AWS_ENDPOINT_URL}\n`);

  const tables = await provisionTables();
  process.stdout.write(
    `  DynamoDB   ${tables.created} created, ${tables.existed} already present ` +
      `(${tables.created + tables.existed} tables)\n`,
  );

  const buckets = await provisionBuckets(names);
  process.stdout.write(`  S3         ${buckets.created} created, ${buckets.existed} already present\n`);

  const messaging = await provisionMessaging(names);
  process.stdout.write(`  SNS topic  ${messaging.topicArn}\n`);
  process.stdout.write(`  SQS queue  ${messaging.queueUrl}\n`);

  const rootToken = await ensureRootToken(names.ddb.dashboardTokens);
  process.stdout.write(`  Login      root dashboard token: ${rootToken}\n\n`);

  return 0;
}

if (isMainModule(import.meta.url)) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`\nProvisioning failed: ${err instanceof Error ? err.stack : String(err)}\n\n`);
      process.exit(1);
    });
}
