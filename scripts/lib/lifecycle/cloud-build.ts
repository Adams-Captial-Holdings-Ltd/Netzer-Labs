/**
 * Cloud image build: Docker-free installs (the "no Docker required" path).
 *
 * WHY. The only reason an operator ever needed Docker Desktop was the local
 * image build inside `npm run deploy`. That was the heaviest prerequisite in
 * the whole install. This module builds the SAME image with AWS CodeBuild
 * inside the operator's own account instead:
 *
 *   package source (git archive, tracked files only, so .env can never
 *   leak into the zip) -> upload to the state bucket under cloud-build/ ->
 *   ensure a one-shot CodeBuild project + minimal IAM role -> run the build
 *   on a native ARM64 container (so a plain `docker build` yields arm64,
 *   no cross-build, and the buildspec self-verifies the architecture and
 *   fails the build on a mismatch) -> CodeBuild pushes to the operator's
 *   private ECR -> deploy resumes exactly where the local path would,
 *   resolving the digest from ECR.
 *
 * Nothing leaves the operator's account: source goes to THEIR state bucket,
 * the build runs in THEIR CodeBuild, the image lands in THEIR ECR. Cost is
 * a few cents of CodeBuild minutes per build. Docker stays fully supported
 * as the faster local path when a running daemon is detected (or forced
 * with --build-local).
 *
 * Teardown: the project and role are deterministic names derived from the
 * ECR repo name, deleted by teardown's final sweep next to the ECR repo
 * itself; the source zips live in the state bucket, which teardown deletes
 * last.
 *
 * Import-safe: no top-level side effects. Pure helpers (names, buildspec,
 * policies, status classification) are exported for tests; the I/O
 * orchestrator shells the AWS CLI via lib/shell like the rest of deploy.
 * No em dashes by house rule.
 */

import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bold, dim, fail, info, ok, warn } from '../ansi.js';
import { run, capture } from '../shell.js';

// ─────────────────────────────────────────────────────────────────────
// Pure helpers (exported for tests)
// ─────────────────────────────────────────────────────────────────────

export interface CloudBuildNames {
  project: string;
  role: string;
  rolePolicy: string;
  logGroup: string;
  s3Prefix: string;
}

/** Deterministic, suffix-aware names so teardown can sweep them. */
export function cloudBuildNames(ecrRepoName: string): CloudBuildNames {
  return {
    project: `${ecrRepoName}-cloud-build`,
    role: `${ecrRepoName}-cloud-build-role`,
    rolePolicy: `${ecrRepoName}-cloud-build-policy`,
    logGroup: `/aws/codebuild/${ecrRepoName}-cloud-build`,
    s3Prefix: 'cloud-build/',
  };
}

/**
 * Inline buildspec. The build host is a native ARM64 container, so a plain
 * `docker build` produces linux/arm64 with no cross-build. The architecture
 * self-check is load-bearing: it moves the "item 9" arm64 gate INSIDE the
 * build (the operator's machine has no docker to inspect with), so a
 * non-arm64 image can never be pushed at all.
 */
export function cloudBuildBuildSpec(): string {
  return [
    'version: 0.2',
    'phases:',
    '  pre_build:',
    '    commands:',
    '      - aws ecr get-login-password --region "$AWS_DEFAULT_REGION" | docker login --username AWS --password-stdin "$ECR_HOST"',
    '  build:',
    '    commands:',
    '      - docker build --build-arg DEPLOY_TIER="$DEPLOY_TIER" -t "$ECR_HOST/$ECR_REPO_NAME:$IMAGE_TAG" -f Dockerfile .',
    '      - ARCH=$(docker inspect --format \'{{.Architecture}}\' "$ECR_HOST/$ECR_REPO_NAME:$IMAGE_TAG"); echo "image architecture is $ARCH"; test "$ARCH" = "arm64"',
    '  post_build:',
    '    commands:',
    '      - docker push "$ECR_HOST/$ECR_REPO_NAME:$IMAGE_TAG"',
    '      - docker tag "$ECR_HOST/$ECR_REPO_NAME:$IMAGE_TAG" "$ECR_HOST/$ECR_REPO_NAME:latest"',
    '      - docker push "$ECR_HOST/$ECR_REPO_NAME:latest"',
    '',
  ].join('\n');
}

