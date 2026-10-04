import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';
import { StorageStack } from './storage-stack.js';
import { SecretsStack } from './secrets-stack.js';
import { DynamoStack } from './dynamo-stack.js';
import { MessagingStack } from './messaging-stack.js';
import { IamStack } from './iam-stack.js';
import { RESOURCE_NAMES } from './constants.js';
import { NetworkStack } from './network-stack.js';
import { ComputeStack } from './compute-stack.js';

function stacks() {
  const app = new App();
  const base = { env: { account: '123456789012', region: 'us-east-1' }, tier: 1 as const };
  const network = new NetworkStack(app, 'CCE-Network', base);
  const storage = new StorageStack(app, 'CCE-Storage', base);
  const secrets = new SecretsStack(app, 'CCE-Secrets', { ...base, dataKey: storage.dataKey });
  const dynamo = new DynamoStack(app, 'CCE-Dynamo', { ...base, dataKey: storage.dataKey });
  const messaging = new MessagingStack(app, 'CCE-Messaging', { ...base, configBucket: storage.configBucket });
  const iam = new IamStack(app, 'CCE-Iam', { ...base, storage, secrets, dynamo, messaging });
  const compute = new ComputeStack(app, 'CCE-Compute', { ...base, vpc: network.vpc,
    albSecurityGroup: network.albSecurityGroup, fargateSecurityGroup: network.fargateSecurityGroup,
    dispatchLoadBalancerSecurityGroup: network.dispatchLoadBalancerSecurityGroup,
    taskRole: iam.taskRole, secrets, logsBucket: storage.logsBucket, messaging });
  const tables = Template.fromStack(dynamo).findResources('AWS::DynamoDB::Table');
  const table = Object.values(tables).find((resource) => resource.Properties.TableName === RESOURCE_NAMES.ddb.effectLedger)!;
  return { table: table.Properties, resource: table, iam: Template.fromStack(iam), compute: Template.fromStack(compute) };
}

describe('effect ledger table', () => {
  let built: ReturnType<typeof stacks>;
  beforeAll(() => { built = stacks(); });
  it('has the frozen partition and sort keys', () => {
    expect(built.table.KeySchema).toEqual([{ AttributeName: 'PK', KeyType: 'HASH' }, { AttributeName: 'SK', KeyType: 'RANGE' }]);
  });
  it('keeps point-in-time recovery and has no expiry configuration', () => {
    const table = built.table;
    expect(table.PointInTimeRecoverySpecification.PointInTimeRecoveryEnabled).toBe(true);
    expect(table).not.toHaveProperty('TimeToLiveSpecification');
  });
  it('has the sparse unknown index', () => {
    expect(built.table.GlobalSecondaryIndexes).toEqual(expect.arrayContaining([expect.objectContaining({
      IndexName: 'gsi1-unknown', Projection: { ProjectionType: 'ALL' },
      KeySchema: [{ AttributeName: 'GSI1PK', KeyType: 'HASH' }, { AttributeName: 'GSI1SK', KeyType: 'RANGE' }],
    })]));
  });
  it('grants the task role the table and index', () => {
    const iam = built.iam;
    const rendered = JSON.stringify({ ...iam.findResources('AWS::IAM::Policy'), ...iam.findResources('AWS::IAM::ManagedPolicy') });
    expect(rendered).toContain('EffectLedgerTable');
    const statements = Object.values(iam.findResources('AWS::IAM::ManagedPolicy')).flatMap((policy) =>
      (policy.Properties.PolicyDocument.Statement as Array<{ Sid?: string; Resource?: unknown }>));
    const resources = (statements.find((statement) => statement.Sid === 'DdbRW')?.Resource ?? []) as unknown[];
    const effect = resources.find((resource) => JSON.stringify(resource).includes('EffectLedgerTable'));
    expect(effect).toBeDefined();
    expect(resources).toContainEqual({ 'Fn::Join': ['', [effect, '/index/*']] });
  });
  it('retains the table and exports its name to the orchestrator', () => {
    expect(built.resource.DeletionPolicy).toBe('Retain');
    const tasks = Object.values(built.compute.findResources('AWS::ECS::TaskDefinition'));
    const orchestrator = tasks.flatMap((task) => task.Properties.ContainerDefinitions ?? [])
      .find((container) => container.Name === 'orchestrator');
    expect(orchestrator?.Environment).toContainEqual({ Name: 'TABLE_EFFECT_LEDGER', Value: RESOURCE_NAMES.ddb.effectLedger });
  });
});
