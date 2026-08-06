import { describe, it, expect, beforeEach, vi } from 'vitest';
import { remediate, actionForRiskId, __setRemediationClients } from './cost-remediation.js';

vi.mock('../../observability/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {} },
}));

/**
 * The executor's whole job is to NOT lie: re-check idleness before mutating,
 * and only report success when a post-describe confirms it. These tests drive
 * each branch with a fake EC2/ELB client that returns a scripted sequence of
 * responses per command (so a describe can answer differently before vs after
 * the mutation) and asserts the mutating command is/ isn't called accordingly.
 */

type Handler = (cmd: unknown, callIndex: number) => unknown;

function makeClient(handlers: Record<string, Handler>) {
  const counts: Record<string, number> = {};
  const calls: string[] = [];
  const client = {
    calls,
    send: async (cmd: { constructor: { name: string } }) => {
      const name = cmd.constructor.name;
      calls.push(name);
      const n = counts[name] ?? 0;
      counts[name] = n + 1;
      const h = handlers[name];
      if (!h) throw new Error(`unexpected command ${name}`);
      const out = h(cmd, n);
      if (out instanceof Error) throw out;
      return out;
    },
  };
  return client;
}

beforeEach(() => __setRemediationClients({}));

describe('actionForRiskId', () => {
  it('maps risk ids to actions', () => {
    expect(actionForRiskId('nat-us-east-1')).toBe('delete-nat-gateway');
    expect(actionForRiskId('eip-us-east-1')).toBe('release-eip');
    expect(actionForRiskId('ebs-eu-west-1')).toBe('delete-ebs-volume');
    expect(actionForRiskId('lb-us-east-1')).toBe('delete-load-balancer');
    expect(actionForRiskId('vpce-us-east-1')).toBe('delete-vpc-endpoint');
    expect(actionForRiskId('mystery-x')).toBeNull();
  });
});

describe('release-eip', () => {
  it('releases an unassociated EIP and verifies it is gone', async () => {
    const ec2 = makeClient({
      DescribeAddressesCommand: (_c, n) =>
        n === 0
          ? { Addresses: [{ PublicIp: '1.2.3.4', AllocationId: 'eipalloc-1' }] } // pre: unassociated
          : { Addresses: [] }, // post: gone
      ReleaseAddressCommand: () => ({}),
    });
    __setRemediationClients({ ec2: () => ec2 as never });
    const r = await remediate({ action: 'release-eip', region: 'us-east-1', resourceId: '1.2.3.4' });
    expect(r.status).toBe('applied');
    expect(r.verified).toBe(true);
    expect(ec2.calls).toContain('ReleaseAddressCommand');
  });

  it('REFUSES to release an EIP that is now associated, and never calls release', async () => {
    const ec2 = makeClient({
      DescribeAddressesCommand: () => ({ Addresses: [{ PublicIp: '1.2.3.4', AllocationId: 'a', AssociationId: 'eipassoc-9', InstanceId: 'i-1' }] }),
      ReleaseAddressCommand: () => new Error('should not be called'),
    });
    __setRemediationClients({ ec2: () => ec2 as never });
    const r = await remediate({ action: 'release-eip', region: 'us-east-1', resourceId: '1.2.3.4' });
    expect(r.status).toBe('refused');
    expect(r.verified).toBe(false);
    expect(ec2.calls).not.toContain('ReleaseAddressCommand');
  });

  it('reports AccessDenied honestly as failed (perms not armed)', async () => {
    const denied = Object.assign(new Error('not authorized to perform ec2:ReleaseAddress'), { name: 'UnauthorizedOperation' });
    const ec2 = makeClient({
      DescribeAddressesCommand: () => ({ Addresses: [{ PublicIp: '1.2.3.4', AllocationId: 'a' }] }),
      ReleaseAddressCommand: () => denied,
    });
    __setRemediationClients({ ec2: () => ec2 as never });
    const r = await remediate({ action: 'release-eip', region: 'us-east-1', resourceId: '1.2.3.4' });
    expect(r.status).toBe('failed');
    expect(r.message).toMatch(/denied|not attached/i);
  });
});

