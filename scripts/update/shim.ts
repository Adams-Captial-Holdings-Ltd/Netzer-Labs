/**
 * THE UPDATER SHIM (IaC readiness plan, item 42).
 *
 * Deliberately SMALL and stable: this file ships in the FIRST public release
 * and must keep working for a year-old install updating to tomorrow's
 * release, so it depends only on the updater-critical formats item 49 pins
 * (release metadata, artifact manifest, signature artifact, rotation docs —
 * all schema-versioned, all parsed tolerantly).
 *
 * The rule is VERIFY-THEN-EXEC, never exec-then-trust. The running script is
 * OLD code; doctor/diff/migrations need TARGET-version logic, so the shim's
 * only job is to verify the target release and bootstrap into it:
 *
 *  (a) target tag from argv (scripts/update.ts is the entry);
 *  (b) REFUSE unless the primary worktree is clean and exactly at a trusted
 *      upstream tag — forked/dirty installs get --build-local guidance, an
 *      upstream image that doesn't match their code must never deploy;
 *  (c) fetch metadata + artifact manifest + signature via the injected
 *      fetcher (the real one composes GitHub releases URLs from RELEASE_REPO;
 *      the network stays behind the injection seam);
 *  (d) verify the signature against PINNED trust roots (trust-roots.ts),
 *      after applying any rotation docs verifiable by the old roots —
 *      failure aborts BEFORE any worktree exists;
 *  (e) check bootstrapPrerequisites (minNode/minNpm) BEFORE any target code
 *      executes, with a clean "your Node is too old" message;
 *  (f) `git worktree add` the target tag into .cce-update/worktrees/<tag>,
 *      `npm ci` there FROM THE TARGET'S LOCKFILE (old node_modules cannot
 *      run new code), then exec the TARGET's update runner inside the
 *      worktree, passing context;
 *  (g) only after the runner exits 0, atomically advance the primary
 *      checkout (`git -C <primary> checkout <tag>`). A failed update leaves
 *      the durable checkout untouched.
 *
 * All shell/git/fs operations are behind injected interfaces so unit tests
 * prove the ORDER of the abort points on fakes.
 */

import {
  immutableMetadataHash,
  parseArtifactManifest,
  parseReleaseMetadata,
  type ReleaseMetadata,
} from '../lib/release/metadata.js';
import {
  applyRotations,
  parseSignatureArtifact,
  verifyAgainstRoots,
  type RotationDoc,
} from '../lib/release/signing.js';

/** Upstream repo the real fetcher composes GitHub releases URLs from. */
export const RELEASE_REPO = 'emmanuelmadams4-lgtm/Netzer-Labs';

/** Managed directory for worktrees + verified artifacts, relative to primary. */
export const UPDATE_DIR = '.cce-update';

/** Release artifacts, behind one injected seam (real impl: GitHub releases). */
export interface ShimFetcher {
  fetchMetadata(tag: string): Promise<string>;
  fetchArtifactManifest(tag: string): Promise<string>;
  fetchSignature(tag: string): Promise<string>;
  /** The published rotation chain; empty when no key has ever rotated. */
  fetchRotationDocs(): Promise<RotationDoc[]>;
}

export interface ShimGit {
  /** True when the primary worktree has no uncommitted/untracked changes. */
  isClean(): Promise<boolean>;
  /** The tag HEAD sits EXACTLY on (git describe --exact-match), or null. */
  exactTag(): Promise<string | null>;
  /** `git worktree add <dir> <tag>` (fetching the tag first if needed). */
  worktreeAdd(dir: string, tag: string): Promise<void>;
  /** `git -C <primary> checkout <tag>` — the atomic pointer advance. */
  checkoutPrimary(tag: string): Promise<void>;
}

export interface ShimProc {
  /** `npm ci` in the TARGET worktree (the target's own lockfile). Exit code. */
  npmCi(cwd: string): Promise<number>;
  /**
   * Exec the TARGET's update runner inside the worktree (npx tsx
   * scripts/update/runner.ts, or node dist/ when the target ships builds).
   * Exit code.
   */
  execRunner(cwd: string, args: string[]): Promise<number>;
}

export interface ShimFs {
  mkdirp(dir: string): void;
  writeFile(path: string, content: string): void;
}

export interface ShimOptions {
  targetTag: string;
  fetcher: ShimFetcher;
  git: ShimGit;
  proc: ShimProc;
  fs: ShimFs;
  /** Pinned roots; defaults to trust-roots.ts in the real entry. */
  trustRoots: readonly string[];
  /** process.versions.node in production; injected for tests. */
  nodeVersion: string;
  /** `npm --version` output when available. */
  npmVersion?: string;
  /** Absolute path of the durable primary checkout. */
  primaryDir: string;
  log?: (line: string) => void;
}

