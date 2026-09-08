import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertPromotionTags, signPromotion, signPromotionMain } from './sign-promotion.js';
import {
  parsePromotionAttestation,
  verifyPromotionAttestation,
} from '../lib/release/promotion.js';
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
const DIGESTS = { 'linux/arm64': IMAGES[0].digest };
const COMMIT = 'c'.repeat(40);

describe('signPromotion', () => {
  it('signs a real rc -> final promotion that verifies against the signing key', () => {
    const { priv, pub } = keypair();
    const att = signPromotion({
      finalTag: 'v1.4.0',
      rcTag: 'rc/v1.4.0',
      commit: COMMIT,
      images: IMAGES,
      privKeyPem: priv,
      canaryRunId: 'canary-118',
    });

    expect(att.rcTag).toBe('rc/v1.4.0');
    expect(att.imageDigests).toEqual(DIGESTS);
    expect(att.canaryRunId).toBe('canary-118');
    // Verified with the keypair's OWN public key, not the one signPromotion
    // derived internally — proves the derivation produced the right key.
    const res = verifyPromotionAttestation([pub], att, {
      finalTag: 'v1.4.0',
      commit: COMMIT,
      imageDigests: DIGESTS,
    });
    expect(res.problems).toEqual([]);
    expect(res.ok).toBe(true);
  });

  it('omits canaryRunId when none is given', () => {
    const { priv } = keypair();
    const att = signPromotion({
      finalTag: 'v1.4.0',
      rcTag: 'rc/v1.4.0',
      commit: COMMIT,
      images: IMAGES,
      privKeyPem: priv,
    });
    expect(att.canaryRunId).toBeUndefined();
  });

  // The load-bearing refusals. rcTag is inside the signed bytes and
  // verifyPromotionAttestation never checks it, so these are the only place a
  // publisher's mis-promotion can be caught.
  it('REFUSES an rcTag that is not rc/<finalTag>', () => {
    const { priv } = keypair();
    expect(() =>
      signPromotion({
        finalTag: 'v1.4.0',
        rcTag: 'rc/v1.3.0',
        commit: COMMIT,
        images: IMAGES,
        privKeyPem: priv,
      }),
    ).toThrow(/does not name the rc for v1\.4\.0 \(expected rc\/v1\.4\.0\)/);
  });

  it('REFUSES self-promotion (rcTag === finalTag)', () => {
    const { priv } = keypair();
    expect(() =>
      signPromotion({
        finalTag: 'v1.4.0',
        rcTag: 'v1.4.0',
        commit: COMMIT,
        images: IMAGES,
        privKeyPem: priv,
      }),
    ).toThrow(/refusing to self-promote/);
  });

  it('REFUSES an rc-shaped finalTag', () => {
    const { priv } = keypair();
    expect(() =>
      signPromotion({
        finalTag: 'rc/v1.4.0',
        rcTag: 'rc/rc/v1.4.0',
        commit: COMMIT,
        images: IMAGES,
        privKeyPem: priv,
      }),
    ).toThrow(/is not a final release tag/);
  });

  it('REFUSES a final tag that is not v-prefixed', () => {
    expect(() => assertPromotionTags('1.4.0', 'rc/1.4.0')).toThrow(/is not a final release tag/);
  });
});

describe('signPromotionMain', () => {
  function fixture(): { dir: string; keyPath: string; imagesPath: string; pub: string } {
    const dir = mkdtempSync(join(tmpdir(), 'sign-promotion-'));
    const { priv, pub } = keypair();
    const keyPath = join(dir, 'priv.pem');
    const imagesPath = join(dir, 'images.json');
    writeFileSync(keyPath, priv);
    writeFileSync(imagesPath, JSON.stringify(IMAGES));
    return { dir, keyPath, imagesPath, pub };
  }

  it('writes a verifiable promotion-attestation.json under <out>/<finalTag>', async () => {
    const { dir, keyPath, imagesPath, pub } = fixture();
    const code = await signPromotionMain([
      '--final-tag',
      'v1.4.0',
      '--rc-tag',
      'rc/v1.4.0',
      '--commit',
      COMMIT,
      '--images',
      imagesPath,
      '--key',
      keyPath,
      '--canary-run-id',
      'canary-118',
      '--out',
      join(dir, 'dist'),
    ]);
    expect(code).toBe(0);

    const att = parsePromotionAttestation(
      readFileSync(join(dir, 'dist', 'v1.4.0', 'promotion-attestation.json'), 'utf8'),
    );
    const res = verifyPromotionAttestation([pub], att, {
      finalTag: 'v1.4.0',
      commit: COMMIT,
      imageDigests: DIGESTS,
    });
    expect(res.problems).toEqual([]);
    expect(att.rcTag).toBe('rc/v1.4.0');
    expect(att.canaryRunId).toBe('canary-118');
  });

  it('exits 2 when a required flag is missing', async () => {
    const { keyPath, imagesPath } = fixture();
    // --rc-tag omitted.
    const code = await signPromotionMain([
      '--final-tag',
      'v1.4.0',
      '--commit',
      COMMIT,
      '--images',
      imagesPath,
      '--key',
      keyPath,
    ]);
    expect(code).toBe(2);
  });

  it('exits 1 (not 2) when the promotion itself is refused', async () => {
    const { dir, keyPath, imagesPath } = fixture();
    const code = await signPromotionMain([
      '--final-tag',
      'v1.4.0',
      '--rc-tag',
      'rc/v1.3.0',
      '--commit',
      COMMIT,
      '--images',
      imagesPath,
      '--key',
      keyPath,
      '--out',
      join(dir, 'dist'),
    ]);
    expect(code).toBe(1);
  });
});
