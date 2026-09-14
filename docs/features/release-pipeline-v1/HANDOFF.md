---
feature: release-pipeline-v1
document_role: handoff
status: current
observed_at: 2026-09-14
as_of_commit: b27ac382cef20103b0bbbc0ab642cf45cb12c8b0
---

# Release pipeline v1 — operational handoff

- **Branches.** Both merge into `development`:
  - `feature/release-pipeline-v1`, cut from `development` at `271339bc`. It
    holds P1, P2 and P6 (`9892afd`) plus the session handoffs.
  - `feature/release-pipeline-p4-p5`, cut from `origin/development` at
    `271339bc`. It holds P4 and P5: the red tests (`4b3393e`), the drift
    disarm (`db116ba`) and the digest pin (`b27ac38`).
- **Where the work happens:** a fresh sibling clone at `C:\dev\_netzer-release`.
  The primary checkout, `C:\dev\Netzer-Labs`, carries unrelated uncommitted
  work and was deliberately not touched.
- **Pushed:** no. Both branches exist only in that clone, and no PR is open.
- **Deployed:** nothing. No tag, release, deploy, secret or repository setting
  has changed, and every consent gate in the parent plan is still closed.
- **`TRUST_ROOTS` is still empty**, so `npm run update` still refuses to run.
  That refusal is correct pre-release behaviour, not a regression.
- **P4 and P5 are built and committed locally, but not yet cleaned up or
  verified.** The focused proof passes apart from the known Windows red, and
  typecheck exits 0. The plan, the work order and the Gauntlet resume prompt
  live outside the repo:
  - `C:\Users\EmmanuelAdams\.claude\plans\implement-phases-p4-and-nested-clock.md`
  - `C:\Users\EmmanuelAdams\.claude\plans\release-p4-p5-codex-workorder.md`
  - `C:\Users\EmmanuelAdams\.claude\plans\release-p4-p5-cleanup-handoff.md`
- **Blockers:**
  - P5's rollout gate needs `aws login` before `qa → staging`.
  - The drift disarm only takes effect once it merges into `development`.
    Until then the schedule keeps failing daily.
  - `release.yml` still needs `RELEASE_SIGNING_KEY`. Its `images` input takes
    the orchestrator digest that `deploy.yml` now logs.
  - VERIFICATION's integration run needs Docker Desktop, which is stopped.
- **Smallest next action:** paste the CLEANUP resume prompt into a fresh
  session.

Session index, newest first:

- [2026-09-14 — P4/P5 implementation](handoffs/2026-09-14-p4-p5-implementation.md)
- [2026-09-11 — P4/P5 specification](handoffs/2026-09-11-p4-p5-specification.md)
- [2026-09-10 — P4/P5 planning](handoffs/2026-09-10-p4-p5-planning.md)
- [2026-09-08 — forgery corpus and release CI](handoffs/2026-09-08-forgery-corpus-and-release-ci.md)

Authorities: [README](README.md) for verified behaviour,
[ADR 0011](../../adr/0011-release-artifact-identity.md) for the decisions.
