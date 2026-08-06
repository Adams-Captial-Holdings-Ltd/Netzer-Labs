/**
 * Release signing (IaC readiness plan, item 44).
 *
 * ed25519 over node:crypto. The signature covers IMMUTABLE content ONLY:
 *
 *   { commit, imageDigests, provenance, metadataHash }
 *
 * NEVER the channel tag. A tag inside the signed payload would make the rc
 * and the promoted final different artifacts by construction; instead,
 * promotion is a separate PROMOTION ATTESTATION (promotion.ts) that binds
 * the final tag to the rc-tested commit + digests. `metadataHash` is the
 * immutableMetadataHash (metadata canonicalized WITH THE TAG REMOVED, see
 * metadata.ts), so the whole chain is tag-free: the rc artifacts and the
 * final artifacts verify against the SAME signature.
 *
 * canonicalPayloadBytes() strips any `tag`/`channel` keys defensively before
 * serializing, so even a buggy caller cannot smuggle channel identity into
 * the signed bytes.
 *
 * Key rotation (item 42): the shim pins TRUST_ROOTS at build time; a new
 * key ships as a RotationDoc SIGNED BY AN OLD ROOT, so an old shim can
 * verify the rotation with the keys it already has, then trust the new set.
 */

import {
  createPrivateKey,
  createPublicKey,
  sign as edSign,
  verify as edVerify,
} from 'node:crypto';

/** Schema version of the key-rotation document (item 49: updater-critical). */
export const ROTATION_DOC_SCHEMA_VERSION = 1;

/** Schema version of the signature artifact file shipped with each release. */
export const SIGNATURE_ARTIFACT_SCHEMA_VERSION = 1;

/**
 * The signed payload. Deliberately tiny and tag-free:
 *  - commit: the exact git commit the release was built from;
 *  - imageDigests: platform -> sha256 digest in the public gallery;
 *  - provenance: builder identity / workflow run URL;
 *  - metadataHash: immutableMetadataHash of the release metadata (tag
 *    excluded by construction, see metadata.ts).
 */
export interface ReleaseSignPayload {
  commit: string;
  imageDigests: Record<string, string>;
  provenance: string;
  metadataHash: string;
}

/**
 * The signature artifact file (signature.json) attached to a release:
 * payload + base64 ed25519 signature over canonicalPayloadBytes(payload).
 */
export interface SignatureArtifact {
  schemaVersion: number;
  payload: ReleaseSignPayload;
  sig: string;
}

/** Keys that could carry channel identity; stripped by construction. */
const CHANNEL_KEYS = new Set(['tag', 'channel']);

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(obj)
        .sort()
        .map((k) => [k, sortKeysDeep(obj[k])]),
    );
  }
  return value;
}

/**
 * Canonical signed bytes: sorted-key JSON of the payload with any top-level
 * `tag`/`channel` keys removed. The exclusion is BY CONSTRUCTION, not by
 * convention — rc and final promotion share one signature because nothing
 * channel-shaped can reach these bytes.
 */
export function canonicalPayloadBytes(payload: ReleaseSignPayload): Buffer {
  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload as unknown as Record<string, unknown>)) {
    if (CHANNEL_KEYS.has(k)) continue;
    cleaned[k] = v;
  }
  return Buffer.from(JSON.stringify(sortKeysDeep(cleaned)), 'utf8');
}

/** Sign the release payload with an ed25519 private key (PEM). Returns base64. */
export function signReleasePayload(privKeyPem: string, payload: ReleaseSignPayload): string {
  const key = createPrivateKey(privKeyPem);
  // ed25519 requires algorithm null (the curve fixes the digest).
  return edSign(null, canonicalPayloadBytes(payload), key).toString('base64');
}

/** Verify a base64 signature over the canonical payload bytes. Never throws on a bad sig. */
export function verifyReleasePayload(
  pubKeyPem: string,
  payload: ReleaseSignPayload,
  sigB64: string,
): boolean {
  let sig: Buffer;
  try {
    sig = Buffer.from(sigB64, 'base64');
    const key = createPublicKey(pubKeyPem);
    return edVerify(null, canonicalPayloadBytes(payload), key, sig);
  } catch {
    return false;
  }
}

/** Try every pinned root; true when ANY verifies. Empty roots verify nothing. */
export function verifyAgainstRoots(
  roots: readonly string[],
  payload: ReleaseSignPayload,
  sigB64: string,
): boolean {
  return roots.some((root) => verifyReleasePayload(root, payload, sigB64));
}

// ─────────────────────────────────────────────────────────────────────
// Key rotation (item 42: rotation metadata verifiable by OLD roots)
// ─────────────────────────────────────────────────────────────────────

