# Rotate the secrets exposed by `/api/config` (NZR-43)

## Symptom

- Before NZR-43, `GET /api/config/*` returned the `oauth`, `oauth_state` and `mcp` runtime-config categories in plain text to every signed-in principal, seat-user included ([security-findings-2026-08-11 #1](../security-findings-2026-08-11.md)).
- An admin write through `POST /api/config/<category>/<key>` also copied the old and new value into the `config_updated` audit row, which every viewer can read through `GET /api/audit`.
- Treat every secret stored in those categories before the fix as exposed.

## Preconditions

- The NZR-43 patch is merged to `development` and deployed (`npm run deploy:cloud`, image-only). Rotating first would just leak the new values (owner rule Q81).
- Verify the patch is live: a secret category must be refused even for the root token.

```bash
curl -sS -o /dev/null -w "HTTP %{http_code}\n" \
  -H "Authorization: Bearer $DASHBOARD_TOKEN" https://<dashboard-host>/api/config/oauth
# expect: HTTP 403 (body {"error":"forbidden_category"})
```

## What to rotate

Use `GET /api/oauth/status` (booleans only) and the Integrations screen to list what is configured; do **not** read the values back.

| Stored at | Secret | How to rotate | Where to save the new value |
|---|---|---|---|
| `oauth/slack_app_<agentId>` (one per agent) | client secret **and** signing secret | Slack app settings → Basic Information → regenerate Client Secret and Signing Secret | `PUT /api/oauth/slack/credentials` with `{agentId, clientId, clientSecret, signingSecret}` (admin) |
| `oauth/slack_client_secret` | Slack OAuth client secret | Slack app settings → regenerate Client Secret | `PUT /api/oauth/slack/credentials` with `{clientId, clientSecret}` |
| `oauth/salesforce_client_secret` | Connected App consumer secret | Salesforce Setup → App Manager → the Connected App → Manage Consumer Details → generate a new secret | `PUT /api/oauth/salesforce/credentials` |
| `oauth/salesforce_tokens` | refresh + access token | Salesforce Setup → Connected Apps OAuth Usage → **revoke** the app's tokens | re-run the connect flow (`POST /api/oauth/salesforce/start`) |
| `mcp/servers` | every `bearerToken` (including the Slack MCP user token from the OAuth callback) | revoke each token at its issuer (Slack: revoke the user token / reinstall the app) | Integrations screen (`PUT /api/integrations/mcp`), or re-run the Slack OAuth connect |
| `oauth_state/*` | single-use PKCE verifiers | nothing to rotate: rows are single-use and short-lived | none |

After each Slack signing-secret change, send a test event to that agent's Slack webhook and confirm it is accepted. Events signed with the old secret must now fail verification.

## Who read them: what the logs can and cannot say

- Config **reads** were never audited before NZR-43. No audit query can say who read `/api/config/oauth` or `/api/config/mcp`. Do not claim otherwise in the HANDOFF.
- Since NZR-43, every refused read writes an always-audited `config_access_denied` row (category and key names only).
- Exposed old values in audit rows: `tsx scripts/audit-query.ts run config-exposure` prints the saved Athena query (all `config_updated` rows on `oauth`/`mcp`/`oauth_state`). The CLI does not execute it: run the printed SQL in the Athena console against the `audit_log` table. UNVERIFIED: that table exists in the target install. The fallback is a DynamoDB query on the audit table, `PK = DAY#<yyyy-mm-dd>` for each day of the exposure window, filtered to `action = config_updated`.
- Narrowing reads: ALB access logs (bucket prefix `alb/`, `infra/lib/compute-stack.ts`) carry client IP and time for each `GET /api/config…` request, not identity.
- Record the query output in the feature HANDOFF (section "NZR-43 rotation"). Record the masked keys only, never a value.

## Legacy app (app.pgnos.ai)

Not redeployed (Q84): mark it known-vulnerable. It holds no real data. Rotate its own copies of these secrets the same way (owner yes for each AWS call).

## Record

For each row in "What to rotate", record in the HANDOFF the rotation date, who rotated it, and how it was verified. Then fill in the merge SHA and the rotation date on finding #1 in `docs/security-findings-2026-08-11.md`.

## Rollback

Rotation is never rolled back. If a new credential does not work, fix it forward: generate another one at the issuer and save it through the same dedicated route.
