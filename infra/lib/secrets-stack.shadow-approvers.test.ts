import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { StorageStack } from './storage-stack.js';
import { SecretsStack } from './secrets-stack.js';
import { DynamoStack } from './dynamo-stack.js';
import { MessagingStack } from './messaging-stack.js';
import { IamStack } from './iam-stack.js';
import { NetworkStack } from './network-stack.js';
import { ComputeStack } from './compute-stack.js';

type Statement = { Sid?: string; Action?: string | string[]; Resource?: unknown };
function synth(staging = false) {
  vi.stubEnv('CCE_CICD_ENABLED', '1');
  vi.stubEnv('CCE_GITHUB_OWNER', 'example');
  vi.stubEnv('CCE_GITHUB_REPO', 'netzer');
  vi.stubEnv('CCE_GITHUB_DEPLOY_REFS', 'refs/heads/main');
  vi.stubEnv('CCE_NAME_SUFFIX', staging ? 'staging' : '');
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
  const policy = Template.fromStack(iam).findResources('AWS::IAM::Policy');
  const statements = Object.values(policy).flatMap((p) => p.Properties.PolicyDocument.Statement as Statement[]);
  const result = { secrets: Template.fromStack(secrets), compute: Template.fromStack(compute),
    iam: Template.fromStack(iam), statements };
  vi.unstubAllEnvs();
  return result;
}
describe('shadow approvers secret', () => {
  let built: ReturnType<typeof synth>;
  beforeAll(() => { built = synth(); });
  it('has the exact name and empty v1 value', () => {
    const rows = Object.values(built.secrets.findResources('AWS::SecretsManager::Secret'));
    const row = rows.find((r) => r.Properties.Name === '/claudeclaw/shadow-approvers');
    expect(row).toBeDefined();
    expect(row?.Properties.SecretString).toBe('{"v":1,"slots":{}}');
    expect(row?.Properties.GenerateSecretString).toBeUndefined();
    const setup = rows.find((r) => r.Properties.Name === '/claudeclaw/shadow-approvers-setup');
    expect(setup?.Properties.SecretString).toBe('{"v":1,"slots":{}}');
  });
  it('grants task runtime GetSecretValue on only this ARN', () => {
    const row = built.statements.find((s) => s.Sid === 'ShadowApproversRead');
    expect(row?.Action).toBe('secretsmanager:GetSecretValue');
    expect(row?.Resource).toEqual({ 'Fn::ImportValue': expect.stringMatching(/SecretShadowApprovers(?!Setup)/) });
    const runtimePolicy = Object.values(built.iam.findResources('AWS::IAM::Policy'))
      .find((policy) => JSON.stringify(policy).includes('ShadowApproversRead'));
    expect(runtimePolicy?.Properties.Roles).toEqual([{ Ref: expect.stringMatching(/^TaskRole/) }]);
    const computePolicies = Object.values(built.compute.findResources('AWS::IAM::Policy'));
    expect(JSON.stringify([...built.statements, ...computePolicies]))
      .not.toContain('SecretShadowApproversSetup');
    expect(JSON.stringify([...built.statements, ...computePolicies]))
      .not.toContain('/claudeclaw/shadow-approvers-setup');
    expect([...built.statements.filter((s) => s !== row), ...computePolicies]
      .filter((s) => JSON.stringify(s).includes('SecretShadowApprovers'))).toEqual([]);
  });
  it('has no PutSecretValue grant for the shadow secret', () => {
    const row = built.statements.find((s) => s.Sid === 'ShadowApproversRead');
    expect(JSON.stringify(row)).not.toContain('PutSecretValue');
  });
  it('passes the secret name as a plain orchestrator environment value', () => {
    const tasks = Object.values(built.compute.findResources('AWS::ECS::TaskDefinition'));
    const orch = tasks.flatMap((t) => t.Properties.ContainerDefinitions ?? []).find((c) => c.Name === 'orchestrator');
    expect(orch?.Environment).toContainEqual({ Name: 'SHADOW_APPROVERS_SECRET_ID', Value: '/claudeclaw/shadow-approvers' });
    expect(orch?.Secrets?.some((s: { Name: string }) => s.Name === 'SHADOW_APPROVERS_SECRET_ID')).toBe(false);
  });
  it('deploy role Paperclip grants cannot match the shadow secret', () => {
    const rows = [
      ...built.statements.filter((s) => s.Sid === 'PaperclipSecretPopulate'),
      ...synth(true).statements.filter((s) => s.Sid === 'PaperclipSecretPopulateStaging'),
    ];
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      for (const pattern of Array.isArray(row.Resource) ? row.Resource : [row.Resource]) {
        const arn = String(pattern);
        const regexp = new RegExp(`^${arn.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
        expect(regexp.test('arn:aws:secretsmanager:us-east-1:123456789012:secret:/claudeclaw/shadow-approvers-ABCDEF')).toBe(false);
      }
    }
  });
});
