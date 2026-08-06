/**
 * Compliance evidence collector.
 *
 * Gathers the LIVE posture signals the dashboard already reads and tags each
 * one with the control domains it informs, so the control catalog
 * (./control-catalog.ts) can grade SOC 2 / HIPAA controls against real state
 * instead of a checkbox the user self-asserts.
 *
 * It deliberately reuses the SAME readers the four Security-Posture routers use
 * (encryption/secrets/backup, WAF/network/GuardDuty, IAM least-privilege,
 * observability + CloudTrail), so the compliance verdict and the Security
 * Posture cards can never disagree. Every source is wrapped fail-soft: a denied
 * describe or a thrown reader degrades to nothing (or an 'unknown' card) rather
 * than failing the whole snapshot. A short in-memory cache fronts the assembly
 * so repeated dashboard polls do not re-hit AWS.
 */

import { getSecurityPosture } from '../security/posture-repo.js';
import { readWafPosture } from '../aws/waf-reader.js';
import { readNetworkPosture } from '../aws/network-reader.js';
import { readGuardDutyPosture } from '../aws/guardduty-reader.js';
import { fetchIamPosture } from '../posture/iam-reader.js';
import { evaluateIamPosture } from '../posture/iam-evaluator.js';
import { assembleStatusData, type StatusData } from '../../adapters/status/data.js';
import { fetchCloudTrailPostureCards } from '../aws/cloudtrail-reader.js';
import { logger } from '../../observability/logger.js';

/** A posture card augmented with provenance + control-domain tags. */
export interface EvidenceCard {
  id: string;
  label: string;
  status: 'ok' | 'warn' | 'crit' | 'unknown';
  detail: string;
  value?: string;
  /** Source area, for grouping/debugging. */
  area: string;
  /** Control-domain tags the catalog matches against. */
  tags: string[];
}

