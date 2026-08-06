/**
 * CloudTrail posture reader (Tier B, read-only).
 *
 * Resolves the audit trail by name (CCE_CLOUDTRAIL_NAME) and emits a
 * handful of green/amber/red posture cards describing whether audit
 * logging is configured the way the security baseline expects:
 *
 *   - trail exists and is enabled
 *   - it is multi-region (captures activity in every region)
 *   - it is actively delivering log files (GetTrailStatus.IsLogging)
 *   - data events are recorded for the audit DynamoDB table
 *
 * Every describe / get call is wrapped so a denied permission or an
 * API error degrades the relevant card to an 'unknown' (amber) state
 * with a short note, never throwing. No secret values are returned;
 * only trail metadata (name, region scope, logging flag).
 */

import {
  CloudTrailClient,
  DescribeTrailsCommand,
  GetTrailStatusCommand,
  GetEventSelectorsCommand,
  type Trail,
  type EventSelector,
  type AdvancedEventSelector,
} from '@aws-sdk/client-cloudtrail';
import { logger } from '../../observability/logger.js';

export type PostureStatus = 'ok' | 'warn' | 'crit' | 'unknown';

export interface PostureCard {
  id: string;
  label: string;
  status: PostureStatus;
  detail: string;
  value?: string;
}

const REGION = process.env.AWS_REGION ?? 'us-east-1';
// Audit table name doubles as the data-event resource we expect the
// trail to be logging. Same deterministic default as the rest of the
// orchestrator; CDK overrides via TABLE_AUDIT_LOG.
const AUDIT_TABLE = process.env.TABLE_AUDIT_LOG ?? 'claudeclaw-audit-log';

let _ct: CloudTrailClient | null = null;
function ct(): CloudTrailClient {
  if (!_ct) _ct = new CloudTrailClient({ region: REGION });
  return _ct;
}

