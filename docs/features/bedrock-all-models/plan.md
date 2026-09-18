---
feature: bedrock-all-models
document_role: backlog
status: accepted
observed_at: 2026-09-13
as_of_commit: 271339bc8b2feea85e6c31b115fdd34e757a72e2
---

> **Approved plan, 2026-09-13.** This is the campaign plan the owner approved on 2026-09-13, copied here verbatim during WI-0 so the work definition survives outside any chat session; it is linked from the [feature README](README.md) rather than declared as `approved_work`, because it is not written in the validator's task-record form.
> The canonical working copy lives outside the repository at `C:\Users\EmmanuelAdams\.claude\plans\ok-i-need-a-ancient-codd.md`; if the two ever differ, that file wins and this copy is refreshed in the same session that changes it.

# Gauntlet plan: agents on every Bedrock model, in production

## Context

Production agents on Telegram, Slack and the dashboard can only use Claude. Every agent turn already goes
through Bedrock's provider-neutral **Converse** API, so Bedrock is not the limit. These four things are:

1. **IAM.** `infra/lib/iam-stack.ts:135-181` allows Claude, Titan embeddings, Nova, and gpt-oss/DeepSeek
   in us-east-1 only. Llama, Mistral, Qwen, Kimi and the rest are AccessDenied "by design", and the role's
   inline policy budget is full.
2. **The selectable list.** `listAvailableModels` (`src/lib/bedrock/models.ts:118-133`) returns only the
   env Claude ids. `/api/models`, `PATCH /agents/:id` (`handler.ts:1391-1402`) and `/model`
   (`commands.ts:157-207`) all check against it.
3. **Claude-only request shape.** Anthropic-only `cachePoint` blocks go on every call (`client.ts:236-259`,
   `agent-loop.ts:1127-1140`), and non-Anthropic models reject them (client.ts:61-63). The first call also
   streams with tools attached.
4. **Pricing.** Unknown ids are billed as Haiku (models.ts:67-72), so the cost cap mis-meters.

Also verified in code (line numbers are development's as of 2026-09-10; `agent-loop.ts`, `handler.ts`,
`commands.ts` and `iam-stack.ts` differ on production, so re-read spans after the back-merge):
- The footer mangles dotted ids (`humanize.ts:93`).
- A non-Claude primary falls back into Claude (client.ts:131-140).
- Session affinity overrides explicit model switches (client.ts:144-147).
- The forced final answer sends tool blocks with no toolConfig (agent-loop.ts:1293-1310).
- Seat `allowedModels` is never enforced.
- Every agent is told it is "built on top of Anthropic Claude" (`templates.ts:72`, `agent-loader.ts:69`).
- The per-turn spend reservation is a flat $0.50 regardless of model (`ledger-gate.ts:55`).

**Outcome:** every Converse-capable text model Bedrock serves this account through the deployment's own
geography can be selected for any agent on every surface, from providers you have approved, subject to
seat policy, and completes real turns in production. A live N/N roll-call proves it.
- Claude coordinates and writes the specifications.
- Codex **gpt-5.6-sol (effort high)** builds each frozen work order through `/codex-build`.
- Claude **Opus 5** evaluates.

## Locked decisions (user, 2026-09-10)

| Topic | Decision |
|---|---|
| Bar | **Live N/N roll-call**, on staging and then production. Every model in the live catalog completes a real turn through `POST /api/test-turn`, running as the task role. Tool-capable models also complete a tool call. `modelId` equals the requested id. Zero AccessDenied or ValidationException. |
| Scope | Every Converse-capable Bedrock text model. AWS's catalog lists about 86; discovery sets the live count. Direct OpenAI and Gemini APIs are a later phase. |
| Non-Converse | Claude Mythos 5, Mythos Preview, GPT-5.5, GPT-5.4, both Daybreak models and Grok 4.3 are excluded (`non-converse`). **Phase 2** adds a Messages/Responses path. |
| Routing | **Same geography only.** In-region first, then the geo profile derived from the stack region: `us.` for production (us-east-1), `eu.` for an EU customer-hosted stack. An IAM Deny blocks global routing. Global-only models are excluded (`no-geo-path`). |
| Provider approval | **Approve providers first.** Runtime-config `models/approved_providers` holds canonical id prefixes.<br>• Absent means today's reachable set: `anthropic.`, `amazon.`, `openai.gpt-oss`, `deepseek.`.<br>• Before any live call, you get every other provider with a link to its terms, and approve which ones to use.<br>• The list gates the catalog, selection, turn time, the Playground and Knowledge test, the probe and the roll-call. |
| Tool risk | Runtime-config `models/tools_allowed` holds id prefixes. **Absent means every tool-capable model.** Models outside the list answer without tools and say so. |
| Seats | Enforce `allowedModels` on selection and on every turn that can be tied to a seat. Runtime-config `seats/default_policy_id` applies to dashboard users with no seat; absent means unrestricted. |
| Cost | A price-scaled reservation, a fixed AI-spend detector, and prices shown in the model pickers. |
| Builder / evaluator | Codex gpt-5.6-sol at high effort, explicitly opted in. Evaluation by Claude Opus 5: the coordinator's diff inspection, then a fresh VERIFICATION session on Opus (select **Opus 5** in the app for those sessions), plus `runner inspect --model claude-opus-5`. |
| Ship path | `feature/bedrock-all-models` from `development` → qa → staging (deploys automatically; roll-call) → production (manual `deploy.yml` dispatch). IAM is a new CDK managed policy. |
| Workspace | A normal clone at `C:\dev\_netzer-allmodels`, not a linked worktree. That avoids the Vitest linked-worktree trap (handoff ledger M6), and matches the two other live campaigns. |

