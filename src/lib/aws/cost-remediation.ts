/**
 * Cost remediation executor — the part that ACTUALLY changes the AWS account.
 *
 * The cost report and the waste scan only ever READ. This module is the only
 * place that mutates, and it exists to make one promise true: if the dashboard
 * says a resource was removed, AWS agrees. We never report success on faith.
 *
 * Every action follows the same three-step contract:
 *   1. PRE-FLIGHT — re-read the resource right now and prove it is genuinely
 *      idle. The waste scan is a heuristic ("more than 2 load balancers",
 *      "multiple NAT gateways") and this is a SHARED production account, so we
 *      do not trust the scan: a NAT gateway still referenced by a route table,
 *      a load balancer with a healthy target, an EBS volume that got
 *      re-attached, an Elastic IP that got associated — all are REFUSED here,
 *      untouched, with the real reason. Better to do nothing than to break
 *      live infrastructure.
 *   2. MUTATE — call the real AWS delete/release API.
 *   3. POST-VERIFY — re-read and confirm the change took effect. `verified` is
 *      true only when AWS confirms the resource is gone or terminating. A
 *      mutation that "succeeded" but does not verify is reported honestly as
 *      not-verified, never as done.
 *
 * The route layer gates this behind cost:write + a runtime-config arm flag +
 * an explicit confirm, and the IAM permissions to delete live in a managed
 * policy that is detached by default. So this code is inert in prod until the
 * owner deliberately arms it.
 */

