/**
 * Synth-level assertion for the orchestrator's War Room table wiring (WRT-9, M12).
 *
 * `infra/lib/compute-stack.ts:395-421` exports 25 `TABLE_*` environment variables
 * to the orchestrator container and none of the three War Room ones, so
 * `src/lib/warroom/*` falls back to the unsuffixed literals compiled into
 * `meetings-repo.ts:14-15` and `publisher.ts:6-7`. Production answers correctly
 * only because its `${app}` prefix happens to equal that fallback; a suffixed
 * environment asks for production's table names and is denied, which is why every
 * War Room read on staging returns 500.
 *
 * The expectations below are LITERAL strings, per the A20 convention recorded in
 * `paperclip-stack.test.ts:18-21`: asserting against
 * `RESOURCE_NAMES.ddb.warroomMeetings` would compare the constant the stack used
 * to synthesize the value with itself, and would keep passing under any rename —
 * which is precisely the class of fault this test exists to catch.
 *
 * The synth is hermetic and needs no AWS credentials: `CCE_NAME_SUFFIX` is pinned
 * empty so this is the production name set regardless of the developer's ambient
 * environment, and `DOMAIN_NAME` is pinned empty because a non-empty value takes
 * the `HostedZone.fromLookup` branch at `compute-stack.ts:1103` and would reach
 * AWS. Both are read at import time or during synthesis, so they are stubbed
 * before the stack modules are loaded.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';

const ENV = { account: '637423318609', region: 'us-east-1' };

/**
 * The `TABLE_*` block is a flat literal on the orchestrator container
 * (`compute-stack.ts:323`), not gated on tier, so either tier proves the same
 * wiring. Tier 1 matches the existing orchestrator env assertions in
 * `paperclip-stack.test.ts`.
 */
const TIER = 1;

interface ContainerDef {
  Name?: string;
  Environment?: { Name: string; Value: string }[];
  Secrets?: { Name: string; ValueFrom: unknown }[];
  PortMappings?: { ContainerPort: number }[];
}

interface TaskDefProps {
  ContainerDefinitions: ContainerDef[];
}

