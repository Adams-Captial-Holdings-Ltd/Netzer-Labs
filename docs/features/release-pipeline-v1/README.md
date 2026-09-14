---
feature: release-pipeline-v1
document_role: index
status: current
observed_at: 2026-09-08
as_of_commit: 271339bc8b2feea85e6c31b115fdd34e757a72e2
implemented_by:
  - scripts/update/shim.ts
  - scripts/update.ts
  - scripts/lib/release/retention-fetcher.ts
  - scripts/release/sign-promotion.ts
  - scripts/release/build-release.ts
  - scripts/lib/release/signing.ts
  - scripts/lib/release/promotion.ts
tested_by:
  - scripts/update/forgery.test.ts
  - scripts/update/shim.test.ts
  - scripts/lib/release/retention-fetcher.test.ts
  - scripts/release/sign-promotion.test.ts
decisions:
  - docs/adr/0011-release-artifact-identity.md
---

# Release pipeline v1

## 1. Start Here

Netzar OS has carried a complete signed-release system for months and has never
cut a release. `TRUST_ROOTS` is empty, `git tag --list` is empty, and
`package.json` still says `0.0.1`. This feature is the work that makes the first
release possible — and, more importantly, makes it *refusable* when it is forged.

The bar this work was held to is not "the modules exist". It is a corpus of five
forged releases the updater must reject. **Three of the five were accepted by the
updater before this work.**

Read [ADR 0011](../../adr/0011-release-artifact-identity.md) first if you want
the reasoning; read [`forgery.test.ts`](../../../scripts/update/forgery.test.ts)
if you want the proof.

## 2. What release-pipeline-v1 does today

- The updater refuses an rc's artifacts presented under a final `v*` tag, by
  fetching and verifying a **promotion attestation** bound to that exact tag,
  commit and digest set.
- The updater refuses a **downgrade** — a genuine, correctly signed older
  release replayed at an installed host — before it fetches a single byte.
- The updater refuses a signed payload carrying `tag`/`channel` **below the top
  level**, which the canonicaliser's one-level filter would otherwise let into
  the signed bytes.
- A concrete `RetentionFetcher` exists, so `verifyRetention()` can be run for
  real instead of only against test stubs.
- `promotion-attestation.json` can actually be signed, by
  [`sign-promotion.ts`](../../../scripts/release/sign-promotion.ts). Before this,
  `createPromotionAttestation` had zero non-test callers and
  `build-release.ts` emitted an unsigned placeholder nothing ever filled.
- A release workflow exists at
  [`release.yml`](../../../.github/workflows/release.yml).

## 3. Current status and current source commit

Branched from `271339bc8b2feea85e6c31b115fdd34e757a72e2` on `development`.

**Nothing here has been exercised against a real release.** No tag has been cut,
no key ceremony has been run, `TRUST_ROOTS` is still empty, and `release.yml` has
never executed. Every claim above is proven by unit tests and mutation testing,
not by a published release.

## 4. Source of truth

| Question | Authority |
|---|---|
| Why identity lives in the attestation, not the signature | [ADR 0011](../../adr/0011-release-artifact-identity.md) |
| What a release publishes, and the retention contract | [`docs/release-pipeline.md`](../../release-pipeline.md) |
| What the updater refuses, and why each refusal is real | [`scripts/update/forgery.test.ts`](../../../scripts/update/forgery.test.ts) |
| The canonicalisation that must not drift | the golden-vector tests in that same file |
| Branch → environment reality | [`development.md`](../../../development.md) |

## 5. Implementation map

| Concern | Where |
|---|---|
| Release verification, all consumers | `verifyReleaseArtifacts` in [`shim.ts`](../../../scripts/update/shim.ts) |
| The promotion gate and the replay gate | `runShim` in the same file |
| Nested channel-key refusal | `findChannelKey`, same file |
| Real asset fetching | [`scripts/update.ts`](../../../scripts/update.ts) |
| Retention checking | [`retention-fetcher.ts`](../../../scripts/lib/release/retention-fetcher.ts) |
| Promotion signing, and the `rcTag` rule | [`sign-promotion.ts`](../../../scripts/release/sign-promotion.ts) |
| Publishing | [`release.yml`](../../../.github/workflows/release.yml) |

## 6. Current business/state rules

