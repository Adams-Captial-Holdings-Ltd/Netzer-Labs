# [US-035] Triggers: webhook + API

> Backlog task NZR-35 ([backlog](../backlog.md)). Plan story: [US-000](US-000-netzar-studio-rebuild.md). Requirement IDs: FR-011, AC-026.

## 1. User Story Statement
* **As a** Persona B, business process owner (PRD 1.3)
* **I want** my active workflow to start by itself when the partner's system sends a signed request (webhook) or an API call to its trigger address
* **So that** it works on real incoming documents, and forged, replayed, oversized, flooding or repeated requests never start a run (0 runs started by any rejected request in the test suite)

---

## 2. Business Context & Description
* **Background:**
  - Per the NZR-13 trigger contract `{type, auth, schema, rateLimit, idempotencyKey}` → one entry point (blueprint §5). C3 switches on `webhook` and `api`; `form`/`embed` is NZR-39.
  - **Q92 (owner):** pilot ingress = the existing Cloudflare tunnel scripts on a `pgnos.ai` subdomain, T0 tier, with controls in the app. Owner: "Defer to NZR-35 with a security review: signing with replay window, rate limits, body-size cap." The task brief adds the idempotency key. This story records that review and its decision.
  - A **webhook** here = an HTTPS POST from another system, signed with a shared secret (HMAC: a keyed hash both sides can compute). **Replay window** = how old a signed request may be (5 minutes, the Slack pattern). **Idempotency key** = a caller-chosen id; the same key twice starts one run.
  - SECURITY T5 lists the required controls; SECURITY risk 9 ranks webhooks Medium/High for C3.
* **Current behaviour (d1d3a66):**
  - No trigger route exists. Public webhook routes today: `/tg` and `/slack` mounted at `src/server.ts:89-90`, before the authenticated `/api` router (`:146`).
  - HMAC + replay pattern to copy: `src/adapters/slack/verify.ts:13` (`MAX_AGE_SECONDS = 300`), `:20-42` (timestamp check, `createHmac('sha256')`, `timingSafeEqual`, length check first).
  - Streaming body cap pattern: `boundedJson` in `src/adapters/dashboard/paperclip-dispatch.ts:50-66` (rejects on `content-length` first, then counts bytes while reading and cancels). SECURITY 2a B1-D: no `bodyLimit` anywhere in `src/` today.
  - Rate limits: `checkAndConsume` is opt-in and fails **open** (`src/lib/state/rate-limits-repo.ts:201-241`); `checkAndConsumeStrict` enforces a fallback policy and fails **closed** (:251-286). Table `rate-limits`, fixed windows.
  - Tunnel facts: the public overlay publishes the whole app on one `pgnos.ai` hostname through a `cloudflared` sidecar (`infra/lib/public-dashboard-access.ts:1-47`; opt-in `CCE_PUBLIC_ACCESS=1` :115; requires `CCE_DEPLOY_MODE=infra-only` and no `DOMAIN_NAME` :121; zone `pgnos.ai` only :80; explicit `CCE_PUBLIC_HOSTNAME` required when `CCE_NAME_SUFFIX` is set :132-142; the sidecar is added only when `CCE_PUBLIC_CONNECTOR_READY=1`, `compute-stack.ts:738`). Ingress rules live in Cloudflare, not in the template (`infra/lib/compute-stack.ts:756-757`). Tunnel traffic arrives on loopback, so a peer-IP check fails open, and ALB/WAF never see it (`src/server.ts:140-144`). T0 has no WAF and no CloudFront anyway (`infra/lib/constants.ts:349-351`).
  - Engine entry point `startRun()` with idempotent create comes from NZR-34 (`src/lib/engine/start-run.ts`).
  - No JSON-Schema validator is installed (no `ajv` in `package.json`); `zod` ^3.23.8 is.
