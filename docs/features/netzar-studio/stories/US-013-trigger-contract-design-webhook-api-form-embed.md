# [US-013] Trigger contract design (webhook/api/form/embed/integration/schedule)

> Backlog task NZR-13 ([backlog](../backlog.md)). Plan story: [US-000](US-000-netzar-studio-rebuild.md). Requirement IDs: FR-011, AC-026.

## 1. User Story Statement
* **As a** Persona B, business process owner (PRD 1.3), whose workflow must start when a partner system sends data
* **I want** one written, typed entry contract for every way a workflow can start, with auth, input schema, rate limit, idempotency key, body cap and replay window fixed per trigger type
* **So that** the C3 webhook and API triggers (NZR-35) plug into one entry point, and a retried or forged call never starts a second run or an unauthorised one

---

## 2. Business Context & Description
* **Background:** Design only in MVP; switched on in C3 (NZR-35 webhook + API; NZR-39 forms/embed stretch). Public-API one-way door. Q92 (round 4): ingress for the pilot webhook (Cloudflare tunnel subdomain vs Route 53 + WAF) is deferred to NZR-35 with a security review, which must cover "signing with replay window, rate limits, body-size cap". Q12 + ADR 0024 (NZR-7): Netzar owns the engine; business scheduler stays forbidden. FR-011 (external actions use authorisation and retry-safety controls); AC-026 (a repeated trigger or retry does not duplicate the business write). SECURITY section 2b T5 sets the controls; this story turns them into a contract.
* **Current behaviour (d1d3a66):**
  - No trigger route, type or table exists. SECURITY boundary B9 "(C3) webhook/API trigger → live engine: Not built" (`foundation/SECURITY.md:49`).
  - **Signing pattern to copy:** `src/adapters/slack/verify.ts` HMAC-SHA256 over `v0:<ts>:<raw_body>`, constant-time compare, `MAX_AGE_SECONDS = 60 * 5` (`:4-13`, `:27-35`), reasons `no_secret | stale_timestamp | bad_signature | missing_headers` (`:17`). Length-guarded `timingSafeEqual` in `src/adapters/dashboard/paperclip-dispatch.ts:31-47`.
  - **No body cap anywhere:** Slack reads the whole body with `await c.req.text()` (`src/adapters/slack/handler.ts:60`, `:131`); SECURITY risk 9 (`SECURITY.md:265`).
  - **Public routes** are mounted before the `/api` auth middleware (`src/server.ts:89-90`: `/tg`, `/slack`). SECURITY checklist (`SECURITY.md:240`): a public route needs an ADR line; a webhook route fails closed when its secret is missing.
  - **Idempotency store to reuse:** table `${app}-hook-idempotency` (`infra/lib/constants.ts:104`), keys `PK=EVENT#<eventId>`, `SK=STATE`, TTL 7 days (`src/lib/hooks/dispatcher.ts:20-50`). It does get-then-put with no condition (`:30-50`), so two concurrent calls can both pass.
  - **Rate limits to reuse:** table `${app}-rate-limits` (`infra/lib/constants.ts:115`); `checkAndConsume` fails **open** on errors, `checkAndConsumeStrict` fails **closed** (`src/lib/state/rate-limits-repo.ts:201`, `:251`); policy `{limit, windowSec}` (`:42-47`).
  - **Kill switches:** `KillSwitchName` union + `ALL_KILL_SWITCHES` + `KILL_SWITCH_META` (`src/lib/state/kill-switches-repo.ts:50`, `:111`, `:274`); `workflow_triggers_disabled` is not a member yet.
  - **Planned storage:** DATA-MODEL row "TriggerContract (design only)": `WF#<wfId>` / `TRIG#<verSeq>`: `{type, auth: {kind, secretRef→Secrets Manager}, inputSchema (JSON Schema), rateLimit, idempotencyKeyPath}`; secrets never in the table.
  - **Workflow trigger step:** `trigger.kind` enum and `trigger.inputs` in `src/lib/workflows/schema.ts` (NZR-12).
