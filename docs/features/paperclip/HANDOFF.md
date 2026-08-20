---
feature: paperclip
document_role: handoff
status: current
observed_at: 2026-08-20
as_of_commit: 6996f64efaace96bb4b19246e4a870be341290c1
---

# Paperclip integration handoff

- **Branch: `fix/paperclip-phase2-readiness`**, cut from `development` at
  `5418497`, seven commits, per
  [CONTRIBUTING.md](../../../CONTRIBUTING.md). It reaches no AWS environment —
  see the
  [branch-to-environment mapping](../../../development.md#branch-to-environment-mapping).
- [PR #81](https://github.com/Adams-Captial-Holdings-Ltd/Netzer-Labs/pull/81)
  **merged** into `development` on 2026-08-20 as `5418497` (squash) and its
  branch was deleted (**P7**). The Phase 1 audit work is on `development`.
- Deployment: **nothing new deployed.** Staging remains green at `e8ba485` with
  the Paperclip substrate switched off. No user-visible route has changed.
- Phases: §33 first milestone 1A–1D complete; Phase 0 complete (`227feca`);
  Phase 1 **code** complete (`44aad84`), audited 2026-08-19, and its remaining
  Phase 2 code blockers cleared 2026-08-20. Active task: **Phase 1 steps 5–8**,
  all of which need a deploy go-ahead.

## What changed on 2026-08-20

Four code blockers closed, and one Phase 2 precondition answered by inspection
rather than by work.

- **The Paperclip ECR repository is created again, gated.** Phase 1 left
  nothing creating it: the ungated version was removed in `e9de42b` because it
  made an empty repo on every deploy for an image nothing pushes (**M23**), and
  CI never had a step. It is now created in deploy **phase a**, beside
  `ensureSchedulerGroup` and behind the same `CCE_PAPERCLIP_ENABLED` flag as
  the two substrate stacks, named from `buildResourceNames().paperclipEcrRepo`
  rather than a regex over `ECR_REPO_NAME`. An unarmed deploy still creates
  nothing.
- **Teardown deletes it.** The out-of-band catalog is a **report, not an
  executor** — `plan.catalogAppOwned` is printed and never acted on, and every
  real deletion is hand-written in `scripts/teardown.ts`. A catalog row alone
  would have left an armed install paying for an orphaned repo, which is the
  same class of mistake as **M23**. Both the row and the explicit delete now
  exist.
- **`/claudeclaw[-suffix]/paperclip` gets a real `better_auth_secret`.**
  Generated once by `npm run setup` into `.env`
  (`PAPERCLIP_BETTER_AUTH_SECRET`), then written by deploy phase b as a
  **merge**, not a replace. Both halves matter: `planSecretWrites` runs on every
  deploy, so minting the value there would rotate the auth secret every deploy;
  and `PutSecretValue` swaps the whole string, so a plain write would destroy
  `reconciler_key` / `agent_keys` / `dispatch_secret` once a later phase mints
  them against the running instance.
- **`ComputeStack` exports its HTTPS listener** so Phase 2's listener rule has
  something to attach to. Optional by design: it is only built when
  `DOMAIN_NAME` is set.
- **The CI deploy path creates the repo too.** CI does **not** run
  `scripts/deploy.ts`; it runs `npx cdk deploy --all` and mirrors the phased
  driver with its own steps. The phase-a fix above would therefore never have
  executed on the path that reaches staging — the same shape as **M22**, one
  layer up. `.github/workflows/deploy.yml` now ensures both repos, gated.
- **Aurora's ceiling is tier-gated** (see decision 2 below).

## Ready for Phase 2?

**Not yet — but the list is shorter and one entry was wrong.**

| Precondition | State on 2026-08-20 |
|---|---|
| The ARM64 question | **ANSWERED — yes.** The pinned digest is an OCI image **index** carrying `linux/amd64` and `linux/arm64` (`sha256:6ab3c816de36f9a69e9f462e950a153e3d30b6cbc03f9a78c5b140277fbafa25`), read straight from GHCR. No `docker buildx` run was needed. This precondition was carried as unmet in two prior handoffs; it was met all along. See **A22**. |
| A repository to push the image to | **DONE** — deploy phase a creates it when armed. |
| `/claudeclaw/paperclip` populated | **DONE for `better_auth_secret`**, which is the only field Phase 2's task needs. The other three stay `REPLACE_ME` until a later phase mints them. |
| Phase 1 **deployed** (Aurora, EFS, log group) | **no** — code only, gate off. Needs a deploy go-ahead; creates billable resources. |
| `cdk diff` read against the real account (step 5) | **no** — never run; same go-ahead. |
| The patched image built and pushed | **no** — nothing builds it yet. See the decision below. |

`plan-audit.md` **P1-C4 is settled**: the shipped `agent_keys` /
`dispatch_secret` spelling wins, `agent_keys_json` / `dispatch_token` must not
be used. Recorded in the audit; the plan text is left alone per **A10**.

## Decisions taken 2026-08-20

Both were taken because Paperclip has to install into a **customer's own AWS
account** as part of a Netzar OS install, not only into ours. The second is
already built; the first is not.

1. **The patched image will be built by CodeBuild in the customer's own
   account**, extending the existing Docker-free path in
   `scripts/lib/lifecycle/cloud-build.ts` to also build
   `vendor/paperclip/Dockerfile` and push to their ECR. That module exists
   precisely because local Docker was "the heaviest prerequisite in the whole
   install"; requiring it again for Paperclip would undo that. Not built yet —
   this is the remaining Phase 2 image blocker.
2. **Aurora is tier-gated on capacity, protection kept — BUILT 2026-08-20.**
   `TierShape.paperclipAuroraMaxAcu` drives `serverlessV2MaxCapacity`: Tier 0
   **1 ACU**, Tier 1 2, Tier 2 4 (the value previously hardcoded for every
   tier), Tier 3 8. `deletionProtection` and `RemovalPolicy.RETAIN` untouched,
   so **P17** and **M19** still hold.

   **This caps burst, it does not remove the floor.** The continuous cost is
   `serverlessV2MinCapacity`, still 0.5 on every tier because 0.5 is the lowest
   non-zero ACU. Cutting that means scale-to-zero, a runtime behaviour change
   and a separate decision — deliberately not taken here.

## Blockers

1. Phase 1 steps 5–8 (real-account `cdk diff` + deploy, image build, image
   push) need an **explicit user deploy go-ahead** — they create billable AWS
   resources.
2. **Nothing builds or pushes the Paperclip image.** Decision 1 above names the
   path; the code does not exist.
3. **Before Phase 4**, the plan's dual-write and `PAPERCLIP_ENABLED`
   contradictions need an author decision. §30's rollout and §25/§27's cutover
   were written to different premises and cannot both be executed. See
   [plan-audit.md](plan-audit.md) P1-C6 and P1-C7.
4. **A staging deploy will very likely fail on an existing orphan.** **M19**
   records that the 2026-08-19 `CCE-STAGING-Filesystem` rollback abandoned
   EFS `fs-08f70326911d2ae49` and log group `/claudeclaw-staging/paperclip`
   as `RETAIN` leftovers. `filesystem-stack.ts:71` creates that log group with
   a **fixed name**, and CloudFormation cannot create a fixed-name log group
   that already exists. Delete the orphan log group before arming
   `CCE_PAPERCLIP_ENABLED` in staging, or the stack rolls back at exactly the
   point it did last time. The orphan EFS will not block (its name is a tag,
   not a key) but a retry creates a **second** filesystem and bills for both.
5. `2026-08-19-staging-deploy-green.md` is still unmerged on
   `docs/staging-deploy-green-handoff`, so the session index below has an
   unlinkable row. Against its own merge-base it adds **one file and touches no
   code**, so merging it is safe and reverts nothing.

## Last required checks

2026-08-20, at `6996f64`, compared to a baseline taken on the untouched branch
before any edit (**P1**) and by failing file **name**, never count (**A9**):

- Full `npm test`: 192 files, 2134 tests. **6 files / 7 tests failed — the same
  names as the baseline**, all in the documented Windows environmental set.
  Passing rose 2116 → 2121, exactly the five cases added.
- `npm run typecheck`, `npm run build`: clean.
- `docs-links.mjs`, `feature-knowledge.mjs`, `diagrams-drift.mjs` (forced into
  PR context): all OK. `git diff --check`: clean.
- `npx cdk ls`: **15 stacks** flag-off, **17** flag-on — the gate still works
  and the listener export did not disturb synth.
- `cdk diff` and any deploy: **not run.** This session made no AWS call.

**Smallest next action:** open a PR for `fix/paperclip-phase2-readiness` →
`development`, and merge `docs/staging-deploy-green-handoff` to restore the
session-index link.

**How staging actually deploys.** `.github/workflows/deploy.yml` carries
`on: push: branches: [staging]`, so **staging deploys automatically on a push
to `staging`** — it is not `workflow_dispatch`-only. **A4** says otherwise and
is correct only for production. Arming Paperclip there is
`gh variable set CCE_PAPERCLIP_ENABLED --body 1` plus a push, and it creates
billable Aurora and EFS. Clear the orphan in blocker 4 first.

## Session log index

Newest first. Every session that works in this folder adds one file to
`handoffs/`, copied from the
[session handoff template](../HANDOFF-TEMPLATE.md), and links it here.

| Session | Date | Summary |
|---|---|---|
| [Phase 2 readiness](handoffs/2026-08-20-phase-2-readiness.md) | 2026-08-20 | Verified the blocker list instead of trusting it: proved the ARM64 precondition was already met, restored gated ECR creation with a real teardown, gave the Paperclip secret a non-rotating `better_auth_secret`, exported the ALB listener, settled P1-C4 |
| [Phase 1 ponytail audit](handoffs/2026-08-19-phase-1-ponytail-audit.md) | 2026-08-19 | Audited Phase 1 for over-engineering; found the `CCE_PAPERCLIP_ENABLED` gate was mirrored in one place of five and failed silently, removed three ungated side-effects, recorded what must not be cut |
| Staging deploy green (`2026-08-19-staging-deploy-green.md`) — **unmerged**, on `docs/staging-deploy-green-handoff`, so not linkable from here | 2026-08-19 | Fixed the non-ASCII SG descriptions, gated the Paperclip stacks behind `CCE_PAPERCLIP_ENABLED`, deployed staging green |
| [Org transfer, OIDC and staging deploy](handoffs/2026-08-19-org-transfer-oidc-and-staging-deploy.md) | 2026-08-19 | Diagnosed the red staging deploy to the org's immutable OIDC subject claims and made the trust generator emit either form |
| [Documentation consolidation](handoffs/2026-08-19-docs-consolidation.md) | 2026-08-19 | Vendored the implementation plan and its audit into the repo, tracked the Codex session log, rewrote this README/HANDOFF from all three handoffs |
| [updated-since patch + Phase 0/1](handoffs/2026-08-18-updated-since-patch-and-phase-0.md) | 2026-08-18 | Finished Milestone 1D, resolved the I3 blocker via the user-approved artifact patch, wrote ADR 0010 and this feature folder, landed Phase 1 infra code |
| [Codex deep dive and first-milestone pause](handoffs/2026-08-18-codex-review.md) | 2026-08-18 | The origin session: produced the implementation plan, built Milestones 1A–1C, and proved the pinned release has no `updatedSince` — the I3 architecture blocker |

Authorities: [README](README.md),
[ADR 0010](../../adr/0010-paperclip-work-engine.md),
[ADR 0009](../../adr/0009-mission-container-model.md),
[implementation plan](implementation-plan.md),
[plan audit](plan-audit.md).