export interface ShimResult {
  metadata: ReleaseMetadata;
  worktreeDir: string;
  warnings: string[];
}

/** Tags the shim accepts as INSTALLED state: upstream releases only. */
const TRUSTED_INSTALLED_TAG_RE = /^v\d/;

/** Tags the shim accepts as TARGETS: releases and release candidates. */
const TARGET_TAG_RE = /^(v|rc\/v)\d[A-Za-z0-9._-]*$/;

export const BUILD_LOCAL_GUIDANCE =
  'If this install is intentionally forked or locally modified, prebuilt upstream ' +
  'images do not match your code: use `npm run deploy -- --build-local` and the ' +
  'documented fork release pipeline (docs/release-pipeline.md) instead of `npm run update`.';

/**
 * Compare dotted numeric versions ("20.11.1" vs "20.9"). Returns <0, 0, >0.
 * Non-numeric suffixes are ignored (good enough for Node/npm versions).
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): number[] =>
    v
      .trim()
      .replace(/^v/, '')
      .split('.')
      .map((part) => Number.parseInt(part, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Filesystem-safe directory segment for a tag (rc/v1.2.3 -> rc-v1.2.3). */
export function tagDirSegment(tag: string): string {
  return tag.replace(/\//g, '-');
}

/**
 * Verify a release's artifacts against the trust roots. Pure (no fs/git);
 * the shim calls it before ANY worktree exists, and other consumers (update
 * discovery, the dogfooding buildspec) reuse the same path so there is
 * exactly one verification implementation.
 */
export function verifyReleaseArtifacts(input: {
  metadataJson: string;
  artifactManifestJson: string;
  signatureJson: string;
  rotationDocs: readonly RotationDoc[];
  pinnedRoots: readonly string[];
}): { metadata: ReleaseMetadata; warnings: string[] } {
  if (input.pinnedRoots.length === 0) {
    throw new Error(
      'no trust roots are pinned (scripts/update/trust-roots.ts is empty). This build ' +
        'predates the first-release key ceremony, so there is nothing to verify releases ' +
        'against; the updater refuses to run rather than exec unverified code.',
    );
  }

  // Rotation chain first: an unverifiable doc aborts (applyRotations throws).
  const roots = applyRotations(input.pinnedRoots, input.rotationDocs);

  const sigArtifact = parseSignatureArtifact(input.signatureJson);
  const { metadata, warnings } = parseReleaseMetadata(input.metadataJson);

  // The signed payload binds the metadata via the IMMUTABLE hash (tag
  // excluded), so rc and final share one signature by construction.
  const expectedHash = immutableMetadataHash(metadata);
  if (sigArtifact.payload.metadataHash !== expectedHash) {
    throw new Error(
      'release verification FAILED: the signed metadataHash does not match the fetched ' +
        `metadata (signed ${sigArtifact.payload.metadataHash}, computed ${expectedHash}). ` +
        'The metadata was modified after signing.',
    );
  }
  if (sigArtifact.payload.commit !== metadata.commit) {
    throw new Error(
      `release verification FAILED: signed commit ${sigArtifact.payload.commit} does not ` +
        `match metadata commit ${metadata.commit}.`,
    );
  }
  for (const img of metadata.images) {
    if (sigArtifact.payload.imageDigests[img.platform] !== img.digest) {
      throw new Error(
        `release verification FAILED: metadata digest for ${img.platform} (${img.digest}) ` +
          'is not covered by the signature.',
      );
    }
  }

  const manifest = parseArtifactManifest(input.artifactManifestJson);
  if (manifest.commit !== sigArtifact.payload.commit) {
    throw new Error(
      `release verification FAILED: artifact manifest commit ${manifest.commit} does not ` +
        `match the signed commit ${sigArtifact.payload.commit}.`,
    );
  }
  for (const img of manifest.images) {
    if (sigArtifact.payload.imageDigests[img.platform] !== img.digest) {
      throw new Error(
        `release verification FAILED: artifact manifest digest for ${img.platform} ` +
          `(${img.digest}) is not covered by the signature.`,
      );
    }
  }

  if (!verifyAgainstRoots(roots, sigArtifact.payload, sigArtifact.sig)) {
    throw new Error(
      'release verification FAILED: the signature does not verify against any trusted ' +
        'signing key. Refusing to execute any target-release code (verify-then-exec).',
    );
  }

  return { metadata, warnings };
}

/** The shim itself. Throws on any abort; the entry maps that to exit 1. */
export async function runShim(opts: ShimOptions): Promise<ShimResult> {
  const log = opts.log ?? ((): void => {});
  const { targetTag } = opts;

  if (!TARGET_TAG_RE.test(targetTag)) {
    throw new Error(
      `"${targetTag}" is not a release tag (expected v1.2.3 or rc/v1.2.3). ` +
        'Usage: npm run update -- <tag>',
    );
  }

  // (b) REFUSE on dirty/forked installs before anything else happens.
  if (!(await opts.git.isClean())) {
    throw new Error(
      'the working tree has local modifications; prebuilt-image updates only run on a ' +
        'clean checkout exactly at a trusted upstream tag. Commit/stash your changes or, ' +
        BUILD_LOCAL_GUIDANCE,
    );
  }
  const installedTag = await opts.git.exactTag();
  if (!installedTag || !TRUSTED_INSTALLED_TAG_RE.test(installedTag)) {
    throw new Error(
      `the primary checkout is ${installedTag ? `at tag "${installedTag}"` : 'not exactly at any tag'}, ` +
        'not at a trusted upstream release tag (v*). Prebuilt-image updates require a ' +
        'known starting release so the upgrade chain is meaningful. ' +
        BUILD_LOCAL_GUIDANCE,
    );
  }
  log(`installed: ${installedTag} -> target: ${targetTag}`);

  // (c) fetch the release artifacts (network behind the injected fetcher).
  const [metadataJson, artifactManifestJson, signatureJson, rotationDocs] = await Promise.all([
    opts.fetcher.fetchMetadata(targetTag),
    opts.fetcher.fetchArtifactManifest(targetTag),
    opts.fetcher.fetchSignature(targetTag),
    opts.fetcher.fetchRotationDocs(),
  ]);

  // (d) verify-then-exec: any failure here happens BEFORE a worktree exists.
  const { metadata, warnings } = verifyReleaseArtifacts({
    metadataJson,
    artifactManifestJson,
    signatureJson,
    rotationDocs,
    pinnedRoots: opts.trustRoots,
  });
  for (const w of warnings) log(`warning: ${w}`);
  log(`signature verified for commit ${metadata.commit}`);

  // (e) bootstrap prerequisites BEFORE any target code executes.
  const { minNode, minNpm } = metadata.bootstrapPrerequisites;
  if (compareVersions(opts.nodeVersion, minNode) < 0) {
    throw new Error(
      `your Node is too old for ${targetTag}: it requires Node >= ${minNode}, you are ` +
        `running ${opts.nodeVersion}. Upgrade Node first (https://nodejs.org), then re-run ` +
        'the update. Nothing was changed.',
    );
  }
  if (minNpm && opts.npmVersion && compareVersions(opts.npmVersion, minNpm) < 0) {
    throw new Error(
      `your npm is too old for ${targetTag}: it requires npm >= ${minNpm}, you are ` +
        `running ${opts.npmVersion}. Run \`npm install -g npm@latest\`, then re-run the ` +
        'update. Nothing was changed.',
    );
  }

  // (f) worktree + the TARGET's own dependency set.
  const segment = tagDirSegment(targetTag);
  const worktreeDir = `${opts.primaryDir}/${UPDATE_DIR}/worktrees/${segment}`;
  opts.fs.mkdirp(`${opts.primaryDir}/${UPDATE_DIR}/worktrees`);
  await opts.git.worktreeAdd(worktreeDir, targetTag);

  log(`npm ci in ${worktreeDir} (target's lockfile)`);
  const ciCode = await opts.proc.npmCi(worktreeDir);
  if (ciCode !== 0) {
    throw new Error(
      `npm ci failed (exit ${ciCode}) in the target worktree; the primary checkout was ` +
        'not touched. Fix the dependency failure and re-run the update.',
    );
  }

  // Persist the VERIFIED metadata for the runner: it must never re-fetch
  // unverified bytes for decisions the shim already verified.
  const releaseDir = `${opts.primaryDir}/${UPDATE_DIR}/releases/${segment}`;
  opts.fs.mkdirp(releaseDir);
  const verifiedMetadataPath = `${releaseDir}/metadata.verified.json`;
  opts.fs.writeFile(verifiedMetadataPath, metadataJson);

  // Exec the TARGET's runner with context.
  const runnerCode = await opts.proc.execRunner(worktreeDir, [
    '--target',
    targetTag,
    '--primary',
    opts.primaryDir,
    '--metadata',
    verifiedMetadataPath,
    '--installed',
    installedTag,
  ]);
  if (runnerCode !== 0) {
    throw new Error(
      `the ${targetTag} update runner exited ${runnerCode}; the primary checkout still ` +
        `points at ${installedTag} (a failed update leaves the durable checkout untouched). ` +
        `Inspect the worktree at ${worktreeDir}, fix, and re-run.`,
    );
  }

  // (g) only now: atomically advance the durable pointer.
  await opts.git.checkoutPrimary(targetTag);
  log(`primary checkout advanced to ${targetTag}`);

  return { metadata, worktreeDir, warnings };
}