## Verified AWS facts (fetched 2026-09-10)

- **API compatibility** ([page](https://docs.aws.amazon.com/bedrock/latest/userguide/models-api-compatibility.html),
  122 rows): every text-chat model supports Converse except the seven listed above. The other non-Converse
  rows are embedding, image, speech, video or rerank models.
- **No feature table.** The per-model Converse feature table now redirects to "Models at a glance". Tool,
  streaming-tool and system support are undocumented in one place, which is why the probe and roll-call
  measure them.
- **GPT-5.6 Sol**
  ([card](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-56-sol.html)): Converse
  works, but only through a profile in us-east-1. Guardrails work through Converse only. Caching is
  Responses API only. It needs `project/default`. $4.40 / $22.00 per 1M tokens.
- **Model cards carry prices and EULA links.** WI-1 prices every catalog model from its card, one URL per
  row. The provider approval list links each provider's terms from the same cards.
- **Global routing** needs the region-less ARN; a Deny on `aws:RequestedRegion = "unspecified"` blocks it
  ([prereqs](https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles-prereq.html)).
- **Marketplace.** The first invoke of a third-party model subscribes the account on AWS Marketplace and
  accepts that provider's terms. Staging and production share one account (`deploy.yml:49`).

## Design

1. **Catalog.** `src/lib/bedrock/catalog.ts`, `getModelCatalog()`.
   - Discovery: ListFoundationModels (TEXT, ACTIVE) plus SYSTEM_DEFINED ListInferenceProfiles, paginated.
   - Invocation id: in-region, then the stack-geography profile.
   - Exclusion reasons: `non-converse`, `not-active`, `not-text`, `no-geo-path`, `guardrail-unsupported`,
     `provider-not-approved`.
   - Cache: 6 h, single-flight, keeps the last good result. On failure it returns env Claude only and never
     throws. It makes no control-plane calls when `AWS_ENDPOINT_URL` is set.
   - `listAvailableModels` stays unchanged, so Jarvis keeps its list.
   - The Playground and Knowledge-test lists are filtered by `approved_providers`.
   - `models/non_anthropic_enabled = '0'` is a Claude-only rollback.
2. **Capability registry.** `capabilities.ts`, `resolveCapabilities(id)`: longest-prefix match on the
   canonical id.
   - Fields: tools, streamingTools, system, images, documents, promptCache, guardrails, maxOutputTokens,
     contextWindow, price (with a source URL).
   - Seeds come from the model cards plus the capability probe (WI-6b).
   - Unknown models default to: tools `'unknown'` (non-streaming, self-heals), no cache, no documents,
     4096 max output, $25/$80 per 1M.
3. **One request builder.** `request-builder.ts`, `buildConverseRequest({kind})`. `buildParams` delegates to
   it. The inline agent-loop sends stay directly under `assertBedrockAllowed()` (guard.test.ts looks back 45
   lines and needs at least 10 send sites). Tools are attached only when the registry says the model is
   tool-capable **and** `models/tools_allowed` permits it.
4. **No streaming tool use.** Go straight to the non-streaming loop, with one final edit or chunk. If AWS
   rejects streaming tool use, retry once and remember it.
5. **No tools** (unsupported, or not on the allowlist). Send no toolConfig, flatten tool blocks to text, and
   add an in-band note naming the reason. The note is stripped from later history.
6. **Guardrails fail closed.** Always attach the configured guardrail; models that can't take one are
   excluded.
7. **Reasoning and limits.**
   - Anthropic content is echoed unmodified; non-Anthropic `reasoningContent` is stripped.
   - maxTokens: keep the base branch's own budgets (after the back-merge, production's `TURN_MAX_TOKENS`),
     clamped per model to `maxOutputTokens`. The builder reads them from the code rather than choosing new
     values, because the deliverables campaign is tuning them.
   - Attachments are gated by capability, and `fitHistory` trims history to the context window.
