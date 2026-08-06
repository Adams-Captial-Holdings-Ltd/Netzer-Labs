# ADR 0001 — T0–T3 tier framework

**Status:** Accepted (2026-04, v3 ship)

## Context

The original v1 deploy had every feature on by default: WAF, X-Ray, daily DDB exports, CloudFront, 365-day log retention, multi-AZ NAT. Fine for a real production deploy but ~$700/month before any traffic — wildly disproportionate for a hobby fork or a staging environment.

We wanted to:
- Ship a "Hobby" config someone could try for under $20/month
- Ship a real Enterprise config without compromising on safety primitives
- Avoid forking the codebase into "hobby" and "enterprise" branches

## Decision

A single `DeployTier = 0 | 1 | 2 | 3` shape, evaluated at `cdk synth` time from `CCE_TIER` env var. Every "expensive or optional" infra construct gates on `tier.<flag>`. The resulting tiers:

- **T0 Hobby** — single Fargate, single NAT, 7-day logs, no WAF/CloudFront/X-Ray/Flow Logs. ~$5/month idle.
- **T1 Standard** — 2× Fargate, 2 NAT (HA), 30-day logs, Flow Logs on. ~$140/month.
- **T2 Pro** — autoscaling 2–10 tasks, 90-day logs, WAF, X-Ray. ~$300/month.
- **T3 Enterprise** — T2 + CloudFront edge + ALB origin gate + 365-day logs + GuardDuty + (when shipped) AWS Config. ~$500–800/month.

The tier table lives in `infra/lib/constants.ts` (`TIERS: Record<DeployTier, TierShape>`).

## Consequences

Good:
- One codebase, four environments. Same CDK synth code; tier flag flips features.
- Cost prediction is deterministic: "what does T2 cost?" → look at the table.
- Upgrade path is a single env var change + redeploy. No manual surgery between tiers.
- Staging can deploy at T1 alongside prod at T3 in the same account (combined with the `CCE_NAME_SUFFIX` work from A3).

Bad:
- Every "if (tier.X)" branch in CDK is a code path that synth might exercise rarely. We've shipped bugs in T0 paths that prod (T3) never sees. Mitigation: `cdk synth` for every tier in CI.
- Adding a new feature now requires deciding which tier(s) get it. Lazy default: "T2+", which means hobby users miss out.
- The tier table has to stay coherent; can't have `T2.fargateMaxTasks < T1.fargateMaxTasks` (the existing test `constants.test.ts` enforces monotonicity).

## Alternatives considered

- **Separate repos per tier**: too much drift; bug fixes would have to be back-ported.
- **Flag every individual setting**: more flexible, but explodes into hundreds of orthogonal env vars; users get analysis paralysis at setup time.
- **Use AWS CDK Aspects to apply tier-specific transforms**: clean but harder to read than `if (tier.xrayEnabled) { ... }`. We prefer obviousness over elegance for infra code.
