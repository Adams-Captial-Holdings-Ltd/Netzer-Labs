/**
 * Status page data assembler (D5).
 *
 * Pulls three signals into one shape the HTML view consumes:
 *
 *   - alarms       CloudWatch DescribeAlarms filtered to our prefix.
 *                  Anything in `ALARM` is an active incident.
 *   - canary       Recent canary_fired audit rows from the last 24h.
 *                  Uptime ratio = ok / total over that window.
 *   - deploys      Recent CFN UPDATE_COMPLETE stack events on the
 *                  Compute stack (one row per shipped deploy).
 *
 * Every source is wrapped so a single AWS-side failure degrades the
 * page section but does not fail the whole response. A status page
 * that 500s during an incident defeats its own purpose.
 */

import {
  CloudWatchClient,
  DescribeAlarmsCommand,
  type MetricAlarm,
} from '@aws-sdk/client-cloudwatch';
import {
  CloudFormationClient,
  DescribeStackEventsCommand,
  type StackEvent,
} from '@aws-sdk/client-cloudformation';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../../lib/state/ddb.js';
import { logger } from '../../observability/logger.js';

const REGION = process.env.AWS_REGION ?? 'us-east-1';
// Matches the rest of the orchestrator: deterministic default that
// the CDK env injection overrides in prod / staging.
const AUDIT_TABLE = process.env.TABLE_AUDIT_LOG ?? 'claudeclaw-audit-log';
// Alarm prefix matches the resource-naming convention. CDK overrides
// via CCE_RESOURCE_PREFIX so a staging deploy filters its own alarms.
const ALARM_PREFIX = process.env.CCE_RESOURCE_PREFIX ?? 'claudeclaw';

let _cw: CloudWatchClient | null = null;
let _cfn: CloudFormationClient | null = null;
function cw(): CloudWatchClient {
  if (!_cw) _cw = new CloudWatchClient({ region: REGION });
  return _cw;
}
function cfn(): CloudFormationClient {
  if (!_cfn) _cfn = new CloudFormationClient({ region: REGION });
  return _cfn;
}

/** Test seam. */
export function __setStatusClients(
  next: { cw?: CloudWatchClient | null; cfn?: CloudWatchClient | null } = {},
): void {
  if ('cw' in next) _cw = next.cw ?? null;
  if ('cfn' in next) _cfn = next.cfn ? (next.cfn as unknown as CloudFormationClient) : null;
}

export interface AlarmRow {
  name: string;
  state: 'OK' | 'ALARM' | 'INSUFFICIENT_DATA';
  reason?: string;
  updatedAt?: string;
}

export interface CanarySummary {
  windowHours: number;
  total: number;
  ok: number;
  errors: number;
  uptimePct: number | null;
  lastFiredAt?: string;
  lastResult?: 'ok' | 'error';
}

export interface DeployRow {
  stack: string;
  timestamp: string;
  status: string;
}

export interface StatusData {
  generatedAt: string;
  /** Overall traffic light derived from alarms + canary. */
  overall: 'ok' | 'degraded' | 'down';
  alarms: AlarmRow[];
  canary: CanarySummary;
  deploys: DeployRow[];
  /** Any source that failed to read; surfaced in the page footer. */
  sourceErrors: string[];
}

async function fetchAlarms(): Promise<AlarmRow[]> {
  const out: AlarmRow[] = [];
  let token: string | undefined;
  // DescribeAlarms with an AlarmNamePrefix is server-side filtered,
  // so we don't scan the whole account's alarm list every request.
  do {
    const resp = await cw().send(
      new DescribeAlarmsCommand({
        AlarmNamePrefix: ALARM_PREFIX,
        NextToken: token,
        MaxRecords: 100,
      }),
    );
    for (const a of (resp.MetricAlarms ?? []) as MetricAlarm[]) {
      if (!a.AlarmName) continue;
      out.push({
        name: a.AlarmName,
        state: (a.StateValue as AlarmRow['state']) ?? 'INSUFFICIENT_DATA',
        ...(a.StateReason ? { reason: a.StateReason } : {}),
        ...(a.StateUpdatedTimestamp
          ? { updatedAt: a.StateUpdatedTimestamp.toISOString() }
          : {}),
      });
    }
    token = resp.NextToken;
  } while (token);
  return out;
}

/**
 * Read recent canary_fired audit rows. The audit table partitions by
 * DAY#YYYYMMDD, so we query today + yesterday to cover the rolling
 * 24h window cleanly without scanning the whole table.
 */
