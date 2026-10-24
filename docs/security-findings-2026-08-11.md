# Production security findings — 2026-08-11

Adversarial audit of the `production` branch source (byte-identical to
`development`; verified by empty `git diff` over `src`, `infra`, `web`,
`scripts`). Six parallel dimension audits — authn/session, authorization,
agent-tool boundary, data exposure/audit integrity, AWS IAM/secrets, and input
validation/DoS — each attacked by an independent skeptic before a finding was
allowed to stand. **26 findings survived verification; 5 were refuted.**

Scope note: this is **static analysis of source**, including `infra/lib/*.ts` as
the CDK *definition* of infrastructure. The live AWS account was not scanned, so
configuration drift outside CDK (console-edited IAM, hand-changed bucket
policies or security groups, unrotated seeded secrets) is **unassessed**.

Threat model used: (T1) a lower-privileged authenticated principal escalating
inside one deployment, (T2) prompt injection into an agent, (T3) an
unauthenticated external attacker, (T4) exfiltration or audit evasion.
Cross-tenant isolation is explicitly *not* in scope — the deployment is the
tenant boundary per [ADR 0002](adr/0002-single-tenant.md).

---

# Netzar OS Enterprise — Production Remediation List

The honest headline: **four issues are genuinely serious.** One of those (Jarvis `ROLE_RANK`) is already fixed on `hotfix/missions-authz` but is not in production. Everything below the "Ship now" cut is either a narrow-population capability gap or an audit-completeness problem — real, worth fixing, not worth a page.

I verified the working tree directly at `/Users/emmanueladams/Documents/Github Reposetories/Netzer-Labs`. `hotfix/missions-authz` diffs against `origin/production` across 9 files and touches `registry.ts`, `authorize-read.ts`, `route-manifest.ts` and the three missions routes in `handler.ts` — it does **not** touch `src/lib/mcp/mcp-tools.ts`, which matters below.

---

## Ship now

### 1. `GET /api/config/*` has no capability gate and returns live OAuth secrets, Salesforce refresh tokens and MCP bearer tokens in plaintext — **critical, exploitable today**
`src/adapters/dashboard/handler.ts:2160` (`/config?category=`), `:2178` (`/config/:category`), `:2186` (`/config/:category/:key`)

**Status (NZR-43):** fixed on branch `feature/nzr-43-config-secrets`, pending merge to `development` (merge SHA to be filled in at merge). The generic `/api/config*` routes now refuse `oauth`, `oauth_state` and `mcp` for every principal, refuse unknown categories by default, and mask secret-shaped values; evidence: `src/adapters/dashboard/config-secrets.test.ts`. The fix differs from the one proposed below: a per-category allowlist (`src/lib/state/config-policy.ts`) instead of a single `config:read` capability. Legacy app.pgnos.ai is known-vulnerable and not patched (Q84); its secrets and the ones exposed here are rotated after merge per `docs/runbooks/rotate-config-secrets.md` (rotation date: pending, owner step). Config reads were never audited before this fix, so who read the secrets cannot be established from the audit log.

The lowest principal in the model — `seat-user`, whose entire capability set is `['dashboard:read','usage:self:read']` (`src/lib/auth/permissions.ts:252-255`) — can `GET /api/config/oauth` and receive every secret the OAuth flow has ever stored. There is no `hasCapability()` call in any of the three route bodies. The only gate is the router-wide middleware at `handler.ts:782-833`, whose sole authorization step is `if (ROLE_RANK[principal.role] < ROLE_RANK[need])` (`:825-826`), and `requiredRole` scopes its `/config` rule to writes only:

```
handler.ts:236   if (subPath.startsWith('/config') && method !== 'GET') return 'admin';
handler.ts:244   if (method === 'GET') return 'viewer';
```

`ROLE_RANK.viewer === 0`, so the comparison is `0 < 0` — always false. `getConfigCategory` returns the partition verbatim: `values[item.SK] = item.value` (`src/lib/state/runtime-config-repo.ts:116`), no redaction, no category allowlist.