* **Target behaviour:**
  - **Doc** `docs/features/netzar-studio/foundation/TRIGGER-CONTRACT.md` and **types** `src/lib/workflows/trigger-contract.ts` (types and constants only, no I/O, no imports beyond `./schema.js`).
  - **Common rules (all types):**
    - A trigger is bound server-side to one workflow; it starts only the **activated** version (C3). The caller cannot pass a workflow id or version (SECURITY T5 E).
    - Input is JSON (`Content-Type: application/json`, else 415). The input schema is derived by code from `trigger.inputs` (NZR-12): `additionalProperties: false`, required fields, types `text` ≤ 10,000 chars, `number`, `date` (ISO 8601), `choice` (enum). Validated before any run starts; unknown fields rejected. Built with zod from the inputs (no new JSON Schema dependency); the JSON Schema form is stored for callers to read.
    - **Body cap:** `TRIGGER_BODY_LIMIT_BYTES = 262_144` (256 KB, SECURITY T5), enforced while streaming (stop reading at the cap), before parsing or signature work → 413.
    - **Idempotency key:** header `Idempotency-Key`, required, `^[A-Za-z0-9_-]{8,128}$`. Stored as `PK=TRIG#<triggerId>#IDEM#<key>` with `bodySha256`, `runId`, TTL `TRIGGER_IDEMPOTENCY_TTL_SEC = 604_800` (7 days, as `dispatcher.ts:49`), written with a **conditional put** (`attribute_not_exists(PK)`). Same key + same body hash → `200 {runId, status: "duplicate"}`, no new run. Same key + different body → `409 idempotency_key_reused`. Integration triggers use the provider's event id as the key.
    - **Replay window:** `TRIGGER_REPLAY_WINDOW_SEC = 300`, both directions (a timestamp more than 300 s in the past or future → 401). The idempotency record outlives the window, so a replay inside 7 days with the same key is a duplicate, never a second run.
    - **Rate limit:** per trigger, default `60` requests per `60` s (scope `trigger:<triggerId>`) through `checkAndConsumeStrict` (fail closed) → `429` with `Retry-After`; per install at most `10` runs in `starting/running` (C-50 sizes an install at about 1,000 runs/day). Global kill switch `workflow_triggers_disabled` and a per-trigger `enabled` flag → 503 (only after auth succeeds).
    - **Error shape:** `{"error": "<code>", "message": "<plain sentence>"}`. Unknown trigger, missing/bad signature, bad token and stale timestamp all return the **same** `401 {"error":"unauthorized"}` (SECURITY T5 I). `400 invalid_input` lists field names and rules, only after auth.
    - **Audit:** `trigger_received` and `trigger_rejected` (reason code, `bodySha256`, triggerId, no body, no headers) per OBSERVABILITY (NZR-44).
    - **Order of checks** (fixed): size → method/content type → auth (signature or token) → timestamp window → kill switch / enabled → rate limit → idempotency claim → input schema → start run. A rejected request at any step starts no run and makes no model call.
  - **Per-type table** (in the doc and as `TRIGGER_TYPES` in the types file):

    | Type | Status | Auth | Input | Rate limit | Idempotency key | Body cap | Replay window |
    |---|---|---|---|---|---|---|---|
    | `webhook` | C3, NZR-35 | Per-trigger secret in Secrets Manager (`netzar/triggers/<triggerId>`), shown once, rotatable; headers `X-Netzar-Timestamp` + `X-Netzar-Signature: v1=<hex HMAC-SHA256(secret, "v1:" + ts + ":" + rawBody)>`; missing secret → fail closed | derived schema | 60/min per trigger | `Idempotency-Key` header | 256 KB | 300 s |
    | `api` | C3, NZR-35 | `Authorization: Bearer <token>`, a token minted for this one trigger, stored hashed, shown once, revocable; no session cookies | derived schema | 60/min per trigger | `Idempotency-Key` header | 256 KB | N/A (no timestamp; token + idempotency) |
    | `form` | Stretch, NZR-39 | Netzar-hosted form page; per-form public id + server-issued one-time form token (no secret in the page) | derived schema (form fields) | 10/min per client IP + 60/min per form | form token (one use) | 256 KB | form token expires in 30 min |
    | `embed` | Stretch, NZR-39 | Per-embed public key + `Origin` allow-list checked server-side; one-time token as `form` | derived schema | as `form` | form token | 256 KB | 30 min token |
    | `integration` | Later (post-pilot) | The install's existing connection to the provider (no new credential); provider signature checked by that connector | provider event mapped to inputs by code | per connection | provider event id | provider max, ≤ 256 KB | provider's window, ≤ 300 s |
    | `schedule` | Blocked: DO NOT BUILD (business scheduler) until an ADR | N/A (internal) | fixed inputs in the definition | min interval from `getSchedulerMinIntervalSec` (`rate-limits-repo.ts:332`) | `<triggerId>#<scheduled time>` | N/A | N/A |
  - **Types** (proposed):
    ```ts
    export type TriggerKind = WorkflowDefinition['trigger']['kind'];         // single source: schema.ts
    export type TriggerAuth =
      | { kind: 'hmac'; secretRef: string }                                    // Secrets Manager id, never the secret
      | { kind: 'token'; tokenHashRef: string }
      | { kind: 'form_token'; formPublicId: string; allowedOrigins?: string[] }
      | { kind: 'connection'; connectionId: string }
      | { kind: 'internal' };
    export interface TriggerContract {
      triggerId: string; workflowId: string; kind: TriggerKind; enabled: boolean;
      auth: TriggerAuth; inputSchema: Record<string, unknown>;              // JSON Schema form, read-only for callers
      rateLimit: { limit: number; windowSec: number };
      idempotency: { source: 'header' | 'form_token' | 'provider_event_id' | 'schedule_slot'; ttlSec: number };
      bodyLimitBytes: number; replayWindowSec: number | null;
    }
    export type TriggerRejectReason = 'too_large' | 'unsupported_media_type' | 'unauthorized' | 'disabled'
      | 'rate_limited' | 'idempotency_key_missing' | 'idempotency_key_reused' | 'invalid_input';
    export type StartRunResult =
      | { ok: true; status: 'accepted' | 'duplicate'; runId: string }
      | { ok: false; httpStatus: 400 | 401 | 409 | 413 | 415 | 429 | 503; reason: TriggerRejectReason; retryAfterSec?: number };
    export const TRIGGER_BODY_LIMIT_BYTES = 262_144;
    export const TRIGGER_REPLAY_WINDOW_SEC = 300;
    export const TRIGGER_IDEMPOTENCY_TTL_SEC = 604_800;
    export const TRIGGER_TYPES: Record<TriggerKind, { status: 'c3' | 'stretch' | 'later' | 'blocked'; /* … */ }>;
    ```
  - **Ingress (Q92, deferred):** the contract is ingress-agnostic. The doc lists both options from Q92 and states that NZR-35's security review picks one; it records SECURITY risk 9's note "WAF tier ≥ 2 in the pilot" as an open conflict with the Q92 recommended option (tunnel, T0).
