---
feature: paperclip
document_role: backlog
status: accepted
observed_at: 2026-09-05
as_of_commit: b2df90e2a235bab90fd6a685bc8d8a126b766061
work_state: in_progress
---

# Paperclip to staging, goal-first: arm the engine, make Missions collaborative, then 8.5, the board bridge, approvals, governance, skills

## Context

ADR 0009 and 0010 adopted Paperclip so that the Missions tab would stop being a per-agent card
store and become a place where several agents collaborate under human approval. The journey
(16 handoffs, phases 1 to 9, staging run 33783021194 green) delivered the substrate, a typed
client, an anti-corruption layer, a reconciler, a dispatch route, cross-surface parity and a
six-lane board. Judged against the original goal it did not replace the tab:

- No user request reaches Paperclip anywhere. `CCE_PAPERCLIP_ENABLED` is `0` (repo variable), so
  `/api/missions*` serves the legacy DynamoDB row in staging and production
  (`src/adapters/dashboard/handler.ts:3290-3296`, `src/lib/missions/mission-acl.ts:100-103`);
  both `paperclip_*` verbs refuse (`src/lib/tools/paperclip-tools.ts:171-177, 244-246`); the
  dispatch route 202-ignores every agent because `paperclip/enabled_agents` is `[]`
  (`src/adapters/dashboard/paperclip-dispatch.ts:182-184`, `scripts/lib/seed-defaults.ts:193-196`).
- The collaboration blocker ADR 0009 named is still enforced and tested: `list_missions` and
  `update_mission` refuse any owner but self (`src/lib/tools/mission-tools.ts:352-357, 417-422`;
  `mission-tools.authz.test.ts:218, 248`).
- Nothing hierarchical crosses the wire: `toWireMission` (`mission-acl.ts:135-153`) carries no
  parent, children, blockers, approvals or goals; `web/src/pages/Missions.tsx` has zero matches
  for any of them and still fans out one request per agent (`:122-140`).
- Phases 8.5, 10, 11, 12 do not exist in `src/`.

Decisions taken with the owner on 2026-09-05:

1. **Goal-first order.** Phase 0 (arm and collaborate) and Phase 1 (hierarchy on the wire) come
   before 8.5; then the bridge; then 10 with the collaboration timeline; 11 without scoped
   secrets; 12 cut to read-only catalog plus skill-policy governance.
2. **Arm the engine in staging** (`CCE_PAPERCLIP_ENABLED=1` as a staging environment variable;
   production stays `0`).
3. **The board gets its own origin under the Netzar domain: `missions.staging.pgnos.ai`**
   (production later: `missions.pgnos.ai`), added to the existing remotely-managed tunnel and
   routed by the orchestrator by `Host`. No vendor name anywhere. Reason: Paperclip's built UI
   hard-codes `/api`, `/assets` and its WebSocket path (upstream `ui/src/api/client.ts`,
   `ui/src/api/auth.ts`, `LiveUpdatesProvider.tsx`; `ui/vite.config.ts` has no `base`), so a path
   prefix is impossible without rebuilding, and sharing `staging.pgnos.ai` would run Paperclip's
   bundle on Netzar's origin with read access to the dashboard bearer in `localStorage` and force a
   per-request guess on `/api/*`. Bar Part F.2.3 ("at a path prefix") is corrected, A1-12 style.

Everything below is judged against `docs/features/paperclip/bar-and-phases.md` (criteria by ID),
README §6's observed shapes, the pinned artifact `v2026.722.0` running in staging, and Deploy run
33783021194 as the deploy bar. Production needs a separate go-ahead; nothing here touches it.

## Operating rules for the whole campaign

**Where.** Worktree `C:\dev\Netzer-Labs\.worktrees\paperclip-promote` (on `development`, clean at
`b2df90e`). One branch per phase from `development` (`feat/paperclip-p0-arm-and-collaborate`,
`feat/paperclip-p1-hierarchy`, `feat/paperclip-8-5-org-goals`, `feat/missions-board-bridge`,
`feat/paperclip-10-approvals`, `feat/paperclip-11-governance`, `feat/paperclip-12-skills`), deleted
after merge (P7). One gauntlet per tree; pieces run serially (P25, P44: never two vitest or synth
critics at once on this 16 GB machine). The session cwd flips between the main checkout and the
worktree; always use absolute paths.

**Gauntlet per piece (Workflow tool, ultracode).** `agent(builder)` edits the worktree test-first
(a literal assertion failing first), runs the focused suites, returns a diff summary with
file:line citations. Then `agent(critic)` with fresh context: read-only on the tree, live against
staging; it must (1) open every cited file:line, (2) execute the evidence listed for the piece
(SSM tunnel with the task's Host forced, `POST /api/test-turn[/stream]` with a staging bearer,
CloudWatch, `gh run view`), (3) hold the piece against its criteria IDs and say PASS/FAIL per ID,
(4) name the single biggest remaining gap, (5) reject a green unit test with no live evidence, a
type against a guessed shape, an IAM grant wider than the literal `claudeclaw-staging` pattern
(`infra/lib/iam-stack.ts:1311-1349`), or a new module where a pattern exists. Loop builder to
critic until PASS; cap at 4 rounds and report a cap as a cap (P27), never as a pass. Both agents
get the ledger pointer (`handoffs/2026-09-03-...md` §5) and the reuse map below.