import {
  EC2Client,
  DescribeAddressesCommand,
  ReleaseAddressCommand,
  DescribeVolumesCommand,
  DeleteVolumeCommand,
  DescribeNatGatewaysCommand,
  DescribeRouteTablesCommand,
  DeleteNatGatewayCommand,
  DescribeVpcEndpointsCommand,
  DeleteVpcEndpointsCommand,
} from '@aws-sdk/client-ec2';
import {
  ElasticLoadBalancingV2Client,
  DescribeLoadBalancersCommand,
  DescribeTargetGroupsCommand,
  DescribeTargetHealthCommand,
  DeleteLoadBalancerCommand,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import {
  CloudWatchLogsClient,
  PutRetentionPolicyCommand,
  DescribeLogGroupsCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import { logger } from '../../observability/logger.js';

export type RemediationAction =
  | 'release-eip'
  | 'delete-ebs-volume'
  | 'delete-nat-gateway'
  | 'delete-vpc-endpoint'
  | 'delete-load-balancer'
  | 'set-log-retention';

export const REMEDIATION_ACTIONS: RemediationAction[] = [
  'release-eip',
  'delete-ebs-volume',
  'delete-nat-gateway',
  'delete-vpc-endpoint',
  'delete-load-balancer',
  'set-log-retention',
];

export interface RemediationRequest {
  action: RemediationAction;
  region: string;
  /** PublicIp | VolumeId | NatGatewayId | VpcEndpointId | LoadBalancerArn | LogGroupName */
  resourceId: string;
  /** For set-log-retention only: days to retain (default 30). */
  retentionDays?: number;
}

// The ONLY resources we will ever touch belong to ClaudeClaw. This account is
// shared, so every executor that could affect a named resource (today: log
// groups) hard-refuses anything that does not match this. Belt-and-suspenders
// on top of the discovery scope.
const CCE_OWNED = /claudeclaw/i;

export interface RemediationResult {
  action: RemediationAction;
  region: string;
  resourceId: string;
  /**
   * applied  = mutation issued AND post-verify confirmed it took effect.
   * refused  = pre-flight found the resource is in use / not idle; nothing touched.
   * failed   = the AWS call errored (e.g. denied) or post-verify could not confirm.
   */
  status: 'applied' | 'refused' | 'failed';
  /** True ONLY when a post-mutation describe confirmed the change. */
  verified: boolean;
  /** Human-readable, truthful outcome shown verbatim in the UI. */
  message: string;
  details?: Record<string, unknown>;
}

// ── Region-keyed clients with a test seam ─────────────────────────────────
const _ec2 = new Map<string, EC2Client>();
const _elb = new Map<string, ElasticLoadBalancingV2Client>();
const _logs = new Map<string, CloudWatchLogsClient>();
let _ec2Override: ((region: string) => EC2Client) | null = null;
let _elbOverride: ((region: string) => ElasticLoadBalancingV2Client) | null = null;
let _logsOverride: ((region: string) => CloudWatchLogsClient) | null = null;

function ec2(region: string): EC2Client {
  if (_ec2Override) return _ec2Override(region);
  let c = _ec2.get(region);
  if (!c) {
    c = new EC2Client({ region });
    _ec2.set(region, c);
  }
  return c;
}
function elb(region: string): ElasticLoadBalancingV2Client {
  if (_elbOverride) return _elbOverride(region);
  let c = _elb.get(region);
  if (!c) {
    c = new ElasticLoadBalancingV2Client({ region });
    _elb.set(region, c);
  }
  return c;
}
function logs(region: string): CloudWatchLogsClient {
  if (_logsOverride) return _logsOverride(region);
  let c = _logs.get(region);
  if (!c) {
    c = new CloudWatchLogsClient({ region });
    _logs.set(region, c);
  }
  return c;
}

/** Test seam: inject fakes, or pass {} to reset overrides + memoized clients. */
export function __setRemediationClients(
  next: {
    ec2?: (region: string) => EC2Client;
    elb?: (region: string) => ElasticLoadBalancingV2Client;
    logs?: (region: string) => CloudWatchLogsClient;
  } = {},
): void {
  _ec2.clear();
  _elb.clear();
  _logs.clear();
  _ec2Override = next.ec2 ?? null;
  _elbOverride = next.elb ?? null;
  _logsOverride = next.logs ?? null;
}

function errName(err: unknown): string {
  return (err as { name?: string })?.name ?? '';
}
function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function refused(req: RemediationRequest, message: string, details?: Record<string, unknown>): RemediationResult {
  return { ...req, status: 'refused', verified: false, message, details };
}
function failed(req: RemediationRequest, message: string, details?: Record<string, unknown>): RemediationResult {
  return { ...req, status: 'failed', verified: false, message, details };
}
function applied(req: RemediationRequest, verified: boolean, message: string, details?: Record<string, unknown>): RemediationResult {
  return { ...req, status: verified ? 'applied' : 'failed', verified, message, details };
}

// ── release-eip ───────────────────────────────────────────────────────────
// PRE: the address still exists and is NOT associated. POST: it is gone.
async function releaseEip(req: RemediationRequest): Promise<RemediationResult> {
  const c = ec2(req.region);
  const found = await c
    .send(new DescribeAddressesCommand({ PublicIps: [req.resourceId] }))
    .then((r) => r.Addresses?.[0])
    .catch((err) => {
      if (errName(err).startsWith('InvalidAddress')) return undefined;
      throw err;
    });
  if (!found) return refused(req, `Elastic IP ${req.resourceId} no longer exists — nothing to release.`);
  if (found.AssociationId) {
    return refused(
      req,
      `Elastic IP ${req.resourceId} is now associated (${found.AssociationId}) and is doing work — not releasing.`,
      { associationId: found.AssociationId, instanceId: found.InstanceId },
    );
  }
  const allocationId = found.AllocationId;
  if (!allocationId) return failed(req, `Elastic IP ${req.resourceId} has no AllocationId (EC2-Classic?) — cannot release via API.`);

  await c.send(new ReleaseAddressCommand({ AllocationId: allocationId }));

  const stillThere = await c
    .send(new DescribeAddressesCommand({ PublicIps: [req.resourceId] }))
    .then((r) => (r.Addresses?.length ?? 0) > 0)
    .catch((err) => (errName(err).startsWith('InvalidAddress') ? false : true));
  return applied(req, !stillThere, stillThere
    ? `Release call succeeded but ${req.resourceId} still appears allocated — verify manually.`
    : `Released Elastic IP ${req.resourceId}. Confirmed gone.`, { allocationId });
}

// ── delete-ebs-volume ───────────────────────────────────────────────────────
// PRE: status is 'available' (detached). POST: not found / deleting.
async function deleteVolume(req: RemediationRequest): Promise<RemediationResult> {
  const c = ec2(req.region);
  const vol = await c
    .send(new DescribeVolumesCommand({ VolumeIds: [req.resourceId] }))
    .then((r) => r.Volumes?.[0])
    .catch((err) => {
      if (errName(err).startsWith('InvalidVolume')) return undefined;
      throw err;
    });
  if (!vol) return refused(req, `Volume ${req.resourceId} no longer exists — nothing to delete.`);
  if (vol.State !== 'available') {
    const att = vol.Attachments?.map((a) => a.InstanceId).filter(Boolean).join(', ');
    return refused(
      req,
      `Volume ${req.resourceId} is '${vol.State}'${att ? ` (attached to ${att})` : ''}, not detached — not deleting.`,
      { state: vol.State },
    );
  }

  await c.send(new DeleteVolumeCommand({ VolumeId: req.resourceId }));

  const gone = await c
    .send(new DescribeVolumesCommand({ VolumeIds: [req.resourceId] }))
    .then((r) => {
      const s = r.Volumes?.[0]?.State;
      return !s || s === 'deleting' || s === 'deleted';
    })
    .catch((err) => errName(err).startsWith('InvalidVolume'));
  return applied(req, gone, gone
    ? `Deleted EBS volume ${req.resourceId} (${vol.Size ?? '?'} GB). Confirmed.`
    : `Delete call succeeded but ${req.resourceId} still reports a live state — verify manually.`);
}

// ── delete-nat-gateway ──────────────────────────────────────────────────────
// PRE: no route table still routes to it. POST: state deleting/deleted.
async function deleteNatGateway(req: RemediationRequest): Promise<RemediationResult> {
  const c = ec2(req.region);
  const gw = await c
    .send(new DescribeNatGatewaysCommand({ NatGatewayIds: [req.resourceId] }))
    .then((r) => r.NatGateways?.[0])
    .catch((err) => {
      if (errName(err).startsWith('NatGatewayNotFound')) return undefined;
      throw err;
    });
  if (!gw) return refused(req, `NAT gateway ${req.resourceId} no longer exists — nothing to delete.`);
  if (gw.State === 'deleted' || gw.State === 'deleting') {
    return applied(req, true, `NAT gateway ${req.resourceId} is already ${gw.State}.`);
  }

  // The real safety check: is any route table still pointing default traffic at it?
  const routed = await c
    .send(
      new DescribeRouteTablesCommand({
        Filters: [{ Name: 'route.nat-gateway-id', Values: [req.resourceId] }],
      }),
    )
    .then((r) => r.RouteTables ?? [])
    .catch(() => null);
  if (routed === null) {
    return refused(req, `Could not confirm ${req.resourceId} is unused (route-table read failed) — refusing to delete blindly.`);
  }
  if (routed.length > 0) {
    const rtbs = routed.map((t) => t.RouteTableId).filter(Boolean);
    return refused(
      req,
      `NAT gateway ${req.resourceId} is still the route for ${routed.length} route table(s) (${rtbs.join(', ')}) — it is carrying traffic. Repoint or remove those routes first.`,
      { routeTables: rtbs },
    );
  }

  await c.send(new DeleteNatGatewayCommand({ NatGatewayId: req.resourceId }));

  const ok = await c
    .send(new DescribeNatGatewaysCommand({ NatGatewayIds: [req.resourceId] }))
    .then((r) => {
      const s = r.NatGateways?.[0]?.State;
      return s === 'deleting' || s === 'deleted';
    })
    .catch((err) => errName(err).startsWith('NatGatewayNotFound'));
  return applied(req, ok, ok
    ? `Deleting NAT gateway ${req.resourceId}. Confirmed (state: deleting). It stops billing once fully deleted.`
    : `Delete call succeeded but ${req.resourceId} is not reporting 'deleting' — verify manually.`);
}

// ── delete-vpc-endpoint ─────────────────────────────────────────────────────
// PRE: a NAT gateway exists in the same VPC as a fallback path. POST: gone.
async function deleteVpcEndpoint(req: RemediationRequest): Promise<RemediationResult> {
  const c = ec2(req.region);
  const ep = await c
    .send(new DescribeVpcEndpointsCommand({ VpcEndpointIds: [req.resourceId] }))
    .then((r) => r.VpcEndpoints?.[0])
    .catch((err) => {
      if (errName(err).startsWith('InvalidVpcEndpoint')) return undefined;
      throw err;
    });
  if (!ep) return refused(req, `VPC endpoint ${req.resourceId} no longer exists — nothing to delete.`);
  // VPC endpoint state is capitalized in the SDK ('Deleting'/'Deleted'); compare
  // case-insensitively so this stays correct regardless.
  const epState = String(ep.State ?? '').toLowerCase();
  if (epState === 'deleting' || epState === 'deleted') {
    return applied(req, true, `VPC endpoint ${req.resourceId} is already ${ep.State}.`);
  }

  // Deleting an interface endpoint cuts private access to that AWS service. Only
  // safe if the VPC has a NAT gateway as a fallback path to the public API.
  const hasNat = await c
    .send(
      new DescribeNatGatewaysCommand({
        Filter: [
          { Name: 'vpc-id', Values: [ep.VpcId ?? ''] },
          { Name: 'state', Values: ['available'] },
        ],
      }),
    )
    .then((r) => (r.NatGateways?.length ?? 0) > 0)
    .catch(() => null);
  if (hasNat === null) {
    return refused(req, `Could not confirm a NAT fallback for ${req.resourceId} — refusing to delete blindly.`);
  }
  if (!hasNat) {
    return refused(
      req,
      `VPC endpoint ${req.resourceId} has no NAT gateway fallback in its VPC — deleting it would cut private access to that AWS service. Not deleting.`,
      { vpcId: ep.VpcId },
    );
  }

  await c.send(new DeleteVpcEndpointsCommand({ VpcEndpointIds: [req.resourceId] }));

  const ok = await c
    .send(new DescribeVpcEndpointsCommand({ VpcEndpointIds: [req.resourceId] }))
    .then((r) => {
      const s = String(r.VpcEndpoints?.[0]?.State ?? '').toLowerCase();
      return !s || s === 'deleting' || s === 'deleted';
    })
    .catch((err) => errName(err).startsWith('InvalidVpcEndpoint'));
  return applied(req, ok, ok
    ? `Deleting VPC endpoint ${req.resourceId}. Confirmed.`
    : `Delete call succeeded but ${req.resourceId} still reports a live state — verify manually.`);
}

// ── delete-load-balancer ────────────────────────────────────────────────────
// PRE: no target group registered to it has a healthy target. POST: not found.
async function deleteLoadBalancer(req: RemediationRequest): Promise<RemediationResult> {
  const c = elb(req.region);
  const lb = await c
    .send(new DescribeLoadBalancersCommand({ LoadBalancerArns: [req.resourceId] }))
    .then((r) => r.LoadBalancers?.[0])
    .catch((err) => {
      if (errName(err).startsWith('LoadBalancerNotFound')) return undefined;
      throw err;
    });
  if (!lb) return refused(req, `Load balancer no longer exists — nothing to delete.`);

  // The real safety check: does any attached target group have a healthy target?
  const tgs = await c
    .send(new DescribeTargetGroupsCommand({ LoadBalancerArn: req.resourceId }))
    .then((r) => r.TargetGroups ?? [])
    .catch(() => null);
  if (tgs === null) {
    return refused(req, `Could not confirm ${lb.LoadBalancerName} is unused (target-group read failed) — refusing to delete blindly.`);
  }
  for (const tg of tgs) {
    if (!tg.TargetGroupArn) continue;
    const healthy = await c
      .send(new DescribeTargetHealthCommand({ TargetGroupArn: tg.TargetGroupArn }))
      .then((r) => (r.TargetHealthDescriptions ?? []).filter((t) => t.TargetHealth?.State === 'healthy').length)
      .catch(() => 0);
    if (healthy > 0) {
      return refused(
        req,
        `Load balancer ${lb.LoadBalancerName} still has ${healthy} healthy target(s) serving traffic (target group ${tg.TargetGroupName}) — not deleting.`,
        { targetGroup: tg.TargetGroupName, healthy },
      );
    }
  }

  await c.send(new DeleteLoadBalancerCommand({ LoadBalancerArn: req.resourceId }));

  const gone = await c
    .send(new DescribeLoadBalancersCommand({ LoadBalancerArns: [req.resourceId] }))
    .then((r) => (r.LoadBalancers?.length ?? 0) === 0)
    .catch((err) => errName(err).startsWith('LoadBalancerNotFound'));
  return applied(req, gone, gone
    ? `Deleted load balancer ${lb.LoadBalancerName}. Confirmed gone.`
    : `Delete call succeeded but ${lb.LoadBalancerName} still appears — verify manually.`);
}

// ── set-log-retention ───────────────────────────────────────────────────────
// The safest real optimization: cap an unbounded ("never expire") CloudWatch log
// group so it stops storing logs forever. NON-destructive to the group and
// REVERSIBLE (set a longer retention or remove the policy). PRE: the group is
// ClaudeClaw-owned (hard guard on a shared account) and currently unbounded.
// POST: describe confirms retentionInDays now equals the target.
// DescribeLogGroups is prefix-matched and defaults to 50 items per page, so
// with >50 prefix-colliding groups the exact name could miss on page one,
// mis-reporting "no longer exists" (pre-check) or "unconfirmed" (post-check).
// Page (bounded) until the exact name is found or the listing ends.
async function findLogGroup(
  c: ReturnType<typeof logs>,
  name: string,
): Promise<{ logGroupName?: string; retentionInDays?: number } | undefined> {
  let token: string | undefined;
  for (let page = 0; page < 10; page++) {
    const r = await c.send(
      new DescribeLogGroupsCommand({
        logGroupNamePrefix: name,
        ...(token ? { nextToken: token } : {}),
      }),
    );
    const hit = (r.logGroups ?? []).find((g) => g.logGroupName === name);
    if (hit) return hit;
    token = r.nextToken;
    if (!token) return undefined;
  }
  return undefined;
}

async function setLogRetention(req: RemediationRequest): Promise<RemediationResult> {
  const name = req.resourceId;
  if (!CCE_OWNED.test(name)) {
    return refused(
      req,
      `Log group "${name}" is not a ClaudeClaw-owned group — refusing to change retention on a shared account.`,
    );
  }
  const days = Number.isFinite(req.retentionDays) && (req.retentionDays as number) > 0 ? Math.floor(req.retentionDays as number) : 30;
  const c = logs(req.region);

  const group = await findLogGroup(c, name).catch(() => null);
  if (group === null) return refused(req, `Could not read log group "${name}" — not changing it.`);
  if (!group) return refused(req, `Log group "${name}" no longer exists — nothing to do.`);
  if (typeof group.retentionInDays === 'number') {
    return refused(
      req,
      `Log group "${name}" already has a ${group.retentionInDays}-day retention — leaving it as-is.`,
      { retentionInDays: group.retentionInDays },
    );
  }

  await c.send(new PutRetentionPolicyCommand({ logGroupName: name, retentionInDays: days }));

  const confirmed = await findLogGroup(c, name)
    .then((g) => g?.retentionInDays === days)
    .catch(() => false);
  return applied(req, confirmed, confirmed
    ? `Set ${days}-day retention on "${name}". Confirmed — it stops growing without bound (reversible).`
    : `Put-retention call succeeded but "${name}" did not confirm ${days} days — verify manually.`, { retentionDays: days });
}

const EXECUTORS: Record<RemediationAction, (req: RemediationRequest) => Promise<RemediationResult>> = {
  'release-eip': releaseEip,
  'delete-ebs-volume': deleteVolume,
  'delete-nat-gateway': deleteNatGateway,
  'delete-vpc-endpoint': deleteVpcEndpoint,
  'delete-load-balancer': deleteLoadBalancer,
  'set-log-retention': setLogRetention,
};

/**
 * Run one remediation. Resolves to a structured result for every EXPECTED
 * outcome (applied / refused / failed) — including AWS errors like AccessDenied,
 * which surface honestly as a failed result rather than a thrown 502 — so the
 * UI always shows the real story. Throws only on a truly unexpected bug.
 */
export async function remediate(req: RemediationRequest): Promise<RemediationResult> {
  const fn = EXECUTORS[req.action];
  if (!fn) return failed(req, `Unknown remediation action: ${req.action}`);
  if (!req.resourceId || !req.region) return failed(req, 'region and resourceId are required.');
  try {
    const result = await fn(req);
    logger.info(
      { action: req.action, region: req.region, resourceId: req.resourceId, status: result.status, verified: result.verified },
      'cost remediation',
    );
    return result;
  } catch (err) {
    const name = errName(err);
    const msg = errMsg(err);
    logger.warn({ action: req.action, resourceId: req.resourceId, errName: name, errMessage: msg }, 'cost remediation error');
    // AccessDenied / UnauthorizedOperation is the common "not armed in prod" case
    // — report it as the true reason, not a generic failure.
    if (/AccessDenied|UnauthorizedOperation/i.test(name) || /not authorized|access denied/i.test(msg)) {
      return failed(req, `AWS denied this action: the remediation IAM permission is not attached. (${msg})`, { errName: name });
    }
    return failed(req, `AWS error: ${msg}`, { errName: name });
  }
}

/** Map a waste-scan risk id (e.g. "nat-us-east-1") to its remediation action. */
export function actionForRiskId(riskId: string): RemediationAction | null {
  if (riskId.startsWith('nat-')) return 'delete-nat-gateway';
  if (riskId.startsWith('vpce-')) return 'delete-vpc-endpoint';
  if (riskId.startsWith('eip-')) return 'release-eip';
  if (riskId.startsWith('ebs-')) return 'delete-ebs-volume';
  if (riskId.startsWith('lb-')) return 'delete-load-balancer';
  if (riskId.startsWith('logs-')) return 'set-log-retention';
  return null;
}
