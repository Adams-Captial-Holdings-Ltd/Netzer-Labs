/**
 * Read-only VPC network posture reader (Tier B).
 *
 * Reports green/amber/red cards for the network controls a reviewer cares
 * about, all discovered at runtime via ec2:Describe* (no IDs are injected
 * as env vars, to avoid a new cross-stack prop):
 *
 *   - Private-subnet isolation: do we have private subnets that do NOT
 *     auto-assign public IPs? The Fargate tasks must live in private
 *     subnets behind NAT, not in public ones.
 *   - VPC endpoints present: interface / gateway endpoints keep AWS API
 *     traffic off the public internet.
 *   - Flow logs enabled: is VPC Flow Logs capturing network metadata?
 *     (T1+ ships with Flow Logs ON; T0 does not.)
 *
 * We scope every describe to the orchestrator VPC, discovered by the
 * Application tag CDK stamps on all resources (claudeclaw-enterprise).
 * Every call is wrapped so a denied permission degrades to an 'unknown'
 * card instead of a 500.
 */

import {
  EC2Client,
  DescribeVpcsCommand,
  DescribeSubnetsCommand,
  DescribeVpcEndpointsCommand,
  DescribeFlowLogsCommand,
  type Vpc,
  type Subnet,
} from '@aws-sdk/client-ec2';
import { logger } from '../../observability/logger.js';
import type { PostureCard } from '../../adapters/dashboard/posture-network.js';

const REGION = process.env.AWS_REGION ?? 'us-east-1';
// CDK stamps every resource with Application=claudeclaw-enterprise (see
// infra/lib/constants.ts TAGS). We filter the VPC by that tag so we never
// inspect an unrelated VPC in a shared account.
const APP_TAG = 'claudeclaw-enterprise';

let _ec2: EC2Client | null = null;

function ec2(): EC2Client {
  if (!_ec2) _ec2 = new EC2Client({ region: REGION });
  return _ec2;
}

/** Test seam: inject a fake, or null to force re-create. */
export function __setNetworkClients(next: { ec2?: EC2Client | null } = {}): void {
  if ('ec2' in next) _ec2 = next.ec2 ?? null;
}

function unknownCard(id: string, label: string, detail: string): PostureCard {
  return { id, label, status: 'unknown', detail };
}

/** Find the orchestrator VPC by the Application tag. */
async function findVpc(): Promise<Vpc | undefined> {
  const resp = await ec2().send(
    new DescribeVpcsCommand({
      Filters: [{ Name: 'tag:Application', Values: [APP_TAG] }],
    }),
  );
  return resp.Vpcs?.[0];
}

/**
 * Build the three network posture cards. Each control is read
 * independently so one denied describe degrades only its own card.
 */
export async function readNetworkPosture(): Promise<PostureCard[]> {
  let vpc: Vpc | undefined;
  try {
    vpc = await findVpc();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ errMessage: msg }, 'posture: vpc discovery failed');
    return [
      unknownCard(
        'net-private-subnets',
        'Private-subnet isolation',
        `Could not read VPC config (${msg}).`,
      ),
      unknownCard('net-vpc-endpoints', 'VPC endpoints', 'VPC not readable.'),
      unknownCard('net-flow-logs', 'VPC flow logs', 'VPC not readable.'),
    ];
  }

  if (!vpc?.VpcId) {
    return [
      unknownCard(
        'net-private-subnets',
        'Private-subnet isolation',
        'No VPC tagged Application=claudeclaw-enterprise found in this region.',
      ),
      unknownCard('net-vpc-endpoints', 'VPC endpoints', 'No matching VPC found.'),
      unknownCard('net-flow-logs', 'VPC flow logs', 'No matching VPC found.'),
    ];
  }

  const vpcId = vpc.VpcId;
  const vpcFilter = { Name: 'vpc-id', Values: [vpcId] };

  const cards: PostureCard[] = [];

  // ── Private-subnet isolation ──────────────────────────────────────
  cards.push(
    await readPrivateSubnets(vpcFilter).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ errMessage: msg }, 'posture: subnets read failed');
      return unknownCard(
        'net-private-subnets',
        'Private-subnet isolation',
        `Could not read subnets (${msg}).`,
      );
    }),
  );

  // ── VPC endpoints present ─────────────────────────────────────────
  cards.push(
    await readVpcEndpoints(vpcFilter).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ errMessage: msg }, 'posture: vpc endpoints read failed');
      return unknownCard(
        'net-vpc-endpoints',
        'VPC endpoints',
        `Could not read VPC endpoints (${msg}).`,
      );
    }),
  );

  // ── Flow logs enabled ─────────────────────────────────────────────
  cards.push(
    await readFlowLogs(vpcId).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ errMessage: msg }, 'posture: flow logs read failed');
      return unknownCard(
        'net-flow-logs',
        'VPC flow logs',
        `Could not read flow logs (${msg}).`,
      );
    }),
  );

  return cards;
}