- A final `v*` target requires a promotion attestation that verifies against the
  **rotated** trust roots and binds the tag, commit and digests. Missing is an
  abort, never a shrug.
- An `rc/v*` target carries no attestation and is not asked for one.
- The updater only moves forward. Equal versions are installable (an rc and its
  final of the same version are the same commit and digests); strictly lower is
  refused.
- `rcTag` is enforced by the **signer**, not the updater: it is inside the
  signed bytes, so only the legitimate publisher can choose it.
- The canonicaliser is not modified. Nested channel keys are refused at the
  consumer instead, so nothing already signed is invalidated.

## 7. Known runtime risks and approved next work

Carried out of scope deliberately, or found in passing and not acted on:

1. **P5 — pin the orchestrator by digest.** Built on
   `feature/release-pipeline-p4-p5` as `b27ac38` (2026-09-14; local, not
   pushed, not yet verified). Every driver forwards `CCE_IMAGE_DIGEST`, and a
   malformed one fails synth. **Rollout gate:** before promoting `qa → staging`,
   re-apply both orchestrator repos' ECR lifecycle policies without the
   untagged-expiry rule. This needs `aws login`.
2. **The orchestrator image-digest step** (`deploy.yml`, `id: orchimg`) — the
   other half of P2, built in the same commit. `release.yml`'s "digest step
   does not exist yet" text goes stale once it merges.
3. **`canonicalPayloadBytes` filters channel keys one level deep only.** Root
   cause of forgery 04; the consumer-side guard is a containment, not a fix.
4. **`verifyPromotionAttestation` never checks `rcTag`**, so a self-promotion
   where `rcTag === finalTag` verifies. `sign-promotion.ts` refuses to *create*
   one; a hand-rolled attestation would still pass verification.
5. **`build-release.ts` self-verifies against the CLI `--pub`**, not
   `TRUST_ROOTS`, so any keypair produces a self-consistent release.
6. **The rotation feed is fetched from a mutable ref**, and a non-array body
   collapses to `[]`. Now `/HEAD/` rather than a non-existent `/main/`, which is
   a fix, but the mutability remains.
7. **Four baseline test files fail at collection** because vite-node does not
   strip `#!/usr/bin/env node` from a `.mjs` imported by a test. One line per
   file. Pre-existing, not caused here, and not this feature's to fix.
8. **`deploy.yml` and `ci.yml` both define a job named `Typecheck + Unit Tests`.**
   Required checks match by name, so that context is ambiguous on `staging` and
   `production`. Rename before any promotion ruleset goes active.
9. **`docs/adr/README.md` does not index ADR 0010.** Noticed while adding 0011.
10. **The drift check is disarmed, not fixed** (`db116ba`, 2026-09-14). All
    39 scheduled runs failed because `CDK_DIFF_ROLE_ARN` is unset, and nothing
    in the repo creates the diff role. Restoring it needs that role and a synth
    env re-derived from `deploy.yml`'s CDK deploy step. Escalate by 2026-10-01.
11. **Filed by P4 and P5, not acted on** (detail in the
    [planning log](handoffs/2026-09-10-p4-p5-planning.md)):
    - `:latest` is still pushed. It is inert once task definitions pin a digest.
    - `npm run deploy -- --image-only` only force-rolls the current revision.
    - `docs/security-posture.md` and `docs/security-model.md` still call the
      drift check daily.
    - P5 pins each environment's own rebuild, not the artifact staging tested,
      so "build once, promote by digest" is a P6/P9 decision.
    - The updater verifies a signed image, then deploys a rebuild of it.
    - Released images age out after about 50 deploys, and the base image
      (`node:20-alpine`) floats by tag.

## 8. Exact focused and full validation commands

```bash
npx vitest run scripts/update/ scripts/lib/release/ scripts/release/
node .baseline/mutate.mjs
```

The second is the one that matters: it reverts each guard in turn and asserts
the matching forgery goes red. A corpus that stays green under mutation proves
nothing.

Full pre-push list: [`development.md`](../../../development.md).

## 9. Related documents

- [Feature knowledge framework](../README.md)
- [The release pipeline](../../release-pipeline.md)
- [ADR 0011 — release artifact identity](../../adr/0011-release-artifact-identity.md)
- [Session handoffs](handoffs/2026-09-08-forgery-corpus-and-release-ci.md)
