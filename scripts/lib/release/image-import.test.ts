import { describe, expect, it } from 'vitest';
import {
  importReleaseImage,
  importTagForDigest,
  type RegistryCopyRunner,
} from './image-import.js';

const DIGEST = `sha256:${'a'.repeat(64)}`;
const OTHER_DIGEST = `sha256:${'b'.repeat(64)}`;
const PUBLIC_REPO = 'public.ecr.aws/claudeclaw/orchestrator';
const PRIVATE_REPO = '111111111111.dkr.ecr.us-east-1.amazonaws.com/claudeclaw-orchestrator';

interface FakeRunner extends RegistryCopyRunner {
  calls: Array<{ op: string; args: string[] }>;
}

function fakeRunner(reportedDigest: string): FakeRunner {
  const calls: FakeRunner['calls'] = [];
  return {
    calls,
    copy: async (src, dst) => {
      calls.push({ op: 'copy', args: [src, dst] });
    },
    digest: async (ref) => {
      calls.push({ op: 'digest', args: [ref] });
      return reportedDigest;
    },
  };
}

describe('importReleaseImage', () => {
  it('copies registry-natively, verifies the private digest, returns it', async () => {
    const runner = fakeRunner(DIGEST);
    const verified = await importReleaseImage({
      craneRunner: runner,
      expectedDigest: DIGEST,
      publicRef: `${PUBLIC_REPO}@${DIGEST}`,
      privateRepo: PRIVATE_REPO,
    });
    expect(verified).toBe(DIGEST);
    expect(runner.calls.map((c) => c.op)).toEqual(['copy', 'digest']);
    // Source is the digest-addressed public ref; destination is private.
    expect(runner.calls[0].args[0]).toBe(`${PUBLIC_REPO}@${DIGEST}`);
    expect(runner.calls[0].args[1]).toBe(`${PRIVATE_REPO}:${importTagForDigest(DIGEST)}`);
    // The verification digest is read from the PRIVATE ref after the copy.
    expect(runner.calls[1].args[0]).toBe(runner.calls[0].args[1]);
  });

  it('HARD FAILS when the post-copy private digest differs from the signed digest', async () => {
    const runner = fakeRunner(OTHER_DIGEST);
    await expect(
      importReleaseImage({
        craneRunner: runner,
        expectedDigest: DIGEST,
        publicRef: `${PUBLIC_REPO}@${DIGEST}`,
        privateRepo: PRIVATE_REPO,
      }),
    ).rejects.toThrow(/FAILED verification.*not.*manifest-preserving|FAILED verification/s);
    // The copy DID happen (that's what gets detected), but nothing returned.
    expect(runner.calls.map((c) => c.op)).toEqual(['copy', 'digest']);
  });

  it('refuses a tag-addressed public ref BEFORE copying (no digest pin = no trust)', async () => {
    const runner = fakeRunner(DIGEST);
    await expect(
      importReleaseImage({
        craneRunner: runner,
        expectedDigest: DIGEST,
        publicRef: `${PUBLIC_REPO}:v1.0.0`,
        privateRepo: PRIVATE_REPO,
      }),
    ).rejects.toThrow(/not digest-addressed/);
    expect(runner.calls).toEqual([]);
  });

  it('refuses a public ref pinning a DIFFERENT digest than the signed one', async () => {
    const runner = fakeRunner(DIGEST);
    await expect(
      importReleaseImage({
        craneRunner: runner,
        expectedDigest: DIGEST,
        publicRef: `${PUBLIC_REPO}@${OTHER_DIGEST}`,
        privateRepo: PRIVATE_REPO,
      }),
    ).rejects.toThrow(/signature does not cover/);
    expect(runner.calls).toEqual([]);
  });

  it('refuses a malformed expected digest', async () => {
    const runner = fakeRunner(DIGEST);
    await expect(
      importReleaseImage({
        craneRunner: runner,
        expectedDigest: 'latest',
        publicRef: `${PUBLIC_REPO}@${DIGEST}`,
        privateRepo: PRIVATE_REPO,
      }),
    ).rejects.toThrow(/not a sha256 digest/);
    expect(runner.calls).toEqual([]);
  });
});
