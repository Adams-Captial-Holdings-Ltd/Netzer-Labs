---
feature: persistent-workspaces
document_role: session-handoff
status: historical
observed_at: 2026-08-14
session_slug: persistent-workspaces-raw
imported_from: ~/Downloads/handoff-persistent-workspaces.md
imported_at: 2026-09-17
---

> Imported verbatim on 2026-09-17 during the machine transfer. Raw pre-template session log; historical only; paths refer to the old machine.

# Handoff: Persistent agent workspaces — document delivery + chat history

## Session Metadata
- Created: 2026-08-14 (state re-verified against live GitHub and git immediately before writing; the work itself was done 2026-08-13)
- Project: `C:\dev\Netzer-Labs` — **not** the OneDrive copy, see Gotchas
- Branches produced: `feature/persistent-workspaces`, `feature/chat-history` (both merged and deleted)
- Session duration: ~4 hours

> Nothing below is recorded as passing unless it actually ran. Where a claim is
> inference rather than evidence, it says so.

## Current State Summary

Two features shipped through the ladder to `staging` and are sitting there
untested, because **no deploy has ever succeeded**. A user-reported bug —
"I tried to make an xlsx file and got AccessDenied" — turned out to be
structural: `generate_document` returned its presigned S3 URL only as *text*,
which the model then retyped into its reply, dropping the signature. That was
fixed by moving documents onto the existing `ToolMedia` channel that
`generate_image` has always used. A second change made dashboard conversations
stop expiring and gave the Chat tab a conversation sidebar with resume. Both
merged into `development` (#34, #36) and were promoted `development → qa →
staging` (#37, #38), all with fully green CI. **Production does not have either
fix and is 47 commits behind staging.**

## Codebase Understanding

### Architecture Overview

TypeScript / Node 20. Hono HTTP server (`src/index.ts`, port 3000). Preact +
`@preact/signals` + `wouter-preact` + Tailwind SPA in `web/`, served at
`/dashboard/`. **All state is DynamoDB (32 tables) + S3 (7 buckets) — no SQL, no
ORM, no Redis.** Amazon Bedrock Converse/ConverseStream drives every agent turn.
ECS Fargate behind an ALB.

The two subsystems this session touched:

```
Tool produces bytes
   └─► ToolResult { text, media[] }          <── the load-bearing distinction
          ├─ text  ──► goes into the MODEL's context, model retypes it
          └─ media ──► AgentTurnResponse.media ──► surface delivers directly
                        ├─ Telegram sendPhoto (images only)
                        ├─ Slack uploadFile (format-agnostic)
                        └─ dashboard SSE `image` | `artifact`

Conversation turn
   └─► sessions-repo.appendTurns()
          PK=AGENT#<agentId>  SK=CHAT#<chatId>
          turns[] trimmed to MAX_TURNS = 20
          ttl = +7 days   ◄── removed for dashboard chats this session
          └─► evicted turns distilled into memories-repo by memory-ingest.ts
```

Worth knowing before redesigning anything here: **the "hybrid memory
architecture" is already fully implemented** — sliding window, periodic LLM
distillation via Haiku, retrieval, structured memory, and a backstop
(`decideIngest`) guaranteeing no turn is evicted before it is summarized. It
also carries a deliberate prompt-injection trust boundary. Do not rebuild it.

### Critical Files

| File | Purpose | Relevance |
|------|---------|-----------|
| `src/lib/tools/registry.ts:41` | `ToolMedia` / `ToolResult` contract | `kind` widened to `'image' \| 'artifact'`; its doc comment already stated the channel exists so surfaces deliver "instead of a bare presigned URL" |
| `src/lib/tools/document-generation-tools.ts` | `generate_document` tool | Root of the bug; now returns `media[]` via the pure `buildDocumentResult` |
| `src/lib/tools/nova-canvas-tools.ts:549-564` | `generate_image` | **The reference implementation.** It always returned `media[]`, which is why images never broke |
| `src/lib/state/sessions-repo.ts:27-28` | `MAX_TURNS = 20`, `TTL_SECONDS` | The entire non-persistence cause |
| `src/lib/state/sessions-repo.ts` | `appendTurns`, `setModelOverride`, `clearSession` | **Three** separate TTL write paths — all must agree |
| `web/src/pages/Chat.tsx` | Chat tab | Minted `dashboard:${Date.now()}` per mount and discarded it on reload |
| `web/src/lib/api.ts` | API client | 60s stale-while-revalidate GET cache + `clearApiCache()`; `downloadFile()` checks `res.ok` before writing to disk |
| `src/adapters/dashboard/handler.ts` | `/api/*` routes + SSE | `GET /api/sessions`, `GET /api/sessions/transcript` **already existed** |
| `docs/adr/0002-single-tenant.md` | Accepted | No `tenantId` anywhere |
| `docs/adr/0009-mission-container-model.md` | Accepted 2026-08 | Explicitly **rejected** workspace/user scoping |
| `docs/diagrams.map` | Diagram ownership | Gates PRs; compares **committed** changes |
| `development.md` (root) | Canonical process | Read before the first edit |

### Key Patterns Discovered

- **Never put a URL a user must click into `text`.** It reaches the model, and
  the model retypes it. A ~900-char signed URL does not survive. Anything
  clickable belongs on `media`.
- **DynamoDB TTL only deletes items that CARRY the attribute.** "Persistent"
  means omitting `ttl`, never a far-future value. A `PutCommand` therefore
  self-heals legacy rows; `UpdateCommand` needs an explicit `REMOVE #t`.
- **DynamoDB rejects a declared-but-unused `ExpressionAttributeValue`**, so a
  conditional `REMOVE`/`SET` must also make `:t` conditional.
- **Test pure exported functions, don't mock DynamoDB.** `nova-canvas-tools.test.ts`
  tests `buildNovaBody` only; `sessions-repo.ingest.test.ts` tests `decideIngest`
  and `clampIngestEveryN`. Follow that shape.
- **The repo prefers a new key prefix over a new table** (ADR 0009), because a
  new table forces `cdk deploy`, which `CLAUDE.md` warns can shift env-backed
  tunables. A row-type change ships via `npm run deploy:cloud`.
- **Adding a whole nav tab requires three synchronized edits** (`App.tsx` route
  `need=`, `Sidebar.tsx` `NAV_ITEMS` `minCapability`, Jarvis `ROUTE_TABLE`). A
  panel *inside* an existing tab avoids all of it.

## Work Completed

### Tasks Finished

- [x] 16-phase feasibility study of persistent conversations + artifacts, verified against source
- [x] Diagnosed the `AccessDenied` download bug to root cause and proved the mechanism
- [x] Confirmed definitively that **no code-execution path exists** in the repo (exhaustive search)
- [x] Fixed document delivery — PR #34, merged
- [x] Made dashboard conversations persistent + built the sidebar — PR #36, merged
- [x] Promoted `development → qa` (#37) and `qa → staging` (#38), both 20/21 checks green
- [x] Updated two diagrams the drift gate correctly flagged
- [x] Wrote `docs/features/persistent-workspaces/{README,HANDOFF}.md` before writing code
- [x] Ran the **full** documented validation list, including the integration suite against Floci
- [x] Produced a separate chat-history handoff for a parallel agent (`Downloads\chat-history-handoff.md`)

### Files Modified

All merged and now on `development`, `qa` and `staging`.

| File | Changes | Rationale |
|------|---------|-----------|
| `src/lib/tools/registry.ts` | `ToolMedia.kind` → `'image' \| 'artifact'` | A document sent down an image path breaks Telegram (`sendPhoto` hardcodes `image.png`) and dashboard (`<img>`) |
| `src/lib/tools/document-generation-tools.ts` | Added pure `buildDocumentResult` + `documentFileName`; returns `media[]` | Fix the broken download; keep it testable without S3 |
| `src/adapters/dashboard/handler.ts` | Emits a distinct `artifact` SSE event | Download card instead of a broken `<img>` |
| `src/adapters/slack/handler.ts` | `deliverSlackImages` → `deliverSlackMedia`, real filenames | `uploadFile` is format-agnostic, so documents were nearly free |
| `src/adapters/telegram/handler.ts` | Skips non-image media, reason at the call site | No `sendDocument` helper exists; parity rule allows an explicit skip |
| `src/lib/state/sessions-repo.ts` | `isPersistentChat` + all three TTL write paths | Dashboard conversations stop expiring |
| `web/src/pages/Chat.tsx` | Conversation sidebar, resume, `sessionStorage` chatId, artifact card | The client-side half of persistence |
| `src/lib/tools/document-generation-tools.test.ts` (new) | 12 tests | Regression cover for the delivery contract |
| `src/lib/state/sessions-repo.persistence.test.ts` (new) | 6 tests | `isPersistentChat` prefix rules |
| `src/lib/state/sessions-repo.integration.test.ts` (new) | 7 tests vs real DynamoDB | Proves attribute **absence**, which a mock cannot |
| `docs/diagrams/{architecture-security,request-lifecycle}.md` | Recorded outbound media delivery | Drift gate; also true facts |
| `docs/features/persistent-workspaces/{README,HANDOFF}.md` (new) | Feature docs | Framework requirement |

### Decisions Made

| Decision | Options Considered | Rationale |
|----------|-------------------|-----------|
| Conversation is the container; no Workspace entity | Workspace/Project hierarchy; reuse Missions | ADR 0009 rejected workspace scoping **on evidence**, five days earlier; sessions already key cleanly per `(agentId, chatId)` |
| Stay single-tenant | Add `tenantId`; full refactor | ADR 0002 Accepted; isolation is at the AWS-account boundary, which is stronger than row scoping |
| Documents only, generated in-process | AgentCore Code Interpreter; Lambda; ECS RunTask | MVP needs fixed document shapes from structured data, not arbitrary LLM-authored code. Code Interpreter's Node runtime ships none of the doc libraries, and its default SANDBOX mode has a disclosed DNS-exfiltration path (Unit 42) |
| S3 prefix as the artifact index | New `claudeclaw-artifacts` DDB table | `ListObjectsV2` already returns name, size and date. A table would duplicate what S3 holds and force a `cdk deploy` |
| Keep the URL in reply text as a fallback | Remove it entirely (my original plan) | Removing it would regress Telegram from a fragile link to **none** |
| Persist dashboard chats only | Remove TTL entirely; make it runtime-configurable | Bot surfaces have no history UI, so permanence there is storage growth plus an unasked-for retention change |
| Match on `chatId` prefix, not `surface` | Thread `surface` through | `setModelOverride` and `clearSession` also write the TTL and see nothing but the id |
| Extend `persistent-workspaces` docs, not a new `chat-history` folder | Second feature folder | The framework states sprawl is the failure mode it exists to prevent |

## Errors, Mistakes & Learnings

### Errors Encountered

| Error / Symptom | Cause | Resolution | Status |
|-----------------|-------|------------|--------|
| S3 `AccessDenied` on a generated `.xlsx`; URL had **no** `X-Amz-*` parameters | Presigned URL returned only in `text`; the model retyped it and dropped the query string | Deliver over `ToolMedia` | **Resolved** (#34) |
| `The token '&&' is not a valid statement separator in this version.` | Gave bash-style chains to a Windows PowerShell 5.1 user | Rewrote as `; if ($?) { … }`; fixed the same mistake in the feature README | Resolved |
| `failed to connect to the docker API at npipe:...` | Docker Desktop not running | Started it — it lives at `%LOCALAPPDATA%\Programs\DockerDesktop\`, **not** Program Files | Resolved |
| `git worktree remove` → `Permission denied` | OneDrive held the files locked | Deregistered the worktree; directory still on disk | **Open (cosmetic)** |
| `SyntaxError: Invalid or unexpected token` on 4 `scripts/**` test files | Those files import `.mjs` helpers beginning with `#!/usr/bin/env node`; vitest's transform chokes on the shebang. **Proven** by deleting one shebang → 7 tests passed | None — pre-existing, Windows-only, CI green on Linux | **Open (environmental)** |
| `docs-assets.mjs` flags an exempt file | `LEGACY_EXEMPT` holds `docs/diagrams/system-flow.excalidraw` with forward slashes; `rel` is `docs\diagrams\...` on Windows, so the exemption never matches | None — same Windows class | **Open (environmental)** |
| `spawnSync npx ENOENT` in `docs-mermaid.mjs` | `npx` is a `.cmd`; Node cannot spawn a batch file by bare name | None — CI passes on Linux | **Open (environmental)** |
| `gh pr create` → `HTTP 502 Bad Gateway` (twice) | GitHub GraphQL transient | Used the REST endpoint via `gh api` | Resolved |
| Permission classifier blocked `gh pr merge` | Session policy gates merges | Owner merged; later merges were permitted | Resolved |

### Mistakes Made & Corrections

| Mistake | Impact | Correction | Lesson |
|---------|--------|------------|--------|
| Planned a `claudeclaw-artifacts` DDB table, a repo module, 4 routes, a separate page | Would have forced a `cdk deploy` and duplicated data S3 already holds | Cut to S3-prefix indexing, 2 routes, no table | Ask whether the storage layer already answers the query before adding one |
| Planned to tag documents `kind: 'image'` | Telegram would have posted a spreadsheet as a photo named `image.png` | Added a distinct `'artifact'` kind and branched per surface | Trace **every** consumer before widening a shared type |
| Planned to strip the URL from reply text | Would have regressed Telegram to no link at all | Kept it as a fallback, matching `generate_image` | Read how the working sibling behaves before changing a shared contract |
| Worked in the OneDrive clone for the first feature | OneDrive synced ~850 files + `node_modules`, then locked them so `git worktree remove` failed | Moved to `C:\dev\Netzer-Labs`; corrected the stored note | The remembered repo path was wrong; verify before designing around it |
| Trusted a stored note claiming vitest cannot run in a Windows worktree | Nearly avoided worktrees entirely | Tested it — the full 1949-test suite ran fine | Verify remembered environment claims |
| Told the user to run `gh workflow run deploy.yml` | `deploy.yml` had never run successfully; the real path may be `npm run deploy:cloud` | Flagged it before they acted | Check a workflow's run history before recommending it |

### Key Learnings

- **The feature was ~70% already built and undocumented.** `generate_document`
  (PDF/DOCX/XLSX), the full memory architecture, a proven versioning pattern
  (`agent-file-history-repo.ts`), and both conversation endpoints all existed.
  The gap was plumbing, not architecture. **Survey before designing.**
- **`generate_image` and `generate_document` had diverged silently.** One used
  the media channel; the other did not. The `ToolMedia` doc comment already
  described the correct behaviour. When two sibling features differ, the one
  that works is the spec.
- **Windows is an unverified third platform here.** `development.md` records its
  baseline as verified **on macOS**; CI runs `ubuntu-latest`. The five local
  failures are all Windows-specific and all in `scripts/`. Record the baseline
  before blaming a change.
- **`GET /api/sessions` without `agentId` does a full table Scan** and returns
  every user's sessions to any `sessions:read` holder. Conversations are
  org-visible, not per-user private.
- **Local development cannot exercise the agent tool path at all.** Floci's
  Bedrock stub always returns `stopReason: 'end_turn'`, so the tool-dispatch
  loop never runs. Plumbing is testable locally; model behaviour is not.

### Prevention / Future Guidance

- Before adding anything a user must click, ask whether it travels through the
  model. If it does, put it on `media` instead of `text`.
- After editing a file mapped in `docs/diagrams.map`, **commit**, then run
  `GITHUB_BASE_REF=development node scripts/ci/diagrams-drift.mjs`. The gate
  reads committed changes.
- Relationship keys in `docs/features/*/README.md` must point at **Git-tracked**
  files. `git add` new tests before running `feature-knowledge.mjs`.
- Run the full `npm test` **before** any change and write the baseline into the
  HANDOFF. On Windows expect **5 failing files / 1 failing test**, all in
  `scripts/`, none in `src/`.
- Never run `npm run test:integration:up` — it starts LocalStack on 4566 and
  collides with Floci. Use `npm run local:test:integration`.
- Give this owner **one command per code block**, tagged `powershell`. `&&` is a
  parser error in PowerShell 5.1.

## Pending Work

### Immediate Next Steps

1. **Get a deploy to succeed.** `deploy.yml` has run 7 times (first
   2026-08-13T18:04) and **never succeeded** — 6 failures and 1 cancelled. Until
   one lands, neither fix has run anywhere. PR #53 (separate session) fixes three
   `deploy.yml` defects and is the likely unblock.
2. **Verify on staging** once deployed — the four checks under Important Context.
3. **Promote `staging → production`** only after that. Production is **47 commits
   behind** and has neither fix.
4. **Fix the 5 Windows-only test failures** (cause fully diagnosed above). They
   gate nothing but make every local run look alarming.
5. **M2 — durable artifacts** (the original plan's next milestone): move
   generated documents from `RAW_BUCKET` to `CURATED_BUCKET`, add
   `GET /api/artifacts` + download, and extend `forget_me`.

### Blockers/Open Questions

- [ ] **Blocker: no successful deploy.** Needs: PR #53 merged and promoted, or
      confirmation that deploys actually go via `npm run deploy:cloud` (CodeBuild).
- [ ] **Blocker before M2: artifact visibility.** Sessions are org-visible today.
      If artifacts inherit that, any `chat:read` holder downloads any user's
      documents. Needs a product decision. Suggested: inherit for the MVP, stamp
      `createdBy`, revisit if a customer objects.
- [ ] Question: is a 20-turn scrollback acceptable? Suggested: ship it, document
      it, treat full transcript retention as the top follow-up.
- [ ] Question: migrate existing `generations/` objects to `CURATED_BUCKET`, or
      let `RAW_BUCKET`'s 365-day lifecycle retire them?

### Deferred Items

- **PPTX generation** (deferred: needs `pptxgenjs`; no PPTX support exists anywhere)
- **Artifact editing via stored spec** (deferred: depends on M2 storage landing)
- **Telegram document delivery** (deferred: no `sendDocument` helper; skipped
  explicitly at the call site per the `CLAUDE.md` parity rule, and stated in PR #34)
- **Conversation search, rename, pin, archive** (deferred: decoration on an unproven flow)
- **Sandbox / code execution** (deferred by decision — see Decisions Made)
- **Full verbatim transcript beyond 20 turns** (deferred: needs a storage decision)

## Context for Resuming Agent

### Important Context

**Neither fix has ever run.** Both are on `development`, `qa` and `staging`
— verified by commit ancestry — but every `deploy.yml` run has failed or been
cancelled. The staging *branch* is current; the staging *environment* is not.
Do not tell the owner to test until a deploy succeeds, or they will verify stale
code and conclude the fix does not work.

**Production has neither fix and is 47 commits behind staging.**

What to verify once a deploy lands:

1. Ask an agent in dashboard chat for a spreadsheet → expect a **download card**,
   and clicking it returns the file rather than `AccessDenied`.
2. Slack should attach the document as a **native file**. Telegram will still
   show only a text link — deliberate.
3. Send a message, reload the page → the conversation persists, appears in the
   sidebar, and reopening replays turns (**≤20** — that is `MAX_TURNS`, not a bug).
4. Switch between conversations in the sidebar; start a new one.

**Do not rebuild the memory system.** `memory-ingest.ts`, `memories-repo.ts` and
`hive-mind-repo.ts` implement a careful design with a prompt-injection trust
boundary. Persistence required no change there.

The full 15-section architecture proposal is at
`C:\Users\EmmanuelAdams\.claude\plans\prompt-research-dynamic-lamport.md` —
§5, §6 and §12 cover the remaining milestones.

### Assumptions Made

- DynamoDB TTL ignores items lacking the attribute. **Verified**, not assumed —
  `sessions-repo.integration.test.ts` proves it against a real DynamoDB.
- Dashboard chats persist, bots expire. **Confirmed with the owner** 2026-08-13.
- No Workspace entity, no `tenantId`. **Confirmed with the owner**, and
  consistent with ADR 0009 and ADR 0002.
- PR #53's `deploy.yml` fixes explain the deploy failures. **Inferred** — the
  logs for the most recent failed run were no longer retrievable
  (`log not found`).
- The ECS task role can write to `CURATED_BUCKET`. **Not verified** — branding
  writes there via presigned PUT, but direct task-role `PutObject` is unconfirmed.
  Check before starting M2; if absent it becomes an IAM change and a `cdk deploy`.

### Potential Gotchas

- **`appendTurns` sets `ttl` in more than one place.** Three write paths total.
  Missing one silently re-arms expiry on a conversation the user can see listed.
- **`appendTurns` retries 3× on `ConditionalCheckFailedException`** behind a
  `version` fence. Do not restructure the write without preserving it.
- **The 60s GET cache** in `web/src/lib/api.ts` hides a newly created
  conversation. `send()` uses a raw `fetch`, so nothing invalidates it — call
  `clearApiCache()`.
- **`chatId` is not a plain id.** `safeDashboardChatId()` re-keys anything not
  prefixed `dashboard:|system:|smoke:|test:`. Round-trip the server's value.
- **Guardrail-blocked turns are deliberately not persisted**, so a conversation
  may hold fewer turns than the user remembers sending.
- **The diagrams drift gate reads committed changes**, not the working tree.
- **Two stray directories to delete by hand:** `.worktrees\persistent-workspaces`
  in the OneDrive clone (OneDrive locked it), and an empty `fix-windows-test-suite`
  in `C:\dev\Netzer-Labs`.

### Where I left off

Stopped deliberately at `staging` on the owner's instruction — *"yes stop at
staging and then i will verify"*. Production was not touched and no deploy was
dispatched.

## Environment State

### Tools/Services Used

- **`gh` CLI** — authenticated as `emmanuelmadams4-lgtm`; works on this repo. The
  GitHub **MCP connector** does not (404s on the private repo).
- **Docker Desktop 29.7.2** — at `%LOCALAPPDATA%\Programs\DockerDesktop\Docker Desktop.exe`
- **Floci 1.6.0** — was started on 127.0.0.1:4566 and left running at session end
- **Git worktrees** under `C:\dev\Netzer-Labs\.worktrees\` (gitignored)

### Active Processes

- Floci container `netzer-os-floci` may still be running. `npm run local:down` stops it.

### Environment Variables

Names only. Local values come from `.env`, created from `.env.local.example`
(**never** `.env.example`, `.env.reference` or `.env.staging.example` — all three
fail `loadEnv()`).

`AWS_ENDPOINT_URL` (the isolation control), `AWS_REGION`, `AWS_ACCESS_KEY_ID`,
`AWS_SECRET_ACCESS_KEY`, `DASHBOARD_TOKEN`, `BEDROCK_DEFAULT_MODEL`,
`RAW_BUCKET`, `CURATED_BUCKET`, `CONFIG_BUCKET`, `TABLE_SESSIONS`, `NODE_ENV`
(never `production` locally).

## Verification evidence

Run immediately before writing this file, 2026-08-14 14:44 UTC.

**Git**
```
git ls-remote --heads origin →
  development eaa9e61   qa 9a5530c   staging 6dfda01   production 7b857d7

fix presence (git merge-base --is-ancestor):
  development  doc-fix=YES  chat-history=YES
  qa           doc-fix=YES  chat-history=YES
  staging      doc-fix=YES  chat-history=YES
  production   doc-fix=no   chat-history=no
git rev-list --count origin/production..origin/staging → 47
```

**Pull requests**
```
#34 feature/persistent-workspaces -> development  MERGED 2026-08-13T15:40:35Z
#36 feature/chat-history          -> development  MERGED 2026-08-13T15:41:44Z
#37 development                   -> qa           MERGED 2026-08-13T16:01:07Z
#38 qa                            -> staging      MERGED 2026-08-13T16:05:02Z
```

**Deploy**
```
gh run list --workflow deploy.yml →
  2026-08-14T05:50 cancelled staging      (push)
  2026-08-14T05:38 failure   staging      (push)
  2026-08-14T05:34 failure   qa           (push)
  2026-08-14T05:28 failure   development  (push)
  2026-08-14T05:25 failure   fix/staging-public-url
  2026-08-14T05:21 failure   fix/staging-public-url
  2026-08-13T18:04 failure   staging      (workflow_dispatch)
→ zero successful deploys
```

**Validation actually run** (on `feature/chat-history`, Windows, 2026-08-13)

| Command | Result |
|---|---|
| `npm run typecheck` | clean |
| `npm test` | 1960 passed; **5 files / 1 test failed — identical to the recorded baseline** |
| `npm run build` | clean |
| `npm --prefix web run typecheck` | clean |
| `npm --prefix web run build` | built, 21.73s |
| `npm run local:test:integration` | **38 passed / 1 failed** — the documented Floci `ListSecrets` gap |
| `npm run local:verify` | all 5 isolation checks passed (`sts:GetCallerIdentity` → `000000000000`) |
| `node scripts/ci/docs-links.mjs` | OK |
| `node scripts/ci/feature-knowledge.mjs` | OK |
| `git diff --check` | clean |
| PR #34 CI | 11/11 green |
| PR #36 CI | 11/11 green |
| PR #37 CI | **20/20 green** — first fully clean promotion in the series |
| PR #38 CI | **21/21 green** |

Baseline recorded on `development` (`8a66ba4`) **before** any change:
`5 failed / 176 passed files; 1 failed / 1942 passed tests`. No regression.

## Related Resources

- PRs: [#34](https://github.com/emmanuelmadams4-lgtm/Netzer-Labs/pull/34),
  [#36](https://github.com/emmanuelmadams4-lgtm/Netzer-Labs/pull/36),
  [#37](https://github.com/emmanuelmadams4-lgtm/Netzer-Labs/pull/37),
  [#38](https://github.com/emmanuelmadams4-lgtm/Netzer-Labs/pull/38)
- Architecture proposal: `C:\Users\EmmanuelAdams\.claude\plans\prompt-research-dynamic-lamport.md`
- Chat-history handoff for a parallel agent: `C:\Users\EmmanuelAdams\Downloads\chat-history-handoff.md`
- Feature docs: `docs/features/persistent-workspaces/README.md`, `HANDOFF.md`
- Process: root `development.md`; `docs/features/README.md`; `CLAUDE.md`
- ADRs: `docs/adr/0002-single-tenant.md`, `docs/adr/0009-mission-container-model.md`
- **Concurrent, unrelated work:** `C:\Users\EmmanuelAdams\Downloads\handoff.md`
  (production SES email, PR #53 open). It fixes `deploy.yml`, so it is very
  likely the unblock for step 1 above.