export interface RotationDoc {
  schemaVersion: number;
  /** The complete NEW trust-root set (PEM public keys), replacing the old. */
  newKeys: string[];
  /** Index into the CURRENT root set of the old key that signed this doc. */
  signedByOldKeyIndex: number;
  /** base64 ed25519 over rotationDocBytes (everything except sig). */
  sig: string;
}

/** Canonical signed bytes of a rotation doc: all fields except `sig`. */
export function rotationDocBytes(doc: Omit<RotationDoc, 'sig'>): Buffer {
  const { schemaVersion, newKeys, signedByOldKeyIndex } = doc;
  return Buffer.from(
    JSON.stringify(sortKeysDeep({ schemaVersion, newKeys, signedByOldKeyIndex })),
    'utf8',
  );
}

/** Create a rotation doc signed by one of the CURRENT (old) private keys. */
export function createRotationDoc(
  oldPrivKeyPem: string,
  newKeys: string[],
  signedByOldKeyIndex: number,
): RotationDoc {
  const unsigned = {
    schemaVersion: ROTATION_DOC_SCHEMA_VERSION,
    newKeys,
    signedByOldKeyIndex,
  };
  const key = createPrivateKey(oldPrivKeyPem);
  const sig = edSign(null, rotationDocBytes(unsigned), key).toString('base64');
  return { ...unsigned, sig };
}

/** Verify a rotation doc against the CURRENT root set (the OLD keys). */
export function verifyRotationDoc(currentRoots: readonly string[], doc: RotationDoc): boolean {
  if (
    typeof doc.schemaVersion !== 'number' ||
    doc.schemaVersion < 1 ||
    !Array.isArray(doc.newKeys) ||
    doc.newKeys.length === 0 ||
    !Number.isInteger(doc.signedByOldKeyIndex)
  ) {
    return false;
  }
  const signer = currentRoots[doc.signedByOldKeyIndex];
  if (!signer) return false;
  try {
    const key = createPublicKey(signer);
    return edVerify(null, rotationDocBytes(doc), key, Buffer.from(doc.sig, 'base64'));
  } catch {
    return false;
  }
}

/**
 * Apply rotation docs in order: each must verify against the roots as they
 * stand AT THAT POINT in the chain (doc N is signed by a key from doc N-1's
 * set), and on success the new set REPLACES the old. An unverifiable doc
 * aborts the whole chain — never silently skip a link, because the next doc
 * would then verify against the wrong generation.
 */
export function applyRotations(
  pinnedRoots: readonly string[],
  docs: readonly RotationDoc[],
): string[] {
  let roots = [...pinnedRoots];
  for (const [i, doc] of docs.entries()) {
    if (!verifyRotationDoc(roots, doc)) {
      throw new Error(
        `key-rotation doc #${i} does not verify against the current trust roots; ` +
          'refusing to extend trust. The rotation chain must be continuous from the ' +
          'pinned roots — a broken link means tampering or a corrupted rotation feed.',
      );
    }
    roots = [...doc.newKeys];
  }
  return roots;
}

/** Parse signature.json. Loud schema-version error; tolerant of extra fields (item 49). */
export function parseSignatureArtifact(json: string): SignatureArtifact {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    throw new Error(
      `signature artifact is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('signature artifact must be a JSON object');
  }
  const m = raw as Record<string, unknown>;
  if (m.schemaVersion === undefined) {
    throw new Error('signature artifact is missing "schemaVersion"; refusing to guess its format');
  }
  if (
    typeof m.schemaVersion !== 'number' ||
    !Number.isInteger(m.schemaVersion) ||
    m.schemaVersion < 1
  ) {
    throw new Error(
      `signature artifact has invalid schemaVersion ${JSON.stringify(m.schemaVersion)}`,
    );
  }
  const p = m.payload as Record<string, unknown> | undefined;
  if (
    !p ||
    typeof p !== 'object' ||
    typeof p.commit !== 'string' ||
    typeof p.metadataHash !== 'string' ||
    p.imageDigests === null ||
    typeof p.imageDigests !== 'object'
  ) {
    throw new Error(
      'signature artifact payload needs { commit, imageDigests, provenance, metadataHash }',
    );
  }
  if (typeof m.sig !== 'string' || m.sig.length === 0) {
    throw new Error('signature artifact is missing "sig"');
  }
  return {
    schemaVersion: m.schemaVersion,
    payload: {
      commit: p.commit,
      imageDigests: p.imageDigests as Record<string, string>,
      provenance: typeof p.provenance === 'string' ? p.provenance : '',
      metadataHash: p.metadataHash,
    },
    sig: m.sig,
  };
}

/** Stable serialization of the signature artifact. */
export function serializeSignatureArtifact(a: SignatureArtifact): string {
  return JSON.stringify(sortKeysDeep(a as unknown as Record<string, unknown>), null, 2) + '\n';
}
