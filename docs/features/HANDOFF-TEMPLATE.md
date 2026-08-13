# Session handoff template

> **This file is the template every working session copies.** One session, one
> handoff file, written into the feature folder it worked in. The rules that
> govern it live in the [feature knowledge framework](README.md); this page is
> the artifact those rules point at.
>
> **The structure below is enforced.** `node scripts/ci/feature-knowledge.mjs`
> checks every `docs/features/<slug>/handoffs/*.md` for the file name, the
> frontmatter keys, and the presence of all nine `##` sections. A handoff that
> drops a section fails Docs CI, so delete placeholder *text* but never a
> heading — write "None this session." under it instead.

A session handoff answers one question: **another engineer or agent, with no
access to your chat log, opens this file and continues the work.** If that is
not true when you close your laptop, the file is not done.

---

## Where it goes

```text
docs/features/<slug>/
  README.md                                  durable view      (one, canonical)
  HANDOFF.md                                 current state     (one, canonical)
  handoffs/
    2026-08-10-floci-local-environment.md    session log       (one per session)
    2026-08-12-feature-handoff-protocol.md   ← newest session
```

- File name is `YYYY-MM-DD-<short-kebab-slug>.md`, dated the day the session
  **started**. Two sessions on one day get distinct slugs, never a `-2` suffix.
  The name is machine-checked.
- Session handoffs are **append-only history**. You write yours; you never edit
  someone else's.
- The canonical `HANDOFF.md` stays a single file and keeps carrying only the
  present volatile state. At the end of your session you update it to point at
  your new session log. It is the "where is this right now" page; your session
  file is the "how it got here, and what bit me" page.

Copy the template with the feature folder already created:

```bash
mkdir -p docs/features/<slug>/handoffs
cp docs/features/HANDOFF-TEMPLATE.md \
   docs/features/<slug>/handoffs/$(date +%Y-%m-%d)-<session-slug>.md
```

PowerShell 5.1 has no `&&` and no `mkdir -p`:

```powershell
New-Item -ItemType Directory -Force docs/features/<slug>/handoffs
```

```powershell
Copy-Item docs/features/HANDOFF-TEMPLATE.md "docs/features/<slug>/handoffs/$(Get-Date -Format yyyy-MM-dd)-<session-slug>.md"
```

## The two rules that decide whether this is useful or misleading

1. **Record a baseline before changing anything.** Run the suite on the
   untouched branch first and write down what already fails. Without it, nobody
   can tell a pre-existing failure from a regression you introduced.
2. **Never record a command as passing unless it actually ran.** A skipped
   environment is not a passing result. Write what you did not run, and why.
   This has already gone wrong here once — see carried-forward mistake **M5**.

## Carrying the ledger forward

Three subsections are **carried forward from the previous session's handoff and
then appended to**, never trimmed and never summarised:

| Subsection | Carries |
|---|---|
| **Mistakes Made & Corrections** | `M#` — what went wrong here before, and the lesson |
| **Prevention / Future Guidance** | `P#` — the guardrails those mistakes bought |
| **Assumptions Made** | `A#` — what is taken as true, and how confident |

Nothing is ever deleted from them. An entry that stops being true is marked
`RESOLVED (<commit>)` — or superseded by a later numbered entry — and stays in
place, because "we already tried that and it did not work" is the single most
expensive thing to rediscover.