8. **Pricing.** Registry prices carry a source; Anthropic prices are unchanged; unknown ids get $25/$80
   (a single source). `family` is widened and `provider`/`priceSource` added. The footer shows `~$` when
   the price is estimated. `GET /models` returns prices, and the pickers show them.
9. **No cross-provider fallback.** A non-Claude primary's chain is `[primary]`. Affinity applies only when the
   primary equals the model that fell back.
10. **IAM.** An unconditional CDK `ManagedPolicy` attached to `taskRole`, with no `managedPolicyName` (one
    account, so CDK names it).
    - Allow InvokeModel, InvokeModelWithResponseStream, Converse and ConverseStream on:
      - `arn:aws:bedrock:${region}::foundation-model/*`;
      - `arn:aws:bedrock:*::foundation-model/*`, conditioned on `bedrock:InferenceProfileArn` =
        `…:inference-profile/${geo}.*`;
      - `…:inference-profile/${geo}.*`;
      - `…:project/default`.
    - `${geo}` is derived from the stack region: `us-*` → `us`, `eu-*` → `eu`, `ap-*` → `apac`. Any other
      region gets in-region only.
    - Deny `bedrock:InvokeModel*` where `aws:RequestedRegion = "unspecified"`.
    - Plus `GetFoundationModelAvailability`.
    - No `bedrock:*`.
11. **Pre-admission model gate** (WI-2b). The model that will run is checked before admission and before any
    Bedrock call.
    - Its provider must be approved.
    - A seated dashboard principal's policy must allow it. The policy is the seat's, or else
      `seats/default_policy_id` for users with no seat. Principals with no `userId` (the root and API
      tokens) are unrestricted.
    - Empty `allowedModels` denies all. Ids are compared canonically (geo prefix and `-1m` stripped).
    - A denial sends zero Bedrock requests, returns a clear message, and writes a `SeatUsage` `denied` row
      with `denialReason` plus an audit entry.
    - Disallowed fallback candidates are skipped.
    - `GET /models` marks `allowedForSeat`, and a disallowed override gets 403 before the turn.
    - Seat policy create/patch validates ids against the catalog, and the Seats page gets a catalog picker.
    - `seats/enforce_model_policy = '0'` is the escape hatch.
    - Telegram and Slack have no chat-identity→seat mapping (`agent-loop.ts:167-171`). The provider gate
      applies there; seat policy does not. That is a documented gap with a call-site comment in both
      adapters.
12. **Cost controls** (WI-2c).
    - **(a) Reservation.** `admitTurnSpend` takes a model-aware worst case: the floor
      (`cost/ledger_reserve_usd` or $0.50) × (the model's blended price ÷ Sonnet's), never below the floor,
      never above the daily cap. Sonnet-priced and cheaper models reserve exactly what they do today.
    - **(b) AI-spend detector.** First read the real Cost Explorer SERVICE names for Marketplace-billed
      Bedrock models (read-only, consent-gated). Then make `aiSpendLast30d`
      (`infra/lib/power-switch-handler/index.js:572-591`) count them, with the matcher extracted into a pure,
      unit-tested function. If the names already match, record the evidence and change nothing.
