/**
 * The concrete RetentionFetcher: GitHub releases + the public image gallery
 * (IaC readiness plan, item 44).
 *
 * artifact-retention.ts owns the POLICY (what a complete artifact set is);
 * this file is only the plumbing behind its injected seam, plus the tiny CLI
 * release CI runs over the in-window tag list:
 *
 *     tsx scripts/lib/release/retention-fetcher.ts --tags v1.0.0,rc/v1.1.0
 *
 * Every method REPORTS, never gates: `null` means "this asset is gone", and
 * verifyRetention turns that into a named problem so CI prints the FULL damage
 * at once. That is deliberately the opposite of ShimFetcher
 * (scripts/update/shim.ts), whose same-named methods gate an install and
 * therefore throw. A transport failure is neither — a 503 is not a pruned
 * artifact — so unexpected statuses throw and the CLI exits on them rather
 * than reporting a false prune that would look like permanent damage.
 *
 * The asset URLs are the ones an ADOPTER'S SHIM actually fetches (the
 * releases/download/<tag>/<asset> form of scripts/update.ts), not the prettier
 * API equivalents: retention has to prove the exact URL an old install will
 * hit still resolves.
 *
 * `fetchImpl` is injected so the tests run with no network at all.
 */

import { fileURLToPath } from 'node:url';
import { RELEASE_REPO } from '../../update/shim.js';
import { verifyRetention, type RetentionFetcher } from './artifact-retention.js';

/** The one seam: global fetch in production, a fake in tests. */
export type FetchLike = typeof fetch;

// Asset names are restated rather than imported from scripts/update.ts: that
// module is a CLI entry, and importing it to borrow four string literals would
// drag its argv sniffing and node:fs adapters into every retention run.
const ASSET_METADATA = 'metadata.json';
const ASSET_ARTIFACT_MANIFEST = 'artifact-manifest.json';
const ASSET_SIGNATURE = 'signature.json';
const ASSET_PROMOTION_ATTESTATION = 'promotion-attestation.json';

/** Published verification material, on the release repo's default branch. */
const PUBLIC_KEY_PATH = 'release-keys/release-signing-ed25519.pub.pem';
const ROTATION_DOCS_PATH = 'release-keys/rotations.json';

/** Manifest media types a v2 registry has to be told we accept. */
const MANIFEST_ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

/** rc tags contain a slash (rc/v1.2.3), so the tag is URL-encoded here. */
function assetUrl(tag: string, asset: string): string {
  return `https://github.com/${RELEASE_REPO}/releases/download/${encodeURIComponent(tag)}/${asset}`;
}

/** HEAD, not a branch name: the default branch is `development`, not `main`. */
function rawUrl(path: string): string {
  return `https://raw.githubusercontent.com/${RELEASE_REPO}/HEAD/${path}`;
}

/**
 * Lifts the 60-request/hour anonymous cap in CI; absent locally is fine.
 * Both spellings: Actions exposes the token as an env var only if the workflow
 * exports one, and the release workflow's retention step exports GH_TOKEN.
 */
function githubAuth(): Record<string, string> {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  return token ? { authorization: `Bearer ${token}` } : {};
}

/** Turn a registry's 401 Bearer challenge into an anonymous pull token. */
async function anonymousPullToken(
  fetchImpl: FetchLike,
  challenge: string | null,
  repoName: string,
): Promise<string | null> {
  const realm = challenge ? /realm="([^"]+)"/.exec(challenge)?.[1] : undefined;
  if (!realm) return null;
  const service = (challenge && /service="([^"]+)"/.exec(challenge)?.[1]) ?? '';
  const scope = encodeURIComponent(`repository:${repoName}:pull`);
  const res = await fetchImpl(`${realm}?service=${encodeURIComponent(service)}&scope=${scope}`);
  if (!res.ok) return null;
  const body = (await res.json()) as { token?: string };
  return body.token ?? null;
}

/**
 * The real fetcher release CI wires into verifyRetention. Pass `fetchImpl`
 * to test it; production takes the default (global fetch).
 */
