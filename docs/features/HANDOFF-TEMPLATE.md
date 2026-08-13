# Session handoff template

> **This file is the template every working session copies.** One session, one
> handoff file, written into the feature folder it worked in. The rules that
> govern it live in the [feature knowledge framework](README.md); this page is
> the artifact those rules point at.

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
- Session handoffs are **append-only history**. You write yours; you never edit
  someone else's.
- The canonical `HANDOFF.md` stays a single file and keeps carrying only the
  present volatile state. At the end of your session you update it to point at
  your new session log. It is the "where is this right now" page; your session
  file is the "how it got here, and what bit me" page.

Copy the template with the feature folder already created:

```bash
cp docs/features/HANDOFF-TEMPLATE.md \
   docs/features/<slug>/handoffs/$(date +%Y-%m-%d)-<session-slug>.md
```

## The two rules that decide whether this is useful or misleading

1. **Record a baseline before changing anything.** Run the suite on the
   untouched branch first and write down what already fails. Without it, nobody
   can tell a pre-existing failure from a regression you introduced.
2. **Never record a command as passing unless it actually ran.** A skipped
   environment is not a passing result. Write what you did not run, and why.
   This has already gone wrong here once — see carried-forward mistake **M5**.

## Carrying the ledger forward

Section 5, **Carried-forward mistakes, assumptions and precautions**, is not
optional and is not yours to shorten. Open the previous session's handoff for
this feature, copy that section forward verbatim, then append what your session
learned. Nothing is ever deleted from it; an entry that stops being true is
marked `RESOLVED` with the commit that resolved it and stays in place, because
"we already tried that and it did not work" is the single most expensive thing
to rediscover.

The seed below is the accumulated ledger as of 2026-08-12. A brand-new feature
folder starts from this seed. An existing one starts from its own latest
session handoff.

## Promote durable facts, do not strand them

A session handoff is a log, so it may hold architecture notes and file maps that
the canonical `HANDOFF.md` is forbidden to carry. That licence comes with an
obligation: anything you learn that will still be true in three months belongs
in the feature `README.md`, an ADR, or [`development.md`](../../development.md)
**as well**. Leaving a durable fact only in a dated session log is how it gets
lost. Section 4.4 of the template is where you record that you did it.

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

# Session handoff: <task title>

## 1. Session metadata

| Field | Value |
|---|---|
| Session started | YYYY-MM-DD |
| Feature folder | `docs/features/<slug>/` |
| Branch worked on | `<branch>` — name it, never say "a feature branch" |
| Branch it merges into next | `<branch>` |
| AWS environment that branch reaches | none / staging / production — per the [branch-to-environment mapping](../../../../development.md#branch-to-environment-mapping) |
| Commit at session start | `<SHA>` |
| Commit at session end | `<SHA>` |
| Pushed | yes / no — committed locally and pushed are different states |
| PR | `#NN` / none |
| Deployed | no, or the exact command that deployed it |

## 2. Current state summary

One paragraph. What was being worked on, what state it is in right now, and
where it was left off. Write it for someone who has read nothing else.

## 3. Codebase understanding

### 3.1 Architecture notes discovered this session

What you had to work out about how the system fits together. Omit anything the
feature README or [`development.md`](../../../../development.md) already says —
link it instead.

### 3.2 Critical files

| File | Purpose | Why it mattered this session |
|---|---|---|
| `src/path/to/file.ts:142` | What it does | Why the next person will need it |

### 3.3 Patterns and conventions to follow

Idioms this codebase actually uses that a newcomer would otherwise violate.
Cross-surface chat work must respect the parity rule in
[`CLAUDE.md`](../../../../CLAUDE.md).

## 4. Work completed

### 4.1 Tasks finished

- [x] `<TASK-ID>` — what was done
- [ ] `<TASK-ID>` — started, not finished; see section 6

### 4.2 Files modified

| File | Change | Rationale |
|---|---|---|

### 4.3 Decisions made

| Decision | Options considered | Why this one |
|---|---|---|

Anything durable here must also become an ADR. A decision recorded only in a
session log is not an accepted decision.

### 4.4 Durable facts promoted out of this log

| Fact learned | Promoted into | Done |
|---|---|---|
| | `docs/features/<slug>/README.md` / ADR / `development.md` | yes / no — if no, say why |

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

## 6. Pending work

### 6.1 Smallest next action

One concrete step. Not a theme, not "continue the work" — the literal next thing
to type or open.

### 6.2 Immediate next steps

1.
2.
3.

### 6.3 Blockers and open questions

- [ ] Blocker: `<what>` — needs: `<what would unblock it>`
- [ ] Question: `<what is unclear>` — suggested resolution: `<your best guess>`

### 6.4 Deferred, and why

- `<item>` — deferred because `<out of scope / needs user input / blocked on X>`

## 7. Verification actually performed

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

## 8. Environment state

- **Tools and services**: versions and configuration that mattered.
- **Active processes**: dev servers, watchers, containers left running.
- **Environment variables**: names only. **Never values, never secrets.**
- **Uncommitted work left in the tree**: what it is and whose it is. Per **P6**,
  do not commit work that is not yours.

## 9. Related documents

- [Feature README](../README.md)
- [Feature HANDOFF (current state)](../HANDOFF.md)
- [Previous session handoff](./<previous-file>.md)
- [Feature knowledge framework](../../README.md)
- [Local development guide](../../../../development.md)
- [Contributing and branch promotion](../../../../CONTRIBUTING.md)
````

---

## Before you close the session

1. Fill section 7 honestly.
2. Carry section 5 forward and append what bit you.
3. Promote durable facts (section 4.4).
4. Update the feature's canonical [`HANDOFF.md`](missions/HANDOFF.md) so its
   current state and its session index point at your new file.
5. Run both documentation gates:

```bash
node scripts/ci/feature-knowledge.mjs
node scripts/ci/docs-links.mjs
```

## Related documents

- [Feature knowledge framework](README.md) — the rules this template implements
- [Missions feature folder](missions/README.md) — a live feature folder
- [Local development guide](../../development.md)
- [Contributing and branch promotion](../../CONTRIBUTING.md)
