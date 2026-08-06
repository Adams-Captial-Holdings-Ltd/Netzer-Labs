/**
 * `npm run update -- <tag>` — the one command for moving between releases
 * (IaC readiness plan, item 42). The orchestrator wires the npm script
 * (`"update": "tsx scripts/update.ts"`); this entry simply runs the UPDATER
 * SHIM (scripts/update/shim.ts) with real adapters.
 *
 * Everything that matters lives in the shim behind injected seams; this file
 * is only the wiring:
 *  - fetcher: GitHub releases assets composed from RELEASE_REPO;
 *  - git/proc/fs: child_process + node:fs adapters;
 *  - trust roots: the pinned scripts/update/trust-roots.ts.
 *
 * Multi-hop chains (item 49): when the target is more than one release
 * ahead, each hop re-enters through the NEWLY checked-out shim, so every
 * hop runs the shim that was canary-tested for it. This entry performs ONE
 * hop; the chain is `npm run update -- <next>` repeated, and the runner's
 * supportWindow check names the stepping-stone tag when a jump is too far.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { capture, run } from './lib/shell.js';
import { maybePrintHelp } from './lib/help.js';
import { runShim, RELEASE_REPO, type ShimFetcher, type ShimGit, type ShimProc } from './update/shim.js';
import { TRUST_ROOTS } from './update/trust-roots.js';
import type { RotationDoc } from './lib/release/signing.js';

const __filename = fileURLToPath(import.meta.url);
const primaryDir = dirname(dirname(__filename));

/** Release-asset names, the contract build-release.mjs publishes under. */
export const ASSET_METADATA = 'metadata.json';
export const ASSET_ARTIFACT_MANIFEST = 'artifact-manifest.json';
export const ASSET_SIGNATURE = 'signature.json';
/** Rotation chain lives at a stable raw URL on the default branch. */
export const ROTATION_DOCS_PATH = 'release-keys/rotations.json';

function assetUrl(tag: string, asset: string): string {
  // GitHub release-asset download URL; the tag is URL-encoded because rc
  // tags contain a slash (rc/v1.2.3).
  return `https://github.com/${RELEASE_REPO}/releases/download/${encodeURIComponent(tag)}/${asset}`;
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) {
    throw new Error(`fetch ${url} failed: HTTP ${res.status} ${res.statusText}`);
  }
  return res.text();
}

const fetcher: ShimFetcher = {
  fetchMetadata: (tag) => fetchText(assetUrl(tag, ASSET_METADATA)),
  fetchArtifactManifest: (tag) => fetchText(assetUrl(tag, ASSET_ARTIFACT_MANIFEST)),
  fetchSignature: (tag) => fetchText(assetUrl(tag, ASSET_SIGNATURE)),
  fetchRotationDocs: async (): Promise<RotationDoc[]> => {
    const url = `https://raw.githubusercontent.com/${RELEASE_REPO}/main/${ROTATION_DOCS_PATH}`;
    const res = await fetch(url, { redirect: 'follow' });
    if (res.status === 404) return []; // no key has ever rotated
    if (!res.ok) throw new Error(`fetch rotation docs failed: HTTP ${res.status}`);
    const parsed: unknown = JSON.parse(await res.text());
    return Array.isArray(parsed) ? (parsed as RotationDoc[]) : [];
  },
};

const git: ShimGit = {
  isClean: async () => {
    const res = await capture('git', ['-C', primaryDir, 'status', '--porcelain']);
    if (res.code !== 0) throw new Error(`git status failed: ${res.stderr}`);
    return res.stdout.trim() === '';
  },
  exactTag: async () => {
    const res = await capture('git', ['-C', primaryDir, 'describe', '--exact-match', '--tags']);
    return res.code === 0 ? res.stdout.trim() : null;
  },
  worktreeAdd: async (dir, tag) => {
    // Fetch the tag from upstream first so a fresh tag resolves.
    await capture('git', ['-C', primaryDir, 'fetch', '--tags', 'origin']);
    const res = await capture('git', ['-C', primaryDir, 'worktree', 'add', '--force', dir, tag]);
    if (res.code !== 0) throw new Error(`git worktree add failed: ${res.stderr}`);
  },
  checkoutPrimary: async (tag) => {
    const res = await capture('git', ['-C', primaryDir, 'checkout', tag]);
    if (res.code !== 0) throw new Error(`git checkout ${tag} failed: ${res.stderr}`);
  },
};

const proc: ShimProc = {
  npmCi: (cwd) => run('npm', ['ci'], { cwd }),
  // The TARGET's runner, executed inside the worktree with the worktree's
  // own deps (npx resolves the worktree's node_modules/tsx).
  execRunner: (cwd, args) =>
    run('npx', ['tsx', 'scripts/update/runner.ts', ...args], { cwd }),
};

async function main(): Promise<void> {
  if (
    maybePrintHelp(process.argv.slice(2), {
      command: 'npm run update -- <tag>',
      oneLiner: 'move this install to a release tag, one verified hop at a time',
      flags: [['<tag>', 'the release tag to move to (e.g. v1.4.0); repeat the command for multi-hop chains']],
      contract:
        'Checks out the target release via the pinned trust roots and RUNS DEPLOY for the hop; expect a full deploy per tag.',
      docs: 'docs/UPGRADING.md',
    })
  ) {
    return;
  }
  const targetTag = process.argv.slice(2).find((a) => !a.startsWith('-'));
  if (!targetTag) {
    console.error('usage: npm run update -- <tag>   (e.g. npm run update -- v1.4.0)');
    process.exit(2);
  }

  const npmVersionRes = await capture('npm', ['--version']);

  try {
    await runShim({
      targetTag,
      fetcher,
      git,
      proc,
      fs: {
        mkdirp: (dir) => mkdirSync(dir, { recursive: true }),
        writeFile: (path, content) => {
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, content);
        },
      },
      trustRoots: TRUST_ROOTS,
      nodeVersion: process.versions.node,
      npmVersion: npmVersionRes.code === 0 ? npmVersionRes.stdout.trim() : undefined,
      primaryDir,
      log: (line) => console.log(line),
    });
    console.log('update complete. Run `npm run verify` any time to re-check the deployment.');
  } catch (err) {
    console.error(`\nupdate aborted: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}

// Guard: never fire the CLI from a test import.
const invokedDirectly = (() => {
  const arg = process.argv[1];
  if (!arg) return false;
  try {
    return fileURLToPath(import.meta.url) === arg || arg.endsWith('/scripts/update.ts');
  } catch {
    return false;
  }
})();
if (invokedDirectly) void main();
