---
feature: librechat-chat-ui
document_role: session-handoff
status: current
observed_at: 2026-08-25
as_of_commit: 06ebe1caf91c4053b0bce6a8fc3c2c82fb9d2710
session_slug: phase-0-scaffolding
supersedes: none
---

# Session handoff: LibreChat chat UI port — Phase 0 scaffolding

## 1. Session metadata

| Field | Value |
|---|---|
| Session started | 2026-08-25 |
| Feature folder | `docs/features/librechat-chat-ui/` |
| Branch worked on | `feature/librechat-chat-ui` |
| Branch it merges into next | `development` |
| AWS environment that branch reaches | none — per the [branch-to-environment mapping](../../../../development.md#branch-to-environment-mapping) |
| Commit at session start | `06ebe1caf91c4053b0bce6a8fc3c2c82fb9d2710` |
| Commit at session end | (session open) |
| Pushed | no |
| PR | none |
| Deployed | no |

## 2. Current state summary

Phase 0 of the LibreChat UI port (plan: eight phases, builder + blind-critic
loop per phase — see [plan.md](../plan.md)). This session: created the working
checkout (a full clone at `C:\dev\_netzer-librechat` — a linked worktree was
created first and abandoned because of ledger entry M6), pinned the donor
(danny-avila/LibreChat `main` @ `6d499ba3ce17f906a7762429c61018f230ecd64e`),
created this feature folder (README + HANDOFF + plan.md, both docs gates OK),
recorded the baseline twice, stood up BOTH comparison stacks (LibreChat on
docker :3080 with a mock OpenAI endpoint; our dashboard on :5173 against Floci),
captured the house-style screenshot set, and ran a builder agent that produced
the Phase-0 extraction **uncommitted and unverified** (see 4.1/6.1). The
session ended at a usage limit; the next session (Codex) picks up at §6.1.

**⚠ UNCOMMITTED, UNVERIFIED work in the clone's working tree** (a builder agent
wrote it; its verifier never ran): modified `web/src/pages/Chat.tsx` and
`web/vite.config.ts`; new `web/src/lib/chat/`, `web/dev/`,
`src/adapters/dashboard/chat-stream.test.ts`,
`src/adapters/dashboard/chat-helpers.test.ts`. Treat every claim about this
code as unproven until the checks in §6.2 pass.

## 3. Codebase understanding

### 3.1 Architecture notes discovered this session

- The dashboard is Preact 10 + Tailwind 3.4 with a raw-`var()` token bridge, so
  Tailwind opacity modifiers on semantic colors (`bg-primary/10`) silently emit
  no CSS. The port adds additive RGB-triplet tokens rather than touching the
  existing bridge. Details in the [feature README](../README.md) appendix.
- LibreChat donor stack (React 18, Ariakit, Recoil/Jotai, i18next) is not
  consumed at runtime — the port is source-level into Preact (user decision).

### 3.2 Critical files

| File | Purpose | Why it mattered this session |
|---|---|---|
| `web/src/pages/Chat.tsx` | The 838-line monolith being decomposed | Every behavior contract to preserve lives here |
| `web/src/index.css` | Token layers + `.chat-md` shared prose | `.chat-md` is shared with WarRoom/Playground — additive changes only |
| `web/tailwind.config.ts` | Token bridge | The dead-opacity landmine; additive `-a` keys land here |
| `web/src/lib/theme.ts` | White-label engine | `applyBrand()` must co-write `--color-primary-rgb` |
| `src/lib/jarvis/route-manifest.test.ts` | Regex-parses App.tsx routes | Route paths/gates must not change |

### 3.3 Patterns and conventions to follow

- Chat-surface parity per [CLAUDE.md](../../../../CLAUDE.md): tool status,
  streaming placeholder, run footer, error rendering, kb/image/artifact.
- `data-tour="chat-agent-picker" | "chat-input" | "chat-new-chat"` must survive
  on equivalent elements (product tour).
- Type-to-confirm `ConfirmDialog` for destructive actions; no native confirm().

## 4. Work completed

### 4.1 Tasks finished

- [x] Working checkout created (full clone, branch from `origin/development`)
- [x] Donor pinned (`6d499ba3ce17…`; re-clone with
      `git clone https://github.com/danny-avila/LibreChat && git checkout 6d499ba3ce17f906a7762429c61018f230ecd64e`)
