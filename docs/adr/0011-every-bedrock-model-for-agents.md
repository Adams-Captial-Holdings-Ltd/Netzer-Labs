# ADR 0011 — Every Converse-capable Bedrock model for agents

**Status:** Proposed (2026-09-13). Extends [ADR 0003](0003-bedrock-inference-profiles.md); becomes Accepted in the campaign's WI-7, once the implementation and the full validation are in. The staging roll-call (WI-8) and the production roll-call (WI-9) are its live proof.

## Context

ADR 0003 fixed a Claude-only model set on `us.` inference profiles: `BEDROCK_MODELS` in `constants.ts`, the env-driven `listAvailableModels` in [`models.ts`](../../src/lib/bedrock/models.ts), and one inline `BedrockInvoke` statement in [`iam-stack.ts`](../../infra/lib/iam-stack.ts) naming Claude, Titan embeddings, Nova and, for the Model Playground only, gpt-oss and DeepSeek in `us-east-1`. Every agent turn already uses Bedrock's provider-neutral Converse API, so the limits are ours: that IAM grant (the role's inline policy budget is full, and the Playground grant went live as an out-of-band customer-managed policy), the selectable list, a Claude-only request shape (Anthropic `cachePoint` blocks on every call), and pricing that bills any unknown id as Haiku.

AWS's catalog lists about 86 Converse-capable text models. The owner wants every one of them selectable for any agent on every surface, from providers they have approved, subject to seat policy, proven by a live N/N roll-call on staging and then production. Two facts shape the design: staging and production share one AWS account, so the first Marketplace invoke of a third-party model binds both; and AWS no longer publishes a per-model Converse feature table, so tool and streaming support must be measured. The [approved plan](../features/bedrock-all-models/plan.md) carries the design, acceptance criteria and work items; the [feature README](../features/bedrock-all-models/README.md) carries present behaviour.

## Decision

- **Converse-capable Bedrock text models, discovered live.** `ListFoundationModels` (TEXT, ACTIVE) plus system-defined `ListInferenceProfiles`, cached six hours, single-flight, never throwing; env Claude entries stay first and unchanged; every exclusion carries a reason.
- **Same-geography routing, plus an IAM Deny on global routing.** In-region first, then the profile derived from the stack region (`us-*` → `us.`, `eu-*` → `eu.`, `ap-*` → `apac.`; any other region stays in-region only). Global-only models are excluded, and `bedrock:InvokeModel*` is denied where `aws:RequestedRegion` is `unspecified`.
- **The `models/approved_providers` gate, with Marketplace terms approved before first use.** Runtime-config holds canonical id prefixes; absent means today's reachable set (`anthropic.`, `amazon.`, `openai.gpt-oss`, `deepseek.`). The owner approves each further provider, with its terms, before any live call; the list gates the catalog, selection, turn time, the Playground and Knowledge test, the probe and the roll-call.
- **The `models/tools_allowed` allowlist.** Id prefixes; absent means every tool-capable model. A model outside it gets no `toolConfig`, answers without tools and says so in-band.
- **Seat model-policy enforcement, plus a default policy.** `allowedModels` is enforced on selection and on every turn that can be tied to a seat; `seats/default_policy_id` covers dashboard users with no seat; ids match canonically (geo prefix and `-1m` stripped); a denial sends zero Bedrock requests and writes a `denied` SeatUsage row. `seats/enforce_model_policy = '0'` is the escape hatch. Chat surfaces have no chat-identity→seat mapping, so only the provider gate applies there, with a call-site comment in both adapters.
- **No cross-provider fallback.** A non-Claude primary's chain is `[primary]`; session affinity applies only after a real fallback from that primary.
- **Guardrails fail closed.** The configured guardrail is always attached; a model that cannot take one is excluded.
- **A price-scaled spend reservation.** The floor (`cost/ledger_reserve_usd`, default $0.50) times the model's blended price over Sonnet's, never below the floor and never above the daily cap; every non-Claude price carries a source URL, and an unknown id is priced at $25/$80 per 1M tokens.
- **An unconditional CDK managed policy without a fixed name.** A `ManagedPolicy` attached to the task role with no `managedPolicyName`, because the account is shared with staging. It allows `InvokeModel`, `InvokeModelWithResponseStream`, `Converse` and `ConverseStream` on in-region foundation models, on foundation models reached through a `${geo}.*` profile, on those profiles and on `project/default`, plus `GetFoundationModelAvailability`. No `bedrock:*`, no region-less ARN.
- **Non-Converse models deferred to phase 2.** Claude Mythos 5 and Mythos Preview, GPT-5.5, GPT-5.4, both Daybreak models and Grok 4.3 need a Messages/Responses path and stay excluded as `non-converse` until it exists.

## Consequences

Good:

- Any approved Converse text model becomes selectable through the same `/model`, `GET /models` and `PATCH /agents/:id` paths on every surface, with the same footer and in-band notes, and the roll-call proves each one completes a real turn and, where capable, a tool call.
- Provider approval, the tool allowlist, seat policy and the Claude-only rollback (`models/non_anthropic_enabled = '0'`) are runtime-config: seconds to take effect, no deploy.
- The IAM policy is additive and inert without the app change, so it need not be rolled back with the feature.

Bad:

- Non-Anthropic models get no prompt cache on Converse, so the full prompt is billed every round; a "cheaper" model can cost more per turn. Prices in the pickers and the scaled reservation mitigate this; they do not remove it.
- One shared account means a staging probe subscribes production to the same Marketplace terms and shares its quotas; the staging roll-call runs off-peak, one model at a time, and quota increases are support requests only the owner can file.
- Agent prompts are tuned for Claude. The roll-call proves a model *runs*, not that it does the job well; quality is a later phase, and the platform prompt becomes model-neutral so non-Claude agents stop claiming to be Claude.
- Capabilities are undocumented, so they are measured by a consent-gated probe before merge and by self-heal at runtime; a model that appears later may cost one failed request before it is remembered.
- ADR 0003's per-region ARN list gives way to geography-derived resources: an EU customer-hosted stack gets `eu.` routing without a code change, but a region outside `us-*`, `eu-*` and `ap-*` gets in-region only.

## Alternatives considered

- **A static model list** (extend `BEDROCK_MODELS` and the env vars by hand). Rejected: the catalog changes monthly, AWS publishes no single feature table any more, and a hand-kept list repeats the Haiku-pricing and AccessDenied-by-design failures for every new model.
- **Global routing** (region-less `global.` profiles). Rejected: it lets a request leave the deployment's geography, which an EU customer-hosted stack and the AWS BAA review the plan names as risk 9 both assume never happens; an explicit IAM Deny makes the exclusion enforceable rather than conventional.
- **Direct OpenAI and Gemini APIs.** Rejected for this phase: new credentials, a second billing path and a second request shape, none of which the Converse work needs. Filed as a later phase alongside the Messages/Responses path.
- **Out-of-band IAM** (a customer-managed policy attached by CLI, as the gpt-oss/DeepSeek grant was). Rejected: `cdk diff` cannot see it, the next full deploy drifts from it, and the repository already carries exactly that drift. A CDK managed policy without a fixed name keeps source and account in sync and survives the shared account.