async function fetchCanary(windowHours = 24): Promise<CanarySummary> {
  const cutoffMs = Date.now() - windowHours * 60 * 60 * 1000;
  const days = new Set<string>();
  for (let ms = cutoffMs; ms <= Date.now() + 1; ms += 12 * 60 * 60 * 1000) {
    const d = new Date(ms);
    days.add(
      `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`,
    );
  }
  // Always include today even if the loop above missed it.
  const now = new Date();
  days.add(
    `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(now.getUTCDate()).padStart(2, '0')}`,
  );

  let total = 0;
  let ok = 0;
  let errors = 0;
  let lastFiredAt: string | undefined;
  let lastResult: 'ok' | 'error' | undefined;
  for (const day of Array.from(days).sort()) {
    let last: Record<string, unknown> | undefined;
    do {
      const resp = await ddb().send(
        new QueryCommand({
          TableName: AUDIT_TABLE,
          KeyConditionExpression: 'PK = :pk',
          ExpressionAttributeValues: { ':pk': `DAY#${day}` },
          // The action attribute is inside the item; we filter
          // client-side rather than via FilterExpression because the
          // expected canary volume per day (~288 rows at 5-min cadence)
          // is small.
          Limit: 500,
          ScanIndexForward: true,
          ...(last ? { ExclusiveStartKey: last } : {}),
        }),
      );
      for (const item of resp.Items ?? []) {
        if (item.action !== 'canary_fired') continue;
        const ts = typeof item.ts === 'string' ? Date.parse(item.ts) : NaN;
        if (!Number.isFinite(ts) || ts < cutoffMs) continue;
        total += 1;
        if (item.result === 'ok') ok += 1;
        else errors += 1;
        if (!lastFiredAt || (typeof item.ts === 'string' && item.ts > lastFiredAt)) {
          lastFiredAt = typeof item.ts === 'string' ? item.ts : undefined;
          lastResult = item.result === 'ok' ? 'ok' : 'error';
        }
      }
      last = resp.LastEvaluatedKey;
    } while (last);
  }
  const uptimePct = total > 0 ? Math.round((ok / total) * 1000) / 10 : null;
  return {
    windowHours,
    total,
    ok,
    errors,
    uptimePct,
    ...(lastFiredAt ? { lastFiredAt } : {}),
    ...(lastResult ? { lastResult } : {}),
  };
}

async function fetchDeploys(stackName: string, limit = 10): Promise<DeployRow[]> {
  const out: DeployRow[] = [];
  // Stack events include every resource transition; we filter to the
  // root stack's UPDATE_COMPLETE / CREATE_COMPLETE events to get one
  // row per shipped deploy.
  let token: string | undefined;
  let pages = 0;
  do {
    const resp = await cfn().send(
      new DescribeStackEventsCommand({ StackName: stackName, NextToken: token }),
    );
    for (const ev of (resp.StackEvents ?? []) as StackEvent[]) {
      if (ev.LogicalResourceId !== stackName) continue;
      if (
        ev.ResourceStatus !== 'UPDATE_COMPLETE' &&
        ev.ResourceStatus !== 'CREATE_COMPLETE'
      ) {
        continue;
      }
      if (!ev.Timestamp) continue;
      out.push({
        stack: stackName,
        timestamp: ev.Timestamp.toISOString(),
        status: ev.ResourceStatus,
      });
      if (out.length >= limit) return out;
    }
    token = resp.NextToken;
    pages += 1;
  } while (token && pages < 5);
  return out;
}

export function pickOverall(args: {
  alarms: AlarmRow[];
  canary: CanarySummary;
}): StatusData['overall'] {
  const active = args.alarms.filter((a) => a.state === 'ALARM');
  if (active.length > 0) return 'down';
  if (args.canary.uptimePct !== null && args.canary.uptimePct < 95) return 'degraded';
  return 'ok';
}

/**
 * Top-level data assembler. Each source has its own try/catch so one
 * AWS hiccup degrades a section instead of taking the page down.
 */
export async function assembleStatusData(args: {
  stackName?: string;
} = {}): Promise<StatusData> {
  const stackName = args.stackName ?? process.env.CCE_COMPUTE_STACK ?? 'CCE-Compute';
  const sourceErrors: string[] = [];

  const alarms = await fetchAlarms().catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ errMessage: msg }, 'status: alarms fetch failed');
    sourceErrors.push(`alarms: ${msg}`);
    return [] as AlarmRow[];
  });
  const canary = await fetchCanary(24).catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ errMessage: msg }, 'status: canary fetch failed');
    sourceErrors.push(`canary: ${msg}`);
    return {
      windowHours: 24,
      total: 0,
      ok: 0,
      errors: 0,
      uptimePct: null,
    } satisfies CanarySummary;
  });
  const deploys = await fetchDeploys(stackName, 10).catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ errMessage: msg }, 'status: deploys fetch failed');
    sourceErrors.push(`deploys: ${msg}`);
    return [] as DeployRow[];
  });

  return {
    generatedAt: new Date().toISOString(),
    overall: pickOverall({ alarms, canary }),
    alarms,
    canary,
    deploys,
    sourceErrors,
  };
}
