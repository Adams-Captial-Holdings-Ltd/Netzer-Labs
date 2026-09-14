---
feature: bedrock-all-models
document_role: index
status: current
observed_at: 2026-09-13
as_of_commit: 271339bc8b2feea85e6c31b115fdd34e757a72e2
implemented_by:
  - src/lib/bedrock/models.ts
  - src/lib/bedrock/client.ts
  - src/agent/agent-loop.ts
  - infra/lib/iam-stack.ts
tested_by:
  - src/lib/bedrock/models-1m.test.ts
  - src/lib/bedrock/fallback-chain.test.ts
  - src/lib/bedrock/guard.test.ts
decisions:
  - docs/adr/0003-bedrock-inference-profiles.md
  - docs/adr/0011-every-bedrock-model-for-agents.md
---

# Bedrock all-models

## 1. Start Here

This index describes the verified implementation snapshot at
`271339bc8b2feea85e6c31b115fdd34e757a72e2`, the head of `origin/development`
when the campaign branch `feature/bedrock-all-models` was cut on 2026-09-13.
It documents what the agents can do **today**, which is use Claude and nothing
else, and points at the approved plan for what they will be able to do. Nothing
in that plan is built yet.

Reading order:

1. This README, for present behaviour and the seams the campaign changes.
2. The [approved plan](plan.md), the only approved work definition: locked
   decisions, design, acceptance criteria AM-01 … AM-39, work items WI-0 … WI-9,
   consent gates and rollback. It is a verbatim copy of the plan approved on
   2026-09-13. It is linked here rather than declared as `approved_work` in the
   frontmatter because the validator reads an `approved_work` target as a task
   backlog (`## <ID>` records with a `yaml` block), which the plan is not.
3. [ADR 0003](../../adr/0003-bedrock-inference-profiles.md), the accepted
   decision that governs routing today, and
   [ADR 0011](../../adr/0011-every-bedrock-model-for-agents.md), the
   **proposed** decision that extends it. ADR 0011 is not accepted until the
   plan's WI-7.
4. The volatile [HANDOFF](HANDOFF.md), then the session logs under
   [`handoffs/`](handoffs/2026-09-13-wi0-setup.md), newest first.

Source code is the ultimate truth for present behaviour. When this page and the
code disagree, the code wins; fix this page.

## 2. What Bedrock all-models does today

Every agent turn on Telegram, Slack and the dashboard already goes through
Bedrock's provider-neutral Converse API, so Bedrock itself is not the limit. Four
things in this repository are, each verified at the commit above:

1. **IAM.** The `BedrockInvoke` statement in
   [`iam-stack.ts`](../../../infra/lib/iam-stack.ts) (lines 135–181) allows
   Claude foundation models in the stack region and six named `us-*`/`eu-*`
   destination regions, Titan embeddings, Nova, and, in `us-east-1` only,
   `openai.gpt-oss-*` and `deepseek.*`. Its own comment says every other
   provider "stays AccessDenied by design" and that the role's inline policy
   budget was full, so the gpt-oss/DeepSeek grant went live as an attached
   customer-managed policy rather than through CDK.
2. **The selectable list.** `listAvailableModels`
   ([`models.ts`](../../../src/lib/bedrock/models.ts) lines 118–133) returns
   only the Claude ids configured in the environment. `PATCH /api/agents/:id`
   ([`handler.ts`](../../../src/adapters/dashboard/handler.ts) lines 1398–1405)
   answers `400 unknown_model` for anything else, and `/model`
   ([`commands.ts`](../../../src/agent/commands.ts) lines 157–207) replies
   `Unknown model` on every chat surface.
3. **A Claude-only request shape.** Anthropic-only `cachePoint` blocks are put
   on the system prompt and after the last tool on every agent call
   ([`client.ts`](../../../src/lib/bedrock/client.ts) lines 236–259 and
   [`agent-loop.ts`](../../../src/agent/agent-loop.ts) lines 1127–1140); the
   comment at `client.ts:60-66` records that non-Anthropic models reject them
   with a `ValidationException`. The first call of a turn streams with the full
   tool list attached (`agent-loop.ts:1008-1023`) and, because the loop passes
   no `maxTokens`, uses the 1024-token default at `client.ts:273`.
4. **Pricing.** `pricingKeyFromId` (`models.ts:67-72`) matches `opus` and
   `sonnet` by regex and bills every other id as Haiku, so the daily cost cap
   mis-meters any non-Claude model.

