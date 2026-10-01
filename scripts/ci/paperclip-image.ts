/**
 * Paperclip image build for the CI deploy driver (ADR 0010 Phase 1.5).
 *
 * WHY THIS FILE EXISTS. There are two deploy drivers: `scripts/deploy.ts` (the
 * operator's local path) and `.github/workflows/deploy.yml` (the path that
 * actually reaches staging and production). Until this file they built the
 * SAME image by two different mechanisms - the local driver through the native
 * ARM64 CodeBuild path in lib/lifecycle/cloud-build.ts, the workflow through
 * QEMU-emulated `docker buildx` on an amd64 GitHub runner. Two mechanisms means
 * the arm64 guarantee, the base-image pull, the build environment and the
 * failure modes all differ between the path that gets tested and the path that
 * ships, which is the same defect class as a step wired into one driver and
 * not the other. Emulation was also the wrong tool on its own merits: the
 * vendored Dockerfile runs apt-get and then a full `tsc` over the entire
 * Paperclip server (a 12,670-line route module, a 212 KB generated OpenAPI,
 * ~116 schema files) at 5-20x under QEMU, uncached, on a runner that bills
 * wall-clock minutes.
 *
 * So this is a thin CLI over the SAME module, never a second implementation:
 * `contentImageTag` + `runCloudBuild` with the Paperclip Dockerfile/context and
 * `pushLatest: false`, exactly as `scripts/deploy.ts` phase a calls them. One
 * artifact, one mechanism, one arm64 guarantee - the buildspec's
 * `test "$ARCH" = "arm64"`, which runs INSIDE the build on a native ARM host
 * and is what stops a wrong-platform image being pushed at all.
 *
 * Inputs are environment variables because the caller is a workflow step:
 *
 *   AWS_REGION, AWS_ACCOUNT_ID  required
 *   PAPERCLIP_ECR_REPO          required; the repo the workflow's
 *                               "Ensure ECR repo exists" step already created
 *   CCE_NAME_SUFFIX             '' for prod, 'staging' for staging - selects
 *                               the state bucket the source zip is staged in,
 *                               through the same resolveStateNames() every
 *                               other lifecycle tool uses
 *   DEPLOY_MANIFEST_BUCKET      optional state-bucket override, same as
 *                               everywhere else
 *   DEPLOY_TIER                 forwarded as the shared buildspec's
 *                               --build-arg; the vendored Dockerfile declares
 *                               no matching ARG, so it is inert here, which is
 *                               also why it is absent from the content tag
 *
 * Nothing here guesses. An ECR probe that fails for any reason other than "no
 * such image" is a hard failure, not "not built yet" - reading an AccessDenied
 * as absence is what the workflow's own 2026-08-14 note is about, and here it
 * would additionally burn a full ARM build before failing at the push.
 */

import { appendFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { S3Client } from '@aws-sdk/client-s3';
import { bold, fail, info, ok } from '../lib/ansi.js';
import { capture } from '../lib/shell.js';
import { ensureStateBucket, resolveStateNames } from '../lib/lifecycle/bootstrap-state.js';
import {
  contentImageTag,
  runCloudBuild,
  staleContentTagReason,
} from '../lib/lifecycle/cloud-build.js';

/** scripts/ci/<this file> -> scripts/ci -> scripts -> repo root. */
const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

const PAPERCLIP_CONTEXT = 'vendor/paperclip';

function required(name: string): string {
  const value = (process.env[name] ?? '').trim();
  if (value === '') {
    throw new Error(`${name} must be set; the CI deploy workflow passes it to this step.`);
  }
  return value;
}

/**
 * Hand the resolved digest to the workflow.
 *
 * The CDK deploy step forwards it as CCE_PAPERCLIP_IMAGE_DIGEST, which
 * infra/bin/app.ts passes to PaperclipStack so both task definitions pin the
 * image BY DIGEST. Without this the CI path had no digest at all and synth
 * fell back to an unpullable placeholder tag: the same "the flag has more
 * homes than the author enumerated" defect as M22/M27, one layer down.
 */
function emitDigest(digest: string): void {
  const out = process.env.GITHUB_OUTPUT;
  if (out) appendFileSync(out, `digest=${digest}
`);
}

/**
 * Digest for a tag in ECR, or null when the tag is genuinely absent.
 * Anything else throws: "does not exist" and "I am not allowed to look" must
 * not be the same answer.
 */
async function describeDigest(repo: string, tag: string, region: string): Promise<string | null> {
  const r = await capture('aws', [
    'ecr', 'describe-images',
    '--repository-name', repo,
    '--image-ids', `imageTag=${tag}`,
    '--region', region,
    '--output', 'json',
  ]);
  if (r.code === 0) {
    const parsed = JSON.parse(r.stdout) as { imageDetails?: Array<{ imageDigest?: string }> };
    return parsed.imageDetails?.[0]?.imageDigest ?? null;
  }
  if (/ImageNotFoundException|RepositoryNotFoundException/.test(r.stderr)) return null;
  throw new Error(
    `cannot read ${repo} in ECR; refusing to guess that this image is missing.\n` +
      `${r.stderr.trim()}\n` +
      `The deploy role needs ecr:DescribeImages on ${repo} (infra/lib/iam-stack.ts, cicdRole\n` +
      'sid EcrPushAppImages). That grant is applied by the CDK deploy LATER IN THIS JOB, so it\n' +
      'must land in an EARLIER deploy than the first one at a tier that provisions Paperclip\n' +
      '(T1+). cicdRole is created only by the PROD IAM stack, so staging needs a prod deploy first.',
  );
}

async function main(): Promise<void> {
  const region = required('AWS_REGION');
  const accountId = required('AWS_ACCOUNT_ID');
  const ecrRepoName = required('PAPERCLIP_ECR_REPO');
  // Same resolver the local driver bootstraps with, so CI stages its source
  // zip in the state bucket that already belongs to this environment rather
  // than inventing a second name that teardown does not know about.
  const { stateBucket } = resolveStateNames(process.env);

  // Content-addressed, identical on both drivers: git's own tree hash for
  // vendor/paperclip, which is exactly the bytes `git archive HEAD` ships to
  // CodeBuild. An app commit that cannot alter this image must not rebuild it.
  const imageTag = await contentImageTag(repoRoot, PAPERCLIP_CONTEXT, 'paperclip');
  if (imageTag === null) {
    throw new Error(
      `could not read the git tree hash of ${PAPERCLIP_CONTEXT}, so the content tag both deploy ` +
        'drivers share cannot be computed. The cloud build packages with `git archive HEAD`, so ' +
        'this step needs a real git checkout (actions/checkout provides one).',
    );
  }

  // Skip-if-already-present, the same idempotence scripts/deploy.ts performs:
  // this exact content is already in the operator's ECR, so there is nothing
  // to build and the digest below is the existing one.
  const existing = await describeDigest(ecrRepoName, imageTag, region);
  if (existing !== null) {
    // The tag names HEAD, not the checkout, so a skip is only honest while the
    // two agree. Silent here in practice (actions/checkout hands this job a
    // clean tree); it is the SAME function scripts/deploy.ts calls at its own
    // skip, so the two drivers cannot drift on when skipping ships the
    // previous image while reporting success.
    const stale = await staleContentTagReason(repoRoot, PAPERCLIP_CONTEXT, imageTag);
    if (stale !== null) throw new Error(stale);
    console.log(
      ok(`Paperclip image ${bold(imageTag)} already in ${ecrRepoName}: ${existing} (build skipped)`),
    );
    emitDigest(existing);
    return;
  }

  // CI is a first-install driver in its own right. Requiring an operator to
  // run the local bootstrap first made an automatic staging deploy incapable
  // of installing Paperclip from a fresh account. Reuse the exact bucket
  // baseline the local driver owns: deterministic name, versioning, SSE,
  // public-access block and tags, all idempotent.
  await ensureStateBucket(new S3Client({ region }), stateBucket, region);
  console.log(ok(`Paperclip cloud-build state bucket ready: ${stateBucket}`));

  console.log(
    info(
      `building ${bold(imageTag)} on NATIVE ARM64 CodeBuild in ${accountId}/${region} ` +
        '(the same path scripts/deploy.ts uses; no emulation, arm64 self-checked in the build)',
    ),
  );
  await runCloudBuild({
    region,
    accountId,
    ecrRepoName,
    ecrHost: `${accountId}.dkr.ecr.${region}.amazonaws.com`,
    stateBucket,
    imageTag,
    deployTier: process.env.DEPLOY_TIER ?? '1',
    repoRoot,
    // The Dockerfile and its build context live in the vendor directory.
    dockerfile: `${PAPERCLIP_CONTEXT}/Dockerfile`,
    buildContext: PAPERCLIP_CONTEXT,
    // No floating :latest in this repo. Its only legitimate consumer is a task
    // definition pinned to the digest, and this repo has no lifecycle policy.
    pushLatest: false,
  });

  // Pin by digest. CI writes no deploy manifest (scripts/deploy.ts owns that),
  // so this is the run log's record of what was pushed.
  const digest = await describeDigest(ecrRepoName, imageTag, region);
  if (digest === null) {
    throw new Error(
      `the cloud build reported success but ${ecrRepoName}:${imageTag} is not in ECR`,
    );
  }
  console.log(ok(`Paperclip image digest: ${bold(digest)}`));
  emitDigest(digest);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  // GitHub workflow command, so the failure lands in the job summary too.
  console.log(`::error::Paperclip image build: ${message.split('\n')[0]}`);
  console.error(fail(message));
  process.exitCode = 1;
});
