---
feature: release-pipeline-v1
document_role: handoff
status: current
observed_at: 2026-09-13
as_of_commit: 4b3393e232d7169082b8f50d5920ceba0ea1b92f
---

# Release pipeline v1 — operational handoff

- **Branches** (both merge into `development`):
  - `feature/release-pipeline-v1`, cut from `development` at `271339bc`. It
    holds P1, P2 and P6 (`9892afd`) plus the session handoffs.
  - `feature/release-pipeline-p4-p5`, cut from `origin/development` at
    `271339bc`. It holds P4 and P5's red tests (`4b3393e`) and no
    implementation yet.
- **Where the work happens:** a fresh sibling clone at `C:\dev\_netzer-release`.
  The primary checkout `C:\dev\Netzer-Labs` carries unrelated uncommitted work
  and was deliberately not touched.
- **Pushed:** no. Both branches exist only in that clone. No PR opened.
- **Deployed:** nothing. No tag, release, deploy, secret or repository setting
  has changed. Every consent gate in the parent plan is still closed.
- **`TRUST_ROOTS` is still empty**, so `npm run update` still refuses to run.
  That refusal is correct pre-release behaviour, not a regression.
- **P4 and P5:** specified, not built. Four test seams are red for the intended
  reasons. AC-4 was amended on 2026-09-11 (Q4, recorded in the newest session
  log). The plan, the Codex work order and the Gauntlet resume prompt are
  outside the repo:
  - `C:\Users\EmmanuelAdams\.claude\plans\implement-phases-p4-and-nested-clock.md`
  - `C:\Users\EmmanuelAdams\.claude\plans\release-p4-p5-codex-workorder.md`
  - `C:\Users\EmmanuelAdams\.claude\plans\release-p4-p5-implementation-handoff.md`
- **Blockers:**
  - P5's rollout gate needs `aws login` before `qa → staging`.
  - `release.yml` still needs `RELEASE_SIGNING_KEY` and an image digest.
  - VERIFICATION's integration run needs Docker Desktop, which is stopped.
- **Smallest next action:** paste the IMPLEMENTATION resume prompt into a fresh
  session.

Session index, newest first:

- [2026-09-11 — P4/P5 specification](handoffs/2026-09-11-p4-p5-specification.md)
- [2026-09-10 — P4/P5 planning](handoffs/2026-09-10-p4-p5-planning.md)
- [2026-09-08 — forgery corpus and release CI](handoffs/2026-09-08-forgery-corpus-and-release-ci.md)

Authorities: [README](README.md) for verified behaviour,
[ADR 0011](../../adr/0011-release-artifact-identity.md) for the decisions.