* **Target behaviour:**
  - `POST /hooks/wf/:triggerId` accepts a signed webhook; `POST /hooks/wf/:triggerId` with `Authorization: Bearer` accepts an API call for `api` triggers. Both call `startRun()` and return a `runId`.
  - Checks run cheapest first, all before any run starts: kill switch → body cap (256 KB) → install-wide pre-auth rate limit → trigger lookup + auth (uniform 401) → replay window → per-trigger rate limit → strict input schema → idempotency → `startRun`.
  - Each trigger has its own secret in Secrets Manager, shown once at creation, rotatable, with a 24 h overlap for the old secret during rotation.
  - Admins create, list, rotate and disable triggers through `/api/workflows/:workflowId/triggers` and `/api/triggers/:triggerId/*`.
  - A trigger can start only the workflow's **active** version (NZR-36). It cannot choose the workflow or version.
  - A written security review `docs/features/netzar-studio/trigger-ingress-review.md` records the Q92 decision, the threats and the tests that prove each control, signed off by the security reviewer and the owner.
* **Out of scope:**
  - Forms and embeds (NZR-39). Schedules and integrations (later).
  - Creating the Cloudflare tunnel or deploying (NZR-38). This story writes the ingress rule text the runbook uses.
  - A trigger setup screen: design.md has no row for it (see NOTES). This story ships the admin API only.
  - Large document upload (presigned two-step upload): see NOTES; v1 caps the body at 256 KB.
* **Target Value:** 100% of the rejection tests (Scenarios 2–5) show 0 `startRun` calls; replay, oversize and flood rejections each produce the named audit row or the aggregated counter; signed requests start a run in < 1 s p95 locally (20 runs, mocked engine).
* **User Persona Profile:** Persona B, business process owner (PRD 1.3). PRD: [foundation/PRD.md](../foundation/PRD.md).

---

## 3. Acceptance Criteria (Confirmation)
*Use the BDD (Behavior-Driven Development) "Given-When-Then" format for clarity.*

### Scenario 1: Signed webhook starts a run
* **Given** an active workflow with webhook trigger `trg_A` (secret `s`) and a body that matches its input schema
* **When** `POST /hooks/wf/trg_A` arrives with `X-Netzar-Timestamp: <now>`, `X-Netzar-Signature: v1=<hex HMAC-SHA256(s, "v1:" + ts + ":" + rawBody)>`, `Idempotency-Key: inv-001`
* **Then** response `202 { runId: <string>, status: 'queued' }`; `startRun` was called once with `{ workflowId, input, trigger: { kind: 'webhook', triggerId: 'trg_A' }, idempotencyKey: 'inv-001' }`; audit row `trigger_received` with `detail: { triggerId, bodySha256, runId }` and no body text
* **Test:** `src/adapters/triggers/webhook.test.ts` › "a correctly signed request starts one run and returns its id"

### Scenario 2: Unsigned, wrong signature, unknown trigger, malformed body
* **Given** (a) no signature headers; (b) a wrong signature; (c) a trigger id that does not exist or is disabled; (d) a valid signature over a body that fails the input schema (unknown field or missing required field)
* **When** each request arrives
* **Then** (a), (b), (c) all get the identical `401 { error: 'unauthorized' }` (same body, same headers, so existence is not revealed, SECURITY T5 I-rule); (d) gets `422 { error: 'invalid_input', fields: [{ path, message }] }`; in all four `startRun` is not called; (d) writes audit `trigger_rejected` with `code: 'invalid_input'`
* **Test:** `src/adapters/triggers/webhook.test.ts` › "rejects unsigned, mis-signed and unknown triggers with the same 401", "rejects a schema-invalid body with 422 and starts nothing"

### Scenario 3: Replay outside the window
* **Given** a correctly signed request whose `X-Netzar-Timestamp` is 301 s old (or 301 s in the future)
* **When** it arrives
* **Then** `401 { error: 'stale_timestamp' }` (only sent after the signature verified), `startRun` not called, audit `trigger_rejected` with `code: 'stale_timestamp'`
* **Test:** `src/adapters/triggers/verify.test.ts` › "rejects a valid signature older than 300 seconds"; `webhook.test.ts` › "audits a replay and starts nothing"

### Scenario 4: Too big
* **Given** a request with `Content-Length: 262145`, and a chunked request with no length that streams 262,145 bytes
* **When** they arrive
* **Then** both get `413 { error: 'body_too_large', limitBytes: 262144 }`; the stream is cancelled after the limit (no full read); signature verification and `startRun` are not called
* **Test:** `src/adapters/triggers/webhook.test.ts` › "rejects an oversized body before reading it all"

