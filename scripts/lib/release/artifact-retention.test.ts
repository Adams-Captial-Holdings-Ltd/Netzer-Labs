import { describe, expect, it } from 'vitest';
import { isFinalReleaseTag, verifyRetention, type RetentionFetcher } from './artifact-retention.js';

const DIGEST = `sha256:${'a'.repeat(64)}`;
const REPO = 'public.ecr.aws/claudeclaw/orchestrator';

function metadataJson(tag: string): string {
  return JSON.stringify({
    schemaVersion: 1,
    tag,
    commit: 'c'.repeat(40),
    bootstrapPrerequisites: { minNode: '20.0.0', minNpm: '10.0.0' },
    images: [{ platform: 'linux/arm64', digest: DIGEST, publicRepo: REPO }],
  });
}

function healthyFetcher(overrides: Partial<RetentionFetcher> = {}): RetentionFetcher {
  return {
    tagExists: async () => true,
    fetchMetadata: async (tag) => metadataJson(tag),
    fetchArtifactManifest: async () => '{}',
    fetchSignature: async () => '{}',
    fetchPromotionAttestation: async () => '{}',
    imageAvailable: async () => true,
    verificationKeysAvailable: async () => true,
    ...overrides,
  };
}

describe('isFinalReleaseTag', () => {
  it('distinguishes finals from rcs', () => {
    expect(isFinalReleaseTag('v1.2.3')).toBe(true);
    expect(isFinalReleaseTag('rc/v1.2.3')).toBe(false);
  });
});

describe('verifyRetention', () => {
  it('passes when every in-window release keeps its full artifact set', async () => {
    const res = await verifyRetention(healthyFetcher(), ['v1.0.0', 'v1.1.0', 'rc/v1.2.0']);
    expect(res.ok).toBe(true);
    expect(res.reports.every((r) => r.ok)).toBe(true);
  });

  it('a pruned stepping-stone fails the run and names every problem', async () => {
    const fetcher = healthyFetcher({
      // v1.1.0 lost its metadata and one image — the classic pruned middle hop.
      fetchMetadata: async (tag) => (tag === 'v1.1.0' ? null : metadataJson(tag)),
      imageAvailable: async () => false,
    });
    const res = await verifyRetention(fetcher, ['v1.0.0', 'v1.1.0', 'v1.2.0']);
    expect(res.ok).toBe(false);
    const v110 = res.reports.find((r) => r.tag === 'v1.1.0');
    expect(v110?.ok).toBe(false);
    expect(v110?.problems.join(' ')).toMatch(/metadata.*no longer fetchable/);
    // Healthy releases with a missing image are ALSO reported (full damage at once).
    const v100 = res.reports.find((r) => r.tag === 'v1.0.0');
    expect(v100?.problems.join(' ')).toMatch(/image .* no longer available/);
  });

  it('requires a promotion attestation for finals but NOT for rcs', async () => {
    const fetcher = healthyFetcher({ fetchPromotionAttestation: async () => null });
    const res = await verifyRetention(fetcher, ['v1.0.0', 'rc/v1.1.0']);
    const final = res.reports.find((r) => r.tag === 'v1.0.0');
    const rc = res.reports.find((r) => r.tag === 'rc/v1.1.0');
    expect(final?.problems.join(' ')).toMatch(/promotion attestation/);
    expect(rc?.ok).toBe(true);
  });

  it('fails every release when the verification keys are gone', async () => {
    const fetcher = healthyFetcher({ verificationKeysAvailable: async () => false });
    const res = await verifyRetention(fetcher, ['v1.0.0']);
    expect(res.ok).toBe(false);
    expect(res.reports[0].problems.join(' ')).toMatch(/verification keys/);
  });

  it('reports a missing tag and unparseable metadata', async () => {
    const fetcher = healthyFetcher({
      tagExists: async () => false,
      fetchMetadata: async () => '{"schemaVersion": 1}', // missing core
    });
    const res = await verifyRetention(fetcher, ['v1.0.0']);
    const problems = res.reports[0].problems.join(' ');
    expect(problems).toMatch(/tag v1\.0\.0 no longer exists/);
    expect(problems).toMatch(/no longer parses/);
  });
});
