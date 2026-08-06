/**
 * PINNED TRUST ROOTS for the updater shim (IaC readiness plan, item 42).
 *
 * ─────────────────────────────────────────────────────────────────────
 *  POPULATED AT THE FIRST-RELEASE KEY CEREMONY — EMPTY UNTIL THEN.
 *
 *  Before the first public release ships, a key ceremony runs
 *  scripts/release/generate-keys.sh, which writes an ed25519 keypair to a
 *  GITIGNORED directory and prints exactly what goes where:
 *
 *    - the PRIVATE key goes to the release-signing environment ONLY
 *      (offline or release-CI secret), never into this repo;
 *    - the PUBLIC key PEM is pasted into TRUST_ROOTS below, and that
 *      commit ships in the first release — every shim built from it can
 *      then verify every future release.
 *
 *  While TRUST_ROOTS is empty the shim REFUSES to update (it has nothing
 *  to verify against); that is correct behavior for a pre-release build,
 *  not a bug to work around. Never add a key here without the ceremony.
 * ─────────────────────────────────────────────────────────────────────
 *
 * Key ROTATION never edits this file retroactively: a new key ships as a
 * RotationDoc signed by an old root (scripts/lib/release/signing.ts), which
 * old shims verify with the keys below and then trust the new set. This
 * array is the generation-zero anchor of that chain.
 */

/** ed25519 public keys, PEM (SPKI). Order matters: RotationDoc.signedByOldKeyIndex indexes it. */
export const TRUST_ROOTS: readonly string[] = [
  // <populated at the first-release key ceremony — see comment above>
];