### Scenario 5: Too fast
* **Given** trigger `trg_A` with limit 60/min and the install-wide pre-auth limit 600/min
* **When** 61 valid requests arrive within one minute, and separately 601 unauthenticated requests arrive
* **Then** request 61 gets `429 { error: 'rate_limited', retryAfterSec }` with header `Retry-After`; unauthenticated request 601 gets the same 429; the rate-limit store failing makes the route return `503 { error: 'unavailable' }` (fail closed); rejected-for-rate audit rows are aggregated to at most 1 `trigger_rejected` row per trigger per minute with `detail.count`
* **Test:** `src/adapters/triggers/webhook.test.ts` › "rate-limits per trigger and install-wide, failing closed", "aggregates rate-limit audit rows"

### Scenario 6: Repeat
* **Given** two valid signed requests with the same `Idempotency-Key: inv-001` (sequential, then concurrent)
* **When** both arrive
* **Then** the first gets `202 { runId: R, status: 'queued' }`, the second `200 { runId: R, status, deduped: true }`; one run exists; a request with no `Idempotency-Key` (and no `idempotencyKeyPath` in the contract) gets `400 { error: 'idempotency_key_required' }`
* **Test:** `src/adapters/triggers/webhook.test.ts` › "same idempotency key starts one run"

### Scenario 7: API trigger, rotation, kill switch, not active
* **Given** (a) an `api` trigger called with `Authorization: Bearer <token>`; (b) a rotated webhook secret, old secret used 1 h and 25 h after rotation; (c) kill switch `workflow_triggers_disabled` active; (d) a workflow with no active version
* **When** each request arrives
* **Then** (a) valid token → 202 as Scenario 1, wrong token → the uniform 401; (b) 1 h → 202, 25 h → 401; (c) `503 { error: 'triggers_disabled' }`, nothing read past the switch; (d) `409 { error: 'not_active' }` after auth, audit `trigger_rejected` `code: 'not_active'`
* **Test:** `src/adapters/triggers/webhook.test.ts` › "accepts a scoped API token", "honours a 24h rotation overlap", "kill switch closes all triggers", "refuses a workflow with no active version"

### Scenario 8: Admin manages triggers; partner principals cannot
* **Given** an admin principal and a seat-user/viewer principal
* **When** each calls `POST /api/workflows/wf_1/triggers { kind: 'webhook' }`, then `POST /api/triggers/trg_A/rotate`, `POST /api/triggers/trg_A/disable`
* **Then** admin: `201 { triggerId, url, secret }` (secret shown only in this response; later `GET` shows `secretLast4` only), rotate `200 { secret, oldSecretValidUntil }`, disable `200 { status: 'disabled' }`; viewer and seat-user: `403 { error: 'forbidden', requiredCapability: 'triggers:write' }` with no Secrets Manager call
* **Test:** `src/adapters/dashboard/triggers.test.ts` › "admin creates, rotates and disables a trigger", "viewer and seat-user cannot manage triggers"

---

## 4. Technical Notes & Constraints
* **Dependencies:** [NZR-34 / US-034](US-034-live-engine-v1-chosen-option.md) Live engine v1 (chosen option)
* **Builds on (other merged work; formal dependency changes are proposed in NOTES-H-live-deploy.md, not made here):** `startRun()`. Also needs: NZR-13 contract types merged; NZR-36 `activeVer` (until then Scenario 7d is the only reachable outcome on a real workflow; tests mock the version lookup).
* **UI/UX Design:** N/A: API. The trigger setup screen named in the old story is **not** in design.md's inventory (checked `foundation/design.md` §3a–3d); see NOTES.
* **Non-Functional Requirements:** auth + strict schema + rate limit + body cap + idempotency per contract (SECURITY T5). Body ≤ 256 KB. Replay window 300 s. Per-trigger default 60 req/min; install-wide pre-auth 600 req/min. Limits in [CONSTRAINTS.md](../foundation/CONSTRAINTS.md).
* **Data & Analytics:** `trigger.received`, `trigger.rejected`. Written to the existing audit log as a separate product event type with no personal data (Q55); catalogue in OBSERVABILITY.md (NZR-44). Props allow-list: `{ triggerKind, reasonCode, bodyBytesBucket }`; never body text, never caller IP.

