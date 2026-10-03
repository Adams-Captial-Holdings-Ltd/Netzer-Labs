import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { StorageStack } from './storage-stack.js';
import { SecretsStack } from './secrets-stack.js';
import { DynamoStack } from './dynamo-stack.js';
import { MessagingStack } from './messaging-stack.js';
import { IamStack } from './iam-stack.js';
import { RESOURCE_NAMES } from './constants.js';

function stacks() {
  const app = new App();
  const base = { env: { account: '123456789012', region: 'us-east-1' }, tier: 1 as const };
  const storage = new StorageStack(app, 'CCE-Storage', base);
  const secrets = new SecretsStack(app, 'CCE-Secrets', { ...base, dataKey: storage.dataKey });
  const dynamo = new DynamoStack(app, 'CCE-Dynamo', { ...base, dataKey: storage.dataKey });
  const messaging = new MessagingStack(app, 'CCE-Messaging', { ...base, configBucket: storage.configBucket });
  const iam = new IamStack(app, 'CCE-Iam', { ...base, storage, secrets, dynamo, messaging });
  const tables = Template.fromStack(dynamo).findResources('AWS::DynamoDB::Table');
  const table = Object.values(tables).find((resource) => resource.Properties.TableName === RESOURCE_NAMES.ddb.effectLedger)!;
  return { table: table.Properties, iam: Template.fromStack(iam) };
}

describe('effect ledger table', () => {
  it('has the frozen partition and sort keys', () => {
    expect(stacks().table.KeySchema).toEqual([{ AttributeName: 'PK', KeyType: 'HASH' }, { AttributeName: 'SK', KeyType: 'RANGE' }]);
  });
  it('keeps point-in-time recovery and has no expiry configuration', () => {
    const table = stacks().table;
    expect(table.PointInTimeRecoverySpecification.PointInTimeRecoveryEnabled).toBe(true);
    expect(table).not.toHaveProperty('TimeToLiveSpecification');
  });
  it('has the sparse unknown index', () => {
    expect(stacks().table.GlobalSecondaryIndexes).toEqual(expect.arrayContaining([expect.objectContaining({
      IndexName: 'gsi1-unknown', Projection: { ProjectionType: 'ALL' },
      KeySchema: [{ AttributeName: 'GSI1PK', KeyType: 'HASH' }, { AttributeName: 'GSI1SK', KeyType: 'RANGE' }],
    })]));
  });
  it('grants the task role the table and index', () => {
    const iam = stacks().iam;
    const rendered = JSON.stringify({ ...iam.findResources('AWS::IAM::Policy'), ...iam.findResources('AWS::IAM::ManagedPolicy') });
    expect(rendered).toContain('EffectLedgerTable');
    const statements = Object.values(iam.findResources('AWS::IAM::ManagedPolicy')).flatMap((policy) =>
      (policy.Properties.PolicyDocument.Statement as Array<{ Sid?: string; Resource?: unknown }>));
    const resources = (statements.find((statement) => statement.Sid === 'DdbRW')?.Resource ?? []) as unknown[];
    const effect = resources.find((resource) => JSON.stringify(resource).includes('EffectLedgerTable'));
    expect(effect).toBeDefined();
    expect(resources).toContainEqual({ 'Fn::Join': ['', [effect, '/index/*']] });
  });
});