**Reuse map (a new module where one of these exists fails the critic).** Wire types in
`src/lib/paperclip/types.ts` beside `PaperclipAgent` (:638). Client methods in
`src/lib/paperclip/client.ts` beside `listAgents` (:526) through `request`/`rawRequest` (:374-385)
and the single `invoke` (kill switch :575, breaker :587). Projections beside
`mission-projection.ts`, importing `AgentIdMap`, `UnknownAgentError`, `neutralizeForPrompt` (:208).
Engine surface `mission-engine.ts:82-102` + `paperclip-mission-engine.ts` (agent cache :53).
Substrate switch `mission-acl.ts` (`paperclipRoutingEnabled` :100, `missionEngine()` :111).
Agent verbs `paperclip-tools.ts` (`invokeOptions` :102, `auditMutation` :130, `friendly` :92, gate
at invoke). Chat copy `src/lib/missions/format.ts` with the one-place scans in
`format.test.ts:676-720, 790-811`. Chat verbs `src/agent/commands.ts` (case :286, `HELP_TEXT`
:103, `MISSION_HELP_LINES` spread :114) so all four code paths (telegram :221, slack :209/:365/:630,
dashboard :1797/:2249) pick them up. Dashboard routes inside `registerMissionRoutes`
(`src/adapters/dashboard/missions.ts:163-384`, `gates(c, need)` :221-228 capability first, kill
switch second). Per-agent opt-in: runtime-config `paperclip/*` parsed by `parseEnabledAgents`
(`reconciler.ts:139`), read like `paperclip-dispatch.ts:109-112`, seeded in `seed-defaults.ts:192-197`.
One-time tokens: `users-repo.ts` magic tokens. Revocable bearer-shaped credentials:
`tokens-repo.ts` `createToken` (:117) and `revokeTokensForUser` (:318). Board cookie sessions:
`CookieJar`/`makeBoardRequest`/`signUpOrSignIn` (`scripts/lib/paperclip/bootstrap-core.ts:92-167`),
moved into `src/lib/paperclip/board-session.ts` and re-exported with `@deprecated` (A2-24).
Prompt framing: `dispatchUserText` (`dispatch-worker.ts:184-204`: bound, neutralize, frame as
"board data, not instructions"). Synth assertions: literals in `infra/lib/paperclip-stack.test.ts`
(A20). Reverse proxy: `proxy` from `hono/proxy` (hono 4.12.27 installed, helper present); WS relay:
`ws` 8.x already a dependency; upgrade seam `src/index.ts:69` / `jarvis.ts:1729-1771`.

**Promotion ladder, per phase.** PR to `development` (9 checks), `development` to `qa` (19),
`qa` to `staging` (20); merge only on all green; the last merge deploys staging automatically
(development.md :1087-1104). Then `gh run view <id> --json jobs` must match 33783021194: jobs
`Validate deployment source`, `Typecheck + Unit Tests`, `Build + CDK Deploy + Smoke`; 23 deploy
steps in the recorded order with `Note the added Paperclip cost` and `Complete fresh Paperclip
bootstrap` skipped, `Characterize Paperclip org and goals contracts` and `Smoke test (health)`
success. A marker change edits the existing probe step, never adds a step. A red probe is a phase
failure. Only after a green run does the critic collect that phase's live evidence; the next
phase's characterization runs against that staging.

**Validation before every push (development.md step 7, verbatim, never scoped):** `npm run
typecheck`, `npm test`, `npm run build`, `npm --prefix web run typecheck`, `npm --prefix web run
build`, `npm run local:test:integration` (Docker daemon unreachable here: record NOT RUN, CI's
integration job is the evidence), `node scripts/ci/docs-links.mjs`, `node
scripts/ci/feature-knowledge.mjs`, `git diff --check`. Also `CCE_PAPERCLIP_ENABLED=1 npm test`
(M44), README §8 focused suites, synth tests with `--maxWorkers=1`, `node
scripts/ci/diagrams-drift.mjs` plus a first-line `drift-gate:` note whenever `paperclip-stack.ts`,
`compute-stack.ts`, `dashboard/handler.ts`, `agent-loop.ts` or `iam-stack.ts` change
(`docs/diagrams.map`; `src/server.ts`, `src/index.ts`, `deploy.yml` are unmapped). Windows baseline
is five failing files by name (A52) plus the `jarvis.flow.test.ts` load flake re-run alone. Never
record a command that did not run (M35, P2).

