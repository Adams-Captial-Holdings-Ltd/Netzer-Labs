---
feature: paperclip
document_role: handoff
status: current
observed_at: 2026-08-19
as_of_commit: 04c9f90
---

# Paperclip integration handoff

- **Branch: `fix/oidc-immutable-subject-claims`**, cut from `development` at
  `bfe8707`; merge target `development`, per
  [CONTRIBUTING.md](../../../CONTRIBUTING.md). The Paperclip feature work itself
  merged at `bfe8707`
  ([PR #72](https://github.com/Adams-Captial-Holdings-Ltd/Netzer-Labs/pull/72),
  2026-08-19) from the now-deleted `codex/paperclip-integration`.
- Deployment: **nothing deployed to any AWS environment**, and `development`
  reaches none — see the
  [branch-to-environment mapping](../../../development.md#branch-to-environment-mapping).
  The code did reach `staging` earlier on 2026-08-19 (PRs #73, #76), but the
  staging deploy **failed at the OIDC step and no infrastructure changed**.
  No user-visible route has changed.
- The 2026-08-18 **GitHub Actions billing blocker is cleared**: the repository
  was transferred to the `Adams-Captial-Holdings-Ltd` org, whose Team plan has
  working billing, and PR #72 subsequently merged. The `CDK_DIFF_ROLE_ARN` repo
  secret did **not** survive the transfer — non-gating, it only feeds the
  scheduled drift workflow, but it is still missing.
- Phases: §33 first milestone 1A–1D complete; Phase 0 complete (`227feca`);
  Phase 1 **code** complete (`44aad84` — CCE-Database, CCE-Filesystem,
  PaperclipSg, paperclip secret, second ECR ensure, cost floor, 9 CDK assertion
  tests). Active task: **Phase 1 steps 6–8**.
- **The staging deploy blocker is cleared (2026-08-19).** The org mints
  immutable OIDC subjects (`repo:<owner>@318461635/<repo>@1324639154:...`) and
  the trust policy could never match the classic form the CDK generated. Fixed
  on `fix/oidc-immutable-subject-claims`; `CCE_GITHUB_IMMUTABLE_SUBJECT=1` is
  set and the live trust policy now matches the generator exactly. See the
  [2026-08-19 OIDC session log](handoffs/2026-08-19-org-transfer-oidc-and-staging-deploy.md).
- **Blockers.** Two, both awaiting a decision rather than work:
  1. Phase 1 steps 6–8 (real-account `cdk diff` + deploy, the ARM64 buildx
     answer, image push to ECR) need an **explicit user deploy go-ahead** —
     they create billable AWS resources. Note Aurora/EFS are **not tier-gated**,
     so a Tier 0 staging deploy provisions a retained, deletion-protected
     cluster.
  2. **Before Phase 4**, the plan's dual-write and `PAPERCLIP_ENABLED`
     contradictions need an author decision. §30's rollout and §25/§27's cutover
     were written to different premises and cannot both be executed. See
     [plan-audit.md](plan-audit.md) P1-C6 and P1-C7.
- Last required checks (2026-08-18, prior session, at `a7ab7a3`+): full
  `npm test` 185 files / 2108 tests passed with only the recorded pre-existing
  Windows baseline failures (4 `scripts/ci` parser suites, buildspec `sh`
  missing, rollback path separator; baseline at `4bdbf08`: 181 files / 2019
  passed, 7 files / 20 failed). `npm run typecheck`, `npm run build`,
  `npm run synth`, web typecheck and build all clean. Paperclip live gate:
  I3 + FI-4 green ×3. `cdk diff` **not run** — it needs AWS credentials that
  session deliberately never used. Docs gates for the 2026-08-19 documentation
  session: see that session log §7.
- **Smallest next action:** merge `fix/oidc-immutable-subject-claims` up the
  ladder (`development` → `qa` → `staging`; the `qa → staging` merge is the
  release action and deploys on push). Before that merge, run `cdk diff` on
  the foundation stacks against the real account and read every line before
  deploying — this is the phase where an unintended orchestrator change would
  hide. Then answer ARM64 with one
  `docker buildx build --platform linux/arm64` of the Paperclip checkout, record
  the result here, push the patched image to the new ECR repo, and proceed to
  Phase 2.

## Session log index

Newest first. Every session that works in this folder adds one file to
`handoffs/`, copied from the
[session handoff template](../HANDOFF-TEMPLATE.md), and links it here.

| Session | Date | Summary |
|---|---|---|
| [Org transfer, OIDC and the staging deploy](handoffs/2026-08-19-org-transfer-oidc-and-staging-deploy.md) | 2026-08-19 | Diagnosed the red staging deploy to the immutable OIDC subject claim, fixed the trust generator and workflow, verified the live IAM policy matches |
| [Documentation consolidation](handoffs/2026-08-19-docs-consolidation.md) | 2026-08-19 | Vendored the implementation plan and its audit into the repo, tracked the Codex session log, rewrote this README/HANDOFF from all three handoffs |
| [updated-since patch + Phase 0/1](handoffs/2026-08-18-updated-since-patch-and-phase-0.md) | 2026-08-18 | Finished Milestone 1D, resolved the I3 blocker via the user-approved artifact patch, wrote ADR 0010 and this feature folder, landed Phase 1 infra code |
| [Codex deep dive and first-milestone pause](handoffs/2026-08-18-codex-review.md) | 2026-08-18 | The origin session: produced the implementation plan, built Milestones 1A–1C, and proved the pinned release has no `updatedSince` — the I3 architecture blocker |

Authorities: [README](README.md),
[ADR 0010](../../adr/0010-paperclip-work-engine.md),
[ADR 0009](../../adr/0009-mission-container-model.md),
[implementation plan](implementation-plan.md),
[plan audit](plan-audit.md).