async function readPrivateSubnets(filter: {
  Name: string;
  Values: string[];
}): Promise<PostureCard> {
  const resp = await ec2().send(
    new DescribeSubnetsCommand({ Filters: [filter] }),
  );
  const subnets = (resp.Subnets ?? []) as Subnet[];
  // A subnet that auto-assigns public IPs is effectively public. We want
  // private subnets (MapPublicIpOnLaunch false) to host the workload.
  const privateCount = subnets.filter(
    (s) => s.MapPublicIpOnLaunch === false,
  ).length;
  const publicCount = subnets.filter(
    (s) => s.MapPublicIpOnLaunch === true,
  ).length;

  if (subnets.length === 0) {
    return {
      id: 'net-private-subnets',
      label: 'Private-subnet isolation',
      status: 'unknown',
      detail: 'No subnets returned for the VPC.',
    };
  }

  return {
    id: 'net-private-subnets',
    label: 'Private-subnet isolation',
    status: privateCount > 0 ? 'ok' : 'crit',
    detail:
      privateCount > 0
        ? `${privateCount} private subnet(s) (no public IP on launch); ${publicCount} public.`
        : 'No private subnets found; workload may be exposed on public subnets.',
    value: `${privateCount}/${subnets.length}`,
  };
}

async function readVpcEndpoints(filter: {
  Name: string;
  Values: string[];
}): Promise<PostureCard> {
  const resp = await ec2().send(
    new DescribeVpcEndpointsCommand({ Filters: [filter] }),
  );
  const endpoints = resp.VpcEndpoints ?? [];
  // EC2 State enum spells the available state "Available" (capitalized).
  const available = endpoints.filter((e) => e.State === 'Available').length;

  return {
    id: 'net-vpc-endpoints',
    label: 'VPC endpoints',
    status: available > 0 ? 'ok' : 'warn',
    detail:
      available > 0
        ? `${available} VPC endpoint(s) available (keeps AWS API traffic off the public internet).`
        : 'No available VPC endpoints; AWS API traffic egresses via NAT.',
    value: String(available),
  };
}

async function readFlowLogs(vpcId: string): Promise<PostureCard> {
  const resp = await ec2().send(
    new DescribeFlowLogsCommand({
      Filter: [{ Name: 'resource-id', Values: [vpcId] }],
    }),
  );
  const logs = resp.FlowLogs ?? [];
  const active = logs.filter((l) => l.FlowLogStatus === 'ACTIVE').length;

  return {
    id: 'net-flow-logs',
    label: 'VPC flow logs',
    status: active > 0 ? 'ok' : 'warn',
    detail:
      active > 0
        ? `${active} active flow log(s) capturing network metadata for the VPC.`
        : 'No active VPC flow logs. Expected off on T0; T1+ should have them ON.',
    value: String(active),
  };
}