Also verified in this snapshot: the footer prints `modelId.split('.').pop()`
([`humanize.ts`](../../../src/lib/tools/humanize.ts) line 93), which mangles an
id whose name contains a dot, such as `kimi-k2.5`; the fallback chain
(`client.ts:131-140`) walks a non-Claude primary into Opus → Sonnet → Haiku;
session affinity (`client.ts:144-147`) outlives an explicit model switch; the
forced final answer (`agent-loop.ts:1293-1310`) sends a history that contains
tool blocks with no `toolConfig`; a seat policy's `allowedModels`
([`seat-model.ts`](../../../src/lib/admin/seat-model.ts) line 53) is stored and
edited but read by no turn path; the platform prompt tells every agent it is
"built on top of Anthropic Claude"
([`templates.ts`](../../../src/lib/agents/templates.ts) line 72,
[`agent-loader.ts`](../../../src/lib/config/agent-loader.ts) line 69); and the
per-turn spend reservation is a flat `$0.50` regardless of model
([`ledger-gate.ts`](../../../src/lib/cost/ledger-gate.ts) lines 55 and 106).

It is **not yet** any of the following: there is no live model catalog, no
capability registry, no provider-approval list, no tool allowlist, no seat
model-policy enforcement, no price-scaled reservation, no geography-scoped IAM
policy, no capability probe and no roll-call tool. Those are the plan's work
items WI-1 through WI-6b, and none of them has a line of code on any branch.

## 3. Current status and current source commit

- **Planning approved 2026-09-13.** The owner approved the plan in
  [`plan.md`](plan.md) on 2026-09-13. WI-0 (this folder, ADR 0011 and the plan
  copy) is the only work item started.
- **Snapshot.** `271339bc8b2feea85e6c31b115fdd34e757a72e2` (`271339b`) is the
  head of `origin/development` when the clone was made and the base of
  `feature/bedrock-all-models`. Every claim in section 2 was checked against
  that commit by reading the source in the clone, not copied from the plan.
- **Source evidence only.** Nothing from this campaign is deployed to staging or
  production, no Bedrock call has been made under it, and no roll-call has run.
  Deployment evidence for the finished feature is defined as AM-20 (staging) and
  AM-21 (production) in the plan and does not exist yet.
- **Production differs from this snapshot.** `origin/production` carries
  hotfixes that are not ancestors of `origin/development`, and they change
  `agent-loop.ts`, `handler.ts`, `commands.ts` and `iam-stack.ts` (1,390 lines
  between them); `src/lib/bedrock/` and `humanize.ts` are identical on both
  branches. The line numbers on this page are development's; re-read them after
  the back-merge. The [HANDOFF](HANDOFF.md) names the commits and treats the
  back-merge as the blocker for WI-2 onward.

## 4. Source of truth

| Concern | Authority | Use it for |
|---|---|---|
| Present model selection and pricing | [models.ts](../../../src/lib/bedrock/models.ts) | Which ids are offered, how an id is priced |
| Present request shape, fallback and affinity | [client.ts](../../../src/lib/bedrock/client.ts), [agent-loop.ts](../../../src/agent/agent-loop.ts) | What is actually sent to Bedrock today |
| Present IAM grant | [iam-stack.ts](../../../infra/lib/iam-stack.ts) | Which model ARNs the task role may invoke |
| Accepted routing decision | [ADR 0003](../../adr/0003-bedrock-inference-profiles.md) | Why every Claude id carries the `us.` profile prefix |
| Proposed extension | [ADR 0011](../../adr/0011-every-bedrock-model-for-agents.md) | The decisions the campaign makes durable once accepted |
| Approved work | [plan.md](plan.md) | Locked decisions, design, AM-01 … AM-39, WI-0 … WI-9, consent gates, rollback |
| Volatile state | [HANDOFF](HANDOFF.md) | Branch, blockers, last checks, next action, session index |
| Process rules | [development.md](../../../development.md) and the [feature knowledge framework](../README.md) | Branch mapping, validation commands, documentation contract |

## 5. Implementation map

The seams the campaign changes, as they are today. Line numbers are those of the
snapshot commit on `development`.

