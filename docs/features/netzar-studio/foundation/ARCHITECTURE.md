---
feature: netzar-studio
document_role: decision
status: draft
observed_at: 2026-10-23
as_of_commit: d1d3a66970cd548f9529a234ef2b51ecdc29378e
---

> Foundation PLAN draft (2026-10-23), written by a read-only review agent and accepted as a draft by the planner. Owner decisions it asks for are in grill round 4 (Q81+). Overrides: [blueprint v2](../blueprint.md) wins on conflict.

# ARCHITECTURE: Netzar Studio rebuild (brownfield, DRAFT)

> **Summary.** Netzar today is one Node 20 / TypeScript Hono server on ECS Fargate. It serves Telegram, Slack, the dashboard API and the Preact SPA, and every AI turn goes through `runAgentTurn()`.
> The rebuild adds a Netzar-owned workflow layer (`src/lib/workflows/`): schema, validator, drafter, preview, and a write-deny sample-data test runner. It reuses the agent loop, tool policy, audit log and cost ledger.
> Nothing in the workflow layer exists yet. Every element marked **TARGET:** is unbuilt. Everything else is cited from the code at `origin/development` d1d3a66.
> The biggest gaps: today's write-deny is not "zero external writes". Retiring Paperclip removes the only Missions engine. The local model path (Floci 1.6.0) cannot run streaming or embeddings yet.
> Owner decisions in `synthesis-round2.md` override blueprint v1: a vertical slice on Nov 10–23, the pilot in PGN's own AWS account, live eval with hashes, and NZR-37 moved to January.

Status: draft for the Foundation PLAN gate. Sources: `docs/features/netzar-studio/blueprint.md`, `backlog.md`, `~/.hermes/netzar-grill/synthesis-round2.md`, the owner PRD (cited by requirement ID), plus the code paths named inline. No mermaid, on purpose.

---

## 1. Context view

```text
                 ┌──────────────────────── Customer / PGN AWS account (single-tenant, ADR 0002) ────────────────────────┐
 Business user   │                                                                                                       │
 Admin / owner ──┼─HTTPS─> CloudFront (+WAF at tier>=2) ─> ALB ─┐                                                       │
 (browser SPA)   │         infra/lib/security-stack.ts          │                                                       │
                 │                                              v                                                       │
 Telegram ───────┼─webhook /tg/:agentId/webhook ──────────> ┌─────────────────────────────┐ ──Converse/Stream──> Amazon Bedrock
 Slack ──────────┼─/slack/events|commands|interactive ────> │  Netzar orchestrator (ECS)  │ ──InvokeModel (Titan embed, Nova)
                 │                                          │  src/index.ts, src/server.ts│ ──Guardrails
 Cloudflare ─────┼─tunnel (cloudflared sidecar, optional)─> │  agent loop + dashboard API │
  Access         │                                          └──┬───────┬────────┬────────┘
                 │      DynamoDB (~25 tables) <────────────────┘       │        │ ──SigV4 MCP──> AgentCore Gateway ──> SaaS tools
                 │      S3 (config, raw, curated, vectors, audit-lock) <┘        │ ──HTTP──> web search, Salesforce, SES email
                 │      SQS/SNS/EventBridge Scheduler, Transcribe, Polly,        │
                 │      Secrets Manager, CloudWatch/X-Ray, Cost Explorer, IAM    │ private :3001 dispatch (ADR 0013/0014)
                 │                                                               v
                 │                        Paperclip work engine (ECS + Aurora PG17 + EFS), tier>=1 only
                 │                        infra/lib/paperclip-stack.ts, database-stack.ts, filesystem-stack.ts
                 └───────────────────────────────────────────────────────────────────────────────────────────────────────┘
 TARGET: external systems POST to one trigger entry point (webhook/API first) -> Netzar live engine (C3). Paperclip removed (January).
```

Evidence: routes are mounted in `src/server.ts` (`/tg`, `/slack`, `/api/*`, `/dashboard`, `/status`, `/health`, `/ready`). The private dispatch listener is in `src/index.ts` (`buildPrivateDispatchApp`, port 3001). The Jarvis WebSocket is in `src/index.ts:83`. The Bedrock client is `src/lib/bedrock/client.ts`. MCP over SigV4 to AgentCore is `src/lib/mcp/client.ts`. Tiers are in `infra/lib/constants.ts`: tier 0 has no Paperclip and no WAF, tier 1 has Paperclip, tiers 2–3 have both.