describe('delete-nat-gateway', () => {
  it('REFUSES when a route table still routes to it', async () => {
    const ec2 = makeClient({
      DescribeNatGatewaysCommand: () => ({ NatGateways: [{ NatGatewayId: 'nat-1', State: 'available', VpcId: 'vpc-1' }] }),
      DescribeRouteTablesCommand: () => ({ RouteTables: [{ RouteTableId: 'rtb-7' }] }), // still routed
      DeleteNatGatewayCommand: () => new Error('should not be called'),
    });
    __setRemediationClients({ ec2: () => ec2 as never });
    const r = await remediate({ action: 'delete-nat-gateway', region: 'us-east-1', resourceId: 'nat-1' });
    expect(r.status).toBe('refused');
    expect(r.message).toMatch(/route table/i);
    expect(ec2.calls).not.toContain('DeleteNatGatewayCommand');
  });

  it('deletes when no route table references it and verifies deleting state', async () => {
    const ec2 = makeClient({
      DescribeNatGatewaysCommand: (_c, n) =>
        n === 0
          ? { NatGateways: [{ NatGatewayId: 'nat-1', State: 'available', VpcId: 'vpc-1' }] }
          : { NatGateways: [{ NatGatewayId: 'nat-1', State: 'deleting' }] },
      DescribeRouteTablesCommand: () => ({ RouteTables: [] }),
      DeleteNatGatewayCommand: () => ({}),
    });
    __setRemediationClients({ ec2: () => ec2 as never });
    const r = await remediate({ action: 'delete-nat-gateway', region: 'us-east-1', resourceId: 'nat-1' });
    expect(r.status).toBe('applied');
    expect(r.verified).toBe(true);
    expect(ec2.calls).toContain('DeleteNatGatewayCommand');
  });
});

describe('delete-ebs-volume', () => {
  it('REFUSES a volume that is not available (in-use)', async () => {
    const ec2 = makeClient({
      DescribeVolumesCommand: () => ({ Volumes: [{ VolumeId: 'vol-1', State: 'in-use', Attachments: [{ InstanceId: 'i-9' }] }] }),
      DeleteVolumeCommand: () => new Error('should not be called'),
    });
    __setRemediationClients({ ec2: () => ec2 as never });
    const r = await remediate({ action: 'delete-ebs-volume', region: 'us-east-1', resourceId: 'vol-1' });
    expect(r.status).toBe('refused');
    expect(r.message).toMatch(/in-use|attached/i);
  });
});

describe('delete-load-balancer', () => {
  it('REFUSES when a target group still has a healthy target', async () => {
    const elb = makeClient({
      DescribeLoadBalancersCommand: () => ({ LoadBalancers: [{ LoadBalancerArn: 'arn:lb/1', LoadBalancerName: 'prod-alb' }] }),
      DescribeTargetGroupsCommand: () => ({ TargetGroups: [{ TargetGroupArn: 'arn:tg/1', TargetGroupName: 'tg' }] }),
      DescribeTargetHealthCommand: () => ({ TargetHealthDescriptions: [{ TargetHealth: { State: 'healthy' } }] }),
      DeleteLoadBalancerCommand: () => new Error('should not be called'),
    });
    __setRemediationClients({ elb: () => elb as never });
    const r = await remediate({ action: 'delete-load-balancer', region: 'us-east-1', resourceId: 'arn:lb/1' });
    expect(r.status).toBe('refused');
    expect(r.message).toMatch(/healthy target/i);
    expect(elb.calls).not.toContain('DeleteLoadBalancerCommand');
  });

  it('deletes a load balancer with no healthy targets and verifies it is gone', async () => {
    const notFound = Object.assign(new Error('not found'), { name: 'LoadBalancerNotFoundException' });
    const elb = makeClient({
      DescribeLoadBalancersCommand: (_c, n) => {
        if (n === 0) return { LoadBalancers: [{ LoadBalancerArn: 'arn:lb/1', LoadBalancerName: 'orphan-alb' }] };
        return notFound; // post-verify: gone
      },
      DescribeTargetGroupsCommand: () => ({ TargetGroups: [{ TargetGroupArn: 'arn:tg/1', TargetGroupName: 'tg' }] }),
      DescribeTargetHealthCommand: () => ({ TargetHealthDescriptions: [] }),
      DeleteLoadBalancerCommand: () => ({}),
    });
    __setRemediationClients({ elb: () => elb as never });
    const r = await remediate({ action: 'delete-load-balancer', region: 'us-east-1', resourceId: 'arn:lb/1' });
    expect(r.status).toBe('applied');
    expect(r.verified).toBe(true);
  });
});

