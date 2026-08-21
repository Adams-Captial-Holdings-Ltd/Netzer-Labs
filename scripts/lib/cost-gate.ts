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
export function resourceSummary(
  tierId: DeployTier,
  privateEndpoints: boolean,
  paperclip = false,
): string {
  const shape = TIERS[tierId];
  const parts = ['ALB', `NAT x${shape.natGatewayCount}`];
  if (privateEndpoints) parts.push('VPC interface endpoints');
  parts.push('DynamoDB', 'KMS', `Fargate x${shape.fargateMinTasks}`);
  // Paperclip work engine (ADR 0010): always-on Aurora min-ACU floor + EFS +
  // the service's own Fargate task. Opt-in like the endpoints above —
  // infra/bin/app.ts synthesizes the stacks only when CCE_PAPERCLIP_ENABLED=1,
  // so listing them unconditionally told every operator that a routine deploy
  // was creating an Aurora cluster it never creates.
  //
  // The Fargate line is listed SEPARATELY from the `Fargate xN` above, not
  // folded into that count: it is a second, independently-sized task
  // (2 vCPU / 4 GB ARM64, desiredCount 1, no autoscaling) on its own task
  // definition, and it is the single largest item the flag adds. Rolling it
  // into the orchestrator's count would hide it behind a number that looks
  // like it only went up by one.
  if (paperclip) {
    parts.push('Aurora Serverless v2 (Paperclip)', 'EFS', 'Fargate x1 (Paperclip)');
  }
  if (shape.wafEnabled) parts.push('WAF');
  if (shape.cloudFrontEnabled) parts.push('CloudFront');
  return parts.join(' + ');
}

/**
 * Honest fixed-floor ranges per tier, lifted from docs/cost-guide.md (which
 * derives them from the estimator plus real-deployment observation). Used
 * only when the estimator spawn fails; endpoints and the Paperclip substrate
 * are priced separately below because the ranges assume both defaults off
 * (CCE_PRIVATE_ENDPOINTS and CCE_PAPERCLIP_ENABLED).
 */
export const FALLBACK_RANGES: Record<DeployTier, string> = {
  0: '$65 to $95',
  1: '$130 to $180',
  2: '$230 to $400',
  3: '$300 to $800',
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
  paperclip = false,
): string {
  // Appended to BOTH branches, unlike the endpoints clause below. Neither
  // branch prices the Paperclip substrate on its own: the ranges above are
  // pre-Paperclip, and scripts/cost-estimate.mjs carries no Aurora/EFS/Fargate
  // line item for it at all. Adding it only to the fallback would hide the
  // cost on the path that normally runs.
  //
  // The Fargate half is NEW HERE and it roughly doubles the figure. The
  // previous note said "roughly $50/mo for the Aurora min-ACU floor and EFS"
  // and carried a "fold in the Fargate task in Phase 2" TODO — that phase has
  // now landed the task, so the gate was under-reporting the cost of arming
  // by about half while telling operators it was complete.
  //
  // ~$58/mo: 2 vCPU + 4 GB ARM64 Fargate, desiredCount 1 with no autoscaling
  // (infra/lib/paperclip-stack.ts), so it bills 24/7 at us-east-1 Graviton
  // rates of $0.03238/vCPU-hr and $0.00356/GB-hr over 730 hours. Rounded and
  // stated as an estimate: it is arithmetic from published rates, not a
  // Pricing API call, and it excludes egress and the migration task's minutes.
  const paperclipNote = paperclip
    ? ', plus roughly $110/mo for the Paperclip work engine — about $50 for ' +
      'the Aurora min-ACU floor and EFS, plus about $58 for its always-on ' +
      '2 vCPU / 4 GB Fargate task (estimated, not verified against pricing APIs)'
    : '';
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
          `(scripts/cost-estimate.mjs, unit prices as of ${parsed.asOf ?? 'unknown'})` +
          `${paperclipNote} + Bedrock token spend`
        );
      }
    } catch {
      // fall through to the static range
    }
  }
  const endpoints = privateEndpoints
    ? ', plus roughly $220/mo for the opt-in VPC interface endpoints'
    : '';
  return `${FALLBACK_RANGES[tierId]}/mo fixed floor (docs/cost-guide.md)${endpoints}${paperclipNote} + Bedrock token spend`;
}