- [x] Feature folder (README, HANDOFF, plan.md, this file) created before code;
      `feature-knowledge.mjs` and `docs-links.mjs` both OK
- [x] Baseline `npm test` recorded twice (see §7) — identical both runs
- [x] LibreChat comparison stack up: docker compose in the QA assets folder
      (see §8), api recreated with `librechat.yaml` custom endpoint
      "Netzar Mock" → mock OpenAI server on :8899 (config loaded, verified in
      container logs)
- [x] House-style screenshot set captured (12 shots: light/dark desktop +
      light mobile of Overview/Agents/Sessions/current Chat)
- [~] CHATUI-000 extraction + golden tests + mock plugin — builder agent WROTE
      the files (uncommitted); verifier never ran; NOT verified, NOT committed
- [ ] LibreChat bar screenshot set — partial: light-desktop 4 shots good but
      the conversation shows the default OpenAI endpoint erroring ("No key
      found") instead of Netzar Mock; dark/mobile sets failed (auth didn't
      carry via storageState). FIXED capture script exists (per-context login +
      explicit endpoint selection) but was not rerun.

### 4.2 Files modified

| File | Change | Rationale |
|---|---|---|
| `docs/features/librechat-chat-ui/*` | Created | Framework requirement before code |

### 4.3 Decisions made

| Decision | Options considered | Why this one |
|---|---|---|
| Full clone, not linked worktree | worktree under `.worktrees/` vs clone at `C:\dev\_netzer-librechat` | Ledger M6: Vitest cannot start in a Windows linked worktree; repo precedent (`_netzer-ha`, `_netzer-staging`) |
| Donor pin | `v0.8.7` tag vs `main` @ SHA | Key donor paths (UnifiedSidebar, theme layer) exist only on `main`; pinned SHA gives reproducibility |
| Preact-native source port (user decision) | vs `react`→`preact/compat` aliasing + donor libs | Zero compat risk to the other 31 pages; donor value is markup + patterns |

### 4.4 Durable facts promoted out of this log

| Fact learned | Promoted into | Done |
|---|---|---|
| Token mapping table + donor pin | `docs/features/librechat-chat-ui/README.md` | yes |

## 5. Carried-forward mistakes, assumptions and precautions

> Copied forward from the previous session handoff, then appended to. Nothing is
> deleted. An entry that is fixed is marked `RESOLVED (<commit>)` and stays.

### 5.1 Process precautions

| # | Precaution | Why it exists |
|---|---|---|
| P1 | Record a baseline before changing anything. | Without it a pre-existing failure is indistinguishable from a regression you caused. |
| P2 | Never record a command as passing unless it actually ran. Say what you skipped and why. | See M5: a handoff once carried checks that no runtime could have executed. |
| P3 | Name the branch. Never write "ready for production". | Four long-lived branches exist and only two reach an AWS environment. |
| P4 | Run the FULL `npm test` before pushing, never a scoped run. | Required by [`CLAUDE.md`](../../../../CLAUDE.md). Scoped runs have hidden cross-module regressions here. |
| P5 | When a document and the code disagree, **the code wins**. Fix the document. | The framework's stated tie-break. |
| P6 | Never force-add unrelated uncommitted work you find in the tree. Preserve it and hand it back to its owner. | Stray files found during cleanup are somebody's in-flight work, not yours to merge. |
| P7 | Delete a transient branch once it merges. | Only `development`, `qa`, `staging`, `production` survive, so a handoff that names a branch names something that still exists. |
| P8 | Docs changes must pass `node scripts/ci/feature-knowledge.mjs` and `node scripts/ci/docs-links.mjs` before pushing. | Docs CI runs them anyway; failing there costs a round trip. |
| P9 | Never restate feature-documentation rules outside [the framework](../../README.md). | A second copy is exactly how these conventions drifted before — see M1. |

### 5.2 Mistakes already made, and their corrections