describe('ComputeStack — orchestrator War Room table names', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  /**
   * `suffix` is what `CCE_NAME_SUFFIX` would be for the target environment:
   * empty for production, `staging` for staging. `APP_NAME_SUFFIX` is read when
   * constants.ts is first evaluated (constants.ts:16) and `RESOURCE_NAMES` is
   * frozen from it (constants.ts:236), so it is stubbed here — before the
   * dynamic imports — rather than in a hook that runs after a static import.
   */
  async function synthCompute(suffix: string, tier: 0 | 1 = TIER) {
    vi.stubEnv('CCE_NAME_SUFFIX', suffix);
    vi.stubEnv('DOMAIN_NAME', '');

    const [
      { NetworkStack },
      { StorageStack },
      { SecretsStack },
      { DynamoStack },
      { MessagingStack },
      { IamStack },
      { ComputeStack },
    ] = await Promise.all([
      import('./network-stack.js'),
      import('./storage-stack.js'),
      import('./secrets-stack.js'),
      import('./dynamo-stack.js'),
      import('./messaging-stack.js'),
      import('./iam-stack.js'),
      import('./compute-stack.js'),
    ]);

    const app = new App();
    const net = new NetworkStack(app, 'CCE-Network', { tier, env: ENV });
    const storage = new StorageStack(app, 'CCE-Storage', { tier, env: ENV });
    const secrets = new SecretsStack(app, 'CCE-Secrets', {
      tier,
      env: ENV,
      dataKey: storage.dataKey,
    });
    const dynamo = new DynamoStack(app, 'CCE-Dynamo', {
      tier,
      env: ENV,
      dataKey: storage.dataKey,
    });
    const messaging = new MessagingStack(app, 'CCE-Messaging', {
      tier,
      env: ENV,
      configBucket: storage.configBucket,
    });
    const iam = new IamStack(app, 'CCE-Iam', {
      tier,
      env: ENV,
      storage,
      secrets,
      dynamo,
      messaging,
    });
    const compute = new ComputeStack(app, 'CCE-Compute', {
      tier,
      env: ENV,
      vpc: net.vpc,
      albSecurityGroup: net.albSecurityGroup,
      fargateSecurityGroup: net.fargateSecurityGroup,
      dispatchLoadBalancerSecurityGroup: net.dispatchLoadBalancerSecurityGroup,
      taskRole: iam.taskRole,
      secrets,
      logsBucket: storage.logsBucket,
      messaging,
    });

    // ComputeStack synthesizes more than one task definition (the orchestrator
    // and the consolidation task). Selecting the wrong one would make this test
    // pass or fail for a reason that has nothing to do with the wiring.
    const template = Template.fromStack(compute);
    const orchestrator = Object.values(
      template.findResources('AWS::ECS::TaskDefinition'),
    )
      .flatMap((r) => (r.Properties as TaskDefProps).ContainerDefinitions ?? [])
      .find((c) => c.Name === 'orchestrator');

    if (!orchestrator) {
      throw new Error('no container named "orchestrator" in the synthesized ComputeStack');
    }

    return {
      template,
      network: Template.fromStack(net),
      iam: Template.fromStack(iam),
      orchestrator,
      env: Object.fromEntries((orchestrator.Environment ?? []).map((e) => [e.Name, e.Value])),
    };
  }

  async function orchestratorEnv(suffix: string) {
    return (await synthCompute(suffix)).env;
  }

  // Seven stacks are synthesized per case, which takes far longer than Vitest's
  // 5 s default. The other infra suites never needed a timeout because they are
  // synchronous: a blocked event loop never lets the timer fire. These must be
  // async to load the stack modules *after* the suffix is stubbed, so the timer
  // is live and the budget has to be stated. Observed 9-62 s depending on
  // whether the transform cache is warm, hence the generous ceiling.
  const BUDGET = 180_000;

  it('registers private dispatch and keeps the ALB on port 3000', async () => {
    const { template, orchestrator, env } = await synthCompute('');
    template.hasResourceProperties('AWS::ServiceDiscovery::PrivateDnsNamespace', {
      Name: 'claudeclaw-dispatch.internal',
    });
    template.hasResourceProperties('AWS::ServiceDiscovery::Service', {
      Name: 'orchestrator',
      DnsConfig: { DnsRecords: [{ TTL: 10, Type: 'A' }] },
    });
    const service = Object.values(template.findResources('AWS::ECS::Service'))[0].Properties;
    expect(service.ServiceRegistries).toHaveLength(1);
    expect(JSON.stringify(service.ServiceRegistries)).toMatch(/Service.*Arn/);
    expect(orchestrator.PortMappings?.map((p) => p.ContainerPort)).toEqual([3000, 3001]);
    expect(env.PAPERCLIP_DISPATCH_PORT).toBe('3001');
    expect(orchestrator.Secrets).toContainEqual(expect.objectContaining({
      Name: 'PAPERCLIP_LOCK_AUDITOR_KEY',
      ValueFrom: expect.objectContaining({
        'Fn::Join': ['', expect.arrayContaining([':lock_auditor_key::'])],
      }),
    }));
    template.resourceCountIs('AWS::ElasticLoadBalancingV2::TargetGroup', 2);
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', { Port: 3000 });
    expect(service.LoadBalancers.map((lb: { ContainerPort: number }) => lb.ContainerPort)).toEqual([3000, 3001]);
  }, BUDGET);

  it('omits dispatch resources and wiring without Paperclip', async () => {
    const { template, orchestrator, env } = await synthCompute('', 0);
    template.resourceCountIs('AWS::ServiceDiscovery::PrivateDnsNamespace', 0);
    template.resourceCountIs('AWS::ServiceDiscovery::Service', 0);
    expect(orchestrator.PortMappings?.map((p) => p.ContainerPort)).toEqual([3000]);
    expect(env.PAPERCLIP_DISPATCH_PORT).toBeUndefined();
    expect(orchestrator.Secrets?.some((s) => s.Name === 'PAPERCLIP_LOCK_AUDITOR_KEY')).toBe(false);
    expect(
      Object.values(template.findResources('AWS::ECS::Service'))[0].Properties.ServiceRegistries,
    ).toBeUndefined();
  }, BUDGET);

  let dispatchSynth: ReturnType<typeof synthCompute> | undefined;
  const dispatch = () => (dispatchSynth ??= synthCompute(''));
  const resources = (template: Template, type: string) => Object.entries(template.findResources(type));

  it('dispatch load balancer: is internal network with one TCP listener on 3001', async () => {
    const { template } = await dispatch();
    const lbs = resources(template, 'AWS::ElasticLoadBalancingV2::LoadBalancer');
    const nlb = lbs.find(([, r]) => r.Properties.Type === 'network');
    expect(nlb?.[1].Properties).toEqual(expect.objectContaining({ Scheme: 'internal', Type: 'network' }));
    expect(nlb?.[1].Properties.Subnets).toHaveLength(2);
    expect(nlb?.[1].Properties.LoadBalancerAttributes).toContainEqual({ Key: 'load_balancing.cross_zone.enabled', Value: 'true' });
    const listeners = resources(template, 'AWS::ElasticLoadBalancingV2::Listener')
      .filter(([, r]) => JSON.stringify(r.Properties.LoadBalancerArn).includes(nlb![0]));
    expect(listeners).toHaveLength(1);
    expect(listeners[0][1].Properties).toEqual(expect.objectContaining({ Port: 3001, Protocol: 'TCP' }));
  }, BUDGET);

  it('dispatch load balancer: has IP TCP target group and 300 second drain', async () => {
    const { template } = await dispatch();
    const groups = resources(template, 'AWS::ElasticLoadBalancingV2::TargetGroup');
    const group = groups.find(([, r]) => r.Properties.Port === 3001)?.[1].Properties;
    expect(group).toEqual(expect.objectContaining({ TargetType: 'ip', Protocol: 'TCP', HealthCheckProtocol: 'TCP', HealthCheckPort: 'traffic-port' }));
    expect(group.TargetGroupAttributes).toContainEqual({ Key: 'deregistration_delay.timeout_seconds', Value: '300' });
  }, BUDGET);

  it('dispatch load balancer: is wholly absent without Paperclip', async () => {
    const { template, network } = await synthCompute('', 0);
    expect(resources(template, 'AWS::ElasticLoadBalancingV2::LoadBalancer').filter(([, r]) => r.Properties.Type === 'network')).toHaveLength(0);
    expect(resources(template, 'Custom::AWS')).toHaveLength(0);
    expect(template.toJSON().Outputs?.DispatchLoadBalancerIp).toBeUndefined();
    expect(JSON.stringify(network.toJSON())).not.toContain('DispatchNlbSg');
  }, BUDGET);

  it('dispatch load balancer: admits only Paperclip to NLB and NLB to Fargate on 3001', async () => {
    const { network } = await dispatch();
    const rules = resources(network, 'AWS::EC2::SecurityGroupIngress').map(([, r]) => r.Properties)
      .filter((r) => r.FromPort === 3001);
    expect(rules).toEqual(expect.arrayContaining([
      expect.objectContaining({ GroupId: expect.objectContaining({ 'Fn::GetAtt': [expect.stringMatching(/DispatchNlbSg/), 'GroupId'] }), SourceSecurityGroupId: expect.objectContaining({ 'Fn::GetAtt': [expect.stringMatching(/PaperclipSg/), 'GroupId'] }) }),
      expect.objectContaining({ GroupId: expect.objectContaining({ 'Fn::GetAtt': [expect.stringMatching(/FargateSg/), 'GroupId'] }), SourceSecurityGroupId: expect.objectContaining({ 'Fn::GetAtt': [expect.stringMatching(/DispatchNlbSg/), 'GroupId'] }) }),
    ]));
    expect(rules.filter((r) => JSON.stringify(r.GroupId).includes('DispatchNlbSg'))).toHaveLength(1);
    expect(rules.every((r) => !r.CidrIp && !r.CidrIpv6)).toBe(true);
  }, BUDGET);

  it('dispatch load balancer: looks up the first NLB interface private IP', async () => {
    const { template } = await dispatch();
    const lookup = resources(template, 'Custom::AWS')[0]?.[1].Properties;
    expect(JSON.stringify(lookup)).toContain('describeNetworkInterfaces');
    expect(JSON.stringify(lookup)).toContain('ELB ');
    expect(JSON.stringify(template.toJSON().Outputs?.DispatchLoadBalancerIp)).toContain('PrivateIpAddress');
  }, BUDGET);

  it('dispatch load balancer: lookup policy grants only DescribeNetworkInterfaces', async () => {
    const { template } = await dispatch();
    const policies = resources(template, 'AWS::IAM::Policy').map(([, r]) => r.Properties.PolicyDocument.Statement).flat();
    const lookup = policies.filter((s) => JSON.stringify(s.Action).includes('ec2:DescribeNetworkInterfaces'));
    expect(lookup).toHaveLength(1);
    expect(lookup[0].Action).toBe('ec2:DescribeNetworkInterfaces');
  }, BUDGET);

  it('dispatch load balancer: listener leaves TCP idle timeout at its default', async () => {
    const { template } = await dispatch();
    const listener = resources(template, 'AWS::ElasticLoadBalancingV2::Listener').find(([, r]) => r.Properties.Port === 3001)?.[1].Properties;
    expect(listener?.ListenerAttributes).toBeUndefined();
  }, BUDGET);

  it('dispatch load balancer: keeps Service logical id and ALB target beside dispatch target', async () => {
    const { template } = await dispatch();
    const service = resources(template, 'AWS::ECS::Service').find(([id]) => id === 'ServiceD69D759B');
    expect(service).toBeDefined();
    expect(service![1].Properties.LoadBalancers.map((lb: { ContainerPort: number }) => lb.ContainerPort)).toEqual([3000, 3001]);
    expect(resources(template, 'AWS::ElasticLoadBalancingV2::TargetGroup').some(([, r]) => r.Properties.Port === 3000)).toBe(true);
  }, BUDGET);

  it('task protection grant names both ECS actions for this cluster only', async () => {
    const { iam } = await dispatch();
    const statements = Object.values(iam.toJSON().Resources).flatMap((r: any) => r.Properties?.PolicyDocument?.Statement ?? []);
    const grant = statements.find((s) => s.Sid === 'EcsTaskProtection');
    expect(grant.Action).toEqual(['ecs:UpdateTaskProtection', 'ecs:GetTaskProtection']);
    expect(JSON.stringify(grant.Resource)).toContain('task/claudeclaw-cluster/*');
    expect(grant.Resource).not.toBe('*');
  }, BUDGET);

  it(
    'exports the three War Room table names to the orchestrator container',
    async () => {
      const env = await orchestratorEnv('');

      expect(env.TABLE_WARROOM_MEETINGS).toBe('claudeclaw-warroom-meetings');
      expect(env.TABLE_WARROOM_TURNS).toBe('claudeclaw-warroom-turns');
      expect(env.TABLE_WARROOM_CONNECTIONS).toBe('claudeclaw-warroom-connections');
    },
    BUDGET,
  );

  /**
   * The reason the fix exists. A suffixed environment has its own War Room
   * tables (`claudeclaw-staging-warroom-*` exist alongside production's), but
   * before this export the orchestrator asked for the unsuffixed production
   * names and the staging task role was denied, so every War Room read 500'd.
   */
  it(
    'carries the suffix through, so a staging deploy reads its own tables',
    async () => {
      const env = await orchestratorEnv('staging');

      expect(env.TABLE_WARROOM_MEETINGS).toBe('claudeclaw-staging-warroom-meetings');
      expect(env.TABLE_WARROOM_TURNS).toBe('claudeclaw-staging-warroom-turns');
      expect(env.TABLE_WARROOM_CONNECTIONS).toBe('claudeclaw-staging-warroom-connections');
    },
    BUDGET,
  );
});