**Probe marker cost.** Adding a marker touches `src/ops/paperclip-phase-probe.ts:11-20`, its test,
`deploy.yml:1171` `expected_markers=(...)`, and the pin in
`scripts/lib/lifecycle/paperclip-image-pipeline.test.ts`. Markers only for idempotent GETs.

**Operator steps (only the owner can do these; I stop and ask at each):**
1. `aws login` at the start of every staging round trip (sessions die in under two hours, A55;
   the critic checks `aws sts get-caller-identity` first).
2. Before bridge piece B-1: add public hostname `missions.staging.pgnos.ai` to the existing
   tunnel in Cloudflare Zero Trust, service `http://localhost:3000` (the tunnel is remotely
   managed, `scripts/lib/public-tunnel/setup.ts:49-61`; `cloudflared` on this machine is logged
   in and can create the DNS route if the dashboard does not).
3. Already approved, I run it at Phase 0: `gh variable set CCE_PAPERCLIP_ENABLED --body 1 --env
   staging` (environment variable overrides the repo-level `0`; `deploy.yml:943` reads `vars.*`).

**Live progress page.** A new Artifact (title "Missions Engine Campaign", favicon 📎) republished
at every critic verdict, every merge, every Deploy run: phase/piece table with PASS/FAIL, biggest
gap, run ids, blockers waiting on the owner. Load `artifact-design` before the first publish.

**Docs, every phase.** New session file
`docs/features/paperclip/handoffs/2026-09-05-goal-first-missions-engine.md` from
`docs/features/HANDOFF-TEMPLATE.md` (numbered 1 to 9; §5 carried verbatim from the 2026-09-03
file, new M/P/A rows appended); `HANDOFF.md` state, blockers, next action, index,
`as_of_commit`; README §2/§3/§5/§6/§7/§8 (every characterization table lands in §6; new files in
`implemented_by`, which must be Git-tracked or `feature-knowledge.mjs` fails); ADR 0010
amendments where a ratified position changes; `docs/how-it-works.md` and
`docs/diagrams/request-lifecycle.md` per new chat verb (A3-12); `docs/out-of-band-catalog.json`
row for the tunnel hostname.

## Phase 0: arm the engine and make Missions collaborative

**P0-0 Image-build timeout (own PR, first).** One `ENV npm_config_fetch_timeout=...` line in the
orchestrator Dockerfile `[build]` stage (ledger A53: three of seven attempts died there). Own PR
because every environment builds it. Evidence: the next staging run's `Build + Push (linux/arm64)`
timing and success.

**P0-1 Arm staging.** Set the staging variable (operator step 3). Before the deploy, record the
count of legacy DynamoDB missions in staging: they vanish from the board on flip
(`mission-acl.ts:53-63`, DL-7 no migration); write the number into the handoff. Criteria: Phase 7
acceptance 7 (router-level switch, no per-request fallback), `authz-matrix.test.ts` unchanged.
Live: staging `GET /api/missions?owner=main` returns `{owner,count,missions}` from Paperclip
(`mission.id` uuid-shaped, `createdByChat:'paperclip'`); `POST /api/missions` creates an issue
visible over the tunnel at `GET /api/companies/{cid}/issues`; `POST /api/test-turn` as `main`
invoking `paperclip_add_comment` no longer returns the wrong-substrate sentence and writes one
`tool_invoke` audit row.

**P0-2 Arm dispatch and characterize the push.** Write runtime-config `paperclip/enabled_agents`
to `["main","research"]` through the dashboard config route (admin). Over the tunnel with Host
forced, read both agents from `GET /api/companies/{cid}/agents` and record `adapterConfig.url` ==
`https://staging.pgnos.ai/api/paperclip/dispatch` (redacted shape to README §6; ledger says no
read-back was ever done). Drive `POST /api/agents/{research}/wakeup` with an `idempotencyKey` using
the `main` key; expect a `POST /api/paperclip/dispatch` 202 line in `/claudeclaw-staging/orchestrator`
and a worker turn. This closes the "push payload UNVERIFIED" note (ADR 0010 :316-321): record the
redacted body shape, never values. Criteria: A1-12 (discriminate on body `status`), Phase 6
acceptance (202 before work, dedupe). No code unless the push is refused for a real defect.

**P0-3 Lift the self-only owner rule to ADR 0009's predicate.** `mission-tools.ts:352-357` (list)
and `:417-422` (update): an agent may read any board in the company; it may mutate a mission it
owns, created, or whose parent it owns (delegation, once P1 exposes `parentId`; ship owner-or-
creator now and widen in P1). Implement the predicate once in `mission-acl.ts` beside
`resolveOwned` (:486-500) and use it from both tools; dashboard routes keep their capability gates.
Rewrite `mission-tools.authz.test.ts:218, 248` with the ADR 0009 :93-96 citation as the reason
and add the positive cases. Criteria: A3-1 (predicate in `src/lib`, not adapters), Phase 8 (verbs
gate at invoke), C-16 (ambiguity error preserved). Live via `/api/test-turn`: `main` lists
`research`'s board and gets rows; `main` updates a mission it created for `research`; `research`
cannot update a mission `main` owns and did not delegate (typed refusal text unchanged in shape).

