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
| ARM64 support | **Confirmed.** The pinned base digest `sha256:6b9daa3c…` is an OCI image *index*; its `linux/arm64` child manifest is `sha256:6ab3c816…`. The Dockerfile pins the **index**, which is what lets an ARM64 builder select that child. The two digests differing is correct, not a mismatch. No experiment owed. | **A22** |
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

8. **One build mechanism, not two.** Requirement 2 says the step must exist on
   both drivers; this says it must be the *same build*. The first version of
   this phase satisfied 2 and violated 8: CI cross-built
   `vendor/paperclip/Dockerfile` with QEMU-emulated `docker buildx` on the
   amd64 runner while `scripts/deploy.ts` used native ARM64 CodeBuild. Same
   Dockerfile, two mechanisms, so the arm64 self-check (requirement 6), the
   base-image pull and the build environment all differed between the path
   that gets exercised locally and the path that reaches staging and
   production — and the emulated one ran an `apt-get` plus a full `tsc` over
   the whole Paperclip server at 5-20x, uncached and untimed. CI now runs
   `scripts/ci/paperclip-image.ts`, a thin CLI over the same
   `scripts/lib/lifecycle/cloud-build.ts`, so the content tag, the
   skip-if-present probe, `pushLatest: false` and the arm64 gate each have
   exactly one implementation.

9. **A skip has to be honest.** The content tag is `git rev-parse
   HEAD:vendor/paperclip` — HEAD, never the working tree, because that is
   exactly what `git archive HEAD` ships to CodeBuild. That makes the skip
   correct about the *tag* and silent about the *operator*: edit
   `vendor/paperclip/updated-since.patch` (step 6's own instruction), skip the
   commit, deploy, and the tag still names the old content, that image is
   already in ECR, no build runs, the old digest is recorded as this deploy's
   Paperclip image, and the deploy reports success. The only "tracked,
   committed files only" warning in the module lives in `packageSource`, which
   the skip path never reaches. So both drivers call
   `staleContentTagReason()` before adopting an existing digest and act on a
   non-null answer — a clean `DeployAbort` locally, a `::error::` in CI. It
   **refuses** rather than warning: on the build path an artifact matching its
   tag is still produced, on the skip path nothing is built and the one line
   printed would assert that ECR is current. It is scoped to the build context,
   so an ordinary dirty app tree does not block a Paperclip skip.

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
- The step 9 guard is provable **without AWS**: `staleContentTagReason()` is
  exercised against a throwaway git repo in
  `scripts/lib/lifecycle/paperclip-image-pipeline.test.ts` — clean tree returns
  null, a modified tracked file refuses, an untracked file in the context
  refuses, an edit outside the context does not, and a non-git directory
  returns null. The same suite pins both drivers to that one function rather
  than to a path-scoped `git status` of their own.

### 5.1 Arming order on the CI driver — do this before setting the flag

The CI deploy role `ClaudeClawGitHubDeploy` (`cicdRole`,
`infra/lib/iam-stack.ts`) had **three** ECR statements, all scoped to
`claudeclaw-orchestrator` / `claudeclaw-*-orchestrator`.
`claudeclaw-staging-paperclip` matches neither, so before this change the CI
Paperclip step could not describe, create or push that repo at all. That is
why a **green flag-off CI run is not evidence the CI path works**: with the
flag unset the step never runs, so the run proves the `if` guard and says
nothing about the grant behind it.

The grants now cover both patterns (`EcrPushAppImages`, `EcrCreateAppRepos`).
The ordering constraint is the same shape as the 2026-08-14 connector incident
the workflow documents inline:

1. The grant is applied by the **`CDK deploy` step later in the same job**, so
   it cannot help the ECR steps that run before it. It must land in a prior,
   **unarmed** deploy.
2. `cicdRole` is created only by the **PROD** IAM stack (a staging deploy skips
   it to avoid `EntityAlreadyExists`). So arming Paperclip in **staging**
   requires a **production** IAM deploy to have run first.

Both ECR probes in the workflow now fail loudly on `AccessDenied` instead of
reading it as "not built yet", so getting this order wrong costs seconds
rather than a whole ARM build. `paperclip-image-pipeline.test.ts`
synthesizes the IAM stack and matches the emitted ARN patterns and
`ecr:RepositoryName` conditions against the repo names `buildResourceNames`
really produces.

The same ordering applies to the **CodeBuild** grants requirement 8 needs, and
they are new in this change:

| Sid | What the CI step does with it |
| --- | --- |
| `PaperclipCloudBuildSource` | `s3:PutObject` under `cloud-build/` in `claudeclaw[-suffix]-deploy-<account>-<region>` (the source zip), plus `s3:ListBucket` for the head-bucket preflight |
| `PaperclipCloudBuildProject` | create / update / start / read `claudeclaw[-suffix]-paperclip-cloud-build` |
| `PaperclipCloudBuildRole` | get / create / put-policy / tag `claudeclaw[-suffix]-paperclip-cloud-build-role` |
| `PaperclipCloudBuildPassRole` | `iam:PassRole` on that one role, conditioned on `iam:PassedToService=codebuild.amazonaws.com` |
| `PaperclipCloudBuildLogs` | read-only log tail of a **failed** build |

These are not an escalation: `cicdRole` already assumes the four
`cdk-hnb659fds-*` bootstrap roles, which between them create any principal in
the account. Each is pinned by a synth-level test that also asserts the
negative (no arbitrary project, no arbitrary role, no write outside the
`cloud-build/` prefix, no log writes).

**Second CI precondition, and it is not IAM.** The cloud build stages its
source in the environment's **state bucket**, which is a *bootstrap primitive*
created by `npm run bootstrap` / a local `npm run deploy` — never by the
workflow, which runs `npx cdk deploy --all` and no lifecycle bootstrap. If
that bucket does not exist for the target environment, the CI step fails in
its first seconds with the remedy in the message rather than partway through a
build. **Staging has never run `scripts/deploy.ts`**, so verify
`aws s3api head-bucket --bucket claudeclaw-staging-deploy-<account>-us-east-1`
before arming the flag there.

### 5.2 What "done" does NOT cover

- **§2 item 3 (digest in the deploy manifest) is satisfied on the
  `scripts/deploy.ts` driver only.** CI writes no deploy manifest at all — not
  for Paperclip and not for the orchestrator either — so on staging and
  production the digest is recorded in the run log, not in a manifest a
  rollback can read. This is pre-existing and not a regression, but the CI path
  must not be read as meeting item 3.
- **`npm run deploy:cloud` does not rebuild the Paperclip image.** The
  image-only path returns before phase a, and the Paperclip build lives inside
  phase a. Bumping `vendor/paperclip` therefore needs a full `npm run deploy`
  (or a CI deploy with the flag armed). See the Deploy section of `CLAUDE.md`.
- **The manifest's `taskFamily` and `containerName` are Phase 4 predictions.**
  `paperclip-image-pipeline.test.ts` carries two assertions that stay skipped
  until `infra/lib/paperclip-stack.ts` exists and then fire: one that Phase 4
  chose the predicted names, one that the `collectPrivateEcrDigests` skip is
  removed once Paperclip has a service of its own to roll back.

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