What is actually in that partition: `setConfig('oauth','salesforce_tokens', JSON.stringify(tokens))` (`src/adapters/dashboard/oauth.ts:103`, also `src/lib/salesforce/client.ts:64`), `slack_client_secret` / `salesforce_client_secret` (`oauth.ts:262,266`), `slack_app_<agentId>` carrying `{clientId, clientSecret, signingSecret}` (`oauth.ts:249`), and the MCP server array with bearer tokens preserved through `sanitize` (`src/lib/mcp/servers-repo.ts:145-146`, written at `:187` under `CATEGORY='mcp'`/`KEY='servers'`, `:12-13`).

The system already knows this data is sensitive. `src/adapters/dashboard/integrations.ts:117-131` gates the *same* MCP registry on operator rank and strips the token with the comment that it never leaves the API; `src/adapters/dashboard/oauth.ts:140-178` gates on operator and returns booleans only. The generic reader serves it raw to rank 0. The route's own stale comment explains how this happened — `handler.ts:2157-2159`: *"Values are plain tunables (cost cap, idle timeout) so they are safe to echo back."*

Escalation beyond credential theft: the leaked per-agent `signingSecret` is the exact value verified at `src/adapters/slack/handler.ts:270` on the per-agent Slack webhook, converting a viewer-tier read into an inbound-event forgery primitive (T2 injection). (The *main* `/slack/events` webhook verifies against `process.env.SLACK_SIGNING_SECRET`, `slack/handler.ts:62,71`, so that one is unaffected.)

**Fix:** add `if (!(await hasCapability(c, 'config:read')))` to all three handlers, and redact known-secret keys (`*_secret`, `*_token*`, `slack_app_*`, `mcp/servers`) server-side regardless of capability. The SPA never calls `/api/config` (no reference under `web/src`), so nothing breaks.

### 2. Jarvis `authorize-read.ts` gated only on `ROLE_RANK` — **fixed on `hotfix/missions-authz`, not yet in production**
`src/lib/jarvis/authorize-read.ts`

A `seat-user`, which `roleForProfileId` (`handler.ts:537-549`) collapses to legacy role `viewer` via its subset test, could read every viewer-tier Jarvis resource by voice while holding no per-tab read capability. Same root cause as #1: legacy rank standing in for the capability model. The hotfix rewrites `authorize-read.ts` (+20) and `route-manifest.ts` (+56) with tests. **Merge and deploy.**

### 3. Any Telegram user can self-disable the Bedrock prompt-injection guardrail with `/warroom` — **high, exploitable today (T2)**
`src/agent/commands.ts:180-188`, `src/lib/warroom/orchestrator.ts:223`, `src/lib/warroom/tool-policy.ts:6-10`

War Room turns run with `skipGuardrail: true` (`orchestrator.ts:223`) — a deliberate decision, because the multi-speaker transcript shape trips `PROMPT_ATTACK`. The problem is who can enter one. The dashboard route is correctly gated (`src/adapters/dashboard/warroom.ts:115,159` via `hasWarroomWrite`), but `src/agent/commands.ts:180` implements a `/warroom` slash command any chat user can type: it calls `createMeeting` with `participants = known.slice(0, 5)` (`:184`) and `setWarroomMode` (`:188`), with **no capability check anywhere on that path**. Thereafter `src/adapters/telegram/handler.ts:171-190` routes every subsequent message from that chat through `orchestrateWarroomTurn`.

The containment that remains is the tool blocklist, and it is incomplete:
```
tool-policy.ts:6-10   const DEFAULT_BLOCKED = ['send_dm','create_mission','forget_memory']
```
`ask_agent` and `log_to_hive` are absent. `ask_agent` runs a full synchronous turn as the target agent (`src/lib/tools/agent-tools.ts:112-126`) and passes **neither `blockedTools` nor `skipGuardrail`** to the nested turn, so the room's policy does not propagate. `log_to_hive` (`agent-tools.ts:254`) writes into the shared table that `buildSystemPrompt` injects into every agent's future system prompt (`src/agent/agent-loop.ts:246-260`) — a persistent cross-agent injection channel.

Net: an uncapability'd chat principal turns off the injection defense for their own turns and fans them out to five agents that retain cross-agent reach.

**Fix (two lines):** add `'ask_agent'` and `'log_to_hive'` to `DEFAULT_BLOCKED` at `tool-policy.ts:6-10`, and gate the `/warroom` command in `commands.ts:180` behind an owner/allowlist check. Longer term, propagate `blockedTools` into the nested turn at `agent-tools.ts:115`.