**Ingress decision (Q92, recorded in the review doc)**
- Pilot path: `CCE_DEPLOY_MODE=infra-only`, no `DOMAIN_NAME`, `CCE_PUBLIC_ACCESS=1`, `CCE_PUBLIC_HOSTNAME=<name>.pgnos.ai` (exact name chosen in NZR-38), `CCE_PUBLIC_CONNECTOR_READY=1` after the token is stored, tunnel `netzar-<suffix|production>-public` (`public-dashboard-access.ts:59`), token via `npm run public:setup` (`scripts/public-setup.ts:1-16`, one AWS write).
- Cloudflare-side ingress (remotely managed tunnel): `/hooks/wf/*` → app; dashboard paths → app; `/tg/*` and `/slack/*` → `http_status:404` in the pilot (Q93 keeps them off). Written as text in the review doc for NZR-38 to apply; this story makes no Cloudflare change.
- App does all enforcement (no WAF at T0). `CF-Connecting-IP` may be logged as a hint, never used for authz or as the only rate-limit key (spoofable if the origin is reached another way).
- UNVERIFIED (check during the review, from Cloudflare docs, before the owner signs): Cloudflare plan request-body limit and proxy read timeout for `pgnos.ai`; whether Cloudflare WAF/rate rules are available on that zone's plan (free extra layer if yes).

**Files to change**
| path | change |
|---|---|
| `src/server.ts:89-90` | Add `app.route('/hooks', buildTriggerRouter())` next to `/tg` and `/slack`, before `/api` (:146). Public route: needs one ADR line (SECURITY §6 first box). |
| `src/lib/state/kill-switches-repo.ts:50-109,111,274` | Add `workflow_triggers_disabled` (category `Workflows`). |
| `src/lib/audit/audit-writer.ts:57-206,234-260` | Add always-audited `trigger_received`, `trigger_rejected`, `trigger_created`, `trigger_rotated`, `trigger_disabled`. |
| `src/lib/auth/permissions.ts:88-136,195-240` | Add `triggers:write` (admin tier and up; not seat-user, not viewer). |
| `src/lib/jarvis/route-manifest.test.ts:165` | `CAPABILITY_MIN_ROLE['triggers:write'] = 'admin'`. |
| `src/server.ts:92-133` (before the `/api` catch-all at `:146`) | Mount `app.route('/api/triggers', buildTriggersAdminRouter())`; the per-workflow create route sits on the NZR-23/NZR-49 workflows router (UNVERIFIED file name; check at PLANNING). |
| `infra/lib/compute-stack.ts` (task role grants) | Allow `secretsmanager:CreateSecret`, `PutSecretValue`, `GetSecretValue`, `TagResource` on `arn:…:secret:${app}/trigger/*` only, KMS `dataKey`. No `*` resource. UNVERIFIED: exact grant block line; follow the existing `publicTunnelSecret` pattern (`compute-stack.ts:697-719`). |
| `docs/data-flows.json` | Inbound flow `partner-webhook` (pilot only). |
| `docs/diagrams/architecture-security.md` | Add `/hooks/wf/*` entry point (B9). `docs/diagrams.map` already maps `handler.ts`; add `src/adapters/triggers/webhook.ts` to that diagram's `sources`. |
| `docs/runbooks/kill-switches.md`, `docs/runbooks/README.md` | New switch; count. |

