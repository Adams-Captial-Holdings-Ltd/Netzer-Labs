# ADR 0011 — A release artifact's identity comes from the promotion attestation, not its signature

**Status:** Accepted (2026-09-08, release-pipeline-v1 P1/P2/P6)

## Context

Netzar OS signs releases with ed25519 and pins the public keys in
[`trust-roots.ts`](../../scripts/update/trust-roots.ts). The signed payload is
deliberately **tag-free**: [`signing.ts`](../../scripts/lib/release/signing.ts)
removes `tag` and `channel` from the payload before canonicalising it, and the
comment there states the intent plainly — rc and final promotion share one
signature *because nothing channel-shaped can reach these bytes*.

That is a real property and worth keeping. It is what makes "the thing tested is
the thing shipped" true by construction rather than by assertion: promoting
`rc/v1.0.0` to `v1.0.0` is a re-tag, not a rebuild, and the two signatures are
byte-identical.

It also means **the signature says nothing about which tag an artifact belongs
to.** An existing test,
[`shim.test.ts`](../../scripts/update/shim.test.ts), asserts exactly this: a
re-tagged rc metadata still verifies. That test is correct and must stay.

The gap was that nothing else supplied the missing binding.
[`promotion.ts`](../../scripts/lib/release/promotion.ts) defines
`createPromotionAttestation` / `verifyPromotionAttestation` precisely to bind a
final tag to the rc-tested commit and digests — but at the time of this ADR
`verifyPromotionAttestation` had **zero non-test callers**, the updater fetched
only metadata, manifest, signature and rotation docs, and
`build-release.ts` emitted the attestation as an unsigned skeleton that nothing
ever signed. So an rc's signature was, in practice, a valid signature for any
tag an attacker chose to serve it under.

## Decision

**1. The tag→artifact binding lives in the promotion attestation, and the
updater enforces it.**

`ShimFetcher` gains a fifth method, `fetchPromotionAttestation(tag)`, typed
`Promise<string>` rather than `Promise<string | null>`. For a target matching
`/^v\d/` the shim fetches the attestation and requires
`verifyPromotionAttestation` to return `{ok: true}` against the **rotated** trust
roots, before any worktree is created or any target code runs. A missing asset
is an abort, never a shrug.

The nullability is not an accident of style.
[`artifact-retention.ts`](../../scripts/lib/release/artifact-retention.ts)
declares a same-named method that *is* nullable, because it reports on retention
rather than gating an install. Copying that nullability into the shim and
writing `if (att) { verify }` would reintroduce the hole by omission, and every
test would still pass.

The rejected alternative was a one-line `if (metadata.tag !== targetTag) throw`
inside `verifyReleaseArtifacts`. It closes the headline case, needs no new
fetcher method — and destroys promotion, because it makes an rc and its final
different artifacts. It is the tempting fix, and it is wrong.

**2. `rcTag` is checked by the publisher, not the updater.**

`rcTag` sits inside the signed attestation bytes, so an attacker cannot alter it
— only the legitimate signer chooses it. A shim-side check would therefore
defend against nothing an attacker can do; a wrong `rcTag` is a *publisher*
mistake. It is enforced in
[`sign-promotion.ts`](../../scripts/release/sign-promotion.ts), which refuses to
sign unless `rcTag === 'rc/' + finalTag`, rejects a self-promotion where the two
are equal, and rejects an rc-shaped final tag. `verifyPromotionAttestation` does
not check `rcTag` at all, so if the signer does not catch it, nothing does.

**3. Nested channel keys are refused by the consumer, not filtered by the
canonicaliser.**

`canonicalPayloadBytes` strips `tag`/`channel` at the **top level only**; the
deep key sort that follows recurses without filtering. So
`imageDigests: {"tag": "v9.9.9"}` reaches the signed bytes and survives parsing,
because the signature parser passes `imageDigests` through by reference.

`verifyReleaseArtifacts` now rejects any signed payload carrying `tag` or
`channel` below the top level. The canonicaliser itself is **not** changed:
altering it would change what bytes get signed, and the fix belongs at the
boundary that can refuse without invalidating anything already published. The
underlying one-level filter is recorded as a follow-up, with the corpus test as
evidence.

## Consequences

- A final `v*` release cannot be installed until its promotion attestation is
  published and signed. Release CI must produce one, or the release is
  uninstallable — a deliberate fail-closed posture.
- `verifyReleaseArtifacts` now returns the rotated `roots` alongside metadata
  and warnings, so the attestation is checked against the same key set as the
  release signature. Checking it against the *pinned* roots instead would brick
  updates on the first key rotation — during exactly the incident a rotation
  responds to.
- The rc→final byte-identical-signature property is preserved, and
  `shim.test.ts`'s re-tag test still passes unchanged.
- A downgrade is refused before any fetch: the updater compares target and
  installed versions with `rc/` stripped, and equal versions remain installable
  because an rc and its final of the same version are the same commit and the
  same digests.

## Evidence

The five forged releases these decisions exist to refuse are encoded in
[`forgery.test.ts`](../../scripts/update/forgery.test.ts). Each carries a witness
assertion proving the forgery is otherwise cryptographically perfect, so the
only reason to refuse is the control under test. Each guard was mutation-tested:
reverting it turns the matching case red.

## Related

- [ADR 0010 — Paperclip is the missions work engine](0010-paperclip-work-engine.md)
- [The release pipeline](../release-pipeline.md)
