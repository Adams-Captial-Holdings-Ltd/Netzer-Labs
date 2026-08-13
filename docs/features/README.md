# Feature knowledge framework

> This page is the single specification for how feature work is documented in this repository. Every meaningful feature gets one folder, `docs/features/<slug>/`, holding two canonical files — a `README.md` that describes verified behavior and names its authorities, and a `HANDOFF.md` that carries only volatile operational state — plus a `handoffs/` directory in which **every working session writes its own dated handoff** from the [session handoff template](HANDOFF-TEMPLATE.md). The folder shape, the frontmatter contract, the vocabularies, and the required sections of the two canonical files are machine-checked by `node scripts/ci/feature-knowledge.mjs` in Docs CI, so that part of the format cannot quietly drift; the session-handoff rules in [section 6a](#6a-session-handoffs-one-per-session) are enforced by review.

There is no second copy of these rules. [`development.md`](../../development.md)
owns the branch-to-environment mapping and links here; [`AGENTS.md`](../../AGENTS.md)
and the [documentation index](../README.md) link here for discovery. If you are
about to write feature conventions into another page, put them here instead.

[Missions](missions/README.md) is the reference implementation. Read its
[README](missions/README.md) and [HANDOFF](missions/HANDOFF.md) alongside this
spec.

---

## 1. When this applies

Create a feature folder when work is **meaningful**: it spans more than one
sitting, more than one person or agent, or more than one branch, and someone
picking it up later would otherwise have to reconstruct the context from chat
logs.

Do not create one for a trivial change. A typo fix, a dependency bump, or a
one-file refactor is carried by its commit message and its PR.

The test that matters: **another engineer or AI agent must be able to open the
feature folder and continue the work without access to the conversation, chat
log, or person that produced it.** If that is not true, the folder is not done.

## 2. The shape

```text
docs/features/<slug>/
  README.md                          document_role: index            status: current
  HANDOFF.md                         document_role: handoff          status: current
  handoffs/
    YYYY-MM-DD-<session-slug>.md     document_role: session-handoff  status: current
```

- `<slug>` is lowercase kebab-case (`missions`, `warp-private-access`).
- A new folder begins with **only** `README.md` and `HANDOFF.md`. The
  `handoffs/` directory appears the first time a session works in the folder.
- Those two canonical files stay canonical: exactly one of each, machine-checked.
- `handoffs/` holds **one file per working session** and is append-only history.
  It is the single sanctioned exception to the sprawl rule below, because the
  alternative — one handoff overwritten by every session — destroys the record
  of what was already tried and why it failed. See
  [section 6a](#6a-session-handoffs-one-per-session).
- Add any *other* document only after a demonstrated maintenance need cannot be
  met by those files and their linked authorities. Sprawl is the failure mode
  this framework exists to prevent.
- Durable authorities (ADRs, backlogs, audits) live where they already live and
  are **declared by frontmatter**, not copied into the folder.

The repository root [`handoff.md`](../../handoff.md) is compatibility-only. It
holds one sentence pointing at a canonical feature HANDOFF, and it must never
become writable operational state again.

## 3. Frontmatter contract

Both files open with YAML frontmatter. These five keys are required on every
feature document:

| Key | Meaning |
|---|---|
| `feature` | The folder slug. Must match the directory name exactly. |
| `document_role` | What kind of document this is (table below). |
| `status` | Its lifecycle state (table below). |
| `observed_at` | `YYYY-MM-DD`, the date the claims were actually checked. |
| `as_of_commit` | The full commit SHA the claims were checked against. |

`observed_at` and `as_of_commit` are the honesty mechanism. They say *when* and
*against what* a statement was true, so a reader can tell a fresh fact from a
stale one without trusting the author's memory.

### Relationship keys

The feature README declares its authorities. Each is optional, but when present
it must be a **YAML list** (never a scalar), and every entry must be a
repository-relative path to a Git-tracked file that exists:

| Key | Points at | Governs |
|---|---|---|
| `implemented_by` | Source files | Present runtime behavior |
| `tested_by` | Test files | What is actually covered |
| `decisions` | ADRs | Durable accepted architecture |
| `approved_work` | A backlog | The only approved execution queue |
| `evidence` | An audit or report | Dated historical findings |

`approved_work` and `evidence` targets must be Markdown files, because the
validator reads their contents.

## 4. Vocabularies

Use these exact values. The validator rejects anything else.

**`document_role`** — `index`, `handoff`, `decision`, `backlog`, `evidence`,
`compatibility`.

Session logs under `handoffs/` use `document_role: session-handoff` plus two
extra keys, `session_slug` and `supersedes`. The validator checks only the two
canonical files, so it neither requires nor rejects these; they are a
convention, honoured by review rather than by CI.

**`status`**

| Value | Means |
|---|---|
| `current` | The present maintained view. Required on every feature README and HANDOFF. |
| `accepted` | An approved durable decision or work definition. |
| `historical` | Dated evidence. True when observed, not maintained since. |
| `superseded` | Replaced. Kept only so old links resolve. |
| `compatibility` | Exists only to redirect an old entry point. |

**`work_state`** (active backlog items only) — `approved`, `in_progress`,
`blocked`.

**`outcome`** (closed backlog items only) — `landed`, `rejected`, `superseded`,
`claimed_unverified`.

**`verification`** — `not_run`, `code_verified`, `environment_verified`.

An item declares **either** a `work_state` **or** a closed-out block, never
both. A closed item must carry all five of `outcome`, `reachable_commit`,
`present_in_current_source`, `deployment`, and `verification`.

Task IDs (`MISSION-012`, `WARP-003`) are permanent. A rejected or superseded ID
is retired forever and must never be reused, and it must not appear in any
`**Dependencies.**` line, because sequencing against dead work is how a backlog
starts lying.

## 5. What the README carries

The feature README is the discovery page and the durable view. It answers "what
is true right now, and who says so":

1. **Start here** — the reading order, and which authority governs what.
2. **What it does today** — present behavior in plain English, and explicitly
   what it is *not* yet.
3. **Current status and source commit** — the snapshot the claims were verified
   against, and whether that is source evidence or deployment evidence. They are
   not the same thing and must not be conflated.
4. **Source of truth table** — concern, authority, what to use it for.
5. **Implementation map** — area, verified file, present behavior.
6. **Business and state rules** — the rules the code actually enforces today.
7. **Known risks and approved next work** — risk, evidence, the backlog item
   that owns it.
8. **Validation commands** — the focused checks and the full pre-push suite.
9. **Related documents** — including a link back to this framework.

When the README and the implementation disagree, **the code wins**. Inspect the
implementation and correct the document.

## 6. What the HANDOFF carries

Only volatile operational state. If a fact will still be true in three months,
it belongs in an authority, not here:

- the current branch and observed commit;
- the next merge target;
- push, PR, and deployment state;
- the current objective and active task IDs;
- blockers and unresolved evidence;
- the last commands actually run and their results, including the baseline;
- the smallest next action;
- links to the feature README and the relevant ADR, backlog, and audit; and
- **a dated index of the session logs in `handoffs/`, newest first**, so a
  reader reaches the current state first and the history second.

Never copy architecture rationale, scope, file maps, data or security models,
task definitions, or decision logs into a HANDOFF. Those belong to their owning
documents, and duplicating them guarantees one copy goes stale.

`HANDOFF.md` is overwritten in place by each session; it is a snapshot, not a
log. The log lives in `handoffs/`.

### Name the branch. Never just say "production"

The most common way a handoff fails is vagueness about where the work is going.
"Ready for production" is not actionable. State explicitly and by name:

- **the branch the work lives on** (`feature/missions-v2`, not "a feature branch");
- **the branch it merges into next**, per [CONTRIBUTING.md](../../CONTRIBUTING.md);
- **the AWS environment that branch reaches, if any**, per the branch-to-environment
  mapping in [`development.md`](../../development.md#branch-to-environment-mapping);
- **whether anything has actually been deployed**, and by which command;
- **whether the work has been pushed at all.** Committed locally and pushed are
  different states, and omitting this strands the next person.

### Two rules that separate a useful handoff from a misleading one

- **Record a baseline before changing anything.** Run the suite on the untouched
  branch first and write down what already fails. Without it, nobody can tell a
  pre-existing failure from a regression you introduced.
- **Never record a command as passing unless it actually ran.** A skipped
  environment is not a passing result. Note what you did not run, and why.

## 6a. Session handoffs, one per session

**Every working session writes its own handoff file into the feature folder it
worked in**, at `docs/features/<slug>/handoffs/YYYY-MM-DD-<session-slug>.md`,
copied from the [session handoff template](HANDOFF-TEMPLATE.md).

A "session" is one continuous stretch of work by one person or one agent. If you
picked the work up, changed something, and put it down, that is a session and it
owes a file.

Why a file per session rather than one rolling document:

- A single overwritten handoff loses the record of what was already attempted.
  Rediscovering a dead end is the most expensive kind of wasted work.
- Sessions increasingly interleave people and agents. Each needs to state what
  *it* observed, on what commit, without silently overwriting somebody else's
  observation.
- It makes the honesty rules checkable after the fact. A dated file that claims
  a command passed can be compared against the commit it names.

### The carried-forward ledger

Section 5 of the template — **mistakes, assumptions and precautions** — is
carried forward from the previous session's handoff **verbatim**, then appended
to. It is never trimmed and never summarised. An entry that has been fixed is
marked `RESOLVED (<commit>)` and stays in place.

This is a deliberate exception to the no-duplication rule in section 6, and it
is the only one. Everywhere else duplication is banned because a second copy
goes stale. Here the copy *is* the artifact: a session that inherits an empty
ledger repeats the previous session's mistakes, which is the exact failure this
framework exists to stop. The cost is real — a stale entry can mislead — and it
is paid down by the `RESOLVED` marking rather than by deletion.

The seed ledger, current as of 2026-08-12, ships in the
[template](HANDOFF-TEMPLATE.md). A new feature folder starts from that seed; an
existing one starts from its own newest session log.

### What a session handoff may carry that `HANDOFF.md` may not

A session log is history, so it may hold architecture notes, file maps, and
decision rationale that the canonical `HANDOFF.md` is forbidden to carry. That
licence comes with an obligation, recorded in section 4.4 of the template:
anything learned that will still be true in three months must **also** be
promoted into the feature `README.md`, an ADR, or
[`development.md`](../../development.md). A durable fact left only in a dated
session log is a fact that has been lost.

### Closing a session

1. Write the session file, including the real results in section 7.
2. Carry section 5 forward and append.
3. Promote durable facts and record that you did.
4. Update the feature's canonical `HANDOFF.md` — current state, and its session
   index pointing at your new file.
5. Run both gates in [section 7](#7-validation).

## 7. Validation

Docs CI runs these on every push and PR to `development`, `qa`, `staging`, and
`production`:

```powershell
node scripts/ci/feature-knowledge.mjs
node scripts/ci/docs-links.mjs
```

The first enforces this specification. The second proves every relative link
resolves. Run both before pushing. The unit tests for the contract itself:

```powershell
npx vitest run scripts/ci/feature-knowledge.test.ts scripts/ci/docs-links.test.ts
```

Note the current limit of the machine check: it validates the two canonical
files, the declared authorities, the root pointer, and the entry points. It does
**not** yet inspect `handoffs/`, so the session-handoff rules in
[section 6a](#6a-session-handoffs-one-per-session) — the file naming, the
carried-forward ledger, the honesty of section 7 — are enforced by review. Do
not read a green `feature-knowledge: OK` as confirmation that a session handoff
is complete.

## 8. Templates

Copy these into a new `docs/features/<slug>/`, replace every placeholder, and
delete any relationship key you genuinely do not have yet. The per-session
template is a separate file, because it is copied far more often than these two:
**[`HANDOFF-TEMPLATE.md`](HANDOFF-TEMPLATE.md)**.

### `README.md`

````markdown
---
feature: <slug>
document_role: index
status: current
observed_at: YYYY-MM-DD
as_of_commit: <full 40-character SHA>
implemented_by:
  - src/path/to/implementation.ts
tested_by:
  - src/path/to/implementation.test.ts
decisions:
  - docs/adr/NNNN-decision.md
approved_work:
  - docs/<slug>-backlog.md
evidence:
  - docs/<slug>-audit.md
---

# <Feature name>

## 1. Start Here

What snapshot this describes, the reading order, and which authority governs
what. Source code is the ultimate truth for present behavior.

## 2. What <feature> does today

Present behavior in plain English, then explicitly what it is not yet.

## 3. Current status and current source commit

The verified snapshot, and whether it is source evidence or deployment
evidence.

## 4. Source of truth

| Concern | Authority | Use it for |
|---|---|---|
| Implementation | [code](../../../src/path/to/implementation.ts) | Present runtime behavior |
| Durable decisions | [ADR NNNN](../../adr/NNNN-decision.md) | Accepted architecture |
| Approved work | [backlog](../../<slug>-backlog.md) | Executable follow-up |
| Evidence and history | [audit](../../<slug>-audit.md) | Dated findings |
| Volatile state | [HANDOFF](HANDOFF.md) | Branch, command, and next-action state |

## 5. Implementation map

| Area | Verified location | Present behavior |
|---|---|---|

## 6. Current business/state rules

## 7. Known runtime risks and approved next work

| Risk | Evidence | Approved next work |
|---|---|---|

## 8. Exact focused and full validation commands

## 9. Related documents

- [Operational HANDOFF](HANDOFF.md)
- [Feature knowledge framework](../README.md)
- [Documentation index](../../README.md)
- [Repository development guidance](../../../development.md)
````

### `HANDOFF.md`

````markdown
---
feature: <slug>
document_role: handoff
status: current
observed_at: YYYY-MM-DD
as_of_commit: <full 40-character SHA>
---

# <Feature name> handoff

- Branch: `<branch>`; merge target: `<branch>`.
- Pushed: yes/no. PR: `#NN` or none. Deployment: unverified, or the command used.
- Phases/tasks: `<IDs>` complete; active task: `<ID>` or none.
- Blockers: none, or what is unresolved and what evidence is missing.
- Last required checks: `<commands>` and their real results, including the
  baseline recorded before any change.
- Smallest next action: `<one concrete step>`.

Authorities: [README](README.md), [ADR NNNN](../../adr/NNNN-decision.md),
[backlog](../../<slug>-backlog.md), [audit](../../<slug>-audit.md).
````

## 9. Related documents

- [Session handoff template](HANDOFF-TEMPLATE.md), copied once per session
- [Missions README](missions/README.md) and [Missions HANDOFF](missions/HANDOFF.md), the reference implementation
- [Documentation index](../README.md)
- [Repository development guidance](../../development.md)
- [Repository agent guidance](../../AGENTS.md)
- [Contributing and branch promotion](../../CONTRIBUTING.md)