/** Minimal structural shape every posture reader returns. */
interface RawCard {
  id: string;
  label: string;
  status: 'ok' | 'warn' | 'crit' | 'unknown';
  detail: string;
  value?: string;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function toEvidence(card: RawCard, area: string, tags: string[]): EvidenceCard {
  return {
    id: card.id,
    label: card.label,
    status: card.status,
    detail: card.detail,
    ...(card.value ? { value: card.value } : {}),
    area,
    tags,
  };
}

/** Run one source fail-soft; an error yields no cards (logged, not thrown). */
async function safeSource(
  name: string,
  fn: () => Promise<EvidenceCard[]>,
): Promise<EvidenceCard[]> {
  try {
    return await fn();
  } catch (err) {
    logger.warn({ errMessage: errMsg(err), source: name }, 'compliance: evidence source failed');
    return [];
  }
}

/**
 * Tag the encryption/secrets/backup/audit bundle from getSecurityPosture by its
 * stable card ids (defined in security/posture-repo.ts).
 */
function tagSecurityPosture(cards: RawCard[]): EvidenceCard[] {
  return cards.map((card) => {
    if (card.id.startsWith('kms-')) {
      return toEvidence(card, 'encryption', ['encryption-at-rest', 'key-rotation']);
    }
    if (card.id.startsWith('secret-')) {
      return toEvidence(card, 'secrets', ['secrets-mgmt']);
    }
    if (card.id === 'ddb-pitr') {
      return toEvidence(card, 'backup', ['backup-recovery']);
    }
    if (card.id === 's3-audit-object-lock') {
      return toEvidence(card, 'audit', ['audit-immutability']);
    }
    if (card.id === 's3-audit-encrypted') {
      return toEvidence(card, 'audit', ['encryption-at-rest']);
    }
    // Group-failure fallback cards from posture-repo use bare ids (no hyphen)
    // when a whole source throws. Map each to its real area/tags so it is not
    // mis-attributed to encryption by the catch-all below.
    if (card.id === 'kms') {
      return toEvidence(card, 'encryption', ['encryption-at-rest', 'key-rotation']);
    }
    if (card.id === 'secrets') {
      return toEvidence(card, 'secrets', ['secrets-mgmt']);
    }
    if (card.id === 's3-audit') {
      return toEvidence(card, 'audit', ['audit-immutability']);
    }
    // Unknown future card from this source: keep it, tag conservatively.
    return toEvidence(card, 'security', ['encryption-at-rest']);
  });
}

/**
 * Derive the alarms + canary evidence cards from the status aggregate. This
 * mirrors (intentionally, minimally) the observability posture router's logic;
 * we only need status + a human detail for the evidence drill-down, not pixel
 * parity with that page.
 */
function observabilityStatusCards(status: StatusData): EvidenceCard[] {
  const cards: EvidenceCard[] = [];

  const alarmsErr = status.sourceErrors.find((e) => e.startsWith('alarms:'));
  if (alarmsErr) {
    cards.push(
      toEvidence(
        { id: 'obs-alarms', label: 'CloudWatch alarms', status: 'unknown', detail: `Could not read alarms: ${alarmsErr.replace(/^alarms:\s*/, '')}` },
        'observability',
        ['monitoring-alerting'],
      ),
    );
  } else {
    const total = status.alarms.length;
    const inAlarm = status.alarms.filter((a) => a.state === 'ALARM').length;
    const card: RawCard =
      inAlarm > 0
        ? { id: 'obs-alarms', label: 'CloudWatch alarms', status: 'crit', detail: `${inAlarm} of ${total} alarm(s) currently firing.`, value: `${inAlarm} firing` }
        : total === 0
          ? { id: 'obs-alarms', label: 'CloudWatch alarms', status: 'warn', detail: 'No CloudWatch alarms are configured.', value: '0 alarms' }
          : { id: 'obs-alarms', label: 'CloudWatch alarms', status: 'ok', detail: `${total} alarm(s) configured, none firing.`, value: `${total} ok` };
    cards.push(toEvidence(card, 'observability', ['monitoring-alerting']));
  }

  const canaryErr = status.sourceErrors.find((e) => e.startsWith('canary:'));
  if (canaryErr) {
    cards.push(
      toEvidence(
        { id: 'obs-canary', label: 'Synthetic canary', status: 'unknown', detail: `Could not read canary history: ${canaryErr.replace(/^canary:\s*/, '')}` },
        'observability',
        ['monitoring-alerting', 'service-uptime'],
      ),
    );
  } else {
    const c = status.canary;
    const card: RawCard =
      c.total === 0
        ? { id: 'obs-canary', label: 'Synthetic canary', status: 'warn', detail: `No canary runs recorded in the last ${c.windowHours}h.`, value: 'no data' }
        : c.lastResult === 'error'
          ? { id: 'obs-canary', label: 'Synthetic canary', status: 'crit', detail: `Last canary run failed${c.lastFiredAt ? ` at ${c.lastFiredAt}` : ''}.`, value: c.uptimePct !== null ? `${c.uptimePct}%` : 'error' }
          : c.uptimePct !== null && c.uptimePct < 95
            ? { id: 'obs-canary', label: 'Synthetic canary', status: 'warn', detail: `Canary uptime ${c.uptimePct}% over ${c.windowHours}h (below 95%).`, value: `${c.uptimePct}%` }
            : { id: 'obs-canary', label: 'Synthetic canary', status: 'ok', detail: `Last canary run ok. Uptime ${c.uptimePct ?? 100}% over ${c.windowHours}h.`, value: c.uptimePct !== null ? `${c.uptimePct}%` : 'ok' };
    cards.push(toEvidence(card, 'observability', ['monitoring-alerting', 'service-uptime']));
  }

  return cards;
}

function xrayEvidence(): EvidenceCard {
  const enabled = process.env.CCE_XRAY_ENABLED === '1';
  const tier = Number(process.env.CCE_TIER ?? '1');
  return toEvidence(
    enabled
      ? { id: 'obs-xray', label: 'X-Ray tracing', status: 'ok', detail: `Distributed tracing is enabled (Tier ${Number.isFinite(tier) ? tier : '?'}).`, value: 'enabled' }
      : { id: 'obs-xray', label: 'X-Ray tracing', status: 'warn', detail: 'Distributed tracing is not enabled. X-Ray activates at Tier 2+.', value: 'tier 2+' },
    'observability',
    ['tracing'],
  );
}

// ── Snapshot assembly + short in-memory cache ───────────────────────

const CACHE_TTL_MS = 30_000;
let _cache: { at: number; cards: EvidenceCard[] } | null = null;

/**
 * Collect the full tagged evidence set used to grade SOC 2 + HIPAA controls.
 * Each source is independently fail-soft; the result is cached for
 * CACHE_TTL_MS so repeated polls (summary + per-control analysis) reuse one
 * snapshot and do not re-hit AWS.
 */
export async function collectComplianceEvidence(
  opts: { force?: boolean } = {},
): Promise<EvidenceCard[]> {
  const now = Date.now();
  if (!opts.force && _cache && now - _cache.at < CACHE_TTL_MS) {
    return _cache.cards;
  }

  const groups = await Promise.all([
    // Encryption / secrets / backup / audit immutability.
    safeSource('security-posture', async () =>
      tagSecurityPosture(await getSecurityPosture()),
    ),
    // Network boundary + WAF (also transmission-security) + threat detection.
    safeSource('waf', async () =>
      (await readWafPosture()).map((c) =>
        toEvidence(c, 'network', ['network-boundary', 'transmission-security']),
      ),
    ),
    safeSource('network', async () =>
      (await readNetworkPosture()).map((c) =>
        toEvidence(c, 'network', ['network-boundary']),
      ),
    ),
    safeSource('guardduty', async () =>
      (await readGuardDutyPosture()).map((c) =>
        toEvidence(c, 'network', ['threat-detection']),
      ),
    ),
    // IAM least-privilege on the workload's own role.
    safeSource('iam', async () => {
      const posture = await fetchIamPosture();
      const { cards } = evaluateIamPosture(posture);
      return cards.map((c) => toEvidence(c, 'iam', ['access-control-iam']));
    }),
    // Observability: alarms + canary + X-Ray.
    safeSource('observability', async () => {
      const status = await assembleStatusData();
      return [...observabilityStatusCards(status), xrayEvidence()];
    }),
    // CloudTrail audit/activity-review trail.
    safeSource('cloudtrail', async () =>
      (await fetchCloudTrailPostureCards()).map((c) =>
        toEvidence(c, 'audit', ['audit-logging', 'activity-review']),
      ),
    ),
  ]);

  const cards = groups.flat();
  _cache = { at: now, cards };
  return cards;
}

/** Test seam: drop the cache. */
export function __resetComplianceEvidenceCache(): void {
  _cache = null;
}
