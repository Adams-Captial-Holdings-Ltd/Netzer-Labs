import { describe, expect, it } from 'vitest';
import { verifyRetention } from './artifact-retention.js';
import { createReleaseRetentionFetcher } from './retention-fetcher.js';

// URLs are hardcoded, not composed from RELEASE_REPO: retention exists to
// prove the EXACT url an old install will hit still resolves, so a change to
// the release repo or the path layout SHOULD break this file loudly.
const RELEASES = 'https://github.com/Adams-Captial-Holdings-Ltd/Netzer-Labs/releases/download';
const RAW = 'https://raw.githubusercontent.com/Adams-Captial-Holdings-Ltd/Netzer-Labs/HEAD';
const REFS = 'https://api.github.com/repos/Adams-Captial-Holdings-Ltd/Netzer-Labs/git/ref/tags';
const DIGEST = `sha256:${'a'.repeat(64)}`;
const REPO = 'public.ecr.aws/claudeclaw/orchestrator';
const MANIFEST = `https://public.ecr.aws/v2/claudeclaw/orchestrator/manifests/${DIGEST}`;
const TOKEN_URL =
  'https://public.ecr.aws/token/?service=public.ecr.aws&scope=repository%3Aclaudeclaw%2Forchestrator%3Apull';
const CHALLENGE = 'Bearer realm="https://public.ecr.aws/token/",service="public.ecr.aws"';

type Handler = (init?: RequestInit) => Response;
type Routes = Record<string, Handler>;

const text = (body: string): Handler => () => new Response(body, { status: 200 });
const code = (status: number): Handler => () => new Response('', { status });

/** A fetch that answers ONLY from `routes`; every other URL is a 404. */
function fakeFetch(routes: Routes): { fetchImpl: typeof fetch; seen: string[] } {
  const seen: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    seen.push(`${init?.method ?? 'GET'} ${url}`);
    return (routes[url] ?? code(404))(init);
  };
  return { fetchImpl, seen };
}

function metadataJson(tag: string, publicRepo = REPO): string {
  return JSON.stringify({
    schemaVersion: 1,
    tag,
    commit: 'c'.repeat(40),
    bootstrapPrerequisites: { minNode: '20.0.0', minNpm: '10.0.0' },
    images: [{ platform: 'linux/arm64', digest: DIGEST, publicRepo }],
  });
}

/** A complete, healthy upstream for one final release. */
function healthyRoutes(tag = 'v1.0.0'): Routes {
  const enc = encodeURIComponent(tag);
  return {
    [`${REFS}/${tag}`]: text('{"ref":"refs/tags/v1.0.0"}'),
    [`${RELEASES}/${enc}/metadata.json`]: text(metadataJson(tag)),
    [`${RELEASES}/${enc}/artifact-manifest.json`]: text('{}'),
    [`${RELEASES}/${enc}/signature.json`]: text('{}'),
    [`${RELEASES}/${enc}/promotion-attestation.json`]: text('{}'),
    [`${RAW}/release-keys/release-signing-ed25519.pub.pem`]: text('-----BEGIN PUBLIC KEY-----'),
    [`${RAW}/release-keys/rotations.json`]: text('[]'),
    [MANIFEST]: text(''),
  };
}

