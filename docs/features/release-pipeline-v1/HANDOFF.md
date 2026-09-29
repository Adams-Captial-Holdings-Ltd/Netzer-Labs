---
feature: release-pipeline-v1
document_role: handoff
status: current
observed_at: 2026-09-17
as_of_commit: 06dc8aa4ca7db6b83c5815e331667866be9bd956
---

# Release pipeline v1 — operational handoff

- **Branches.** Both are cut from `development` at `271339bc`, and both merge back into it:
  - `feature/release-pipeline-v1` holds P1, P2 and P6 (`9892afd`) plus the session handoffs. Before the 2026-09-17 transfer commit, its tip was `06dc8aa`.
  - `feature/release-pipeline-p4-p5` holds P4 and P5, at `4d36c24`:
    - the red tests (`4b3393e`);
    - the drift disarm (`db116ba`);
    - the digest pin (`b27ac38`) and its cleanup (`4d36c24`).
- **Where the work happens.**
  - Until the transfer, the work lived in a fresh sibling clone, `C:\dev\_netzer-release`, on the old Windows PC. The primary checkout, `C:\dev\Netzer-Labs`, was deliberately left untouched.
  - The owner is moving development to a new Windows PC and a Mac. There, resume in a fresh clone of origin with `feature/release-pipeline-p4-p5` checked out. Appendix A of the newest session log has the path map.
- **Pushed:** not yet at the time of writing. Right after the 2026-09-17 transfer commit, the coordinator pushes both branches to origin under the same names.
  - These pushes are owner-approved backups: no PR, no merge, no deploy.
  - Confirm with `git ls-remote origin refs/heads/feature/release-pipeline-v1 refs/heads/feature/release-pipeline-p4-p5`.
- **Deployed:** nothing. No tag, release, deploy, secret or repository setting has changed, and every consent gate in the parent plan is still closed. The ECR lifecycle change below was applied directly with the owner's consent. It is not a deploy.
- **`TRUST_ROOTS` is still empty**, so `npm run update` still refuses to run. That refusal is correct before a release, not a regression.
- **P4 and P5 are built and cleaned up, but not verified.** VERIFICATION hadn't started by 2026-09-17.
  - The focused proof passes apart from the known Windows red.
  - Typecheck exits 0, and the 17 related test files pass.
  - The plan, the work order and the Gauntlet resume prompt live outside the repo, in `~/.claude/plans/`. The devkit (`netzer-devkit`, private) stores each one under `claude/plans/`:
    - `implement-phases-p4-and-nested-clock.md`
    - `release-p4-p5-codex-workorder.md`
    - `release-p4-p5-verification-handoff.md`
- **Blockers:**
  - P5's ECR rollout gate was applied on 2026-09-14, so both orchestrator repos now carry the one-rule policy. A local `npm run deploy` from pre-P5 code puts the untagged rule back, so re-read both policies right before `qa → staging`.
  - The drift disarm only takes effect once it merges into `development`, and pushing the branch doesn't count. Until the merge, the schedule keeps failing daily, and the 2026-10-01 escalation date still applies.
  - `release.yml` still needs `RELEASE_SIGNING_KEY`. Its `images` input takes the orchestrator digest that `deploy.yml` now logs.
  - VERIFICATION's integration run needs Docker for Floci. Nobody has checked Docker on the new machines.
  - The "five known Windows reds" have only been measured on Windows. On a new machine, and especially the Mac, record a fresh baseline before judging AC-10.
  - `feature/bedrock-all-models` also adds an ADR 0011. Whichever branch merges second renumbers its ADR.
- **Smallest next action:** on a new machine, in a fresh clone with `feature/release-pipeline-p4-p5` checked out, paste the VERIFICATION resume prompt into a fresh session. The newest session log embeds that prompt in Appendix A.

Session index, newest first:

- [2026-09-17 — machine transfer](handoffs/2026-09-17-machine-transfer.md)
- [2026-09-14 — P4/P5 cleanup](handoffs/2026-09-14-p4-p5-cleanup.md)
- [2026-09-14 — P4/P5 implementation](handoffs/2026-09-14-p4-p5-implementation.md)
- [2026-09-11 — P4/P5 specification](handoffs/2026-09-11-p4-p5-specification.md)
- [2026-09-10 — P4/P5 planning](handoffs/2026-09-10-p4-p5-planning.md)
- [2026-09-08 — forgery corpus and release CI](handoffs/2026-09-08-forgery-corpus-and-release-ci.md)

Authorities: [README](README.md) for verified behaviour,
ADR 0011 (`adr/0011-release-artifact-identity.md` on branch `feature/release-pipeline-v1`) for the decisions.
