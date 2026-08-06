/**
 * Read-only AWS cost reader + waste detector (Tier B cost dashboard).
 *
 * Two independent reads, both fail-soft (a denied API yields an
 * `available: false` payload with a note, never a 500):
 *
 *   readCostSummary()  - month-to-date spend, by-service breakdown, a
 *                        ~30-day daily trend, last month's total, and a
 *                        straight-line month-end projection. All via the
 *                        Cost Explorer API (ce:GetCostAndUsage). CE is a
 *                        global service; its endpoint lives in us-east-1,
 *                        so the CE client is pinned there regardless of
 *                        AWS_REGION.
 *
 *   readCostRisks()    - scans the regions that actually have spend (derived
 *                        from CE, so the scan stays bounded to 1-3 regions in
 *                        practice) and flags the classic silent money-burners:
 *                        idle/duplicate NAT gateways, the interface-endpoint +
 *                        NAT "pay twice" antipattern, unattached Elastic IPs,
 *                        orphaned EBS volumes, and surplus load balancers.
 *                        Each risk carries an approximate current cost and the
 *                        portion that is recoverable.
 *
 * Estimates use public on-demand list prices and are intentionally
 * approximate (rates vary by region); they exist to rank waste, not to
 * reconcile the invoice to the cent. The invoice is the source of truth for
 * actuals; readCostSummary() returns those actuals straight from CE.
 *
 * Cross-account safety: this AWS account is shared. Heavy items (NAT,
 * endpoints) live in the tagged ClaudeClaw VPC in the home region. Orphans
 * found OUTSIDE the home region are reported at low severity with a
 * "confirm owner" note, never as a confident delete recommendation.
 */

