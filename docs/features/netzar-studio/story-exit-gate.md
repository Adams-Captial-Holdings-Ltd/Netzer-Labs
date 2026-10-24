---
feature: netzar-studio
document_role: process
status: accepted
observed_at: 2026-10-24
---

# Story exit gate

Owner rule (2026-10-24): no user story moves forward until **code review, unit tests, UAT and E2E** all pass on the exact committed HEAD, each with recorded evidence. Applies to every rigor tier (T1, T2, T3); it overrides the Q68 tier policy wherever that policy would skip a gate (tiers still decide how deep the code review goes). Source of truth for the process: the gauntlet-loop skill, `references/story-exit-gate.md`.

| Gate | Pass means | Evidence |
|---|---|---|
| 1. Code review | Fresh critic (no build transcript) reviewed the diff against the story's criteria and repo rules; plus a Greptile CLI review (`greptile review --json`, `--plus` for T3, auth, handlers, infra) on every story: any P0/P1 comment, security issue or confidence <= 2 fails the gate; every finding fixed or owner-waived with a reason; before the owner is asked to merge the batch PR, its CI checks and reviewer-bot comments (Kody, Greptile, CodeRabbit) are read and blocking items fixed | reviewer, HEAD sha, findings and disposition, Greptile confidence and comment count |
| 2. Unit tests | Frozen failing tests committed first (red sha), now green; touched modules unit-tested; full suite and typecheck green on a clean checkout of the exact HEAD; the PR-time docs/CI scripts (docs-links, diagrams-drift in PR mode, secret-scan, asset budget) pass on that clean checkout | red sha, green sha, real counts |
| 3. UAT | Each Given/When/Then scenario walked as the persona, marked PASS/FAIL; UI: owner accepts a short demo; non-UI: owner accepts an evidence summary; owner task: owner confirms the artifact | scenario table, who accepted, date |
| 4. E2E | Run through the real entry point (HTTP route, browser UI or CLI), not mocks of the unit under test; happy path plus the main failure path; docs/owner tasks record `N/A: reason` | script or test file, run output, screenshot or log path |

Order: unit tests, code review, E2E, UAT. A failed gate returns the story to implementation in a fresh session; fixes re-run the failed gate and every gate after it.

Rules:
- The builder never signs off a gate.
- `PENDING` only for a gate that needs an environment that does not exist yet (staging before the AWS account). The story is then "Done locally", with the pending gate listed in the HANDOFF.
- A gate is never marked PASS from a planned action or an unrun command.
- A story with a gate that is not PASS or PENDING cannot be the base for the next story. Plane state Done requires the evidence block.

Evidence block (in the story's session log and PR description):

```
Story: NZR-<n>   HEAD: <sha>
G1 code review : PASS|FAIL|WAIVED  reviewer=<who> findings=<fixed>/<total>
GR greptile    : PASS|FAIL|ERROR confidence=<1-5> comments=<n>
G2 unit tests  : PASS|FAIL        red=<sha> green=<sha> counts=<pass>/<total> typecheck=<ok>
G3 UAT         : PASS|FAIL|PENDING scenarios=<n>/<n> accepted_by=<who> date=<d>
G4 E2E         : PASS|FAIL|N/A|PENDING run=<path>
Lessons checked: <ids or none>   New lessons: <ids or none>
```

Lessons ledger: [LESSONS.md](LESSONS.md). Every gate failure, and every bug found after a gate passed, gets one entry (what went wrong, which gate should have caught it, the guard added, story id). A lesson without a guard is not closed. Read it before planning each story.

Time cost: E2E and UAT add roughly 1 to 3 points per story. They are counted inside the story points from now on (re-check at the Nov 9 re-plan, Q71).
