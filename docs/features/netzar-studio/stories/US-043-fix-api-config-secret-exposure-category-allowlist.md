# [US-043] Fix /api/config secret exposure: category allowlist, server-side deny, masking

> Backlog task NZR-43 ([backlog](../backlog.md)). Plan story: [US-000](US-000-netzar-studio-rebuild.md). Requirement IDs: NFR-007, FR-015.

## 1. User Story Statement
* **As a** Persona E, enterprise administrator (PRD 1.3)
* **I want** the runtime-config endpoints (`/api/config*`) to refuse every request for a secret category and to mask any secret-shaped value they do return
* **So that** no signed-in user, admin included, can read our OAuth, Slack signing or MCP credentials, and permission tests show 0 secret values leaving the API

---

## 2. Business Context & Description
* **Background:**
  * Grill round 4, Q81: the most severe open item. It lands **first**, before NZR-5, because both edit `src/adapters/dashboard/handler.ts`. Owner rules: category allowlist (default deny), server-side deny for secret categories, masking; rotate the exposed secrets only **after** the patch merges; check the audit log for who read them.
  * Q84: the legacy app (app.pgnos.ai) is **not** redeployed. It is marked known-vulnerable, holds no real data, and its secrets are rotated (owner yes for each AWS call).
  * Source finding: [security-findings-2026-08-11 #1](../../../security-findings-2026-08-11.md); threat B1/I and risk #2 in [SECURITY.md](../foundation/SECURITY.md).
  * PRD IDs: NFR-007 (security), FR-015.
* **Current behaviour (d1d3a66):**
  * Three read routes, no capability check in any body: `GET /config?category=` (`handler.ts:2941-2946`), `GET /config/:category` (`handler.ts:2959-2963`), `GET /config/:category/:key` (`handler.ts:2967-2972`). The comment at `handler.ts:2938-2940` still says "values are plain tunables … safe to echo back".
  * The only gate is the router middleware (`handler.ts:1427-1435`). `requiredRole` returns `viewer` for every GET (`handler.ts:464`; the `/config` rule at `:456` covers non-GET only). `viewer` is rank 0 (`handler.ts:420`), so every authenticated principal passes, including `seat-user`, whose capability set is only `dashboard:read` + `usage:self:read` (`src/lib/auth/permissions.ts:252-255`).
  * `getConfigCategory` returns the whole DynamoDB partition `CONFIG#<category>` with no filter (`src/lib/state/runtime-config-repo.ts:99-127`); `getConfig` returns one value (`:69-94`). Note: `grep` reports this file as binary because the cache key uses a NUL separator (`:57`); use `grep -a`.
  * Secrets stored in runtime-config today:
    * `oauth` category — 8 `setConfig('oauth', …)` call sites (7 single-line + 1 multi-line): `salesforce_tokens` (`src/adapters/dashboard/oauth.ts:103`, `src/lib/salesforce/client.ts:64`), `slack_client_secret` (`oauth.ts:262`), `salesforce_client_secret` (`oauth.ts:266`), `slack_app_<agentId>` = JSON `{clientId, clientSecret, signingSecret}` (`oauth.ts:248-258`), plus non-secret `slack_client_id`, `salesforce_client_id`, `salesforce_login_url` (`oauth.ts:261,265,268`). The leaked per-agent `signingSecret` is the value the per-agent Slack webhook verifies, so a reader can forge inbound Slack events (finding #1, "Escalation").
    * `mcp` category, key `servers` — one JSON array whose `bearerToken` survives `sanitize` (`src/lib/mcp/servers-repo.ts:12-13`, `:145-147`, written at `:187`); the Slack MCP user token lands here from the OAuth callback (`oauth.ts:84-100`).
    * `oauth_state` category — single-use PKCE rows including `codeVerifier` (`src/lib/oauth/state-repo.ts:18`, `:50`).
  * The same data is already redacted on its dedicated routes: `GET /api/integrations/mcp` strips `bearerToken` (`src/adapters/dashboard/integrations.ts:117-131`); `GET /api/oauth/status` returns booleans only (`oauth.ts:140-178`). The generic reader bypasses both.
  * Write path leaks too: `POST /config/:category/:key` (`handler.ts:2974-3043`) is admin-only (`handler.ts:456`) but (a) accepts `oauth`/`mcp`/`oauth_state` keys, (b) logs the raw new value with `logger.warn` (`:3023-3026`), (c) writes `oldValue` and `newValue` in plain text into the `config_updated` audit row (`:3028-3041`), and (d) echoes the value (`:3042`). Audit rows are readable by every viewer through `GET /audit` (`audit:read`, `handler.ts:2761-2771`; viewer holds it, `permissions.ts:204`). So one admin write to `oauth/salesforce_tokens` publishes the old token to every viewer.
  * Config **reads are never audited** (no `writeAudit` in `handler.ts:2941-2972`). The audit actions are a closed union (`src/lib/audit/audit-writer.ts:57-206`) with no read or deny action for config.
  * SPA readers of `/api/config` (all must keep working): `web/src/lib/api.ts:770-789` (client); `Settings.tsx:139` (`profile/first_name`), `Settings.tsx:145` (`cost/report_async_enabled`), `Settings.tsx:143` → `theme.ts:629` (`themes` list), `theme.ts:272` (`branding` list), `Cost.tsx:454` (`cost/watch_enabled`), `HiveMind.tsx:44-45` (`memory/*`), `routes/Jarvis.tsx:290-291` (`profile/first_name`). Writers: `Settings.tsx:170,325`, `Jarvis.tsx:306`, `IamCopilot.tsx:77` (`iam/apply_enabled`), `theme.ts:491,496`, `Cost.tsx:512`, `HiveMind.tsx:75-76`. No SPA screen reads `oauth`, `oauth_state` or `mcp` through `/api/config` (grep of `web/src`).
* **Target behaviour:**
  * One policy table, `CONFIG_POLICY`, names every category the generic routes serve and the capability each needs. A category not in the table is refused (default deny).
  * `oauth`, `oauth_state` and `mcp` are refused on all four routes for every principal, owner and env root token included. Their dedicated routes (`/api/oauth/*`, `/api/integrations/mcp`) stay the only way to set or inspect them.
  * Every refusal returns the same `403 {"error":"forbidden_category"}` and writes an always-audited `config_access_denied` row carrying the category and key names only.
  * Any value whose key looks like a secret (in any allowed category, including inside a JSON value) is masked as `****` + last 4 characters (`****` alone when the value is shorter than 12 characters), on read responses, the write echo, the `config_updated` audit row and the log line.
  * The SPA screens listed above behave exactly as today for every role.
  * After merge: the owner rotates every secret stored in `oauth` and `mcp`, records the date, and records what the logs can and cannot say about who read them. The legacy app is marked known-vulnerable.
* **Out of scope:**
  * Moving the secrets out of runtime-config into Secrets Manager (proposed follow-up; see NOTES).
  * `/vectors*` scope checks (NZR-5, US-005) and chat files (NZR-6, US-006).
  * Other open B1 items: `X-Dashboard-User` editor identity, leftmost `X-Forwarded-For`, `GET /inbox` gate, body limits (SECURITY.md 2a).
  * Deploying anything to the legacy app (Q84).
* **Target Value:** 0 secret values returned by any `/api/config*` route or written to any `config_updated` audit row, measured by the frozen tests F43-1 to F43-10 (all green) across 5 principal tiers (seat-user, viewer, operator, admin, owner). Exposure window and rotation date recorded in the feature HANDOFF within 2 days of merge.
* **User Persona Profile:** Persona E, enterprise administrator (PRD 1.3). PRD: [foundation/PRD.md](../foundation/PRD.md).

---

## 3. Acceptance Criteria (Confirmation)
*Use the BDD (Behavior-Driven Development) "Given-When-Then" format for clarity.*

### Scenario 1: Allowed categories work as before for the screens that use them
* **Given** a viewer (and separately a seat-user) and runtime-config holding `profile/first_name=Ada`, `cost/report_async_enabled=true`, `themes/library=[…]`, `branding/company_name=Acme`, `memory/ingest_every_n_turns=5`
* **When** they call `GET /api/config/profile/first_name`, `GET /api/config/cost/report_async_enabled`, `GET /api/config/themes`, `GET /api/config/branding`, `GET /api/config/memory/ingest_every_n_turns` and `GET /api/config` (no category)
* **Then** each returns 200 with the same body shape as today (`{category,key,value}` or `{category,values}` or `{categories:{cost,sessions,rate_limits}}`) and byte-identical values (no key here is secret-shaped, so nothing is masked and no JSON is re-serialized)
* **Test:** `src/adapters/dashboard/config-secrets.test.ts` › "F43-6 serves the categories the SPA reads unchanged to a viewer and a seat-user"

### Scenario 2: Secret categories are refused to everyone, on every route
* **Given** any principal: seat-user, viewer, operator, admin, owner (env root token)
* **When** they call `GET /api/config/oauth`, `GET /api/config?category=oauth`, `GET /api/config/oauth/slack_app_ops`, `GET /api/config/mcp/servers`, `GET /api/config/oauth_state/abc`, or `POST /api/config/oauth/slack_client_secret` with `{"value":"x"}`
* **Then** each returns `403 {"error":"forbidden_category"}`; `getConfig`, `getConfigCategory` and `setConfig` are never called; no `config_updated` audit row is written
* **Test:** `src/adapters/dashboard/config-secrets.test.ts` › "F43-1 GET /config/oauth refuses every tier, owner included", "F43-2 GET /config/:category/:key refuses oauth, oauth_state and mcp keys", "F43-3 GET /config?category=oauth is refused like the path form", "F43-8 POST /config/oauth/* is refused even for the owner and never writes"

### Scenario 3: Unknown categories are refused by default
* **Given** an admin
* **When** they call `GET /api/config/no_such_category`, `GET /api/config/OAUTH`, `GET /api/config/oau%74h/x` (percent-encoded `oauth`) and `POST /api/config/no_such_category/k`
* **Then** each returns the same `403 {"error":"forbidden_category"}` as Scenario 2 (no difference in status or body between "secret" and "unknown"), and no store call happens
* **Test:** `src/adapters/dashboard/config-secrets.test.ts` › "F43-4 refuses a category that is not on the allowlist, in any spelling"

### Scenario 4: Secret-shaped values are masked wherever they would leave
* **Given** an admin, and `paperclip` holding `base_url=https://pc.internal` and `api_key=sk-live-1234567890abcd`, and `media` holding `servers_json={"items":[{"id":"a","bearerToken":"tok-abcdefgh1234wxyz"}]}`
* **When** they call `GET /api/config/paperclip`, `GET /api/config/paperclip/api_key`, `GET /api/config/media/servers_json`, then `POST /api/config/paperclip/api_key` with `{"value":"sk-new-9999999999zzzz"}`
* **Then** reads return `api_key: "****abcd"`, `base_url` unchanged, and the JSON value with `"bearerToken":"****wxyz"`; the POST stores the real value (`setConfig` receives `sk-new-9999999999zzzz`) but responds `value: "****zzzz"`, and the `config_updated` audit row has `oldValue: "****abcd"`, `newValue: "****zzzz"`; the `logger.warn` call has no unmasked value
* **Test:** `src/adapters/dashboard/config-secrets.test.ts` › "F43-5 masks a secret-shaped key inside an allowed category", "F43-9 config_updated audit, log line and echo never carry a secret-shaped value"; unit cases in `src/lib/state/config-policy.test.ts` › "isSecretConfigKey matches secret names and not tunables", "maskConfigValue masks nested JSON fields and leaves untouched JSON byte-identical"

### Scenario 5: Sensitive but non-secret categories need a higher capability
* **Given** `power/url`, `alerting/recipients`, `jarvis/routine_1` and `paperclip/enabled_agents` exist
* **When** a viewer, an operator and an admin read them
* **Then** `power`, `alerting`, `jarvis`: viewer and operator get `403 {"error":"forbidden_category"}`, admin gets 200; `paperclip`: viewer gets 403, operator and admin get 200
* **Test:** `src/adapters/dashboard/config-secrets.test.ts` › "F43-10 security-tier and integrations-tier categories refuse lower tiers"; matrix rows in `src/adapters/dashboard/authz-matrix.test.ts` › "Runtime config read (GET /config/power) — security:read" and "Runtime config read (GET /config/oauth) — denied for every tier"

### Scenario 6: Every refusal is audited, even with audit suppression on
* **Given** the `audit_log_disabled` kill switch is active
* **When** a viewer calls `GET /api/config/oauth/slack_app_ops`
* **Then** `writeAudit` is called once with `{action:'config_access_denied', surface:'dashboard', result:'blocked', userId:<dashboardIdentity>, detail:{category:'oauth', key:'slack_app_ops', method:'GET', reason:'secret_category', event:'security.config_denied'}}`; the row is written (the action is in `ALWAYS_AUDITED_ACTIONS`); `detail` holds no value field
* **Test:** `src/adapters/dashboard/config-secrets.test.ts` › "F43-7 audits each refusal as config_access_denied with names only"; `src/lib/audit/audit-writer.test.ts` › "config_access_denied survives audit_log_disabled"

### Scenario 7: Degraded mode — the store or the audit writer is down
* **Given** DynamoDB is failing (`getConfigCategory` fails open to `{}`, `runtime-config-repo.ts:121-127`) and the audit write rejects
* **When** a viewer requests `GET /api/config/oauth` and `GET /api/config/profile`
* **Then** `oauth` is still `403 {"error":"forbidden_category"}` (the policy check runs before any store call and does not wait on the audit write); `profile` returns `200 {"category":"profile","values":{}}` as today
* **Test:** `src/adapters/dashboard/config-secrets.test.ts` › "F43-7b a failing audit write or store never turns a refusal into a 200"

### Scenario 8: Rotation after the patch, and the legacy app
* **Given** the patch is merged to `development` (owner yes)
* **When** the owner runs the rotation runbook
* **Then** (a) the HANDOFF records, per secret, the rotation date and who rotated it: every `oauth/slack_app_<agentId>` client secret **and** signing secret, `oauth/slack_client_secret`, `oauth/salesforce_client_secret`, `oauth/salesforce_tokens` (refresh token revoked), every `bearerToken` in `mcp/servers` (Slack MCP user token revoked); (b) the HANDOFF records the output of `tsx scripts/audit-query.ts run config-exposure` (all `config_updated` rows on `oauth`/`mcp`/`oauth_state`, which exposed old values) and states plainly that config **reads** were never audited before this fix, so "who read" can only be narrowed with ALB access-log lines matching `GET /api/config` (bucket prefix `alb/`, `infra/lib/compute-stack.ts:1106`): client IP and time, not identity; (c) `docs/security-findings-2026-08-11.md` finding #1 gets a status line: fixed on `development` at `<sha>`, legacy app.pgnos.ai known-vulnerable and not patched (Q84), its secrets rotated on `<date>`
* **Test:** N/A (owner step). Evidence: the HANDOFF section "NZR-43 rotation" and the saved-query output file `docs/features/netzar-studio/handoffs/<date>-nzr-43-rotation.md`.

---

## 4. Technical Notes & Constraints
* **Dependencies:** None. NZR-5 (US-005) waits for this story because both edit `handler.ts`.
* **UI/UX Design:** N/A: API fix, no screen changes. Settings check done (see Agent gotchas): every key the SPA reads is in an allowed category and none is secret-shaped, so Settings, Cost, Hive Mind, Jarvis greeting and theme reconcile show the same values. What changes for users: nothing in the SPA. What breaks: (1) any hand-run `curl GET /api/config/oauth|mcp|oauth_state` (now 403, intended); (2) viewers and operators lose generic reads of `power`, `alerting`, `jarvis` (no SPA caller); (3) viewers lose `paperclip` (no SPA caller; `docs/features/paperclip/README.md:502` documents the read for operators, still allowed).
* **Non-Functional Requirements:** Default-deny allowlist; check on the server, before any store call; one uniform 403 body; added latency < 1 ms (in-memory table, no extra DynamoDB read). Full `npm test` stays green. Limits in [CONSTRAINTS.md](../foundation/CONSTRAINTS.md).
* **Data & Analytics:** New always-audited action `config_access_denied` (`result:'blocked'`) with `detail.event = 'security.config_denied'`, the product event name from Q55; category/key names and pseudonymous `userId` only, no values. NZR-44 catalogues it in OBSERVABILITY.md.
* **Files to change:**

  | path | change |
  |---|---|
  | `src/adapters/dashboard/handler.ts:2938-2972` | Replace the stale comment. In all three GET routes call `configAccess(c, category, key?, 'read')` first; on refusal return its 403. Mask every returned value with `maskConfigValue`. In the no-category branch (`:2947-2956`) mask each of `cost`, `sessions`, `rate_limits`. |
  | `src/adapters/dashboard/handler.ts:2974-3043` | Call `configAccess(c, category, key, 'write')` before the cost block at `:2988`. Mask `body.value` and `before` in `logger.warn` (`:3023-3026`), the `config_updated` detail (`:3036-3039`) and the response (`:3042`). Store the real value unchanged (`:3022`). |
  | `src/adapters/dashboard/handler.ts` (new local helper near `hasCapability`, `:870-875`) | `configAccess(c, category, key, mode)`: look up `CONFIG_POLICY`; unknown or secret → audit + 403; else `hasCapability(c, policy.read)` for reads → audit + 403 on miss. Writes keep the legacy admin gate (`requiredRole`, `:455-456`) and the cost allowlist (`:2988-3012`). |
  | `src/lib/audit/audit-writer.ts:57-206` | Add `'config_access_denied'` to the `AuditEvent['action']` union. |
  | `src/lib/audit/audit-writer.ts:234-278` | Add `'config_access_denied'` to `ALWAYS_AUDITED_ACTIONS`. |
  | `src/adapters/dashboard/authz-matrix.test.ts:285-399` and `:551-570` | Add matrix rows: `GET /config/oauth` denied for all 4 tiers (body `forbidden_category`, so assert status + body, not `requiredCapability`); `GET /config/power` minTier admin; `GET /config/profile` allowed for all. The mock at `:173-181` already stubs `getConfigCategory`. |
  | `scripts/audit-query.ts:10-16` | Add saved query `config-exposure`: `SELECT ts, userId, operatorLabel, detail FROM audit_log WHERE action='config_updated' AND (detail LIKE '%"category":"oauth"%' OR detail LIKE '%"category":"mcp"%' OR detail LIKE '%"category":"oauth_state"%') ORDER BY ts`. UNVERIFIED: that the Athena `audit_log` table exists in the target install; fallback is a DynamoDB query on `PK=DAY#<day>` for each day of the window. |
  | `docs/diagrams/architecture-security.md` (top comments) | Add a `<!-- drift-gate: verified against NZR-43 … -->` line: generic config routes gain an in-route category policy, no new principal, grant or boundary. Required by `docs/diagrams.map` (maps `handler.ts`) and `node scripts/ci/diagrams-drift.mjs`. |
  | `docs/features/netzar-studio/foundation/SECURITY.md` §2a row B1/I and §7 risk #2 | Mark fixed; cite `src/adapters/dashboard/config-secrets.test.ts` at the merge SHA (Q75 evidence rule). |
  | `docs/security-findings-2026-08-11.md` finding #1 | Status line (Scenario 8c). |

* **New files:**
  * `src/lib/state/config-policy.ts` — `CONFIG_POLICY`, `SECRET_CONFIG_CATEGORIES`, `isSecretConfigKey(key)`, `maskSecret(v)`, `maskConfigValue(key, value)`. Pure, no I/O.
  * `src/lib/state/config-policy.test.ts` — unit tests for the table and masking.
  * `src/adapters/dashboard/config-secrets.test.ts` — frozen route tests F43-1 to F43-10 (pattern: `config-cost-guard.test.ts:17-66`, real router via `app.request()`, `dashboard-auth.js` mocked by role).
  * `docs/runbooks/rotate-config-secrets.md` — owner rotation steps (pattern: `docs/runbooks/rotate-dashboard-token.md`).
* **Policy table (the contract the tests pin):**

  | category | read needs | generic POST | why / who reads |
  |---|---|---|---|
  | `profile`, `branding`, `themes` | `dashboard:read` | admin | Settings, Jarvis, theme boot (every principal incl. seat-user) |
  | `cost` | `dashboard:read` | existing rules `handler.ts:2988-3012` | Settings, Cost, aggregate |
  | `sessions`, `rate_limits`, `memory` | `dashboard:read` | admin | aggregate `:2949`, Hive Mind |
  | `media`, `images`, `agent`, `bedrock`, `delegation`, `drift`, `iam` | `dashboard:read` | admin | server tunables (`scripts/lib/seed-defaults.ts`), IAM toggle write |
  | `paperclip` | `integrations:read` (operator+) | admin | `docs/features/paperclip/README.md:502` |
  | `power`, `alerting`, `jarvis` | `security:read` (admin+) | admin | Function URL (`power.ts:91`), alert emails = personal data (`sns-recipients.ts:37`), routines (`jarvis-routines.ts:21`) |
  | `oauth`, `oauth_state`, `mcp` | **deny, everyone** | **deny** | secrets; dedicated routes only |
  | anything else | **deny** | **deny** | default deny |

  Secret-key rule (`isSecretConfigKey(k)`), exactly: `/(secret|password|passwd|bearer|credential|api[_-]?key|private[_-]?key)/i.test(k) || /(^|[_-])token$/i.test(k) || /[a-z]Token$/.test(k)`. Must match `client_secret`, `clientSecret`, `signingSecret`, `bearerToken`, `api_key`, `apiKey`, `slack_bot_token`, `refresh_token`, `accessToken`; must NOT match `max_output_tokens`, `watch_enabled`, `first_name`, `library`, `active`, `daily_cap_usd`, `base_url`, `hive_promote_min_confidence`.
* **API contract:**
  * `GET /api/config` — needs `dashboard:read` (the read capability of `cost`, `sessions`, `rate_limits`). 200 `{categories:{cost:{…},sessions:{…},rate_limits:{…}}}` (values masked). Unchanged shape.
  * `GET /api/config?category=<c>` and `GET /api/config/<c>` — read capability from the table. 200 `{category, values: Record<string,string>}` (masked). 403 `{error:'forbidden_category'}` for secret, unknown or missing capability. 401 `{error:'unauthorized'}` unchanged. 503 `{error:'dashboard_read_disabled', reason}` unchanged (`handler.ts:1418-1426`).
  * `GET /api/config/<c>/<k>` — as above; 200 `{category, key, value: string|null}` (masked).
  * `POST /api/config/<c>/<k>` — body `{value: string, reason?: string}`. Legacy admin gate unchanged (403 `{error:'forbidden', requiredRole:'admin', yourRole}` for lower roles; `watch_enabled` exception at `:455`). New: 403 `{error:'forbidden_category'}` for secret or unknown categories (checked after the legacy gate, before any read). Existing 403 `{error:'forbidden_key', detail}` (`:2997-3007`) and 400 `{error:'missing_value'}` unchanged. 200 `{ok:true, category, key, value}` with `value` masked.
* **Data changes:** None. No table, key or item shape changes; stored values are untouched. Rollback needs no data step.
* **Security notes:**
  * Threats: SECURITY.md B1/I (config read), A6 (secrets), risk #2; finding #1. New: audit-row leak through `config_updated` `oldValue` (see Current behaviour).
  * Authz rule: category policy first, then capability; the check uses the decoded route param (Hono decodes `%74` → `t`) and exact, case-sensitive match. Identity comes from the session principal only.
  * Uniform 403 body hides whether a category exists or holds secrets.
  * Audit: `config_access_denied` via `writeAudit` (fire-and-forget is acceptable: a refusal returns nothing, so a lost row cannot hide a leak) and always-audited so `audit_log_disabled` cannot hide probing.
  * Secrets handling: values never appear in audit detail, logs or responses in full. Rotation only after merge (Q81). Run `node scripts/ci/secret-scan.mjs <changed files…>` on the diff (SECURITY.md §6). Test fixtures use obviously fake values (`sk-live-1234567890abcd`); confirm the secret scan allowlist accepts them or use `REPLACE_ME`-style strings.
* **Test plan:**
  * Frozen failing tests first, own commit, record the red SHA: F43-1, F43-2, F43-3, F43-4, F43-5, F43-7, F43-8, F43-9, F43-10 (red today). F43-6 and F43-7b are guards (green today, must stay green).
  * Unit: `src/lib/state/config-policy.test.ts` (positive and negative key lists above; mask of 3, 11, 12, 40-character values; nested JSON; non-JSON value starting with `{`; untouched JSON returned as the identical string).
  * Matrix: new rows in `authz-matrix.test.ts`.
  * Existing tests that must stay green unchanged: `src/adapters/dashboard/config-cost-guard.test.ts` (all 6), `authz-matrix.test.ts` › "Cost watch toggle …" and "Rate-limits config write stays admin-only (UNCHANGED)…", `handler.role.test.ts`, `paperclip-dispatch.private.test.ts:179-191`, `src/lib/paperclip/config.ssrf.test.ts`.
  * Commands: `npx vitest run src/adapters/dashboard/config-secrets.test.ts src/lib/state/config-policy.test.ts src/adapters/dashboard/authz-matrix.test.ts src/adapters/dashboard/config-cost-guard.test.ts src/lib/audit/audit-writer.test.ts`, then `npm run typecheck`, then full `npm test`, then `node scripts/ci/diagrams-drift.mjs` and `node scripts/ci/docs-links.mjs`.
* **Repo rules that apply:**
  * `handler.ts` changed ⇒ update `docs/diagrams/architecture-security.md` (mapped in `docs/diagrams.map`), drift gate `scripts/ci/diagrams-drift.mjs`.
  * New audit action ⇒ edit the closed union in `audit-writer.ts`; `writeAudit` (fire-and-forget) for denials, matching `auth_failure` (`handler.ts:1400-1409`).
  * No new capability, so `CAPABILITY_MIN_ROLE` in `src/lib/jarvis/route-manifest.test.ts:165-192` and nav sync (Sidebar `NAV_ITEMS`, `App.tsx`, Jarvis `ROUTE_TABLE`) are not touched.
  * No new dependency. Full `npm test` before push (CLAUDE.md:46, CONTRIBUTING.md:35). Owner yes for every merge/push (Q50). T3: failing test in its own commit first (SECURITY.md §6).
* **Rollback:** `git revert` of the merge commit; no data or flag to restore. Rotated secrets stay rotated (rotation is never rolled back). If one SPA read is wrongly blocked, the fix is one row in `CONFIG_POLICY`, not a revert.
* **Build slices (proposal):**
  1. **Red tests** (~1 h): `config-secrets.test.ts`, `config-policy.test.ts`, matrix rows. Turns nothing green; records red SHA.
  2. **Policy + read routes** (~1.5 h): `config-policy.ts`, `configAccess`, audit action + always-audited, the three GET routes. Turns F43-1..F43-7, F43-10 green.
  3. **Write path masking** (~1 h): POST deny + mask log/audit/echo. Turns F43-8, F43-9 green; full `npm test`.
  4. **Docs + runbook** (~0.5 h + owner time): diagram drift line, SECURITY.md evidence, finding #1 status, saved query, `rotate-config-secrets.md`. Owner rotates after merge.
* **Agent gotchas:**
  * There are **three** read routes and one write route; patching only `/config/:category` leaves `?category=` and `/:category/:key` open.
  * `grep` treats `runtime-config-repo.ts` as binary (NUL in `cacheKey`, `:57`); use `grep -a` or read the file.
  * `setConfig('oauth', …)` appears 8 times, not 7: `oauth.ts:249-258` spans lines, so a single-line grep misses it.
  * Do not re-serialize JSON values unless a field was masked: `themes/library` must come back byte-identical or the theme engine sees a change.
  * `max_output_tokens` (`agent` category) must not be masked; a naive `/token/i` breaks that.
  * The legacy middleware runs first: for POST, a viewer still gets `{error:'forbidden', requiredRole:'admin'}` before the category check. Tests must expect that body for lower roles.
  * Hono decodes path params; test the percent-encoded spelling to prove the check runs on the decoded name.
  * `authz-matrix.test.ts` `expectDenied` asserts `requiredCapability`; the new rows need a status + `forbidden_category` assertion instead.
  * The audit log cannot answer "who read /api/config" (no read rows ever existed). Do not invent a query that claims it can.

---

## 5. Estimation & Tracking
* **Epic Name:** M0 Security fixed (cycle C0 Week 0: factory, security patch, foundation PLAN, 2026-10-20 to 2026-11-01)
* **Priority:** Must Have
* **Story Points / Effort Estimate:** 5 (raw estimate 4 h; 1 pt is about 1 h of factory work, rounded to 1/2/3/5/8/13, Q47)
* **Rigor tier:** T3 · **Deploy reach:** local only · **Labels:** security, urgent

---

## 6. Definition of Ready (DoR) Checklist
*Before pulling this story into a sprint:*
- [ ] User persona and "So That" benefit are clear and verified (Persona E; 0 secret values from `/api/config*`).
- [ ] Acceptance criteria cover both happy paths and edge cases (8 scenarios: allowed, secret, unknown/encoded, masking, capability tiers, audit, degraded, rotation).
- [ ] UX/UI designs: N/A: API fix; the SPA readers listed in section 2 keep working (pinned by F43-6).
- [ ] Dependencies have been identified and are unblocked (none; NZR-5 waits on this).
- [ ] The team has reviewed and estimated the story points (5 pts; re-checked at the Nov 9 re-plan, Q71).
- [ ] Task stories (build slices) are written at this step's PLANNING, before code (Q70).

---

## 7. Definition of Done (DoD) Checklist
*Before this story can be marked as complete:*
- [ ] **Story exit gate (owner rule, all four required on the exact HEAD, evidence block recorded):** (1) code review: fresh critic, findings fixed or owner-waived; (2) unit tests: red SHA then green, full suite + typecheck; (3) UAT: every Given/When/Then scenario marked PASS and accepted; (4) E2E: run through the real entry point, happy + main failure path (or `N/A: reason` for docs/owner tasks). See [story-exit-gate](../story-exit-gate.md). Lessons in [LESSONS.md](../LESSONS.md) checked before PLANNING; any failure adds an entry with a guard. `PENDING` only for a gate needing an environment that does not exist yet (story is then Done locally).
- [ ] Code is written and follows CLAUDE.md / CONTRIBUTING.md, minimum correct diff (/ponytail): `config-policy.ts` + edits to `handler.ts:2938-3043`, `audit-writer.ts`, `authz-matrix.test.ts`, `scripts/audit-query.ts`.
- [ ] Peer code review is completed and approved. Full T3 review layers incl. one Greptile pass (Q68): fresh Claude critic + security reviewer (+ NVIDIA roles after bake-off); owner reviews the security boundary (`CONFIG_POLICY` table and the write-path masking).
- [ ] A frozen failing test came first (red SHA recorded for F43-1..F43-5, F43-7..F43-10); the gate is green on a clean checkout of the exact HEAD: `npx vitest run src/adapters/dashboard/config-secrets.test.ts src/lib/state/config-policy.test.ts src/adapters/dashboard/authz-matrix.test.ts`, `npm run typecheck`, full `npm test`, `node scripts/ci/diagrams-drift.mjs`, `node scripts/ci/secret-scan.mjs <changed files>`.
- [ ] QA: the fresh critic re-runs the gate against these criteria. UAT: N/A, no user-facing change; the owner accepts the evidence summary and the rotation record (Scenario 8).
- [ ] Documentation is updated: feature HANDOFF (incl. "NZR-43 rotation") + a dated session handoff; SECURITY.md cites the test file at the merge SHA; finding #1 status line; `docs/runbooks/rotate-config-secrets.md`; architecture-security drift line.
- [ ] Done = merged to `development` (owner yes for every merge/push, Q50) and verified locally. Staging: PENDING until NZR-42 (AWS account) exists. Legacy app.pgnos.ai: not deployed (Q84), marked known-vulnerable, secrets rotated.

<!-- runner:evidence:start -->
### Story exit gate evidence (runner)

```
Story: NZR-43   HEAD: 1c604540d30c3950a76e3b3c89e71d0280c878fe
G1 code review : PASS  reviewer=claude-opus fresh critic session=5378222d-7343-48c0-a773-2d23c495582d findings=0/5 open_low=5 greptile=not-run
G2 unit tests  : PASS        red=f18a533 green=1c60454 counts=4669/4669 story_files=212/212 typecheck=ok
G2b integration: PENDING run=- (not in runner scope yet, Goal v1)
G3 UAT         : PASS scenarios=7/8 pending_owner=1 accepted_by=owner (Telegram) date=2026-10-24
G4 E2E         : PASS run=docs/features/netzar-studio/evidence/NZR-43/e2e-run.log counts=19/19
G5 Opik eval   : N/A     experiment=- (not in runner scope yet, Goal v1)
Lessons checked: L-001,L-002   New lessons: none
```

- [e2e-run.log](../evidence/NZR-43/e2e-run.log)
- [g1-review.md](../evidence/NZR-43/g1-review.md)
- [gates.md](../evidence/NZR-43/gates.md)
- [uat-live.json](../evidence/NZR-43/uat-live.json)
- [uat-transcript.md](../evidence/NZR-43/uat-transcript.md)
- [uat.json](../evidence/NZR-43/uat.json)
<!-- runner:evidence:end -->