export function createReleaseRetentionFetcher(fetchImpl: FetchLike = fetch): RetentionFetcher {
  /** 200 -> body, 404 -> null (gone), anything else -> throw (broken check). */
  async function asset(tag: string, name: string): Promise<string | null> {
    const url = assetUrl(tag, name);
    const res = await fetchImpl(url, { redirect: 'follow', headers: githubAuth() });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`retention check ${url} failed: HTTP ${res.status}`);
    return res.text();
  }

  return {
    tagExists: async (tag) => {
      // NOT encodeURIComponent'd: the ref of rc/v1.2.3 IS refs/tags/rc/v1.2.3,
      // so that slash is a real path separator in this API.
      const res = await fetchImpl(
        `https://api.github.com/repos/${RELEASE_REPO}/git/ref/tags/${tag}`,
        { headers: { accept: 'application/vnd.github+json', ...githubAuth() } },
      );
      return res.ok;
    },

    fetchMetadata: (tag) => asset(tag, ASSET_METADATA),
    fetchArtifactManifest: (tag) => asset(tag, ASSET_ARTIFACT_MANIFEST),
    fetchSignature: (tag) => asset(tag, ASSET_SIGNATURE),
    fetchPromotionAttestation: (tag) => asset(tag, ASSET_PROMOTION_ATTESTATION),

    imageAvailable: async (publicRepo, digest) => {
      // An internal release publishes no public image at all (its metadata
      // carries publicRepo: ''), so there is nothing to check. A NON-empty
      // repo always gets a real registry lookup — never a shrug.
      if (publicRepo.trim() === '') return true;
      const slash = publicRepo.indexOf('/');
      if (slash === -1) {
        throw new Error(`publicRepo "${publicRepo}" has no registry host; cannot check ${digest}`);
      }
      const name = publicRepo.slice(slash + 1);
      const url = `https://${publicRepo.slice(0, slash)}/v2/${name}/manifests/${digest}`;
      const headers: Record<string, string> = { accept: MANIFEST_ACCEPT };
      let res = await fetchImpl(url, { method: 'HEAD', headers });
      if (res.status === 401) {
        // Anonymous pull: public.ecr.aws (like every v2 registry) answers the
        // first request with a Bearer challenge and expects token-then-retry.
        const token = await anonymousPullToken(
          fetchImpl,
          res.headers.get('www-authenticate'),
          name,
        );
        if (!token) return false;
        res = await fetchImpl(url, {
          method: 'HEAD',
          headers: { ...headers, authorization: `Bearer ${token}` },
        });
      }
      return res.ok;
    },

    verificationKeysAvailable: async () => {
      const key = await fetchImpl(rawUrl(PUBLIC_KEY_PATH), { redirect: 'follow' });
      if (!key.ok) return false;
      // The rotation chain must stay REACHABLE. A 404 is not damage: it is
      // exactly how "no key has ever rotated" looks, and scripts/update.ts
      // reads that same 404 as an empty chain — hard-failing on it would fail
      // every release until the day of the first rotation. Any OTHER failure
      // is an unreachable chain, which strands every old shim that re-fetches
      // it, so it is reported.
      const rotations = await fetchImpl(rawUrl(ROTATION_DOCS_PATH), { redirect: 'follow' });
      return rotations.ok || rotations.status === 404;
    },
  };
}

async function main(argv: string[]): Promise<void> {
  const at = argv.indexOf('--tags');
  const tags = (at === -1 ? '' : (argv[at + 1] ?? ''))
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  if (tags.length === 0) {
    console.error('usage: tsx scripts/lib/release/retention-fetcher.ts --tags v1.0.0,rc/v1.1.0');
    process.exit(2);
  }
  const { ok, reports } = await verifyRetention(createReleaseRetentionFetcher(), tags);
  for (const r of reports) {
    console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.tag}`);
    for (const p of r.problems) console.log(`       ${p}`);
  }
  if (!ok) {
    console.error(`\nretention FAILED: ${reports.filter((r) => !r.ok).length}/${reports.length} releases`);
    process.exit(1);
  }
}

// Guard: never fire the CLI from a test import (scripts/update.ts, same shape).
const invokedDirectly =
  process.argv[1] === fileURLToPath(import.meta.url) ||
  (process.argv[1]?.endsWith('retention-fetcher.ts') ?? false);
if (invokedDirectly) {
  void main(process.argv.slice(2)).catch((err: unknown) => {
    console.error(`retention check errored: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