**New files**
| path | purpose |
|---|---|
| `src/adapters/triggers/webhook.ts` | `buildTriggerRouter()`: the check pipeline above |
| `src/adapters/triggers/verify.ts` | `verifyTriggerSignature(rawBody, sigHeader, tsHeader, secrets[])` → `{ ok } \| { ok:false, reason }`; HMAC-SHA256, 300 s window, timing-safe, accepts current + overlapping old secret |
| `src/adapters/triggers/bounded-body.ts` | Byte-capped raw body reader (generalised from `paperclip-dispatch.ts:50-66`; returns raw bytes for HMAC, not parsed JSON) |
| `src/lib/triggers/triggers-repo.ts` | Trigger items in the studio table; cached lookup (30 s) |
| `src/lib/triggers/secrets.ts` | Create/rotate/read trigger secrets in Secrets Manager (`${app}/trigger/<triggerId>`); 60 s cache |
| `src/lib/triggers/input-schema.ts` | Compile the NZR-13 declarative field list to a `zod` `.strict()` schema (no `ajv`) |
| `src/adapters/dashboard/triggers.ts` | Admin router: list, create, rotate, disable |
| `docs/features/netzar-studio/trigger-ingress-review.md` | Security review + Q92 decision + Cloudflare ingress text + sign-off lines |

**API contract**
- `POST /hooks/wf/:triggerId` — public; auth by trigger kind.
  - Headers (webhook): `X-Netzar-Timestamp` (unix seconds), `X-Netzar-Signature: v1=<64 hex>`, `Idempotency-Key` (1–128 chars `[A-Za-z0-9_.:-]`) unless the contract sets `idempotencyKeyPath`. Headers (api): `Authorization: Bearer ntk_<token>`, `Idempotency-Key`.
  - Body: JSON ≤ 262,144 bytes, `Content-Type: application/json`, validated by the trigger's strict input schema.
  - 202 `{ runId, status: 'queued' }` · 200 `{ runId, status, deduped: true }` · 400 `{ error: 'idempotency_key_required' }` / `{ error: 'invalid_json' }` · 401 `{ error: 'unauthorized' }` (no/bad auth, unknown or disabled trigger) · 401 `{ error: 'stale_timestamp' }` (only after a valid signature) · 409 `{ error: 'not_active' }` · 413 `{ error: 'body_too_large', limitBytes: 262144 }` · 415 `{ error: 'unsupported_media_type' }` · 422 `{ error: 'invalid_input', fields: [{ path, message }] }` · 429 `{ error: 'rate_limited', retryAfterSec }` + `Retry-After` · 503 `{ error: 'triggers_disabled' }` / `{ error: 'unavailable' }`.
- `GET /api/workflows/:workflowId/triggers` — `triggers:write`. 200 `{ triggers: [{ triggerId, kind, status, url, secretLast4, rateLimitPerMin, createdAt, createdBy }] }`.
- `POST /api/workflows/:workflowId/triggers` — `triggers:write`. Body strict `{ kind: 'webhook' | 'api', rateLimitPerMin?: 1..600 }`. 201 `{ triggerId, url, secret }` (only time the secret is returned). 404 `{ error: 'not_found' }`.
- `POST /api/triggers/:triggerId/rotate` — `triggers:write`. 200 `{ secret, oldSecretValidUntil }`.
- `POST /api/triggers/:triggerId/disable` — `triggers:write`. 200 `{ status: 'disabled' }`. Re-enable = create a new trigger (no un-disable in v1).
- All admin routes: 401 `{ error: 'unauthorized' }`, 403 `{ error: 'forbidden', requiredCapability: 'triggers:write' }`.

**Data changes**
- Studio table (NZR-12), expand-only:
  - `TRIGGER#<triggerId>` / `META`: `workflowId, kind (webhook|api), status (active|disabled), secretRef (Secrets Manager name), secretLast4, rateLimitPerMin, createdBy (person id), createdAt, rotatedAt?, oldSecretValidUntil?`. One `GetItem` per request (cached 30 s). Deviation from DATA-MODEL §3 (`WF#<wfId>/TRIG#<verSeq>`): the hot path needs lookup by trigger id; record in NOTES and the DATA-MODEL change list.
  - `WF#<workflowId>` / `TRIGREF#<triggerId>`: list index for the admin `GET`.
- Secrets Manager: `${app}/trigger/<triggerId>` JSON `{ current, previous?, previousValidUntil? }` (KMS `dataKey`). Never in DynamoDB, logs, audit or fixtures.
- Rate-limit counters: existing `rate-limits` table, identities `trigger#<triggerId>` and `trigger-global`.
- Idempotency: delegated to `startRun` (`IDEM#` rows, NZR-34).
- Rollback: disable triggers or trip `workflow_triggers_disabled`; items and secrets stay; delete secrets only at pilot end (SECURITY §5.12).