* **Out of scope:** any route, handler, table, secret, kill-switch member or infra (NZR-35); choosing ingress (NZR-35 security review, Q92); forms/embed build (NZR-39); file uploads through a trigger (open item: the golden workflow needs a policy document; 256 KB JSON cannot carry most PDFs; NZR-35 decides between an upload ticket and text-only input); an ADR for public routes (written with NZR-35, SECURITY checklist line 240).
* **Target Value:** 6 of 6 trigger types have all 6 contract fields (auth, input, rate limit, idempotency key, body cap, replay window) filled or marked N/A with a reason; 0 runtime files in the diff.
* **User Persona Profile:** Persona B, business process owner (PRD 1.3). Owns the workflow; hands the trigger address and secret to the partner's IT person (the contract is also what PRD Persona D, developer, reads). PRD: [foundation/PRD.md](../foundation/PRD.md).

---

## 3. Acceptance Criteria (Confirmation)
*Use the BDD (Behavior-Driven Development) "Given-When-Then" format for clarity.*

### Scenario 1: Contract complete for every type
* **Given** `TRIGGER-CONTRACT.md` and `src/lib/workflows/trigger-contract.ts`
* **When** the critic checks the per-type table and `TRIGGER_TYPES`
* **Then** each of `webhook`, `api`, `form`, `embed`, `integration`, `schedule` has auth, input, rate limit, idempotency key, body cap and replay window, each a value or `N/A` with a reason; the keys of `TRIGGER_TYPES` equal the `trigger.kind` enum in `schema.ts`
* **Test:** `src/lib/workflows/trigger-contract.test.ts` › "TRIGGER_TYPES covers every trigger kind in the schema"