import {
  CostExplorerClient,
  GetCostAndUsageCommand,
} from '@aws-sdk/client-cost-explorer';
import {
  EC2Client,
  DescribeNatGatewaysCommand,
  DescribeVpcEndpointsCommand,
  DescribeAddressesCommand,
  DescribeVolumesCommand,
} from '@aws-sdk/client-ec2';
import {
  ElasticLoadBalancingV2Client,
  DescribeLoadBalancersCommand,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import {
  CloudWatchLogsClient,
  DescribeLogGroupsCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import { logger } from '../../observability/logger.js';

const HOME_REGION = process.env.AWS_REGION ?? 'us-east-1';

// Approximate public on-demand list prices (USD). See file header.
const HOURS_PER_MONTH = 730;
const NAT_HOURLY = 0.045; // per NAT gateway
const NAT_MONTHLY = NAT_HOURLY * HOURS_PER_MONTH; // ~$32.85
const ENDPOINT_AZ_HOURLY = 0.01; // per interface endpoint, per AZ
const ENDPOINT_AZ_MONTHLY = ENDPOINT_AZ_HOURLY * HOURS_PER_MONTH; // ~$7.30
const EIP_MONTHLY = 0.005 * HOURS_PER_MONTH; // ~$3.65 per idle public IPv4
const EBS_GB_MONTHLY = 0.08; // gp3-ish per GB-month
const ALB_MONTHLY = 0.0225 * HOURS_PER_MONTH; // ~$16.43 base (excludes LCU)
const LOG_GB_MONTHLY = 0.03; // CloudWatch Logs storage per GB-month
// Only ever surface (and later remediate) ClaudeClaw-owned log groups — this is
// a shared account, so aiexpertnetwork / other groups are never listed.
const CCE_LOG_OWNED = /claudeclaw/i;
// Cap the region fan-out so the risk scan stays bounded even on a busy account.
const MAX_REGIONS = 8;

// ── Cost Explorer client (pinned to us-east-1) ──────────────────────────
let _ce: CostExplorerClient | null = null;
function ce(): CostExplorerClient {
  if (!_ce) _ce = new CostExplorerClient({ region: 'us-east-1' });
  return _ce;
}

// Per-region EC2 / ELBv2 clients, created on demand and memoized.
const _ec2ByRegion = new Map<string, EC2Client>();
function ec2(region: string): EC2Client {
  let c = _ec2ByRegion.get(region);
  if (!c) {
    c = new EC2Client({ region });
    _ec2ByRegion.set(region, c);
  }
  return c;
}
const _elbByRegion = new Map<string, ElasticLoadBalancingV2Client>();
function elb(region: string): ElasticLoadBalancingV2Client {
  let c = _elbByRegion.get(region);
  if (!c) {
    c = new ElasticLoadBalancingV2Client({ region });
    _elbByRegion.set(region, c);
  }
  return c;
}

const _logsByRegion = new Map<string, CloudWatchLogsClient>();
function cwlogs(region: string): CloudWatchLogsClient {
  let c = _logsByRegion.get(region);
  if (!c) {
    c = new CloudWatchLogsClient({ region });
    _logsByRegion.set(region, c);
  }
  return c;
}

/** Test seam: inject fakes, or pass {} to reset all memoized clients. */
export function __setCostClients(
  next: {
    ce?: CostExplorerClient | null;
    ec2?: (region: string) => EC2Client;
    elb?: (region: string) => ElasticLoadBalancingV2Client;
    logs?: (region: string) => CloudWatchLogsClient;
  } = {},
): void {
  if ('ce' in next) _ce = next.ce ?? null;
  _ec2ByRegion.clear();
  _elbByRegion.clear();
  _logsByRegion.clear();
  if (next.ec2) _ec2ByRegionOverride = next.ec2;
  if (next.elb) _elbByRegionOverride = next.elb;
  if (next.logs) _logsByRegionOverride = next.logs;
}
let _ec2ByRegionOverride: ((region: string) => EC2Client) | null = null;
let _elbByRegionOverride: ((region: string) => ElasticLoadBalancingV2Client) | null = null;
let _logsByRegionOverride: ((region: string) => CloudWatchLogsClient) | null = null;
function ec2For(region: string): EC2Client {
  return _ec2ByRegionOverride ? _ec2ByRegionOverride(region) : ec2(region);
}
function elbFor(region: string): ElasticLoadBalancingV2Client {
  return _elbByRegionOverride ? _elbByRegionOverride(region) : elb(region);
}
function logsFor(region: string): CloudWatchLogsClient {
  return _logsByRegionOverride ? _logsByRegionOverride(region) : cwlogs(region);
}

// ── Types ───────────────────────────────────────────────────────────────
export interface CostServiceSlice {
  service: string;
  amountUsd: number;
}
export interface CostDailyPoint {
  date: string; // YYYY-MM-DD
  amountUsd: number;
}
export interface CostSummary {
  generatedAt: string;
  currency: 'USD';
  available: boolean;
  note?: string;
  monthToDateUsd: number;
  lastMonthUsd: number;
  projectedMonthUsd: number;
  daysElapsed: number;
  daysInMonth: number;
  byService: CostServiceSlice[];
  daily: CostDailyPoint[];
}
export interface CostRisk {
  id: string;
  severity: 'high' | 'medium' | 'low';
  title: string;
  detail: string;
  region: string;
  estMonthlyUsd: number; // what the flagged thing costs now
  estMonthlySavingsUsd: number; // recoverable portion
  resourceIds: string[];
}
export interface CostRisksResult {
  generatedAt: string;
  available: boolean;
  note?: string;
  regionsScanned: string[];
  risks: CostRisk[];
  totalMonthlySavingsUsd: number;
}

// ── Date helpers (UTC) ────────────────────────────────────────────────────
function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function monthBounds(now: Date) {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const monthStart = new Date(Date.UTC(y, m, 1));
  const nextMonthStart = new Date(Date.UTC(y, m + 1, 1));
  const lastMonthStart = new Date(Date.UTC(y, m - 1, 1));
  const tomorrow = new Date(Date.UTC(y, m, now.getUTCDate() + 1));
  const daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const daysElapsed = now.getUTCDate();
  return { monthStart, nextMonthStart, lastMonthStart, tomorrow, daysInMonth, daysElapsed };
}
function num(v: string | undefined): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// ── Cost summary ──────────────────────────────────────────────────────────
export async function readCostSummary(now: Date = new Date()): Promise<CostSummary> {
  const b = monthBounds(now);
  const base: CostSummary = {
    generatedAt: now.toISOString(),
    currency: 'USD',
    available: false,
    monthToDateUsd: 0,
    lastMonthUsd: 0,
    projectedMonthUsd: 0,
    daysElapsed: b.daysElapsed,
    daysInMonth: b.daysInMonth,
    byService: [],
    daily: [],
  };

  // Month-to-date, grouped by service. This call is the one that decides
  // `available`; the other two are best-effort enrichment.
  let mtd: number;
  let byService: CostServiceSlice[];
  try {
    const resp = await ce().send(
      new GetCostAndUsageCommand({
        TimePeriod: { Start: ymd(b.monthStart), End: ymd(b.tomorrow) },
        Granularity: 'MONTHLY',
        Metrics: ['UnblendedCost'],
        GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }],
      }),
    );
    const groups = resp.ResultsByTime?.[0]?.Groups ?? [];
    byService = groups
      .map((g) => ({
        service: g.Keys?.[0] ?? 'Unknown',
        amountUsd: num(g.Metrics?.UnblendedCost?.Amount),
      }))
      .filter((s) => s.amountUsd > 0)
      .sort((a, b2) => b2.amountUsd - a.amountUsd);
    mtd = byService.reduce((acc, s) => acc + s.amountUsd, 0);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ errMessage: msg }, 'cost: month-to-date read failed');
    return {
      ...base,
      note: `Cost data unavailable (${msg}). The task role needs ce:GetCostAndUsage.`,
    };
  }

  // Last-month total + daily trend, each independently best-effort.
  const [lastMonthUsd, daily] = await Promise.all([
    ce()
      .send(
        new GetCostAndUsageCommand({
          TimePeriod: { Start: ymd(b.lastMonthStart), End: ymd(b.monthStart) },
          Granularity: 'MONTHLY',
          Metrics: ['UnblendedCost'],
        }),
      )
      .then((r) => num(r.ResultsByTime?.[0]?.Total?.UnblendedCost?.Amount))
      .catch(() => 0),
    ce()
      .send(
        new GetCostAndUsageCommand({
          TimePeriod: {
            Start: ymd(new Date(b.tomorrow.getTime() - 31 * 86400_000)),
            End: ymd(b.tomorrow),
          },
          Granularity: 'DAILY',
          Metrics: ['UnblendedCost'],
        }),
      )
      .then((r) =>
        (r.ResultsByTime ?? []).map((p) => ({
          date: p.TimePeriod?.Start ?? '',
          amountUsd: num(p.Total?.UnblendedCost?.Amount),
        })),
      )
      .catch(() => [] as CostDailyPoint[]),
  ]);

  // Project from the recent settled-day run rate, not MTD/elapsed-days. The
  // current day is partial (CE settles ~a day behind), so including it drags
  // the average down; and a run rate also catches a mid-month step change
  // (exactly the kind that tripled this account's May bill) that an
  // MTD/elapsed average would smear away. Drop today, average the last 7
  // settled days, scale to the month. Fall back to MTD/elapsed when the daily
  // series is too sparse to trust.
  const settled = daily.slice(0, -1).filter((d) => d.amountUsd > 0);
  const recent = settled.slice(-7);
  const avgDaily = recent.length ? recent.reduce((a, p) => a + p.amountUsd, 0) / recent.length : 0;
  const projectedMonthUsd =
    recent.length >= 3
      ? avgDaily * b.daysInMonth
      : b.daysElapsed > 0
        ? (mtd / b.daysElapsed) * b.daysInMonth
        : mtd;

  return {
    ...base,
    available: true,
    monthToDateUsd: mtd,
    lastMonthUsd,
    projectedMonthUsd,
    byService,
    daily,
  };
}