* **Security notes:**
  - Threats: SECURITY 2b T5 (S, T, D, I, R, E all apply), risk 9; B9 boundary; B1-D (no body limit). Pilot controls §5.10 (per-partner credentials, rotated at start and end).
  - Authz: public route authenticates per trigger and fails closed when the secret is missing or unreadable (→ 503 `unavailable`, never "accept"). Admin routes: `triggers:write`; partner principals never hold it (§5.9).
  - Uniform 401 for "no such trigger", "disabled", "no auth", "bad signature" — compare timing too: always compute one HMAC (against a dummy secret when the trigger is unknown).
  - Audit: `writeAuditOrThrow` for `trigger_created/rotated/disabled` and accepted requests; rejected requests aggregated (≤ 1 row/trigger/min/reason) so a flood cannot flood the audit log (WORM at tier ≥ 2). Body hash only.
  - Secrets: generated with `randomBytes(32)`, returned once, stored only in Secrets Manager; run `node scripts/ci/secret-scan.mjs` on the diff; fixtures use obvious fake secrets (`test-secret-not-real`).
  - The tunnel makes the whole app public: the review doc must list every public path the tunnel exposes and state the expected response for each (dashboard login, `/hooks/wf/*`, `/tg/*` → 404 by ingress rule, `/slack/*` → 404, `/health`, `/status`).
* **Test plan:**
  - Frozen failing tests first: Scenarios 2, 3, 4, 5, 6 (the rejection paths) in `src/adapters/triggers/webhook.test.ts` and `verify.test.ts`, red SHA recorded.
  - Unit: `src/adapters/triggers/webhook.test.ts` (drive `buildTriggerRouter()` with `app.request()`; mock `startRun`, triggers repo, secrets, rate-limits repo, kill switches, audit), `verify.test.ts` (pure), `bounded-body.test.ts`, `src/lib/triggers/input-schema.test.ts`, `src/adapters/dashboard/triggers.test.ts` (principals mocked as in `seat-admin.test.ts`).
  - Security review checklist in `trigger-ingress-review.md`: one row per T5 control → test name.
  - Fixtures: synthetic JSON only (`src/adapters/triggers/__fixtures__/golden-input.json`), fake secrets.
  - Commands: `npx vitest run src/adapters/triggers src/lib/triggers src/adapters/dashboard/triggers.test.ts src/lib/jarvis/route-manifest.test.ts`; `npx vitest run infra`; full `npm test`; `node scripts/ci/diagrams-drift.mjs`; `node scripts/ci/docs-links.mjs`; `node scripts/ci/secret-scan.mjs <changed files>`.
* **Repo rules that apply:** public route ⇒ ADR line (SECURITY §6); new outbound/inbound flow ⇒ `docs/data-flows.json`; new capability ⇒ `CAPABILITY_MIN_ROLE`; additive capability strings only (`permissions.ts:84-86`); no new dependency (no `ajv`; C-15); IAM grants on own ARNs only (SECURITY §6); `writeAuditOrThrow` for evidence; full `npm test` before push.
* **Rollback:** trip `workflow_triggers_disabled` (all triggers 503 at once); per trigger: disable; image rollback `npm run deploy:rollback -- --class=image --to=previous`; Cloudflare ingress rule for `/hooks/wf/*` → 404 (NZR-38 runbook).
* **Build slices (proposal):**
  1. *Verify + body cap* (1–2 h): `verify.ts`, `bounded-body.ts`, tests. Green: Scenarios 3, 4.
  2. *Webhook pipeline* (2 h): `webhook.ts`, triggers repo (read), secrets (read), rate limits, kill switch, audit, `startRun` call, `/hooks` mount. Green: Scenarios 1, 2, 5, 6, 7a/c/d.
  3. *Admin API + secrets lifecycle* (2 h): `triggers.ts` router, create/rotate/disable, IAM grants, capability, manifest test. Green: Scenarios 7b, 8.
  4. *Security review doc* (1 h): `trigger-ingress-review.md`, data-flows, diagrams, runbook. Sign-off by security reviewer + owner.
