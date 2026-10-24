---
feature: netzar-studio
document_role: lessons
status: current
observed_at: 2026-10-24
---

# Lessons ledger

One entry per gate failure or post-gate bug. A lesson is closed only when its guard exists. Read before planning each story ([story exit gate](story-exit-gate.md)).

| ID | Story | What went wrong | Gate that should have caught it | Guard added | Closed |
|---|---|---|---|---|---|
| L-001 | planning | A status message claimed a blueprint file existed before it was written; later it turned out an earlier session had written it | G2/G3 evidence rule | Never mark a gate or deliverable PASS without a run or a file path; evidence block required | yes (rule in gate doc) |
| L-002 | NZR-3 (provisional) | Build checkout reuses main checkout's node_modules through a symlink instead of a clean lockfile install | G1 review | NZR-3 delivers the clean-clone builder; until then builds are marked provisional | no |
| L-003 | NZR-43 | Runner reported every gate green, but batch PR #217 failed CI twice: docs-links passed locally only because the git-ignored `e2e-run.log` existed in the dirty working tree, and diagrams-drift ran without PR context (path validation only), so the audit-writer change without a request-lifecycle diagram update was missed | G2 | G2 runs CI parity (docs-links, feature-knowledge, runnable-blocks, diagrams-drift with GITHUB_BASE_REF=development, docs-assets, server build, secret scans) in a clean checkout of the committed HEAD; Greptile gate GR on every story; `runner.py pr-feedback` reads the batch PR's checks | yes |
| L-004 | NZR-43 | Reviewer comments (Kody: unvalidated `category` param, masked write-back overwriting secrets, uncapped denial rows, raw bodies logged in the E2E) were never read before PR #215 was offered for merge | G1 | `runner.py pr-feedback` must run before any merge request to the owner; blocking items start a fix round automatically (max 3, then owner) | yes |