## Phase 1: hierarchy on the wire and in the detail modal

**P1-1 Characterize before typing.** Over the tunnel: create parent and child issues
(`POST /api/companies/{cid}/issues` with `parentId`, the route `paperclip_create_subtask` already
uses), then record from `GET /api/issues/{id}` and the list which fields carry `parentId`,
children, blocking relations (`blockedByIssueIds` or an `issue_relations` shape) and the raw
status; grep `tests/contract/openapi.snapshot.json` for the request schemas. README §6 table.

**P1-2 Additive wire fields.** `toWireMission` gains `parentId`, `children:[{id,title,status,
ownerAgent}]` (or `childCount` if the list does not carry children), `blockedBy:[id]`,
`paperclipStatus` (C-15 already recommends additive `paperclipStatus`/`blockedBy`). Types in
`types.ts`; client `listIssues`/`getIssue` read only fields P1-1 observed; projection in
`mission-projection.ts` (`issueToMission`); provenance untouched. Envelope tests in
`missions.test.ts` updated additively; `authz-matrix.test.ts` untouched. Criteria: A1-15 (every
field read exists in the snapshot or P1-1's table), A2-16/17, Phase 7 acceptance 3 (existing
fields byte-identical). Live: a delegated mission on staging shows `parentId` and the parent shows
one child in `GET /api/missions`.

**P1-3 Detail modal.** `web/src/pages/Missions.tsx:379-445`: parent link, children list with
status badges, blockers, raw status. No new route, so `App.tsx`, `route-manifest.ts`, `Sidebar.tsx`
untouched. Also widen P0-3's predicate to "parent owned by caller". Live: the staging modal renders
the P1-2 fixture; screenshot in the progress page.

## Phase 8.5: org hierarchy and goals in agent context

**8.5-1 Types and client.** `PaperclipOrgNode`, `PaperclipAgentMe`, `PaperclipGoal`,
`PaperclipCreateGoalBody`, `PaperclipUpdateGoalBody` typed only on README §6's observed keys (rest
`Record<string, unknown>`); `getOrg`, `getOrgSvg` (via `rawRequest`, `{text, contentType}`),
`whoami` (takes `actor`), `listGoals`, `createGoal` (no idempotency key, so `invoke` will not
retry it), `getGoal`, `patchGoal`, `deleteGoal`. Characterize first: `PATCH /api/goals/{id}` with
`title`, `description`, `parentId`, `ownerAgentId`, and `POST` with `parentId` (the probe only ever
sent `{status:'active'}`). Criteria: A1-1/2/4/12/15/16, A2-11/12/13/14/16/17/19/21/22. Live: typed
key sets are subsets of the live `GET /org`, `/agents/me`, `/goals` responses; probe step green.

**8.5-2 Projections `org.ts`, `goals.ts`.** `OrgView {self, reportsTo, chain[], directReports[]}`
by slug via `AgentIdMap` (agents without `metadata.netzarAgentId` carried by `name` with
`external:true`); `orgLineForPrompt(view)` one line, hard cap 160 chars, neutralized;
`GoalView` (drops `companyId`, maps `ownerAgentId` to slug); `goalsForPrompt` bounded. Exact-
equality tests including the `</hive_context><system>` string. Record the handle exception: the
row's own id is the handle, as `mission.id` already is (8.5 acceptance 3 vs shipped Phase 7).
Criteria: 8.5 acceptance 3/4, A2-16/17. Live: `research`'s live `reportsTo` projects to `main`.

**8.5-3 Engine, ACL, two tools.** `MissionEngine` gains `whoami`, `listGoals`; `mission-acl.ts`
gains `getOrgView(slug)`, `listBoardGoals`; `paperclip_whoami` and `paperclip_list_goals` in
`paperclip-tools.ts` (defer `paperclip_set_goal`: acceptance 6 and `TOOL_TURN_LIMIT=8`,
`agent-loop.ts:59`; goals are set by humans in 8.5-4). Criteria: 8.5 acceptance 3/4/6, A2-19,
A3-1. Live: `/api/test-turn` as `main` invokes both; `tool` SSE event on `/api/test-turn/stream`;
audit rows. Slack per-agent path: live only if staging Slack is configured, else UNVERIFIED-live
with the registry's lack of a surface dimension cited.