### Scenario 2: Numbers fixed in one place
* **Given** the types file
* **When** the test imports its constants
* **Then** `TRIGGER_BODY_LIMIT_BYTES === 262144`, `TRIGGER_REPLAY_WINDOW_SEC === 300`, `TRIGGER_IDEMPOTENCY_TTL_SEC === 604800`; the doc quotes the same numbers
* **Test:** `src/lib/workflows/trigger-contract.test.ts` › "body cap, replay window and idempotency TTL match SECURITY T5"

### Scenario 3: Retry and replay cannot start a second run (designed)
* **Given** the doc's idempotency section
* **When** the critic reads it
* **Then** it specifies: required `Idempotency-Key`, conditional put (`attribute_not_exists`), same key + same `bodySha256` → 200 duplicate with the first `runId`, same key + different body → 409, record TTL 7 days > replay window 300 s; and it names the race in `src/lib/hooks/dispatcher.ts:30-50` as the pattern **not** to copy
* **Test:** critic command `grep -n 'attribute_not_exists\|dispatcher.ts:30-50\|409' docs/features/netzar-studio/foundation/TRIGGER-CONTRACT.md` › "3 matches"

### Scenario 4: Failure answers leak nothing
* **Given** the doc's error table
* **When** the critic reads it
* **Then** unknown trigger, bad signature, bad token and stale timestamp share one `401 {"error":"unauthorized"}`; `400 invalid_input` and `503 disabled` are only returned after auth; the fixed order of checks puts size before parsing and auth before schema
* **Test:** critic command `grep -n 'unauthorized' docs/features/netzar-studio/foundation/TRIGGER-CONTRACT.md` › "one shared 401 row; order-of-checks list present"

### Scenario 5: No runtime in the diff
* **Given** `git diff --name-only origin/development...HEAD`
* **When** it is inspected
* **Then** it lists only `src/lib/workflows/trigger-contract.ts`, `src/lib/workflows/trigger-contract.test.ts`, `docs/features/netzar-studio/foundation/TRIGGER-CONTRACT.md` and link edits in docs; no file under `src/adapters/`, `src/server.ts`, `infra/`, `web/`; the types file imports only `./schema.js` (no AWS SDK, no hono)
* **Test:** `src/lib/workflows/trigger-contract.test.ts` › "imports nothing but ./schema.js"; critic command `git diff --name-only origin/development...HEAD`

### Scenario 6: Schedule stays blocked
* **Given** the `schedule` row
* **When** it is read
* **Then** its status is `blocked` with the reason "DO NOT BUILD row 1: business scheduler; needs an ADR", and `TRIGGER_TYPES.schedule.status === 'blocked'`
* **Test:** `src/lib/workflows/trigger-contract.test.ts` › "schedule is blocked until an ADR"

---