describe('createReleaseRetentionFetcher', () => {
  it('fetches each release asset from the exact URL an old shim uses', async () => {
    const { fetchImpl, seen } = fakeFetch(healthyRoutes('rc/v1.2.0'));
    const f = createReleaseRetentionFetcher(fetchImpl);

    expect(await f.fetchMetadata('rc/v1.2.0')).toContain('"schemaVersion":1');
    expect(await f.fetchArtifactManifest('rc/v1.2.0')).toBe('{}');
    expect(await f.fetchSignature('rc/v1.2.0')).toBe('{}');
    expect(await f.fetchPromotionAttestation('rc/v1.2.0')).toBe('{}');

    // The rc tag's slash is percent-encoded in a release-asset URL.
    expect(seen).toEqual([
      `GET ${RELEASES}/rc%2Fv1.2.0/metadata.json`,
      `GET ${RELEASES}/rc%2Fv1.2.0/artifact-manifest.json`,
      `GET ${RELEASES}/rc%2Fv1.2.0/signature.json`,
      `GET ${RELEASES}/rc%2Fv1.2.0/promotion-attestation.json`,
    ]);
  });

  it('returns null for a pruned asset but throws when the check itself is broken', async () => {
    const { fetchImpl } = fakeFetch({
      [`${RELEASES}/v1.0.0/signature.json`]: code(503),
    });
    const f = createReleaseRetentionFetcher(fetchImpl);

    // 404: the asset really is gone — report it, never throw.
    expect(await f.fetchMetadata('v1.0.0')).toBeNull();
    // 503: the CHECK is broken, which is not the same as permanent damage.
    await expect(f.fetchSignature('v1.0.0')).rejects.toThrow(/HTTP 503/);
  });

  it('checks the git tag by its full ref, slash and all', async () => {
    const { fetchImpl, seen } = fakeFetch({ [`${REFS}/rc/v1.2.0`]: text('{}') });
    const f = createReleaseRetentionFetcher(fetchImpl);

    expect(await f.tagExists('rc/v1.2.0')).toBe(true);
    expect(await f.tagExists('v9.9.9')).toBe(false);
    // refs/tags/rc/v1.2.0 — that slash is a real path separator, not encoded.
    expect(seen[0]).toBe(`GET ${REFS}/rc/v1.2.0`);
  });

  it('skips the image check only when publicRepo is empty', async () => {
    const { fetchImpl, seen } = fakeFetch({ [MANIFEST]: text('') });
    const f = createReleaseRetentionFetcher(fetchImpl);

    // Internal release: nothing was published, so there is nothing to check.
    expect(await f.imageAvailable('', DIGEST)).toBe(true);
    expect(seen).toEqual([]);

    // A non-empty repo always reaches the registry.
    expect(await f.imageAvailable(REPO, DIGEST)).toBe(true);
    expect(seen).toEqual([`HEAD ${MANIFEST}`]);

    // A pruned digest (404 from the registry) is reported as unavailable.
    expect(await f.imageAvailable(REPO, `sha256:${'b'.repeat(64)}`)).toBe(false);
  });

  it('answers a registry auth challenge with an anonymous token, then retries', async () => {
    const { fetchImpl, seen } = fakeFetch({
      [MANIFEST]: (init) => {
        const headers = init?.headers as Record<string, string> | undefined;
        return headers?.authorization
          ? new Response('', { status: 200 })
          : new Response('', { status: 401, headers: { 'www-authenticate': CHALLENGE } });
      },
      [TOKEN_URL]: text('{"token":"anon"}'),
    });
    const f = createReleaseRetentionFetcher(fetchImpl);

    expect(await f.imageAvailable(REPO, DIGEST)).toBe(true);
    expect(seen).toEqual([`HEAD ${MANIFEST}`, `GET ${TOKEN_URL}`, `HEAD ${MANIFEST}`]);
  });

  it('requires the published key and tolerates a never-created rotation chain', async () => {
    const key = `${RAW}/release-keys/release-signing-ed25519.pub.pem`;
    const rotations = `${RAW}/release-keys/rotations.json`;
    const keys = async (routes: Routes): Promise<boolean> =>
      createReleaseRetentionFetcher(fakeFetch(routes).fetchImpl).verificationKeysAvailable();

    expect(await keys({ [key]: text('pem'), [rotations]: text('[]') })).toBe(true);
    // A 404 chain is how "no key has ever rotated" looks; scripts/update.ts
    // reads the same 404 as an empty chain, so it is not retention damage.
    expect(await keys({ [key]: text('pem') })).toBe(true);
    // An unreachable chain strands every old shim that re-fetches it.
    expect(await keys({ [key]: text('pem'), [rotations]: code(500) })).toBe(false);
    // The key itself going away fails every release in the window.
    expect(await keys({ [rotations]: text('[]') })).toBe(false);
  });
});

describe('verifyRetention over the real fetcher', () => {
  it('passes when a release still has its complete artifact set', async () => {
    const { fetchImpl } = fakeFetch(healthyRoutes('v1.0.0'));
    const res = await verifyRetention(createReleaseRetentionFetcher(fetchImpl), ['v1.0.0']);
    expect(res.reports[0].problems).toEqual([]);
    expect(res.ok).toBe(true);
  });

  it('names every gap when the upstream release has been pruned', async () => {
    const routes = healthyRoutes('v1.0.0');
    delete routes[`${RELEASES}/v1.0.0/signature.json`]; // asset pruned
    delete routes[MANIFEST]; // image expired out of the gallery
    delete routes[`${REFS}/v1.0.0`]; // tag deleted

    const { fetchImpl } = fakeFetch(routes);
    const res = await verifyRetention(createReleaseRetentionFetcher(fetchImpl), ['v1.0.0']);

    expect(res.ok).toBe(false);
    const problems = res.reports[0].problems.join(' ');
    expect(problems).toMatch(/tag v1\.0\.0 no longer exists/);
    expect(problems).toMatch(/signature for v1\.0\.0 is no longer fetchable/);
    expect(problems).toMatch(/image linux\/arm64 .* no longer available/);
  });
});