| # | Mistake | Impact | Correction | Lesson |
|---|---|---|---|---|
| M1 | Feature-documentation conventions were written on several pages at once. | The copies drifted and no page was trustworthy. | Single specification in [the framework](../../README.md), machine-checked by `scripts/ci/feature-knowledge.mjs`. | One rule, one home, enforced by CI rather than by discipline. |
| M2 | The repository-root `handoff.md` was used as live, writable operational state. | It became a stale global handoff that contradicted the per-feature ones. | Reduced to a one-sentence compatibility pointer; CI now fails if it grows back. | Operational state is per-feature. A global handoff always rots. |
| M3 | `infra/lib/dynamo-stack.ts` carries a header comment claiming "All 14 DynamoDB tables". | It creates **32**. The comment misled table-count work. | Read the synthesized template, never the comment. | Comments are not authorities. `infra/lib/constants.ts` and the synth output are. |
| M4 | The CodeBuild deploy branch default was changed from `main` to `production`, then reverted. | Churn on a live CI path; the doc fixes from that change were kept, the behaviour change was not. | Reverted in `4ce27a7`, doc fixes retained. | Do not re-apply this without first establishing why it was reverted. |
| M5 | A feature handoff recorded required checks as complete when the authoring machine had no Node runtime, so they could not have run. | The next reader would have trusted an unverified contract. | Disclosed explicitly in the handoff; Docs CI on `development` became the first real execution. | This is precisely what P2 exists to prevent. Disclosure is the minimum; running the check is the goal. |
| M6 | Targeted Vitest was run inside a Windows **linked worktree**. | Startup failed with `Cannot read directory "../../../../../../../.."` and could not resolve `vitest.config.ts`; no tests collected. | Ran from a normal checkout instead. | On Windows, run test suites from a normal clone. Dependency-free Node CI scripts are fine in a worktree; Vitest is not. |
| M7 | `npm run test:integration:up` was assumed safe alongside the local stack. | It starts LocalStack on port 4566 and collides with Floci. Two emulators must never run at once. | Use `npm run local:test:integration`, which passes `--env-file=.env`. | One emulator on 4566, ever. |
| M8 | `.env` was created for local development while several lifecycle scripts default their environment flag to **prod** and read `.env`. | Commands that were previously inert became genuinely dangerous. | Catalogued in [dangerous commands](../../../../development.md#dangerous-commands-never-run-locally). | Read that list before running any unfamiliar `npm run` script. |
| M9 | *(this session)* A linked worktree was created under `.worktrees/` for this feature before re-reading M6. | Wasted setup; a locked `node_modules` left an orphaned directory `.worktrees/librechat-chat-ui` in the main checkout pending manual deletion. | Abandoned; full clone at `C:\dev\_netzer-librechat` used instead. | Read the ledger before environment setup, not after. |

### 5.3 Standing assumptions

| # | Assumption | Confidence and caveat |
|---|---|---|
| A1 | Local development never reaches real AWS; `AWS_ENDPOINT_URL` is the isolation control and `scripts/local/guard.ts` fails closed. | Verified. Prove it any time with `npm run local:verify`, which requires account id `000000000000`. |
| A2 | [`development.md`](../../../../development.md) was verified on **macOS**, Floci 1.6.0, Docker 28.3.2, Node 24.3.0, on 2026-08-10. | Windows and Linux behaviour is **not** covered by that verification. See M6. |
| A3 | Bedrock is a **stub** locally: fixed placeholder text, `stopReason` always `end_turn`, no `ConverseStream`, no embeddings. | Local development validates plumbing, never model behaviour. Tool use is unreachable locally by design. |
| A4 | `qa` deploys nothing, and merging to `production` deploys nothing on its own. | Verified in `.github/workflows/deploy.yml`; deployment is `workflow_dispatch` only and requires typing `deploy`. |
| A5 | Table names are compiled in at import time (`process.env.TABLE_X ?? 'claudeclaw-<literal>'` in a module-level const). | A `TABLE_*` override must be set before the first import. `src/lib/state/agents-repo.ts` is the lone lazy exception. |
| A6 | AWS console access for this account is root-user sign-in via `aws login` with the `netzer-root` profile. | The `netzer-dev` SSO profile is known broken. Do not burn time on it. |

### 5.4 Known traps that cost time

Short pointers only. The owning document has the detail; do not copy it here.

| Trap | Where the detail lives |
|---|---|
| A bare `KEY=` in `.env` becomes `''`, and zod's `.optional()`/`.default()` only fire on `undefined`. Omit the line instead. | [Environment variables](../../../../development.md#environment-variables) |
| `.env.example`, `.env.reference` and `.env.staging.example` all fail `loadEnv()`. Only `.env.local.example` works. | [Environment variables](../../../../development.md#environment-variables) |
| `NODE_ENV=production` locally arms a deployed-task fail-fast; the orchestrator refuses to start. | [Environment variables](../../../../development.md#environment-variables) |
| `CCE_NAME_SUFFIX` renames tables but four modules read the unsuffixed literal anyway. | [Environment variables](../../../../development.md#environment-variables) |
| Vite does **not** always use port 5173, and binds `localhost` (IPv6 `::1`), so the IPv4 literal fails. Read the URL Vite prints. | [Troubleshooting](../../../../development.md#troubleshooting) |
| `GET /ready` returning `503` locally is **correct** — Slack and Telegram are genuinely unconfigured. | [Starting development](../../../../development.md#starting-development) |
| A poisoned row in `claudeclaw-dashboard-tokens` causes a permanent `401` with a correct token. Fix: `npm run local:provision`. | [Troubleshooting](../../../../development.md#troubleshooting) |
| Floci answers `ConverseStream` with 501; the replay-as-non-streaming fallback fires **only** when `AWS_ENDPOINT_URL` is set. | [Troubleshooting](../../../../development.md#troubleshooting) |
| `src/adapters/dashboard/jarvis.flow.test.ts` intermittently times out at 5000 ms. Pre-existing flake. Reproduce twice before chasing it. | [Troubleshooting](../../../../development.md#troubleshooting) |
| The IAM Copilot **degrades invisibly** locally: an empty findings list renders identically to "validated clean". | [Known local limitations](../../../../development.md#known-local-limitations) |
| The cost waste scan reports a **false clean** and caches it for 30 minutes. Local cost output is not meaningful. | [Known local limitations](../../../../development.md#known-local-limitations) |
| `npm run doctor`, `status` and `verify` fail rather than skip against an empty emulator. They give no useful local signal. | [Known local limitations](../../../../development.md#known-local-limitations) |
| Tailwind opacity modifiers on this app's semantic colors (`bg-primary/10`) emit **no CSS** — raw `var()` strings lack `<alpha-value>`. Use the `-a` triplet keys or `*-dim` vars. | [Feature README appendix](../README.md) |

## 6. Pending work

### 6.1 Smallest next action

Verify the builder's uncommitted Phase-0 extraction: from
`C:\dev\_netzer-librechat`, run
`npx vitest run src/adapters/dashboard/chat-stream.test.ts src/adapters/dashboard/chat-helpers.test.ts`.

### 6.2 Immediate next steps

1. Adversarially verify the uncommitted extraction (see §2 warning): moved
   helper/parser bodies must match `origin/development:web/src/pages/Chat.tsx`
   verbatim (comments included); Chat.tsx JSX must be character-identical;
   then run the two new test files, `npm --prefix web run typecheck`,
   `npm --prefix web run build`, and full `npm test` (compare against §7
   baseline — anything new is a regression to fix).
2. Commit in small conventional commits (docs folder first), per
   [CONTRIBUTING.md](../../../CONTRIBUTING.md).
3. Rerun the fixed LibreChat bar capture script (QA assets folder, §8):
   it must select the "Netzar Mock" endpoint before sending, and log in per
   themed context. Freeze the resulting set — critics reuse it for every phase.
4. Proceed to CHATUI-001 (theming) per [plan.md](../plan.md): phase gate =
   builder + separate blind critic comparing against the frozen LibreChat set
   AND the house set; loop until the critic picks ours.
5. Update the live progress page at each phase gate (see §8).

### 6.3 Blockers and open questions

- [ ] The `/gsd-phase` skill on the original machine is a stub (no `gsd-core`
      engine); phase state is tracked in `.planning/ROADMAP.md` in the clone,
      which is git-excluded (`.git/info/exclude`) and local-only.

### 6.4 Deferred, and why

- `AgentDetail.tsx` ChatTab restyle — out of scope per plan; noted for the PR body.
- Orphaned dir `C:\dev\Netzer-Labs\.worktrees\librechat-chat-ui` (file lock) — delete when the lock clears; git already pruned it.

## 7. Verification actually performed

| Command | Baseline (before changes) | After changes |
|---|---|---|
| `npm run typecheck` | not run | not run |
| `npm test` | **ran twice, identical**: 235 files: 5 failed / 229 passed / 1 skipped; 2897 tests: 1 failed / 2890 passed / 6 skipped. Failing files: `scripts/ci/docs-links.test.ts`, `scripts/ci/feature-knowledge.test.ts`, `scripts/ci/runnable-blocks.test.ts`, `scripts/release/sync-deprecations.test.ts` (all four: `SyntaxError: Invalid or unexpected token` at a comment during collect — environmental), `scripts/lib/lifecycle/rollback-classes.test.ts > infra class > deploys the archived assembly with --app and diffs first` (real assertion). Note: bare `npx vitest run` ADDITIONALLY fails 2 `src/lib/audit/audit-writer.test.ts` cases that `npm test` passes — env-sensitive; always baseline with `npm test`. | not run after builder changes |
| `npm run build` | not run | not run |
| `npm --prefix web run typecheck` | not run | not run (builder claimed to run it; unverified) |
| `npm --prefix web run build` | not run | not run (unverified) |
| `npm run local:test:integration` | not run | not run |
| `node scripts/ci/docs-links.mjs` | OK (pre-docs) | **OK** (with README/HANDOFF/plan.md present; 117 files, 1278 links) |
| `node scripts/ci/feature-knowledge.mjs` | OK (pre-docs) | **OK** |
| `git diff --check` | not run | not run |

Anything not run, and why: session ended at a usage limit mid-Phase-0; the
builder's extraction is unverified (its verifier agent never ran). Do not trust
any "after changes" claim until re-run.

## 8. Environment state

- **Tools and services**: Windows 11, Node (repo `.nvmrc` pins 20; Node 24
  present), git, Docker Desktop (per-user install:
  `C:\Users\EmmanuelAdams\AppData\Local\Programs\DockerDesktop`).
- **QA assets folder (durable): `C:\dev\_netzer-librechat-qa\`** — mock OpenAI
  server (`mock-openai.js`, run `node mock-openai.js`, listens :8899), the
  LibreChat `librechat.yaml` + `docker-compose.override.yml` (copy into a
  LibreChat checkout at the pinned SHA and `docker compose up -d`), Playwright
  capture scripts (`capture-librechat-bar.js` — the FIXED version;
  `capture-house.js`), and `bar/` screenshots (`bar/house/` complete 12 shots;
  `bar/librechat/` partial — see 4.1). Playwright itself was installed in a
  session-temp dir; reinstall with `npm i playwright && npx playwright install
  chromium` next to the scripts.
- **Active processes at session end** (all safe to kill/restart): orchestrator
  `:3000` (tsx watch in the clone; started via `npm run dev`), Vite dashboard
  `:5173` (`npm --prefix web run dev`), mock OpenAI `:8899`, LibreChat docker
  stack `:3080` (containers LibreChat/chat-mongodb/chat-meilisearch/rag_api/
  vectordb; admin-panel crash-loops — irrelevant), Floci emulator `:4566`
  (container netzer-os-floci). Trap hit twice this session: piping a dev
  server's output through `head` kills it via SIGPIPE once enough lines pass —
  run servers with NO output pipe.
- **`scripts/local/dev.mjs` fails on this machine** (`spawn npm ENOENT` under
  Git Bash after provisioning succeeds) — start the orchestrator and dashboard
  separately per development.md's secondary workflows, as above.
- **Live progress page** (Claude artifact, update at each phase gate):
  https://claude.ai/code/artifact/6a23c430-b651-4ad3-9cca-4774d2473f6b
- **Environment variables**: clone has `.env` created from `.env.local.example`
  by `npm run local` (local-only values). `CCE_CHAT_MOCK=1` arms the mock SSE
  plugin (builder-written, unverified).
- **Uncommitted work left in the tree**: (a) the main checkout
  `C:\dev\Netzer-Labs` carries someone's in-flight `feature/paperclip-phase-1-5`
  work (modified CLAUDE.md + untracked handoffs) — untouched per P6; note its
  `.worktrees/librechat-chat-ui` orphan directory is file-locked leftovers from
  the abandoned worktree (git already pruned it) — delete when unlocked;
  (b) THIS clone's working tree holds the builder's uncommitted Phase-0
  extraction (§2) plus this docs folder — commit docs first, extraction only
  after verification. A reference COPY of this docs folder exists (untracked)
  at `C:\dev\Netzer-Labs\docs\features\librechat-chat-ui\` for discoverability;
  the clone's copy on `feature/librechat-chat-ui` is canonical.

## 9. Related documents

- [Feature README](../README.md)
- [Feature HANDOFF (current state)](../HANDOFF.md)
- [Feature knowledge framework](../../README.md)
- [Local development guide](../../../../development.md)
- [Contributing and branch promotion](../../../../CONTRIBUTING.md)