// ── Waste / cost-risk scan ────────────────────────────────────────────────
/** Regions that actually have spend this month, derived from CE. */
async function activeRegions(now: Date): Promise<string[]> {
  const b = monthBounds(now);
  const resp = await ce().send(
    new GetCostAndUsageCommand({
      TimePeriod: { Start: ymd(b.monthStart), End: ymd(b.tomorrow) },
      Granularity: 'MONTHLY',
      Metrics: ['UnblendedCost'],
      GroupBy: [{ Type: 'DIMENSION', Key: 'REGION' }],
    }),
  );
  const regions = (resp.ResultsByTime?.[0]?.Groups ?? [])
    .map((g) => ({ region: g.Keys?.[0] ?? '', amt: num(g.Metrics?.UnblendedCost?.Amount) }))
    .filter((r) => /^[a-z]{2}-[a-z]+-\d$/.test(r.region) && r.amt > 0.5)
    .sort((a, c) => c.amt - a.amt)
    .map((r) => r.region);
  // Always include the home region, dedupe, and bound the fan-out.
  const set = [HOME_REGION, ...regions].filter((r, i, a) => a.indexOf(r) === i);
  return set.slice(0, MAX_REGIONS);
}

async function scanRegion(region: string, _now: Date): Promise<CostRisk[]> {
  const isHome = region === HOME_REGION;
  const sharedNote = isHome ? '' : ' Outside the primary region on a shared account; confirm this is ClaudeClaw before removing.';
  const risks: CostRisk[] = [];

  // Run all describes for the region in parallel; each one is fail-soft.
  const [nat, endpoints, addresses, volumes, lbs] = await Promise.all([
    ec2For(region)
      .send(new DescribeNatGatewaysCommand({ Filter: [{ Name: 'state', Values: ['available'] }] }))
      .then((r) => r.NatGateways ?? [])
      .catch(() => []),
    ec2For(region)
      .send(new DescribeVpcEndpointsCommand({}))
      .then((r) => r.VpcEndpoints ?? [])
      .catch(() => []),
    ec2For(region)
      .send(new DescribeAddressesCommand({}))
      .then((r) => r.Addresses ?? [])
      .catch(() => []),
    ec2For(region)
      .send(new DescribeVolumesCommand({ Filters: [{ Name: 'status', Values: ['available'] }] }))
      .then((r) => r.Volumes ?? [])
      .catch(() => []),
    elbFor(region)
      .send(new DescribeLoadBalancersCommand({}))
      .then((r) => r.LoadBalancers ?? [])
      .catch(() => []),
  ]);

  // NAT gateways: collapse multi-AZ/duplicate gateways to one per VPC.
  if (nat.length > 0) {
    const byVpc = new Map<string, number>();
    for (const g of nat) byVpc.set(g.VpcId ?? '?', (byVpc.get(g.VpcId ?? '?') ?? 0) + 1);
    const vpcCount = byVpc.size;
    const totalMonthly = nat.length * NAT_MONTHLY;
    const savings = (nat.length - vpcCount) * NAT_MONTHLY;
    if (nat.length > vpcCount || vpcCount > 1) {
      risks.push({
        id: `nat-${region}`,
        severity: savings > 30 ? 'high' : 'medium',
        title: `${nat.length} NAT gateways across ${vpcCount} VPC(s)`,
        detail:
          `NAT gateways cost ~$${NAT_MONTHLY.toFixed(0)}/mo each just to exist. ` +
          `${vpcCount > 1 ? 'Multiple VPCs suggests leftover/duplicate stacks. ' : ''}` +
          `For low egress, one per environment is usually enough.${sharedNote}`,
        region,
        estMonthlyUsd: round2(totalMonthly),
        estMonthlySavingsUsd: round2(Math.max(0, savings)),
        resourceIds: nat.map((g) => g.NatGatewayId ?? '').filter(Boolean),
      });
    }
  }

  // Interface endpoints: redundant when NAT also exists (NAT already reaches
  // the AWS APIs). Sum cost across availability zones (one ENI per subnet).
  const ifaceEndpoints = endpoints.filter((e) => e.VpcEndpointType === 'Interface');
  if (ifaceEndpoints.length > 0) {
    const azUnits = ifaceEndpoints.reduce((acc, e) => acc + (e.SubnetIds?.length ?? 1), 0);
    const monthly = azUnits * ENDPOINT_AZ_MONTHLY;
    const redundant = nat.length > 0;
    risks.push({
      id: `vpce-${region}`,
      severity: monthly > 50 ? 'high' : monthly > 15 ? 'medium' : 'low',
      title: `${ifaceEndpoints.length} VPC interface endpoints`,
      detail:
        `Interface endpoints bill ~$${ENDPOINT_AZ_MONTHLY.toFixed(2)}/mo per availability zone (${azUnits} AZ-endpoints here). ` +
        (redundant
          ? 'You also run NAT gateways, which already reach the AWS APIs, so most of these are redundant. Keep only the endpoints you need for private isolation and drop the rest.'
          : 'Keep only the ones in active use; exotic services (Athena, Glue, agent runtimes) are common dead weight.') +
        sharedNote,
      region,
      estMonthlyUsd: round2(monthly),
      estMonthlySavingsUsd: round2(redundant ? monthly * 0.8 : monthly * 0.4),
      resourceIds: ifaceEndpoints.map((e) => e.VpcEndpointId ?? '').filter(Boolean),
    });
  }

  // Unattached Elastic IPs (billed when not associated to a running resource).
  const idleEips = addresses.filter((a) => !a.AssociationId);
  if (idleEips.length > 0) {
    const monthly = idleEips.length * EIP_MONTHLY;
    risks.push({
      id: `eip-${region}`,
      severity: 'low',
      title: `${idleEips.length} unattached Elastic IP(s)`,
      detail: `Each idle public IPv4 bills ~$${EIP_MONTHLY.toFixed(2)}/mo while allocated to nothing. Release them.${sharedNote}`,
      region,
      estMonthlyUsd: round2(monthly),
      estMonthlySavingsUsd: round2(monthly),
      resourceIds: idleEips.map((a) => a.PublicIp ?? '').filter(Boolean),
    });
  }

  // Orphaned (available = unattached) EBS volumes.
  if (volumes.length > 0) {
    const gb = volumes.reduce((acc, v) => acc + (v.Size ?? 0), 0);
    const monthly = gb * EBS_GB_MONTHLY;
    risks.push({
      id: `ebs-${region}`,
      severity: monthly > 10 ? 'medium' : 'low',
      title: `${volumes.length} unattached EBS volume(s) (${gb} GB)`,
      detail: `Detached volumes keep billing (~$${EBS_GB_MONTHLY.toFixed(2)}/GB-mo). Snapshot if needed, then delete.${sharedNote}`,
      region,
      estMonthlyUsd: round2(monthly),
      estMonthlySavingsUsd: round2(monthly),
      resourceIds: volumes.map((v) => v.VolumeId ?? '').filter(Boolean),
    });
  }

  // Surplus load balancers. Prod + staging = 2 expected; more usually means
  // orphaned CDK redeploys.
  if (lbs.length > 2 && isHome) {
    const extra = lbs.length - 2;
    const monthly = lbs.length * ALB_MONTHLY;
    risks.push({
      id: `lb-${region}`,
      severity: 'medium',
      title: `${lbs.length} load balancers`,
      detail:
        `Each load balancer bills ~$${ALB_MONTHLY.toFixed(0)}/mo before traffic. ` +
        `Only prod + staging are expected; the rest are likely orphans from old deploys: ` +
        lbs.map((l) => l.LoadBalancerName).filter(Boolean).join(', ') +
        '.',
      region,
      estMonthlyUsd: round2(monthly),
      estMonthlySavingsUsd: round2(extra * ALB_MONTHLY),
      resourceIds: lbs.map((l) => l.LoadBalancerArn ?? '').filter(Boolean),
    });
  }

  return risks;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export async function readCostRisks(now: Date = new Date()): Promise<CostRisksResult> {
  let regions: string[];
  try {
    regions = await activeRegions(now);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ errMessage: msg }, 'cost: region discovery failed');
    // CE denied: fall back to scanning just the home region so the page still
    // surfaces something useful from the EC2 describes alone.
    regions = [HOME_REGION];
  }

  const perRegion = await Promise.all(
    regions.map((r) =>
      scanRegion(r, now).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn({ errMessage: msg, region: r }, 'cost: region scan failed');
        return [] as CostRisk[];
      }),
    ),
  );

  // CloudWatch log retention is a global-ish, home-region concern (our logs live
  // there), so scan it once rather than per region. Fails soft to null.
  const logRisk = await scanLogRetention(HOME_REGION).catch(() => null);

  const risks = [...perRegion.flat(), ...(logRisk ? [logRisk] : [])]
    .sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || b.estMonthlySavingsUsd - a.estMonthlySavingsUsd);
  const totalMonthlySavingsUsd = round2(risks.reduce((acc, r) => acc + r.estMonthlySavingsUsd, 0));

  return {
    generatedAt: now.toISOString(),
    available: true,
    regionsScanned: regions,
    risks,
    totalMonthlySavingsUsd,
  };
}

