# NZR-43 UAT transcript (G3)

- Date: 2026-10-24 · Branch `feature/nzr-43-config-secrets` @ 1c60454 · Walker: fresh UAT agent (not the builder)
- App: http://127.0.0.1:3900 (fake local stack, Floci emulator, no real AWS, no model calls)
- Persona: Persona E. Live requests use the **owner / env root token only** (masked as `****`). The local app cannot mint seat-user, viewer, operator or admin sessions, or flip the `audit_log_disabled` kill switch, or make DynamoDB or the audit writer fail. Those parts are covered by the story's named unit tests (run below, 27/27 green).
- Live script: `/root/.hermes/netzar-runner/runs/NZR-43/uat-walk.mjs`; per-scenario live verdicts: `uat-live.json`.

## Coverage per scenario

| # | Live (owner) | Unit tests run (other roles / states) | Result |
|---|---|---|---|
| 1 | 6/6 reads 200, same shapes, `themes/library` byte-identical | F43-6 (viewer + seat-user) ✓; matrix `GET /config/profile` all tiers ✓ | PASS |
| 2 | 6/6 → `403 {"error":"forbidden_category"}` | F43-1, F43-2, F43-3, F43-8 (all tiers; no store call, no `config_updated`) ✓; matrix `GET /config/oauth` ✓ | PASS |
| 3 | 4/4 identical 403 body (incl. `OAUTH`, `oau%74h`) | F43-4 (no store call) ✓ | PASS |
| 4 | 5/5: `****abcd`, `base_url` unchanged, `"bearerToken":"****wxyz"`, POST echo `****zzzz`, audit row `****abcd`→`****zzzz` with no raw secret | F43-5, F43-9 (setConfig gets real value; logger.warn masked) ✓; `isSecretConfigKey…`, `maskConfigValue…` ✓ | PASS |
| 5 | 4/4 admin-side (owner) 200 on power/alerting/jarvis/paperclip | F43-10 (viewer/operator 403 matrix) ✓; matrix `GET /config/power` ✓ | PASS |
| 6 | 1/1 `config_access_denied` row visible in `GET /api/audit` with names only | F43-7 (exact writeAudit payload) ✓; `config_access_denied survives audit_log_disabled` ✓ | PASS |
| 7 | not reproducible live (store/audit can't be failed locally) | F43-7b ✓ | PASS (unit) |
| 8 | owner step (rotation after merge, HANDOFF record) | N/A | PENDING-OWNER |

## Unit test run

`npx vitest run src/adapters/dashboard/config-secrets.test.ts src/lib/state/config-policy.test.ts src/adapters/dashboard/authz-matrix.test.ts src/lib/audit/audit-writer.test.ts -t "F43-|isSecretConfigKey matches|maskConfigValue masks nested|Runtime config read|config_access_denied survives"`

```
✓ authz-matrix › Runtime config read (GET /config/power) — security:read › viewer DENIED / operator DENIED / admin ALLOWED / owner ALLOWED
✓ authz-matrix › Runtime config read (GET /config/oauth) — denied for every tier › viewer/operator/admin/owner DENIED
✓ authz-matrix › Runtime config read (GET /config/profile) — dashboard:read › viewer/operator/admin/owner ALLOWED
✓ config-secrets › F43-1 GET /config/oauth refuses every tier, owner included
✓ config-secrets › F43-2 GET /config/:category/:key refuses oauth, oauth_state and mcp keys
✓ config-secrets › F43-3 GET /config?category=oauth is refused like the path form
✓ config-secrets › F43-4 refuses a category that is not on the allowlist, in any spelling
✓ config-secrets › F43-5 masks a secret-shaped key inside an allowed category
✓ config-secrets › F43-6 serves the categories the SPA reads unchanged to a viewer and a seat-user
✓ config-secrets › F43-7 audits each refusal as config_access_denied with names only
✓ config-secrets › F43-7b a failing audit write or store never turns a refusal into a 200
✓ config-secrets › F43-8 POST /config/oauth/* is refused even for the owner and never writes
✓ config-secrets › F43-9 config_updated audit, log line and echo never carry a secret-shaped value
✓ config-secrets › F43-11 a secret pasted into reason is masked in the log line and the config_updated row
✓ config-secrets › F43-10 security-tier and integrations-tier categories refuse lower tiers
✓ audit-writer › expanded always-audited set (C5c) › config_access_denied survives audit_log_disabled
✓ config-policy › isSecretConfigKey matches secret names and not tunables
✓ config-policy › maskConfigValue masks nested JSON fields and leaves untouched JSON byte-identical
Test Files 4 passed (4) · Tests 27 passed | 133 skipped (160)
```

Note: the live server log line (Scenario 4, `logger.warn` masking) was not inspected live. It is covered by F43-9 / F43-11.

# Live request/response transcript (owner token masked)

## Scenario seed: state setup via owner writes

```
POST /api/config/profile/first_name
Authorization: Bearer ****  (owner/env root token)
body: {"value":"Ada"}
-> 200
{"ok":true,"category":"profile","key":"first_name","value":"Ada"}
```
- PASS: seed profile/first_name -> 200
```
POST /api/config/cost/report_async_enabled
Authorization: Bearer ****  (owner/env root token)
body: {"value":"true"}
-> 200
{"ok":true,"category":"cost","key":"report_async_enabled","value":"true"}
```
- PASS: seed cost/report_async_enabled -> 200
```
POST /api/config/branding/company_name
Authorization: Bearer ****  (owner/env root token)
body: {"value":"Acme"}
-> 200
{"ok":true,"category":"branding","key":"company_name","value":"Acme"}
```
- PASS: seed branding/company_name -> 200
```
POST /api/config/memory/ingest_every_n_turns
Authorization: Bearer ****  (owner/env root token)
body: {"value":"5"}
-> 200
{"ok":true,"category":"memory","key":"ingest_every_n_turns","value":"5"}
```
- PASS: seed memory/ingest_every_n_turns -> 200
```
POST /api/config/themes/library
Authorization: Bearer ****  (owner/env root token)
body: {"value":"[{\"id\":\"t1\",\"name\":\"Dusk\"}]"}
-> 200
{"ok":true,"category":"themes","key":"library","value":"[{\"id\":\"t1\",\"name\":\"Dusk\"}]"}
```
- PASS: seed themes/library -> 200
```
POST /api/config/paperclip/base_url
Authorization: Bearer ****  (owner/env root token)
body: {"value":"https://pc.internal"}
-> 200
{"ok":true,"category":"paperclip","key":"base_url","value":"https://pc.internal"}
```
- PASS: seed paperclip/base_url -> 200
```
POST /api/config/paperclip/api_key
Authorization: Bearer ****  (owner/env root token)
body: {"value":"sk-live-1234567890abcd"}
-> 200
{"ok":true,"category":"paperclip","key":"api_key","value":"****abcd"}
```
- PASS: seed paperclip/api_key -> 200
```
POST /api/config/media/servers_json
Authorization: Bearer ****  (owner/env root token)
body: {"value":"{\"items\":[{\"id\":\"a\",\"bearerToken\":\"tok-abcdefgh1234wxyz\"}]}"}
-> 200
{"ok":true,"category":"media","key":"servers_json","value":"{\"items\":[{\"id\":\"a\",\"bearerToken\":\"****wxyz\"}]}"}
```
- PASS: seed media/servers_json -> 200
```
POST /api/config/power/url
Authorization: Bearer ****  (owner/env root token)
body: {"value":"https://power.example.invalid"}
-> 200
{"ok":true,"category":"power","key":"url","value":"https://power.example.invalid"}
```
- PASS: seed power/url -> 200
```
POST /api/config/alerting/recipients
Authorization: Bearer ****  (owner/env root token)
body: {"value":"ops@example.invalid"}
-> 200
{"ok":true,"category":"alerting","key":"recipients","value":"ops@example.invalid"}
```
- PASS: seed alerting/recipients -> 200
```
POST /api/config/jarvis/routine_1
Authorization: Bearer ****  (owner/env root token)
body: {"value":"daily-brief"}
-> 200
{"ok":true,"category":"jarvis","key":"routine_1","value":"daily-brief"}
```
- PASS: seed jarvis/routine_1 -> 200
```
POST /api/config/paperclip/enabled_agents
Authorization: Bearer ****  (owner/env root token)
body: {"value":"ops"}
-> 200
{"ok":true,"category":"paperclip","key":"enabled_agents","value":"ops"}
```
- PASS: seed paperclip/enabled_agents -> 200

## Scenario 1: Allowed categories work as before

```
GET /api/config/profile/first_name
Authorization: Bearer ****  (owner/env root token)
-> 200
{"category":"profile","key":"first_name","value":"Ada"}
```
- PASS: profile/first_name {category,key,value} = Ada
```
GET /api/config/cost/report_async_enabled
Authorization: Bearer ****  (owner/env root token)
-> 200
{"category":"cost","key":"report_async_enabled","value":"true"}
```
- PASS: cost/report_async_enabled = "true"
```
GET /api/config/themes
Authorization: Bearer ****  (owner/env root token)
-> 200
{"category":"themes","values":{"library":"[{\"id\":\"t1\",\"name\":\"Dusk\"}]"}}
```
- PASS: themes {category,values} with library byte-identical
```
GET /api/config/branding
Authorization: Bearer ****  (owner/env root token)
-> 200
{"category":"branding","values":{"company_name":"Acme"}}
```
- PASS: branding company_name = Acme
```
GET /api/config/memory/ingest_every_n_turns
Authorization: Bearer ****  (owner/env root token)
-> 200
{"category":"memory","key":"ingest_every_n_turns","value":"5"}
```
- PASS: memory/ingest_every_n_turns = "5"
```
GET /api/config
Authorization: Bearer ****  (owner/env root token)
-> 200
{"categories":{"cost":{"cap_enabled":"false","daily_cap_usd":"50","ledger_enabled":"false","ledger_reserve_usd":"0.5","remediation_enabled":"false","report_async_enabled":"true","watch_enabled":"false"},"sessions":{},"rate_limits":{}}}
```
- PASS: GET /api/config -> {categories:{cost,sessions,rate_limits}}

## Scenario 2: Secret categories refused on every route (owner)

```
GET /api/config/oauth
Authorization: Bearer ****  (owner/env root token)
-> 403
{"error":"forbidden_category"}
```
- PASS: GET /api/config/oauth -> 403 forbidden_category
```
GET /api/config?category=oauth
Authorization: Bearer ****  (owner/env root token)
-> 403
{"error":"forbidden_category"}
```
- PASS: GET /api/config?category=oauth -> 403 forbidden_category
```
GET /api/config/oauth/slack_app_ops
Authorization: Bearer ****  (owner/env root token)
-> 403
{"error":"forbidden_category"}
```
- PASS: GET /api/config/oauth/slack_app_ops -> 403 forbidden_category
```
GET /api/config/mcp/servers
Authorization: Bearer ****  (owner/env root token)
-> 403
{"error":"forbidden_category"}
```
- PASS: GET /api/config/mcp/servers -> 403 forbidden_category
```
GET /api/config/oauth_state/abc
Authorization: Bearer ****  (owner/env root token)
-> 403
{"error":"forbidden_category"}
```
- PASS: GET /api/config/oauth_state/abc -> 403 forbidden_category
```
POST /api/config/oauth/slack_client_secret
Authorization: Bearer ****  (owner/env root token)
body: {"value":"x"}
-> 403
{"error":"forbidden_category"}
```
- PASS: POST /api/config/oauth/slack_client_secret -> 403 forbidden_category

## Scenario 3: Unknown categories refused by default (owner ≥ admin)

```
GET /api/config/no_such_category
Authorization: Bearer ****  (owner/env root token)
-> 403
{"error":"forbidden_category"}
```
- PASS: GET /api/config/no_such_category -> identical 403 body
```
GET /api/config/OAUTH
Authorization: Bearer ****  (owner/env root token)
-> 403
{"error":"forbidden_category"}
```
- PASS: GET /api/config/OAUTH -> identical 403 body
```
GET /api/config/oau%74h/x
Authorization: Bearer ****  (owner/env root token)
-> 403
{"error":"forbidden_category"}
```
- PASS: GET /api/config/oau%74h/x -> identical 403 body
```
POST /api/config/no_such_category/k
Authorization: Bearer ****  (owner/env root token)
body: {"value":"x"}
-> 403
{"error":"forbidden_category"}
```
- PASS: POST /api/config/no_such_category/k -> identical 403 body

## Scenario 4: Secret-shaped values masked

```
GET /api/config/paperclip
Authorization: Bearer ****  (owner/env root token)
-> 200
{"category":"paperclip","values":{"api_key":"****abcd","base_url":"https://pc.internal","enabled_agents":"ops","poll_interval_ms":"15000","poll_overlap_ms":"2000","poll_page_limit":"500","reconciler_mode":"shadow"}}
```
- PASS: paperclip api_key ****abcd, base_url unchanged
```
GET /api/config/paperclip/api_key
Authorization: Bearer ****  (owner/env root token)
-> 200
{"category":"paperclip","key":"api_key","value":"****abcd"}
```
- PASS: paperclip/api_key -> ****abcd
```
GET /api/config/media/servers_json
Authorization: Bearer ****  (owner/env root token)
-> 200
{"category":"media","key":"servers_json","value":"{\"items\":[{\"id\":\"a\",\"bearerToken\":\"****wxyz\"}]}"}
```
- PASS: media/servers_json bearerToken ****wxyz
```
POST /api/config/paperclip/api_key
Authorization: Bearer ****  (owner/env root token)
body: {"value":"sk-new-9999999999zzzz"}
-> 200
{"ok":true,"category":"paperclip","key":"api_key","value":"****zzzz"}
```
- PASS: POST echo value ****zzzz
```
GET /api/audit?limit=50
Authorization: Bearer ****  (owner/env root token)
-> 200
{"days":1,"count":23,"rows":[{"PK":"DAY#2026-10-24","SK":"2026-10-24T14:35:21.585Z#600c452e-edc0-4fa8-acdc-8c407a5dda97","GSI1PK":"AGENT#system","GSI1SK":"2026-10-24T14:35:21.585Z#600c452e-edc0-4fa8-acdc-8c407a5dda97","id":"600c452e-edc0-4fa8-acdc-8c407a5dda97","ts":"2026-10-24T14:35:21.585Z","action":"config_updated","surface":"dashboard","result":"ok","userId":"b904028e3d3dcff0","operatorLabel":"Root token","detail":{"category":"paperclip","key":"api_key","oldValue":"****abcd","newValue":"****zzzz"}},{"PK":"DAY#2026-10-24","SK":"2026-10-24T14:35:21.542Z#c9f5e59e-aef9-47b6-9d21-9c7da718536f","GSI1PK":"AGENT#system","GSI1SK":"2026-10-24T14:35:21.542Z#c9f5e59e-aef9-47b6-9d21-9c7da718536f","id":"c9f5e59e-aef9-47b6-9d21-9c7da718536f","ts":"2026-10-24T14:35:21.542Z","action":"config_access_denied","surface":"dashboard","result":"blocked","userId":"dashboard:b904028e3d3dcff00587110d618e982a3f397d22f95661f9a0b06a974c29d18d","detail":{"category":"no_such_category","key":"k","method":"POST","reason":"unknown_category","event":"security.config_denied"}},{"PK":"DAY#2026-10-24","SK":"2026-10-24T14:35:21.536Z#4173d130-e969-4796-8c85-232cf84b7328","GSI1PK":"AGENT#system","GSI1SK":"2026-10-24T14:35:21.536Z#4173d130-e969-4796-8c85-232cf84b7328","id":"4173d130-e969-4796-8c85-232cf84b7328","ts":"2026-10-24T14:35:21.536Z","action":"config_access_denied","surface":"dashboard","result":"blocked","userId":"dashboard:b904028e3d3dcff00587110d618e982a3f397d22f95661f9a0b06a974c29d18d","detail":{"cate …[truncated]
```
- PASS: audit has config_updated with oldValue ****abcd / newValue ****zzzz, no raw secret

## Scenario 5: Sensitive categories need higher capability (admin side live)

```
GET /api/config/power/url
Authorization: Bearer ****  (owner/env root token)
-> 200
{"category":"power","key":"url","value":"https://power.example.invalid"}
```
- PASS: owner (≥admin) /api/config/power/url -> 200
```
GET /api/config/alerting/recipients
Authorization: Bearer ****  (owner/env root token)
-> 200
{"category":"alerting","key":"recipients","value":"ops@example.invalid"}
```
- PASS: owner (≥admin) /api/config/alerting/recipients -> 200
```
GET /api/config/jarvis/routine_1
Authorization: Bearer ****  (owner/env root token)
-> 200
{"category":"jarvis","key":"routine_1","value":"daily-brief"}
```
- PASS: owner (≥admin) /api/config/jarvis/routine_1 -> 200
```
GET /api/config/paperclip/enabled_agents
Authorization: Bearer ****  (owner/env root token)
-> 200
{"category":"paperclip","key":"enabled_agents","value":"ops"}
```
- PASS: owner (≥admin) /api/config/paperclip/enabled_agents -> 200

## Scenario 6: Refusals audited

```
GET /api/config/oauth/slack_app_ops
Authorization: Bearer ****  (owner/env root token)
-> 403
{"error":"forbidden_category"}
```
```
GET /api/audit?limit=50
Authorization: Bearer ****  (owner/env root token)
-> 200
{"days":1,"count":24,"rows":[{"PK":"DAY#2026-10-24","SK":"2026-10-24T14:35:21.628Z#10981e23-83af-4ea0-8b40-6ac6cdce1703","GSI1PK":"AGENT#system","GSI1SK":"2026-10-24T14:35:21.628Z#10981e23-83af-4ea0-8b40-6ac6cdce1703","id":"10981e23-83af-4ea0-8b40-6ac6cdce1703","ts":"2026-10-24T14:35:21.628Z","action":"config_access_denied","surface":"dashboard","result":"blocked","userId":"dashboard:b904028e3d3dcff00587110d618e982a3f397d22f95661f9a0b06a974c29d18d","detail":{"category":"oauth","key":"slack_app_ops","method":"GET","reason":"secret_category","event":"security.config_denied"}},{"PK":"DAY#2026-10-24","SK":"2026-10-24T14:35:21.585Z#600c452e-edc0-4fa8-acdc-8c407a5dda97","GSI1PK":"AGENT#system","GSI1SK":"2026-10-24T14:35:21.585Z#600c452e-edc0-4fa8-acdc-8c407a5dda97","id":"600c452e-edc0-4fa8-acdc-8c407a5dda97","ts":"2026-10-24T14:35:21.585Z","action":"config_updated","surface":"dashboard","result":"ok","userId":"b904028e3d3dcff0","operatorLabel":"Root token","detail":{"category":"paperclip","key":"api_key","oldValue":"****abcd","newValue":"****zzzz"}},{"PK":"DAY#2026-10-24","SK":"2026-10-24T14:35:21.542Z#c9f5e59e-aef9-47b6-9d21-9c7da718536f","GSI1PK":"AGENT#system","GSI1SK":"2026-10-24T14:35:21.542Z#c9f5e59e-aef9-47b6-9d21-9c7da718536f","id":"c9f5e59e-aef9-47b6-9d21-9c7da718536f","ts":"2026-10-24T14:35:21.542Z","action":"config_access_denied","surface":"dashboard","result":"blocked","userId":"dashboard:b904028e3d3dcff00587110d618e982a3f397d22f95661f9a0b06a974c29d18d","detail":{"categ …[truncated]
```
- PASS: config_access_denied row present with category/key names, no value field