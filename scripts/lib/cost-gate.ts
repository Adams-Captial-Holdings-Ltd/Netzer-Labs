/**
 * Tier-aware copy for the deploy confirmation gate (issue #50).
 *
 * The gate used to print a fixed "$140 + VPC endpoints" line regardless of
 * tier, over-stating a Hobby deploy and listing interface endpoints that only
 * exist when CCE_PRIVATE_ENDPOINTS=1. These helpers derive the resource list
 * from the same TIERS shape CDK deploys from, and format the dollar estimate
 * from `scripts/cost-estimate.mjs --json` output (the repo's recalculable
 * estimator) with a static docs/cost-guide.md range as the fail-soft fallback
 * when the spawn or parse fails.
 */

import { TIERS, type DeployTier } from '../../infra/lib/constants.js';

/** Coerce a raw DEPLOY_TIER env string to a valid tier, defaulting to 1. */
export function clampTier(raw: string | undefined): DeployTier {
  const trimmed = (raw ?? '').trim();
  // Guard the empty string explicitly: Number('') is 0, which is a VALID
  // tier, and an unset DEPLOY_TIER must mean the tier-1 default, not Hobby.
  if (trimmed === '') return 1;
  const n = Number(trimmed);
  return (n === 0 || n === 1 || n === 2 || n === 3 ? n : 1) as DeployTier;
}

/**
 * What a first deploy at this tier actually creates. Interface endpoints are
 * opt-in and only listed when the flag is set; WAF/CloudFront are tier-gated.
 */
export function resourceSummary(tierId: DeployTier, privateEndpoints: boolean): string {
  const shape = TIERS[tierId];
  const parts = ['ALB', `NAT x${shape.natGatewayCount}`];
  if (privateEndpoints) parts.push('VPC interface endpoints');
  parts.push('DynamoDB', 'KMS', `Fargate x${shape.fargateMinTasks}`);
  // Paperclip work engine substrate (ADR 0010): always-on Aurora min-ACU
  // floor + EFS. Deployed by phase a at every tier.
  parts.push('Aurora Serverless v2 (Paperclip)', 'EFS');
  if (shape.wafEnabled) parts.push('WAF');
  if (shape.cloudFrontEnabled) parts.push('CloudFront');
  return parts.join(' + ');
}

/**
 * Honest fixed-floor ranges per tier, lifted from docs/cost-guide.md (which
 * derives them from the estimator plus real-deployment observation). Used
 * only when the estimator spawn fails; endpoints are priced separately below
 * because the ranges assume the default CCE_PRIVATE_ENDPOINTS off.
 */
// Ranges include the Paperclip substrate added by ADR 0010 Phase 1
// (Aurora Serverless v2 min-ACU ~$45/mo + EFS; the Paperclip Fargate task
// arrives in a later phase). Estimated, not verified against pricing APIs
// — re-derive from scripts/cost-estimate.mjs once a deployment exists.
export const FALLBACK_RANGES: Record<DeployTier, string> = {
  0: '$110 to $150',
  1: '$175 to $235',
  2: '$275 to $455',
  3: '$345 to $855',
};

/**
 * Format the money line from estimator `--json` stdout. Falls back to the
 * docs range when stdout is null (spawn failed) or unparseable, so the gate
 * never blocks a deploy on a broken estimator.
 */
export function estimateLine(
  estimatorStdout: string | null,
  tierId: DeployTier,
  privateEndpoints: boolean,
): string {
  if (estimatorStdout) {
    try {
      const parsed = JSON.parse(estimatorStdout) as {
        asOf?: string;
        results?: Array<{ tier?: number; fixedMonthlyUsd?: number }>;
      };
      const row = parsed.results?.find((r) => r.tier === tierId);
      if (row && typeof row.fixedMonthlyUsd === 'number' && Number.isFinite(row.fixedMonthlyUsd)) {
        return (
          `~$${Math.round(row.fixedMonthlyUsd)}/mo fixed floor ` +
          `(scripts/cost-estimate.mjs, unit prices as of ${parsed.asOf ?? 'unknown'}) ` +
          `+ Bedrock token spend`
        );
      }
    } catch {
      // fall through to the static range
    }
  }
  const endpoints = privateEndpoints
    ? ', plus roughly $220/mo for the opt-in VPC interface endpoints'
    : '';
  return `${FALLBACK_RANGES[tierId]}/mo fixed floor (docs/cost-guide.md)${endpoints} + Bedrock token spend`;
}