### 4. `dynamodb_query` binds reads to the agent partition but not the chat — cross-user memory and transcript reads — **high, exploitable today**
`src/lib/tools/dynamodb-tools.ts:110-115`

```
function authorizePk(entry, pk, agentId) {
  if (entry.scope === 'open') return null;
  const own = `AGENT#${agentId}`;
  if (pk === own || pk.startsWith(`${own}#`)) return null;
```
`ctx.chatId` is never referenced anywhere in the file. Both `sessions` and `memories` are `scope: 'agent'` (`dynamodb-tools.ts:54-67`), and their SKs are chat-keyed — `SK: CHAT#{chatId}` (`src/lib/state/sessions-repo.ts:3-6`), `SK = MEM#<chatId>#...` (`src/lib/state/memories-repo.ts:4-6`). `redact()` (`dynamodb-tools.ts:229-237`) strips only `PK`/`SK`/`GSI*`/`ttl`, leaving `content`, `userId`, `firstMessage`, `surface`.

The asymmetry is unmistakable: `src/lib/tools/memory-tools.ts:117,152,193` and `src/lib/tools/schedule-tools.ts:222` all filter on `ctx.chatId`. Chat binding was simply never applied here; `dynamodb-tools.test.ts` has cases for own-partition, other-agent partition and prefix collision, and zero for chat scoping.

Reachable by (a) any Telegram/Slack chat principal, who holds no capability at all, and (b) any prompt-injected agent turn on any surface. **Not** reachable from a low-tier dashboard principal: `POST /test-turn` falls through `requiredRole` to `'operator'` (`handler.ts:245`). Per-call leakage is bounded by `JSON.stringify(r).slice(0, 500)` (`dynamodb-tools.ts:213`), which comfortably fits a memory `content` field — exactly the name/location/timezone facts memory-ingest is told to capture.

**Fix:** in `authorizePk`, for `scope: 'agent'` entries on chat-keyed tables, additionally require the model-supplied `skPrefix` to be pinned to `ctx.chatId`.

### 5. Telegram ingress authenticates the platform but never the sender — **medium, but it is the delivery vehicle for #3 and #4**
`src/adapters/telegram/handler.ts:56-78`, then `:114`

The webhook secret check is unconditional and fail-closed (correct — it 401s even when the secret is unset, `:72-78`). After that, the next statements are the JSON parse, `parseUpdate`, and `void handleMessage(...)` at `:114`. There is no check on `msg.chatId` or `msg.userId`. The comment at `:61-66` references an "F13 allowlist" that has no implementation — `grep -rn allowlist src` returns only IAM-action, MCP-server, cost-key and Jarvis-canary allowlists. `resolveOwnerChatId` (`src/lib/agent/owner-alias.ts:41-62`) is a namespace alias, not a gate: a non-match falls through to `?? msg.chatId` (`handler.ts:107`).