| Area | Verified location | Present behavior |
|---|---|---|
| IAM grant | [iam-stack.ts](../../../infra/lib/iam-stack.ts) `:135-181` | One inline `BedrockInvoke` statement: Claude in the stack region and six `us-*`/`eu-*` destination regions, Titan embeddings, Nova, gpt-oss and DeepSeek in `us-east-1`, plus account-scoped inference profiles and guardrails. No other provider. |
| Model list | [models.ts](../../../src/lib/bedrock/models.ts) `:118-133` | `listAvailableModels` reads the `BEDROCK_*_MODEL` env vars, hides a `-1m` id whose family cannot do 1M, and returns nothing else. |
| Pricing | [models.ts](../../../src/lib/bedrock/models.ts) `:67-77` | `pricingKeyFromId` picks a `KNOWN_PRICING` row; any id that is not opus or sonnet is priced as Haiku. |
| Request builder | [client.ts](../../../src/lib/bedrock/client.ts) `:236-273` | `buildParams` adds `cachePoint` blocks unless `disableCache`, drops `temperature` after a rejection, resolves `-1m` to base id plus beta, and defaults `maxTokens` to 1024. |
| Fallback and affinity | [client.ts](../../../src/lib/bedrock/client.ts) `:126-155` | Throttling or unavailability before the first chunk walks Opus → Sonnet → Haiku; a fallen-back session sticks to its fallback model. |
| First call of a turn | [agent-loop.ts](../../../src/agent/agent-loop.ts) `:1008-1023` | `converseStreamTurnWithFallback` with the full tool list attached; the tool loop and the forced synthesis (`:1145-1310`) send `ConverseCommand` directly, each under `assertBedrockAllowed()`. |
| Selection surfaces | [handler.ts](../../../src/adapters/dashboard/handler.ts) `:1398-1405`, [commands.ts](../../../src/agent/commands.ts) `:157-207` | Both validate against `listAvailableModels`; `/model` is the shared command every chat surface runs. |
| Footer | [humanize.ts](../../../src/lib/tools/humanize.ts) `:93` | `modelId.split('.').pop()`, latency, `$cost`, tool count, context. |
| Spend reservation | [ledger-gate.ts](../../../src/lib/cost/ledger-gate.ts) `:55`, `:106` | The worst case is `cost/ledger_reserve_usd` or `$0.50`, independent of the model. |
| Seat policy | [seat-model.ts](../../../src/lib/admin/seat-model.ts) `:53`, [seat-admin.ts](../../../src/adapters/dashboard/seat-admin.ts) | `allowedModels` is created and patched by the admin routes and enforced nowhere. |
| Agent persona | [templates.ts](../../../src/lib/agents/templates.ts) `:72`, [agent-loader.ts](../../../src/lib/config/agent-loader.ts) `:69` | "an AI assistant built on top of Anthropic Claude via Amazon Bedrock". |
| Tests | [models-1m.test.ts](../../../src/lib/bedrock/models-1m.test.ts), [fallback-chain.test.ts](../../../src/lib/bedrock/fallback-chain.test.ts), [guard.test.ts](../../../src/lib/bedrock/guard.test.ts) | `-1m` resolution and hiding; the fallback chain and affinity; and the guard's source scan, which requires a guard call within 45 lines above every Bedrock command construction and at least 10 such sites. No test exercises a non-Claude model. |

## 6. Current business/state rules

- An agent's model must be one of the ids `listAvailableModels` returns; the
  dashboard answers `400 unknown_model` and the `/model` command answers
  `Unknown model "<id>"` otherwise. `/model reset` clears the per-agent model
  and any per-chat override.
- Only Claude ids exist in that list, all on `us.` inference profiles per
  ADR 0003; a `-1m` id is synthetic and resolves to the base id plus the
  `context-1m` beta at the Bedrock boundary.
- Prompt caching is on unless `CCE_PROMPT_CACHE=0`; when on, every agent call
  carries `cachePoint` blocks, which only Anthropic models accept.
- On `ThrottlingException` or `ServiceUnavailableException` before the first
  chunk, the turn falls back down the Opus → Sonnet → Haiku chain and the
  session keeps the fallback model until its affinity is cleared. A failure
  after the first chunk propagates instead.
- A model that rejects `temperature` is remembered for the life of the process
  and never receives it again; every other model gets `0.7`.
- Any id that is not opus or sonnet is priced as Haiku for the token ledger, the
  footer and the cost cap.
- A turn is admitted when the ledger can reserve the flat worst case
  (`cost/ledger_reserve_usd`, default `$0.50`) under the daily cap.