This is a deliberate exception to the no-duplication rule in
[section 6](README.md#6-what-the-handoff-carries) of the framework, and it is
the only one. Everywhere else duplication is banned because a second copy goes
stale. Here the copy *is* the artifact: a session that inherits an empty ledger
repeats the previous session's mistakes.

The seed ledger below is the accumulated record as of 2026-08-13. A brand-new
feature folder starts from this seed. An existing one starts from its own
newest session log.

## Promote durable facts, do not strand them

A session handoff is a log, so it may hold architecture notes and file maps that
the canonical `HANDOFF.md` is forbidden to carry. That licence comes with an
obligation: anything you learn that will still be true in three months belongs
in the feature `README.md`, an ADR, or [`development.md`](../../development.md)
**as well**. Leaving a durable fact only in a dated session log is how it gets
lost.

---

## The template

Everything below the line, inside the block, is what you copy.

````markdown
---
feature: <slug>
document_role: session-handoff
status: current
observed_at: YYYY-MM-DD
as_of_commit: <full 40-character SHA>
session_slug: <short-kebab-slug>
supersedes: <previous session file name, or none>
---

# Handoff: <task title>

## Session Metadata

- Created: YYYY-MM-DD
- Project: <repository path, and the worktree if not the main checkout>
- Branch: `<branch>` → merges into `<branch>`; reaches `<none | staging | production>`
  ([branch mapping](../../../../development.md#branch-to-environment-mapping))
- Commits: start `<SHA>` → end `<SHA>`. Pushed: yes/no. PR: `#NN`/none. Deployed: no, or the exact command.
- Session duration: <approximate>

Name the branch. Never write "ready for production" — this repository has four
long-lived branches and only two reach an AWS environment.

## Current State Summary

One paragraph: what was being worked on, what state it is in right now, and
where it was left off. Write it for someone who has read nothing else.

## Codebase Understanding

### Architecture Overview

What you had to work out about how the system fits together. Omit anything the
feature README or [`development.md`](../../../../development.md) already says —
link it instead.

### Critical Files

| File | Purpose | Relevance |
|---|---|---|
| `src/path/to/file.ts:142` | What it does | Why the next person will need it |

### Key Patterns Discovered

Idioms this codebase actually uses that a newcomer would otherwise violate.
Cross-surface chat work must respect the parity rule in
[`CLAUDE.md`](../../../../CLAUDE.md).

## Work Completed

### Tasks Finished

- [x] `<TASK-ID>` — what was done
- [ ] `<TASK-ID>` — started, not finished; see Pending Work

### Verification Actually Performed

Fill in the real result. `not run` is an acceptable and expected answer;
a false `pass` is not.

| Command | Baseline (before changes) | After changes |
|---|---|---|
| `npm run typecheck` | | |
| `npm test` | | |
| `npm run build` | | |
| `npm --prefix web run typecheck` | | |
| `npm --prefix web run build` | | |
| `npm run local:test:integration` | | |
| `node scripts/ci/docs-links.mjs` | | |
| `node scripts/ci/feature-knowledge.mjs` | | |
| `git diff --check` | | |

Anything not run, and why:

### Files Modified

| File | Changes | Rationale |
|---|---|---|

### Decisions Made

| Decision | Options Considered | Rationale |
|---|---|---|

Anything durable here must also become an ADR. A decision recorded only in a
session log is not an accepted decision.

## Errors, Mistakes & Learnings

### Errors Encountered

| Error / Symptom | Cause | Resolution | Status |
|---|---|---|---|
| <exact error text or observed failure> | <root cause, if known> | <what fixed it, or what was attempted> | Resolved / Open |

### Mistakes Made & Corrections

> Carried forward from the previous session handoff, then appended. Nothing is
> deleted. A fixed entry is marked `RESOLVED (<commit>)` and stays.

| # | Mistake | Impact | Correction | Lesson |
|---|---|---|---|---|
| M1 | Feature-documentation conventions written on several pages at once | Copies drifted; no page was trustworthy | Single spec in [the framework](../../README.md), machine-checked | One rule, one home, enforced by CI not discipline |
| M2 | Root `handoff.md` used as live, writable operational state | Became a stale global handoff contradicting the per-feature ones | Reduced to a one-sentence compatibility pointer; CI fails if it grows back | Operational state is per-feature; a global handoff always rots |
| M3 | `infra/lib/dynamo-stack.ts` header claims "All 14 DynamoDB tables" | It creates **32**; misled table-count work | Read the synthesized template, never the comment | Comments are not authorities |
| M4 | CodeBuild deploy branch default changed `main`→`production`, then reverted | Churn on a live CI path | Reverted in `4ce27a7`, doc fixes kept | Establish why it was reverted before re-applying |
| M5 | A handoff recorded required checks as complete on a machine with no Node runtime | The next reader would have trusted an unverified contract | Disclosed in the handoff; Docs CI became the first real execution | Disclosure is the minimum; running the check is the goal |
| M6 | Targeted Vitest run inside a Windows linked worktree | Startup failed; no tests collected | Ran from a normal checkout | Superseded by **A7** — the full suite does run in a worktree |
| M7 | Assumed `npm run test:integration:up` was safe alongside the local stack | It starts LocalStack on 4566 and collides with Floci | Use `npm run local:test:integration` | One emulator on 4566, ever |
| M8 | Created `.env` while several lifecycle scripts default their environment flag to **prod** and read it | Previously inert commands became genuinely dangerous | Catalogued in [dangerous commands](../../../../development.md#dangerous-commands-never-run-locally) | Read that list before running any unfamiliar `npm run` |
| M9 | Planned a feature against a commit while a parallel session shipped overlapping work | The plan's core mechanism was obsolete before implementation began | `git fetch` + diffed the anchor files, then rescoped to a delta | Re-read the anchors immediately before implementing an earlier plan |
| M10 | Scaffolded a second feature folder for work that belonged to an existing one | Would have split one feature's record in two — the exact failure M1 describes | Folded into the existing folder before any commit | Search `docs/features/` for an owning folder before creating one |
| M11 | Edited a source file with a PowerShell regex round-trip | The re-encode corrupted every em-dash in it | Repaired with the editor; grepped the tree for further mojibake | Edit source files with an editor, not shell text rewriting |

### Key Learnings

- **Learning 1:** new understanding about the codebase, tooling, workflow, or requirement
- **Learning 2:** behavior, constraint, or edge case discovered
- **Learning 3:** an approach that worked well and should be repeated

### Prevention / Future Guidance

> Carried forward, then appended. Same rules as the mistake ledger.

- **P1** Record a baseline before changing anything.
- **P2** Never record a command as passing unless it actually ran.
- **P3** Name the branch. Never write "ready for production".
- **P4** Run the FULL `npm test` before pushing, never a scoped run ([CLAUDE.md](../../../../CLAUDE.md)).
- **P5** When a document and the code disagree, **the code wins**. Fix the document.
- **P6** Never force-add unrelated uncommitted work found in the tree.
- **P7** Delete a transient branch once it merges.
- **P8** Run `node scripts/ci/feature-knowledge.mjs` and `node scripts/ci/docs-links.mjs` before pushing docs changes.
- **P9** Never restate feature-documentation rules outside [the framework](../../README.md).
- **P10** Before implementing a plan written earlier, `git fetch` and diff the files it anchors on.
- **P11** Edit source files with an editor; a PowerShell regex round-trip corrupts non-ASCII characters.
- **P12** When testing a `streamSSE` route, `await res.text()` before asserting on any mock.
- **P13** Prove a new user-data route against a **non-owner** principal, not only an unauthenticated one.

## Pending Work

### Immediate Next Steps

1. The literal next thing to type or open — not a theme, not "continue the work".
2.
3.

### Blockers/Open Questions

- [ ] Blocker: `<what>` — needs: `<what would unblock it>`
- [ ] Question: `<what is unclear>` — suggested: `<your best guess>`

### Deferred Items

- `<item>` — deferred because `<out of scope / needs user input / blocked on X>`

## Context for Resuming Agent

### Important Context

The critical things the next agent MUST know to continue effectively. This is
the most important section in the file.

### Assumptions Made

> Carried forward, then appended. Same rules as the mistake ledger.

- **A1** Local development never reaches real AWS; `AWS_ENDPOINT_URL` is the isolation control and `scripts/local/guard.ts` fails closed. Prove it with `npm run local:verify` (requires account `000000000000`).
- **A2** [`development.md`](../../../../development.md) was verified on **macOS** on 2026-08-10; its local command set was re-verified on **Windows 11** on 2026-08-13. Linux is unverified.
- **A3** Bedrock is a **stub** locally: fixed placeholder text, `stopReason` always `end_turn`, no `ConverseStream`, no embeddings. Local runs validate plumbing, never model behaviour; tool use is unreachable by design.
- **A4** `qa` deploys nothing, and merging to `production` deploys nothing on its own — `deploy.yml` is `workflow_dispatch` only and requires typing `deploy`.
- **A5** Table names are compiled in at import time (`process.env.TABLE_X ?? 'claudeclaw-<literal>'` in a module-level const), so a `TABLE_*` override must be set before the first import. `src/lib/state/agents-repo.ts` is the lone lazy exception.
- **A6** AWS console access is root-user sign-in via `aws login` with the `netzer-root` profile. The `netzer-dev` SSO profile is known broken.
- **A7** The full vitest suite **does** run in a Windows linked worktree (verified 2026-08-13). Fall back to a normal clone only if startup actually fails (M6).
- **A8** The Windows `npm test` baseline on `development` is **not green**: `scripts/` files fail on shebang parsing, a missing `sh`, and POSIX path assertions. None are in `src/`; CI on ubuntu is green. Check the recorded baseline before blaming a change.

### Potential Gotchas

Short pointers only. The owning document has the detail; do not copy it here.

| Gotcha | Where the detail lives |
|---|---|
| A bare `KEY=` in `.env` becomes `''`, and zod's `.optional()`/`.default()` only fire on `undefined`. Omit the line instead. | [Environment variables](../../../../development.md#environment-variables) |
| `.env.example`, `.env.reference` and `.env.staging.example` all fail `loadEnv()`. Only `.env.local.example` works. | [Environment variables](../../../../development.md#environment-variables) |
| `NODE_ENV=production` locally arms a deployed-task fail-fast; the orchestrator refuses to start. | [Environment variables](../../../../development.md#environment-variables) |
| `CCE_NAME_SUFFIX` renames tables but four modules read the unsuffixed literal anyway. | [Environment variables](../../../../development.md#environment-variables) |
| Vite does **not** always use port 5173, and binds `localhost` (IPv6 `::1`). Read the URL Vite prints. | [Troubleshooting](../../../../development.md#troubleshooting) |
| `GET /ready` returning `503` locally is **correct** — Slack and Telegram are genuinely unconfigured. | [Starting development](../../../../development.md#starting-development) |
| A poisoned row in `claudeclaw-dashboard-tokens` causes a permanent `401` with a correct token. Fix: `npm run local:provision`. | [Troubleshooting](../../../../development.md#troubleshooting) |
| Floci answers `ConverseStream` with 501; the replay fallback fires **only** when `AWS_ENDPOINT_URL` is set. | [Troubleshooting](../../../../development.md#troubleshooting) |
| `src/adapters/dashboard/jarvis.flow.test.ts` intermittently times out at 5000 ms. Reproduce twice before chasing it. | [Troubleshooting](../../../../development.md#troubleshooting) |
| The IAM Copilot **degrades invisibly** locally: an empty findings list renders identically to "validated clean". | [Known local limitations](../../../../development.md#known-local-limitations) |
| The cost waste scan reports a **false clean** and caches it for 30 minutes. | [Known local limitations](../../../../development.md#known-local-limitations) |
| `npm run doctor`, `status` and `verify` fail rather than skip against an empty emulator. | [Known local limitations](../../../../development.md#known-local-limitations) |
| PowerShell 5.1 has no `&&`; chain with `; if ($?) { … }`. | [Contributing](../../../../CONTRIBUTING.md) |

## Environment State

### Tools/Services Used

- `<tool/service>`: versions and configuration that mattered.

### Active Processes

- Dev servers, watchers, containers left running — or "none".

### Environment Variables

- Names only. **Never values, never secrets.**

### Uncommitted Work Left in the Tree

- What it is and whose it is. Per **P6**, do not commit work that is not yours.

## Related Resources

- [Feature README](../README.md)
- [Feature HANDOFF (current state)](../HANDOFF.md)
- [Previous session handoff](./<previous-file>.md)
- [Feature knowledge framework](../../README.md)
- [Local development guide](../../../../development.md)
- [Contributing and branch promotion](../../../../CONTRIBUTING.md)
````

---

## Before you close the session

1. Fill **Verification Actually Performed** honestly.
2. Carry the three ledgers forward and append what bit you.
3. Promote durable facts into the feature `README.md`, an ADR, or `development.md`.
4. Update the feature's canonical [`HANDOFF.md`](missions/HANDOFF.md) so its
   current state and its session index point at your new file.
5. Run both documentation gates:

```bash
node scripts/ci/feature-knowledge.mjs
```

```bash
node scripts/ci/docs-links.mjs
```

## Related documents

- [Feature knowledge framework](README.md) — the rules this template implements
- [Missions feature folder](missions/README.md) and [Missions HANDOFF](missions/HANDOFF.md), the reference implementation
- [Local development guide](../../development.md)
- [Contributing and branch promotion](../../CONTRIBUTING.md)
