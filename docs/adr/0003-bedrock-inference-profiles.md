# ADR 0003 — Cross-region Bedrock inference profiles

**Status:** Accepted (2026-04, v3 ship)

## Context

Bedrock model IDs come in two shapes:

- Direct: `anthropic.claude-sonnet-4-6` — bound to a single region; if the region throttles, every request fails until backoff
- Inference profile: `us.anthropic.claude-sonnet-4-6` — Bedrock fans the request out to the best-available destination region (us-east-1, us-east-2, us-west-2). Higher resilience to per-region throttling.

We saw throttle bursts in early dev where a single region hit its per-minute quota. The fan-out absorbs them without operator action.

## Decision

Every Claude model reference in the codebase uses the `us.` inference-profile prefix. IAM permissions in `iam-stack.ts` grant `bedrock:InvokeModel` on foundation-model ARNs in ALL THREE destination regions, not just `us-east-1`. Missing the cross-region grant breaks the fan-out silently on first invocation in a new destination region.

Canonical IDs live in `BEDROCK_MODELS` in `constants.ts`:

```ts
export const BEDROCK_MODELS = {
  opus: 'us.anthropic.claude-opus-4-7',
  opus1m: 'us.anthropic.claude-opus-4-7-1m',
  sonnet: 'us.anthropic.claude-sonnet-4-6',
  sonnet1m: 'us.anthropic.claude-sonnet-4-6-1m',
  haiku: 'us.anthropic.claude-haiku-4-5',
  embedTitanV2: 'amazon.titan-embed-text-v2:0',
} as const;
```

The orchestrator reads each model ID from env vars set by `compute-stack` at deploy time. When env is empty (e.g. CI deploys), `compute-stack` falls back to `BEDROCK_MODELS` constants. (This fallback was added 2026-05-20 after a CI deploy regression — see ADR 0006 if/when written.)

## Consequences

Good:
- A single region's throttle no longer fails turns. p95 latency tightens, fewer Bedrock retries.
- We don't have to think about which region a request will land in — Bedrock picks.
- The canonical ID set is in one place (`BEDROCK_MODELS`) so adding a region or rotating to a new model version is a single-line change.

Bad:
- IAM grants are broader: every Claude region's foundation-model ARN. If AWS adds a region we don't list, requests routed there fail. Mitigation: re-check the inference-profile destination list quarterly.
- Marketplace permissions (`aws-marketplace:Subscribe` and friends) are required so Bedrock can auto-subscribe to the foundation model on first call in each region. We grant `*` resource which is broader than ideal; AWS doesn't expose a tighter scope.
- Latency floor is the slowest-of-the-destinations. Usually a wash; occasionally a US-east-1 → US-west-2 fan-out adds 100ms.

## Alternatives considered

- **Single-region**: simpler IAM, predictable latency. Loses the throttle absorption. We tried this in v1 and saw throttle errors at low traffic; not viable.
- **App-level fallback** (try us-east-1, on 429 fall back to us-west-2): same effect but in our code. Bedrock's inference profile does this server-side; we'd be reinventing it and worse.
- **Provisioned throughput**: dedicated capacity, eliminates throttling entirely. ~$3/hour per model. Worth it at sustained high load; overkill at our current ~$1/day Bedrock spend.
