# Release pipeline and the updater

> Every release of this project ships as signed, machine-readable artifacts: a metadata file, an image list, and a cryptographic signature that your installation checks before it runs a single line of new code. Release candidates and final releases are the exact same artifact under two names, and a promotion attestation proves it. Updating is one command, `npm run update -- <tag>`, and a failed update leaves your installation exactly where it was.

This page is the end-to-end story of how releases are cut, signed, promoted, retained, distributed, and consumed (IaC readiness plan items 41, 42, 44). It also states plainly which pieces exist as tooling today and which get created at the first public release.

## The artifact set

Each release tag publishes four files as GitHub release assets, assembled by [`scripts/release/build-release.mjs`](../scripts/release/build-release.mjs):

| Asset | Contract | Purpose |
| --- | --- | --- |
| `metadata.json` | [`scripts/lib/release/metadata.ts`](../scripts/lib/release/metadata.ts) | The machine-readable release contract: required actions (classified `automatic` / `manual-preflight` / `approval-required`), migration flags, rollback posture, support window, bootstrap prerequisites (min Node/npm), image digests, UPGRADING link. The dashboard and updater consume this; nothing ever parses release-note prose. |
| `artifact-manifest.json` | same module | tag → commit → per-platform image digests → provenance. "Signed multi-arch" is meaningless without saying what is signed; this names the digests precisely. |
| `signature.json` | [`scripts/lib/release/signing.ts`](../scripts/lib/release/signing.ts) | ed25519 signature over the IMMUTABLE payload (below). |
| `promotion-attestation.json` | [`scripts/lib/release/promotion.ts`](../scripts/lib/release/promotion.ts) | Final `v*` tags only: binds the final tag to the rc-tested commit + digests. Assembled as a skeleton at rc time, signed at promotion. |

All of these formats are **updater-critical** (plan item 49): each carries a `schemaVersion`, parsers fail loud when it is missing, and they tolerate unknown extra fields and NEWER schema versions for everything outside a tiny hard-required core. That asymmetry is deliberate: a year-old install's shim must parse tomorrow's metadata well enough to verify it, check prerequisites, and hand control to the new release's own code.

## What is signed, and why rc and final share one signature

The signed payload is exactly:

```
{ commit, imageDigests, provenance, metadataHash }
```

The channel tag is excluded **by construction**, in two layers:

1. `metadataHash` is the `immutableMetadataHash` of `metadata.json`: canonical sorted-key JSON with the `tag` field removed before hashing.
2. `canonicalPayloadBytes()` strips any `tag`/`channel` keys before serializing the payload, so even a buggy caller cannot smuggle channel identity into the signed bytes.

A tag inside the signed payload would make `rc/v1.4.0` and `v1.4.0` different artifacts by construction, which would mean the thing you tested is not the thing you shipped. Instead, an rc and its promoted final differ only in the metadata `tag` field and verify against the **same signature** (a unit test in [`build-release.test.ts`](../scripts/release/build-release.test.ts) proves the signature bytes are identical). What binds the final tag to the rc-tested artifacts is the promotion attestation, whose signed bytes DO include both tags, because channel identity is its entire purpose.

Corollary that the tooling enforces: nothing channel-derived may appear in defaulted metadata fields. `build-release.ts` defaults `upgradingUrl` to a commit-pinned URL, never a tag-pinned one, for exactly this reason.

## The rc flow

Release candidates live in the protected `rc/v*` namespace and run through the **same** signing pipeline as finals; there is no separate "test" pipeline that could drift. The upgrade canary (plan item 38) deploys the PREVIOUS release into the scratch account and runs `npm run update` to the rc artifact, so the upgrade path itself is what gets tested. Publishing `v*` is a re-tag plus a promotion attestation, never a rebuild: the digests in the final's metadata are byte-identical to the rc's, the signature carries over unchanged, and the attestation (optionally carrying the canary run id) is the proof.

Neither `v*` nor `rc/v*` ever triggers a customer deploy. Deploy triggers live in the separate `deploy/v*` namespace ([deploy-tag-pattern.ts](../infra/lib/deploy-tag-pattern.ts), [github-to-aws.md](./github-to-aws.md)); the dogfooding pipeline normalizes `deploy/vX` to upstream `vX` and verifies the upstream artifacts, ignoring whatever commit the deploy tag points at.

## Artifact retention: the contract behind upgrade chains

Direct upgrades are supported from N-1 only; older installs upgrade as a chain of sequential N-1 hops (plan item 49). Every hop needs its release fully intact upstream: a pruned stepping-stone strands every adopter behind it, permanently. So the retention contract says: **every release inside the support window keeps its tag, signed metadata, artifact manifest, signature, images, promotion attestation, and verification keys fetchable upstream**.

This is verified, not promised: release CI runs [`verifyRetention()`](../scripts/lib/release/artifact-retention.ts) over the in-window release list on every release and fails the release if any artifact of any in-window predecessor has gone missing. The check reports the full damage at once rather than stopping at the first hole.

## Distribution: ECR Public is distribution only

Release images are multi-arch and published to a public ECR gallery, but the gallery is **never the runtime source**:

- Fargate tasks run in private subnets and pull through private-ECR VPC endpoints; a task referencing the public gallery cannot pull at all.
- Public pull quotas would gate your rollouts.
- The rollback guarantees in [lifecycle.md](./lifecycle.md) (immutable per-deploy tags, digest-existence preflight) are private-ECR properties.

So `npm run update` verifies the signature first, then **imports** the selected platform digest into your own private regional ECR repo (a bootstrap-state primitive, created before any stack) via [`importReleaseImage()`](../scripts/lib/release/image-import.ts):