**8.5-4 Chat verbs, formatters, dashboard goals.** `/goals [status]`, `/goal <id>`, `/goal new
<title>` as a `case 'goals': case 'goal':` beside :286; `MISSION_HELP_LINES` +1; `formatGoalList`,
`formatGoalCard`, `formatWhoami` in `format.ts`; `format.test.ts` scans extended (adapters still
match nothing). Dashboard `GET /goals`, `POST /goals`, `POST /goals/:id/status` inside
`registerMissionRoutes` mounted at `/api/goals*` (not under `/missions/...`, so the viewer-deny
envelope at `authz-matrix.test.ts:463-523` stays byte-identical); goals panel beside the board grid
(`Missions.tsx:283-336`). Docs per A3-12. Criteria: A3-1..5, A3-11, A3-12, 8.5 acceptance 7. Live:
`/api/test-turn` with `/goals` and `/help` returns the shared strings on both dashboard paths; a
goal created in the panel appears at `GET /api/goals` and in the probe's `goals-list` shape.

**8.5-5 One opt-in, bounded standing line.** Runtime-config `paperclip/context_agents` (seed `[]`,
`parseEnabledAgents`; separate from `enabled_agents` so context never arms writes, M33);
`mission-acl.ts` `orgLineFor(slug)` with a 30 s memo returning `''` when off/not opted in/no key;
`buildSystemPrompt` (`agent-loop.ts:274-374`) pushes one `<org_context>` line via `softly(...)`
after `<hive_context>` (:345), already neutralized, no guillemet double-escape (:327-337).
Criteria: 8.5 acceptance 4/5 and the caution (:456-463), A3-3. Live: set `["research"]`;
`/api/test-turn` as `research` "who do you report to?" names `main`; `inputTokens` delta in/out of
the list bounds the cost; unset gives no line (unit both states, both flag states).

## The bridge: Missions board on `missions.staging.pgnos.ai`

**B-1 Characterize, and the operator hostname step (no code).** Operator step 2. Then
`curl -sI https://missions.staging.pgnos.ai/health` answers 200 from Netzar (proves the tunnel
delivers the Host). Over the tunnel with the CEO credentials the bootstrap used
(`CCE_PAPERCLIP_ADMIN_EMAIL`, `PAPERCLIP_ADMIN_PASSWORD`): `POST /api/auth/sign-in/email` and
record `Set-Cookie` names and attributes (`paperclip-default.session_token`, Secure/SameSite/
Path/Max-Age); `GET /api/auth/get-session` shape; whether the CEO is instance admin
(`GET /api/admin/users?query=` 200 or 403; on 403 stop and decide, do not guess);
`PUT /api/admin/users/{id}/company-access` status; one throwaway sign-up then sign-in (no delete
route exists; record it); load the UI through the tunnel and record behaviour when the events
WebSocket fails (decides whether B-5 blocks B-6). Criteria: A1-16, A1-17 through the proxy with a
real browser `Origin`. Output: README §6 "board bridge contract" table.

**B-2 Infra and secrets, both states.** New GitHub env var `CCE_MISSIONS_BOARD_HOSTNAME`
(staging `missions.staging.pgnos.ai`). Homes (M22/M27/M34/M38): `infra/bin/app.ts:181-205` reads
it into a `PaperclipStack` prop `publicHostname?` validated with the exported hostname check from
`infra/lib/public-dashboard-access.ts:111-156`; `paperclip-stack.ts` env block (:435-477) sets
`PAPERCLIP_PUBLIC_URL=https://<host>` and makes `PAPERCLIP_ALLOWED_HOSTNAMES` the explicit comma
list Cloud Map host + public host (M56/M58), `TRUST_PROXY` only if B-1 proved a dependency;
`compute-stack.ts` env `MISSIONS_BOARD_HOSTNAME` beside :544-546 and secrets `PAPERCLIP_ADMIN_EMAIL`
(new field `admin_email`) and `PAPERCLIP_ADMIN_PASSWORD` (existing field) beside :592-599 under the
same `paperclipProvisioned` gate; `deploy.yml` populate step (:491) merge-adds `admin_email` from
`vars.CCE_PAPERCLIP_ADMIN_EMAIL` when `REPLACE_ME`, never overwrites; both CDK-deploy synth env
blocks; `scripts/deploy.ts` `cdkEnvBag`; `manifest.ts` `SYNTH_INPUT_ALLOWLIST`;
`secrets-stack.ts:117` field list; `bootstrap-secret.ts` merge; `src/config/env.ts`; `.env.example`.
Tests: `paperclip-stack.test.ts:374-388` deliberately reversed into two literal tests (set: exact URL
and allow-list; unset: undefined, template byte-identical to today); compute-stack literals;
`app.stack-set.test.ts` unchanged. Diagram notes for both stacks. Criteria: A1-18, Phase 4.5
acceptance 1/2, A20, M33. Live: `describe-task-definition claudeclaw-staging-paperclip` shows the
values; orchestrator RUNNING (both secret fields resolved); probe step green; tunnel
`GET /api/health` with `Host: missions.staging.pgnos.ai` 200 and with `Host: nope.example` 403.

