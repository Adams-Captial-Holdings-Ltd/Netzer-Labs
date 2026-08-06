import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createPromotionAttestation,
  parsePromotionAttestation,
  serializePromotionAttestation,
  verifyPromotionAttestation,
} from './promotion.js';

function keypair(): { priv: string; pub: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    priv: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    pub: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

const DIGESTS = { 'linux/arm64': `sha256:${'a'.repeat(64)}` };
const FIELDS = {
  finalTag: 'v1.4.0',
  rcTag: 'rc/v1.4.0',
  commit: 'c'.repeat(40),
  imageDigests: DIGESTS,
  canaryRunId: 'canary-118',
};

describe('promotion attestation', () => {
  it('creates, serializes, parses, and verifies', () => {
    const { priv, pub } = keypair();
    const att = createPromotionAttestation(priv, FIELDS);
    const parsed = parsePromotionAttestation(serializePromotionAttestation(att));
    const res = verifyPromotionAttestation([pub], parsed, {
      finalTag: FIELDS.finalTag,
      commit: FIELDS.commit,
      imageDigests: DIGESTS,
    });
    expect(res.problems).toEqual([]);
    expect(res.ok).toBe(true);
  });

  it('binds the FINAL tag: a different installed tag fails', () => {
    const { priv, pub } = keypair();
    const att = createPromotionAttestation(priv, FIELDS);
    const res = verifyPromotionAttestation([pub], att, {
      finalTag: 'v1.5.0',
      commit: FIELDS.commit,
      imageDigests: DIGESTS,
    });
    expect(res.ok).toBe(false);
    expect(res.problems.join(' ')).toMatch(/finalTag/);
  });

  it('binds the rc-tested commit and digests exactly', () => {
    const { priv, pub } = keypair();
    const att = createPromotionAttestation(priv, FIELDS);
    const wrongCommit = verifyPromotionAttestation([pub], att, {
      finalTag: FIELDS.finalTag,
      commit: 'd'.repeat(40),
      imageDigests: DIGESTS,
    });
    expect(wrongCommit.ok).toBe(false);

    const wrongDigest = verifyPromotionAttestation([pub], att, {
      finalTag: FIELDS.finalTag,
      commit: FIELDS.commit,
      imageDigests: { 'linux/arm64': `sha256:${'f'.repeat(64)}` },
    });
    expect(wrongDigest.ok).toBe(false);
    expect(wrongDigest.problems.join(' ')).toMatch(/digest/);
  });

  it('tampering with the signed fields breaks the signature', () => {
    const { priv, pub } = keypair();
    const att = createPromotionAttestation(priv, FIELDS);
    const tampered = { ...att, rcTag: 'rc/v9.9.9' };
    const res = verifyPromotionAttestation([pub], tampered, {
      finalTag: FIELDS.finalTag,
      commit: FIELDS.commit,
      imageDigests: DIGESTS,
    });
    expect(res.ok).toBe(false);
    expect(res.problems.join(' ')).toMatch(/signature/);
  });

  it('rejects untrusted signers', () => {
    const signer = keypair();
    const stranger = keypair();
    const att = createPromotionAttestation(signer.priv, FIELDS);
    const res = verifyPromotionAttestation([stranger.pub], att, {
      finalTag: FIELDS.finalTag,
      commit: FIELDS.commit,
      imageDigests: DIGESTS,
    });
    expect(res.ok).toBe(false);
  });

  it('parse fails loud on missing schemaVersion / fields', () => {
    expect(() => parsePromotionAttestation('{}')).toThrow(/schemaVersion/);
    expect(() =>
      parsePromotionAttestation(JSON.stringify({ schemaVersion: 1, finalTag: 'v1' })),
    ).toThrow(/required field/);
  });
});