/**
 * ClaudeClaw-owned CloudWatch log groups with NO retention ("never expire").
 * Unbounded retention is the most common silent AWS cost — every Fargate/Lambda
 * task defaults to it — and it is the safest thing to fix (setting a retention
 * is non-destructive to the group and reversible). Scoped strictly to
 * ClaudeClaw-owned groups so a shared account's groups are never surfaced.
 * Home region only (that is where our logs live); fails soft.
 */
async function scanLogRetention(region: string): Promise<CostRisk | null> {
  const groups: { name: string; bytes: number }[] = [];
  let token: string | undefined;
  try {
    // Bounded pagination so a huge account can't spin here forever.
    for (let page = 0; page < 20; page++) {
      const out = await logsFor(region).send(
        new DescribeLogGroupsCommand({ limit: 50, nextToken: token }),
      );
      for (const g of out.logGroups ?? []) {
        const name = g.logGroupName ?? '';
        // Unbounded = retentionInDays unset, AND ours.
        if (name && g.retentionInDays == null && CCE_LOG_OWNED.test(name)) {
          groups.push({ name, bytes: g.storedBytes ?? 0 });
        }
      }
      token = out.nextToken;
      if (!token) break;
    }
  } catch (err) {
    logger.warn({ errMessage: err instanceof Error ? err.message : String(err), region }, 'cost: log-retention scan failed');
    return null;
  }
  if (groups.length === 0) return null;

  const totalBytes = groups.reduce((acc, g) => acc + g.bytes, 0);
  const monthly = (totalBytes / 1e9) * LOG_GB_MONTHLY;
  return {
    id: `logs-${region}`,
    severity: 'low',
    title: `${groups.length} ClaudeClaw log group(s) with no expiry`,
    detail:
      `These log groups keep every log line forever (no retention policy), so storage only grows. ` +
      `Setting a retention (e.g. 30 days) caps it — non-destructive to the group and reversible. ` +
      `Storing ~${(totalBytes / 1e6).toFixed(0)} MB today at ~$${LOG_GB_MONTHLY.toFixed(2)}/GB-mo.`,
    region,
    estMonthlyUsd: round2(monthly),
    // The recoverable portion grows over time; the current stored cost is a
    // conservative floor for what capping retention saves.
    estMonthlySavingsUsd: round2(monthly),
    resourceIds: groups.map((g) => g.name),
  };
}

function severityRank(s: CostRisk['severity']): number {
  return s === 'high' ? 3 : s === 'medium' ? 2 : 1;
}