**B-3 Host gate and HTTP reverse proxy.** New adapter `src/adapters/missions-board/handler.ts`
exporting `buildMissionsBoardRouter(deps)` and `isMissionsBoardHost(host, env)`; mounted in
`src/server.ts` as the first `app.use('*')` after `secureHeaders()` (:69), host match delegates,
else `next()`; absent hostname env means not mounted (M33). Inside: `GET /_netzar/bridge` is the
only ungated path; everything else needs cookie `netzar_board_gate` whose value passes
`authenticateDashboardToken` with label prefix `missions-board:`; then `paperclip_disabled` (503,
same body as `missions.ts:185`); then refuse browser `POST /api/auth/sign-up/email` and
`/sign-in/email` with 403 (A38 closed at the edge; the bridge signs in server-side over Cloud
Map); then `proxy()` from `hono/proxy` to `PAPERCLIP_BASE_URL + path`, forwarding `Cookie` minus
the gate, `Origin`/`Referer` unchanged, `X-Forwarded-Proto: https`, no `X-Forwarded-Host` (P40);
responses stream through, `Set-Cookie` included; proxied responses get `Content-Security-Policy:
frame-ancestors https://staging.pgnos.ai` instead of the SAMEORIGIN default so a later embed works.
Criteria: Phase 4.5 acceptance 3/5, A38, A2-13, A2-21. Live: no cookie gives 401 JSON; with a gate
the Paperclip `index.html` and `/assets/index-*.js` 200; sign-up POST 403 and no sign-up line in
Paperclip's log; `staging.pgnos.ai/dashboard` unchanged; smoke step green.

**B-4 Session bridge, provisioning, revocation.** Dashboard side: `POST
/api/missions-board/handoff` registered beside `handler.ts:3290-3292` under
`paperclipRoutingEnabled()`, `gates(c,'missions:board')`; new capability `'missions:board'` in
`permissions.ts:88-135` for admin/org-admin/owner only (additive fail-closed rule :84-86);
additive `authz-matrix.test.ts` block; issues a `createMagicToken({purpose:'missions_board',
expiresAtMs: now+60s})` and returns `{url}`. Board side `GET /_netzar/bridge?t&next`:
`consumeUserMagicToken` (single use), re-check user active and capability, `ensureBridgedUser`
in `src/lib/paperclip/board-session.ts`: CEO sign-in over Cloud Map, `GET /api/admin/users?query=
<email>`, if absent `signUpOrSignIn` with a Netzar-owned credential, `PUT
/api/admin/users/{id}/company-access {companyIds:[companyId]}`, sign in as the user, forward
Paperclip's `Set-Cookie` verbatim plus `netzar_board_gate` (HttpOnly, Secure, SameSite=Lax,
Path=/) from `createToken('missions-board:<emailLower>','user:<id>',role,1,{userId,profileId})`,
302 to a path-only `next` (default `/`). Credential: `HMAC-SHA256(APP_ENCRYPTION_KEY,
'missions-board:v1:'+userId)` hex: `APP_ENCRYPTION_KEY` is already injected
(`compute-stack.ts:559`, `env.ts:234`) and read by nothing, so no new secret, store, IAM or
encryption helper; record that rotating it orphans bridged accounts (P18 shape) in ADR 0010.
Audit `missions_board_opened` added to the union (`audit-writer.ts:58`) and
`ALWAYS_AUDITED_ACTIONS` (:221). Revocation: gate rows are user-bound token rows, so the three
`revokeTokensForUser` callers (`handler.ts:3844, :3877, :3975`) already kill them; add
`revokeMissionsBoardAccess(userId)` (CEO `PUT company-access {companyIds:[]}`, best-effort) at
:3877 always and at :3844/:3975 when the new profile lacks the capability. Criteria: Part F.2.5,
Phase 4.5 acceptance 4/5 (button carries no hostname literal; the `web/` grep test at
`paperclip-stack.test.ts:413-422` still holds, its stated reason updated), A2-9, A1-17. Live: admin
bearer gets a URL; opening it lands signed in as that email (`/api/auth/get-session` through the
board host; CEO admin listing shows membership); token reuse 401; viewer 403 envelope; disabling
the member makes the next board request 401 and company access `[]`; audit rows visible.

**B-5 WebSocket relay.** Export `handleJarvisUpgrade(req, socket, head)` from
`jarvis.ts:1729-1771` and let `src/index.ts:69` own one dispatcher: board host and path
`/api/companies/*/events/ws` relays, else Jarvis. Relay validates the gate from the cookie, strips
it, opens `new WebSocket('ws://<cloud map host>:3100'+path, {headers:{cookie, origin}})` with `ws`,
pipes frames both ways, closes both on either end, pending ceiling copied from `admitPendingAuth`.
Criteria: Part F.2.1, A2-21, Phase 4.5 acceptance 3. Live: 101 on the board host in devtools; a goal
created in a second tab appears without reload; Jarvis voice still connects.

