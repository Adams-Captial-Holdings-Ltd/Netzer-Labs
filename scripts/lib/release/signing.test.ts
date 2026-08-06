import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  applyRotations,
  canonicalPayloadBytes,
  createRotationDoc,
  parseSignatureArtifact,
  signReleasePayload,
  verifyAgainstRoots,
  verifyReleasePayload,
  verifyRotationDoc,
  type ReleaseSignPayload,
} from './signing.js';

function keypair(): { priv: string; pub: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    priv: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    pub: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

const PAYLOAD: ReleaseSignPayload = {
  commit: 'a'.repeat(40),
  imageDigests: { 'linux/arm64': `sha256:${'b'.repeat(64)}` },
  provenance: 'ci-run-42',
  metadataHash: 'c'.repeat(64),
};

describe('signReleasePayload / verifyReleasePayload', () => {
  it('signs and verifies', () => {
    const { priv, pub } = keypair();
    const sig = signReleasePayload(priv, PAYLOAD);
    expect(verifyReleasePayload(pub, PAYLOAD, sig)).toBe(true);
  });

  it('rejects a tampered payload', () => {
    const { priv, pub } = keypair();
    const sig = signReleasePayload(priv, PAYLOAD);
    expect(
      verifyReleasePayload(pub, { ...PAYLOAD, commit: 'd'.repeat(40) }, sig),
    ).toBe(false);
  });

  it('rejects the wrong key and never throws on garbage', () => {
    const { priv } = keypair();
    const { pub: otherPub } = keypair();
    const sig = signReleasePayload(priv, PAYLOAD);
    expect(verifyReleasePayload(otherPub, PAYLOAD, sig)).toBe(false);
    expect(verifyReleasePayload('not a pem', PAYLOAD, sig)).toBe(false);
    expect(verifyReleasePayload(otherPub, PAYLOAD, '!!!not-base64-sig')).toBe(false);
  });
});

describe('canonicalPayloadBytes — channel exclusion by construction', () => {
  it('strips tag/channel keys, so rc and final promotion share ONE signature', () => {
    const { priv, pub } = keypair();
    // A buggy caller smuggles channel identity into the payload object:
    const rcPayload = { ...PAYLOAD, tag: 'rc/v1.0.0', channel: 'rc' } as ReleaseSignPayload;
    const finalPayload = { ...PAYLOAD, tag: 'v1.0.0', channel: 'final' } as ReleaseSignPayload;

    // The signed bytes are identical: the tag cannot reach them.
    expect(canonicalPayloadBytes(rcPayload).equals(canonicalPayloadBytes(finalPayload))).toBe(
      true,
    );

    // Therefore the rc signature verifies the final artifact unchanged —
    // promotion re-tags, it never re-signs.
    const rcSig = signReleasePayload(priv, rcPayload);
    expect(verifyReleasePayload(pub, finalPayload, rcSig)).toBe(true);
    expect(rcSig).toBe(signReleasePayload(priv, finalPayload));
  });

  it('is key-order independent (sorted-key JSON)', () => {
    const reordered = {
      metadataHash: PAYLOAD.metadataHash,
      provenance: PAYLOAD.provenance,
      imageDigests: PAYLOAD.imageDigests,
      commit: PAYLOAD.commit,
    } as ReleaseSignPayload;
    expect(canonicalPayloadBytes(reordered).equals(canonicalPayloadBytes(PAYLOAD))).toBe(true);
  });
});

describe('verifyAgainstRoots', () => {
  it('accepts any matching root; empty roots verify nothing', () => {
    const a = keypair();
    const b = keypair();
    const sig = signReleasePayload(b.priv, PAYLOAD);
    expect(verifyAgainstRoots([a.pub, b.pub], PAYLOAD, sig)).toBe(true);
    expect(verifyAgainstRoots([a.pub], PAYLOAD, sig)).toBe(false);
    expect(verifyAgainstRoots([], PAYLOAD, sig)).toBe(false);
  });
});

describe('key rotation', () => {
  it('a rotation doc signed by an old root verifies and replaces the set', () => {
    const oldKey = keypair();
    const newKey = keypair();
    const doc = createRotationDoc(oldKey.priv, [newKey.pub], 0);

    expect(verifyRotationDoc([oldKey.pub], doc)).toBe(true);
    const roots = applyRotations([oldKey.pub], [doc]);
    expect(roots).toEqual([newKey.pub]);

    // Releases signed by the NEW key now verify; the old key alone would not.
    const sig = signReleasePayload(newKey.priv, PAYLOAD);
    expect(verifyAgainstRoots(roots, PAYLOAD, sig)).toBe(true);
  });

  it('chains: doc N verifies against doc N-1 generation', () => {
    const g0 = keypair();
    const g1 = keypair();
    const g2 = keypair();
    const doc1 = createRotationDoc(g0.priv, [g1.pub], 0);
    const doc2 = createRotationDoc(g1.priv, [g2.pub], 0);
    expect(applyRotations([g0.pub], [doc1, doc2])).toEqual([g2.pub]);
  });

  it('a broken chain link ABORTS instead of being skipped', () => {
    const g0 = keypair();
    const g1 = keypair();
    const stranger = keypair();
    const forged = createRotationDoc(stranger.priv, [g1.pub], 0);
    expect(() => applyRotations([g0.pub], [forged])).toThrow(/does not verify/);
  });

  it('rejects malformed docs (bad index, empty newKeys)', () => {
    const g0 = keypair();
    const doc = createRotationDoc(g0.priv, [g0.pub], 0);
    expect(verifyRotationDoc([g0.pub], { ...doc, signedByOldKeyIndex: 7 })).toBe(false);
    expect(verifyRotationDoc([g0.pub], { ...doc, newKeys: [] })).toBe(false);
  });
});

describe('parseSignatureArtifact', () => {
  it('round-trips and fails loud on schema/shape problems', () => {
    const artifact = { schemaVersion: 1, payload: PAYLOAD, sig: 'abc' };
    const parsed = parseSignatureArtifact(JSON.stringify(artifact));
    expect(parsed.payload.commit).toBe(PAYLOAD.commit);

    expect(() => parseSignatureArtifact('{}')).toThrow(/schemaVersion/);
    expect(() =>
      parseSignatureArtifact(JSON.stringify({ schemaVersion: 1, payload: {}, sig: 'x' })),
    ).toThrow(/payload/);
    expect(() =>
      parseSignatureArtifact(JSON.stringify({ schemaVersion: 1, payload: PAYLOAD })),
    ).toThrow(/sig/);
  });

  it('tolerates extra fields (item 49: old shims, new artifacts)', () => {
    const artifact = { schemaVersion: 1, payload: PAYLOAD, sig: 'abc', futureField: true };
    expect(parseSignatureArtifact(JSON.stringify(artifact)).sig).toBe('abc');
  });
});