export function cloudBuildTrustPolicy(): string {
  return JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Principal: { Service: 'codebuild.amazonaws.com' },
        Action: 'sts:AssumeRole',
      },
    ],
  });
}

export interface CloudBuildPolicyInput {
  region: string;
  accountId: string;
  ecrRepoName: string;
  stateBucket: string;
}

/** Least-privilege role policy: logs to its own group, push to ONE repo, read ONE s3 prefix. */
export function cloudBuildRolePolicy(input: CloudBuildPolicyInput): string {
  const names = cloudBuildNames(input.ecrRepoName);
  return JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'Logs',
        Effect: 'Allow',
        Action: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
        Resource: [
          `arn:aws:logs:${input.region}:${input.accountId}:log-group:${names.logGroup}`,
          `arn:aws:logs:${input.region}:${input.accountId}:log-group:${names.logGroup}:*`,
        ],
      },
      {
        Sid: 'EcrAuth',
        Effect: 'Allow',
        Action: ['ecr:GetAuthorizationToken'],
        Resource: '*',
      },
      {
        Sid: 'EcrPush',
        Effect: 'Allow',
        Action: [
          'ecr:BatchCheckLayerAvailability',
          'ecr:CompleteLayerUpload',
          'ecr:InitiateLayerUpload',
          'ecr:PutImage',
          'ecr:UploadLayerPart',
          'ecr:BatchGetImage',
          'ecr:GetDownloadUrlForLayer',
        ],
        Resource: `arn:aws:ecr:${input.region}:${input.accountId}:repository/${input.ecrRepoName}`,
      },
      {
        Sid: 'SourceZip',
        Effect: 'Allow',
        Action: ['s3:GetObject', 's3:GetObjectVersion'],
        Resource: `arn:aws:s3:::${input.stateBucket}/${names.s3Prefix}*`,
      },
    ],
  });
}

export type CloudBuildStatus = 'IN_PROGRESS' | 'SUCCEEDED' | 'FAILED' | 'FAULT' | 'STOPPED' | 'TIMED_OUT';

/** true = keep polling; false = terminal. */
export function isBuildInProgress(status: string): boolean {
  return status === 'IN_PROGRESS';
}

export function buildSucceeded(status: string): boolean {
  return status === 'SUCCEEDED';
}

// ─────────────────────────────────────────────────────────────────────
// I/O orchestrator
// ─────────────────────────────────────────────────────────────────────

export interface CloudBuildOptions {
  region: string;
  accountId: string;
  ecrRepoName: string;
  ecrHost: string;
  stateBucket: string;
  imageTag: string;
  deployTier: string;
  repoRoot: string;
  log?: (line: string) => void;
}

class CloudBuildError extends Error {}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function packageSource(repoRoot: string, logLine: (l: string) => void): Promise<string> {
  const dirty = await capture('git', ['status', '--porcelain'], { cwd: repoRoot });
  if (dirty.code === 0 && dirty.stdout.trim().length > 0) {
    logLine(
      warn(
        'working tree has uncommitted changes; the cloud build packages TRACKED, COMMITTED files only (git archive HEAD). Commit first if those changes should ship.',
      ),
    );
  }
  const tmp = mkdtempSync(join(tmpdir(), 'cce-cloud-build-'));
  const zipPath = join(tmp, 'source.zip');
  const r = await run('git', ['archive', '--format=zip', '-o', zipPath, 'HEAD'], { cwd: repoRoot });
  if (r !== 0) {
    rmSync(tmp, { recursive: true, force: true });
    throw new CloudBuildError('git archive failed; the cloud build needs a git checkout to package');
  }
  return zipPath;
}

