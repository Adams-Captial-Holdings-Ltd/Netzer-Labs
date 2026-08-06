import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { assembleRelease } from '../release/build-release.js';
import {
  BUILD_LOCAL_GUIDANCE,
  compareVersions,
  runShim,
  tagDirSegment,
  verifyReleaseArtifacts,
  type ShimFetcher,
  type ShimFs,
  type ShimGit,
  type ShimOptions,
  type ShimProc,
} from './shim.js';

function keypair(): { priv: string; pub: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    priv: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    pub: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

const COMMIT = 'c'.repeat(40);
const DIGEST = `sha256:${'d'.repeat(64)}`;

function releaseFiles(priv: string, pub: string, tag = 'v1.1.0', minNode = '20.0.0') {
  return assembleRelease({
    tag,
    commit: COMMIT,
    privKeyPem: priv,
    verifyRoots: [pub],
    images: [{ platform: 'linux/arm64', digest: DIGEST, publicRepo: 'public.ecr.aws/cc/orch' }],
    provenance: 'test-build',
    minNode,
  }).files;
}

interface Recorded {
  calls: string[];
}

function fakes(opts: {
  files: Record<string, string>;
  clean?: boolean;
  installedTag?: string | null;
  npmCiCode?: number;
  runnerCode?: number;
  tamperSignature?: boolean;
}): Recorded & { fetcher: ShimFetcher; git: ShimGit; proc: ShimProc; fs: ShimFs } {
  const calls: string[] = [];
  const sigJson = opts.tamperSignature
    ? opts.files['signature.json'].replace(/"commit": "c+"/, `"commit": "${'e'.repeat(40)}"`)
    : opts.files['signature.json'];
  return {
    calls,
    fetcher: {
      fetchMetadata: async () => {
        calls.push('fetchMetadata');
        return opts.files['metadata.json'];
      },
      fetchArtifactManifest: async () => {
        calls.push('fetchArtifactManifest');
        return opts.files['artifact-manifest.json'];
      },
      fetchSignature: async () => {
        calls.push('fetchSignature');
        return sigJson;
      },
      fetchRotationDocs: async () => [],
    },
    git: {
      isClean: async () => {
        calls.push('isClean');
        return opts.clean ?? true;
      },
      exactTag: async () => {
        calls.push('exactTag');
        return opts.installedTag === undefined ? 'v1.0.0' : opts.installedTag;
      },
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
        return opts.npmCiCode ?? 0;
      },
      execRunner: async () => {
        calls.push('execRunner');
        return opts.runnerCode ?? 0;
      },
    },
    fs: {
      mkdirp: () => {},
      writeFile: () => {},
    },
  };
}

function shimOpts(
  f: ReturnType<typeof fakes>,
  pub: string,
  overrides: Partial<ShimOptions> = {},
): ShimOptions {
  return {
    targetTag: 'v1.1.0',
    fetcher: f.fetcher,
    git: f.git,
    proc: f.proc,
    fs: f.fs,
    trustRoots: [pub],
    nodeVersion: '22.1.0',
    npmVersion: '10.5.0',
    primaryDir: '/install/claudeclaw-enterprise',
    ...overrides,
  };
}

describe('compareVersions', () => {
  it('compares dotted versions numerically', () => {
    expect(compareVersions('20.11.1', '20.0.0')).toBeGreaterThan(0);
    expect(compareVersions('18.20.0', '20.0.0')).toBeLessThan(0);
    expect(compareVersions('v20.0', '20.0.0')).toBe(0);
  });
});

describe('tagDirSegment', () => {
  it('flattens rc tags for filesystem use', () => {
    expect(tagDirSegment('rc/v1.2.3')).toBe('rc-v1.2.3');
  });
});

describe('runShim — happy path', () => {
  it('verifies, gates, worktrees, runs, then advances the pointer — in that order', async () => {
    const { priv, pub } = keypair();
    const f = fakes({ files: releaseFiles(priv, pub) });
    const result = await runShim(shimOpts(f, pub));
    expect(result.metadata.commit).toBe(COMMIT);
    expect(result.worktreeDir).toBe(
      '/install/claudeclaw-enterprise/.cce-update/worktrees/v1.1.0',
    );
    expect(f.calls).toEqual([
      'isClean',
      'exactTag',
      'fetchMetadata',
      'fetchArtifactManifest',
      'fetchSignature',
      'worktreeAdd',
      'npmCi',
      'execRunner',
      'checkoutPrimary',
    ]);
  });
});