## 4. Technical Notes & Constraints
* **Dependencies:** [NZR-12 / US-012](US-012-workflow-definition-schema-validator.md) Workflow definition schema + validator
* **Uses from NZR-12:** the `trigger.kind` enum and `trigger.inputs`. Audit action names `trigger_received` / `trigger_rejected` are fixed here and catalogued by [NZR-44 / US-044](US-044-observability-md-logs-product-events-run-history.md) (not a dependency).
* **UI/UX Design:** N/A: contract. (Where an admin copies the secret or token once is NZR-35 UI.)
* **Non-Functional Requirements:** Idempotency key required (AC-026). Body cap 256 KB, replay window 300 s, rate limit fail-closed (SECURITY T5). Limits in [CONSTRAINTS.md](../foundation/CONSTRAINTS.md).
* **Data & Analytics:** N/A: no product event for this step; standard audit entries only. (Names `trigger_received` / `trigger_rejected` are defined for NZR-35.)
* **Steps:**
  1. Builder (Opus, T3): commit `trigger-contract.test.ts` with the five tests named in section 3 against an empty module; `npx vitest run src/lib/workflows/trigger-contract.test.ts`; record red + SHA.
  2. Builder: write `trigger-contract.ts` (types and constants above).
  3. Builder: write `TRIGGER-CONTRACT.md`: 1 Purpose; 2 Common rules; 3 Order of checks; 4 Per-type table; 5 Error table; 6 Idempotency and replay; 7 Rate limits and kill switch; 8 Audit; 9 Ingress options (Q92, deferred); 10 Open items (file inputs, WAF vs tunnel, public-route ADR, API token minting). Frontmatter `status: current`. Link from DATA-MODEL row "TriggerContract" and SECURITY T5.
  4. Builder: green test, `npm run typecheck`, `npm test`, Docs CI.
  5. Fresh critic + security reviewer + one Greptile pass (T3, Q68); owner reviews the security boundary.
* **Files to change:**
  | path | change |
  |---|---|
  | `docs/features/netzar-studio/foundation/DATA-MODEL.md` (row "TriggerContract", line 126) | link to TRIGGER-CONTRACT.md; replace "inputSchema (JSON Schema)" note with "derived from `trigger.inputs`" |
  | `docs/features/netzar-studio/foundation/SECURITY.md` (T5, lines 105-111) | one link line to TRIGGER-CONTRACT.md |
  | `src/server.ts`, `src/adapters/**`, `src/lib/state/kill-switches-repo.ts`, `infra/**`, `web/**` | **no change** (Scenario 5) |
* **New files:**
  - `src/lib/workflows/trigger-contract.ts`: types and constants only (`TriggerContract`, `TriggerAuth`, `StartRunResult`, `TRIGGER_TYPES`, three numeric constants).
  - `src/lib/workflows/trigger-contract.test.ts`: frozen tests for Scenarios 1, 2, 5, 6.
  - `docs/features/netzar-studio/foundation/TRIGGER-CONTRACT.md`: the contract (frontmatter `feature: netzar-studio`, `document_role: decision`, `status: current`, `observed_at`, `as_of_commit`).
* **Data changes:** none now. Designed for NZR-35: studio table `WF#<wfId>` / `TRIG#<verSeq>` (DATA-MODEL line 126) holds the `TriggerContract` without secrets; idempotency rows `PK=TRIG#<triggerId>#IDEM#<key>` in `${app}-hook-idempotency` (`infra/lib/constants.ts:104`) or a new prefix in the studio table (NZR-35 picks; TTL 7 days, conditional put); rate-limit scope `trigger:<triggerId>` in `${app}-rate-limits`; secrets at Secrets Manager `netzar/triggers/<triggerId>`. Forward-only: new trigger kinds are additive to the enum.
* **Evidence:** red then green test output with SHAs; `npm run typecheck`, `npm test`, Docs CI output; `git diff --name-only` output for Scenario 5.
* **API contract:** **design only, no route in this story.** Proposed for NZR-35: `POST /t/{triggerId}` (public, mounted before `/api` like `/slack`, `src/server.ts:89-90`). Request headers: `Content-Type: application/json`, `Idempotency-Key`, plus `X-Netzar-Timestamp` + `X-Netzar-Signature` (webhook) or `Authorization: Bearer` (api). Responses: `202 {runId, status:"accepted"}`, `200 {runId, status:"duplicate"}`, `400 {error:"invalid_input", message, fields:[{name, rule}]}`, `401 {error:"unauthorized"}`, `409 {error:"idempotency_key_reused"}`, `413 {error:"too_large"}`, `415 {error:"unsupported_media_type"}`, `429 {error:"rate_limited"}` + `Retry-After`, `503 {error:"disabled"}`.
* **Security notes:** SECURITY T5 is binding (STRIDE per control). Secrets live in Secrets Manager under the trigger id and never in DynamoDB, logs or audit rows. Constant-time compare with a length guard (`paperclip-dispatch.ts:31-47`; `timingSafeEqual` throws on unequal lengths). The signature covers the raw bytes, so the body is read once, capped, then verified, then parsed. Use the fail-closed rate limiter (`checkAndConsumeStrict`), never `checkAndConsume`. Run inputs from a trigger are untrusted text for every AI step (delimited per SECURITY section 4 mitigation 4). Webhook credentials per partner, rotated at pilot start and end (SECURITY section 5 control 10).
* **Test plan:** `src/lib/workflows/trigger-contract.test.ts` (Scenarios 1, 2, 5, 6) and critic greps (Scenarios 3, 4). Commands: `npx vitest run src/lib/workflows/trigger-contract.test.ts`, `npm run typecheck`, `npm test`, `node scripts/ci/docs-links.mjs && node scripts/ci/feature-knowledge.mjs`.
* **Repo rules that apply:** frozen failing test first (C-41); SECURITY checklist (`SECURITY.md:240`: public routes need an ADR line, fail closed without a secret); never repurpose an action or capability string; no new dependency.
* **Rollback:** delete the two new source files and the doc (nothing imports them until NZR-35).
* **Build slices (proposal):**
  1. Frozen test (red) + `trigger-contract.ts` → Scenarios 1, 2, 5, 6.
  2. `TRIGGER-CONTRACT.md` + links → Scenarios 3, 4.