async function ensureRole(opts: CloudBuildOptions, names: CloudBuildNames, logLine: (l: string) => void): Promise<boolean> {
  const got = await capture('aws', ['iam', 'get-role', '--role-name', names.role]);
  let created = false;
  if (got.code !== 0) {
    logLine(info(`creating IAM role ${names.role} (scoped to this build only)`));
    const create = await capture('aws', [
      'iam', 'create-role',
      '--role-name', names.role,
      '--assume-role-policy-document', cloudBuildTrustPolicy(),
      '--tags', 'Key=Application,Value=claudeclaw',
    ]);
    if (create.code !== 0) throw new CloudBuildError(`iam create-role failed: ${create.stderr.trim()}`);
    created = true;
  }
  // put-role-policy is idempotent; always align the policy with this build's inputs.
  const put = await capture('aws', [
    'iam', 'put-role-policy',
    '--role-name', names.role,
    '--policy-name', names.rolePolicy,
    '--policy-document', cloudBuildRolePolicy(opts),
  ]);
  if (put.code !== 0) throw new CloudBuildError(`iam put-role-policy failed: ${put.stderr.trim()}`);
  return created;
}

async function ensureProject(
  opts: CloudBuildOptions,
  names: CloudBuildNames,
  sourceLocation: string,
  roleArn: string,
  logLine: (l: string) => void,
): Promise<void> {
  const projectSpec = {
    name: names.project,
    description: 'ClaudeClaw Enterprise cloud image build (Docker-free installs). Safe to delete; deploy recreates it.',
    source: { type: 'S3', location: sourceLocation, buildspec: cloudBuildBuildSpec() },
    artifacts: { type: 'NO_ARTIFACTS' },
    environment: {
      type: 'ARM_CONTAINER',
      image: 'aws/codebuild/amazonlinux2-aarch64-standard:3.0',
      computeType: 'BUILD_GENERAL1_LARGE',
      privilegedMode: true,
    },
    serviceRole: roleArn,
    timeoutInMinutes: 30,
    tags: [{ key: 'Application', value: 'claudeclaw' }],
  };
  const existing = await capture('aws', [
    'codebuild', 'batch-get-projects', '--names', names.project, '--region', opts.region, '--output', 'json',
  ]);
  const found =
    existing.code === 0 &&
    (JSON.parse(existing.stdout) as { projects?: unknown[] }).projects?.length === 1;
  const verb = found ? 'update-project' : 'create-project';
  if (!found) logLine(info(`creating CodeBuild project ${names.project}`));
  const r = await capture('aws', [
    'codebuild', verb, '--cli-input-json', JSON.stringify(projectSpec), '--region', opts.region,
  ]);
  if (r.code !== 0) throw new CloudBuildError(`codebuild ${verb} failed: ${r.stderr.trim()}`);
}

async function tailBuildLogs(names: CloudBuildNames, region: string, logLine: (l: string) => void): Promise<void> {
  const r = await capture('aws', [
    'logs', 'tail', names.logGroup, '--since', '30m', '--region', region,
  ]);
  if (r.code === 0 && r.stdout.trim()) {
    logLine(dim('  last build log lines:'));
    for (const line of r.stdout.trim().split('\n').slice(-25)) logLine(dim(`  ${line}`));
  }
}

/**
 * Package, upload, build, and wait. On success the image (tag + latest) is
 * already in the operator's private ECR; the caller resolves the digest from
 * ECR exactly like the local path. Throws on any failure with the log tail.
 */