13. **Honest identity.** The platform prompt becomes model-neutral ("an AI assistant running on Amazon
    Bedrock"), so non-Claude agents don't claim to be Claude.
14. **Pinned-model health.** `GET /models/catalog-status` also lists agents whose model is no longer in the
    catalog (retired, or its provider revoked).
15. **Capability probe** (WI-6b). `scripts/rollcall/capability-probe.ts` uses the new request builder with
    **your** AWS login from your machine, before any merge.
    - It runs against approved providers only and needs `--yes`.
    - It measures tools, streaming tools, system prompt, cachePoint rejection, guardrail and reasoning echo
      per model.
    - It writes evidence, and Claude promotes the measured facts into registry seeds.
16. **Roll-call.** `scripts/rollcall/models-rollcall.ts`.
    - Per model, one at a time: a plain turn plus a tool turn through `/api/test-turn`, on a minimal
      `rollcall` agent, plus a pass on `main` with its real tools. Approved providers only.
    - Asserts 200, a matching `modelId`, non-empty text, `costUsd > 0`, no AccessDenied or
      ValidationException, and at least one tool call on tool turns.
    - Needs `--yes`, `--max-usd` and `--production`, plus a cap-headroom check.
    - Uses the root token (no seat). Evidence goes to `docs/features/bedrock-all-models/evidence/`.

**N accounting:** N is the whole live catalog, with exclusions listed as reasons. Counted as a **FAIL**,
never an exclusion: not authorized or not entitled, answered by another model, or refused by a gate on the
roll-call token.

## Acceptance criteria

- **AM-01 Catalog.** Exactly the ACTIVE, TEXT, Converse-capable, geo-invocable, approved models, with the
  right invocation id, deduplicated and paginated. Env Claude entries come first and are unchanged.
  Exclusions carry reasons.
- **AM-02 Catalog failure modes.** A discovery error gives `env-fallback` and never throws. With
  `AWS_ENDPOINT_URL` set, zero control-plane calls. Flag `'0'` means Claude only.
- **AM-03 `GET /models`.** Keeps its shape, `defaultModelId`, and `''` meaning agent default. Claude entries
  deep-equal the old output. New fields are optional.
- **AM-04 Selection.** PATCH, create, `/model` and explicit overrides reject non-catalog ids. `/model gpt-5`
  is still rejected. `/model list <provider>` replies in ≤ 4000 characters.
- **AM-05 Capability defaults.** Seeds and unknown-model defaults exactly as documented.
- **AM-06 Request shapes.** Claude first and loop requests deep-equal goldens captured on the post-back-merge
  base before the refactor.
  Non-Anthropic requests have no cachePoint, `maxTokens ≤ maxOutputTokens`, a guardrail when configured, no
  toolConfig when tools are off, and no unsupported attachments.
- **AM-07 No streaming tool use.** With tools, zero ConverseStream sends, one `onChunk`, and tool events still
  fire.
- **AM-08 Self-heal.** Each heal retries once, remembers, and adds the note.
- **AM-09 Reasoning echo.** No non-Anthropic `reasoningContent` in echoes; Anthropic echoes byte-identical.
- **AM-10 Synthesis and dispatch.** The synthesis request has no tool blocks. A toolUse block with
  `end_turn` is still dispatched.
- **AM-11 History.** Fits the window, alternates correctly, notes stripped.
- **AM-12 Guardrails.** Fail-closed guardrail behaviour is tested.
- **AM-13 Pricing.** Unknown id → $25/$80; new Claude names never become Haiku; existing Claude costs and
  `models-1m.test.ts` unchanged; every non-Claude row has a source URL.
- **AM-14 Footer.** `kimi-k2.5` renders correctly and Claude is unchanged; `~$` when estimated.
- **AM-15 Fallback and affinity.** Non-Claude chain is `[primary]`; affinity ignored after a primary change.
- **AM-16 Jarvis.** `jarvis.flow.test.ts` passes untouched; `listAvailableModels` unchanged.
- **AM-17 IAM synth.** Synth for us-east-1, for both suffixes, yields exactly the policy in decision 10: no
  name, `us.*` condition, Deny, `project/default`, no `bedrock:*` or region-less ARN, grade A. No `global.`
  ids in constants.
- **AM-18 Guard test.** Green, and fails on a planted unguarded send.
- **AM-19 Roll-call library.** Tests pass; refuses without `--yes` or without cap headroom.
- **AM-20 Staging.** N/N, Logs Insights clean, evidence committed.
- **AM-21 Production.** N/N after the manual deploy.
- **AM-22 Full validation.** All 9 `development.md` commands actually run and pass.
- **AM-23 Docs.** ADR 0011, the feature folder and the out-of-band note done; docs CI green.
- **AM-24 Seat denial.** Zero sends, a clear message, a `denied` SeatUsage row, and an audit row.
- **AM-25 Unaffected paths.** Principals without a seat or policy, and Telegram/Slack seat handling, are
  unchanged; both adapters carry the gap comment.
- **AM-26 Seat selection.** `allowedForSeat` marked; a disallowed override gets 403 before any turn work;
  pickers disable disallowed models.
- **AM-27 Canonical matching.** `us.`, bare and `-1m` ids match one entry; empty means deny all.
- **AM-28 Policy admin.** Create/patch reject non-catalog ids; the Seats picker lists the catalog.
- **AM-29 Seat escape hatch.** `seats/enforce_model_policy = '0'` disables enforcement; absent enforces.
- **AM-30 Provider approval.**
  - Unapproved providers are excluded (`provider-not-approved`), rejected at selection, and refused at turn
    time with zero sends, on all surfaces.
  - They are filtered from the Playground and Knowledge test.
  - The default list is exactly `anthropic.`, `amazon.`, `openai.gpt-oss`, `deepseek.`.
  - The probe and roll-call refuse unapproved providers.
- **AM-31 Tool allowlist.** Models outside `models/tools_allowed` get no toolConfig and the note; absent
  means every tool-capable model.
- **AM-32 Default seat policy.** `seats/default_policy_id` applies to unseated dashboard users; absent means
  unrestricted; root and API tokens are unaffected.
- **AM-33 Reservation.**
  - Sonnet-priced and cheaper models reserve exactly the floor, as today.
  - Pricier models reserve floor × price ratio, capped at the daily cap.
  - Concurrency tests show no cap overshoot.
- **AM-34 AI-spend detector.** Counts every Bedrock-model service name in a fixture captured from the account
  (Marketplace included), and the old names still count.
- **AM-35 Prices in pickers.** `GET /models` carries price in/out plus its source; the pickers show it, or
  "price estimated".
- **AM-36 Honest identity.** No platform prompt claims Anthropic Claude.
- **AM-37 Geography.** The geo prefix is derived from the stack region in both IAM and discovery; unknown
  regions get in-region only.
- **AM-38 Pinned-model health.** `catalog-status` lists agents whose model left the catalog.
- **AM-39 Capability probe.** Approved providers only, `--yes` required; measured facts committed as
  evidence and seeds.

## Work items (dependency order)

Each code WI runs the full cycle, **one fresh session per phase**:
1. SPECIFICATION (Claude writes failing tests, commits locally, freezes the work order).
2. IMPLEMENTATION (Codex builds; Claude inspects the diff and reruns the proof).
3. CLEANUP (Claude, `/refactor`).
4. VERIFICATION (Opus).

**Preconditions (re-checked 2026-09-13):**
- **Back-merge production's hotfixes into `development` first.** `1abba67`, `d828124`, `1124118`, `8c14b3f`
  and `hotfix/empty-turn-poisoning` are on `origin/production` but not on `origin/development`.
  - `src/lib/bedrock/` and `humanize.ts` are identical on both branches; `agent-loop.ts`, `handler.ts`,
    `commands.ts` and `iam-stack.ts` are not.
  - Production's agent loop sends `TURN_MAX_TOKENS` on the first call, the tool loop and the synthesis call.
    Development still sends 1024 on the first call.
  - **WI-0 and WI-1 can start now.** Every other code WI starts only once all five are ancestors of
    `origin/development` (`git merge-base --is-ancestor <sha> origin/development`). Rebase first.
  - A back-merge task was started separately on 2026-09-10. If it still hasn't landed when WI-2's
    SPECIFICATION opens, stop and ask whether this campaign should raise that PR itself.
- **Deliverables campaign** (`~/.claude/plans/claude-bedrock-deliverables-wobbly-heron.md`, clone
  `C:\dev\_netzer-diag`, branch `chore/deliverables-parity`). Its W1 ablates output budgets, and later rounds
  may change temperature, thinking and the prompt on the same agent-loop call sites. Whichever lands second
  rebases. WI-3's Claude goldens are re-captured after any rebase that touches those sites.
- **Release P4/P5** (`~/.claude/plans/implement-phases-p4-and-nested-clock.md`). If it reaches `qa` before
  WI-8, its ECR lifecycle gate (consent-gated, needs `aws login`) runs before our qa → staging promotion.
- `feature/conversation-history` also edits `handler.ts`; rebase when it lands.

| WI | Scope | Failing tests first | Focused proof | Provider |
|---|---|---|---|---|
| **0** Setup and docs | Normal clone `C:\dev\_netzer-allmodels`, branch `feature/bedrock-all-models` from `origin/development`; `npm ci --ignore-scripts` (and web); baseline `npm test`. Feature folder `docs/features/bedrock-all-models/` (README, HANDOFF, session handoff, `plan.md`). ADR 0011, Proposed: extends ADR 0003 and records routing, provider approval, the tool allowlist, seats and cost | none | `node scripts/ci/docs-links.mjs`, `node scripts/ci/feature-knowledge.mjs` | Claude (Fable) |
| **1** Registry, pricing, catalog | `capabilities.ts`, `catalog.ts` (discovery, geo derivation, provider-approval filter); `models.ts`; `playground-catalog.ts` (fallback price; approval filter). Claude gathers price rows and EULA links from the cards | `capabilities.test.ts`, `catalog.test.ts`, `models-pricing.test.ts` (AM-01/02/05/13/16/30-catalog/37-catalog) | `npx vitest run src/lib/bedrock`, `npm run typecheck` | Codex |
| **2** Selection surfaces | `handler.ts` (GET `/models` with prices, `/models/catalog-status` with pinned-model health, validation, Playground and Knowledge filters); `commands.ts`; `agent-manager.ts`; `model-validation.ts` | `models-route.test.ts`, `commands.test.ts` (AM-03/04/35-api/38) | `npx vitest run src/adapters/dashboard/models-route.test.ts src/agent/commands.test.ts` | Codex |
| **2b** Pre-admission model gate | `seat-model-policy.ts`; `agent-loop.ts` (gate, fallback filter); `ledger-gate.ts` (denied row); `handler.ts` (annotation, 403); `seat-admin.ts` (validation); gap comments in both adapters; `Seats.tsx` picker | `seat-model-policy.test.ts`, `agent-loop.seat-policy.test.ts`, `seat-admin.test.ts`, `ledger-gate.test.ts` (AM-24–30/32) | `npx vitest run src/lib/admin src/lib/cost src/agent/agent-loop.seat-policy.test.ts src/adapters/dashboard/seat-admin.test.ts` | Codex (Opus specifies and verifies) |
| **2c** Cost controls | `ledger-gate.ts` (`admitTurnSpend` worst case) and the agent-loop call site; power-switch `aiSpendLast30d` (the matcher extracted and tested). The Cost Explorer name capture comes first, with consent | `ledger-gate.test.ts`, spend-matcher test (AM-33/34) | `npx vitest run src/lib/cost infra/lib` | Codex (Opus specifies) |
| **3** Request shaping | `request-builder.ts`; `client.ts` (delegation, heal, fallback, affinity); `agent-loop.ts` (non-streaming path, guarded sites, toolUse dispatch, tool allowlist, notes, usage estimate, synthesis fix) | Goldens first; `request-builder.test.ts`, `agent-loop.multimodel.test.ts`, `fallback-chain.test.ts` (AM-06–12/15/18/31) | `npx vitest run src/agent src/lib/bedrock`, then full `npm test` | Codex (Opus specifies and verifies) |
| **4** Display parity | `humanize.ts` (short name, `~$`); `costEstimated` in SSE and `/test-turn`; context windows from the registry in the Telegram and Slack (both paths) footers and `/context`; web `format.ts`, `helpers.ts`, `types.ts`, `ModelMenu.tsx`, `AgentDetail.tsx`, Chat (provider groups, **prices**, disabled states); model-neutral persona in `templates.ts` and `agent-loader.ts` | Footer, chat-helpers and persona tests (AM-14/35/36) | `npx vitest run src/lib/tools src/lib/agents src/lib/config src/adapters/dashboard/chat-helpers.test.ts`, web typecheck and build | Codex |
| **5** IAM | `iam-stack.ts` (policy with geo derivation, Deny; stale comment fixed) | `iam-stack.test.ts` (AM-17/37-iam) | `npx vitest run infra/lib/iam-stack.test.ts` | Codex (Opus specifies and reviews) |
| **6** Roll-call tool | `scripts/rollcall/{models-rollcall,rollcall-lib}.ts`, `rollcall:models` script | `rollcall-lib.test.ts` (AM-19) | `npx vitest run scripts/rollcall` | Codex |
| **6b** Provider approval and capability probe | **(1)** Claude lists every provider in the us-east-1 catalog with its terms link, and you approve. **(2)** Codex builds `capability-probe.ts` against a failing test. **(3)** With consent, Claude runs the probe using your `aws login` against approved providers only, then promotes the results into registry seeds (Sonnet) | `capability-probe.test.ts` (AM-39) | `npx vitest run scripts/rollcall`, plus the live probe evidence | Claude + Codex, **consent-gated** |
| **7** Docs, validation, PR | ADR 0011 → Accepted; README runbook (all the runtime-config settings, roll-call, probe, seat semantics); out-of-band catalog note. **Gap report** asking approval to list `rollcall:models` and the probe under development.md "Spends money". Full validation; PR to `development` | none | All 9 commands | Claude (Fable, Opus review) |
| **8** Staging | Seat inventory; release P4/P5's ECR lifecycle gate if that work is on `qa`; the approved-provider runtime-config write; promotions dev → qa → staging; policy attached to the task role; roll-call off-peak, one model at a time (warm-up pass, then scored); Logs Insights; evidence | none | AM-20 | Claude, **consent-gated** |
| **9** Production | The same as staging for production, including the manual `deploy.yml` dispatch and `--production` | none | AM-21 | Claude, **consent-gated** |

**Claude routing:**
- Fable: docs, handoffs, work orders, and the SPECIFICATION of WI-1, WI-2, WI-4 and WI-6.
- Opus: the SPECIFICATION of WI-2b, WI-2c, WI-3 and WI-5, and every VERIFICATION.
- Sonnet: CLEANUP, mechanical takeovers, price rows and seed promotion.

## Codex lane (every code WI)

- **Policy.** `CODEX_POLICY: BALANCED (user-directed)`: one build per WI plus at most one targeted
  correction (`--resume` with `--feedback`), then Claude takes over and a fresh Opus inspection covers the
  takeover. No silent model change: if Sol refuses CLI 0.153.0, **stop and ask** (update the ChatGPT
  extension, or fall back to Claude).
- **Availability** (2026-09-10, no model call): `codex-cli 0.153.0` at
  `~/.vscode/extensions/openai.chatgpt-26.901.22334-win32-x64/bin/windows-x86_64/codex.exe`, logged in;
  `gpt-5.6-sol` is in `~/.codex/models_cache.json`. Re-resolve the path via
  `ls ~/.vscode/extensions | grep openai.chatgpt`.
- **Build command:**
  `python ~/.claude/skills/claudex-loop/scripts/runner.py build --host claude --builder codex --repo <clone> --plan <WO.md> --unreviewed-spec --model gpt-5.6-sol --effort high --cli <codex.exe> --proof "<focused proof>" --artifacts <dir> --timeout 1800`
- **Files outside the checkout.** Work orders, artifacts and progress state live in
  `C:\Users\EmmanuelAdams\.claude\gauntlet\bedrock-all-models\`. The failing tests are committed before
  delegation.
- **Afterwards, Claude** runs `git status` and checks the diff (including untracked files), rejects
  out-of-scope edits and weakened tests, reruns the proof, then runs
  `runner.py inspect --host claude --builder codex --base <sha> --model claude-opus-5`.
- **`/ponytail` constraints in every work order:** smallest correct diff, no new dependencies, no speculative
  abstractions, nothing outside the listed files.
- **Three-strike breaker** on repeated failures, with logs kept to the last 15–20 lines.
- **Codex never** plans, edits docs, touches AWS, commits or pushes.
- **Provenance.** Codex-authored commits carry an `Implemented-By: Codex gpt-5.6-sol` trailer.
  `PROVENANCE.md:12` (authorship through Claude Code) is yours or counsel's to update; I won't edit it.

## Consent gates (carried verbatim into every handoff)

- **Authorized:** approving this plan authorizes local commits on `feature/bedrock-all-models` only
  (`-c user.name="Emmanuel Adams" -c user.email="e.adams@personalgrowthcs.com"` plus the Co-Authored-By
  trailer).
- **Ask separately each time before:**
  - any push, PR, merge or promotion;
  - `aws login` (you run it) and any AWS call, including Cost Explorer and seat inventory reads;
  - **any first live call to a provider**, which accepts its Marketplace terms (approved providers only);
  - any runtime-config write (approved providers, tool allowlist, default seat policy, the escape hatches);
  - any IAM change or deploy dispatch;
  - any probe or roll-call run (they spend money);
  - creating agents, seats or policies in staging or production;
  - editing `development.md` or `PROVENANCE.md`.
- **Never run:** `npm run deploy`, `deploy:cloud`, `cdk deploy`, `destroy`, `demo:*`, or any other
  development.md "dangerous command".

## Surface parity (CLAUDE.md)

- **`/model` and `/model list`:** the shared `runCommand`, so every surface behaves the same.
- **Footer:** `formatTurnFooter` feeds Telegram `:460`, the Slack main bot `:499` and Slack per-agent `:774`.
  The dashboard uses `modelShortName` and `~`.
- **`/context`:** Telegram `:560`, and Slack `:549` and `:816`.
- **Notes (no tools, tool allowlist, dropped attachment, provider or seat refusal):** carried in
  `result.text`, so they are identical everywhere.
- **Non-streaming turns:** the placeholder is replaced by one final edit.
- **Provider gate:** every surface. **Seat gate:** dashboard only, with gap comments in both the Telegram and
  Slack adapters.
- **Staging manual check:** you send one message each on Telegram, the Slack main bot and a Slack per-agent
  app, using a non-Claude model.

## Risks and things to know

1. **Undocumented capabilities.** Handled by the probe (before merge), self-heal (for models that appear
   later) and the roll-call.
2. **Non-portable tool schemas.** The `main` pass with real tools catches them.
3. **Small context windows.** Tool dropping and `fitHistory`; size failures on `main` are reported
   separately from access.
4. **Cost.**
   - The price-scaled reservation, headroom checks and per-card prices cover the main risk.
   - Non-Anthropic models lose prompt caching on Converse, so the full prompt is billed every round and a
     "cheaper" model can cost more per turn.
5. **Shared account.** Staging and production share quotas and Marketplace subscriptions, so the staging
   roll-call runs off-peak and one model at a time. New models start with low quotas; increases are AWS
   support requests only you can file.
6. **Seat lockouts.** Handled by canonical matching, the pre-promotion inventory and the escape hatch.
7. **Retired models.** `catalog-status` lists agents pinned to them.
8. **Quality.** The roll-call proves models *run*, not that they do the job *well*, because agent prompts
   are tuned for Claude. Quality evaluation is a later phase.
9. **Patient data.** If agents may see it, check each model against your AWS BAA first
   (`LEGAL_REVIEW_CHECKLIST.md:60-61, 96` already asks this).
10. **Synthesis fix.** It changes Claude turns that hit the 8-round cap, so it gets its own test.

## Rollback

CI writes no rollback manifest, so the levers that need no deploy come first. Each runtime-config write is
consent-gated.

- `models/non_anthropic_enabled = '0'`: agents go back to Claude only within seconds.
- Narrow `models/approved_providers` or `models/tools_allowed`: removes a provider, or its tool use.
- `seats/enforce_model_policy = '0'`: turns seat enforcement off.
- The IAM policy is additive and does nothing without the app change, so leave it in place.
- A code defect these levers can't contain: the ECS deployment circuit breaker, or a manual rollback to the
  previous task-definition revision.

## Out of scope (filed for later)

- **Phase 2:** a Messages/Responses path for the seven non-Converse models.
- Direct OpenAI and Gemini APIs.
- Global routing.
- A chat-identity→seat mapping.
- `monthlySpendLimitUsd` enforcement.
- Seat status enforcement.
- Jarvis (stays Anthropic-only).
- The hardcoded ids in internal helpers.
- Feeding the Playground from the catalog (it is only filtered by approval).
- Image, video, embedding and speech models.
- Provisioned throughput.
- Enabling reasoning.
- Refreshing Claude prices.
- Model quality evaluation.
- Edits to `PROVENANCE.md`.

## Verification (end to end)

1. **Per WI:** the focused proof, plus a full `npm test` against the WI-0 baseline. A fresh Opus VERIFICATION
   reports PASS or FAIL per AM id; a failure goes back to the right phase in a new session.
2. **Before the PR:**
   - the capability probe evidence (AM-39);
   - all 9 validation commands (AM-22).
3. **Staging (AM-20):**
   - the seat inventory is reviewed;
   - the approved-provider list is written;
   - the roll-call reaches N/N and Logs Insights is clean;
   - the manual surface messages are checked;
   - one seat-denial check runs if you authorize a throwaway staging seat.
4. **Production (AM-21):** the same, after the manual deploy dispatch.
5. **Progress:** a private "Bedrock All-Models Gauntlet" Artifact, updated at each phase boundary.

## Next-session handoff (paste into a fresh session after approval)

```text
GAUNTLET_MODE: DIRECT_COORDINATOR
GAUNTLET_PHASE: SPECIFICATION

This is a Gauntlet Loop handoff for a fresh session. Before doing substantive work, load/re-read the
gauntlet-loop skill and the netzer-os-development-process skill (read root development.md). The mode and
phase markers are authoritative. Do not generate another generic Gauntlet prompt. Do not restart completed
phases. Do not rely on prior conversation context. Restore state from this handoff and execute only the
named phase.

GOAL: production agents (Telegram, Slack, dashboard) can use every Converse-capable Bedrock text model
reachable in the deployment's own geography (US for production), from approved providers, subject to seat
model policy; proven by a live N/N roll-call.
APPROVED PLAN: C:\Users\EmmanuelAdams\.claude\plans\ok-i-need-a-ancient-codd.md (copy it into
docs/features/bedrock-all-models/plan.md during WI-0). Acceptance criteria AM-01..AM-39 are defined there.
BAR: live N/N roll-call via POST /api/test-turn as the task role, staging then production (AM-20/21).
CURRENT WORK ITEM: WI-0 setup + WI-1 (capability registry, per-model pricing and EULA links from AWS model
cards, live catalog with stack-geography routing, exclusion reasons, provider-approval filter).
BASELINE: not yet captured; capture `npm test` + `npm run typecheck` on the untouched worktree first and
record the known red files in the session handoff.
NEXT OBJECTIVE: WI-0 setup, then WI-1's failing tests (capabilities.test.ts, catalog.test.ts,
models-pricing.test.ts) red for the intended reason, committed locally; freeze the Codex work order
(outside the checkout, C:\Users\EmmanuelAdams\.claude\gauntlet\bedrock-all-models\work-orders\WI-1.md).
EXPECTED SCOPE: src/lib/bedrock/{capabilities,catalog}.ts (new), models.ts, playground-catalog.ts.
CLAUDE ROUTING: fable for this SPECIFICATION; opus for VERIFICATION (select Opus 5 in the app).
IMPLEMENTATION_PROVIDER: CODEX (planned)  CODEX_POLICY: BALANCED (user-directed)
CODEX_MODEL_CLASS: gpt-5.6-sol, effort high (explicit user opt-in)  CODEX_ATTEMPTS_USED: 0
CODEX_ELIGIBILITY: YES - pure TypeScript, table-driven, frozen by failing tests, 4 known files.
REQUIRED SKILLS: /graft (answers from the main checkout; re-read spans in the clone), /tdd, /harness
(fake Bedrock control plane; no AWS), /git (local commits only).
PRECONDITION NOTE: WI-0 and WI-1 can start now (src/lib/bedrock is identical on development and
production). Every other code WI waits until 1abba67, d828124, 1124118, 8c14b3f and
hotfix/empty-turn-poisoning are all ancestors of origin/development (git merge-base --is-ancestor); if they
still aren't when WI-2 opens, stop and ask the user. Capture WI-3's Claude goldens only on that base.
USER CONSTRAINTS: see "Consent gates" in the plan - carry them verbatim into every later handoff.
Workspace: normal clone C:\dev\_netzer-allmodels (not a linked worktree; ledger M6), branch
feature/bedrock-all-models from origin/development. Never edit the main checkout C:\dev\Netzer-Labs
(dirty with others' work).
Emit the IMPLEMENTATION handoff when the SPECIFICATION exit audit passes, then stop.
```
