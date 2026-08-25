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

import { TIERS, paperclipProvisioned, type DeployTier } from '../../infra/lib/constants.js';

// Re-exported, not redefined. The parser moved to constants.ts so that
// infra/bin/app.ts — which since Phase 9 lets the tier decide whether Aurora
// EXISTS — calls the SAME function this gate prices from, instead of its own
// bare Number() that read a blank tier as Hobby. Callers here are unchanged.
export { clampTier } from '../../infra/lib/constants.js';

/**
 * What a first deploy at this tier actually creates. Interface endpoints are
 * opt-in and only listed when the flag is set; WAF/CloudFront are tier-gated.
 */
export function resourceSummary(
  tierId: DeployTier,
  privateEndpoints: boolean,
  env: Record<string, string | undefined> = process.env,
): string {
  const shape = TIERS[tierId];
  const parts = ['ALB', `NAT x${shape.natGatewayCount}`];
  if (privateEndpoints) parts.push('VPC interface endpoints');
  parts.push('DynamoDB', 'KMS', `Fargate x${shape.fargateMinTasks}`);
  // Paperclip work engine (ADR 0010): always-on Aurora min-ACU floor + EFS +
  // the service's own Fargate task. Read through `paperclipProvisioned`, not
  // from a separate flag the caller passes in: the same predicate
  // infra/bin/app.ts deploys from, so this gate cannot promise an Aurora
  // cluster synth does not create, or stay silent about one it does. That
  // predicate is the tier OR the environment-scoped provisioning override, so
  // a Tier 0 environment that opts in is charged for it here — the gate has to
  // name the money whichever input turned the substrate on.
  //
  // The Fargate line is listed SEPARATELY from the `Fargate xN` above, not
  // folded into that count: it is a second, independently-sized task
  // (2 vCPU / 4 GB ARM64, desiredCount 1, no autoscaling) on its own task
  // definition, and it is the single largest item the substrate adds. Rolling it
  // into the orchestrator's count would hide it behind a number that looks
  // like it only went up by one.
  if (paperclipProvisioned(tierId, env)) {
    parts.push('Aurora Serverless v2 (Paperclip)', 'EFS', 'Fargate x1 (Paperclip)');
  }
  if (shape.wafEnabled) parts.push('WAF');
  if (shape.cloudFrontEnabled) parts.push('CloudFront');
  return parts.join(' + ');
}

/**
 * Honest fixed-floor ranges per tier, lifted from docs/cost-guide.md (which
 * derives them from the estimator plus real-deployment observation). Used
 * only when the estimator spawn fails. They are still PRE-PAPERCLIP figures —
 * static prose in a docs page, not something this file can recompute — so the
 * note in estimateLine is appended to THIS branch only. The estimator itself
 * now carries the Aurora/EFS/Fargate line items, so the note must not be
 * appended there as well or the substrate is counted twice.
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
  env: Record<string, string | undefined> = process.env,
): string {
  // FALLBACK BRANCH ONLY, and that is the whole point of the change. The
  // estimator now carries Aurora + EFS + the Paperclip Fargate task as real
  // line items (scripts/cost-estimate.mjs, gated on the same
  // TierShape.paperclipEnabled), so its fixedMonthlyUsd already includes them
  // and appending this note there would bill the operator twice. The static
  // ranges above are docs prose this file cannot recompute, so they still need
  // it.
  //
  // Tier-driven since Phase 9, for the same reason resourceSummary is: the
  // substrate installs by default at Tier 1+, so an operator at those tiers
  // must be shown this money whether or not they have ever heard of the
  // engine, and a Tier 0 operator must not be charged for it in the copy —
  // unless that Tier 0 environment set CCE_PAPERCLIP_PROVISION_ENV_OVERRIDE,
  // which `paperclipProvisioned` folds in.
  const paperclipEnabled = paperclipProvisioned(tierId, env);
  const paperclipNote = paperclipEnabled
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
        // The Paperclip line items are INSIDE this figure; say so rather than
        // adding the note, so the number and the prose cannot drift apart.
        const paperclipIncluded = paperclipEnabled ? ', Paperclip work engine included' : '';
        return (
          `~$${Math.round(row.fixedMonthlyUsd)}/mo fixed floor ` +
          `(scripts/cost-estimate.mjs, unit prices as of ${parsed.asOf ?? 'unknown'}` +
          `${paperclipIncluded}) + Bedrock token spend`
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