export async function runCloudBuild(opts: CloudBuildOptions): Promise<void> {
  // eslint-disable-next-line no-console
  const logLine = opts.log ?? ((l: string) => console.log(l));
  const names = cloudBuildNames(opts.ecrRepoName);

  logLine(info('no local Docker needed: building in AWS CodeBuild inside YOUR account (a few cents, ~10 minutes)'));

  // 1. Package tracked source (never .env: git archive ships committed files only).
  const zipPath = await packageSource(opts.repoRoot, logLine);
  const key = `${names.s3Prefix}${opts.imageTag}-${randomUUID().slice(0, 8)}.zip`;

  try {
    // 2. Upload to the state bucket (a bootstrap primitive; exists before any build).
    const cp = await run('aws', ['s3', 'cp', zipPath, `s3://${opts.stateBucket}/${key}`, '--region', opts.region]);
    if (cp !== 0) throw new CloudBuildError('uploading the source zip to the state bucket failed');

    // 3. Role + project (idempotent; IAM propagation gets a grace retry below).
    const roleCreated = await ensureRole(opts, names, logLine);
    const roleArn = `arn:aws:iam::${opts.accountId}:role/${names.role}`;
    if (roleCreated) await sleep(10_000);
    await ensureProject(opts, names, `${opts.stateBucket}/${key}`, roleArn, logLine);

    // 4. Start (one retry for fresh-role propagation), then poll.
    const envOverrides = JSON.stringify([
      { name: 'ECR_HOST', value: opts.ecrHost, type: 'PLAINTEXT' },
      { name: 'ECR_REPO_NAME', value: opts.ecrRepoName, type: 'PLAINTEXT' },
      { name: 'IMAGE_TAG', value: opts.imageTag, type: 'PLAINTEXT' },
      { name: 'DEPLOY_TIER', value: opts.deployTier, type: 'PLAINTEXT' },
    ]);
    let buildId = '';
    for (let attempt = 1; attempt <= 2; attempt++) {
      const start = await capture('aws', [
        'codebuild', 'start-build',
        '--project-name', names.project,
        '--environment-variables-override', envOverrides,
        '--region', opts.region, '--output', 'json',
      ]);
      if (start.code === 0) {
        buildId = (JSON.parse(start.stdout) as { build?: { id?: string } }).build?.id ?? '';
        break;
      }
      if (attempt === 2) throw new CloudBuildError(`codebuild start-build failed: ${start.stderr.trim()}`);
      logLine(dim('  start-build refused (fresh IAM role propagating); retrying in 15s'));
      await sleep(15_000);
    }
    if (!buildId) throw new CloudBuildError('start-build returned no build id');
    logLine(ok(`cloud build started · ${bold(buildId)}`));

    let lastPhase = '';
    const deadline = Date.now() + 35 * 60 * 1000;
    for (;;) {
      await sleep(15_000);
      if (Date.now() > deadline) throw new CloudBuildError('cloud build timed out after 35 minutes');
      const poll = await capture('aws', [
        'codebuild', 'batch-get-builds', '--ids', buildId, '--region', opts.region, '--output', 'json',
      ]);
      if (poll.code !== 0) continue; // transient; keep polling until deadline
      const build = (JSON.parse(poll.stdout) as {
        builds?: Array<{ buildStatus?: string; currentPhase?: string }>;
      }).builds?.[0];
      const status = build?.buildStatus ?? 'IN_PROGRESS';
      const phase = build?.currentPhase ?? '';
      if (phase && phase !== lastPhase) {
        lastPhase = phase;
        logLine(dim(`  cloud build phase: ${phase}`));
      }
      if (isBuildInProgress(status)) continue;
      if (buildSucceeded(status)) {
        logLine(ok('cloud build succeeded · image pushed to your private ECR (arm64 self-verified in the build)'));
        return;
      }
      logLine(fail(`cloud build ended with status ${status}`));
      await tailBuildLogs(names, opts.region, logLine);
      throw new CloudBuildError(`cloud build ${status}; see the log lines above (or CloudWatch ${names.logGroup})`);
    }
  } finally {
    rmSync(join(zipPath, '..'), { recursive: true, force: true });
  }
}
