# [US-039] Later (stretch): forms/embed triggers

> Backlog task NZR-39 ([backlog](../backlog.md)). Plan story: [US-000](US-000-netzar-studio-rebuild.md). Requirement IDs: FR-011.

## 1. User Story Statement
* **As a** Persona B, business process owner (PRD 1.3)
* **I want** a simple web form (a link, or embedded on a page of mine) that starts my active workflow when someone fills it in
* **So that** people who have no system that can send webhooks can still feed the workflow, while spam, floods and double submits start no extra runs (0 runs from rejected submissions in the test suite)

---

## 2. Business Context & Description
* **Background:**
  - **Stretch, cut first if late (Q72).** Priority Could Have. Not needed for the Dec 31 pilot (the pilot uses the webhook, NZR-35). Start only if NZR-34/35/36/38 are done or safely on track at the C3 mid-point check.
  - NZR-13 contract types include `form` and `embed`; this story switches them on through the same check pipeline NZR-35 builds (`src/adapters/triggers/webhook.ts`).
  - A browser cannot keep a shared secret, so forms cannot use HMAC signing. Instead: a short-lived **form token** (signed by the server when the form page loads), a **honeypot** (a hidden field real people leave empty), strict rate limits, a small body cap and a **submission id** used as the idempotency key.
  - **Embed** = the same form shown inside an `<iframe>` on the owner's site. Only origins listed on the trigger may frame it.
  - SECURITY T5 applies (S, T, D, I); SECURITY §5.10: pilot triggers point only at partner-controlled systems, so a public form in the pilot needs the owner's yes and stays off by default.
* **Current behaviour (d1d3a66):**
  - No form route. The web app shows the sign-in page for every path when there is no token (`AuthGate`, `web/src/App.tsx:106-119`), so a public form cannot be a page of the signed-in SPA.
  - `secureHeaders()` runs on every response (`src/server.ts:87`); Hono's default sends `X-Frame-Options: SAMEORIGIN` and no CSP, so an embed on another origin is blocked today.
  - After NZR-35: `buildTriggerRouter()` with kill switch `workflow_triggers_disabled`, `checkAndConsumeStrict` limits, uniform 401, trigger items `TRIGGER#<id>/META`, `startRun()` with idempotency (`src/lib/engine/start-run.ts`, NZR-34).
* **Target behaviour:**
  - `GET /f/:triggerId` returns a small server-rendered HTML form (no React, no login) built from the trigger's input field list (text, long text, email, number, date, select; no file upload in v1), with a hidden form token, a hidden submission id and a honeypot field.
  - `POST /f/:triggerId` (form-encoded) checks: kill switch → body cap 64 KB → install-wide limit → trigger lookup (kind `form` or `embed`, active) → form token (signature, ≤ 60 min old) → honeypot empty → per-trigger limit (default 10/min, max 60/min) → strict field schema → idempotency (submission id) → `startRun`. Then it shows "Thanks, we got it." with no run details.
  - Embed: `GET /f/:triggerId?embed=1` sends `Content-Security-Policy: frame-ancestors <listed origins>` and no `X-Frame-Options`; any other route keeps today's headers.
  - Admins create form/embed triggers with the NZR-35 admin API (`kind: 'form' | 'embed'`, `allowedOrigins` for embed).
