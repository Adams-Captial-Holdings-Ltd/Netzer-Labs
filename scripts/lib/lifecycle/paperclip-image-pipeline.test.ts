/**
 * Phase 1.5 regression tests for the Paperclip image pipeline.
 *
 * The pure half (buildspec parameterization, deterministic names, the
 * manifest record) is unit-tested directly. The other half of this phase is
 * WHERE those calls sit, and that is exactly what regressed before:
 *
 *  - a resource created outside the CCE_PAPERCLIP_ENABLED gate (M23),
 *  - a step added to scripts/deploy.ts but not to the CI workflow, which is
 *    the driver that actually reaches staging (M27, M22),
 *  - a teardown sweep covering the orchestrator repo only, so the second
 *    CodeBuild project, its role, its role policy and its log group outlive
 *    the install (the M23/M24 defect class).
 *
 * None of those are reachable from a function call, so the placement checks
 * read the committed sources - the same shape as teardown-plan.test.ts
 * reading the real out-of-band catalog off disk.
 *
 * Names are asserted as LITERALS, never against RESOURCE_NAMES.x, which
 * would compare a constant with itself and pass under any rename (A20).
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { buildResourceNames } from '../../../infra/lib/constants.js';
import { DynamoStack } from '../../../infra/lib/dynamo-stack.js';
import { IamStack } from '../../../infra/lib/iam-stack.js';
import { MessagingStack } from '../../../infra/lib/messaging-stack.js';
import { SecretsStack } from '../../../infra/lib/secrets-stack.js';
import { StorageStack } from '../../../infra/lib/storage-stack.js';
import { resolveStateNames } from './bootstrap-state.js';
import {
  cloudBuildBuildSpec,
  cloudBuildNames,
  contentImageTag,
  staleContentTagReason,
} from './cloud-build.js';
import { buildImageRecords } from './deploy-phases.js';
import { PAPERCLIP_CONTAINER_NAME, type DeployManifest } from './manifest.js';
import { collectPrivateEcrDigests } from './rollback-classes.js';
import { parseCatalog } from './teardown-plan.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
/** Line endings normalized so the assertions below are CRLF-agnostic. */
const read = (rel: string): string =>
  readFileSync(join(REPO_ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

const DEPLOY_TS = read('scripts/deploy.ts');
const TEARDOWN_TS = read('scripts/teardown.ts');
const WORKFLOW = read('.github/workflows/deploy.yml');

/**
 * The `{ ... }` block that starts at `head`, brace-matched.
 *
 * `head` must occur exactly once. These helpers slice on a literal, so a
 * second occurrence would silently hand every assertion below the WRONG
 * block, and a reworded one would hand them nothing - both are asserted
 * rather than left to chance.
 */
function blockAfter(source: string, head: string): string {
  const start = source.indexOf(head);
  expect(start, `expected to find ${head}`).toBeGreaterThanOrEqual(0);
  expect(source.indexOf(head, start + 1), `expected ONE ${head}`).toBe(-1);
  let depth = 0;
  for (let i = start + head.length - 1; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces after ${head}`);
}

/** One workflow step, from its `- name:` line up to the next one. */
function workflowStep(name: string): string {
  const head = `      - name: ${name}`;
  const start = WORKFLOW.indexOf(head);
  expect(start, `expected a workflow step named ${name}`).toBeGreaterThanOrEqual(0);
  expect(WORKFLOW.indexOf(head, start + 1), `expected ONE step named ${name}`).toBe(-1);
  const next = WORKFLOW.indexOf('\n      - name: ', start + 1);
  return WORKFLOW.slice(start, next === -1 ? undefined : next);
}

// ─────────────────────────────────────────────────────────────────────
// Buildspec: parameterized, with the arm64 self-check kept
// ─────────────────────────────────────────────────────────────────────

describe('cloudBuildBuildSpec parameterization', () => {
  it('defaults to the orchestrator build unchanged', () => {
    expect(cloudBuildBuildSpec()).toContain(
      'docker build --build-arg DEPLOY_TIER="$DEPLOY_TIER" -t "$ECR_HOST/$ECR_REPO_NAME:$IMAGE_TAG" -f Dockerfile .',
    );
  });

  it('builds the vendored Paperclip Dockerfile from the vendor directory', () => {
    const spec = cloudBuildBuildSpec('vendor/paperclip/Dockerfile', 'vendor/paperclip');
    expect(spec).toContain('-f vendor/paperclip/Dockerfile vendor/paperclip');
    expect(spec).not.toContain('-f Dockerfile .');
  });

  it('keeps :latest for the orchestrator and withholds it from Paperclip', () => {
    // The orchestrator repo has carried :latest since before this module.
    expect(cloudBuildBuildSpec()).toContain('docker push "$ECR_HOST/$ECR_REPO_NAME:latest"');
    // The Paperclip repo is new, has no lifecycle policy, and its only
    // legitimate consumer is a task definition pinned to the digest.
    const spec = cloudBuildBuildSpec('vendor/paperclip/Dockerfile', 'vendor/paperclip', false);
    expect(spec).toContain('docker push "$ECR_HOST/$ECR_REPO_NAME:$IMAGE_TAG"');
    expect(spec).not.toContain(':latest');
  });

  it('keeps the arm64 self-check INSIDE the build for every consumer', () => {
    // The pinned Paperclip base is a multi-arch index: drop this and a
    // wrong-platform builder pushes amd64 that crash-loops on Fargate.
    for (const spec of [
      cloudBuildBuildSpec(),
      cloudBuildBuildSpec('vendor/paperclip/Dockerfile', 'vendor/paperclip'),
    ]) {
      expect(spec).toContain('test "$ARCH" = "arm64"');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// Content-addressed tag: what makes the phase idempotent, and the one
// value BOTH drivers have to compute identically.
// ─────────────────────────────────────────────────────────────────────

describe('contentImageTag', () => {
  it('is git tree hash of the directory, prefixed and truncated to 12', async () => {
    const tag = await contentImageTag(REPO_ROOT, 'vendor/paperclip', 'paperclip');
    const tree = execFileSync('git', ['rev-parse', 'HEAD:vendor/paperclip'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    }).trim();
    // The literal shape the workflow's `git rev-parse ... | cut -c1-12`
    // produces. If these two ever diverge the drivers rebuild each other's
    // images forever, so this asserts the value, not just the format.
    expect(tag).toBe(`paperclip-${tree.slice(0, 12)}`);
    expect(tag).toMatch(/^paperclip-[0-9a-f]{12}$/);
  });

  it('is stable across calls, so a rerun resolves the same tag', async () => {
    expect(await contentImageTag(REPO_ROOT, 'vendor/paperclip', 'paperclip')).toBe(
      await contentImageTag(REPO_ROOT, 'vendor/paperclip', 'paperclip'),
    );
  });

  it('does not track the app: a different directory yields a different tag', async () => {
    expect(await contentImageTag(REPO_ROOT, 'vendor/paperclip', 'paperclip')).not.toBe(
      await contentImageTag(REPO_ROOT, 'scripts/lib/lifecycle', 'paperclip'),
    );
  });

  it('returns null for a path absent from HEAD, so the caller can fall back', async () => {
    expect(await contentImageTag(REPO_ROOT, 'vendor/not-a-real-directory', 'paperclip')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────
// The skip's guard. contentImageTag hashes HEAD, so the tag cannot see the
// working tree: edit vendor/paperclip/updated-since.patch (the re-pin
// workflow's own step), do not commit, deploy, and the OLD tag is already in
// ECR - build skipped, old digest recorded as this deploy's Paperclip image,
// deploy green. The only "committed files only" warning in cloud-build.ts
// lives in packageSource, which the skip path never reaches.
// ─────────────────────────────────────────────────────────────────────

describe('staleContentTagReason (the guard both drivers call)', () => {
  /**
   * A throwaway git repo, so the guard's ACTUAL git invocation is exercised -
   * the pathspec, the `--` separator and the exit-code handling - rather than
   * only the pure message it formats. This is the one link that a source-grep
   * cannot pin: get the pathspec wrong and the guard either never fires or
   * fires on every unrelated edit, and both look identical from the outside.
   */
  function scratchRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), 'cce-stale-tag-'));
    const git = (...args: string[]): void => {
      execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
    };
    git('init', '-q');
    writeFileSync(join(dir, 'vendored.txt'), 'pinned\n');
    mkdirSync(join(dir, 'app'), { recursive: true });
    writeFileSync(join(dir, 'app', 'index.ts'), 'export const x = 1;\n');
    git('add', '-A');
    git('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-qm', 'init');
    return dir;
  }

  it('is null on a clean checkout, so a normal re-deploy still skips', async () => {
    const dir = scratchRepo();
    try {
      expect(await staleContentTagReason(dir, '.', 'paperclip-abc123456789')).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses when the build context has uncommitted work the tag cannot name', async () => {
    const dir = scratchRepo();
    try {
      writeFileSync(join(dir, 'vendored.txt'), 'repinned\n');
      const reason = await staleContentTagReason(dir, 'vendored.txt', 'paperclip-abc123456789');
      expect(reason).not.toBeNull();
      // The operator must be told WHICH image would have gone out and which
      // file caused it, not merely that something is uncommitted.
      expect(reason).toContain('vendored.txt');
      expect(reason).toContain('paperclip-abc123456789');
      expect(reason).toContain('PREVIOUS image');
      expect(reason).toContain('COMMITTED tree');
      expect(reason).toContain('Nothing was built');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('also catches an untracked file dropped into the context', async () => {
    // git archive HEAD does not ship it either, so the built image would not
    // contain it and the tag would not change: same silent-stale class.
    const dir = scratchRepo();
    try {
      writeFileSync(join(dir, 'app', 'scratch.ts'), '// not committed\n');
      expect(await staleContentTagReason(dir, 'app', 'paperclip-abc')).toContain('scratch.ts');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is scoped to the context: unrelated edits do not block the skip', async () => {
    // A dirty app tree is the normal state of a working deploy and cannot
    // change vendor/paperclip's tree hash. Blocking on it would make the guard
    // fire constantly and get deleted.
    const dir = scratchRepo();
    try {
      writeFileSync(join(dir, 'app', 'index.ts'), 'export const x = 2;\n');
      expect(await staleContentTagReason(dir, 'vendored.txt', 'paperclip-abc')).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is null outside a git checkout, where there is no content tag anyway', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cce-no-git-'));
    try {
      expect(await staleContentTagReason(dir, '.', 'paperclip-abc')).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('cloudBuildNames for the Paperclip repo', () => {
  it('derives every resource teardown has to delete', () => {
    const n = cloudBuildNames('claudeclaw-staging-paperclip');
    expect(n.project).toBe('claudeclaw-staging-paperclip-cloud-build');
    expect(n.role).toBe('claudeclaw-staging-paperclip-cloud-build-role');
    expect(n.rolePolicy).toBe('claudeclaw-staging-paperclip-cloud-build-policy');
    expect(n.logGroup).toBe('/aws/codebuild/claudeclaw-staging-paperclip-cloud-build');
  });

  it('is fed by the repo name teardown actually passes it', () => {
    // Closes the one un-executed link in the teardown chain: teardown loops
    // `buildResourceNames(suffix).paperclipEcrRepo` into cloudBuildNames, so
    // the four literals above only describe what teardown deletes if THIS
    // holds. A dry run cannot be performed without AWS; this is the part of
    // it that is a pure function.
    expect(buildResourceNames('staging').paperclipEcrRepo).toBe('claudeclaw-staging-paperclip');
    expect(cloudBuildNames(buildResourceNames('staging').paperclipEcrRepo).project).toBe(
      'claudeclaw-staging-paperclip-cloud-build',
    );
  });

  it('is a DIFFERENT project from the orchestrator build', () => {
    expect(cloudBuildNames('claudeclaw-paperclip').project).not.toBe(
      cloudBuildNames('claudeclaw-orchestrator').project,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────
// Manifest record: a digest that is deployed but unrecorded is a digest
// no rollback can resolve.
// ─────────────────────────────────────────────────────────────────────

describe('buildImageRecords with the Paperclip image', () => {
  const base = {
    app: 'claudeclaw-staging',
    repoUri: '123456789012.dkr.ecr.us-east-1.amazonaws.com/claudeclaw-staging-orchestrator',
    imageDigest: 'sha256:' + 'a'.repeat(64),
    tier: 1,
    paperclipRepoUri: '123456789012.dkr.ecr.us-east-1.amazonaws.com/claudeclaw-staging-paperclip',
  };

  it('records nothing for Paperclip when the gated build did not run', () => {
    expect(buildImageRecords(base).some((r) => r.containerName === 'paperclip-server')).toBe(false);
  });

  it('records the digest and pins the platform to linux/arm64', () => {
    const digest = 'sha256:' + 'b'.repeat(64);
    const record = buildImageRecords({ ...base, paperclipDigest: digest }).find(
      (r) => r.containerName === 'paperclip-server',
    );
    expect(record).toBeDefined();
    expect(record?.digest).toBe(digest);
    expect(record?.repo).toBe(base.paperclipRepoUri);
    expect(record?.platform).toBe('linux/arm64');
    expect(record?.taskFamily).toBe('claudeclaw-staging-paperclip');
  });

  it('does not make an orchestrator rollback depend on the Paperclip repo', () => {
    // The image rollback class re-points the orchestrator service only. The
    // Paperclip digest lives in a repo teardown deletes with --force and
    // Phase 9 will churn; verifying it here would abort a rollback of a
    // RUNNING service over an image no service consumes yet. Fed from the
    // real record producer so the two cannot drift apart.
    const digest = 'sha256:' + 'b'.repeat(64);
    const images = buildImageRecords({ ...base, paperclipDigest: digest });
    const { toVerify } = collectPrivateEcrDigests(
      { imageDigest: base.imageDigest, images } as unknown as DeployManifest,
      'claudeclaw-staging-orchestrator',
    );
    expect(toVerify.map((v) => v.digest)).toEqual([base.imageDigest]);
    expect(toVerify.some((v) => v.repositoryName.endsWith('-paperclip'))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────
// The gate, on BOTH deploy drivers
// ─────────────────────────────────────────────────────────────────────

describe('CCE_PAPERCLIP_ENABLED gate (scripts/deploy.ts)', () => {
  const gated = blockAfter(DEPLOY_TS, 'if (paperclipEnabled) {');

  it('builds and pushes the Paperclip image only inside the gate', () => {
    expect(gated).toContain('runCloudBuild(');
    expect(gated).toContain("dockerfile: 'vendor/paperclip/Dockerfile'");
    expect(gated).toContain("buildContext: 'vendor/paperclip'");
  });

  it('resolves the pushed digest from the Paperclip repo, inside the gate', () => {
    expect(gated).toContain('resolveImageDigest(env, paperclipTag, paperclipRepoName)');
  });

  it('tags by vendor content, not by the app git sha', () => {
    expect(gated).toContain("contentImageTag(repoRoot, 'vendor/paperclip', 'paperclip')");
    // imageTag is the app's short git sha; naming it here is what made every
    // unrelated commit rebuild the image. It survives only as the `??`
    // fallback for a non-git checkout, so it may appear in that expression
    // and nowhere else in the gated block.
    expect(gated).toContain('imageTag: paperclipTag');
    const usesOfAppTag = gated.split(/\bimageTag\b/).length - 1;
    const asProperty = gated.split('imageTag: paperclipTag').length - 1;
    const asFallback = gated.split('?? imageTag').length - 1;
    expect(usesOfAppTag).toBe(asProperty + asFallback);
  });

  it('publishes no floating :latest into the Paperclip repo', () => {
    // Its one legitimate consumer is a task definition pinned to the digest
    // recorded in the manifest. The orchestrator repo keeps its :latest;
    // this one is created with no lifecycle policy and no consumer yet.
    expect(gated).toContain('pushLatest: false');
  });

  it('guards the skip so uncommitted vendor work cannot ship the previous image', () => {
    // The tag is HEAD's tree hash, so this branch is the one place a green
    // deploy can record the OLD digest as this deploy's Paperclip image. The
    // guard has to run BEFORE the digest is adopted and before the reassuring
    // "already in ... skipping the build" line is printed, or it guards a
    // decision that is already made.
    expect(gated).toContain(
      "staleContentTagReason(repoRoot, 'vendor/paperclip', paperclipTag)",
    );
    // A DeployAbort, so the operator reads the remedy instead of a stack.
    expect(gated).toContain('if (stale) throw new DeployAbort(stale)');
    const guardAt = gated.indexOf('staleContentTagReason(');
    expect(guardAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(gated.indexOf('paperclipImageDigest = existingPaperclip.digest'));
    expect(guardAt).toBeLessThan(gated.indexOf('skipping the build'));
    // ...and only on the skip branch: the build path packages `git archive
    // HEAD`, so its image and its tag agree and packageSource's warning is the
    // right shape there.
    expect(guardAt).toBeLessThan(gated.indexOf('runCloudBuild('));
  });

  it('skips the build when that content is already in ECR, and still records a digest', () => {
    expect(gated).toContain('describeImageDigest(env, paperclipTag, paperclipRepoName)');
    expect(gated).toContain('paperclipImageDigest = existingPaperclip.digest');
    // The manifest record (requirement 4) must be written on BOTH branches,
    // so the journal call sits outside the if/else.
    const journalAt = gated.indexOf("journal('paperclip-image-pushed'");
    const buildAt = gated.indexOf('runCloudBuild(');
    expect(journalAt).toBeGreaterThan(buildAt);
  });

  it('has exactly one Paperclip build in the file, so none escapes the gate', () => {
    const occurrences = DEPLOY_TS.split("dockerfile: 'vendor/paperclip/Dockerfile'").length - 1;
    expect(occurrences).toBe(1);
  });

  it('threads the digest into the manifest', () => {
    expect(DEPLOY_TS).toContain('paperclipDigest: opts.paperclipImageDigest');
  });
});