* **Agent gotchas:**
  - Do not add `workflow_triggers_disabled` to `KillSwitchName` here; that is runtime (NZR-35). The doc names it.
  - Do not copy the hook dispatcher's get-then-put idempotency (`dispatcher.ts:30-50`); it races.
  - The Slack adapter reads unbounded bodies (`slack/handler.ts:60`); do not cite it for the body cap, only for the signing scheme.
  - `TriggerKind` must come from `schema.ts` so the two lists cannot drift.
  - Q92 is deferred, not decided: write both ingress options, pick neither.

---

## 5. Estimation & Tracking
* **Epic Name:** M1 Foundations ready (cycle C1 Foundations, 2026-10-27 to 2026-11-09)
* **Priority:** Should Have
* **Story Points / Effort Estimate:** 2 (raw estimate 2 h; 1 pt is about 1 h of factory work, rounded to 1/2/3/5/8/13, Q47)
* **Rigor tier:** T3 · **Deploy reach:** local only · **Labels:** workflow, docs

---

## 6. Definition of Ready (DoR) Checklist
*Before pulling this story into a sprint:*
- [ ] User persona and "So That" benefit are clear and verified.
- [ ] Acceptance criteria cover both happy paths and edge cases (all six types, fixed numbers, retry/replay, no leaks, no runtime, schedule blocked).
- [ ] UX/UI designs: N/A: contract.
- [ ] Dependencies have been identified and are unblocked (NZR-12 merged: `trigger.kind` enum exists).
- [ ] The team has reviewed and estimated the story points (2 pts; re-checked at the Nov 9 re-plan, Q71).
- [ ] Task stories (build slices) are written at this step's PLANNING, before code (Q70).

---

## 7. Definition of Done (DoD) Checklist
*Before this story can be marked as complete:*
- [ ] Code is written and follows CLAUDE.md / CONTRIBUTING.md, minimum correct diff (/ponytail); types and constants only.
- [ ] Peer code review is completed and approved. Full review layers incl. one Greptile pass (Q68): fresh Claude critic + security reviewer (+ NVIDIA roles after bake-off); owner reviews the security boundary.
- [ ] The frozen failing test `trigger-contract.test.ts` came first (red SHA recorded); green on a clean checkout of the exact HEAD; `npm run typecheck`, full `npm test` and Docs CI green.
- [ ] QA: the fresh critic re-runs the gate against these criteria. UAT: N/A, no user-facing change; the owner accepts the evidence summary.
- [ ] Documentation is updated: feature HANDOFF + a dated session handoff; DATA-MODEL and SECURITY T5 link TRIGGER-CONTRACT.md.
- [ ] Done = merged to `development` (owner yes for every merge/push, Q50) and verified locally. Staging: N/A: no runtime.
