#!/usr/bin/env bash
# Release-signing key ceremony (IaC readiness plan, items 42 + 44).
#
# Generates an ed25519 keypair for release signing and prints exactly what
# goes where. Run ONCE before the first public release (and again only as
# part of a signed key ROTATION, see scripts/lib/release/signing.ts).
#
# The output directory is GITIGNORED (scripts/release/keys/). The private
# key must never enter this repo, any shared machine, or a chat log.
set -euo pipefail

KEY_DIR="$(cd "$(dirname "$0")" && pwd)/keys"
PRIV="$KEY_DIR/release-signing-ed25519.pem"
PUB="$KEY_DIR/release-signing-ed25519.pub.pem"

if [[ -f "$PRIV" ]]; then
  echo "refusing to overwrite existing key at $PRIV" >&2
  echo "key rotation is a SIGNED RotationDoc, not a regenerate; see scripts/lib/release/signing.ts" >&2
  exit 1
fi

mkdir -p "$KEY_DIR"
chmod 700 "$KEY_DIR"

openssl genpkey -algorithm ed25519 -out "$PRIV"
chmod 600 "$PRIV"
openssl pkey -in "$PRIV" -pubout -out "$PUB"

cat <<EOF

Generated ed25519 release-signing keypair:

  private key : $PRIV
  public key  : $PUB

WHAT GOES WHERE
===============

1. PRIVATE KEY -> the release-signing environment ONLY.
   Store it as the release CI secret (e.g. GitHub Actions secret
   RELEASE_SIGNING_KEY) or keep it offline for manual signing with
   scripts/release/build-release.mjs. It must NEVER be committed; the
   keys/ directory is gitignored as a backstop, not a guarantee.

2. PUBLIC KEY -> scripts/update/trust-roots.ts.
   Paste the PEM below into the TRUST_ROOTS array and commit. That commit
   must ship IN THE FIRST PUBLIC RELEASE: every shim built from it can then
   verify every future release. An empty TRUST_ROOTS means the shim refuses
   to update, by design.

3. PUBLIC KEY (again) -> the published verification-keys location
   (release-keys/ on the default branch), so item 44's artifact-retention
   check can verify keys stay available.

Public key PEM (for TRUST_ROOTS):

EOF
cat "$PUB"