// ─────────────────────────────────────────────────────────────────────
// ONE build mechanism. The CI driver used to cross-build this image with
// QEMU-emulated buildx while the local driver used native ARM CodeBuild:
// same Dockerfile, two mechanisms, so the arm64 gate, the base-image pull
// and the build environment all differed between the path that is
// exercised locally and the path that reaches staging and production.
// ─────────────────────────────────────────────────────────────────────

describe('CCE_PAPERCLIP_ENABLED gate (.github/workflows/deploy.yml)', () => {
  // CI does not run scripts/deploy.ts. A build present in only one driver is
  // absent from the path that reaches staging and production.
  const step = workflowStep('Build + Push Paperclip (native ARM64 CodeBuild)');

  it('is gated on the same variable as the ECR repo create', () => {
    expect(step).toContain("if: vars.CCE_PAPERCLIP_ENABLED == '1'");
  });

  it('drives the SAME cloud-build module the local driver uses', () => {
    // Not a hand-mirrored copy of the build: a thin CLI over
    // scripts/lib/lifecycle/cloud-build.ts. Everything that makes the image
    // what it is - the arm64 self-check, the tag, the skip, pushLatest -
    // therefore has exactly one implementation.
    expect(step).toContain('run: npx tsx scripts/ci/paperclip-image.ts');
    expect(existsSync(join(REPO_ROOT, 'scripts', 'ci', 'paperclip-image.ts'))).toBe(true);
  });

  it('passes the repo and the suffix that select this environment', () => {
    expect(step).toContain('PAPERCLIP_ECR_REPO: ${{ steps.cfg.outputs.paperclip_ecr_repo }}');
    // Wrong suffix here stages the source zip in the OTHER environment's
    // state bucket; it must match what the CDK deploy step passes.
    expect(step).toContain(
      "CCE_NAME_SUFFIX: ${{ env.TARGET_ENV == 'staging' && 'staging' || '' }}",
    );
    expect(WORKFLOW.split("CCE_NAME_SUFFIX: ${{ env.TARGET_ENV == 'staging' && 'staging' || '' }}").length - 1).toBe(2);
  });

  it('bounds the step, which the emulated build never did', () => {
    expect(step).toContain('timeout-minutes: 45');
  });

  it('builds no Paperclip image with docker on the runner', () => {
    // The whole point: no QEMU, no buildx, no `docker push` for this image
    // anywhere on the CI driver. (Prose about the old mechanism is allowed;
    // an INVOCATION of it is not, so this matches the build flags.)
    expect(step).not.toMatch(/docker (buildx|build|push|image)/);
    expect(WORKFLOW).not.toContain('-f vendor/paperclip/Dockerfile');
    // The orchestrator image still uses buildx, and only for its own
    // Dockerfile - so this is a change of mechanism for ONE artifact, not a
    // removal of cross-compilation the other image still needs.
    expect(WORKFLOW).toContain('-f Dockerfile');
  });
});