describe('set-log-retention', () => {
  it('sets retention on an unbounded ClaudeClaw group and verifies it', async () => {
    const logsClient = makeClient({
      DescribeLogGroupsCommand: (_c, n) =>
        n === 0
          ? { logGroups: [{ logGroupName: '/aws/codebuild/claudeclaw-orchestrator-deploy', retentionInDays: undefined, storedBytes: 4_000_000 }] }
          : { logGroups: [{ logGroupName: '/aws/codebuild/claudeclaw-orchestrator-deploy', retentionInDays: 30 }] },
      PutRetentionPolicyCommand: () => ({}),
    });
    __setRemediationClients({ logs: () => logsClient as never });
    const r = await remediate({
      action: 'set-log-retention',
      region: 'us-east-1',
      resourceId: '/aws/codebuild/claudeclaw-orchestrator-deploy',
      retentionDays: 30,
    });
    expect(r.status).toBe('applied');
    expect(r.verified).toBe(true);
    expect(logsClient.calls).toContain('PutRetentionPolicyCommand');
  });

  it('REFUSES a non-ClaudeClaw group (shared account guard) without any call', async () => {
    const logsClient = makeClient({
      PutRetentionPolicyCommand: () => new Error('should not be called'),
      DescribeLogGroupsCommand: () => new Error('should not be called'),
    });
    __setRemediationClients({ logs: () => logsClient as never });
    const r = await remediate({
      action: 'set-log-retention',
      region: 'us-east-1',
      resourceId: '/ecs/aiexpertnetwork-backend-prod',
      retentionDays: 30,
    });
    expect(r.status).toBe('refused');
    expect(r.message).toMatch(/not a ClaudeClaw-owned/i);
    expect(logsClient.calls).toHaveLength(0);
  });

  it('REFUSES a group that already has a retention policy', async () => {
    const logsClient = makeClient({
      DescribeLogGroupsCommand: () => ({ logGroups: [{ logGroupName: '/claudeclaw/orchestrator', retentionInDays: 365 }] }),
      PutRetentionPolicyCommand: () => new Error('should not be called'),
    });
    __setRemediationClients({ logs: () => logsClient as never });
    const r = await remediate({
      action: 'set-log-retention',
      region: 'us-east-1',
      resourceId: '/claudeclaw/orchestrator',
      retentionDays: 30,
    });
    expect(r.status).toBe('refused');
    expect(r.message).toMatch(/already has/i);
    expect(logsClient.calls).not.toContain('PutRetentionPolicyCommand');
  });
});

describe('delete-vpc-endpoint', () => {
  it('REFUSES when there is no NAT fallback in the VPC', async () => {
    const ec2 = makeClient({
      DescribeVpcEndpointsCommand: () => ({ VpcEndpoints: [{ VpcEndpointId: 'vpce-1', State: 'available', VpcId: 'vpc-1' }] }),
      DescribeNatGatewaysCommand: () => ({ NatGateways: [] }), // no fallback
      DeleteVpcEndpointsCommand: () => new Error('should not be called'),
    });
    __setRemediationClients({ ec2: () => ec2 as never });
    const r = await remediate({ action: 'delete-vpc-endpoint', region: 'us-east-1', resourceId: 'vpce-1' });
    expect(r.status).toBe('refused');
    expect(r.message).toMatch(/no NAT|fallback/i);
  });
});