## 2. Container view today

| Container | What runs | Evidence |
|---|---|---|
| Orchestrator task (Fargate) | Hono app: chat adapters, dashboard API, SPA, status. In-process workers: scheduler, queue drain, canary, webhook monitor, cost/drift watch, Paperclip reconciler, config invalidation listener | `infra/lib/compute-stack.ts:308,323,1313`; `src/index.ts` |
| Sidecars | `xray-daemon`, `cloudflared` (optional) | `compute-stack.ts:657,739` |
| Consolidation worker | Separate Fargate task def, started by a Lambda on a schedule | `compute-stack.ts:818,1050`; `src/lambdas/consolidation-spawner.ts` |
| Lambdas (Node 20) | Consolidation spawner, Jarvis reaper, public endpoint probe, power switch, TTL tripwire, backup, demo reset, Lambda@Edge power reroute | `dynamo-stack.ts:701`, `observability-stack.ts:651`, `power-switch-stack.ts`, `tripwire-stack.ts`, `security-stack.ts:411` |
| Edge | CloudFront (origin read timeout 60 s) + WAF (CommonRuleSet scoped off `/tg/` and `/slack/`), only when `tier.wafEnabled` | `security-stack.ts:78-135,452-460` |
| Load balancer | ALB, internal when there is no domain; idle timeout 4000 s | `compute-stack.ts:1094`; `constants.ts:343` |
| Web SPA | Preact + Vite build, copied into the image and served at `/dashboard` | `Dockerfile` stage `web`; `src/adapters/dashboard/spa.ts` |
| DynamoDB | sessions, hive-mind, audit-log, token-usage, memories, agent-file-history, mission-tasks, scheduled-tasks, kill-switches, effect-ledger, spend-ledger, identities, warroom-*, runtime-config and more | `infra/lib/dynamo-stack.ts:94-376` |
| S3 | config (`agents/<id>/CLAUDE.md`, `agent.yaml`), raw, curated, vectors index, vectors staging (7-day expiry), logs, audit-lock (Object Lock, tier >= 2) | `infra/lib/storage-stack.ts:302`; `src/lib/vectors/store.ts:28-36` |
| Messaging | SNS config invalidation, SQS ingest, SQS scheduled-fire (+ DLQs) | `infra/lib/messaging-stack.ts` |
| Paperclip | Fargate service + migrate task, Aurora Serverless v2 PG17 (RETAIN), EFS | `paperclip-stack.ts:397,596`; `database-stack.ts` |

There is no Step Functions resource in `infra/` today (grep: no `StateMachine`). TARGET: the C3 spike (NZR-33) chooses between Step Functions Standard and its own DynamoDB engine.

## 3. Module boundaries and dependency direction

### 3.1 Today

| Layer | Path | Role |
|---|---|---|
| Entry | `src/index.ts`, `src/server.ts` | Boot, route mounting, side-effect tool registration (`import './lib/tools/*.js'`) |
| Adapters | `src/adapters/{telegram,slack,dashboard,status}` | Verify, parse, render. `dashboard/handler.ts` is 5,147 lines |
| Agent runtime | `src/agent/agent-loop.ts` (1,744 lines), `picker.ts`, `commands.ts`, `memory-ingest.ts` | The one AI runtime (ADR 0014) |
| Domain libs | `src/lib/*` (≈45 dirs): `tools/`, `bedrock/`, `audit/`, `cost/`, `state/` (repos), `vectors/`, `memory/`, `missions/`, `paperclip/`, `work/`, `packs/`, `auth/`, `jarvis/`, … | Shared services |
| Infra | `infra/bin/app.ts`, `infra/lib/*-stack.ts` | CDK. Local DynamoDB tables are derived by synthesizing `DynamoStack` (`scripts/local/table-schemas.ts`) |