/** Test seam. */
export function __setCloudTrailClient(next: CloudTrailClient | null): void {
  _ct = next;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Returns the four CloudTrail posture cards. Card ids are stable and
 * documented in the router contract:
 *   posture.cloudtrail.enabled
 *   posture.cloudtrail.multiRegion
 *   posture.cloudtrail.logging
 *   posture.cloudtrail.dataEvents
 */
export async function fetchCloudTrailPostureCards(): Promise<PostureCard[]> {
  const trailName = process.env.CCE_CLOUDTRAIL_NAME;

  // When we have no configured trail name we still attempt a describe of
  // all trails so a discoverable trail does not look "missing". But the
  // baseline check targets our named audit trail specifically.
  let trail: Trail | undefined;
  let describeError: string | undefined;
  try {
    const resp = await ct().send(
      new DescribeTrailsCommand(
        trailName ? { trailNameList: [trailName], includeShadowTrails: true } : {},
      ),
    );
    const trails = resp.trailList ?? [];
    trail = trailName
      ? trails.find((t) => t.Name === trailName || t.TrailARN?.includes(`/${trailName}`))
      : trails[0];
  } catch (err) {
    describeError = errMsg(err);
    logger.warn({ errMessage: describeError }, 'posture: cloudtrail DescribeTrails failed');
  }

  // ── Card 1: trail enabled / exists ────────────────────────────────
  const enabledCard: PostureCard = describeError
    ? {
        id: 'posture.cloudtrail.enabled',
        label: 'CloudTrail audit trail',
        status: 'unknown',
        detail: `Could not read trails: ${describeError}`,
      }
    : trail
      ? {
          id: 'posture.cloudtrail.enabled',
          label: 'CloudTrail audit trail',
          status: 'ok',
          detail: `Trail "${trail.Name ?? 'unknown'}" is configured.`,
          value: trail.Name ?? undefined,
        }
      : {
          id: 'posture.cloudtrail.enabled',
          label: 'CloudTrail audit trail',
          status: 'crit',
          detail: trailName
            ? `No trail named "${trailName}" was found.`
            : 'No CloudTrail trail is configured.',
        };

  // ── Card 2: multi-region ──────────────────────────────────────────
  let multiRegionCard: PostureCard;
  if (describeError) {
    multiRegionCard = {
      id: 'posture.cloudtrail.multiRegion',
      label: 'Trail multi-region coverage',
      status: 'unknown',
      detail: `Could not read trails: ${describeError}`,
    };
  } else if (!trail) {
    multiRegionCard = {
      id: 'posture.cloudtrail.multiRegion',
      label: 'Trail multi-region coverage',
      status: 'unknown',
      detail: 'No trail to inspect.',
    };
  } else if (trail.IsMultiRegionTrail) {
    multiRegionCard = {
      id: 'posture.cloudtrail.multiRegion',
      label: 'Trail multi-region coverage',
      status: 'ok',
      detail: 'Trail captures activity across all regions.',
      value: 'multi-region',
    };
  } else {
    multiRegionCard = {
      id: 'posture.cloudtrail.multiRegion',
      label: 'Trail multi-region coverage',
      status: 'warn',
      detail: 'Trail is single-region; activity in other regions is not logged.',
      value: 'single-region',
    };
  }

  // ── Card 3: actively logging ──────────────────────────────────────
  let loggingCard: PostureCard;
  // GetTrailStatus takes the trail name or ARN; prefer the ARN when we
  // have one so it resolves regardless of the caller's home region.
  const trailRef = trail?.TrailARN ?? trail?.Name ?? trailName;
  if (!trailRef || describeError || !trail) {
    loggingCard = {
      id: 'posture.cloudtrail.logging',
      label: 'Trail delivering logs',
      status: 'unknown',
      detail: describeError
        ? `Could not read trails: ${describeError}`
        : 'No trail to inspect.',
    };
  } else {
    try {
      const status = await ct().send(new GetTrailStatusCommand({ Name: trailRef }));
      if (status.IsLogging) {
        loggingCard = {
          id: 'posture.cloudtrail.logging',
          label: 'Trail delivering logs',
          status: 'ok',
          detail: 'Trail is actively delivering log files.',
          value: 'logging',
        };
      } else {
        loggingCard = {
          id: 'posture.cloudtrail.logging',
          label: 'Trail delivering logs',
          status: 'crit',
          detail: 'Trail exists but logging is stopped.',
          value: 'stopped',
        };
      }
    } catch (err) {
      const msg = errMsg(err);
      logger.warn({ errMessage: msg }, 'posture: cloudtrail GetTrailStatus failed');
      loggingCard = {
        id: 'posture.cloudtrail.logging',
        label: 'Trail delivering logs',
        status: 'unknown',
        detail: `Could not read trail status: ${msg}`,
      };
    }
  }

  // ── Card 4: data events on the audit table ────────────────────────
  let dataEventsCard: PostureCard;
  if (!trailRef || describeError || !trail) {
    dataEventsCard = {
      id: 'posture.cloudtrail.dataEvents',
      label: 'Data events on audit table',
      status: 'unknown',
      detail: describeError
        ? `Could not read trails: ${describeError}`
        : 'No trail to inspect.',
    };
  } else {
    try {
      const sel = await ct().send(new GetEventSelectorsCommand({ TrailName: trailRef }));
      const hasDataEvents = eventSelectorsCoverTable(
        sel.EventSelectors,
        sel.AdvancedEventSelectors,
        AUDIT_TABLE,
      );
      if (hasDataEvents) {
        dataEventsCard = {
          id: 'posture.cloudtrail.dataEvents',
          label: 'Data events on audit table',
          status: 'ok',
          detail: `Data events are recorded for the audit table "${AUDIT_TABLE}".`,
          value: 'enabled',
        };
      } else {
        dataEventsCard = {
          id: 'posture.cloudtrail.dataEvents',
          label: 'Data events on audit table',
          status: 'warn',
          detail: 'Trail does not record data events covering the audit table.',
          value: 'not-covered',
        };
      }
    } catch (err) {
      const msg = errMsg(err);
      logger.warn({ errMessage: msg }, 'posture: cloudtrail GetEventSelectors failed');
      dataEventsCard = {
        id: 'posture.cloudtrail.dataEvents',
        label: 'Data events on audit table',
        status: 'unknown',
        detail: `Could not read event selectors: ${msg}`,
      };
    }
  }

  return [enabledCard, multiRegionCard, loggingCard, dataEventsCard];
}

/**
 * Heuristic: does this trail's event-selector config record data events
 * that would cover the audit DynamoDB table? We accept either a basic
 * selector that includes DynamoDB tables broadly, or an advanced
 * selector whose resources reference the table name. Conservative: if we
 * cannot positively confirm coverage we return false (the card degrades
 * to a warn, not a false "ok").
 */
function eventSelectorsCoverTable(
  basic: EventSelector[] | undefined,
  advanced: AdvancedEventSelector[] | undefined,
  tableName: string,
): boolean {
  for (const s of basic ?? []) {
    for (const dr of s.DataResources ?? []) {
      const type = dr.Type ?? '';
      if (!type.includes('DynamoDB')) continue;
      const values = dr.Values ?? [];
      // "arn:aws:dynamodb" alone (all tables) or an ARN naming our table.
      if (values.some((v) => v.endsWith(':dynamodb') || v.includes(`/${tableName}`))) {
        return true;
      }
      // A bare DynamoDB data-resource with no narrowing values means
      // "all current and future tables".
      if (values.length === 0) return true;
    }
  }
  for (const a of advanced ?? []) {
    let isDataEvent = false;
    let matchesTable = false;
    for (const fs of a.FieldSelectors ?? []) {
      const field = fs.Field ?? '';
      const all = [
        ...(fs.Equals ?? []),
        ...(fs.StartsWith ?? []),
        ...(fs.EndsWith ?? []),
      ];
      if (field === 'eventCategory' && all.includes('Data')) isDataEvent = true;
      if (field === 'resources.type' && all.some((v) => v.includes('DynamoDB'))) {
        // A DynamoDB-typed data selector with no ARN narrowing covers
        // every table, which includes ours.
        matchesTable = true;
      }
      if (field === 'resources.ARN' && all.some((v) => v.includes(`/${tableName}`))) {
        matchesTable = true;
      }
    }
    if (isDataEvent && matchesTable) return true;
  }
  return false;
}