* **Agent gotchas:**
  - **HMAC over the raw bytes.** Read the raw body with the byte cap, verify, then `JSON.parse`. Hono's `c.req.json()` consumes the stream and re-serialising changes bytes, so the signature never matches.
  - `boundedJson` in `paperclip-dispatch.ts` returns parsed JSON and swallows parse errors as `null`; do not reuse it as-is.
  - Do not use `checkAndConsume` (opt-in: no policy row ⇒ unlimited, and fails open; `rate-limits-repo.ts:205-217,234-240`). Use `checkAndConsumeStrict` with a fallback policy.
  - Peer IP through the tunnel is `127.0.0.1` (`server.ts:140-144`); the leftmost `X-Forwarded-For` is caller-controlled (SECURITY 2a B1-R). Never key the per-trigger limit on IP.
  - A rate limit keyed only by trigger id **before** auth lets anyone who learns the URL exhaust the partner's quota. Pre-auth uses the install-wide key; the per-trigger key is consumed only after auth.
  - Length check before `timingSafeEqual` (it throws on unequal lengths; `slack/verify.ts:37-39`).
  - `/hooks` must be mounted before `app.route('/api', …)` and must not pass through the dashboard bearer middleware (`handler.ts:1410-1436`).
  - Secrets Manager calls cost latency; cache the secret (60 s) and invalidate on rotate/disable.

---

## 5. Estimation & Tracking
* **Epic Name:** M3 Live + pilot (cycle C3 Live (loop 2) + pilot, 2026-12-08 to 2026-12-31)
* **Priority:** Must Have
* **Story Points / Effort Estimate:** 5 (raw estimate 6 h; 1 pt is about 1 h of factory work, rounded to 1/2/3/5/8/13, Q47)
* **Rigor tier:** T3 · **Deploy reach:** local only · **Labels:** workflow

---

## 6. Definition of Ready (DoR) Checklist
*Before pulling this story into a sprint:*
- [ ] User persona and "So That" benefit are clear and verified (Persona B; partner system posts the document).
- [ ] Acceptance criteria cover both happy paths and edge cases (8 scenarios: start, bad auth/body, replay, size, rate, repeat, API/rotation/kill/not-active, admin authz).
- [ ] UX/UI designs: N/A: API. Trigger setup screen owner decided (NOTES) before NZR-38.
- [ ] Dependencies have been identified and are unblocked (NZR-34 `startRun` merged; NZR-13 contract merged; NZR-36 version pointer shape agreed; pilot document size confirmed ≤ 256 KB or the upload follow-up accepted).
- [ ] The team has reviewed and estimated the story points (5 pts; re-checked at the Nov 9 re-plan, Q71).
- [ ] Task stories (build slices) are written at this step's PLANNING, before code (Q70).

---

## 7. Definition of Done (DoD) Checklist
*Before this story can be marked as complete:*
- [ ] Code is written and follows CLAUDE.md / CONTRIBUTING.md, minimum correct diff (/ponytail).
- [ ] Peer code review is completed and approved. Full review layers incl. one Greptile pass (Q68): fresh Claude critic + security reviewer (signs `trigger-ingress-review.md`) (+ NVIDIA roles after bake-off); owner reviews the security boundary and signs the Q92 decision.
- [ ] A frozen failing test came first (red SHA recorded); the gate is green on a clean checkout of the exact HEAD: `npx vitest run src/adapters/triggers src/lib/triggers src/adapters/dashboard/triggers.test.ts`; full `npm test` green.
- [ ] QA: the fresh critic re-runs the gate against these criteria. UAT: N/A, no user-facing change; the owner accepts the evidence summary (rejection matrix).
- [ ] Documentation is updated: feature HANDOFF + a dated session handoff; durable facts promoted to README/ADR (public-route ADR line); `data-flows.json`, security diagram, kill-switch runbook updated.
- [ ] Done = merged to `development` (owner yes for every merge/push, Q50) and verified locally. Staging: PENDING until NZR-42 (AWS account) exists; the live webhook is tested on rebuild staging before the pilot (DEPLOY §6 item 3).