- Seat policies carry `allowedModels`, but no selection or turn path consults
  it; chat-surface turns carry no `dashboardUserId`, so they cannot be tied to
  a seat at all.

## 7. Known runtime risks and approved next work

These are present risks in the snapshot, not fixes claimed by this folder. Every
row is owned by a work item in the
[approved plan](plan.md#work-items-dependency-order).

| Risk | Evidence | Approved next work |
|---|---|---|
| Any non-Claude model is unselectable and, if reached by a direct API call, `AccessDenied` by IAM | `models.ts:118-133`; `iam-stack.ts:135-181` and its "AccessDenied by design" comment | WI-1 (catalog, capability registry, pricing), WI-2 (selection surfaces), WI-5 (IAM managed policy) |
| A non-Anthropic model would reject the Claude request shape | `cachePoint` at `client.ts:236-259` and `agent-loop.ts:1127-1140`; comment at `client.ts:60-66` | WI-3 (one request builder, no streaming tool use, self-heal) |
| The cost cap mis-meters unknown ids as Haiku and reserves a flat $0.50 | `models.ts:67-72`; `ledger-gate.ts:55` | WI-1 (per-model prices with a source), WI-2c (price-scaled reservation, AI-spend detector) |
| Seat `allowedModels` is never enforced | `seat-model.ts:53`; no reader outside `seat-admin.ts` | WI-2b (pre-admission model gate, default seat policy, escape hatch) |
| Footer and persona are Claude-specific | `humanize.ts:93`; `templates.ts:72`, `agent-loader.ts:69` | WI-4 (display parity, model-neutral persona) |
| A non-Claude primary falls back into Claude; affinity overrides a switch | `client.ts:131-147` | WI-3 (chain is `[primary]`; affinity only after a real fallback) |
| Forced synthesis sends tool blocks without `toolConfig` | `agent-loop.ts:1293-1310` | WI-3 (synthesis fix with its own test) |
| Per-model Converse capabilities are undocumented | Plan, "Verified AWS facts": the per-model feature table is gone | WI-6b (capability probe, consent-gated), WI-6 (roll-call tool), WI-8 and WI-9 (N/N on staging, then production) |
| Production carries hotfixes that development lacks in exactly these files | [HANDOFF](HANDOFF.md) blockers | Back-merge before WI-2's SPECIFICATION; only WI-0 and WI-1 may start first |

## 8. Exact focused and full validation commands

Focused checks for this folder and the seams above:

```powershell
node scripts/ci/feature-knowledge.mjs
node scripts/ci/docs-links.mjs
npx vitest run src/lib/bedrock
```

`infra/lib/iam-stack.test.ts` does not exist at the snapshot commit; WI-5 writes
it red first, and only then does `npx vitest run infra/lib/iam-stack.test.ts`
become a focused check.

Full repository validation before any push, exactly as
[`development.md`](../../../development.md) lists it:

```powershell
npm run typecheck
npm test
npm run build
npm --prefix web run typecheck
npm --prefix web run build
npm run local:test:integration
node scripts/ci/docs-links.mjs
node scripts/ci/feature-knowledge.mjs
git diff --check
```

The baseline for this branch (`npm test` and `npm run typecheck` on the
untouched clone) had not been captured when this page was written; the
[HANDOFF](HANDOFF.md) records who owes it. A command that did not run is not a
passing result. Never run the plan's capability probe or roll-call, or anything
under [dangerous commands](../../../development.md#dangerous-commands-never-run-locally),
without the owner's explicit consent: they spend money or touch a live
environment.

## 9. Related documents

- [Approved plan, verbatim copy of 2026-09-13](plan.md)
- [Operational HANDOFF](HANDOFF.md)
- [Session handoff: WI-0 setup, 2026-09-13](handoffs/2026-09-13-wi0-setup.md)
- [ADR 0003 — Cross-region Bedrock inference profiles](../../adr/0003-bedrock-inference-profiles.md)
- [ADR 0011 — Every Converse-capable Bedrock model for agents](../../adr/0011-every-bedrock-model-for-agents.md) (proposed)
- [Feature knowledge framework](../README.md), the specification this document conforms to
- [Session handoff template](../HANDOFF-TEMPLATE.md)
- [Documentation index](../../README.md)
- [Repository development guidance](../../../development.md)
- [Repository agent guidance](../../../AGENTS.md)
- [Chat surface parity rule](../../../CLAUDE.md), which the plan's "Surface parity" section implements