- the copy is registry-native and manifest-preserving (`crane copy` / `skopeo copy --all`), run from the operator's machine with explicit egress;
- never `docker pull` + `tag` + `push`, which can rewrite manifests and silently change the digest;
- never ECR pull-through cache, whose first pull happens at task start, exactly when a private subnet cannot reach out;
- after the copy, the private digest is read back and must equal the signed digest, or the import hard-fails.

Trust carries by digest pinning after the verified import; the private copy is not re-signed. The deploy manifest records the PRIVATE digest.

## The updater: a two-phase bootstrap

`npm run update -- <tag>` runs the **updater shim** ([`scripts/update/shim.ts`](../scripts/update/shim.ts)), which is deliberately small and stable because the running script is OLD code while doctor, diff, and migrations need TARGET-version logic. The rule is verify-then-exec, never exec-then-trust.

The shim's flow, with its abort points:

1. **Refuse dirty/forked installs.** The primary checkout must be clean and exactly at a trusted upstream `v*` tag, or the shim stops before fetching anything and points at `--build-local` (below).
2. **Fetch** `metadata.json`, `artifact-manifest.json`, `signature.json`, and any key-rotation docs from GitHub releases.
3. **Verify** against the trust roots pinned at build time in [`scripts/update/trust-roots.ts`](../scripts/update/trust-roots.ts), after applying any rotation docs that verify against the old roots. Any failure aborts BEFORE a worktree exists.
4. **Gate prerequisites.** The signed metadata's `bootstrapPrerequisites` (min Node/npm) are checked against the running toolchain BEFORE any target code executes, so "your Node is too old" is a clean early message, never a mid-update crash.
5. **Worktree + target deps.** `git worktree add .cce-update/worktrees/<tag>`, then `npm ci` there from the TARGET's lockfile (old `node_modules` cannot run new code).
6. **Exec the target's runner** ([`scripts/update/runner.ts`](../scripts/update/runner.ts)) inside the worktree, passing the verified metadata.
7. **Advance the pointer last.** Only after the runner exits 0 does the shim run `git checkout <tag>` in the primary checkout. A failed update leaves the durable checkout untouched.

The runner (target-version code) then does the update proper: prints the release-notes summary and the machine-readable `BEGIN-REQUIRED-ACTIONS` block (including the `requiredActionsHash` the item-47 approval artifact binds to), runs doctor against the NEW version's requirements and a `cdk diff` preview, all read-only and lock-free; then acquires the lifecycle lock at the first mutation, revalidates the deployed version has not changed since the preview, journals and performs the image import, runs `expand` migrations, hands off to the standard phased deploy (`tsx scripts/deploy.ts --yes`, as a child process; deploy takes the lock itself), and runs `backfill` and `contract` migrations only after `npm run verify` passes. The migration ordering contract (expand before rollout, contract after verify-stable, journaled phases, idempotency keys, maintenance-mode gate) lives in [`scripts/lib/release/migrations.ts`](../scripts/lib/release/migrations.ts) with the per-release registry at [`scripts/migrations/index.ts`](../scripts/migrations/index.ts).

Key rotation: the shim's pinned roots are generation zero. A new signing key ships as a `RotationDoc` signed by an old key; old shims verify the rotation chain with the keys they already have and then trust the new set. A broken chain link aborts the whole chain.

## Forks: `--build-local`

If you have forked and modified this repo, upstream prebuilt images do not match your code, and the shim will refuse to update you (that refusal is the last clause of plan item 42, and it is load-bearing). Your path:

1. Build and deploy from your own source: `npm run deploy -- --build-local` builds your tree's image and deploys it; nothing in the prebuilt pipeline is a prerequisite.
2. To keep consuming upstream changes, maintain an `upstream` remote and rebase your fork onto new release tags (`npm run doctor` warns when tracked files are locally modified, which is the early warning for merge pain).
3. To run your own release pipeline, the tooling here is fork-ready: run your own key ceremony (`scripts/release/generate-keys.sh`), put YOUR public key in your fork's `trust-roots.ts`, publish your own gallery, and `build-release.mjs` assembles and self-verifies your artifacts with the same code paths.

## What exists today vs what the first release creates

Everything in this page's tooling exists and is unit-tested against fakes **today**. The external objects do not exist yet and are created at first-release time:

| Created at first release | How | Where it lands |
| --- | --- | --- |
| Release signing keypair | the KEY CEREMONY: run [`scripts/release/generate-keys.sh`](../scripts/release/generate-keys.sh) once | private key → release-signing environment only (CI secret or offline); public key → `TRUST_ROOTS` in [`trust-roots.ts`](../scripts/update/trust-roots.ts) and the published `release-keys/` location |
| Public ECR gallery | `aws ecr-public create-repository --region us-east-1` in the distribution account (the ECR Public control plane is served only from us-east-1, regardless of the account's default region) | `publicRepo` values in each release's metadata |
| First release artifacts | release CI calls `build-release.mjs` at tag time, uploads the four assets | GitHub release assets for the tag |
| The shim itself, shipped | the trust-roots commit + this tooling are IN the first release | every adopter's checkout, so the SECOND release's upgrade canary has an updater to test (plan item 50) |

Until the ceremony happens, `TRUST_ROOTS` is empty and the shim refuses to update. That refusal is correct pre-release behavior, not a bug: an updater with nothing pinned has nothing to verify against, and verify-then-exec means it must not run.

Sequencing (plan item 50): the metadata pipeline and shim ship in the FIRST public release; the upgrade canary arms on the SECOND release, when there are two releases to upgrade between.