The intended direction is entry → adapters → agent → lib → AWS SDK. It is **not enforced**, and some imports go the other way:
- lib → agent: `src/lib/state/sessions-repo.ts:46` imports `agent/memory-ingest`. `paperclip/dispatch-worker.ts`, `warroom/orchestrator.ts` and `scheduler/queue-drain.ts` call the agent loop.
- lib → adapters: `src/lib/scheduler/delivery.ts`, `missions/format.ts`, `paperclip/dispatch-worker.ts`, `search/dispatch.ts`.
- `src/lib/work/` (effect ledger, executor, approvals) **is already on `development`**. `paperclip/dispatch-worker.ts:54` uses it. The blueprint's "PR #206 unmerged, reuse step 4–6 libs later" is out of date. Those libs are Paperclip-shaped: `approvals.ts:3` imports `paperclip/shadow-users`, and `EffectKey` is `{caseKey, stage, step, stageEntryNo}` (`effect-ledger.ts:1`).

### 3.2 TARGET modules

Rule for every new module: it may import `lib/*` and call `runAgentTurn`. It must not import `src/adapters/*`. Routes live in a new dashboard router file mounted in `src/server.ts`, not inside the 5,147-line `handler.ts`.

| TARGET module | Responsibility | Reuses | PRD |
|---|---|---|---|
| TARGET: `src/lib/workflows/schema.ts` | Versioned zod schema: trigger, agent step (`agentRef` + `agentVersion`), decision, approval, output | `zod` (already a dep); pattern of `src/lib/packs/schema.ts` | FR-001, FR-008, §4.2, OBJ-004 |
| TARGET: `workflows/validator.ts` | Structural + reference checks, plain-language errors | `listKnownAgentsAsync()` (`lib/config/agent-loader.ts:290`) | §4.4, AC-006 |
| TARGET: `workflows/drafter.ts` | Builds the drafter turn. Returns a draft or one clarifying question (≤3 total). Never executes model output (§4.3) | `runAgentTurn`, read-only tools | FR-001, NFR-003, AC-002 |
| TARGET: `workflows/preview.ts` | Pure function: definition → numbered plain steps (who/what/when/approvals) | `lib/missions/format.ts` style: pure, shared by all surfaces | FR-004, AC-003 |
| TARGET: `workflows/test-runner.ts` | Sample-data dry run. One AI step = one `runAgentTurn` with `toolPolicy:{aiStep:true}` plus the stricter sandbox in §8 R1. Records per-step results | tool policy, audit, ledger | FR-005, AC-005 |
| TARGET: `workflows/store.ts` + DynamoDB table | Draft rows + immutable draft revisions (NZR-24 history) | `state/ddb.ts`; new table in `dynamo-stack.ts` (local tables follow by synth) | FR-008 |
| TARGET: playbooks store (Library) | "How we do X" documents the drafter reads | vectors ingest (`lib/vectors/ingest.ts`) or plain S3 text; must not become a 2nd skills store (do-not-build #8) | FR-012, FR-029 |
| TARGET: company-facts queue | Hive writes land as `proposed`. Only `approved` facts reach `recentHive()` | `state/hive-mind-repo.ts:58,136`; both writers (`tools/agent-tools.ts:292`, `agent/memory-ingest.ts:177`) | FR-012 |
| TARGET: agent versions | Immutable `{CLAUDE.md, agent.yaml}` pair per version id. Loader loads a pinned version | `state/agent-file-history-repo.ts` (revId + bodyHash already kept); `agent-loader.ts:195,233` reads only the live key today | FR-002, AC-012 |
| TARGET: eval harness | 30 cases, scorer, baseline; committed result holds hashes of drafter files + dataset + model; CI fails on mismatch | `vitest` | FR-027 (spirit), BQA-AC-002 |
| TARGET: trigger contract (design only) | `{type, auth, schema, rateLimit}` → one entry point | Webhook auth pattern of `adapters/telegram/verify.ts`, `slack/verify.ts` | §4.5 |
| TARGET: live engine (C3, post-spike) | Runs, step executions, waits, approvals, retries | `lib/work/executor.ts` + effect ledger, after re-keying off Paperclip | FR-009/010/011, PR-AC-001..006 |

## 4. Request flow: the core vertical slice (TARGET, Nov 10–23)

```text
User (Workflows tab)            Dashboard API (TARGET router)       workflows/*            agent loop / shared seams
 │ 1 "describe" text ─────────> POST /api/workflows/draft ─────────> drafter ──────────> runAgentTurn(aiStep:true,
 │                               (hasCapability TARGET wf:write)                         isolated chatId, no appendTurns)
 │                                                                     │  <── draft JSON | question
 │                                                                     ├─> validator (schema+refs)
 │                                                                     ├─> store.saveRevision(draft)
 │ <── SSE: progress, question | preview ──────────────────────────────┴─> preview(definition)
 │ 2 "add my approval before sending"  (edit-by-chat = same path, prior draft in context) ─> new revision
 │ 3 "Test with sample data" + presigned upload ──> POST /api/workflows/:id/test ─> test-runner
 │                                                         for each step: AI step -> runAgentTurn(sandbox)
 │                                                         approval step -> simulated, recorded only
 │ <── SSE per-step result in plain words ─────────────────  audit row per step; spend via ledger
```

Seams it reuses (all exist today):

| Seam | Where | What the slice gets |
|---|---|---|
| Agent loop | `src/agent/agent-loop.ts:762` `runAgentTurn` | Cost admission (`admitTurnSpend`, `:766`), kill switches, guardrail, ≤8 tool rounds (`:61`), outbound DLP |
| Tool policy | `src/lib/tools/tool-policy.ts`; applied at `agent-loop.ts:1092-1099` and again at dispatch | `aiStep:true` → built-ins only if `readOnly` (10 marked tools, see `docs/security-model.md` "AI steps cannot write") |
| Audit | `src/lib/audit/audit-writer.ts:286` `writeAudit`, `:432` `writeAuditOrThrow` | `agent_turn` + `tool_invoke` rows (IDs and hashes only) |
| Cost | `src/lib/cost/ledger-gate.ts`, `spend-ledger.ts`; `usage/token-tracker.ts` | Reserve-before-spend when `cost/ledger_enabled` is on |
| Streaming to SPA | `/api/test-turn/stream` SSE pattern in `adapters/dashboard/handler.ts` | `onChunk`/`onToolEvent` → SSE, same shape as Chat |
| Uploads | Presigned PUT to staging (`lib/vectors/store.ts:48-60`) | Sample PDFs skip the API body path (WAF 8 KB cap) |
| AWS tripwire in tests | `vitest.setup.ts` | Refuses `*.amazonaws.com` dials; base for the zero-write assertion (it does not patch `fetch`) |

Slice rules: TARGET. The test runner never calls `appendTurns` (`state/sessions-repo.ts`), because that triggers memory ingest and Hive writes. It uses a synthetic `chatId` per run, so `buildMemoryContext` reads no real user memories. It drops MCP tools entirely. Test runs and analytics events (Q55) are written with a new always-audited action, so `audit_log_disabled` cannot drop them.

## 5. Environments

| Env | Where | Model backend | Data | Status |
|---|---|---|---|---|
| Local | Dev box/VPS. App on host (`npm run local`, `scripts/local/dev.mjs`); Floci on `127.0.0.1:4566` (`docker-compose.local.yml`, image **pinned `floci/floci:1.6.0`**); `AWS_ENDPOINT_URL` is the isolation switch (`development.md` §Environment variables; `scripts/local/guard.ts`) | TARGET: NVIDIA hosted models through Floci's Bedrock `proxy` backend (`FLOCI_SERVICES_BEDROCK_RUNTIME_BACKEND=proxy`, `…_PROXY_URL`, `…_MODEL_MAPPING`; `~/floci/docs/services/bedrock-runtime.md`) | Test/synthetic only (Q65, Q67) | Stub today: `development.md` "Known local limitations" 1–4 (stub text, no tool use, no stream, no embeddings) |
| CI | GitHub Actions `ci.yml`: typecheck, build, web build, `npm test`, LocalStack integration, hermetic `cdk synth`; `docs-ci.yml`: links, feature-knowledge, mermaid render, `diagrams.map` drift | Recorded replies (NZR-11, TARGET) | Fixtures | Live |
| Staging / pilot | TARGET: PGN's own AWS account (NZR-42, not opened, drop-dead Nov 9), managed pilot with a written exception (Q64) | Bedrock after access is granted; re-baseline eval (Q66) | No customer production data; partner consent | Not opened |
| GA | Customer-hosted, customer's own AWS account (PRD §8.1, OBJ-006) | Customer's approved Bedrock models | Customer's | Later |

Branch → environment. Two repo docs disagree. The code matches the first:

| Branch | Root `development.md` §Branch to environment mapping + `.github/workflows/deploy.yml` | `docs/development.md` / `docs/deployment.md` ("approved target, not active") |
|---|---|---|
| `feature/*`, `fix/*`, `chore/*` | Nothing (local only) | Nothing |
| `development` | Nothing: CI + hermetic synth | Auto-deploy to a persistent T0 QA env via OIDC |
| `qa` | Nothing: review gate | QA promotion gate |
| `staging` | **Auto-deploy on push** (`deploy.yml:14-16`) to `staging.pgnos.ai`, tier pinned to 0 | Release-candidate gate, no second stack |
| `production` | Manual dispatch + typed `deploy` | Signed `v*` release, client-approved update |

`deploy.yml:49` uses one `vars.AWS_ACCOUNT_ID` for both staging and prod. The repo does not show which account that variable points at.

## 6. Tech stack as found

| Area | Found | Evidence |
|---|---|---|
| Runtime | Node 20 (engines `>=20`, `.nvmrc` 20, `node:20-alpine`, CI Node 20, Lambdas `NODEJS_20_X`) | `package.json`, `.nvmrc`, `Dockerfile`, `ci.yml`, `infra/lib/*-stack.ts` |
| Language | TypeScript ^5.7.2, ESM (`"type":"module"`), NodeNext `.js` imports | `package.json`, `src/index.ts` comment |
| Server | Hono ^4.12.27 + `@hono/node-server`; `ws` for Jarvis; pino logging; zod ^3.23.8 env/schema | `package.json`, `src/server.ts`, `src/config/env.ts` |
| AWS | SDK v3 (~25 clients), CDK ^2.170 | `package.json` |
| Web | Preact ^10.25, wouter-preact, @preact/signals, Vite ^6, Tailwind ^3.4.15 (`darkMode:'class'`, body text 15px), marked + DOMPurify, lucide-preact | `web/package.json`, `web/tailwind.config.ts:5,157-163` |
| Nav contract | Sidebar `NAV_ITEMS` (`web/src/components/Sidebar.tsx:92`), `App.tsx` routes (32 `path=`), Jarvis `ROUTE_TABLE` (`src/lib/jarvis/route-manifest.ts:106`); the sync is tested in `route-manifest.test.ts:118` | as cited |
| Tests | Vitest ^2.1.8 (`src/**`, `infra/**`, `scripts/**`; integration excluded), AWS tripwire setup; Playwright 1.63.0 only for `tests/e2e/*` against a deployed URL. **No web unit test runner and no axe** | `vitest.config.ts`, `vitest.setup.ts`, `package.json` `e2e:chat` |
| Local emulator | Floci 1.6.0 pinned (the `~/floci` checkout is 2.3.0) | `docker-compose.local.yml`; `~/floci/CHANGELOG.md` |

## 7. One-way doors (each needs an ADR)

| # | Decision | ADR it touches | Notes |
|---|---|---|---|
| D1 | Paperclip replaced as the work authority | Supersedes **0012** (Paperclip owns work state); amends 0010, 0013, 0014, 0016, 0019 | PRD §2.3: one authority marker per workflow; PR-AC-001..006 before retirement. NZR-37 is now January |
| D2 | Customers build workflows | Supersedes **0017 decision 21** (`0017:20,31,34` "There are no customer-built workflows") | 0017's own revisit trigger fires |
| D3 | Netzar owns its workflow engine | Amends **do-not-build #1** (`docs/features/paperclip/do-not-build.md`), 0012, 0016 (approval engine) | Engine choice itself waits for NZR-33 |
| D4 | Workflows are versioned data (Draft→Test→Publish→Activate→Rollback) | Touches **0018/0021** (packs carry Paperclip pipeline bodies; 0018 says "no workflow schema is invented") and 0012 #3 key-per-version | Decide whether packs embed the new schema |
| D5 | Eval flywheel (must beat baseline; hashes; lessons need approval) | New. Touches 0020 (audit) and `docs/code-config-contract.md` (where drafter prompts live) | See R4 |
| D6 | Knowledge layers Company → Team → Agent + Playbooks; Company-facts approval | New. Touches do-not-build #8 (skills store) and 0015 | PRD DEC-010 / FR-029 say "S3 Vectors"; code is JSONL-in-S3 |
| D7 | Agent runtime: keep TS `runAgentTurn`; LangGraph.js later, behind our interface | Reaffirms **0014**; do-not-build #4 | PRD §2.5: separate responsibilities from the workflow engine |
| D8 | Pilot in PGN's AWS account (exception) | Exception to **0018 decision 18** ("staff never access customer data"), PRD §8.1 / DEC-006; 0002 (one install per partner) | Needs a written expiry and exit plan to customer-hosted |
| D9 | TARGET (proposed): live engine = Step Functions or own DynamoDB engine | New after NZR-33 | PRD §2.5 "no overlapping execution authorities" |

## 8. Risks and open questions (ranked)

| Rank | Risk (found in code) | Evidence | Why it matters / suggested handling |
|---|---|---|---|
| R1 | **Write-deny ≠ zero external writes.** In an AI step an MCP tool runs if the agent's `agent.yaml` allowlist names it. The loop's own persistence path writes memories and Hive notes. `tool_invoke` audit rows can be dropped by `audit_log_disabled` | `tool-policy.ts:11`; `security-model.md` "AI steps cannot write" + known limits; `sessions-repo.ts:46` → `memory-ingest.ts:177` `logToHive` | Blueprint AC3 / AC-005 "zero external writes" fails as designed. Add a sandbox policy: no MCP, no `appendTurns`, synthetic chatId, always-audited test actions. Assert with the tripwire **plus** a `fetch` spy |
| R2 | **Retiring Paperclip removes the only Missions engine.** `createPaperclipMissionEngine` is the sole `MissionEngine`. Chat `/missions`, mission tools, the dashboard Missions tab and Jarvis depend on it. `lib/work/approvals.ts` needs Paperclip shadow users | `lib/missions/mission-acl.ts:84,118`; `paperclip/mission-engine.ts` header; `work/approvals.ts:3`; `work/effect-ledger.ts:1` | Conflicts with "remove nothing" and "keep Slack/Telegram working". At tier 0 Paperclip isn't provisioned, so Missions may already be dead in a T0 pilot. Needs a decision: a Netzar MissionEngine on the new engine, or retire Missions |
| R3 | **The local model path can't run the slice as pinned.** Floci 1.6.0 has the proxy (Converse only). ConverseStream arrives in 2.1.0. `InvokeModel` stays a stub in proxy mode, so Titan embeddings, vector search and playbook retrieval fail locally. Guardrails are not emulated | `docker-compose.local.yml`; `~/floci/CHANGELOG.md` (1.6.0 proxy, 2.1.0 stream); `bedrock-runtime.md` "Out of scope"; `bedrock/client.ts:413-428`; `development.md` limits 1–4 | NZR-10 "no app code change" holds for chat only. Bump the Floci pin. Decide on an embedding backend for dev, or keep playbooks keyword-only in the slice. Model ids stay `us.anthropic.*` (ADR 0003), so mapping is required |
| R4 | **Eval hashes vs the code/config contract.** Agent prompts live in S3 (`agents/<id>/CLAUDE.md`), not in the repo. A CI hash of "drafter files" only works if the drafter prompt ships as product code. Live eval in CI also sends that prompt to NVIDIA | `CLAUDE.md` "Agent prompts"; `docs/code-config-contract.md` table; synthesis Q65/Q66 | Decide: the drafter is a product-owned, repo-shipped prompt (new category, ADR D5). CI live eval needs an NVIDIA secret and the owner's yes on the terms |
| R5 | **The deploy target is ambiguous.** A push to `staging` auto-deploys to `staging.pgnos.ai` in whatever `vars.AWS_ACCOUNT_ID` names. The docs describe a different (dev→QA) pipeline. "Dec 31 done" needs a deployed install, but C3's exit says "locally" and NZR-38 is runbook-only | `deploy.yml:14-16,49`; root `development.md` vs `docs/deployment.md` | Before NZR-42: repoint or guard the `staging` trigger. Make one doc canonical. Add a deploy story to C3 |
| R6 | **The knowledge scope leak is live, and the PRD's storage claim is wrong.** `/vectors*` takes `scope` from the request with only `vectors:read`. The store is JSONL-in-S3 with an O(N) scan, not S3 Vectors | `adapters/dashboard/handler.ts:3081-3088,3331-3340,3368`; `lib/vectors/store.ts:1-12`; PRD FR-029, DEC-010 | NZR-5/6 are week-0 T3. Fix the PRD wording, or add an S3 Vectors migration as an explicit decision (FR-029 is "Must") |
| R7 | **Agent versions can't be pinned yet.** History rows exist, but the loader reads only the live keys. `agent-manager.ts` writes S3 without history. The PUT route writes the DDB row and then S3 non-atomically. The tool allowlist lives in `agent.yaml`, so a version must pin both files | `agent-file-history-repo.ts`; `agent-loader.ts:195,233`; `agents/agent-manager.ts:122-145`; `handler.ts:1628-1660` | NZR-22 should build on `revId`/`bodyHash`, not a new store. Pin `{prompt, yaml}` together |
| R8 | **The edge will block or cut Studio traffic.** At tiers with WAF, CommonRuleSet (8 KB body limit) covers `/api/*`. CloudFront origin read timeout is 60 s. C3 webhooks need their own path scope-down like `/tg/` | `security-stack.ts:111-135,460`; `vectors/store.ts:48` | Keep request bodies small (ids, not full drafts). Stream with keepalives. Run tests async with polling. Pick the pilot tier now |
| R9 | **Two workflow formats.** The packs schema already defines agents + Paperclip pipelines and approval gates | `lib/packs/schema.ts:8-68`; ADR 0018/0021 | Without ADR D4 there will be two schemas (NFR-006 / OBJ-004 risk) |
| R10 | **No UI test base.** `web/` has no test script and no axe. Playwright targets deployed URLs only | `web/package.json`; `development.md` limit 14 | NZR-20 and the "all screens reachable" claim need installs (Q78) and a local Playwright target |
| R11 | **Cost and attribution.** Drafter and test turns share the daily cap with chat. Per-feature ledger partitions are not built | ADR 0020 #5 ("step 16"); `cost/ledger-gate.ts` | A tester session could hit the cap. Tag turns by feature; set a Studio budget |
| R12 | **Scale-out correctness.** One service runs every in-process worker, behind autoscaling. Draft/test state held in memory breaks with more than one task | `compute-stack.ts:1327-1331`; `src/index.ts` | Keep run state in DynamoDB. Use the existing lease pattern (`state/runner-lease.ts`) |
| R13 | **Hive is injected into every prompt and has two writers.** A queue that gates only `log_to_hive` misses `memory-ingest`'s automatic writes | `agent-loop.ts:412`; `agent-tools.ts:292`; `memory-ingest.ts:177` | NZR-28 must gate both writers and the read path |
| R14 | **Layering drift.** lib→agent and lib→adapters imports already exist | §3.1 | Add a lint/test that `src/lib/workflows/**` imports no `adapters/` |

Open questions for the owner:
1. Pilot tier (0/1/2): it decides Paperclip, WAF, and the Object Lock audit (WORM, ADR 0020) in the PGN account.
2. Missions after Paperclip: rebuild on the Netzar engine, or retire?
3. Is the drafter prompt repo-shipped product code (eval hashes), or S3 operator config?
4. Must playbook retrieval be semantic (embeddings) in the Nov 10–23 slice, given the local embedding gap?
5. Which account does `vars.AWS_ACCOUNT_ID` name today, and should the `staging` push trigger stay on before NZR-42?
6. The committed `backlog.md` (1e0ebde) stops at NZR-40. An uncommitted working-tree edit, made by another lane during this review, adds NZR-41 (review gauntlet v2) and NZR-42 (AWS account). Reconcile before the gate.