describe('runShim — abort points (order asserted on fakes)', () => {
  it('DIRTY TREE is refused before anything is fetched, with --build-local guidance', async () => {
    const { priv, pub } = keypair();
    const f = fakes({ files: releaseFiles(priv, pub), clean: false });
    await expect(runShim(shimOpts(f, pub))).rejects.toThrow(/local modifications/);
    await expect(runShim(shimOpts(f, pub))).rejects.toThrow(/--build-local/);
    expect(f.calls).not.toContain('fetchMetadata');
    expect(f.calls).not.toContain('worktreeAdd');
  });

  it('NOT exactly at a trusted upstream tag is refused (forked installs)', async () => {
    const { priv, pub } = keypair();
    for (const installedTag of [null, 'my-fork-tag']) {
      const f = fakes({ files: releaseFiles(priv, pub), installedTag });
      await expect(runShim(shimOpts(f, pub))).rejects.toThrow(/trusted upstream release tag/);
      expect(f.calls).not.toContain('fetchMetadata');
    }
  });

  it('SIGNATURE FAILURE aborts BEFORE any worktree exists', async () => {
    const { priv, pub } = keypair();
    const f = fakes({ files: releaseFiles(priv, pub), tamperSignature: true });
    await expect(runShim(shimOpts(f, pub))).rejects.toThrow(/verification FAILED/);
    expect(f.calls).not.toContain('worktreeAdd');
    expect(f.calls).not.toContain('npmCi');
    expect(f.calls).not.toContain('checkoutPrimary');
  });

  it('an UNTRUSTED signer aborts before any worktree exists', async () => {
    const signer = keypair();
    const pinned = keypair(); // trust roots pin a DIFFERENT key
    const f = fakes({ files: releaseFiles(signer.priv, signer.pub) });
    await expect(runShim(shimOpts(f, pinned.pub))).rejects.toThrow(
      /does not verify against any trusted signing key/,
    );
    expect(f.calls).not.toContain('worktreeAdd');
  });

  it('EMPTY trust roots refuse to update (pre-key-ceremony build)', async () => {
    const { priv, pub } = keypair();
    const f = fakes({ files: releaseFiles(priv, pub) });
    await expect(runShim(shimOpts(f, pub, { trustRoots: [] }))).rejects.toThrow(
      /no trust roots are pinned/,
    );
    expect(f.calls).not.toContain('worktreeAdd');
  });

  it('NODE TOO OLD aborts before npm ci, with a clean message', async () => {
    const { priv, pub } = keypair();
    const f = fakes({ files: releaseFiles(priv, pub, 'v1.1.0', '22.0.0') });
    await expect(runShim(shimOpts(f, pub, { nodeVersion: '20.11.1' }))).rejects.toThrow(
      /your Node is too old.*requires Node >= 22\.0\.0.*running 20\.11\.1/s,
    );
    expect(f.calls).not.toContain('npmCi');
    expect(f.calls).not.toContain('worktreeAdd');
    expect(f.calls).not.toContain('checkoutPrimary');
  });

  it('npm ci failure leaves the checkout pointer untouched', async () => {
    const { priv, pub } = keypair();
    const f = fakes({ files: releaseFiles(priv, pub), npmCiCode: 1 });
    await expect(runShim(shimOpts(f, pub))).rejects.toThrow(/npm ci failed/);
    expect(f.calls).toContain('worktreeAdd');
    expect(f.calls).not.toContain('execRunner');
    expect(f.calls).not.toContain('checkoutPrimary');
  });

  it('RUNNER FAILURE leaves the durable checkout untouched (order asserted)', async () => {
    const { priv, pub } = keypair();
    const f = fakes({ files: releaseFiles(priv, pub), runnerCode: 1 });
    await expect(runShim(shimOpts(f, pub))).rejects.toThrow(
      /update runner exited 1.*untouched/s,
    );
    // The runner DID run, inside the worktree, after npm ci...
    expect(f.calls.indexOf('execRunner')).toBeGreaterThan(f.calls.indexOf('npmCi'));
    // ...but the pointer advance NEVER happened.
    expect(f.calls).not.toContain('checkoutPrimary');
  });

  it('rejects non-release target tags before doing anything', async () => {
    const { priv, pub } = keypair();
    const f = fakes({ files: releaseFiles(priv, pub) });
    await expect(runShim(shimOpts(f, pub, { targetTag: 'main' }))).rejects.toThrow(
      /not a release tag/,
    );
    expect(f.calls).toEqual([]);
  });
});

describe('verifyReleaseArtifacts — cross-checks', () => {
  it('detects metadata modified after signing (metadataHash mismatch)', () => {
    const { priv, pub } = keypair();
    const files = releaseFiles(priv, pub);
    const meta = JSON.parse(files['metadata.json']) as Record<string, unknown>;
    meta.commit = 'f'.repeat(40); // mutate immutable content post-signing
    expect(() =>
      verifyReleaseArtifacts({
        metadataJson: JSON.stringify(meta),
        artifactManifestJson: files['artifact-manifest.json'],
        signatureJson: files['signature.json'],
        rotationDocs: [],
        pinnedRoots: [pub],
      }),
    ).toThrow(/metadataHash does not match/);
  });

  it('a RE-TAGGED metadata (rc -> final) still verifies: tag is outside the signature', () => {
    const { priv, pub } = keypair();
    const files = releaseFiles(priv, pub, 'rc/v1.1.0');
    const meta = JSON.parse(files['metadata.json']) as Record<string, unknown>;
    meta.tag = 'v1.1.0'; // promotion: ONLY the channel tag changes
    const { metadata } = verifyReleaseArtifacts({
      metadataJson: JSON.stringify(meta),
      artifactManifestJson: files['artifact-manifest.json'],
      signatureJson: files['signature.json'],
      rotationDocs: [],
      pinnedRoots: [pub],
    });
    expect(metadata.tag).toBe('v1.1.0');
  });

  it('detects an artifact manifest whose digests the signature does not cover', () => {
    const { priv, pub } = keypair();
    const files = releaseFiles(priv, pub);
    const manifest = JSON.parse(files['artifact-manifest.json']) as {
      images: Array<{ digest: string }>;
    };
    manifest.images[0].digest = `sha256:${'9'.repeat(64)}`;
    expect(() =>
      verifyReleaseArtifacts({
        metadataJson: files['metadata.json'],
        artifactManifestJson: JSON.stringify(manifest),
        signatureJson: files['signature.json'],
        rotationDocs: [],
        pinnedRoots: [pub],
      }),
    ).toThrow(/not covered by the signature/);
  });
});

describe('guidance text', () => {
  it('names the fork pipeline doc', () => {
    expect(BUILD_LOCAL_GUIDANCE).toContain('docs/release-pipeline.md');
    expect(BUILD_LOCAL_GUIDANCE).toContain('--build-local');
  });
});