**B-6 Missions tab button, docs, bar correction.** "Open full board" on `Missions.tsx` behind
`hasCapability('missions:board')`, calling the handoff route and `window.open(url,'_blank',
'noopener')`; no `Sidebar`/`App`/`route-manifest` change. README §2/§3/§5/§6 (hostname, cookie
names, edge-closed sign-up, derivation rule, revocation; the SSM-only paragraph at :335-341
superseded); HANDOFF; ADR 0010 amendment (host-based bridge; §16.6 and the "SSM-only" statement
superseded); `bar-and-phases.md` Part F.2.3 correction blockquote; diagram notes; out-of-band
catalog row; `.env.example`. Gates green; fresh-context critic reads the README against live
behaviour. Follow-on recorded, not built: embed the board in the Missions tab as a same-site frame.

## Phase 10: approvals, review gates, the collaboration record

Human decisions (approve, reject, request-revision) happen in Paperclip's own UI through the
bridge with the user's own session, which gives attribution for free (acceptance 3). Netzar builds
the read side on every surface, deep links into the decision, and the agent's half (`resubmit`).

**10-1 Characterize approvals, work products, timeline.** Grep the snapshot for `/approvals`,
`/work-products`, `/timeline`; over the tunnel: how an agent creates an approval, list/get shapes,
decision routes with an agent key (expect refusal, record) and with the CEO session, `resubmit` as
the agent and whether it needs `X-Paperclip-Run-Id`, comments, work products,
`GET /api/companies/{cid}/timeline` filtered by project (the one fully typed schema, Part F.4). Add
one marker `approvals-list` (four-file cost). Criteria: A1-4/12/16/17.

**10-2 Extract the framing helper.** `frameUntrustedBlock(tag, attrs, lines, {maxChars,
maxEntries})` in `mission-projection.ts` beside `neutralizeForPrompt`; `dispatchUserText`
(`dispatch-worker.ts:184-204`) rewritten to call it with an exact-equality test that dispatch
prompt bytes are unchanged. Criteria: A3-4 spirit, Phase 10 acceptance 4, Phase 12 acceptance 6.

**10-3 Types, client, `approvals.ts`, engine, ACL.** `PaperclipApproval`, `PaperclipWorkProduct`,
`PaperclipTimeline*`; `listApprovals`, `getApproval`, `resubmitApproval`, `listApprovalComments`,
`listWorkProducts`, `getTimeline`; `ApprovalView` (handles, status as observed, requester/decider
slugs, bounded revision note), `TimelineView` (actors as slugs, `edges[]` kind/from/to/issue/at);
engine and ACL `listBoardApprovals`, `resubmitBoardApproval`, `collaborationTimeline(project?)`.
Decision methods are never called by the ACL. Criteria: A1-1/4/12/13, A2-16/17/18/19, acceptance 3.
Live: typed keys subset of live; `approvals-list` marker green.

**10-4 Dashboard: approvals, work products, timeline.** Detail modal shows approval state and
work products read-only with "Decide in board" deep links (`next=/approvals/<id>` through B-4);
routes `GET /missions/:owner/:id/approvals`, `.../work-products` in `registerMissionRoutes`
(`missions:read`); a "Collaboration" panel on the Missions page over `GET /api/missions/timeline`
rendering who delegated or assigned to whom (Part F.4: lead with the timeline). Document locking
not exposed (acceptance 5). Live: an agent-created approval shows; request-revision in the board
reflects on refresh; the timeline shows P0-2's delegation edge.

**10-5 Tools and chat.** `paperclip_list_approvals`, `paperclip_resubmit_approval(approval_id,
note)`; `/approvals [status]`; `formatApprovalList`, `formatApprovalCard`; notes enter tool text
only through `frameUntrustedBlock`; `auditMutation` union gains `resubmit_approval`. Criteria:
acceptance 1/2/4, A3-1..5, A3-12. Live: `/api/test-turn` `/approvals`; a resubmit after a
request-revision made in the board; audit row.

## Phase 11: governance and the client-facing chart (scoped secrets dropped by decision)

**11-1 ADR amendment and deny-list test.** ADR 0010 amendment "the org chart is client-facing"
with a pointer at plan §16.6/§16.7; a test asserting serialized `OrgView`/`GoalView`/
`ApprovalView`/`TimelineView` and the org/goals/approvals/timeline route JSON contain no
`companyId`, no uuid-shaped value other than the row's own `id`, no `NZR-\d+`, no `*Cents`, no
`apiKey|token|secret` keys, fixture from README §6 (`/agents/me` carries `budgetMonthlyCents`,
`permissions`). Criteria: acceptance 1/2.

