/**
 * Read-only GuardDuty posture reader (Tier B).
 *
 * Reports a single card: is a GuardDuty detector enabled in this region,
 * and how many high-severity findings are currently open? GuardDuty's
 * detector id is discovered at runtime via guardduty:ListDetectors (no env
 * injection).
 *
 * We deliberately surface only a COUNT of high-severity findings, never
 * the finding detail (which can contain principal names, IPs, resource
 * arns). Tier B is metadata only.
 *
 * Fail-soft: a denied permission or a region with no detector degrades to
 * an 'unknown' / 'warn' card instead of a 500.
 */

import {
  GuardDutyClient,
  ListDetectorsCommand,
  GetDetectorCommand,
  ListFindingsCommand,
} from '@aws-sdk/client-guardduty';
import { logger } from '../../observability/logger.js';
import type { PostureCard } from '../../adapters/dashboard/posture-network.js';

const REGION = process.env.AWS_REGION ?? 'us-east-1';
// GuardDuty maps severity to numeric bands: 7.0+ is High, 8.0+ Critical.
// We count High and above as the actionable bucket.
const HIGH_SEVERITY_THRESHOLD = 7.0;

let _gd: GuardDutyClient | null = null;

function gd(): GuardDutyClient {
  if (!_gd) _gd = new GuardDutyClient({ region: REGION });
  return _gd;
}

/** Test seam: inject a fake, or null to force re-create. */
export function __setGuardDutyClients(
  next: { gd?: GuardDutyClient | null } = {},
): void {
  if ('gd' in next) _gd = next.gd ?? null;
}

/**
 * Build the GuardDuty posture card. The detector id is the first detector
 * in the region (an account has at most one per region).
 */
export async function readGuardDutyPosture(): Promise<PostureCard[]> {
  let detectorId: string | undefined;
  try {
    const list = await gd().send(new ListDetectorsCommand({}));
    detectorId = list.DetectorIds?.[0];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ errMessage: msg }, 'posture: guardduty list failed');
    return [
      {
        id: 'guardduty-enabled',
        label: 'GuardDuty threat detection',
        status: 'unknown',
        detail: `Could not list GuardDuty detectors (${msg}).`,
      },
    ];
  }

  if (!detectorId) {
    return [
      {
        id: 'guardduty-enabled',
        label: 'GuardDuty threat detection',
        status: 'warn',
        detail:
          'No GuardDuty detector in this region. Threat detection is not active.',
      },
    ];
  }

  // Is the detector actually ENABLED (vs created-but-disabled)?
  const detector = await gd()
    .send(new GetDetectorCommand({ DetectorId: detectorId }))
    .catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ errMessage: msg }, 'posture: guardduty get failed');
      return undefined;
    });
  const enabled = detector?.Status === 'ENABLED';

  // Count high-severity open findings. We never read the findings detail,
  // only the id count, so no sensitive data leaves AWS.
  let highCount: number | undefined;
  try {
    const findings = await gd().send(
      new ListFindingsCommand({
        DetectorId: detectorId,
        FindingCriteria: {
          Criterion: {
            severity: { Gte: HIGH_SEVERITY_THRESHOLD },
            'service.archived': { Eq: ['false'] },
          },
        },
        MaxResults: 50,
      }),
    );
    highCount = findings.FindingIds?.length ?? 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ errMessage: msg }, 'posture: guardduty findings failed');
    // Detector state is still informative even if findings are denied.
    highCount = undefined;
  }

  let status: PostureCard['status'];
  let detail: string;
  if (!enabled) {
    status = 'warn';
    detail = `Detector ${detectorId.slice(0, 8)} exists but is not ENABLED.`;
  } else if (highCount === undefined) {
    status = 'ok';
    detail = 'GuardDuty detector ENABLED. High-severity finding count not readable.';
  } else if (highCount > 0) {
    status = 'crit';
    detail = `GuardDuty detector ENABLED. ${highCount} open high-severity finding(s).`;
  } else {
    status = 'ok';
    detail = 'GuardDuty detector ENABLED. No open high-severity findings.';
  }

  return [
    {
      id: 'guardduty-enabled',
      label: 'GuardDuty threat detection',
      status,
      detail,
      ...(highCount !== undefined ? { value: String(highCount) } : {}),
    },
  ];
}
