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
