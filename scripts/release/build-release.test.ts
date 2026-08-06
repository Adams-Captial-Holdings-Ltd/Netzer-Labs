import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { assembleRelease } from './build-release.js';
import { parseSignatureArtifact } from '../lib/release/signing.js';
import type { ReleaseImage } from '../lib/release/metadata.js';

function keypair(): { priv: string; pub: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    priv: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    pub: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

const IMAGES: ReleaseImage[] = [
  {
    platform: 'linux/arm64',
    digest: `sha256:${'a'.repeat(64)}`,
    publicRepo: 'public.ecr.aws/claudeclaw/orchestrator',
  },
];

const BASE = {
  commit: 'c'.repeat(40),
  images: IMAGES,
  provenance: 'ci-run-1',
};

describe('assembleRelease', () => {
  it('emits the four artifacts and self-verifies through the shim path', () => {
    const { priv, pub } = keypair();
    const { files, metadata } = assembleRelease({
      ...BASE,
      tag: 'v1.0.0',
      privKeyPem: priv,
      verifyRoots: [pub],
    });
    expect(Object.keys(files).sort()).toEqual([
      'artifact-manifest.json',
      'metadata.json',
      'promotion-attestation.skeleton.json',
      'signature.json',
    ]);
    expect(metadata.tag).toBe('v1.0.0');
    // assembleRelease throwing on a bad sig is the self-validation; reaching
    // here means the shim's verify path accepted the artifacts.
  });

  it('rc and final share ONE signature: only the tag differs, the sig bytes do not', () => {
    const { priv, pub } = keypair();
    const rc = assembleRelease({ ...BASE, tag: 'rc/v1.0.0', privKeyPem: priv, verifyRoots: [pub] });
    const final = assembleRelease({ ...BASE, tag: 'v1.0.0', privKeyPem: priv, verifyRoots: [pub] });

    const rcSig = parseSignatureArtifact(rc.files['signature.json']);
    const finalSig = parseSignatureArtifact(final.files['signature.json']);
    expect(rcSig.sig).toBe(finalSig.sig);
    expect(rcSig.payload).toEqual(finalSig.payload);
    // The metadata DOES differ (the channel tag)…
    expect(rc.files['metadata.json']).not.toBe(final.files['metadata.json']);
    // …but the signed payload's metadataHash is identical (tag excluded).
    expect(rcSig.payload.metadataHash).toBe(finalSig.payload.metadataHash);
  });

  it('fails at build time when self-verification cannot succeed (wrong root)', () => {
    const signer = keypair();
    const stranger = keypair();
    expect(() =>
      assembleRelease({
        ...BASE,
        tag: 'v1.0.0',
        privKeyPem: signer.priv,
        verifyRoots: [stranger.pub],
      }),
    ).toThrow(/does not verify against any trusted signing key/);
  });

  it('the promotion skeleton carries the rc binding fields for publish time', () => {
    const { priv, pub } = keypair();
    const { files } = assembleRelease({
      ...BASE,
      tag: 'rc/v1.0.0',
      privKeyPem: priv,
      verifyRoots: [pub],
    });
    const skeleton = JSON.parse(files['promotion-attestation.skeleton.json']) as {
      rcTag: string;
      commit: string;
      imageDigests: Record<string, string>;
    };
    expect(skeleton.rcTag).toBe('rc/v1.0.0');
    expect(skeleton.commit).toBe(BASE.commit);
    expect(skeleton.imageDigests['linux/arm64']).toBe(IMAGES[0].digest);
  });
});
