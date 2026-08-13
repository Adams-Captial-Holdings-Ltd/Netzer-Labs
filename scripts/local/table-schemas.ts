/**
 * Derive the exact DynamoDB table schemas for local provisioning by synthesizing
 * the real CDK DynamoStack in memory.
 *
 * Why synth instead of a hand-written table list: the CDK stack is already the
 * single source of truth for every table name, key schema, GSI and TTL
 * attribute. Copying that into a second list guarantees drift the first time
 * someone adds a table. Synth is a purely local operation. It builds a cloud
 * assembly on disk and never calls AWS, so this stays inside the local-only
 * boundary.
 *
 * The stack is synthesized with an explicit account and region so CDK never
 * performs an environment context lookup (the only thing in synth that would
 * reach for credentials).
 */

import { App, Stack } from 'aws-cdk-lib';
import { Key } from 'aws-cdk-lib/aws-kms';
import { DynamoStack } from '../../infra/lib/dynamo-stack.js';

/** A DynamoDB key or index attribute, in CreateTable wire shape. */
export interface KeyAttr {
  name: string;
  type: 'S' | 'N' | 'B';
}

export interface GsiSchema {
  indexName: string;
  partitionKey: KeyAttr;
  sortKey?: KeyAttr;
}

export interface TableSchema {
  tableName: string;
  partitionKey: KeyAttr;
  sortKey?: KeyAttr;
  gsis: GsiSchema[];
  /** TTL attribute name, when the table defines one. */
  ttlAttribute?: string;
}

/** CloudFormation AWS::DynamoDB::Table property shape, narrowed to what we read. */
interface CfnTableProps {
  TableName?: string;
  KeySchema?: Array<{ AttributeName: string; KeyType: 'HASH' | 'RANGE' }>;
  AttributeDefinitions?: Array<{ AttributeName: string; AttributeType: 'S' | 'N' | 'B' }>;
  GlobalSecondaryIndexes?: Array<{
    IndexName: string;
    KeySchema: Array<{ AttributeName: string; KeyType: 'HASH' | 'RANGE' }>;
  }>;
  TimeToLiveSpecification?: { AttributeName?: string; Enabled?: boolean };
}

function keyOf(
  keySchema: Array<{ AttributeName: string; KeyType: string }> | undefined,
  attrs: Map<string, 'S' | 'N' | 'B'>,
  keyType: 'HASH' | 'RANGE',
): KeyAttr | undefined {
  const entry = (keySchema ?? []).find((k) => k.KeyType === keyType);
  if (!entry) return undefined;
  return { name: entry.AttributeName, type: attrs.get(entry.AttributeName) ?? 'S' };
}

/**
 * Synthesize DynamoStack and return one TableSchema per AWS::DynamoDB::Table.
 *
 * Throws if synth yields no tables, which would otherwise let `provision`
 * silently create nothing and leave the developer with an empty local stack.
 */
export function deriveTableSchemas(): TableSchema[] {
  const app = new App();
  // Explicit env: pins the stack so CDK resolves without an account lookup.
  const host = new Stack(app, 'LocalSchemaHost', {
    env: { account: '000000000000', region: process.env.AWS_REGION ?? 'us-east-1' },
  });
  // A key *reference* by ARN. Purely local, no KMS API call.
  const dataKey = Key.fromKeyArn(
    host,
    'LocalDataKey',
    'arn:aws:kms:us-east-1:000000000000:key/00000000-0000-0000-0000-000000000000',
  );

  const stack = new DynamoStack(app, 'LocalDynamo', {
    env: { account: '000000000000', region: process.env.AWS_REGION ?? 'us-east-1' },
    dataKey,
  } as ConstructorParameters<typeof DynamoStack>[2]);

  const template = app.synth().getStackByName(stack.stackName).template as {
    Resources?: Record<string, { Type: string; Properties?: CfnTableProps }>;
  };

  const schemas: TableSchema[] = [];
  for (const res of Object.values(template.Resources ?? {})) {
    if (res.Type !== 'AWS::DynamoDB::Table') continue;
    const p = res.Properties ?? {};
    if (!p.TableName) continue;

    const attrs = new Map<string, 'S' | 'N' | 'B'>(
      (p.AttributeDefinitions ?? []).map((a) => [a.AttributeName, a.AttributeType]),
    );
    const partitionKey = keyOf(p.KeySchema, attrs, 'HASH');
    if (!partitionKey) continue;

    schemas.push({
      tableName: p.TableName,
      partitionKey,
      sortKey: keyOf(p.KeySchema, attrs, 'RANGE'),
      gsis: (p.GlobalSecondaryIndexes ?? []).map((g) => ({
        indexName: g.IndexName,
        partitionKey: keyOf(g.KeySchema, attrs, 'HASH') as KeyAttr,
        sortKey: keyOf(g.KeySchema, attrs, 'RANGE'),
      })),
      ttlAttribute: p.TimeToLiveSpecification?.Enabled
        ? p.TimeToLiveSpecification.AttributeName
        : undefined,
    });
  }

  if (schemas.length === 0) {
    throw new Error(
      'deriveTableSchemas(): CDK synth produced no DynamoDB tables. ' +
        'infra/lib/dynamo-stack.ts may have changed shape.',
    );
  }
  return schemas;
}
