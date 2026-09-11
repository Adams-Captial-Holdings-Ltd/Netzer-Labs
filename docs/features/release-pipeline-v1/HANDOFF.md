---
feature: release-pipeline-v1
document_role: handoff
status: current
observed_at: 2026-09-10
as_of_commit: 271339bc8b2feea85e6c31b115fdd34e757a72e2
---

# Release pipeline v1 — operational handoff

- **Branch:** `feature/release-pipeline-v1`, cut from `development` at
  `271339bc`. It holds P1, P2 and P6 (`9892afd`) plus the session handoffs.
  P4 and P5 go on `feature/release-pipeline-p4-p5`, which is planned and **not
  yet created** (to be cut from `origin/development`). Both merge into
  `development`.
- **Where the work happens:** a fresh sibling clone at `C:\dev\_netzer-release`.
  The primary checkout `C:\dev\Netzer-Labs` carries unrelated uncommitted work
  and was deliberately not touched.
- **Pushed:** no. Both branches exist only in that clone. No PR opened.
- **Deployed:** nothing. No tag, release, deploy, secret or repository setting
  has changed. Every consent gate in the parent plan is still closed.
- **`TRUST_ROOTS` is still empty**, so `npm run update` still refuses to run.
  That refusal is correct pre-release behaviour, not a regression.
- **P4 and P5:** plan approved on 2026-09-10; nothing built yet. The plan and
  the Gauntlet resume prompt are outside the repo:
  `C:\Users\EmmanuelAdams\.claude\plans\implement-phases-p4-and-nested-clock.md`
  and `C:\Users\EmmanuelAdams\.claude\plans\release-p4-p5-handoff.md`.
- **Blockers:**
  - P5's rollout gate needs `aws login` before `qa → staging`.
  - `release.yml` still needs `RELEASE_SIGNING_KEY` and an image digest.
- **Smallest next action:** paste the Gauntlet resume prompt into a fresh
  session. It starts the SPECIFICATION phase.

Session index, newest first:

- [2026-09-10 — P4/P5 planning](handoffs/2026-09-10-p4-p5-planning.md)
- [2026-09-08 — forgery corpus and release CI](handoffs/2026-09-08-forgery-corpus-and-release-ci.md)

Authorities: [README](README.md) for verified behaviour,
[ADR 0011](../../adr/0011-release-artifact-identity.md) for the decisions.