* **Out of scope:**
  - File uploads, CAPTCHA services (Cloudflare Turnstile would add an outbound flow + secret; a follow-up if spam shows up), custom styling, multi-page forms, a form builder screen (fields come from the workflow's trigger contract).
  - Integrations and schedules (later).
* **Target Value:** a valid submission starts exactly one run; in the spam test, of 100 submissions in one minute only the configured limit (10) start runs and the rest get 429; bot submissions with the honeypot filled start 0 runs.
* **User Persona Profile:** Persona B, business process owner (PRD 1.3). PRD: [foundation/PRD.md](../foundation/PRD.md).

---

## 3. Acceptance Criteria (Confirmation)
*Use the BDD (Behavior-Driven Development) "Given-When-Then" format for clarity.*

### Scenario 1: Form submit starts a run
* **Given** an active workflow with form trigger `trg_F` whose fields are `name` (text, required, ≤ 200) and `details` (long text, ≤ 5000)
* **When** someone opens `GET /f/trg_F`, fills both fields and submits
* **Then** the page has a `<form method="post">` with inputs `name`, `details`, hidden `_t` (form token), hidden `_sid` (UUID), and an empty honeypot `website` hidden from view and from screen readers (`aria-hidden`, `tabindex="-1"`); the POST returns `200` HTML containing "Thanks, we got it."; `startRun` was called once with `trigger: { kind: 'form', triggerId: 'trg_F' }`, `idempotencyKey: <_sid>`, `input: { name, details }`; audit `trigger_received` with `bodySha256` only
* **Test:** `src/adapters/triggers/form.test.ts` › "renders the form and a valid submit starts one run"

### Scenario 2: Spam and floods
* **Given** `trg_F` with limit 10/min
* **When** (a) 100 valid submissions arrive within one minute; (b) a submission has the honeypot filled; (c) the form token is missing, forged or older than 60 min; (d) the body is 65,537 bytes
* **Then** (a) 10 start runs, 90 get `429` HTML "Too many submissions. Try again in a minute." with `Retry-After`; (b) `200` "Thanks, we got it." (the bot is not told) and `startRun` is not called; (c) `400` HTML "This form expired. Reload the page and try again."; (d) `413`; rejections are audited aggregated (≤ 1 `trigger_rejected` row per trigger per minute per reason with `detail.count`)
* **Test:** `src/adapters/triggers/form.test.ts` › "limits a flood to the configured rate", "silently drops honeypot submissions", "refuses a missing, forged or expired form token", "refuses an oversized body"

### Scenario 3: Double submit
* **Given** a person clicks Submit twice (same `_sid`)
* **When** both POSTs arrive
* **Then** one run exists, both responses show "Thanks, we got it."
* **Test:** `src/adapters/triggers/form.test.ts` › "a double click starts one run"

### Scenario 4: Bad input
* **Given** a submission with `name` empty, or an extra field `admin=1`, or `details` over 5000 characters
* **When** it arrives
* **Then** `422` HTML re-renders the form with the person's values kept and a message under each bad field ("Please fill this in.", "This is too long (5000 characters max)."); unknown fields are dropped and audited as `code: 'unknown_field'`; `startRun` is not called
* **Test:** `src/adapters/triggers/form.test.ts` › "re-renders with field errors and starts nothing"

### Scenario 5: Embed only on listed sites
* **Given** embed trigger `trg_E` with `allowedOrigins: ['https://partner.example']`
* **When** `GET /f/trg_E?embed=1` is requested
* **Then** the response has `Content-Security-Policy: frame-ancestors https://partner.example` and no `X-Frame-Options` header; `GET /f/trg_F` (plain form) and every other route (e.g. `/dashboard`, `/health`) still send `X-Frame-Options: SAMEORIGIN`
* **Test:** `src/adapters/triggers/form.test.ts` › "embed allows only listed origins"; `src/server.headers.test.ts` › "other routes keep X-Frame-Options"

### Scenario 6: Off, disabled or not active
* **Given** (a) kill switch `workflow_triggers_disabled`; (b) a disabled or unknown trigger id; (c) a workflow with no active version
* **When** the form is opened or submitted
* **Then** (a) `503` HTML "This form is not taking submissions right now."; (b) `404` HTML "Form not found." (same for unknown and disabled); (c) `GET` shows the same 503 text and `POST` returns 503 without calling `startRun`
* **Test:** `src/adapters/triggers/form.test.ts` › "kill switch closes forms", "unknown and disabled look the same", "no active version"

---

## 4. Technical Notes & Constraints
* **Dependencies:** [NZR-35 / US-035](US-035-triggers-webhook-api.md) Triggers: webhook + API
* **Builds on (other merged work; formal dependency changes are proposed in NOTES-H-live-deploy.md, not made here):** (pipeline, admin API, secrets, limits). Also NZR-34 `startRun`, NZR-36 active versions.
* **UI/UX Design:** design.md has no row for a public form page (NO-MOCK-YET). A plain mock (form, thanks, expired, too many, field errors, closed) is needed before the step starts (Q77). Copy strings above are the starting point.
* **Non-Functional Requirements:** body ≤ 64 KB; per-trigger default 10/min (max 60/min); install-wide 600/min shared with webhooks; form token TTL 60 min; page weight ≤ 30 KB, no external scripts or fonts; WCAG 2.2 AA labels and error text. Limits in [CONSTRAINTS.md](../foundation/CONSTRAINTS.md).
* **Data & Analytics:** `trigger.received`, `trigger.rejected` with `triggerKind: 'form' | 'embed'` (events defined in NZR-35). Written to the existing audit log as a separate product event type with no personal data (Q55); catalogue in OBSERVABILITY.md (NZR-44). Never field values, never IP.

**Files to change**
| path | change |
|---|---|
| `src/server.ts:87` | Keep `secureHeaders()` for every route except `/f/*`; mount `/f` with its own headers (default `X-Frame-Options: SAMEORIGIN`, embed variant with CSP `frame-ancestors`) |
| `src/server.ts:89-90` | `app.route('/f', buildFormRouter())` beside `/hooks`, `/tg`, `/slack` |
| `src/lib/triggers/triggers-repo.ts` (NZR-35) | Accept kinds `form`, `embed`; new attribute `allowedOrigins[]` (embed only, each `https://` origin, ≤ 5) |
| `src/adapters/dashboard/triggers.ts` (NZR-35) | Create body accepts `kind: 'form' | 'embed'`, `allowedOrigins`; response returns `url` = `https://<host>/f/<triggerId>` and no secret (form triggers have none) |
| `src/lib/triggers/input-schema.ts` (NZR-35) | Form-encoded coercion (number, date) before the same strict zod schema |
| `docs/data-flows.json`, `docs/diagrams/architecture-security.md` | Public `/f/*` entry point |

**New files**
| path | purpose |
|---|---|
| `src/adapters/triggers/form.ts` | `buildFormRouter()`: GET render, POST pipeline |
| `src/adapters/triggers/form-html.ts` | Escaped HTML templates (form, thanks, errors, closed); no user value is ever inserted unescaped |
| `src/adapters/triggers/form-token.ts` | `issueFormToken(triggerId, now)` / `verifyFormToken(token, triggerId, now)`: HMAC-SHA256 with an install secret, 60 min TTL |
| `src/adapters/triggers/form.test.ts`, `src/server.headers.test.ts` | Scenarios 1–6 |

**API contract**
- `GET /f/:triggerId[?embed=1]` — public. 200 HTML form · 404 HTML "Form not found." · 503 HTML closed.
- `POST /f/:triggerId` — public, `Content-Type: application/x-www-form-urlencoded` only (415 otherwise). Fields: declared inputs + `_t` + `_sid` (UUID v4) + honeypot `website`. Responses (HTML): 200 thanks (also for honeypot), 400 expired token / bad `_sid`, 404, 413, 415, 422 re-rendered form with errors, 429 with `Retry-After`, 503.
- Admin (NZR-35 routes): `POST /api/workflows/:workflowId/triggers` body `{ kind: 'form' | 'embed', rateLimitPerMin?: 1..60, allowedOrigins?: string[] }` → `201 { triggerId, url }`; `400 { error: 'invalid_body' }` when `embed` has no origins or an origin is not `https://`.

**Data changes**
- `TRIGGER#<id>/META`: `kind` gains `form | embed`; new optional `allowedOrigins`. Expand-only.
- Form-token signing key: one install secret `${app}/trigger/form-token-key` in Secrets Manager (created on first form trigger, same IAM scope as NZR-35 `${app}/trigger/*`).
- No new table. Idempotency via `startRun`.

* **Security notes:**
  - SECURITY T5: S (anyone can submit — mitigated by token + limits, not auth), T (strict schema, form-encoded only), D (body cap, two-level fail-closed limits, aggregated audit), I (uniform 404 for unknown/disabled; thanks page shows nothing about the run).
  - XSS: every value echoed back on a 422 is HTML-escaped; test with `<script>` in each field. No inline event handlers; send `Content-Security-Policy: default-src 'none'; style-src 'self'; form-action 'self'; frame-ancestors …`.
  - CSRF is not a risk here (no session, no cookies), but the form token stops simple replay and scripted posting without loading the page.
  - Pilot: form/embed triggers off unless the owner says yes for the pilot (§5.10); if used, the partner confirms the page is only shared internally.
  - Do not log field values; audit only hashes.
* **Test plan:**
  - Frozen failing tests first: Scenario 2 (spam/flood) and Scenario 5 (headers), red SHA recorded.
  - Unit: `src/adapters/triggers/form.test.ts` (drive the router with `app.request()`; mock `startRun`, repo, rate limits, kill switch, secrets), `form-token.test.ts`, `src/server.headers.test.ts` (build the real `createServer` app and check headers on `/f`, `/health`, `/dashboard`).
  - Fixtures: synthetic field values only.
  - Commands: `npx vitest run src/adapters/triggers src/server.headers.test.ts`; full `npm test`; `node scripts/ci/diagrams-drift.mjs`; `node scripts/ci/secret-scan.mjs <changed files>`.
* **Repo rules that apply:** public route ⇒ ADR line (SECURITY §6); `data-flows.json` updated; no new dependency (no template engine, no CAPTCHA SDK); additive data shape; full `npm test` before push.
* **Rollback:** disable the trigger, or trip `workflow_triggers_disabled`; Cloudflare ingress `/f/*` → 404 on the pilot; image rollback `npm run deploy:rollback -- --class=image --to=previous`.
* **Build slices (proposal):**
  1. *Form page + token + submit* (2 h): `form.ts`, `form-html.ts`, `form-token.ts`, mount. Green: Scenarios 1, 3, 4, 6.
  2. *Spam controls* (1 h): honeypot, limits, body cap, aggregated audit. Green: Scenario 2.
  3. *Embed headers + admin kinds* (1–2 h): server header split, `allowedOrigins`, admin API. Green: Scenario 5.
* **Agent gotchas:**
  - Hono `secureHeaders()` writes its headers after the handler runs, so deleting `X-Frame-Options` inside the `/f` handler does not stick. Split the middleware by path in `server.ts` and prove it with `server.headers.test.ts`.
  - Do not build the form in the React SPA: `AuthGate` shows Login for every path without a token (`web/src/App.tsx:106-119`).
  - The honeypot response must look like success (200 thanks); a 400 teaches bots.
  - Rate-limit key: trigger id + install-wide, never IP alone (tunnel peer IP is loopback, `src/server.ts:140-144`).
  - The per-trigger limit must be consumed only after the form token verifies, or a scripted flood with no token burns the real users' quota.

---

## 5. Estimation & Tracking
* **Epic Name:** M3 Live + pilot (cycle C3 Live (loop 2) + pilot, 2026-12-08 to 2026-12-31)
* **Priority:** Could Have
* **Story Points / Effort Estimate:** 5 (raw estimate 5 h; 1 pt is about 1 h of factory work, rounded to 1/2/3/5/8/13, Q47)
* **Rigor tier:** T3 · **Deploy reach:** local only · **Labels:** stretch, cut-1

---

## 6. Definition of Ready (DoR) Checklist
*Before pulling this story into a sprint:*
- [ ] User persona and "So That" benefit are clear and verified (Persona B; people without systems).
- [ ] Acceptance criteria cover both happy paths and edge cases (6 scenarios: submit, spam/flood, double submit, bad input, embed, closed).
- [ ] UX/UI designs are attached and finalized: form page states mocked (Q77); NO-MOCK-YET today.
- [ ] Dependencies have been identified and are unblocked (NZR-35 merged; C3 mid-point check says the pilot path is on track; Q72 cut order applied if not).
- [ ] The team has reviewed and estimated the story points (5 pts; re-checked at the Nov 9 re-plan, Q71).
- [ ] Task stories (build slices) are written at this step's PLANNING, before code (Q70).

---

## 7. Definition of Done (DoD) Checklist
*Before this story can be marked as complete:*
- [ ] Code is written and follows CLAUDE.md / CONTRIBUTING.md, minimum correct diff (/ponytail).
- [ ] Peer code review is completed and approved. Full review layers incl. one Greptile pass (Q68): fresh Claude critic + security reviewer (XSS, headers, limits) (+ NVIDIA roles after bake-off); owner reviews the security boundary (new public route).
- [ ] A frozen failing test came first (red SHA recorded); `npx vitest run src/adapters/triggers src/server.headers.test.ts` and full `npm test` green on a clean checkout of the exact HEAD.
- [ ] QA: the fresh critic re-runs the gate against these criteria. UAT: the owner fills the form once in a browser and sees one run start.
- [ ] Documentation is updated: feature HANDOFF + a dated session handoff; durable facts promoted to README/ADR (public-route ADR line); `data-flows.json` and security diagram updated.
- [ ] Done = merged to `development` (owner yes for every merge/push, Q50) and verified locally. Staging: PENDING until NZR-42 (AWS account) exists; pilot use only with the owner's yes.