Telegram bot usernames are globally addressable, so anyone on the platform can open a DM and drive a full agent turn — the slash-command router, war-room orchestrator (#3), media ingest, and the full tool loop (#4). They also reach `s3_vectors_search` (`src/lib/tools/vector-tools.ts:37-80`), which scopes to the *agent's* knowledge scope plus `SHARED_KNOWLEDGE_SCOPE` with no per-chat partition, so the org corpus is semantically queryable by a stranger with citations.

**Fix:** an env-driven sender allowlist (`CCE_ALLOWED_TELEGRAM_CHATS`) checked immediately after `parseUpdate` at `handler.ts:83`, defaulting to closed. Slack is materially different — workspace membership bounds it — so scope this to Telegram.

### 6. `ToolRegistry.invoke` wrote no audit row — **fixed on `hotfix/missions-authz`, not yet in production** — but MCP dispatch is still unaudited *after* the hotfix
`src/lib/tools/registry.ts` (fixed, +56), `src/lib/mcp/mcp-tools.ts:93-140` (**not** fixed)

The hotfix commit ("record every tool dispatch centrally in ToolRegistry") touches `registry.ts`, `registry.test.ts` and `dynamodb-tools.test.ts` only. MCP is a **separate dispatch path** — `src/agent/agent-loop.ts:1016-1018` branches `isMcpToolName(tu.name) ? await invokeMcpTool(...) : await tools.invoke(...)`, so `ToolRegistry.invoke` is never reached for an `mcp__*` tool. `grep writeAudit src/lib/mcp/` returns nothing; `invokeMcpTool` emits only `emitToolMetric` on all four paths. MCP is where the externally-effectful vendor-write tools live and servers are runtime-configured with no redeploy (per `CLAUDE.md`), so "which agent, on whose behalf, called which vendor write tool" stays unanswerable post-hotfix. This is the easiest gap in the list to believe is closed when it is not.

**Fix:** merge the hotfix, **and** add the same `writeAudit` call to `invokeMcpTool` at `mcp-tools.ts:119-132`.

### 7. The four `/api/missions*` routes wrote no audit rows — **fixed on `hotfix/missions-authz`, not yet in production**
`src/adapters/dashboard/handler.ts:3103,3148,3186`

The hotfix adds `mission_created`, `mission_status_changed` and `mission_reassigned` rows, including an `assignedBy: explicit | auto` discriminator — correct, since auto-assign feeds attacker-influenced prompt text to a model that picks the owner. The routes themselves are capability-gated in production; this is trail completeness, not access. **Merge with the rest.**

---

## Fix soon

- **Inter-agent inbox text is interpolated into the recipient's system prompt with no tag neutralization** — `src/agent/agent-loop.ts:262-271` injects `t.messageText.slice(0, 240)` raw between `<inbox>`/`</inbox>`, while twelve lines above `:254` does `.replace(/</g,'‹').replace(/>/g,'›')` for hive notes with a comment about exactly this. Write side is unfiltered (`src/lib/state/inter-agent-tasks-repo.ts:50-63`, `agent-tools.ts:196-207`). The system prompt is outside guardrail inspection (`agent-loop.ts:96-97`). Marginal risk over the accepted hive design is *forging pseudo-XML structure*, not getting untrusted text in at all. **Fix: apply the same two-replace at `:266`, or call the already-exported `sanitizeForHive` (`src/agent/memory-ingest.ts:98`).**

- **`GET /api/agents/:agentId/history/:revId` returns full CLAUDE.md revision bodies with no gate** — `handler.ts:1086-1092` does a bare `c.json(rev)` where `body` is populated (`src/lib/state/agent-file-history-repo.ts:159`). The sibling list route deliberately projects it away (`chars: r.body.length`, `handler.ts:1081`) and `GET /agents/:agentId/file` is gated on `agents:read` (`handler.ts:1008-1010`), so the asymmetry is unintentional. Escalation set is narrow — viewer and above already hold `agents:read` and can read the current body. **Fix: `agents:read` check on both history routes.**

- **`send_email` bypasses the block-severity DLP scan** — `scanOutboundReply` (`src/agent/agent-loop.ts:427-433`) covers only the model's reply text; tool *arguments* are never scanned (`scanForExfil` has exactly three non-test call sites: `agent-loop.ts:433`, `dashboard/dlp.ts:30`, `jarvis/safe-egress.ts:98`). An AWS access key or PEM key that would be redacted out of a reply leaves unexamined in an email body. The audit row records `{messageId, to: to.length, cc: cc.length, subjectLen}` (`src/lib/tools/email-tools.ts:169-181`) — no addresses, no body hash, so it cannot answer "where did this go". Default-off (`registerIfConfigured`, `email-tools.ts:74-86`). The absence of a recipient allowlist is product intent, not a gap. **Fix: scan tool args for BLOCK-severity patterns before dispatch; add a recipient-domain list and body hash to the audit detail.**

- **Leftmost `X-Forwarded-For` is trusted — audit source IP is attacker-chosen** — `handler.ts:580-586` takes `split(',')[0]`; an ALB *appends* the real client address to the right, and no `routing.http.xff_header_processing` attribute exists anywhere under `infra/`. Every `login_request`/`login_failure` row (`handler.ts:636,709,719,729`) and every `auth_failure` row (`handler.ts:788-805`) stamps that value, and the true origin is persisted nowhere. Same pattern at `src/adapters/dashboard/jarvis.ts:1646`. The rate-limit half is weaker than it looks: magic tokens are 32 random bytes single-use (`src/lib/state/users-repo.ts:244-274`), `/login` retains a per-email cap (`handler.ts:601-604`), so what is lost is the fail-closed 10/300 unauthenticated ceiling (DDB write amplification, enumeration cover) — not an authn bypass. **Fix: rightmost XFF entry with a trusted-proxy count, at both `handler.ts:582` and `jarvis.ts:1646`.**

- **War Room accepts the full session bearer from `?token=`, and it never expires** — `extractBearerToken` falls back to `return queryToken ?? ''` (`src/lib/auth/dashboard-auth.ts:183`); `src/adapters/dashboard/warroom.ts:97` is the only caller passing the second argument, and the SPA uses it (`web/src/pages/WarRoom.tsx:333`, same value as the `Authorization` header at `:282`). ALB access logging is unconditional (`infra/lib/compute-stack.ts:828`) with 730-day retention (`infra/lib/storage-stack.ts:115-132`). `mintSessionToken` (`handler.ts:479-489`) omits `expiresInDays`, so `tokens-repo.ts:128-135` writes no `expiresAt` and `isExpired` returns false forever. Not a T3 exposure — the bucket blocks all public access and grants no read to the task role — but it is a durable full-privilege credential readable by any in-account IAM principal with S3 read, a materially wider set than dashboard RBAC. The codebase already solved this: `src/lib/jarvis/ws-ticket.ts` mints a 30s single-use scoped ticket for exactly this reason. **Fix: migrate War Room SSE to the ws-ticket pattern; give session tokens an absolute expiry.**

- **`operatorIdentity` is the caller-controlled `X-Dashboard-User` header, and it is the only identity on agent-prompt edits** — `handler.ts:184-188` returns `dashboard:${raw}` verbatim; `handler.ts:1043` passes it as `editedBy` into `saveAgentFile`, which writes it as the audit `detail` with no `userId` (`src/lib/state/agent-file-history-repo.ts:111-123`) and into S3 object metadata (`:199-203`). The type itself documents the header as untrusted — *"Never use as canonical identity"* (`src/lib/audit/audit-writer.ts:208`) — and `dashboardIdentity` (`handler.ts:190-198`), which hashes the bearer, is used correctly elsewhere (`handler.ts:2341`). Requires `agents:write` already, so it is repudiation, not escalation: the trail cannot distinguish two operators who edited an agent's system prompt, and with no header it reads `dashboard:anonymous`. **Fix: add `dashboardIdentity(c)` alongside `editedBy` on both call sites (`:1043`, `:3020`).**

- **No request-body size limit anywhere** — `grep -rn "bodyLimit|Content-Length|maxBodySize" src/ infra/` returns zero matches; `buildApp` installs only `secureHeaders()` (`src/server.ts:66`). The unauthenticated `POST /api/auth/login` buffers the whole body at `handler.ts:629-631` *before* `authRateLimited` runs. WAF `SizeRestrictions` only lands at tier 2+ (`infra/lib/constants.ts:231,247,267`), so a default tier-0/1 deploy has nothing between the internet and `c.req.json()`. Availability only. The authenticated `POST /api/ingest` (`handler.ts:2311+`, accepts `contentBase64`) is a bigger instance of the same gap. **Fix: global `bodyLimit` middleware in `server.ts:66`.**

- **`GET /api/inbox` has no capability gate** — `handler.ts:2976-2980`, four lines, `agentId` straight from the query string into `listInbox`, which queries the whole `AGENT#<toAgent>` partition and returns `messageText`, `fromChat`, `toChat`, `intent` (`src/lib/state/inter-agent-tasks-repo.ts:29-40,81-99`). Every neighbour is gated — `/sessions/transcript` on `sessions:read` (`:2987`), `/export` on `sessions:read` (`:3002`), `/memories` on `memories:read` (`:2129`). Low because the gain accrues only to `seat-user` and custom profiles lacking `sessions:read`; viewer and above already read richer data through gated routes; agent ids are not enumerable (`/api/agents` *is* gated at `:900-904`; `/agents/templates` at `:1095` serves only the static catalog), so an attacker is limited to `main` and guesses; payload capped at 50 rows with a 7-day TTL. **Fix: `agents:read` check at `:2977`.**

- **`GET /api/export` is gated only on `sessions:read` but returns five surfaces** — `handler.ts:2998-3006` checks one capability, while `exportChatData` (`src/lib/tools/privacy-tools.ts:78-125`) returns memory `content`, scheduled `promptText`, inbox `messageText` and mission `title`/`body` — each of which has its own independent read capability elsewhere. The route's own comment ("Carries the same per-chat data the Sessions tab reads", `:2999-3001`) is factually wrong; the Sessions tab's export is a separate route (`:3430-3434`). No templated profile escalates: viewer+ holds all five, `seat-user` lacks `sessions:read` entirely and is 403'd. Requires an admin to have built a custom profile with `sessions:read` but not the others. **Fix: check all five capabilities.**

- **`POST /api/vectors/upload-url` gates a write credential on a read capability** — `handler.ts:2367-2382` checks `vectors:read` (viewer-tier) then calls `presignUploadUrl`, which signs a bare `PutObjectCommand` with `expiresIn: 300`, no content-type, no length range, no checksum (`src/lib/vectors/store.ts:41-64`). The two routes it feeds require `agents:write` and carry the comment "*vectors:read is list-only*" (`handler.ts:2308-2312`, `:2388-2392`). Overwrite is closed — `uploadKeyFor` namespaces under `uploads/<uuid>/` and strips the filename (`store.ts:71-74`), `isUploadKey` rejects `..` (`:78-80`) — so impact is storage/cost abuse plus a staging foothold. **Fix: change the check to `agents:write`.**

- **`AuditAppendOnly` Deny does not deliver the immutability its comment claims** — `infra/lib/iam-stack.ts:333-345` denies only `DeleteItem`, `DeleteTable`, `UpdateItem`, while `DdbRW` (`:310-327`) allows `PutItem` (`:318`) and `BatchWriteItem` (`:321`) over the audit table. DynamoDB authorizes a `BatchWriteItem` carrying `DeleteRequest` entries under `dynamodb:BatchWriteItem`, and `PutItem` on an existing `(PK,SK)` is a full overwrite; keys are enumerable (`src/lib/audit/audit-writer.ts:331-333` writes `PK: DAY#<day>, SK: <ts>#<id>`). The comment at `:330-331` — *"audit retention is not audit immutability without this"* — overstates what ships. Low, because no arbitrary-DDB-write primitive exists in `src/` (the audit table is deliberately excluded from the tool allowlist, `src/lib/tools/dynamodb-tools.ts:32-35`; the only `BatchWriteCommand` is hardcoded to the meetings table, `src/lib/warroom/meetings-repo.ts:165`), and at the deployed tier the S3 Object Lock mirror is a genuine compensating control with a write-only grant (`infra/lib/storage-stack.ts:256-266`, `iam-stack.ts:540-553`). **Fix: add the three write actions to the Deny; give the audit writer a narrow separate allow.**

- **`iam:CreatePolicyVersion` on `*` with a Deny that only covers role ARNs** — `infra/lib/iam-stack.ts:1158` in the `IamCopilotWrite` statement; the paired `IamCopilotProtectInfraRoles` Deny (`:1171-1189`) enumerates only role-scoped actions on role resources, so nothing matches a policy ARN. **Not exploitable by any T1–T4 actor**: `CreatePolicyVersionCommand` is never imported (`src/lib/aws/iam-copilot.ts:19-29`), `applyIam` is a closed six-member switch (`:326-390`), and the router rejects anything outside `APPLY_ACTIONS` (`src/adapters/dashboard/iam-copilot.ts:110-112`). The statement is also gated on `CCE_IAM_COPILOT_WRITE === '1'` (`iam-stack.ts:1151`), which the production deploy workflow does not set. Least-privilege hygiene. **Fix: drop the unused action; add a policy-resource Deny.**

- **Runtime-config writes log the raw value and store it in a viewer-readable audit row** — `handler.ts:2240-2244` passes `value: body.value` to pino (verbatim into CloudWatch); `:2246-2259` writes `oldValue`/`newValue` into audit `detail`, which `GET /audit/export` emits as `JSON.stringify(r.detail)` (`handler.ts:3367`) behind `audit:read` — a VIEWER_CAPS capability. `redact.ts` PATTERNS (`:15-24`) match neither an OAuth client secret nor an MCP bearer. Low because the secret variant needs an admin who already holds the secrets, and finding #1 hands the same data to viewers with no admin action. **Fix: allowlist which categories echo values into logs/audit.**

- **PII redaction is inert on the log path, fail-open on cold start, and blind to nested detail** — `redact.ts:5-7` claims to cover pino messages, but `redactSync`/`refreshPiiCache` appear outside `redact.ts` only in `src/lib/audit/audit-writer.ts` and `src/lib/tools/web-search-tools.ts`; `src/observability/logger.ts` has no formatter, only `truncateForLog` (`:39-43`), a pure slice. So flipping `pii_redaction_enabled` silently does nothing for logs. On the audit path, `audit-writer.ts:292,407` call `void refreshPiiCache()` unawaited before the synchronous loop at `:303-306`/`:413-416`, and `redactSync` bails when the cache is cold (`redact.ts:45`) — first-events-only. The durable part: the loop visits only **top-level** string values of `detail`, so nested objects and the top-level `errMessage` are never scanned. **Fix: recurse into `detail`, include `errMessage`, and either wire a pino hook or correct the docstring.**

- **Public `/status/data.json` echoes raw AWS SDK error strings** — `src/adapters/status/data.ts:245-247,251-253,263-265` push `${source}: ${msg}` into `sourceErrors`, returned at `:275` and rendered at `src/adapters/status/view.ts:87-93`. The endpoint is public by design and explicitly carved out of both WAF ACLs (`infra/lib/security-stack.ts:177-194,354-372`). An `AccessDenied` from `cloudwatch:DescribeAlarms` embeds the account id, assumed-role name and task id. Fires only in a degraded state; reconnaissance, not access. **Fix: replace `sourceErrors` entries with a coarse marker.**

- **Fire-and-forget handlers with no terminal catch, under a process-wide `process.exit(1)`** — `src/adapters/telegram/handler.ts:114`, `src/adapters/slack/handler.ts:125,298` all `void` their handlers; `src/index.ts:152-155` exits the process on `unhandledRejection`. The prologue is unguarded: `getSession` (`src/lib/state/sessions-repo.ts:114-124`) propagates verbatim and is awaited at `handler.ts:138,171` before the `try` at `:310`. The most reachable throw site is `src/adapters/telegram/media.ts:63-66` (`await fetch` + `await metaResp.json()`, neither guarded) — a 502 HTML body from `api.telegram.org` kills the task. Reliability, not an attacker primitive: the webhook secret check is fail-closed, so the attacker's only lever is sending a message; the crash needs an independent dependency failure. **Fix: terminal `.catch` on all three `void` sites; log-and-continue on `unhandledRejection`.**

---

## Accepted / not a finding

- **Cross-tenant isolation.** Single-tenant by accepted decision (`docs/adr/0002-single-tenant.md`); no `tenantId` in any partition key, deliberately. Isolation is at the AWS account boundary.
- **Operator/admin/owner power.** `config:write` first appears in `OPERATOR_CAPS` (`src/lib/auth/permissions.ts:222`); admins holding secrets, editing agent prompts and running purges is their job.
- **`GET /api/notifications` "detection oracle" (refuted).** The missing gate at `handler.ts:3177-3252` is real but three of four disclosures are non-findings: the CloudWatch alarm rows and the derived `auth_anomaly` signal (`handler.ts:3232`) are byte-for-byte the same data served **unauthenticated** at `GET /status/data.json` (`src/adapters/status/handler.ts:146-150` over `data.ts:59-64`, "intentionally public"), and kill-switch reads / spend-vs-cap map to `kill-switches:read` and `overview:read`, both VIEWER_CAPS. Residual: a `seat-user` sees kill-switch names and spend percentage without the matching caps. Worth a consistency fix; no detection-evasion value; not T4.
- **`ask_agent` default `allowed_agents: '*'` (refuted).** A hardening knob, not a gap. `send_dm` in the same file (`src/lib/tools/agent-tools.ts:156-212`) permits messaging any known agent with **no** allowlist knob at all, so tightening `ask_agent`'s default changes nothing about cross-agent reach. `ask_agent` has a deliberate guard set (kill switch, recursion cap of 1, no self-ask, 2000-char cap) and an audit row on every call (`:131-143`). The real issue is the War Room blocklist gap in Ship-now #3.
- **ALB `DirectHost` listener rule (refuted).** `infra/lib/compute-stack.ts:918-928` does forward on Host header alone, but the regional WAF carries an identical `limit: 2000` rate rule and is associated with the ALB (`infra/lib/security-stack.ts:83-125,233-238`), the code itself disclaims the header gate as a boundary (`security-stack.ts:255-259`: the bearer auth is the real boundary), and the rule is load-bearing pre-CloudFront-cutover (`compute-stack.ts:948-953`). Residual is a wrong comment at `compute-stack.ts:890-896` claiming direct ALB hits 403.
- **Orphan `execute-api:ManageConnections` grant (refuted).** `infra/lib/iam-stack.ts:866-872` grants it on a wildcard API id with no API Gateway anywhere in the repo. Grants nothing today; hypothetical future harm is cross-workload blast radius inside one account, which the single-tenant ADR puts at the account boundary. Hygiene backlog.
- **`GET /api/vectors` heap exhaustion (refuted).** `iterateRows` (`src/lib/vectors/store.ts:246-282`) is an async generator yielding one row at a time; `listDocuments` (`:214-244`) retains only per-document summaries. Nothing accumulates. The scope prefix always appends a trailing slash, so no value yields the bare `index/` prefix. Residual is an unbounded S3 fan-out — latency and request cost, not memory.
- **Slack sender identity.** Unlike Telegram, Slack ingress is bounded by workspace membership; "any user" there means "any workspace member", which is intended product behaviour.
- **Dashboard `POST /test-turn` as a low-tier attack path.** Does not exist: `requiredRole` returns `'operator'` for any non-GET path not specially cased (`handler.ts:245`), and `roleForProfileId` (`:537-549`) uses a subset rule, so only a profile holding the entire operator template reaches operator rank.

---

## Open questions

1. **Is `CCE_IAM_COPILOT_WRITE=1` set in the live production deploy?** `.github/workflows/deploy.yml:184-206` does not set it; `scripts/deploy.ts:1197` defaults it empty; only `.github/workflows/cdk-drift.yml` sets it, for a `cdk diff`. Meanwhile `docs/out-of-band-catalog.json` says a *live-attached* managed policy `CCE-IamCopilot` exists, whose CDK equivalent (`infra/lib/iam-stack.ts:1051-1092`) does **not** grant `CreatePolicyVersion`. Needs an `aws iam list-attached-role-policies` against the real task role to settle which statement is actually live.
2. **Which integrations are wired in the deployed instance?** Finding #1's gate is missing unconditionally, but the severity of the *payload* depends on whether the OAuth Connect flow has populated `oauth/*` and `mcp/servers`. A one-line check of the runtime-config table's `CONFIG#oauth` and `CONFIG#mcp` partitions tells you whether this is a critical live secret leak or a pre-positioned one.
3. **Is the deployed tier actually ≥ 2?** `deploy.yml:43` defaults `CCE_TIER` to `'3'`, which is what makes the S3 Object Lock audit mirror (`infra/lib/storage-stack.ts:256-266`) a real compensating control for the `AuditAppendOnly` gap and makes the WAF `SizeRestrictions` rule present for the body-limit gap. Confirm against the running stack — both findings step up a level at tier 0/1.
4. **Does the model actually obey a forged `</inbox><operating_directive>` in 240 characters?** The structural gap at `agent-loop.ts:266` is unambiguous from code; whether it converts to action is a runtime question. Fix regardless — it is one line.
5. **Is the `/warroom` slash command intended to be self-service for chat users?** The dashboard equivalent is operator-gated (`warroom.ts:115,159`); the chat path is not (`commands.ts:180`). If self-service is a product requirement, the guardrail decision at `orchestrator.ts:223` needs revisiting rather than the command being locked down.
6. **Who holds `s3:GetObject` on the ALB logs bucket?** `grep -rn logsBucket infra/lib/` shows no grant to the ECS task role, so no agent pivot — but the set of observability/CI/auditor IAM principals determines how bad the War Room token-in-URL leak actually is. Not answerable from this repo.
