---
feature: paperclip
document_role: decision
status: accepted
observed_at: 2026-08-20
as_of_commit: 17fadd1
---

# Phase 1.5 — the Paperclip image pipeline

**An approved work definition, not a session log.** It exists because the
implementation plan has no phase for the thing Phase 2 depends on most.

## 1. Why this phase exists

The [implementation plan](implementation-plan.md) goes Phase 1 (substrate) →
Phase 2 (service online). Phase 2's build sheet assumes an image is already
sitting in ECR: its step 8 reads "built, **or retagged from the pinned upstream
tag**". [ADR 0010](../../adr/0010-paperclip-work-engine.md)'s amendment killed
the retag option — the artifact must be built through
`vendor/paperclip/Dockerfile`, or the `updatedSince` patch is absent and DL-3's
durable poll silently breaks.

So the plan contains a step that **nothing in this repository performs**.

Phase 2's definition of done is `GET /api/health` returning 200 through the
ALB. That needs a container actually running. Without this phase, every line of
Phase 2 would be written blind and verified only much later — which is how the
two preceding sessions lost their time.

Numbered 1.5 because it is a prerequisite discovered after Phase 1 shipped, not
a renumbering of the plan. **A10** still holds: the plan is historical and this
document outranks it where they disagree.

## 2. Goal

One path, needing no local Docker and no hand-run commands, that:

1. builds `vendor/paperclip/Dockerfile` for **linux/arm64**,
2. pushes it to `claudeclaw[-suffix]-paperclip` in the **operator's own**
   account,
3. records its digest in the deploy manifest,
4. creates nothing at all when `CCE_PAPERCLIP_ENABLED` is unset.

**Done when:** an armed deploy leaves a digest-addressable arm64 Paperclip image
in the operator's ECR, and a teardown removes every resource that path created.

## 3. What already exists — do not rebuild it

| Thing | State | Where |
|---|---|---|
| The Dockerfile | **Works.** `docker-compose.paperclip.yml:16` builds it today for the integration harness, so the recipe is exercised, not theoretical. | `vendor/paperclip/Dockerfile` |
| ARM64 support | **Confirmed.** The pinned base digest is an OCI image *index* carrying `linux/arm64` (`sha256:6ab3c816…`). No experiment owed. | **A22** |
| The ECR repository | **Created, gated**, on *both* deploy drivers as of [#82](https://github.com/Adams-Captial-Holdings-Ltd/Netzer-Labs/pull/82). Proven in CI: the step ran during the 2026-08-20 staging deploy and correctly created nothing with the flag off. | `scripts/deploy.ts` phase a, `.github/workflows/deploy.yml` |
| The whole Docker-free build path | **Exists for the orchestrator**: git-archive the source to the operator's state bucket, one-shot CodeBuild project on a **native ARM64** container, push to their ECR, resolve the digest. Its buildspec already self-verifies `test "$ARCH" = "arm64"`. | `scripts/lib/lifecycle/cloud-build.ts` |

**The approach is to parameterise `cloud-build.ts`, not to write a second
module.** It was built precisely because local Docker was "the heaviest
prerequisite in the whole install"; a Paperclip-specific copy would reintroduce
that and double the teardown surface.

Minimum shape: `runCloudBuild` already takes `ecrRepoName`. It needs a
Dockerfile/context parameter too, defaulting to today's behaviour so the
orchestrator path is untouched.

## 4. Hard requirements

Each of these is a trap this repository has already paid for once.

1. **Teardown must delete the second CodeBuild project.**
   `scripts/teardown.ts:787` calls `cloudBuildNames(names.ecrRepo)` — the
   *orchestrator* repo only. A Paperclip build creates
   `claudeclaw[-suffix]-paperclip-cloud-build`, its IAM role, its role policy
   and its log group, and **none of them would be deleted**. This is the same
   class of defect as **M23** (ungated ECR repo) and **M24** (catalog reports,
   it does not delete). Fix teardown in the same change, not later.

2. **Both deploy drivers, or neither.** CI does **not** run
   `scripts/deploy.ts`; it runs `npx cdk deploy --all` and mirrors the phased
   driver with its own steps. A build wired into one is absent from the other
   (**M27**). Grep `.github/workflows/deploy.yml` for anything added to
   `deploy.ts`.

3. **Gate on `CCE_PAPERCLIP_ENABLED`.** An unarmed deploy must not start a
   CodeBuild run, create a project, or push an image. Match the gate already on
   the repo create.

4. **Record the digest in the manifest.** `buildImageRecords`
   (`scripts/lib/lifecycle/deploy-phases.ts:504`) emits `ContainerImageRecord[]`
   for the orchestrator and the consolidation worker. The Paperclip image must
   join it with `platform: 'linux/arm64'`, or a rollback cannot resolve the
   digest it is rolling back to.

5. **Pin by digest, never a floating tag.** The same rule the X-Ray and
   `cloudflared` sidecars follow: an archived template must stay reproducible.

6. **Keep the arm64 self-check.** The buildspec's
   `test "$ARCH" = "arm64"` moves the architecture gate *inside* the build, so
   a wrong-architecture image can never be pushed at all. Do not drop it for
   the Paperclip build — the base image is multi-arch, so a builder on the
   wrong platform would silently produce amd64.

7. **Catalogue it.** Add the CodeBuild project to
   `docs/out-of-band-catalog.json` beside `paperclip-ecr-repo`. Remember the
   catalog **reports**; requirement 1 is what actually deletes.

## 5. Verification

- `npm run typecheck`, full `npm test` (**P4** — never a scoped run), compared
  to a baseline taken before any edit (**P1**) by failing file **name**
  (**A9**).
- `npx cdk ls` unchanged: 15 stacks flag-off, 17 flag-on.
- Unarmed deploy: **no** CodeBuild project, **no** image, **no** repo. This is
  the assertion that catches a broken gate; today's staging deploy is the
  worked example of proving a gate by its absence.
- Armed deploy in **staging**: an arm64 image lands in
  `claudeclaw-staging-paperclip`, and
  `aws ecr describe-images` reports a digest that
  `docker manifest inspect` confirms as `linux/arm64`.
- Teardown dry-run lists the Paperclip CodeBuild project, its role and its log
  group as things it will delete.

## 6. Out of scope

- The Paperclip **service**, task definition, target group and listener rule —
  those are Phase 2, whose build sheet is §6.5 of
  [the Phase 2 readiness log](handoffs/2026-08-20-phase-2-readiness.md).
- Populating `/claudeclaw[-suffix]/paperclip`. CI populates **no** secrets at
  all (**A26**), which is a separate architectural gap.
- Re-pinning the upstream Paperclip release. **A7** must be re-verified on any
  re-pin, and the patch re-evaluated per ADR 0010's amendment.

## 7. What this unblocks

With this phase done and the Phase 1 substrate deployed, every Phase 2
precondition is met and Phase 2 becomes verifiable the day it is written rather
than the week after.

## 8. Related documents

- [Feature README](README.md) and [HANDOFF](HANDOFF.md)
- [Phase 2 readiness session log](handoffs/2026-08-20-phase-2-readiness.md) —
  §6.5 carries the Phase 2 build sheet
- [ADR 0010](../../adr/0010-paperclip-work-engine.md) and its amendment
- [Implementation plan](implementation-plan.md) and its [audit](plan-audit.md)
