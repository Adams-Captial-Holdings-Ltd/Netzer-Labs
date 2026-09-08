/**
 * The forgery corpus: releases the updater MUST refuse.
 *
 * Every case is signed with a throwaway ed25519 key that IS the pinned trust
 * root, so nothing here fails merely because the crypto is wrong. Each attack
 * carries a WITNESS assertion proving the forgery is otherwise perfect — that
 * the only reason to refuse is the control being tested. No network, no AWS.
 *
 * Two cases (03 and 05) are REGRESSION PINS: green on origin/development by
 * design. They are here so a future "simplification" of signing.ts:166-184 or
 * shim.ts's digest cross-check cannot pass unnoticed. Do not delete them for
 * being green.
 */
import { createPrivateKey, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { assembleRelease } from '../release/build-release.js';
import {
  canonicalPayloadBytes,
  createRotationDoc,
  signReleasePayload,
  verifyAgainstRoots,
  type RotationDoc,
} from '../lib/release/signing.js';
import {
  createPromotionAttestation,
  serializePromotionAttestation,
} from '../lib/release/promotion.js';
import { immutableMetadataHash, type ReleaseMetadata } from '../lib/release/metadata.js';
import {
  runShim,
  verifyReleaseArtifacts,
  type ShimFetcher,
  type ShimFs,
  type ShimGit,
  type ShimOptions,
  type ShimProc,
} from './shim.js';

const COMMIT = 'c'.repeat(40);
const PLATFORM = 'linux/arm64';
const DIGEST = `sha256:${'d'.repeat(64)}`;

function keypair(): { priv: string; pub: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    priv: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    pub: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

/** A genuine, self-consistent release for `tag`, signed by `priv`. */
function release(priv: string, pub: string, tag: string): Record<string, string> {
  return assembleRelease({
    tag,
    commit: COMMIT,
    privKeyPem: priv,
    verifyRoots: [pub],
    images: [{ platform: PLATFORM, digest: DIGEST, publicRepo: 'public.ecr.aws/cc/orch' }],
    provenance: 'forgery-corpus',
    minNode: '20.0.0',
  }).files;
}

/** A genuinely SIGNED promotion attestation (assembleRelease emits a skeleton). */
function attestation(
  priv: string,
  finalTag: string,
  rcTag: string,
  over: { commit?: string; imageDigests?: Record<string, string> } = {},
): string {
  return serializePromotionAttestation(
    createPromotionAttestation(priv, {
      finalTag,
      rcTag,
      commit: over.commit ?? COMMIT,
      imageDigests: over.imageDigests ?? { [PLATFORM]: DIGEST },
    }),
  );
}

interface Parts {
  files: Record<string, string>;
  /** undefined models "the asset is not published": the real fetcher throws. */
  attestationJson?: string;
  rotations?: RotationDoc[];
  installedTag?: string;
}

function harness(parts: Parts): {
  calls: string[];
  fetcher: ShimFetcher;
  git: ShimGit;
  proc: ShimProc;
  fs: ShimFs;
} {
  const calls: string[] = [];
  return {
    calls,
    fetcher: {
      fetchMetadata: async () => {
        calls.push('fetchMetadata');
        return parts.files['metadata.json'];
      },
      fetchArtifactManifest: async () => {
        calls.push('fetchArtifactManifest');
        return parts.files['artifact-manifest.json'];
      },
      fetchSignature: async () => {
        calls.push('fetchSignature');
        return parts.files['signature.json'];
      },
      fetchPromotionAttestation: async () => {
        calls.push('fetchPromotionAttestation');
        if (parts.attestationJson === undefined) {
          // Mirrors scripts/update.ts's fetchText, which throws on !res.ok.
          throw new Error('fetch attestation failed: HTTP 404 Not Found');
        }
        return parts.attestationJson;
      },
      fetchRotationDocs: async () => parts.rotations ?? [],
    },
    git: {
      isClean: async () => true,
      exactTag: async () => parts.installedTag ?? 'v1.0.0',
      worktreeAdd: async () => {
        calls.push('worktreeAdd');
      },
      checkoutPrimary: async () => {
        calls.push('checkoutPrimary');
      },
    },
    proc: {
      npmCi: async () => {
        calls.push('npmCi');
        return 0;
      },
      execRunner: async () => {
        calls.push('execRunner');
        return 0;
      },
    },
    fs: { mkdirp: () => {}, writeFile: () => {} },
  };
}

function opts(
  h: ReturnType<typeof harness>,
  pub: string,
  overrides: Partial<ShimOptions> = {},
): ShimOptions {
  return {
    targetTag: 'v1.1.0',
    fetcher: h.fetcher,
    git: h.git,
    proc: h.proc,
    fs: h.fs,
    trustRoots: [pub],
    nodeVersion: '22.1.0',
    npmVersion: '10.5.0',
    primaryDir: '/install/cce',
    ...overrides,
  };
}

/** Nothing destructive may have run. */
function nothingExecuted(calls: string[]): void {
  expect(calls).not.toContain('worktreeAdd');
  expect(calls).not.toContain('npmCi');
  expect(calls).not.toContain('execRunner');
  expect(calls).not.toContain('checkoutPrimary');
}

// ─────────────────────────────────────────────────────────────────────
describe('forgery 01 — an rc signature presented as a final tag', () => {
  it('refuses rc bytes re-tagged as a final release, though the signature verifies', async () => {
    const { priv, pub } = keypair();
    const files = release(priv, pub, 'rc/v1.1.0');
    const meta = JSON.parse(files['metadata.json']) as ReleaseMetadata;
    meta.tag = 'v1.1.0'; // the ONLY mutation
    const metadataJson = JSON.stringify(meta);

    // WITNESS: the forgery is cryptographically perfect at the signature layer.
    // Every cross-check in verifyReleaseArtifacts passes, so the refusal below
    // can only come from the promotion gate.
    expect(() =>
      verifyReleaseArtifacts({
        metadataJson,
        artifactManifestJson: files['artifact-manifest.json'],
        signatureJson: files['signature.json'],
        rotationDocs: [],
        pinnedRoots: [pub],
      }),
    ).not.toThrow();

    const h = harness({ files: { ...files, 'metadata.json': metadataJson } });
    // No attestation asset exists for an rc that was never promoted. The
    // message originates in the fetcher by design, so assert only the refusal.
    await expect(runShim(opts(h, pub))).rejects.toThrow();
    nothingExecuted(h.calls);
  });

  it('refuses an attestation signed by a key outside the trust roots', async () => {
    const { priv, pub } = keypair();
    const stranger = keypair();
    const files = release(priv, pub, 'v1.1.0');
    const h = harness({
      files,
      attestationJson: attestation(stranger.priv, 'v1.1.0', 'rc/v1.1.0'),
    });
    await expect(runShim(opts(h, pub))).rejects.toThrow(/promotion attestation/);
    nothingExecuted(h.calls);
  });

  it('refuses a real attestation for a DIFFERENT tag replayed onto this one', async () => {
    const { priv, pub } = keypair();
    const files = release(priv, pub, 'v1.1.0');
    const h = harness({
      files,
      attestationJson: attestation(priv, 'v1.2.0', 'rc/v1.2.0'),
    });
    await expect(runShim(opts(h, pub))).rejects.toThrow(/finalTag/);
    nothingExecuted(h.calls);
  });

  it('accepts the promoted artifact, so the gate is not simply refusing everything', async () => {
    const { priv, pub } = keypair();
    const files = release(priv, pub, 'v1.1.0');
    const h = harness({ files, attestationJson: attestation(priv, 'v1.1.0', 'rc/v1.1.0') });
    await expect(runShim(opts(h, pub))).resolves.toBeDefined();
    expect(h.calls).toContain('checkoutPrimary');
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('forgery 02 — a replayed older release', () => {
  it('refuses a genuine older release before a single byte is fetched', async () => {
    const { priv, pub } = keypair();
    // Nothing is forged: a perfectly signed, perfectly attested v1.0.0.
    const files = release(priv, pub, 'v1.0.0');
    const h = harness({
      files,
      attestationJson: attestation(priv, 'v1.0.0', 'rc/v1.0.0'),
      installedTag: 'v1.1.0',
    });
    await expect(runShim(opts(h, pub, { targetTag: 'v1.0.0' }))).rejects.toThrow(
      /OLDER than the installed release/,
    );
    expect(h.calls).not.toContain('fetchMetadata');
    nothingExecuted(h.calls);
  });

  // These four stop the replay gate from being a blunt instrument.
  it('still allows a forward final release', async () => {
    const { priv, pub } = keypair();
    const files = release(priv, pub, 'v1.2.0');
    const h = harness({
      files,
      attestationJson: attestation(priv, 'v1.2.0', 'rc/v1.2.0'),
      installedTag: 'v1.1.0',
    });
    await expect(runShim(opts(h, pub, { targetTag: 'v1.2.0' }))).resolves.toBeDefined();
  });

  it('still allows a forward RELEASE CANDIDATE — the upgrade canary', async () => {
    const { priv, pub } = keypair();
    const files = release(priv, pub, 'rc/v1.2.0');
    const h = harness({ files, installedTag: 'v1.1.0' });
    // compareVersions maps a non-numeric segment to 0, so an implementation
    // that forgets to strip `rc/` reads this as [0,2,0] < [1,1,0] and refuses
    // every forward release candidate.
    await expect(runShim(opts(h, pub, { targetTag: 'rc/v1.2.0' }))).resolves.toBeDefined();
  });

  it('allows re-installing the rc of the version already installed, and does not gate it', async () => {
    const { priv, pub } = keypair();
    const files = release(priv, pub, 'rc/v1.1.0');
    const h = harness({ files, installedTag: 'v1.1.0' });
    await expect(runShim(opts(h, pub, { targetTag: 'rc/v1.1.0' }))).resolves.toBeDefined();
    // rc tags carry no attestation, so the gate must not demand one.
    expect(h.calls).not.toContain('fetchPromotionAttestation');
  });

  it('refuses an older release candidate too', async () => {
    const { priv, pub } = keypair();
    const files = release(priv, pub, 'rc/v1.0.0');
    const h = harness({ files, installedTag: 'v1.1.0' });
    await expect(runShim(opts(h, pub, { targetTag: 'rc/v1.0.0' }))).rejects.toThrow(/OLDER/);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('forgery 03 — a swapped digest inside the signed payload', () => {
  // REGRESSION PIN: green on origin/development by design. It guards the
  // metadata/manifest cross-checks against a future "the signature already
  // covers this" simplification.
  it('refuses a swapped digest even when the payload is RE-SIGNED by a trusted key', () => {
    const { priv, pub } = keypair();
    const files = release(priv, pub, 'v1.1.0');
    const sig = JSON.parse(files['signature.json']) as {
      payload: { imageDigests: Record<string, string> };
      sig: string;
    };
    sig.payload.imageDigests[PLATFORM] = `sha256:${'9'.repeat(64)}`;
    sig.sig = signReleasePayload(priv, sig.payload as never);

    // WITNESS: the signature genuinely verifies, so the guard under test is
    // the metadata cross-check, not ed25519.
    expect(verifyAgainstRoots([pub], sig.payload as never, sig.sig)).toBe(true);

    expect(() =>
      verifyReleaseArtifacts({
        metadataJson: files['metadata.json'],
        artifactManifestJson: files['artifact-manifest.json'],
        signatureJson: JSON.stringify(sig),
        rotationDocs: [],
        pinnedRoots: [pub],
      }),
    ).toThrow(/not covered by the signature/);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('forgery 04 — a tag smuggled one level below CHANNEL_KEYS', () => {
  for (const key of ['tag', 'channel'] as const) {
    it(`refuses a nested "${key}" key that survives canonicalisation into the signed bytes`, () => {
      const { priv, pub } = keypair();
      const files = release(priv, pub, 'v1.1.0');
      const sig = JSON.parse(files['signature.json']) as {
        payload: { imageDigests: Record<string, string> };
        sig: string;
      };
      sig.payload.imageDigests[key] = 'v9.9.9';
      sig.sig = signReleasePayload(priv, sig.payload as never);

      // WITNESS: the smuggled key really does reach the signed bytes — this is
      // signature-covered content, not malleability.
      expect(canonicalPayloadBytes(sig.payload as never).toString('utf8')).toContain(
        `"${key}":"v9.9.9"`,
      );
      expect(verifyAgainstRoots([pub], sig.payload as never, sig.sig)).toBe(true);

      expect(() =>
        verifyReleaseArtifacts({
          metadataJson: files['metadata.json'],
          artifactManifestJson: files['artifact-manifest.json'],
          signatureJson: JSON.stringify(sig),
          rotationDocs: [],
          pinnedRoots: [pub],
        }),
      ).toThrow(new RegExp(`channel identity at payload\\.imageDigests\\.${key}`));
    });
  }
});

// ─────────────────────────────────────────────────────────────────────
describe('forgery 05 — a rotation signed only by the new key', () => {
  // REGRESSION PIN: green on origin/development by design. It guards
  // verifyRotationDoc's "signer must be a CURRENT root" rule end to end.
  it('refuses a rotation doc that vouches for itself', async () => {
    const oldK = keypair();
    const attacker = keypair();
    // Self-signed: the attacker's key is in newKeys but not in the pinned roots.
    const forged = createRotationDoc(attacker.priv, [attacker.pub], 0);
    const files = release(attacker.priv, attacker.pub, 'v1.1.0');
    const h = harness({
      files,
      attestationJson: attestation(attacker.priv, 'v1.1.0', 'rc/v1.1.0'),
      rotations: [forged],
    });
    await expect(runShim(opts(h, oldK.pub))).rejects.toThrow(/key-rotation doc/);
    nothingExecuted(h.calls);
  });

  it('after a VALID rotation, the attestation is checked against the NEW roots', async () => {
    const oldK = keypair();
    const newK = keypair();
    // Signed by the OLD key, as a real ceremony would be.
    const rotation = createRotationDoc(oldK.priv, [newK.pub], 0);
    const files = release(newK.priv, newK.pub, 'v1.1.0');
    const h = harness({
      files,
      attestationJson: attestation(newK.priv, 'v1.1.0', 'rc/v1.1.0'),
      rotations: [rotation],
    });
    // Passing the PINNED roots instead of the rotated ones to
    // verifyPromotionAttestation would fail here and nowhere else.
    await expect(runShim(opts(h, oldK.pub))).resolves.toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('golden vector — canonicalisation is byte-stable', () => {
  // A deterministic key from a fixed 32-byte seed, built through the standard
  // PKCS#8 ed25519 DER prefix. No PEM literal: scripts/ci/secret-scan.mjs:72
  // matches `-----BEGIN ... PRIVATE KEY-----`, and a fixture must not trip it.
  const SEEDED_PRIV = createPrivateKey({
    key: Buffer.concat([
      Buffer.from('302e020100300506032b657004220420', 'hex'),
      Buffer.alloc(32, 7),
    ]),
    format: 'der',
    type: 'pkcs8',
  })
    .export({ type: 'pkcs8', format: 'pem' })
    .toString();

  const PAYLOAD = {
    commit: 'c'.repeat(40),
    imageDigests: { 'linux/arm64': `sha256:${'d'.repeat(64)}` },
    provenance: 'golden-vector',
    metadataHash: 'e'.repeat(64),
  };

  it('pins the canonical bytes: sorted keys, no spaces, tag-free', () => {
    expect(canonicalPayloadBytes(PAYLOAD).toString('utf8')).toBe(
      `{"commit":"${'c'.repeat(40)}","imageDigests":{"linux/arm64":"sha256:${'d'.repeat(64)}"},` +
        `"metadataHash":"${'e'.repeat(64)}","provenance":"golden-vector"}`,
    );
  });

  it('pins the signature over those bytes (ed25519 is deterministic)', () => {
    expect(signReleasePayload(SEEDED_PRIV, PAYLOAD)).toBe(
      '+zkf9bOWxeSF/Cnas42n4n+5AoehSUU2hN2nzjPsewAQhmmpH4CtTke1WLCUtzXhAlIgTl1nt36x3fPh6RaSAg==',
    );
  });

  it('pins immutableMetadataHash against a literal metadata object', () => {
    // Written out inline rather than taken from assembleRelease: that would
    // track APP_SCHEMA_VERSION and turn this pin into a maintenance treadmill.
    const metadata = {
      schemaVersion: 1,
      tag: 'v1.0.0',
      commit: 'c'.repeat(40),
      appSchemaVersion: 1,
      bootstrapPrerequisites: { minNode: '20.0.0', minNpm: '10.0.0' },
      requiredActions: [],
      migrationFlags: { phases: [], maintenanceModePhases: [] },
      rollbackPosture: 'reversible',
      supportWindow: { directFrom: 'v0.9.0' },
      upgradingUrl: 'https://example.invalid/UPGRADING.md',
      images: [{ platform: 'linux/arm64', digest: `sha256:${'d'.repeat(64)}`, publicRepo: '' }],
      artifactManifestKey: 'artifact-manifest.json',
    } as unknown as ReleaseMetadata;

    // The tag is excluded, which is what lets rc and final share a signature.
    const withRcTag = { ...metadata, tag: 'rc/v1.0.0' } as ReleaseMetadata;
    expect(immutableMetadataHash(withRcTag)).toBe(immutableMetadataHash(metadata));

    expect(immutableMetadataHash(metadata)).toBe(
      '650fce2b477a6c6ed1f112a5d54e7fc212e2e9b077e337b8029729b4c1dca4c6',
    );
  });
});