describe('the CI entry point is a CLI over cloud-build.ts, not a second build', () => {
  const CLI = read('scripts/ci/paperclip-image.ts');

  it('calls the shared module with the Paperclip context', () => {
    expect(CLI).toContain('runCloudBuild(');
    expect(CLI).toContain("from '../lib/lifecycle/cloud-build.js'");
    expect(CLI).toContain('dockerfile: `${PAPERCLIP_CONTEXT}/Dockerfile`');
    expect(CLI).toContain('buildContext: PAPERCLIP_CONTEXT');
    expect(CLI).toContain("const PAPERCLIP_CONTEXT = 'vendor/paperclip'");
  });

  it('keeps the content tag and the skip, matching scripts/deploy.ts', () => {
    expect(CLI).toContain("contentImageTag(repoRoot, PAPERCLIP_CONTEXT, 'paperclip')");
    expect(CLI).toContain('(build skipped)');
    // The skip must precede the build, or it skips nothing.
    expect(CLI.indexOf('(build skipped)')).toBeLessThan(CLI.indexOf('runCloudBuild('));
  });

  it('guards the skip with the SAME helper the local driver calls', () => {
    // One mechanism, not two hand-matched `git status` invocations that drift
    // the first time either is edited - the same argument that made both
    // drivers share contentImageTag and the buildspec.
    expect(CLI).toContain('staleContentTagReason(repoRoot, PAPERCLIP_CONTEXT, imageTag)');
    expect(CLI).toContain('if (stale !== null) throw new Error(stale)');
    expect(CLI).toContain("from '../lib/lifecycle/cloud-build.js'");
    expect(CLI.indexOf('staleContentTagReason(repoRoot')).toBeLessThan(
      CLI.indexOf('(build skipped)'),
    );
    // Both drivers reach the guard through the module, so neither can hold a
    // private copy of the rule. (deploy.ts keeps an UNSCOPED isCleanTree() for
    // the deploy-id path; what neither may grow is a second path-scoped
    // `git status --porcelain -- <context>` of its own.)
    expect(DEPLOY_TS).toContain('staleContentTagReason');
    expect(CLI).not.toContain("'--porcelain', '--'");
    expect(DEPLOY_TS).not.toContain("'--porcelain', '--'");
  });

  it('publishes no floating :latest into the Paperclip repo', () => {
    expect(CLI).toContain('pushLatest: false');
  });

  it('never shells out to docker: the build host is CodeBuild', () => {
    // Prose about the mechanism it replaced is fine; a spawn is not.
    expect(CLI).not.toMatch(/(capture|run|spawn)\(\s*'docker'/);
  });

  it('refuses to read an unreadable ECR probe as "not built yet"', () => {
    // Same failure mode the workflow records for 2026-08-14, and here it
    // would additionally burn a full ARM build before failing at the push.
    expect(CLI).toContain('refusing to guess that this image is missing');
    expect(CLI).toContain('ImageNotFoundException|RepositoryNotFoundException');
  });

  it('resolves the state bucket with the shared resolver, not a literal', () => {
    expect(CLI).toContain('resolveStateNames(process.env)');
    expect(CLI).not.toMatch(/claudeclaw[a-z*-]*-deploy-/);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Teardown deletes the SECOND cloud build; the catalog only reports it
// ─────────────────────────────────────────────────────────────────────

describe('teardown sweeps both cloud builds', () => {
  it('loops the cloud-build sweep over the Paperclip repo as well', () => {
    expect(TEARDOWN_TS).toContain(
      'for (const repoName of [names.ecrRepo, buildResourceNames(suffix).paperclipEcrRepo])',
    );
  });

  it('still deletes the project, the role policy, the role and the log group', () => {
    const sweep = TEARDOWN_TS.slice(
      TEARDOWN_TS.indexOf('for (const repoName of ['),
      TEARDOWN_TS.indexOf('ecr:DeleteRepository'),
    );
    expect(sweep).toContain("'delete-project'");
    expect(sweep).toContain("'delete-role-policy'");
    expect(sweep).toContain("'delete-role'");
    expect(sweep).toContain("'delete-log-group'");
  });

  it('catalogs the project as app-owned and deletable', () => {
    const entry = parseCatalog(read('docs/out-of-band-catalog.json')).find(
      (e) => e.id === 'paperclip-cloud-build',
    );
    expect(entry).toBeDefined();
    expect(entry?.ownership).toBe('app-owned');
    expect(entry?.teardown).toBe('delete');
    expect(entry?.nameOrPattern).toContain('claudeclaw<suffix>-paperclip-cloud-build');
  });
});

// ─────────────────────────────────────────────────────────────────────
// The CI driver's IAM. A step wired into the workflow that the deploy
// role cannot execute is wired, not working.
// ─────────────────────────────────────────────────────────────────────

describe('ClaudeClawGitHubDeploy can actually reach the Paperclip ECR repo', () => {
  /**
   * Synthesized, not grepped. The workflow step's three ECR calls
   * (describe-repositories / create-repository, describe-images,
   * docker push) all resolve against the ARN patterns and the
   * `ecr:RepositoryName` condition below, and a pattern that merely LOOKS
   * right - wrong wildcard position, wrong separator - reads fine in the
   * source and denies at runtime. So the patterns are pulled out of the
   * emitted template and matched against the repo names buildResourceNames
   * really produces, prod and staging.
   *
   * Proving this from a green flag-off CI run is impossible: with the flag
   * unset the step does not run, so the run proves the `if` guard and says
   * nothing about the grant behind it.
   */
  const template = ((): Template => {
    const prev = { ...process.env };
    // cicdRole exists only on a PROD deploy with CI/CD armed (a staging
    // deploy skips it to avoid EntityAlreadyExists).
    process.env.CCE_CICD_ENABLED = '1';
    delete process.env.CCE_NAME_SUFFIX;
    process.env.CCE_GITHUB_OWNER = 'acme';
    process.env.CCE_GITHUB_REPO = 'cce-fork';
    process.env.CCE_GITHUB_DEPLOY_REFS = 'refs/heads/main';
    try {
      const app = new App();
      const env = { account: '637423318609', region: 'us-east-1' };
      const base = { env, tier: 1 as const };
      const storage = new StorageStack(app, 'CCE-Storage', base);
      const secrets = new SecretsStack(app, 'CCE-Secrets', { ...base, dataKey: storage.dataKey });
      const dynamo = new DynamoStack(app, 'CCE-Dynamo', { ...base, dataKey: storage.dataKey });
      const messaging = new MessagingStack(app, 'CCE-Messaging', {
        ...base,
        configBucket: storage.configBucket,
      });
      return Template.fromStack(
        new IamStack(app, 'CCE-Iam', { ...base, storage, secrets, dynamo, messaging }),
      );
    } finally {
      process.env = prev;
    }
  })();

  /**
   * Every statement attached to the one role whose name the workflow
   * hard-codes - both inline `Policies` on the role and the separate
   * AWS::IAM::Policy resources `addToPolicy` emits, matched back to the
   * role by Ref so another role's grants can never satisfy these tests.
   */
  const cicdStatements = ((): Array<Record<string, unknown>> => {
    const roles = template.findResources('AWS::IAM::Role', {
      Properties: { RoleName: 'ClaudeClawGitHubDeploy' },
    });
    const logicalId = Object.keys(roles)[0];
    expect(logicalId, 'expected a ClaudeClawGitHubDeploy role in the synthesized IAM stack').toBeDefined();
    type Doc = { PolicyDocument: { Statement: Array<Record<string, unknown>> } };
    const role = roles[logicalId] as { Properties?: { Policies?: Doc[] } };
    const out = (role.Properties?.Policies ?? []).flatMap((p) => p.PolicyDocument.Statement);
    const policies = template.findResources('AWS::IAM::Policy') as Record<
      string,
      { Properties?: { Roles?: unknown[] } & Doc }
    >;
    for (const p of Object.values(policies)) {
      const attached = (p.Properties?.Roles ?? []).some(
        (r) => JSON.stringify(r) === JSON.stringify({ Ref: logicalId }),
      );
      if (attached) out.push(...(p.Properties?.PolicyDocument.Statement ?? []));
    }
    expect(out.length, 'found no policy statements attached to ClaudeClawGitHubDeploy').toBeGreaterThan(0);
    return out;
  })();

  /** IAM wildcards: `*` any run, `?` one char. Nothing else is special. */
  const iamMatch = (pattern: string, value: string): boolean =>
    new RegExp(
      '^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$',
    ).test(value);

  const statement = (sid: string): Record<string, unknown> => {
    const s = cicdStatements.find((st) => st.Sid === sid);
    expect(s, `expected an inline statement with Sid ${sid}`).toBeDefined();
    return s as Record<string, unknown>;
  };

  const repoNames = [
    buildResourceNames('').paperclipEcrRepo,
    buildResourceNames('staging').paperclipEcrRepo,
  ];

  it('names the real repos, so this is not a constant compared with itself', () => {
    expect(repoNames).toEqual(['claudeclaw-paperclip', 'claudeclaw-staging-paperclip']);
  });

  it('grants push/describe on the Paperclip repo, prod and staging', () => {
    const st = statement('EcrPushAppImages');
    const resources = (Array.isArray(st.Resource) ? st.Resource : [st.Resource]) as string[];
    for (const repo of repoNames) {
      const arn = `arn:aws:ecr:us-east-1:637423318609:repository/${repo}`;
      expect(
        resources.some((r) => typeof r === 'string' && iamMatch(r, arn)),
        `no ECR push grant covers ${arn}`,
      ).toBe(true);
    }
    // The three calls the workflow step makes, in order.
    const actions = st.Action as string[];
    for (const a of ['ecr:DescribeRepositories', 'ecr:DescribeImages', 'ecr:PutImage']) {
      expect(actions).toContain(a);
    }
    // Not a regression of the orchestrator's own grant.
    expect(
      resources.some((r) =>
        iamMatch(r, 'arn:aws:ecr:us-east-1:637423318609:repository/claudeclaw-staging-orchestrator'),
      ),
    ).toBe(true);
  });

  it('lets the "Ensure ECR repo exists" step create the Paperclip repo', () => {
    const st = statement('EcrCreateAppRepos');
    const patterns = ((st.Condition as Record<string, Record<string, string[]>>).StringLike[
      'ecr:RepositoryName'
    ] ?? []) as string[];
    for (const repo of repoNames) {
      expect(
        patterns.some((p) => iamMatch(p, repo)),
        `no ecr:CreateRepository condition admits ${repo}`,
      ).toBe(true);
    }
    // Still not a licence to create arbitrary repositories.
    expect(patterns.some((p) => iamMatch(p, 'someone-elses-repo'))).toBe(false);
  });

  // ── The CodeBuild path the CI step now drives ──────────────────────
  //
  // Moving CI off emulated buildx onto the shared cloud-build module means
  // CI must be able to stage a source zip, ensure the build role, create or
  // update the project and start it. Each of those is a distinct grant, and
  // a step that is wired but cannot execute is wired, not working - the
  // exact defect this suite was written for.

  const resources = (st: Record<string, unknown>): string[] =>
    (Array.isArray(st.Resource) ? st.Resource : [st.Resource]).filter(
      (r): r is string => typeof r === 'string',
    );
  const covers = (st: Record<string, unknown>, arn: string): boolean =>
    resources(st).some((r) => iamMatch(r, arn));

  /** The real names cloudBuildNames() derives, prod and staging. */
  const cloudBuilds = repoNames.map((r) => cloudBuildNames(r));

  it('names the real cloud-build resources, prod and staging', () => {
    expect(cloudBuilds.map((c) => c.project)).toEqual([
      'claudeclaw-paperclip-cloud-build',
      'claudeclaw-staging-paperclip-cloud-build',
    ]);
  });

  it('can create, update and start the Paperclip CodeBuild project', () => {
    const st = statement('PaperclipCloudBuildProject');
    for (const c of cloudBuilds) {
      const arn = `arn:aws:codebuild:us-east-1:637423318609:project/${c.project}`;
      expect(covers(st, arn), `no CodeBuild grant covers ${arn}`).toBe(true);
    }
    for (const a of [
      'codebuild:BatchGetProjects',
      'codebuild:CreateProject',
      'codebuild:UpdateProject',
      'codebuild:StartBuild',
      'codebuild:BatchGetBuilds',
    ]) {
      expect(st.Action as string[]).toContain(a);
    }
    // Not a licence over every project in the account.
    expect(
      covers(st, 'arn:aws:codebuild:us-east-1:637423318609:project/someone-elses-build'),
    ).toBe(false);
  });

  it('can create and PASS the build role, and only to CodeBuild', () => {
    const role = statement('PaperclipCloudBuildRole');
    for (const c of cloudBuilds) {
      const arn = `arn:aws:iam::637423318609:role/${c.role}`;
      expect(covers(role, arn), `no IAM grant covers ${arn}`).toBe(true);
    }
    // create-role passes `--tags Application=claudeclaw`, which needs TagRole.
    for (const a of ['iam:GetRole', 'iam:CreateRole', 'iam:PutRolePolicy', 'iam:TagRole']) {
      expect(role.Action as string[]).toContain(a);
    }
    // The one grant that would otherwise be a general escalation.
    expect(covers(role, 'arn:aws:iam::637423318609:role/Admin')).toBe(false);

    const pass = statement('PaperclipCloudBuildPassRole');
    expect(pass.Action).toEqual('iam:PassRole');
    for (const c of cloudBuilds) {
      expect(covers(pass, `arn:aws:iam::637423318609:role/${c.role}`)).toBe(true);
    }
    expect(pass.Condition).toEqual({
      StringEquals: { 'iam:PassedToService': 'codebuild.amazonaws.com' },
    });
  });

  it('can stage the source zip in THIS environment’s state bucket', () => {
    const st = statement('PaperclipCloudBuildSource');
    // Bucket names come from the real resolver, not a literal restated here.
    for (const suffix of ['', 'staging']) {
      const { stateBucket } = resolveStateNames({
        AWS_ACCOUNT_ID: '637423318609',
        AWS_REGION: 'us-east-1',
        CCE_NAME_SUFFIX: suffix,
      });
      expect(covers(st, `arn:aws:s3:::${stateBucket}`), `no head-bucket grant for ${stateBucket}`).toBe(true);
      expect(
        covers(st, `arn:aws:s3:::${stateBucket}/${cloudBuildNames('x').s3Prefix}paperclip-abc.zip`),
        `no PutObject grant under cloud-build/ in ${stateBucket}`,
      ).toBe(true);
      // Scoped to the prefix the cloud build uses, not the whole bucket:
      // deploy manifests and journals live in the same bucket.
      expect(covers(st, `arn:aws:s3:::${stateBucket}/manifests/latest.json`)).toBe(false);
    }
    expect(st.Action as string[]).toContain('s3:PutObject');
  });

  it('can tail a FAILED build’s logs, read-only', () => {
    const st = statement('PaperclipCloudBuildLogs');
    for (const c of cloudBuilds) {
      const arn = `arn:aws:logs:us-east-1:637423318609:log-group:${c.logGroup}`;
      expect(covers(st, arn), `no log-read grant covers ${arn}`).toBe(true);
      expect(covers(st, `${arn}:*`)).toBe(true);
    }
    // Read-only: CI never writes to, or deletes, the build's log group. The
    // BUILD role owns those (cloudBuildRolePolicy sid Logs), and teardown
    // deletes the group.
    for (const a of st.Action as string[]) expect(a.startsWith('logs:')).toBe(true);
    for (const a of ['logs:PutLogEvents', 'logs:DeleteLogGroup', 'logs:CreateLogGroup']) {
      expect(st.Action as string[]).not.toContain(a);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// Handoff to Phase 4. Both assertions are inert until Phase 4's stack
// file lands, and fire the moment it does - which is the point: a comment
// asking a future author to remember something is not enforcement.
// ─────────────────────────────────────────────────────────────────────

describe('Phase 4 handoff (arms itself when infra/lib/paperclip-stack.ts lands)', () => {
  const stackPath = join(REPO_ROOT, 'infra', 'lib', 'paperclip-stack.ts');
  const stackSource = existsSync(stackPath)
    ? readFileSync(stackPath, 'utf8').replace(/\r\n/g, '\n')
    : null;

  it.runIf(stackSource !== null)(
    'the manifest predicts the container and family Phase 4 actually chose',
    () => {
      // buildImageRecords writes `${app}-paperclip` / 'paperclip-server'
      // BEFORE any task definition exists. Until this file existed those
      // were predictions and the pipeline test pinned the prediction, so a
      // Phase 4 that picked other names would have left the manifest
      // recording a rollback target matching nothing in ECS, with every
      // test still green.
      expect(stackSource).toContain(PAPERCLIP_CONTAINER_NAME);
      expect(stackSource).toMatch(/-paperclip['"`]/);
    },
  );

  it.runIf(stackSource !== null)(
    'the rollback skip is gone once Paperclip has a service to roll back',
    () => {
      // collectPrivateEcrDigests skips the Paperclip digest because today
      // no service consumes it, so verifying it would abort an ORCHESTRATOR
      // rollback over an unused image. The moment Paperclip has a service
      // that skip inverts: the one image a Paperclip rollback depends on
      // becomes the one image rollback never checks.
      const hasService = /Ec2Service|FargateService|AWS::ECS::Service/.test(stackSource ?? '');
      if (!hasService) return;
      expect(
        read('scripts/lib/lifecycle/rollback-classes.ts'),
        'Paperclip now has a service: delete the PAPERCLIP_CONTAINER_NAME skip in collectPrivateEcrDigests and verify that digest',
      ).not.toContain('if (img.containerName === PAPERCLIP_CONTAINER_NAME)');
    },
  );
});