**11-2 `org.svg` from Netzar's origin.** `client.getOrgSvg()` (content type must be
`image/svg+xml`); ACL `orgChartSvg()`; `GET /api/missions/org.svg` (`missions:read`, inline,
`private, max-age=60`); the SPA fetches with the bearer and renders a blob URL in an `<img>` on an
"Org" panel. Characterize the SVG text for uuids first; strip or record. Criteria: acceptance 3/4,
8.5 acceptance 2, A2-13/14. Live: staging page shows the chart; bearer 200, none 401; `org-svg`
marker.

**11-3 Disjoint planes.** README §6 statement; a test that no Paperclip permission key string is in
`CAPABILITIES` and `PATCH /api/agents/{id}/permissions` has no caller under `src/`; optional read-
only display of `/agents/me.permissions` on the agent detail. Criteria: acceptance 6.

## Phase 12: skills, cut to read-only catalog and policy governance

**12-1 Characterize.** Snapshot grep for `/skills`, `/skill-policy`, `review|performance` (record
absent, acceptance 5); over the tunnel with agent key and CEO session: catalog list/detail, company
skills/detail/versions, `GET skill-policy` default, `POST skill-policy/evaluate` body and verdict,
`GET /api/agents/{id}/skills`, `POST .../skills/{skillId}/audit` body. Add marker `skills-catalog`.
Criteria: A1-12/15/16/17.

**12-2 Read side.** Types, client GETs, `skills.ts` (`SkillView`: handle, name, bounded summary,
version, bound agents as slugs), ACL, tool `paperclip_list_skills` (text via `frameUntrustedBlock`),
dashboard `/skills` tab per the tab pattern (`App.tsx` route with `RequireCapability('agents:read')`,
`route-manifest.ts` ROUTE_TABLE row, `Sidebar.tsx` item). Criteria: acceptance 1/6, A2-16..19, A3-4.
Live: the tab lists what the tunnel lists; tool via `/api/test-turn`; marker green.

**12-3 Governance with authoring, one PR.** `getSkillPolicy`, `evaluateSkillPolicy`,
`auditSkill`; the tab shows the policy read-only and each skill's latest verdict; "Author in board"
and "Edit policy in board" deep links through B-4 (policy PUT deliberately not built: Phase 11
acceptance 6). Criteria: acceptance 2. Live: change the policy in the board, verdicts change.
Deferred with evidence: delivery into Netzar agent context, evals, sync, fork/star/comment,
performance reviews.

## Bar text that cannot be implemented as written (record, do not guess)

1. Part F.2.3 path-prefix same-origin: false at the tag; host-based bridge is the correction (B-6).
2. 8.5 acceptance 3 "no Paperclip uuids on a Netzar surface" vs shipped `mission.id`: the row's
   own id is the handle; exception in 8.5-2, enforced with that carve-out in 11-1.
3. Phase 4.5 acceptance 4 "no link in the SPA" vs the bridge button: capability-gated to admin+,
   no hostname literal; the grep test stands, its reason updated (B-4/B-6).
4. `paperclip-stack.test.ts:374-388` pins `PAPERCLIP_PUBLIC_URL` undefined: reversed in B-2 with
   both-state literal tests.
5. Phase 10 human decisions through Netzar: not built (attribution); decisions happen in the
   board; agents get `resubmit`.
6. Phase 12 acceptance 5 (performance reviews): absent at the tag; snapshot grep is the evidence.
7. Telegram and Slack per-agent live proof depends on staging having those adapters configured;
   otherwise UNVERIFIED-live citing the four `runCommand` call sites, never a claim.
8. `boardMutationGuard` and Better Auth trusted origins through the proxy: characterized in
   B-1/B-3 with a real browser `Origin`, not from the source read.
9. P1-2's text asks for `blockedBy:[id]` unconditionally; P1-1 MEASURED `blockedBy` as an array
   of OBJECTS present only on the 201 create response and the detail read, never on a list row,
   so carrying it on the list wire would violate A1-15. The shipped code carries parentId,
   paperclipStatus, blockerAttention{state,reason} and childCount, not blockedBy; reason at
   `mission-acl.ts:176-184`. The bar's own precedence rule settles it: a green contract probe
   against the pinned artifact beats all four documents. `childCount` is Netzar-derived
   (`childCountsByParent`, grouping the fetched board by parentId), not a Paperclip field, and is
   absent rather than 0 for a childless row.

## Verification (end to end)

- Every piece: builder tests fail first then pass; critic PASS by ID with live evidence named
  above; progress page updated.
- Every phase: full step-7 list both flag states; three green PR rungs; Deploy run equal to
  33783021194 job for job and step for step (plus skipped pair), probe step success with the
  marker set of that phase; staging evidence collected after the run; README/HANDOFF/session
  handoff/ADR updated in the same PR as the code.
- Campaign exit: staging Missions tab and chat surfaces are Paperclip-backed with delegation,
  blockers, approvals, goals, org line and timeline visible; the board reachable at
  `missions.staging.pgnos.ai` only through the Netzar gate; sign-up closed at the edge; all
  characterization tables in README §6; final handoff written; production untouched and no
  release created.
