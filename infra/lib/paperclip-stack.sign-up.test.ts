import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { NetworkStack } from './network-stack.js';
import { StorageStack } from './storage-stack.js';
import { SecretsStack } from './secrets-stack.js';
import { DynamoStack } from './dynamo-stack.js';
import { MessagingStack } from './messaging-stack.js';
import { IamStack } from './iam-stack.js';
import { ComputeStack } from './compute-stack.js';
import { FilesystemStack } from './filesystem-stack.js';
import { PaperclipStack } from './paperclip-stack.js';

function containers(windowOpen = false) {
  const app = new App();
  const base = { env: { account: '123456789012', region: 'us-east-1' }, tier: 1 as const };
  const network = new NetworkStack(app, 'CCE-Network', base);
  const storage = new StorageStack(app, 'CCE-Storage', base);
  const secrets = new SecretsStack(app, 'CCE-Secrets', { ...base, dataKey: storage.dataKey });
  const dynamo = new DynamoStack(app, 'CCE-Dynamo', { ...base, dataKey: storage.dataKey });
  const messaging = new MessagingStack(app, 'CCE-Messaging', { ...base, configBucket: storage.configBucket });
  const iam = new IamStack(app, 'CCE-Iam', { ...base, storage, secrets, dynamo, messaging });
  const compute = new ComputeStack(app, 'CCE-Compute', { ...base, paperclipSignupWindow: windowOpen,
    vpc: network.vpc, albSecurityGroup: network.albSecurityGroup,
    fargateSecurityGroup: network.fargateSecurityGroup,
    dispatchLoadBalancerSecurityGroup: network.dispatchLoadBalancerSecurityGroup,
    taskRole: iam.taskRole, secrets, logsBucket: storage.logsBucket, messaging });
  const files = new FilesystemStack(app, 'CCE-Filesystem', { ...base, vpc: network.vpc,
    paperclipSecurityGroup: network.paperclipSecurityGroup });
  const paperclip = new PaperclipStack(app, 'CCE-Paperclip', { ...base, paperclipSignupWindow: windowOpen,
    vpc: network.vpc, paperclipSecurityGroup: network.paperclipSecurityGroup, cluster: compute.cluster,
    fileSystem: files.paperclipFileSystem, accessPoint: files.paperclipAccessPoint,
    logGroup: files.paperclipLogGroup, paperclipSecret: secrets.paperclipSecret });
  const c = Object.values(Template.fromStack(compute).findResources('AWS::ECS::TaskDefinition'))
    .flatMap((t) => t.Properties.ContainerDefinitions ?? []).find((x) => x.Name === 'orchestrator');
  const p = Object.values(Template.fromStack(paperclip).findResources('AWS::ECS::TaskDefinition'))
    .flatMap((t) => t.Properties.ContainerDefinitions ?? []).find((x) => x.Name === 'paperclip-server');
  return { orchestrator: c, paperclip: p };
}
const env = (container: { Environment?: Array<{ Name: string; Value: string }> } | undefined) =>
  Object.fromEntries((container?.Environment ?? []).map((row) => [row.Name, row.Value]));

describe('Paperclip sign-up window', () => {
  it('sign-up is closed by default', () => {
    const { paperclip, orchestrator } = containers();
    expect(env(paperclip).PAPERCLIP_AUTH_DISABLE_SIGN_UP).toBe('true');
    expect(env(orchestrator).PAPERCLIP_SIGNUP_WINDOW).toBeUndefined();
    expect(orchestrator?.Secrets).toEqual(expect.arrayContaining([
      expect.objectContaining({ Name: 'PAPERCLIP_SIGNUP_PROBE_EMAIL' }),
    ]));
  });
  it('an explicit window opens sign-up and marks the orchestrator', () => {
    const { paperclip, orchestrator } = containers(true);
    expect(env(paperclip).PAPERCLIP_AUTH_DISABLE_SIGN_UP).toBeUndefined();
    expect(env(orchestrator).PAPERCLIP_SIGNUP_WINDOW).toBe('open');
  });
});
