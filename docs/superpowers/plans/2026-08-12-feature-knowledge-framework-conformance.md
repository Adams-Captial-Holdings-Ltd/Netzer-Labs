# Feature Knowledge Framework Conformance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the five scattered copies of the feature-documentation rules into one machine-enforced specification at `docs/features/README.md`, and reduce the repo to four branches.

**Architecture:** One spec document that every other page links to instead of restating. The validator stops hardcoding `missions` and instead discovers `docs/features/<slug>/` folders, then follows each README's own frontmatter (`approved_work:`, `evidence:`) to find and check its authorities. Entry-point link checks compute relative paths rather than matching literals.

**Tech Stack:** Node 20 (dependency-free `.mjs` CI scripts), Vitest, GitHub Actions, Git.

## Context

Codex built the feature-knowledge system merged as PR #12. The system is sound; its
placement sprawled. **The rules for documenting feature work are written in five places
and none of them is the specification:**

| Where the rules live now | What it holds |
|---|---|
| `development.md` §906-996 | Handoff rules, required sections, branch→env mapping |
| `docs/README.md` §9-30 | Folder convention + status vocabulary, restated |
| `scripts/ci/feature-knowledge.mjs` | The machine contract, **hardcoded to `missions`** |
| `AGENTS.md` §10-19 | Entry-point prose, restated again |
| `docs/features/missions/README.md` | The only exemplar |

Two consequences: there is no `docs/features/README.md`, so a second feature has an
example to copy but no spec to conform to; and the validator's fixed file list, canonical
paths, `MISSION-\d+` regex, and audit checks are all literals, so a second feature folder
would be enforced by nothing.

Separately, the branch list overgrew to 7 remote + 6 local branches, one holding 2,123
lines of never-pushed work.

**Outcome:** one canonical spec, a validator that enforces it for any feature, and a
four-branch repo.

## Global Constraints

- CI scripts under `scripts/ci/` are **dependency-free** `.mjs` — bare Node, no `npm ci`.
- `docs/` house style: every page opens with a plain-English blockquote summary; all
  internal links relative.
- `scripts/ci/docs-links.mjs` resolves every relative link in `docs/**`, `README.md`,
  `AGENTS.md`, `development.md`, `handoff.md`. It strips fenced code blocks, so template
  placeholders must live inside fences.
- `development.md` must keep the literal string `docs/features/<slug>/HANDOFF.md` and must
  never match `/(update|write|keep|maintain)[^\n]{0,80}(root|global)\s+(`?handoff\.md`?|operational handoff)/i`.
- Feature docs carry `observed_at` / `as_of_commit`. **Do not bump them on a document you
  did not re-verify** — that fabricates evidence.
- Task IDs are permanent; a rejected or superseded ID is never reused.

## Blocking environment limitation

**This machine has no Node runtime** — `node`, `npm`, and `npx` are all absent
(`Get-Command node` fails; no `nodejs` under Program Files, no nvm/fnm/volta/scoop
install). Every "run the test" step below therefore **cannot execute locally**, and
GitHub Actions Docs CI is the first real execution.

Two ways to proceed; pick one before starting:

- **(a) Install Node 20 first** and run the plan as written with real TDD.
- **(b) Accept CI as the gate:** author carefully, push to `development`, read the Docs CI
  run, fix forward. Branch deletion (Task 6) happens only after CI is green.

Under (b), never record a step as passing. A skipped check is not a passing result.

---

## File Structure

**Create**
- `docs/features/README.md` — the specification. Sole owner of the format.

**Modify**
- `scripts/ci/feature-knowledge.mjs` — generalize from missions to any slug.
- `scripts/ci/feature-knowledge.test.ts` — two-feature fixture proving genericity.
- `development.md`, `docs/README.md`, `AGENTS.md`, `CONTRIBUTING.md` — delete restated
  rules, link the spec.
- `docs/features/missions/{README,HANDOFF}.md` — link the spec; correct stale branch facts.
- `.github/workflows/{ci,docs-ci}.yml` — drop `main` from triggers.

---

### Task 1: Preserve the unpushed WARP work

Branch analysis, already verified. Recovery SHAs recorded before any deletion:

```
origin/chore/netzar-os-repository-architecture 5485fdd   0 ahead of development
origin/docs/shared-qa-deployment               3ee0ee0   0 ahead of development
origin/feature/missions-v2                     b69c6f2   0 ahead of development
local  main                                    355c397   0 unique (no origin/main exists)
local  hotfix/power-switch-concurrency         1400208   0 unique
local  feature/missions-knowledge-system       44c870d   0 unique (merged via PR #12)
local  docs/shared-qa-deployment               bd6abaf   2 unique  <-- subset of warp
local  feat/warp-private-dashboard             a0e9329   5 unique  <-- REAL WORK
```

All three remote branches are fully merged; deleting them loses nothing. `origin/production`
is 3 commits "ahead" but they are merge commits only — a content diff confirms production
has no file content development lacks. `feat/warp-private-dashboard` is the one that
matters: 5 unpushed commits, 2,123 insertions (WARP private-access CDK construct + tests,
`scripts/warp-setup.ts`, lifecycle manifest wiring, 3 design docs), and its history contains
the 2 unique commits from local `docs/shared-qa-deployment`.

**Files:** no source edits; history only.

- [ ] **Step 1: Fast-forward local `development` to the remote**

```bash
git fetch origin --prune
git branch -f development origin/development
```

- [ ] **Step 2: Merge the WARP work, preserving both branches' commits**

```bash
git checkout development
git merge --no-ff feat/warp-private-dashboard -m "chore(branches): consolidate WARP private dashboard work into development"
```

Expected: clean merge, 12 files, 2,123 insertions, no conflicts.

- [ ] **Step 3: Confirm nothing else is unique**

```bash
for b in main hotfix/power-switch-concurrency docs/shared-qa-deployment feature/missions-knowledge-system chore/netzar-os-repository-architecture; do echo "$b: $(git rev-list --count development..$b)"; done
```

Expected: every branch reports `0`.

---

### Task 2: Write the specification

**Files:**
- Create: `docs/features/README.md`

**Interfaces:**
- Produces: the canonical anchor set later tasks link to, and the literal path
  `docs/features/README.md` that Task 4's validator checks for.

- [ ] **Step 1: Write the spec**

Sections, in order: opening blockquote summary; §1 when a feature folder applies (the
"continue without the chat log" test); §2 the folder shape (README + HANDOFF only, add a
third only on demonstrated need, root `handoff.md` is compatibility-only); §3 the
frontmatter contract (`feature`, `document_role`, `status`, `observed_at`, `as_of_commit`,
plus the five relationship list keys); §4 the vocabularies; §5 what the README carries
(nine numbered sections, "the code wins"); §6 what the HANDOFF carries (volatile only,
"name the branch", the baseline rule and the never-claim-an-unrun-command rule); §7
validation commands; §8 copy-paste templates for both files; §9 related documents.

Templates go inside four-backtick fences so `docs-links.mjs` strips them and does not try
to resolve placeholder links like `docs/<slug>-backlog.md`.

- [ ] **Step 2: Verify every real link resolves**

From `docs/features/`: `../README.md` → `docs/README.md`; `../../development.md`,
`../../AGENTS.md`, `../../CONTRIBUTING.md`, `../../handoff.md` → repo root;
`missions/README.md`, `missions/HANDOFF.md` → the exemplar. The anchor
`../../development.md#branch-to-environment-mapping` requires Task 5 to keep that heading.

Run: `node scripts/ci/docs-links.mjs`
Expected: `docs-links: OK`

- [ ] **Step 3: Commit**

```bash
git add docs/features/README.md
git commit -m "docs(features): add the feature knowledge framework specification"
```

---

### Task 3: Generalize the validator — tests first

**Files:**
- Modify: `scripts/ci/feature-knowledge.test.ts`

**Interfaces:**
- Consumes: `validateFeatureKnowledge({files, trackedFiles, existingFiles})` from
  `feature-knowledge.mjs` — signature unchanged, so `docs-ci.yml` needs no edit.
- Produces: two new expectations on that module — an exported
  `relativeLink(fromFile, toFile): string`, and an exported `snapshotRepository(rootDir)`
  that loads all tracked `.md` rather than a fixed 8-file list.

- [ ] **Step 1: Write the failing tests**

Replace the single-feature fixture with two features: `missions` (exercises every
relationship key) and `warp-private-access` (the minimum conforming folder — two files, no
declared authorities). New cases beyond the existing suite:

```ts
it.each([
  ['AGENTS.md', 'docs/features/README.md', 'docs/features/README.md'],
  ['docs/README.md', 'docs/features/README.md', 'features/README.md'],
  ['docs/features/missions/README.md', 'docs/features/README.md', '../README.md'],
  ['docs/missions-v2-audit.md', 'docs/features/missions/README.md', 'features/missions/README.md'],
])('resolves %s -> %s as %s', (from, to, expected) => {
  expect(relativeLink(from, to)).toBe(expected);
});
```

Plus: framework spec must exist; at least one feature folder must exist; *both* features'
canonical files are required (not just the first); `feature:` must equal the folder name;
slug must be kebab-case; every feature README must link `../README.md`; `approved_work`
and `evidence` targets must be Markdown; the root `handoff.md` may point at any feature;
and a non-`MISSION` prefix is honoured:

```ts
it('reads task IDs from any feature prefix, not only MISSION', () => {
  expect(failuresFor(({ files, trackedFiles, existingFiles }) => {
    files['docs/features/warp-private-access/README.md'] = `${frontmatter('warp-private-access', 'index', 'current', 'approved_work:\n  - docs/warp-backlog.md\n')}\n# WARP\n\nSee the [framework](../README.md).\n`;
    files['docs/warp-backlog.md'] = '# WARP backlog\n## WARP-001\n```yaml\nwork_state: nonsense\n```\n';
    trackedFiles.add('docs/warp-backlog.md');
    existingFiles.add('docs/warp-backlog.md');
  }).join('\n')).toMatch(/WARP-001: invalid work_state nonsense/);
});
```

Close with a real-repo assertion using the new helper:

```ts
it('accepts the current repository', () => {
  expect(validateFeatureKnowledge(snapshotRepository(resolve(import.meta.dirname, '../..')))).toEqual([]);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run scripts/ci/feature-knowledge.test.ts`
Expected: FAIL — `relativeLink is not a function`, and the two-feature fixture reports
missing-canonical errors for `warp-private-access` under the old missions-only logic.

*(Under option (b): cannot run. Do not tick this box; note it in the HANDOFF.)*

- [ ] **Step 3: Commit the failing tests**

```bash
git add scripts/ci/feature-knowledge.test.ts
git commit -m "test(docs): require the feature contract to be feature-agnostic"
```

---

### Task 4: Generalize the validator — implementation

**Files:**
- Modify: `scripts/ci/feature-knowledge.mjs`

**Interfaces:**
- Produces: `relativeLink(fromFile, toFile)`, `parseFrontmatter(text)`, `taskRecords(markdown)`,
  `validateFeatureKnowledge(snapshot)`, `snapshotRepository(rootDir)`.

- [ ] **Step 1: Replace the literals with discovery**

Delete `FIXED_FILES`. Add:

```js
const FRAMEWORK = 'docs/features/README.md';
const FEATURE_FILE = /^docs\/features\/([^/]+)\/(.+)$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TASK_ID = /[A-Z][A-Z0-9]*-\d+/;
```

`FEATURE_FILE` deliberately requires a slash after the slug, so `docs/features/README.md`
is not mistaken for a feature folder. Discover slugs from both `Object.keys(files)` and
`trackedFiles`, so a folder missing its README still fails.

- [ ] **Step 2: Add the relative-link helper**

```js
export function relativeLink(fromFile, toFile) {
  const from = fromFile.split('/').slice(0, -1);
  const to = toFile.split('/');
  let shared = 0;
  while (shared < from.length && shared < to.length - 1 && from[shared] === to[shared]) shared += 1;
  return [...from.slice(shared).map(() => '..'), ...to.slice(shared)].join('/');
}
```

Wrap it in `linksTo(text, fromFile, toFile)`, which accepts both `target` and `./target`
and requires the match be followed by `#`, `)`, whitespace, or `>`.

- [ ] **Step 3: Follow frontmatter instead of hardcoding authorities**

Per feature README: validate each `approved_work:` target with `validateWorkQueue` (task
records, no duplicate IDs, `work_state` XOR the five closed keys, no retired ID in a
`**Dependencies.**` line) and each `evidence:` target with `validateEvidence` (labeled
historical, links back to *its own* feature README via `linksTo`). Generalize
`taskRecords` from `MISSION-\d+` to `TASK_ID`. Require both target kinds to end in `.md`.

Verified against the real backlog: its 30 `##`/`###` headings yield no false positives.

- [ ] **Step 4: Retarget the entry-point and root-handoff checks**

`AGENTS.md`, `docs/README.md`, and `development.md` must each link `FRAMEWORK` via
`linksTo`. `development.md` must still contain the literal `docs/features/<slug>/HANDOFF.md`
and must still fail the global-operational-handoff regex. The root `handoff.md` link may
target any `docs/features/<slug>/HANDOFF.md`, and its `feature:` must name a real folder.

- [ ] **Step 5: Broaden the snapshot**

```js
const files = Object.fromEntries([...existingFiles]
  .filter((path) => path.endsWith('.md'))
  .map((path) => [path, readFileSync(resolve(rootDir, path), 'utf8')]));
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run scripts/ci/feature-knowledge.test.ts`
Expected: PASS, including `accepts the current repository`.

Then: `node scripts/ci/feature-knowledge.mjs`
Expected: `feature-knowledge: OK`

- [ ] **Step 7: Commit**

```bash
git add scripts/ci/feature-knowledge.mjs
git commit -m "test(docs): enforce the feature contract for every feature folder"
```

---

### Task 5: Repoint the four prose copies

**Files:**
- Modify: `development.md:906-996`, `docs/README.md:9-30`, `AGENTS.md:10-19`, `CONTRIBUTING.md:55-78`

- [ ] **Step 1: `development.md`**

Retitle §906 to `## Feature work (\`docs/features/<slug>/HANDOFF.md\`)` — keeping that
literal path, which the validator checks. Cut the restated folder rules, the "Required
sections" list, the durable-vs-volatile paragraph, and the two baseline rules; all now live
in the spec. Keep and clarify the branch→env mapping, which `development.md` legitimately
owns, and **keep the `### Branch to environment mapping` heading** — Task 2 anchors to it.
Replace "five long-lived branches" with "four". Add a `### Long-lived branches` subsection.
In §Maintenance rules, replace the "feature handoff rules" bullet with a note that the
feature documentation rules are not maintained here.

Danger: do not write `(update|write|keep|maintain)` within 80 same-line characters of
`root handoff.md`. Verify with:

```bash
grep -nEi "(update|write|keep|maintain).{0,80}(root|global)[[:space:]]+(\`?handoff\.md\`?|operational handoff)" development.md
```

Expected: no output.

- [ ] **Step 2: `docs/README.md`**

Collapse the restated status/work_state vocabulary into a pointer to
`./features/README.md`, keeping the Missions paragraph as the reference implementation.

- [ ] **Step 3: `AGENTS.md`**

Add a paragraph: read the framework before creating or editing any feature document, and
Docs CI rejects documents that do not conform. Must contain a link to
`docs/features/README.md`.

- [ ] **Step 4: `CONTRIBUTING.md`**

State that `development`, `qa`, `staging`, `production` are the only long-lived branches;
require transient branches be deleted on merge; drop the stale "`main` remains
production-authorized as a recovery path … never deleted" clause (there is no
`origin/main`); add that PRs touching `docs/features/` must conform to the framework.

- [ ] **Step 5: Run both checkers**

Run: `node scripts/ci/docs-links.mjs && node scripts/ci/feature-knowledge.mjs`
Expected: `docs-links: OK` and `feature-knowledge: OK`

- [ ] **Step 6: Commit**

```bash
git add development.md docs/README.md AGENTS.md CONTRIBUTING.md
git commit -m "docs: point every entry point at the feature knowledge framework"
```

---

### Task 6: Bring the Missions docs current, and fix CI triggers

**Files:**
- Modify: `docs/features/missions/README.md`, `docs/features/missions/HANDOFF.md`,
  `.github/workflows/ci.yml:5,7`, `.github/workflows/docs-ci.yml:16,18`

- [ ] **Step 1: Missions README**

Add a "Feature knowledge framework" bullet to §9 pointing at `../README.md` — the
validator now requires it.
Correct §3, which cites `feature/missions-knowledge-system` as if it still exists; it was
merged through PR #12 and deleted, and commit `946ac3f` is now reachable from `development`.

**Leave `observed_at` and `as_of_commit` unchanged.** The Missions implementation was not
re-verified in this change; bumping them would claim verification that did not happen.

- [ ] **Step 2: Missions HANDOFF**

Rewrite. Branch is `development`, merge target `qa`. Set `observed_at: 2026-08-12` and
`as_of_commit` to the Task 1 merge commit — this document *was* re-observed. Record
honestly which checks ran and which did not, per the environment limitation above.

- [ ] **Step 3: Drop `main` from CI triggers**

```bash
sed -i 's/branches: \[development, qa, staging, production, main\]/branches: [development, qa, staging, production]/' .github/workflows/ci.yml .github/workflows/docs-ci.yml
```

- [ ] **Step 4: Verify and commit**

Run: `node scripts/ci/feature-knowledge.mjs && node scripts/ci/docs-links.mjs`
Expected: both OK.

```bash
git add docs/features/missions .github/workflows
git commit -m "docs(missions): reconcile handoff with the merged branch state"
```

---

### Task 7: Push, verify CI, then collapse the branch set

**Do not start until Docs CI is green.** Deleting branches while the tree might still need
a fix removes the fallback.

- [ ] **Step 1: Push**

```bash
git push origin development
```

- [ ] **Step 2: Read the CI result**

```bash
gh run list --branch development --limit 3
```

Expected: Docs CI passes, specifically "Validate feature-knowledge contracts" and the
internal-links step. On failure: `gh run view <id> --log-failed`, fix forward, push again.

- [ ] **Step 3: Free the branches held by worktrees**

The main worktree sits on `hotfix/power-switch-concurrency`, and two linked worktrees hold
`feat/warp-private-dashboard` and `feature/missions-knowledge-system`. A checked-out branch
cannot be deleted.

```bash
git checkout development
git worktree remove .worktrees/shared-qa-deployment
git worktree remove .worktrees/development
```

`.worktrees/development` is owned by a different Windows user (`CodexSandboxOffline`) and
reports "dubious ownership"; it may need `--force` or a `git config --global --add
safe.directory` exception.

- [ ] **Step 4: Delete the merged remote branches**

```bash
git push origin --delete chore/netzar-os-repository-architecture docs/shared-qa-deployment feature/missions-v2
```

- [ ] **Step 5: Delete the local branches**

```bash
git branch -D main hotfix/power-switch-concurrency feature/missions-knowledge-system chore/netzar-os-repository-architecture docs/shared-qa-deployment feat/warp-private-dashboard
```

- [ ] **Step 6: Confirm the final state**

```bash
gh api repos/emmanuelmadams4-lgtm/Netzer-Labs/branches --jq '.[].name'
git branch
```

Expected: exactly `development`, `qa`, `staging`, `production` in both.

---

## Self-Review

**Spec coverage.** Framework doc → Task 2. Generalized validator → Tasks 3-4. `development.md`
references the framework → Task 5 Step 1 (three links). Cleanup of the sprawl → Task 5.
Branch collapse to four → Tasks 1 and 7. All covered.

**Type consistency.** `relativeLink` is defined in Task 4 Step 2 and consumed by Task 3's
tests and by `linksTo` in Steps 3-4. `snapshotRepository` keeps its name and gains a
broader body in Step 5. `validateFeatureKnowledge`'s signature is unchanged, so
`docs-ci.yml` line 46 still works untouched.

**Known risk.** Under option (b) no step is locally verifiable. Every "Expected: PASS" is a
prediction until CI runs, and Task 7 Step 2 is the real gate.

## Out of scope

- `cutover.md` has 12 references to `main` as a recovery branch. It reads as a historical
  cutover runbook; rewriting it is a separate change, but it now sits in mild tension with
  the updated `CONTRIBUTING.md`. Worth a follow-up rather than a silent edit here.
- `docs/missions-v2-audit.md` and `docs/missions-v2-backlog.md` stay at the `docs/` root.
  Moving them into `docs/features/missions/` would make the folder self-contained but
  touches inbound links across the docs tree; you declined that scope.

## Note on existing draft

Tasks 1-6 are already drafted in a scratchpad worktree (`…/scratchpad/dev-wt`) with the
Task 1 merge committed locally as `69791f9`. Nothing has been pushed; `origin/development`
is untouched at `1a86112`. On approval this becomes a review-and-land pass rather than a
from-scratch build. Per your convention the plan itself should also be saved to
`docs/superpowers/plans/2026-08-12-feature-knowledge-framework-conformance.md`.
