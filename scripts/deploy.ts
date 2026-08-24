/**
 * Netzar OS Enterprise — Deploy CLI (phased pipeline)
 *
 * IaC readiness plan items 8 / 10 / 13 / 14. Each step prints its outcome
 * before starting the next; phases are idempotent so re-running after a
 * failure picks up cleanly.
 *
 *   1. Pre-check (subset of `npm run status`)
 *   2. PREFLIGHT — read-only doctor checks; any FAIL aborts before any
 *      resource is created (--skip-preflight bypasses with a loud warning)
 *   3. BOOTSTRAP-STATE + MANDATORY LOCK — state bucket / lock table / ECR
 *      repo primitives, then the lifecycle lease lock with heartbeat;
 *      everything after this point releases the lock in a finally block
 *   4. CDK bootstrap detection, auto-run if missing
 *   5. Docker build (linux/arm64) + ECR push + digest resolution + image
 *      manifest ARCHITECTURE verification (arm64 or hard fail)
 *   6. CONFIRMATION GATE (the Tier B money gate)
 *   7. PHASE a — foundation stacks (Network, Storage, Guardrails, Secrets,
 *      Dynamo, Messaging) + scheduler-group existence check
 *   8. PHASE b — populateSecretsV2: per-deploy staging labels, configured
 *      surface write failures are deploy FAILURES with recovery commands
 *   9. PHASE c — idempotent runtime-config seed
 *  10. PHASE d — remaining stacks (--all), force-roll ECS + wait stable so
 *      tasks pick up the phase-b secret versions, post-deploy instructions,
 *      ALB health poll
 *  11. Surface validation (mode-scoped, token-valid vs delivery-verified)
 *  12. Manifest: journal promotion + archived cdk.out (and the legacy
 *      simple manifest for older tooling)
 *  13. Webhook smoke test
 *
 * Flags: --env=staging|<name>, --tier=0|1|2, --yes, --image-only,
 *        --skip-preflight, --resume (informational),
 *        --build-local | --build-cloud (image build mode; the default
 *        auto-detects: local Docker when a daemon is running, otherwise an
 *        in-account CodeBuild build so Docker is never a requirement).
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname, userInfo } from 'node:os';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { SecretsManagerClient, DescribeSecretCommand } from '@aws-sdk/client-secrets-manager';
import { buildPublicTunnelSecretName } from '../infra/lib/public-dashboard-access.js';
import { PUBLIC_SECRET_READY_STAGE } from './lib/public-tunnel/setup.js';
import { DEPLOY_EXIT_DECLINED } from './lib/exit-codes.js';
import { maybePrintHelp } from './lib/help.js';
import { confirm, spinner, closePrompt } from './lib/prompt.js';
import { bold, cyan, dim, fail, gray, info, ok, red, section, warn, yellow } from './lib/ansi.js';
import { run, capture, pipe } from './lib/shell.js';
import { getCallerIdentity, findServiceAnomalyMonitor } from './lib/aws-checks.js';
import { clampTier, resourceSummary, estimateLine } from './lib/cost-gate.js';
import { checkDocker } from './lib/docker-check.js';
import {
  allChecks,
  buildContext,
  resolveFeatures,
  resolveMode,
  runPreflight,
  summarize,
} from './lib/preflight/checks.js';
import { renderCheckResults, renderSummary } from './lib/preflight/render.js';
import { newDeployId } from './lib/lifecycle/ids.js';
import {
  bootstrapState,
  type BootstrapResult,
  type EcrClientLike,
} from './lib/lifecycle/bootstrap-state.js';
import { releaseLock, startHeartbeat } from './lib/lifecycle/lock.js';
import { appendJournal, promoteManifest, s3BodyToString } from './lib/lifecycle/journal.js';
import {
  APP_SCHEMA_VERSION,
  collectSynthInputs,
  MANIFEST_SCHEMA_VERSION,
  type DeployManifest,
  type SecretVersionRecord,
} from './lib/lifecycle/manifest.js';
import {
  buildImageRecords,
  extractGuardrailOutputs,
  hashStackTemplates,
  imageInspectHasArm64,
  imageJsonHasArm64,
  populateSecretsV2,
  resolveRuntimeConfigTable,
  SecretWriteFailure,
  seedRevisionOf,
  XRAY_SIDECAR_DIGEST_FALLBACK,
  xrayDigestFromComputeStackSource,
} from './lib/lifecycle/deploy-phases.js';
import {
  contentImageTag,
  runCloudBuild,
  staleContentTagReason,
} from './lib/lifecycle/cloud-build.js';
import { SEED_DEFAULTS, applyEnvOverrides, runSeed } from './lib/seed-defaults.js';
import { validateConfiguredSurfaces, type SurfaceCheck } from './lib/surface-validate.js';
import { buildApp, buildResourceNames } from '../infra/lib/constants.js';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = dirname(dirname(__filename));

// --env=staging|prod|<name> picks which env file to load.
// prod (default)  → .env
// staging         → .env.staging
// any other value → .env.<value>
function resolveEnvFile(): { name: string; path: string; outputsPath: string } {
  const flag = process.argv.find((a) => a.startsWith('--env='))?.split('=')[1] ?? 'prod';
  const fileName = flag === 'prod' ? '.env' : `.env.${flag}`;
  const outputsName = flag === 'prod' ? 'cdk-outputs.json' : `cdk-outputs.${flag}.json`;
  return {
    name: flag,
    path: join(repoRoot, fileName),
    outputsPath: join(repoRoot, outputsName),
  };
}
const envSpec = resolveEnvFile();
const envPath = envSpec.path;
const outputsPath = envSpec.outputsPath;
// Phase (a) writes its outputs to a sibling file so the foundation outputs
// (Guardrails CfnOutputs) survive phase (d) clearing the main outputs file.
const foundationOutputsPath = outputsPath.replace(/\.json$/, '.foundation.json');

/** Key of the crash-detection marker in the state bucket. */
const IN_PROGRESS_KEY = 'state/in-progress.json';

interface EnvBag {
  AWS_ACCOUNT_ID: string;
  AWS_REGION: string;
  ECR_REPO_NAME: string;
  CDK_STACK_NAME: string;
  DEPLOY_TIER: string;
  DEPLOY_MANIFEST_BUCKET: string;
  [k: string]: string;
}

/**
 * Failure inside the locked region. Thrown (never process.exit) so main's
 * finally block always releases the deploy lock before the process dies.
 */
class DeployAbort extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = 'DeployAbort';
    this.exitCode = exitCode;
  }
}

function nameSuffixFor(env: EnvBag): string {
  // Explicit CCE_NAME_SUFFIX in the env file wins; otherwise the --env flag
  // ('' for prod, the flag value for anything else) — same rule as seed.ts.
  return env.CCE_NAME_SUFFIX ?? (envSpec.name === 'prod' ? '' : envSpec.name);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  // Help must come before EVERYTHING: this command's early phases create
  // the state bucket, lock table, and ECR repo, and a help-asker must
  // never trigger that.
  if (
    maybePrintHelp(args, {
      command: 'npm run deploy',
      oneLiner: 'phased pipeline: preflight, bootstrap, image, money gate, stacks, health',
      flags: [
        ['--env=<name>', 'target .env.<name> instead of .env'],
        ['--tier=<n>', 'override DEPLOY_TIER for this run'],
        ['--yes, -y', 'pre-accept the cost confirmation gate'],
        ['--image-only', 'rebuild + push the image and roll the service; no CDK'],
        ['--build-local | --build-cloud', 'force the image build mode (default auto-detects Docker)'],
        ['--skip-preflight', 'skip the embedded doctor checks (not recommended)'],
      ],
      contract:
        'Creates AWS resources and starts the standing cost; the tier estimate is confirmed at the money gate before any stack.',
      docs: 'AGENTS.md · docs/cost-guide.md',
    })
  ) {
    process.exit(0);
  }
  const skipConfirm = args.includes('--yes') || args.includes('-y');
  const imageOnly = args.includes('--image-only');
  const skipPreflight = args.includes('--skip-preflight');
  const resumeFlag = args.includes('--resume');
  const tierArg = args.find((a) => a.startsWith('--tier='))?.split('=')[1];
  const buildLocalFlag = args.includes('--build-local');
  const buildCloudFlag = args.includes('--build-cloud');
  if (buildLocalFlag && buildCloudFlag) {
    // eslint-disable-next-line no-console
    console.log(fail('--build-local and --build-cloud are mutually exclusive'));
    process.exit(1);
  }
  const buildPref: BuildPref = buildLocalFlag ? 'local' : buildCloudFlag ? 'cloud' : 'auto';

  // eslint-disable-next-line no-console
  console.log('\n' + bold(`Netzar OS Enterprise · Deploy (${envSpec.name})`));
  // eslint-disable-next-line no-console
  console.log(gray('─'.repeat(36)));

  if (resumeFlag) {
    // eslint-disable-next-line no-console
    console.log(
      info(
        '--resume: journal-based phase resume is not implemented yet (it lands with the ' +
          'rollback work). Phases are idempotent, so this run simply continues fresh.',
      ),
    );
  }

  const { env, buildMode } = await preCheck(tierArg, buildPref);
  const nameSuffix = nameSuffixFor(env);

  // ── PREFLIGHT — pure read-only, BEFORE bootstrap-state ──────────────
  if (skipPreflight) {
    // eslint-disable-next-line no-console
    console.log(
      '\n' +
        red(bold('⚠⚠⚠  --skip-preflight set — SKIPPING ALL READ-ONLY PREFLIGHT CHECKS  ⚠⚠⚠')) +
        '\n' +
        yellow(
          '  Missing Bedrock grants, quota shortages, name collisions, and TLS problems\n' +
            '  will now surface MID-DEPLOY instead of before any resource is created.',
        ),
    );
  } else {
    await preflight(env);
  }

  // ── BOOTSTRAP-STATE + MANDATORY LOCK ─────────────────────────────────
  section('Bootstrap state + deploy lock');
  const region = env.AWS_REGION;
  const s3 = new S3Client({ region });
  const ddb = new DynamoDBClient({ region });
  const owner = `${userInfo().username}@${hostname()}#${process.pid}`;
  let boot: BootstrapResult;
  try {
    boot = await bootstrapState(
      { s3, ddb, ecr: cliEcrClient(region) },
      env,
      { owner, operation: 'deploy', leaseMs: 5 * 60_000 },
    );
  } catch (err) {
    // A held lock or a cross-account collision: surface the lib's message
    // cleanly and stop before any further mutation.
    // eslint-disable-next-line no-console
    console.log(fail(err instanceof Error ? err.message : String(err)));
    closePrompt();
    process.exit(1);
    return;
  }
  const { names, lock } = boot;
  const stateBucket = names.stateBucket;
  // eslint-disable-next-line no-console
  console.log(ok(`state bucket ${stateBucket} · lock table ${names.lockTable} · ECR ${names.ecrRepo}`));
  // eslint-disable-next-line no-console
  console.log(ok(`deploy lock acquired by ${owner} (fencing token ${lock.fencingToken}, 5m lease)`));

  const gitShaFull = await currentGitShaFull();
  if (!gitShaFull) {
    await releaseLock(ddb, names.lockTable, lock);
    // eslint-disable-next-line no-console
    console.log(fail('not a git checkout (`git rev-parse HEAD` failed) — the deploy id and manifest need a commit sha'));
    closePrompt();
    process.exit(1);
    return;
  }
  const deployId = newDeployId(gitShaFull);
  // eslint-disable-next-line no-console
  console.log(ok(`deploy id ${bold(deployId)}`));

  // Heartbeat: renew the 5-minute lease every 60s; losing it mid-deploy
  // means another operation took over — abort loudly, never keep mutating.
  const stopHeartbeat = startHeartbeat(ddb, names.lockTable, lock, 60_000, (err) => {
    // eslint-disable-next-line no-console
    console.error(
      red(
        '\nFATAL: deploy lock lost mid-deploy: ' +
          (err instanceof Error ? err.message : String(err)) +
          '\nAnother operation holds the lease now; ABORTING all mutating work immediately.',
      ),
    );
    process.exit(1);
  });

  // Crash detection: a leftover in-progress marker names the prior
  // incomplete deploy. Phases are idempotent, so this run continues fresh;
  // precise journal-based resume lands with the rollback work.
  const prior = await readInProgress(s3, stateBucket);
  if (prior) {
    // eslint-disable-next-line no-console
    console.log(
      warn(
        `a previous deploy (${prior.deployId}, started ${prior.startedAt}) never completed. ` +
          'Phases are idempotent — this run continues fresh and will overwrite the marker.',
      ),
    );
  }
  await writeInProgress(s3, stateBucket, {
    deployId,
    gitSha: gitShaFull,
    startedAt: new Date().toISOString(),
  });

  // Everything after this point runs under the lock; the finally block
  // releases it on success, failure, and operator abort alike.
  let exitCode = 0;
  let journalSeq = 0;
  const journal = async (event: string, data?: Record<string, unknown>): Promise<void> => {
    await appendJournal(s3, stateBucket, {
      deployId,
      seq: journalSeq++,
      event,
      at: new Date().toISOString(),
      fencingToken: lock.fencingToken,
      data,
    });
  };

  try {
    if (!imageOnly) {
      await ensureCdkBootstrap(env);
    }

    // ── Image build (local Docker OR in-account CodeBuild) + digest + arm64 gate ──
    let imageTag: string;
    if (buildMode === 'cloud') {
      section('Cloud image build (no local Docker)');
      imageTag =
        (await currentGitShaShort()) ?? new Date().toISOString().replace(/[:.]/g, '-');
      await ensureEcrRepo(env);
      await runCloudBuild({
        region: env.AWS_REGION,
        accountId: env.AWS_ACCOUNT_ID,
        ecrRepoName: env.ECR_REPO_NAME,
        ecrHost: ecrHostOf(env),
        stateBucket,
        imageTag,
        deployTier: env.DEPLOY_TIER ?? '1',
        repoRoot,
      });
    } else {
      imageTag = await dockerBuild(env);
      await ecrLoginAndPush(env, imageTag);
    }
    const imageDigest = await resolveImageDigest(env, imageTag);
    if (buildMode === 'cloud') {
      // The arm64 gate ran INSIDE the build (native ARM host + explicit
      // architecture self-check that fails the build), so there is no
      // docker binary here to re-inspect with, and none is needed.
      // eslint-disable-next-line no-console
      console.log(ok('image manifest architecture verified inside the cloud build (arm64 self-check)'));
    } else {
      await verifyImageArchitecture(env, imageTag);
    }
    await journal('image-pushed', { imageTag, imageDigest, buildMode });

    if (imageOnly) {
      // eslint-disable-next-line no-console
      console.log('\n' + ok('image-only deploy complete'));
      // eslint-disable-next-line no-console
      console.log(info('Rolling Fargate task with new image: `aws ecs update-service`'));
      await journal('image-only-roll', { imageTag, imageDigest });
      await rollFargateService(env);
      await webhookSmokeTest(env);
      await clearInProgress(s3, stateBucket);
      return;
    }

    // Resolve attach-vs-create for the Cost Anomaly monitor BEFORE the env
    // bag is built: the Guardrails stack deploys in phase a and reads
    // CCE_ANOMALY_MONITOR_ARN from the bag.
    await resolveAnomalyMonitor(env);

    await confirmationGate(env, skipConfirm);

    // Shared by the readiness gate below and phase b further down.
    const secretsClient = new SecretsManagerClient({ region });

    // ── Public connector readiness gate (pgnos design) ───────────────
    // The connector is an ESSENTIAL container reading the `token` JSON field
    // of the tunnel secret. Attaching it before that field exists means ECS
    // cannot resolve the secret, the container never starts, and the rollout
    // of a live service fails. So the first deploy creates the secret only;
    // the connector joins on a later deploy, once `npm run public:setup` has
    // written the token. Existence of the ready stage is the signal; the
    // value behind it is never read here.
    //
    // Runs BEFORE phase a, not between phases c and d where it used to sit.
    // `cdk deploy --exclusively` still SYNTHESIZES the whole app, so
    // ComputeStack is constructed during phase a — with this gate downstream,
    // that synth saw an unset CCE_PUBLIC_CONNECTOR_READY and (once
    // assertPublicEntrypointRenderable landed) aborted the deploy outright.
    // Before that assert existed the same ordering silently emitted a phase-a
    // task definition with no connector. This is read-only DescribeSecret with
    // no dependency on any phase, so the correct place for it is ahead of the
    // first synth.
    if (env.CCE_PUBLIC_ACCESS === '1') {
      let ready = false;
      // Suffix-derived from the parsed env bag, matching what the cdk child
      // will synthesize. Reading the module default would probe PROD's secret
      // from a staging deploy, report a false ready, and attach an essential
      // connector to a token that is still REPLACE_ME.
      const publicSecretId = buildPublicTunnelSecretName(nameSuffix);
      try {
        const described = await secretsClient.send(
          new DescribeSecretCommand({ SecretId: publicSecretId }),
        );
        ready = Object.values(described.VersionIdsToStages ?? {}).some((stages) =>
          (stages ?? []).includes(PUBLIC_SECRET_READY_STAGE),
        );
      } catch (err) {
        if ((err as { name?: string }).name !== 'ResourceNotFoundException') throw err;
      }
      env.CCE_PUBLIC_CONNECTOR_READY = ready ? '1' : '';
      // eslint-disable-next-line no-console
      console.log(
        ready
          ? ok('public connector: token present, attaching the cloudflared sidecar')
          : warn(
              'public connector: no token yet, deploying the secret only. ' +
                'Run `npm run public:setup`, then re-run this deploy to attach the sidecar.',
            ),
      );
    }

    // ── PHASE a — foundation stacks ──────────────────────────────────
    section('Phase a · foundation stacks');
    const prefix = env.CDK_STACK_NAME;
    const paperclipEnabled = env.CCE_PAPERCLIP_ENABLED === '1';
    // Set only by the gated Paperclip build below; stays undefined on an
    // unarmed deploy, and the manifest then carries no Paperclip record.
    let paperclipImageDigest: string | undefined;
    const foundationStacks = [
      `${prefix}-Network`,
      `${prefix}-Storage`,
      `${prefix}-Guardrails`,
      `${prefix}-Secrets`,
      `${prefix}-Dynamo`,
      `${prefix}-Messaging`,
      // Paperclip work engine substrate (ADR 0010): Aurora + EFS/log group.
      // Gated on the SAME flag infra/bin/app.ts reads. Naming them
      // unconditionally does not fail loudly: `cdk deploy` errors only when
      // NO pattern matches, and the six names above always match, so an
      // unsynthesized CCE-Database is dropped SILENTLY and the deploy
      // reports success having created no Aurora and no EFS.
      ...(paperclipEnabled ? [`${prefix}-Database`, `${prefix}-Filesystem`] : []),
    ];
    const foundationOutputs = await cdkDeployStacks(env, imageTag, {
      stacks: foundationStacks,
      outputsFile: foundationOutputsPath,
    });
    await journal('foundation-complete', { stacks: foundationStacks });
    await ensureSchedulerGroup(env, nameSuffix);
    // Paperclip work engine (ADR 0010): the ECR repo the pinned+patched
    // image is built into, just below. Gated on the SAME flag as the two
    // stacks above, so an unarmed deploy creates nothing - the previous
    // ungated version left an empty, uncatalogued repo on every deploy
    // (M23). Named from buildResourceNames so it tracks CCE_NAME_SUFFIX,
    // never a regex over ECR_REPO_NAME. Catalogued as paperclip-ecr-repo
    // and deleted in scripts/teardown.ts's final sweep -- note the catalog
    // only REPORTS, so a row there without that delete would orphan it.
    if (paperclipEnabled) {
      const paperclipRepoName = buildResourceNames(nameSuffix).paperclipEcrRepo;
      await ensureEcrRepo(env, paperclipRepoName);
      // Phase 1.5: build the pinned+patched Paperclip image (ADR 0010) into
      // that repo. ALWAYS through CodeBuild, never the local Docker path:
      // the point of the phase is ONE path that needs no daemon on the
      // operator's machine, and the buildspec's `test "$ARCH" = "arm64"`
      // self-check is the only thing standing between a multi-arch base
      // image and an amd64 container that crash-loops on Fargate. The whole
      // block sits inside the CCE_PAPERCLIP_ENABLED gate, so an unarmed
      // deploy creates no project, starts no build, and pushes no image.
      // The mirror of this on the CI driver is the "Build + Push Paperclip"
      // step in .github/workflows/deploy.yml (CI does NOT run this script).
      //
      // Tagged by CONTENT, never by the app's git sha. vendor/paperclip
      // changes only when its Dockerfile or its patch changes, so an app
      // commit that cannot possibly alter this image must not trigger a
      // fresh ~10 minute ARM build, a second source upload, and another
      // layer set in a repo that has no lifecycle policy - forever, in every
      // customer account, once Paperclip installs by default. The fallback
      // to the app tag only fires outside a git checkout, which the cloud
      // build cannot run in anyway (it packages with git archive).
      const paperclipTag =
        (await contentImageTag(repoRoot, 'vendor/paperclip', 'paperclip')) ?? imageTag;
      const existingPaperclip = await describeImageDigest(env, paperclipTag, paperclipRepoName);
      if (existingPaperclip.digest) {
        // ...but only when the tag can honestly speak for the working tree.
        // paperclipTag hashes HEAD:vendor/paperclip, so uncommitted edits
        // there (the re-pin workflow's own step) leave the tag naming the OLD
        // content, which is already in ECR - and this branch would then print
        // success while shipping the previous image and recording its digest
        // as this deploy's. Same rule on the CI driver, through the same
        // function; its doc comment says why this refuses rather than warns.
        // A DeployAbort so the operator gets the remedy, not a stack trace,
        // and it lands here in phase a: before secrets, before any stack
        // update, before the manifest, so nothing has rolled out.
        const stale = await staleContentTagReason(repoRoot, 'vendor/paperclip', paperclipTag);
        if (stale) throw new DeployAbort(stale);
        // Idempotent re-run: this exact content is already in the operator's
        // ECR. Skip the build and record the EXISTING digest, so the manifest
        // still carries a Paperclip record (requirement 4) and a rollback can
        // still resolve it.
        paperclipImageDigest = existingPaperclip.digest;
        // eslint-disable-next-line no-console
        console.log(
          ok(
            `Paperclip image ${bold(paperclipTag)} already in ${paperclipRepoName}; skipping the build`,
          ),
        );
      } else {
        section('Phase a · Paperclip image build (no local Docker)');
        await runCloudBuild({
          region: env.AWS_REGION,
          accountId: env.AWS_ACCOUNT_ID,
          ecrRepoName: paperclipRepoName,
          ecrHost: ecrHostOf(env),
          stateBucket,
          imageTag: paperclipTag,
          // DEPLOY_TIER reaches the shared buildspec as a --build-arg the
          // vendored Dockerfile declares no ARG for, so it is inert here -
          // which is also why it is correctly absent from the content tag.
          deployTier: env.DEPLOY_TIER ?? '1',
          repoRoot,
          // The Dockerfile COPYs updated-since.patch from beside itself, so
          // the context is the vendor directory, not the repo root.
          dockerfile: 'vendor/paperclip/Dockerfile',
          buildContext: 'vendor/paperclip',
          // No `:latest` in this repo. Its only legitimate consumer is a task
          // definition pinned to the digest recorded in the manifest below,
          // and a mutable tag sitting in a repo with no lifecycle policy is
          // exactly what the next author reaches for instead. The CI driver
          // publishes no `:latest` here either.
          pushLatest: false,
        });
        paperclipImageDigest = await resolveImageDigest(env, paperclipTag, paperclipRepoName);
      }
      await journal('paperclip-image-pushed', {
        imageTag: paperclipTag,
        imageDigest: paperclipImageDigest,
        ecrRepo: paperclipRepoName,
        reusedExisting: existingPaperclip.digest !== null,
      });
    }

    // ── PHASE b — populate + validate secrets ────────────────────────
    section('Phase b · populate secrets (per-deploy staging labels)');
    const secretBase = nameSuffix ? `/claudeclaw-${nameSuffix}` : '/claudeclaw';
    const guardrails = extractGuardrailOutputs(foundationOutputs);
    let secretVersions: SecretVersionRecord[];
    try {
      const result = await populateSecretsV2({
        client: secretsClient,
        env,
        secretBase,
        deployId,
        region,
        guardrails,
        // eslint-disable-next-line no-console
        log: (line) => console.log(ok(line)),
      });
      secretVersions = result.records;
      for (const w of result.warnings) {
        // eslint-disable-next-line no-console
        console.log(warn(w));
      }
      for (const [secretId, labels] of Object.entries(result.pruned)) {
        // eslint-disable-next-line no-console
        console.log(dim(`  pruned ${labels.length} old deploy label(s) from ${secretId}`));
      }
    } catch (err) {
      if (err instanceof SecretWriteFailure) {
        // eslint-disable-next-line no-console
        console.log(fail(err.message));
        // eslint-disable-next-line no-console
        console.log(info('Recovery (then re-run the deploy):'));
        // eslint-disable-next-line no-console
        console.log('  ' + cyan(err.recovery));
        throw new DeployAbort('configured-surface secret write failed');
      }
      throw err;
    }
    await journal('secrets-populated', {
      secrets: secretVersions.map((r) => ({ secretId: r.secretId, versionId: r.versionId })),
    });

    // ── PHASE c — seed runtime-config ────────────────────────────────
    section('Phase c · seed runtime-config defaults');
    const seedRows = applyEnvOverrides(SEED_DEFAULTS, env);
    const seedTable = resolveRuntimeConfigTable(env, envSpec.name);
    const docClient = DynamoDBDocumentClient.from(ddb);
    const seedResult = await runSeed({ ddbClient: docClient, tableName: seedTable, rows: seedRows });
    // eslint-disable-next-line no-console
    console.log(
      ok(
        `seeded ${seedResult.created.length}, left ${seedResult.skipped.length} existing → ${seedTable}`,
      ),
    );
    await journal('seed-complete', {
      created: seedResult.created.length,
      skipped: seedResult.skipped.length,
    });
    const seedRevision = seedRevisionOf(seedRows);

    // ── PHASE d — remaining stacks + force-roll + stability ──────────
    section('Phase d · remaining stacks (cdk deploy --all)');
    const outputs = await cdkDeployStacks(env, imageTag, { outputsFile: outputsPath });
    // Secrets inject at task START: force a new deployment so every task
    // restarts onto the phase-(b) secret versions, then wait for stability.
    await rollFargateService(env);
    await waitForServiceStable(env);
    await postDeployInstructions(env, outputs);
    await waitForAlbHealthy(outputs);
    await journal('compute-complete', { imageTag, imageDigest });

    // ── Surface validation (item 13, mode-scoped) ────────────────────
    const surfacesFailed = await surfaceValidation(env);

    // ── Manifest (item 14) ───────────────────────────────────────────
    section('Deploy manifest');
    const manifest = await assembleManifest({
      env,
      nameSuffix,
      deployId,
      gitSha: gitShaFull,
      imageTag,
      imageDigest,
      paperclipImageDigest,
      secretVersions,
      seedRevision,
      stateBucket,
      s3,
      region,
    });
    await promoteManifest(s3, stateBucket, manifest, lock.fencingToken);
    // eslint-disable-next-line no-console
    console.log(
      ok(`manifest promoted → s3://${stateBucket}/deploys/${deployId}/manifest.json (+ manifests/latest.json)`),
    );
    // DEPRECATED: the legacy simple manifest, kept because older tooling
    // (status/rollback paths predating the lifecycle manifest) may still
    // read it. The lifecycle manifest above is the source of truth.
    await writeDeployManifest(env, imageTag, outputs);

    await clearInProgress(s3, stateBucket);
    await webhookSmokeTest(env);

    // eslint-disable-next-line no-console
    console.log('\n' + bold('Deploy complete.'));
    if (surfacesFailed) {
      // eslint-disable-next-line no-console
      console.log(
        fail(
          'a CONFIGURED surface failed validation — the deploy is recorded in the manifest ' +
            'but is NOT healthy. Fix the remediation items above and re-run `npm run status`.',
        ),
      );
      exitCode = 1;
    } else {
      // eslint-disable-next-line no-console
      console.log(info('Run `npm run status` to verify health.'));
    }
  } catch (err) {
    if (err instanceof DeployAbort) {
      // A decline is a calm exit, not a failure: the gate already printed
      // its own info line, so no red "aborted" banner on top of it.
      if (err.exitCode !== 0 && err.exitCode !== DEPLOY_EXIT_DECLINED) {
        // eslint-disable-next-line no-console
        console.log('\n' + fail(`deploy aborted: ${err.message}`));
      }
      exitCode = err.exitCode;
    } else {
      // eslint-disable-next-line no-console
      console.error(red('\nfatal error during deploy:'));
      // eslint-disable-next-line no-console
      console.error(err);
      exitCode = 1;
    }
  } finally {
    stopHeartbeat();
    try {
      const released = await releaseLock(ddb, names.lockTable, lock);
      // eslint-disable-next-line no-console
      console.log(released ? dim('  deploy lock released') : warn('deploy lock was already taken over (lease lapsed)'));
    } catch (err) {
      // eslint-disable-next-line no-console
      console.log(warn(`failed to release deploy lock: ${err instanceof Error ? err.message : String(err)} — the 5-minute lease will lapse on its own`));
    }
    closePrompt();
  }
  process.exit(exitCode);
}

// ─────────────────────────────────────────────────────────────────────
// Pre-check
// ─────────────────────────────────────────────────────────────────────
type BuildPref = 'auto' | 'local' | 'cloud';
type BuildMode = 'local' | 'cloud';

async function preCheck(
  tierOverride?: string,
  buildPref: BuildPref = 'auto',
): Promise<{ env: EnvBag; buildMode: BuildMode }> {
  section('Pre-check');
  if (!existsSync(envPath)) {
    // eslint-disable-next-line no-console
    console.log(
      fail(
        `No env file at ${envPath}. ` +
          (envSpec.name === 'prod'
            ? 'Run `npm run setup` first.'
            : `Create it by copying .env.staging.example or following docs/staging.md.`),
      ),
    );
    closePrompt();
    process.exit(1);
  }
  const env = parseEnvFile(readFileSync(envPath, 'utf-8')) as EnvBag;
  const required = [
    'AWS_ACCOUNT_ID',
    'AWS_REGION',
    'ECR_REPO_NAME',
    'CDK_STACK_NAME',
  ];
  for (const k of required) {
    if (!env[k]) {
      // eslint-disable-next-line no-console
      console.log(fail(`Missing required env var ${k}. Re-run \`npm run setup\`.`));
      closePrompt();
      process.exit(1);
    }
  }
  if (tierOverride && ['0', '1', '2'].includes(tierOverride)) {
    env.DEPLOY_TIER = tierOverride;
  }
  // eslint-disable-next-line no-console
  console.log(ok(`account ${env.AWS_ACCOUNT_ID} · region ${env.AWS_REGION} · tier ${env.DEPLOY_TIER ?? '1'}`));

  // AWS creds sanity
  const stop = spinner('verifying AWS credentials');
  try {
    await getCallerIdentity(env.AWS_REGION);
    stop(ok('AWS credentials valid'));
  } catch (err) {
    const e = err as { message?: string };
    stop(fail(`AWS credentials invalid: ${e.message ?? err}`));
    closePrompt();
    process.exit(1);
  }

  // Build mode: local Docker when available (fastest), otherwise an
  // in-account CodeBuild image build so Docker is never a REQUIREMENT.
  // --build-local forces the old hard gate; --build-cloud skips Docker
  // even when a daemon is running.
  let buildMode: BuildMode;
  const dock = await checkDocker();
  if (buildPref === 'local') {
    if (!dock.running) {
      // eslint-disable-next-line no-console
      console.log(fail('--build-local set but the Docker daemon is not running.'));
      closePrompt();
      process.exit(1);
    }
    buildMode = 'local';
  } else if (buildPref === 'cloud') {
    buildMode = 'cloud';
  } else {
    buildMode = dock.running ? 'local' : 'cloud';
  }
  if (buildMode === 'local') {
    // eslint-disable-next-line no-console
    console.log(ok(`docker engine ${dock.version ?? 'ok'} · image builds locally`));
  } else {
    // eslint-disable-next-line no-console
    console.log(
      info(
        dock.running
          ? 'build mode: cloud (--build-cloud) · image builds in AWS CodeBuild in your account'
          : 'no running Docker found · image will build in AWS CodeBuild inside your account (a few cents, ~10 min). Docker stays optional; install it later for faster local builds.',
      ),
    );
  }

  return { env, buildMode };
}

// ─────────────────────────────────────────────────────────────────────
// Preflight (read-only, before bootstrap-state)
// ─────────────────────────────────────────────────────────────────────
async function preflight(env: EnvBag): Promise<void> {
  section('Preflight · read-only doctor checks');
  // eslint-disable-next-line no-console
  console.log(dim('  no AWS resource is created, modified, or deleted by these checks\n'));
  const ctx = buildContext(env);
  const results = await runPreflight(ctx, allChecks);
  // eslint-disable-next-line no-console
  const log = (msg: string): void => console.log(msg);
  renderCheckResults(results, log);
  const summary = summarize(results);
  renderSummary(summary, log);
  if (summary.fail > 0) {
    // eslint-disable-next-line no-console
    console.log(
      fail(
        'preflight found blocking problems — aborting BEFORE any resource is created. ' +
          'Fix the FAIL items above (or, at your own risk, re-run with --skip-preflight).',
      ),
    );
    closePrompt();
    process.exit(1);
  }
  if (summary.warn > 0) {
    // eslint-disable-next-line no-console
    console.log(warn('preflight passed with warnings — review the WARN items above'));
  } else {
    // eslint-disable-next-line no-console
    console.log(ok('all preflight checks passed'));
  }
}

// ─────────────────────────────────────────────────────────────────────
// State-bucket in-progress marker (crash detection)
// ─────────────────────────────────────────────────────────────────────
interface InProgressMarker {
  deployId: string;
  gitSha: string;
  startedAt: string;
}

async function readInProgress(s3: S3Client, bucket: string): Promise<InProgressMarker | null> {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: IN_PROGRESS_KEY }));
    return JSON.parse(await s3BodyToString(res.Body)) as InProgressMarker;
  } catch (err) {
    const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (e.name === 'NoSuchKey' || e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404) {
      return null;
    }
    throw err;
  }
}

async function writeInProgress(
  s3: S3Client,
  bucket: string,
  marker: InProgressMarker,
): Promise<void> {
  // Overwrite allowed by design: a stale marker from a crashed deploy is
  // replaced by the new run after the warning is printed.
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: IN_PROGRESS_KEY,
      Body: JSON.stringify(marker, null, 2) + '\n',
      ContentType: 'application/json',
    }),
  );
}

async function clearInProgress(s3: S3Client, bucket: string): Promise<void> {
  await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: IN_PROGRESS_KEY }));
}

// ─────────────────────────────────────────────────────────────────────
// ECR client adapter for bootstrap-state (no @aws-sdk/client-ecr dep)
// ─────────────────────────────────────────────────────────────────────
function cliEcrClient(region: string): EcrClientLike {
  const throwCli = (stderr: string, fallback: string): never => {
    const match = /\(([A-Za-z]+Exception)\)/.exec(stderr);
    const err = new Error(stderr.trim() || fallback);
    err.name = match?.[1] ?? (/RepositoryNotFoundException/.test(stderr)
      ? 'RepositoryNotFoundException'
      : /RepositoryAlreadyExistsException/.test(stderr)
        ? 'RepositoryAlreadyExistsException'
        : 'CliError');
    throw err;
  };
  return {
    async describeRepositories(input: { repositoryNames: string[] }): Promise<unknown> {
      const r = await capture('aws', [
        'ecr', 'describe-repositories',
        '--repository-names', ...input.repositoryNames,
        '--region', region, '--output', 'json',
      ]);
      if (r.code !== 0) throwCli(r.stderr, 'aws ecr describe-repositories failed');
      return r.stdout.trim() ? JSON.parse(r.stdout) : {};
    },
    async createRepository(input: Record<string, unknown>): Promise<unknown> {
      const tags = (input.tags as Array<{ Key: string; Value: string }> | undefined) ?? [];
      const args = [
        'ecr', 'create-repository',
        '--repository-name', String(input.repositoryName),
        '--image-scanning-configuration', 'scanOnPush=true',
        '--region', region, '--output', 'json',
      ];
      if (tags.length > 0) {
        args.push('--tags', ...tags.map((t) => `Key=${t.Key},Value=${t.Value}`));
      }
      const r = await capture('aws', args);
      if (r.code !== 0) throwCli(r.stderr, 'aws ecr create-repository failed');
      return r.stdout.trim() ? JSON.parse(r.stdout) : {};
    },
    async putLifecyclePolicy(input: {
      repositoryName: string;
      lifecyclePolicyText: string;
    }): Promise<unknown> {
      const r = await capture('aws', [
        'ecr', 'put-lifecycle-policy',
        '--repository-name', input.repositoryName,
        '--lifecycle-policy-text', input.lifecyclePolicyText,
        '--region', region, '--output', 'json',
      ]);
      if (r.code !== 0) throwCli(r.stderr, 'aws ecr put-lifecycle-policy failed');
      return r.stdout.trim() ? JSON.parse(r.stdout) : {};
    },
  };
}

// ─────────────────────────────────────────────────────────────────────
// CDK bootstrap detection
// ─────────────────────────────────────────────────────────────────────
async function ensureCdkBootstrap(env: EnvBag): Promise<void> {
  section('CDK bootstrap');
  const stop = spinner('checking for CDKToolkit stack');
  const { code, stderr } = await capture('aws', [
    'cloudformation',
    'describe-stacks',
    '--stack-name',
    'CDKToolkit',
    '--region',
    env.AWS_REGION,
  ]);
  if (code === 0) {
    stop(ok('CDK toolkit already bootstrapped'));
    return;
  }
  if (/does not exist/i.test(stderr)) {
    stop(warn('CDK toolkit not bootstrapped. Running bootstrap...'));
    const bootCode = await run(
      'npx',
      ['cdk', 'bootstrap', `aws://${env.AWS_ACCOUNT_ID}/${env.AWS_REGION}`],
      { cwd: repoRoot },
    );
    if (bootCode !== 0) {
      throw new DeployAbort('cdk bootstrap failed');
    }
    // eslint-disable-next-line no-console
    console.log(ok('CDK bootstrap complete'));
    return;
  }
  stop(fail(`unexpected error: ${stderr.trim()}`));
  throw new DeployAbort('could not determine CDK bootstrap state');
}

// ─────────────────────────────────────────────────────────────────────
// Docker build
// ─────────────────────────────────────────────────────────────────────
async function dockerBuild(env: EnvBag): Promise<string> {
  section('Docker build');
  const gitSha = await currentGitShaShort();
  const tag = gitSha || new Date().toISOString().replace(/[:.]/g, '-');
  const localImage = `${env.ECR_REPO_NAME}:${tag}`;
  // eslint-disable-next-line no-console
  console.log(info(`building ${localImage} (linux/arm64)`));
  // Build pinned to the task runtime platform (IaC readiness item 9):
  // Fargate runs ARM64 (Graviton). An x86 operator's default
  // `docker build` would push an amd64 image that crash-loops with
  // "exec format error", so the platform is explicit everywhere.
  const code = await run(
    'docker',
    [
      'buildx',
      'build',
      '--platform',
      'linux/arm64',
      '--load',
      '-t',
      localImage,
      '--build-arg',
      `DEPLOY_TIER=${env.DEPLOY_TIER ?? '1'}`,
      '--provenance=false',
      '-f',
      'Dockerfile',
      '.',
    ],
    { cwd: repoRoot },
  );
  if (code !== 0) {
    throw new DeployAbort('docker build failed');
  }
  // eslint-disable-next-line no-console
  console.log(ok(`image built · tag ${bold(tag)}`));
  return tag;
}

async function currentGitShaShort(): Promise<string | null> {
  const { code, stdout } = await capture('git', ['rev-parse', '--short=12', 'HEAD'], {
    cwd: repoRoot,
  });
  return code === 0 ? stdout.trim() : null;
}

async function currentGitShaFull(): Promise<string | null> {
  const { code, stdout } = await capture('git', ['rev-parse', 'HEAD'], { cwd: repoRoot });
  return code === 0 ? stdout.trim() : null;
}

async function isCleanTree(): Promise<boolean> {
  const { code, stdout } = await capture('git', ['status', '--porcelain'], { cwd: repoRoot });
  return code === 0 && stdout.trim() === '';
}

// ─────────────────────────────────────────────────────────────────────
// ECR push
// ─────────────────────────────────────────────────────────────────────
function ecrHostOf(env: EnvBag): string {
  return `${env.AWS_ACCOUNT_ID}.dkr.ecr.${env.AWS_REGION}.amazonaws.com`;
}

/** Idempotent ECR repo create, shared by the local and cloud build paths. */
async function ensureEcrRepo(
  env: EnvBag,
  repoName: string = env.ECR_REPO_NAME,
): Promise<void> {
  const desc = await capture('aws', [
    'ecr',
    'describe-repositories',
    '--repository-names',
    repoName,
    '--region',
    env.AWS_REGION,
  ]);
  if (desc.code !== 0) {
    // eslint-disable-next-line no-console
    console.log(info(`creating ECR repo ${repoName}`));
    const created = await run('aws', [
      'ecr',
      'create-repository',
      '--repository-name',
      repoName,
      '--image-scanning-configuration',
      'scanOnPush=true',
      '--region',
      env.AWS_REGION,
    ]);
    if (created !== 0) {
      throw new DeployAbort('failed to create ECR repository');
    }
  }
}

async function ecrLoginAndPush(env: EnvBag, tag: string): Promise<void> {
  section('ECR push');
  const ecrHost = ecrHostOf(env);

  // Orchestrator repo only. The Paperclip repo is created in phase a,
  // gated on CCE_PAPERCLIP_ENABLED, because it belongs with the substrate
  // it serves rather than with the orchestrator's image push.
  await ensureEcrRepo(env);

  // Login
  const loginCode = await pipe(
    { cmd: 'aws', args: ['ecr', 'get-login-password', '--region', env.AWS_REGION] },
    {
      cmd: 'docker',
      args: ['login', '--username', 'AWS', '--password-stdin', ecrHost],
    },
  );
  if (loginCode !== 0) {
    throw new DeployAbort('docker login to ECR failed');
  }
  // eslint-disable-next-line no-console
  console.log(ok(`logged in to ${ecrHost}`));

  // Tag and push
  const localImage = `${env.ECR_REPO_NAME}:${tag}`;
  const remoteSha = `${ecrHost}/${env.ECR_REPO_NAME}:${tag}`;
  const remoteLatest = `${ecrHost}/${env.ECR_REPO_NAME}:latest`;

  await run('docker', ['tag', localImage, remoteSha]);
  await run('docker', ['tag', localImage, remoteLatest]);

  // Push with up to 3 retries on transient failures
  for (let i = 1; i <= 3; i++) {
    const code = await run('docker', ['push', remoteSha]);
    if (code === 0) break;
    if (i === 3) {
      throw new DeployAbort('docker push failed after 3 attempts');
    }
    // eslint-disable-next-line no-console
    console.log(warn(`push attempt ${i} failed, retrying in 10s`));
    await sleep(10_000);
  }
  await run('docker', ['push', remoteLatest]);
  // eslint-disable-next-line no-console
  console.log(ok(`pushed ${bold(remoteSha)}`));
}

/**
 * Digest of a tag already in ECR, or null when that tag is not there.
 *
 * Silent and non-throwing, so it serves two callers: resolveImageDigest
 * below (which turns a null into a labelled abort), and the "has this exact
 * content been built before?" probe in phase a, where absence is the normal
 * case and not an error. `stderr` is carried out so the aborting caller
 * keeps the diagnostic it used to print.
 */
async function describeImageDigest(
  env: EnvBag,
  tag: string,
  repoName: string,
): Promise<{ digest: string | null; stderr: string }> {
  const r = await capture('aws', [
    'ecr',
    'describe-images',
    '--repository-name',
    repoName,
    '--image-ids',
    `imageTag=${tag}`,
    '--region',
    env.AWS_REGION,
    '--output',
    'json',
  ]);
  if (r.code !== 0) return { digest: null, stderr: r.stderr.trim() };
  const parsed = JSON.parse(r.stdout) as { imageDetails?: Array<{ imageDigest?: string }> };
  return { digest: parsed.imageDetails?.[0]?.imageDigest ?? null, stderr: '' };
}

/**
 * Resolve the pushed image's digest from ECR (recorded in the manifest).
 * `repoName` defaults to the orchestrator repo; the Paperclip build passes
 * its own so a rollback can resolve the digest it is rolling back to.
 */
async function resolveImageDigest(
  env: EnvBag,
  tag: string,
  repoName: string = env.ECR_REPO_NAME,
): Promise<string> {
  const stop = spinner(`resolving pushed image digest (${repoName})`);
  const { digest, stderr } = await describeImageDigest(env, tag, repoName);
  if (!digest) {
    stop(fail(`could not describe pushed image${stderr ? `: ${stderr}` : ''}`));
    throw new DeployAbort('pushed image digest could not be resolved');
  }
  stop(ok(`image digest ${bold(digest)}`));
  return digest;
}

/**
 * Item 9: verify the pushed image's manifest architecture matches the
 * Fargate runtime platform (linux/arm64) BEFORE any deploy continues. An
 * x86 operator's default `docker build` pushes amd64 that crash-loops on
 * ARM64 Fargate with "exec format error".
 */
async function verifyImageArchitecture(env: EnvBag, tag: string): Promise<void> {
  const imageRef = `${ecrHostOf(env)}/${env.ECR_REPO_NAME}:${tag}`;
  const stop = spinner('verifying image manifest architecture (linux/arm64)');
  const r = await capture('docker', ['buildx', 'imagetools', 'inspect', imageRef]);
  if (r.code !== 0) {
    stop(fail(`docker buildx imagetools inspect failed: ${r.stderr.trim()}`));
    throw new DeployAbort('could not inspect the pushed image manifest to verify its architecture');
  }
  // Index/manifest-list case: the default output lists linux/arm64 directly.
  if (imageInspectHasArm64(r.stdout)) {
    stop(ok('image manifest architecture verified: linux/arm64'));
    return;
  }
  // Single-manifest case: the default output omits the platform line, so fall
  // back to the structured form and read .image.architecture.
  const j = await capture('docker', [
    'buildx', 'imagetools', 'inspect', imageRef, '--format', '{{json .}}',
  ]);
  if (j.code === 0 && imageJsonHasArm64(j.stdout)) {
    stop(ok('image manifest architecture verified: linux/arm64'));
    return;
  }
  // Only fail when BOTH the index check and the JSON check miss.
  stop(fail('pushed image manifest does NOT include linux/arm64'));
  // eslint-disable-next-line no-console
  console.log(
    warn(
      '  The Fargate task runtime is ARM64 (Graviton); this image would crash-loop with\n' +
        '  "exec format error". This usually means a default x86 `docker build` produced\n' +
        '  an amd64 image. Rebuild with: docker buildx build --platform linux/arm64 ...\n' +
        '  (the deploy script does this — check for a Docker context/builder override).',
    ),
  );
  throw new DeployAbort('image architecture mismatch: linux/arm64 required');
}

// ─────────────────────────────────────────────────────────────────────
// Cost Anomaly monitor resolution (attach vs create, issue #49)
// ─────────────────────────────────────────────────────────────────────

/**
 * AWS allows exactly ONE DIMENSIONAL/SERVICE Cost Anomaly monitor per
 * account and auto-creates "Default-Services-Monitor" the first time anomaly
 * detection is enabled, so the CostGuardrails default create collides on
 * most non-fresh accounts. When the operator has not pinned
 * CCE_ANOMALY_MONITOR_ARN, discover the existing monitor here and pin it in
 * the env bag so the stack attaches its subscription instead of creating a
 * duplicate. Fail-soft and read-only: on any error (usually a missing
 * ce:GetAnomalyMonitors grant) we warn and keep the old create-path
 * behavior rather than block the deploy.
 */
async function resolveAnomalyMonitor(env: EnvBag): Promise<void> {
  const pinned = (env.CCE_ANOMALY_MONITOR_ARN ?? '').trim();
  if (pinned !== '') {
    // eslint-disable-next-line no-console
    console.log(dim(`  anomaly monitor pinned via CCE_ANOMALY_MONITOR_ARN: ${pinned}`));
    return;
  }
  const stop = spinner('checking for an existing Cost Anomaly service monitor');
  try {
    const existing = await findServiceAnomalyMonitor();
    if (existing) {
      env.CCE_ANOMALY_MONITOR_ARN = existing.arn;
      stop(
        ok(
          `existing service anomaly monitor found ("${existing.name}"); attaching to it instead of creating one`,
        ),
      );
    } else {
      stop(ok('no existing service anomaly monitor; the CostGuardrails stack will create one'));
    }
  } catch (err) {
    stop(
      warn(
        `could not list Cost Anomaly monitors (${err instanceof Error ? err.message : String(err)}); ` +
          'proceeding with the create path. If this account already has a service monitor the ' +
          'CostGuardrails stack will fail with AlreadyExists; set CCE_ANOMALY_MONITOR_ARN in .env to attach instead.',
      ),
    );
  }
}

// ─────────────────────────────────────────────────────────────────────
// Confirmation gate (Tier B money gate)
// ─────────────────────────────────────────────────────────────────────
async function confirmationGate(env: EnvBag, skipConfirm: boolean): Promise<void> {
  section('Confirmation · this is the money gate');
  const tierId = clampTier(env.DEPLOY_TIER);
  const privateEndpoints = env.CCE_PRIVATE_ENDPOINTS === '1';
  const paperclipEnabled = env.CCE_PAPERCLIP_ENABLED === '1';
  // The dollar figure comes from the repo's recalculable estimator so the
  // gate can never drift from docs/cost-guide.md. Fail-soft: a broken spawn
  // falls back to the static per-tier range inside estimateLine.
  let estimatorJson: string | null = null;
  try {
    const est = await capture(process.execPath, [
      join(repoRoot, 'scripts', 'cost-estimate.mjs'),
      `--tier=${tierId}`,
      '--json',
      ...(privateEndpoints ? ['--private-endpoints'] : []),
    ]);
    if (est.code === 0) estimatorJson = est.stdout;
  } catch {
    // estimateLine falls back to the docs range
  }
  // eslint-disable-next-line no-console
  console.log(
    [
      `  ${dim('account ')}${bold(env.AWS_ACCOUNT_ID)}`,
      `  ${dim('region  ')}${bold(env.AWS_REGION)}`,
      `  ${dim('stack   ')}${bold(env.CDK_STACK_NAME)}`,
      `  ${dim('tier    ')}${bold(String(tierId))}`,
    ].join('\n'),
  );
  // eslint-disable-next-line no-console
  console.log(
    '\n' +
      yellow(
        `  A first deploy at tier ${tierId} creates ${resourceSummary(tierId, privateEndpoints, paperclipEnabled)}.\n` +
          `  Approximate monthly cost: ${estimateLine(estimatorJson, tierId, privateEndpoints, paperclipEnabled)}.\n` +
          '  Resources are RETAINED on stack destroy and require manual deletion.',
      ),
  );
  if (skipConfirm) {
    // eslint-disable-next-line no-console
    console.log(dim('  --yes flag set, proceeding without prompt'));
    return;
  }
  const proceed = await confirm('\nProceed with cdk deploy?', false);
  if (!proceed) {
    // eslint-disable-next-line no-console
    console.log(info('Deploy aborted. Image was already pushed to ECR; re-run when ready.'));
    // Distinct exit code, NOT 0: a decline used to exit 0 and the up
    // conductor read that as a finished deploy and ran verify on nothing.
    throw new DeployAbort('operator declined at the confirmation gate', DEPLOY_EXIT_DECLINED);
  }
}

// ─────────────────────────────────────────────────────────────────────
// cdk deploy — shared env bag + phased stack deploys
// ─────────────────────────────────────────────────────────────────────

/**
 * The env bag every cdk invocation gets (phases a and d use the SAME one,
 * and the manifest's synthInputs allowlist reads from it too).
 */
function cdkEnvBag(env: EnvBag, imageTag: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CDK_DEFAULT_ACCOUNT: env.AWS_ACCOUNT_ID,
    CDK_DEFAULT_REGION: env.AWS_REGION,
    DEPLOY_TIER: env.DEPLOY_TIER ?? '1',
    CDK_STACK_NAME: env.CDK_STACK_NAME,
    // Suffix every named resource (`claudeclaw[-suffix]-*`) so staging
    // can sit alongside prod in the same account without collisions.
    // Empty for prod (default), `staging` for staging.
    CCE_NAME_SUFFIX: nameSuffixFor(env),
    // Forward Bedrock model IDs so the compute stack can inject them
    // into the task definition. Without these forwards, the
    // `process.env.BEDROCK_*` reads in `compute-stack.ts` would be undefined.
    BEDROCK_OPUS_MODEL: env.BEDROCK_OPUS_MODEL ?? '',
    BEDROCK_SONNET_MODEL: env.BEDROCK_SONNET_MODEL ?? '',
    BEDROCK_DEFAULT_MODEL:
      env.BEDROCK_DEFAULT_MODEL ?? env.BEDROCK_SONNET_MODEL ?? env.BEDROCK_HAIKU_MODEL ?? '',
    BEDROCK_HAIKU_MODEL: env.BEDROCK_HAIKU_MODEL ?? '',
    BEDROCK_OPUS_1M_MODEL: env.BEDROCK_OPUS_1M_MODEL ?? '',
    BEDROCK_SONNET_1M_MODEL: env.BEDROCK_SONNET_1M_MODEL ?? '',
    BEDROCK_EMBED_MODEL: env.BEDROCK_EMBED_MODEL ?? 'amazon.titan-embed-text-v2:0',
    // Optional ACM cert for HTTPS listener (Block 2 C7)
    ACM_CERT_ARN: env.ACM_CERT_ARN ?? '',
    // Optional domain name. If set, CDK auto-issues cert + DNS record
    // via Route 53 (requires the apex zone to be in Route 53).
    DOMAIN_NAME: env.DOMAIN_NAME ?? '',
    // Delegated-subzone override (#23, merged in #45): compute-stack reads
    // these from process.env to skip the apex `HostedZone.fromLookup` when the
    // apex lives outside this account's Route 53. They were never added to this
    // bag, so setting them in .env silently no-opped — the override only took
    // effect when exported inline. Forward them like every other deploy var.
    HOSTED_ZONE_ID: env.HOSTED_ZONE_ID ?? '',
    HOSTED_ZONE_NAME: env.HOSTED_ZONE_NAME ?? '',
    // cost-guardrails-stack attaches its anomaly subscription to an existing
    // account monitor when this is set (shared-account / pre-existing
    // Default-Services-Monitor case). Also read from process.env in-stack, and
    // also never forwarded — so the .env hatch for the one-monitor-per-account
    // collision didn't work either. When unset in .env, resolveAnomalyMonitor
    // fills it in from ce:GetAnomalyMonitors before this bag is built.
    CCE_ANOMALY_MONITOR_ARN: env.CCE_ANOMALY_MONITOR_ARN ?? '',
    // network-stack reads this from process.env to decide whether to create
    // the ~15 opt-in VPC interface endpoints. Same silent-no-op bug class as
    // the zone override above: without this forward, setting it in .env did
    // nothing and only an inline export worked.
    CCE_PRIVATE_ENDPOINTS: env.CCE_PRIVATE_ENDPOINTS ?? '',
    // Paperclip Aurora/EFS substrate (ADR 0010), read by infra/bin/app.ts.
    // Same allowlist trap as the three above, and it bit hardest here:
    // without this forward, CCE_PAPERCLIP_ENABLED=1 in .env armed NOTHING —
    // synth never saw the flag so the stacks were omitted, while phase a
    // still named them, and `cdk deploy` drops unmatched names silently when
    // other names match. The deploy reported green having created no Aurora
    // and no EFS. Normalized to '1'/'' so this and the phase-a list can never
    // disagree with app.ts's strict `=== '1'`.
    CCE_PAPERCLIP_ENABLED: env.CCE_PAPERCLIP_ENABLED === '1' ? '1' : '',
    // Magic-link email config + Jarvis greeting. compute-stack reads these
    // from process.env (CCE_EMAIL_FROM/CCE_DASHBOARD_URL/CCE_SES_CONFIG_SET
    // default to '', JARVIS_GREETING to a generic line). Without forwarding
    // them here a deploy blanks the email vars — every magic-link send skips
    // with reason "unconfigured" — and resets the greeting. The same vars are
    // mirrored in .github/workflows/cdk-drift.yml (from repo Variables) so the
    // drift check synthesizes the deployed values instead of flagging them.
    CCE_EMAIL_FROM: env.CCE_EMAIL_FROM ?? '',
    CCE_DASHBOARD_URL: env.CCE_DASHBOARD_URL ?? '',
    CCE_SES_CONFIG_SET: env.CCE_SES_CONFIG_SET ?? '',
    // Only forward the greeting when set: compute-stack has a non-empty
    // default and forwarding '' would override it with a blank greeting.
    ...(env.JARVIS_GREETING ? { JARVIS_GREETING: env.JARVIS_GREETING } : {}),
    // CI enablement is two independent opt-in paths, both default OFF:
    // GitHub Actions OIDC (CCE_CICD_ENABLED) and CodeBuild tag deploys
    // (CCE_CODEBUILD_ENABLED). Either one requires an EXPLICIT GitHub
    // owner/repo in .env — synth fails closed with no default, so a
    // fork can never inherit the upstream repo's deploy authority.
    // Immutable per-deploy image tag (IaC readiness item 9): the task
    // definition pins THIS tag, never `latest`.
    CCE_IMAGE_TAG: imageTag,
    // Deployment mode reaches synth (deploy-mode.ts drives the
    // internal-ALB/infra-only branches in compute-stack).
    CCE_DEPLOY_MODE: env.CCE_DEPLOY_MODE ?? '',
    // Private WARP access (opt-in, default OFF). warp-private-access.ts reads
    // these from process.env during synth to decide whether the cloudflared
    // sidecar and the Route 53 private zone exist at all. Both are
    // NON-SECRET: a flag and a hostname. The connector TOKEN never travels
    // this path — it goes cloudflared -> Secrets Manager -> container, and is
    // deliberately absent from this bag, the manifest, and cdk.out.
    CCE_WARP_PRIVATE_ACCESS: env.CCE_WARP_PRIVATE_ACCESS ?? '',
    CCE_PUBLIC_ACCESS: env.CCE_PUBLIC_ACCESS ?? '',
    CCE_PUBLIC_HOSTNAME: env.CCE_PUBLIC_HOSTNAME ?? '',
    // Set by the readiness gate below, never by the operator's env file: the
    // connector may only join the task once its token actually exists.
    CCE_PUBLIC_CONNECTOR_READY: env.CCE_PUBLIC_CONNECTOR_READY ?? '',
    CCE_WARP_PRIVATE_HOSTNAME: env.CCE_WARP_PRIVATE_HOSTNAME ?? '',
    // Ops alert destination. This bag is an ALLOWLIST, so a variable that is
    // set in .env but missing here never reaches synth. That is exactly what
    // happened on the 2026-08-15 staging deploy: CCE_OPS_ALERT_EMAIL was set
    // in .env.staging, the deploy succeeded, every outage alarm was created —
    // and the SNS topic still had zero subscribers, because the value never
    // crossed into the cdk child process.
    CCE_OPS_ALERT_EMAIL: env.CCE_OPS_ALERT_EMAIL ?? '',
    CCE_CICD_ENABLED: env.CCE_CICD_ENABLED ?? '',
    CCE_CODEBUILD_ENABLED: env.CCE_CODEBUILD_ENABLED ?? '',
    // Opt-in IAM-copilot write grant (default off). Set CCE_IAM_COPILOT_WRITE=1
    // in .env to keep the in-dashboard IAM-apply capability across deploys;
    // without it iam-stack omits the write grant (and a clean deploy drops it).
    CCE_IAM_COPILOT_WRITE: env.CCE_IAM_COPILOT_WRITE ?? '',
    // Opt-in managed-policy constructs (item 27), default OFF. Installs
    // with live-attached copies keep these off (policy-name conflict).
    CCE_POLICY_IAM_COPILOT: env.CCE_POLICY_IAM_COPILOT ?? '',
    CCE_POLICY_PLAYGROUND_NONANTHROPIC: env.CCE_POLICY_PLAYGROUND_NONANTHROPIC ?? '',
    CCE_POLICY_COST_REMEDIATION: env.CCE_POLICY_COST_REMEDIATION ?? '',
    CCE_GITHUB_OWNER: env.CCE_GITHUB_OWNER ?? '',
    CCE_GITHUB_REPO: env.CCE_GITHUB_REPO ?? '',
    CCE_GITHUB_BRANCH: env.CCE_GITHUB_BRANCH ?? '',
    CCE_GITHUB_DEPLOY_REFS: env.CCE_GITHUB_DEPLOY_REFS ?? '',
    CCE_GITHUB_DEPLOY_ENVIRONMENTS: env.CCE_GITHUB_DEPLOY_ENVIRONMENTS ?? '',
  };
}

/**
 * Run `cdk deploy` for either an explicit stack list (--exclusively, used
 * by phase a) or --all (phase d), returning the parsed outputs file.
 */
async function cdkDeployStacks(
  env: EnvBag,
  imageTag: string,
  opts: { stacks?: string[]; outputsFile: string },
): Promise<Record<string, Record<string, string>>> {
  if (existsSync(opts.outputsFile)) {
    writeFileSync(opts.outputsFile, '{}'); // clear stale outputs
  }
  const stackArgs = opts.stacks ? [...opts.stacks, '--exclusively'] : ['--all'];
  const code = await run(
    'npx',
    ['cdk', 'deploy', ...stackArgs, '--require-approval', 'never', '--outputs-file', opts.outputsFile],
    { cwd: repoRoot, env: cdkEnvBag(env, imageTag) },
  );
  if (code !== 0) {
    // eslint-disable-next-line no-console
    console.log(fail('cdk deploy failed. Inspect CloudFormation events:'));
    // eslint-disable-next-line no-console
    console.log(
      info(`aws cloudformation describe-stack-events --stack-name ${env.CDK_STACK_NAME}-Compute --region ${env.AWS_REGION}`),
    );
    throw new DeployAbort(`cdk deploy failed (${opts.stacks ? opts.stacks.join(', ') : '--all'})`);
  }
  if (!existsSync(opts.outputsFile)) {
    throw new DeployAbort(`${opts.outputsFile} missing after deploy`);
  }
  return JSON.parse(readFileSync(opts.outputsFile, 'utf-8')) as Record<string, Record<string, string>>;
}

/**
 * Item 8: the EventBridge Scheduler GROUP must exist before Compute
 * (which schedules into it) ever starts. The Messaging stack owns the
 * group's NAME, but the group itself cannot live in CloudFormation:
 * the original prod group was created out-of-band, and adding an
 * AWS::Scheduler::ScheduleGroup with the same explicit name would fail
 * every existing install's next Messaging deploy with AlreadyExists.
 * So deploy CREATES it idempotently here (tagged, cataloged in
 * docs/out-of-band-catalog.json, deleted by teardown), then verifies.
 * Runtime-created schedules INSIDE it remain app data.
 */
async function ensureSchedulerGroup(env: EnvBag, nameSuffix: string): Promise<void> {
  const groupName = buildResourceNames(nameSuffix).schedulerGroupName;
  const stop = spinner(`ensuring EventBridge Scheduler group ${groupName}`);
  const get = await capture('aws', [
    'scheduler',
    'get-schedule-group',
    '--name',
    groupName,
    '--region',
    env.AWS_REGION,
  ]);
  if (get.code === 0) {
    stop(ok(`scheduler group ${groupName} exists`));
    return;
  }
  const create = await capture('aws', [
    'scheduler',
    'create-schedule-group',
    '--name',
    groupName,
    '--tags',
    'Key=app,Value=claudeclaw',
    'Key=claudeclaw:component,Value=scheduler-group',
    '--region',
    env.AWS_REGION,
  ]);
  if (create.code !== 0) {
    stop(fail(`scheduler group ${groupName} missing and could not be created`));
    // eslint-disable-next-line no-console
    console.log(
      warn(
        `  Compute schedules into this group and must NOT start without it.\n` +
          `  Check: aws scheduler get-schedule-group --name ${groupName} --region ${env.AWS_REGION}\n` +
          `  Error: ${create.stderr.trim()}`,
      ),
    );
    throw new DeployAbort('EventBridge Scheduler group missing after foundation phase');
  }
  stop(ok(`scheduler group ${groupName} created`));
}

// ─────────────────────────────────────────────────────────────────────
// Surface validation (item 13, mode-scoped)
// ─────────────────────────────────────────────────────────────────────
function surfaceCheckLine(check: SurfaceCheck): string {
  switch (check.status) {
    case 'delivery-verified':
      return ok(`${check.id} ${dim('·')} ${bold('delivery-verified')}`);
    case 'token-valid':
      // Distinct from delivery-verified on purpose: the credential works,
      // but a real round-trip through OUR endpoint has not been proven.
      return info(`${check.id} ${dim('·')} ${yellow('token-valid (delivery not proven)')}`);
    case 'fail':
      return fail(`${check.id}`);
    case 'skip':
      return `${gray('—')}  ${gray(check.id)}`;
  }
}

async function surfaceValidation(env: EnvBag): Promise<boolean> {
  section('Surface validation');
  const mode = resolveMode(env);
  const record: Record<string, string | undefined> = { ...env };
  if (mode === 'infra-only') {
    // infra-only has NO chat surfaces by definition: skip Slack/Telegram
    // entirely; the dashboard is validated only when a domain exists (the
    // no-domain tunnel path is exercised by `npm run verify`, P2).
    delete record.SLACK_BOT_TOKEN;
    delete record.SLACK_SIGNING_SECRET;
    delete record.SLACK_APP_TOKEN;
    delete record.TELEGRAM_TOKENS_JSON;
    delete record.TELEGRAM_WEBHOOK_SECRET;
    // eslint-disable-next-line no-console
    console.log(dim('  mode infra-only · chat surfaces skipped; dashboard validated only with a domain'));
    if (!env.DOMAIN_NAME) {
      // eslint-disable-next-line no-console
      console.log(dim('  no DOMAIN_NAME — dashboard reachable via the private tunnel; `npm run verify` covers that path'));
      return false;
    }
  }
  const { checks, anyConfiguredFailed } = await validateConfiguredSurfaces(record, {
    register: true,
  });
  if (checks.length === 0) {
    // eslint-disable-next-line no-console
    console.log(dim('  no configured surfaces to validate'));
    return false;
  }
  for (const check of checks) {
    // eslint-disable-next-line no-console
    console.log(surfaceCheckLine(check));
    for (const line of check.detail.split('\n')) {
      // eslint-disable-next-line no-console
      console.log(dim(`     ${line}`));
    }
    if (check.remediation) {
      for (const line of check.remediation.split('\n')) {
        // eslint-disable-next-line no-console
        console.log(dim(`     ↳ ${line}`));
      }
    }
  }
  return anyConfiguredFailed;
}

// ─────────────────────────────────────────────────────────────────────
// Lifecycle manifest assembly (item 14)
// ─────────────────────────────────────────────────────────────────────
async function assembleManifest(opts: {
  env: EnvBag;
  nameSuffix: string;
  deployId: string;
  gitSha: string;
  imageTag: string;
  imageDigest: string;
  /** Present only when the gated Paperclip image build ran this deploy. */
  paperclipImageDigest?: string;
  secretVersions: SecretVersionRecord[];
  seedRevision: string;
  stateBucket: string;
  s3: S3Client;
  region: string;
}): Promise<DeployManifest> {
  const { env, nameSuffix, deployId } = opts;
  const tier = Number(env.DEPLOY_TIER ?? '1');
  const app = buildApp(nameSuffix);
  const repoUri = `${ecrHostOf(env)}/${env.ECR_REPO_NAME}`;
  const paperclipRepoUri = `${ecrHostOf(env)}/${buildResourceNames(nameSuffix).paperclipEcrRepo}`;

  // X-Ray sidecar digest: read from the compute-stack source so the record
  // can never drift from the task definition (fallback constant otherwise).
  let xrayDigest = XRAY_SIDECAR_DIGEST_FALLBACK;
  try {
    const source = readFileSync(join(repoRoot, 'infra/lib/compute-stack.ts'), 'utf-8');
    xrayDigest = xrayDigestFromComputeStackSource(source) ?? XRAY_SIDECAR_DIGEST_FALLBACK;
  } catch {
    // fallback constant stands
  }

  const cdkVersionOut = await capture('npx', ['cdk', '--version'], { cwd: repoRoot });
  const cdkVersion = cdkVersionOut.code === 0 ? cdkVersionOut.stdout.trim() : 'unknown';

  const cdkOutDir = join(repoRoot, 'cdk.out');
  const stackTemplateHashes = existsSync(cdkOutDir) ? hashStackTemplates(cdkOutDir) : {};
  const stacks = Object.keys(stackTemplateHashes).sort();

  // Archive the COMPLETE cdk.out (templates + asset manifests + checksums):
  // item 19's infra rollback redeploys this artifact, not template hashes.
  let cdkOutArchiveKey: string | undefined;
  if (existsSync(cdkOutDir)) {
    const zipPath = join(tmpdir(), `cce-cdk-out-${deployId}.zip`);
    const zipped = await run('zip', ['-r', '-q', zipPath, 'cdk.out'], { cwd: repoRoot });
    if (zipped === 0) {
      const key = `deploys/${deployId}/cdk.out.zip`;
      const cp = await run('aws', [
        's3',
        'cp',
        zipPath,
        `s3://${opts.stateBucket}/${key}`,
        '--region',
        opts.region,
      ]);
      if (cp === 0) {
        cdkOutArchiveKey = key;
        // eslint-disable-next-line no-console
        console.log(ok(`cdk.out archived → s3://${opts.stateBucket}/${key}`));
      } else {
        // eslint-disable-next-line no-console
        console.log(warn('cdk.out archive upload failed — manifest will have no cdkOutArchiveKey (infra rollback falls back to git + synth)'));
      }
    } else {
      // eslint-disable-next-line no-console
      console.log(warn('zipping cdk.out failed — manifest will have no cdkOutArchiveKey'));
    }
  }

  const features = resolveFeatures(env);
  const envBag = cdkEnvBag(env, opts.imageTag);

  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    appSchemaVersion: APP_SCHEMA_VERSION,
    deployId,
    gitSha: opts.gitSha,
    cleanTree: await isCleanTree(),
    account: env.AWS_ACCOUNT_ID,
    region: env.AWS_REGION,
    tier,
    mode: resolveMode(env),
    featureFlags: {
      imageGen: features.imageGen,
      tts: features.tts,
      knowledge: features.knowledge,
      jarvisVoice: features.jarvisVoice,
    },
    imageTag: opts.imageTag,
    imageDigest: opts.imageDigest,
    ecrRepo: env.ECR_REPO_NAME,
    images: buildImageRecords({
      app,
      repoUri,
      imageDigest: opts.imageDigest,
      tier,
      xrayDigest,
      paperclipRepoUri,
      paperclipDigest: opts.paperclipImageDigest,
    }),
    cdkVersion,
    synthInputs: collectSynthInputs(envBag as Record<string, string | undefined>),
    stacks,
    stackTemplateHashes,
    secretVersions: opts.secretVersions,
    seedRevision: opts.seedRevision,
    cdkOutArchiveKey,
    deployedAt: new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────────────
// Deploy manifest (LEGACY)
// ─────────────────────────────────────────────────────────────────────
/**
 * @deprecated The lifecycle manifest (assembleManifest + promoteManifest)
 * is the source of truth; this simple manifest is still written at its
 * original S3 key because other tooling may read it. Remove once status/
 * rollback fully migrate to the lifecycle manifest.
 */
async function writeDeployManifest(
  env: EnvBag,
  imageTag: string,
  outputs: Record<string, Record<string, string>>,
): Promise<void> {
  const manifest = {
    version: imageTag,
    deployedAt: new Date().toISOString(),
    tier: Number(env.DEPLOY_TIER ?? '1'),
    region: env.AWS_REGION,
    account: env.AWS_ACCOUNT_ID,
    stack: env.CDK_STACK_NAME,
    outputs,
  };
  const tmpPath = join(repoRoot, 'deployment-manifest.json');
  writeFileSync(tmpPath, JSON.stringify(manifest, null, 2));

  if (env.DEPLOY_MANIFEST_BUCKET) {
    // Ensure bucket exists; create if not.
    const headBucket = await capture('aws', [
      's3api',
      'head-bucket',
      '--bucket',
      env.DEPLOY_MANIFEST_BUCKET,
      '--region',
      env.AWS_REGION,
    ]);
    if (headBucket.code !== 0) {
      // eslint-disable-next-line no-console
      console.log(info(`creating deployment manifest bucket ${env.DEPLOY_MANIFEST_BUCKET}`));
      const createArgs =
        env.AWS_REGION === 'us-east-1'
          ? ['s3api', 'create-bucket', '--bucket', env.DEPLOY_MANIFEST_BUCKET, '--region', env.AWS_REGION]
          : [
              's3api',
              'create-bucket',
              '--bucket',
              env.DEPLOY_MANIFEST_BUCKET,
              '--region',
              env.AWS_REGION,
              '--create-bucket-configuration',
              `LocationConstraint=${env.AWS_REGION}`,
            ];
      await run('aws', createArgs);
    }
    const cp = await run('aws', [
      's3',
      'cp',
      tmpPath,
      `s3://${env.DEPLOY_MANIFEST_BUCKET}/deployments/${imageTag}/manifest.json`,
      '--region',
      env.AWS_REGION,
    ]);
    if (cp === 0) {
      // eslint-disable-next-line no-console
      console.log(ok(`legacy manifest uploaded to s3://${env.DEPLOY_MANIFEST_BUCKET}/deployments/${imageTag}/manifest.json`));
    } else {
      // eslint-disable-next-line no-console
      console.log(warn('legacy manifest upload failed; local copy retained'));
    }
  } else {
    // eslint-disable-next-line no-console
    console.log(dim('  no DEPLOY_MANIFEST_BUCKET configured; skipping legacy manifest S3 upload'));
  }
}

// ─────────────────────────────────────────────────────────────────────
// Post-deploy instructions
// ─────────────────────────────────────────────────────────────────────
async function postDeployInstructions(
  env: EnvBag,
  outputs: Record<string, Record<string, string>>,
): Promise<void> {
  section('Post-deploy · manual steps');

  const computeOutputs = findStackOutputs(outputs, 'Compute');
  const albDns = computeOutputs?.AlbDnsName ?? null;

  if (!albDns) {
    // eslint-disable-next-line no-console
    console.log(
      warn(
        'ALB DNS name not found in CDK outputs yet. Compute stack will expose it in session 3.',
      ),
    );
    return;
  }
  const useHttps = Boolean(env.DOMAIN_NAME || env.ACM_CERT_ARN);
  const scheme = useHttps ? 'https' : 'http';
  // Prefer the friendly DOMAIN_NAME for URL strings if configured
  const publicHost = env.DOMAIN_NAME && env.DOMAIN_NAME.length > 0 ? env.DOMAIN_NAME : albDns;
  if (!useHttps) {
    // eslint-disable-next-line no-console
    console.log(
      warn(
        'ALB is HTTP-only. Slack and Telegram webhooks require HTTPS and will NOT accept this URL. Set DOMAIN_NAME (Route 53 auto-cert) or ACM_CERT_ARN and re-deploy.',
      ),
    );
  }
  // eslint-disable-next-line no-console
  console.log(ok(`ALB ${bold(albDns)}`));
  if (publicHost !== albDns) {
    // eslint-disable-next-line no-console
    console.log(ok(`Domain ${bold(publicHost)}`));
  }
  // eslint-disable-next-line no-console
  console.log('\n  1. Slack Event Subscription URL:');
  // eslint-disable-next-line no-console
  console.log('     ' + cyan(`${scheme}://${publicHost}/slack/events`));
  // eslint-disable-next-line no-console
  console.log('     ' + dim('paste into api.slack.com > your app > Event Subscriptions'));

  const envParsed = parseEnvFile(readFileSync(envPath, 'utf-8'));
  if (envParsed.TELEGRAM_TOKENS_JSON && scheme === 'https') {
    // eslint-disable-next-line no-console
    console.log('\n  2. Telegram webhook URL:');
    // eslint-disable-next-line no-console
    console.log('     ' + cyan(`${scheme}://${publicHost}/tg/main/webhook`));
    // eslint-disable-next-line no-console
    console.log('     ' + dim('surface validation registers this automatically (setWebhook) below'));
  }

  // Persist ALB DNS to .env for status to find
  const updatedEnv = parseEnvFile(readFileSync(envPath, 'utf-8'));
  updatedEnv.ALB_DNS_NAME = albDns;
  updatedEnv.DASHBOARD_URL = `https://${albDns}`;
  updatedEnv.DEPLOYED_AT = new Date().toISOString();
  writeFileSync(
    envPath,
    Object.entries(updatedEnv)
      .filter(([_, v]) => v != null && v !== '')
      .map(([k, v]) => `${k}=${v}`)
      .join('\n') + '\n',
    { mode: 0o600 },
  );
}

function findStackOutputs(
  outputs: Record<string, Record<string, string>>,
  partialName: string,
): Record<string, string> | undefined {
  const key = Object.keys(outputs).find((k) => k.includes(partialName));
  return key ? outputs[key] : undefined;
}

// ─────────────────────────────────────────────────────────────────────
// ALB health poll
// ─────────────────────────────────────────────────────────────────────
async function waitForAlbHealthy(
  outputs: Record<string, Record<string, string>>,
): Promise<void> {
  section('ALB health · waiting for healthy target');
  const compute = findStackOutputs(outputs, 'Compute');
  const albDns = compute?.AlbDnsName;
  if (!albDns) {
    // eslint-disable-next-line no-console
    console.log(dim('  no ALB DNS yet, skipping health poll'));
    return;
  }
  // Prefer HTTPS if a domain or ACM cert is configured; otherwise HTTP.
  const envCheck = parseEnvFile(readFileSync(envPath, 'utf-8'));
  const useHttps = Boolean(envCheck.DOMAIN_NAME || envCheck.ACM_CERT_ARN);
  const scheme = useHttps ? 'https' : 'http';
  const publicHost =
    envCheck.DOMAIN_NAME && envCheck.DOMAIN_NAME.length > 0
      ? envCheck.DOMAIN_NAME
      : albDns;
  const stop = spinner(`polling ${scheme}://${publicHost}/health`);
  for (let i = 1; i <= 20; i++) {
    try {
      const r = await fetch(`${scheme}://${publicHost}/health`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (r.ok) {
        stop(ok(`ALB healthy in ${i * 15}s`));
        return;
      }
    } catch {
      // expected during early boot; keep polling
    }
    await sleep(15_000);
  }
  stop(warn('ALB never reached healthy in 5 minutes. Check CloudWatch logs.'));
}

// ─────────────────────────────────────────────────────────────────────
// Fargate roll + stability wait
// ─────────────────────────────────────────────────────────────────────
function resolveClusterService(): { cluster: string; service: string } {
  // Read the cluster + service names from the latest cdk-outputs.json if it
  // exists, falling back to the deterministic resource names. This ensures
  // image-only deploys target the correct service even if the user renamed
  // the stack prefix.
  let cluster = 'claudeclaw-cluster';
  let service = 'claudeclaw-service';
  if (existsSync(outputsPath)) {
    try {
      const outputs = JSON.parse(readFileSync(outputsPath, 'utf-8')) as Record<
        string,
        Record<string, string>
      >;
      for (const stackOut of Object.values(outputs)) {
        if (stackOut.FargateClusterArn) {
          cluster = stackOut.FargateClusterArn.split('/').pop() ?? cluster;
        }
        if (stackOut.FargateServiceName) service = stackOut.FargateServiceName;
      }
    } catch {
      // fall back to deterministic names
    }
  }
  return { cluster, service };
}

async function rollFargateService(env: EnvBag): Promise<void> {
  section('Rolling Fargate service');
  const { cluster, service } = resolveClusterService();
  const code = await run('aws', [
    'ecs',
    'update-service',
    '--cluster',
    cluster,
    '--service',
    service,
    '--force-new-deployment',
    '--region',
    env.AWS_REGION,
  ]);
  if (code === 0) {
    // eslint-disable-next-line no-console
    console.log(ok(`rolling deployment started for ${service}`));
  } else {
    // eslint-disable-next-line no-console
    console.log(warn('update-service failed (service may not exist yet)'));
  }
}

/**
 * Wait for the rolled service to stabilize. Secrets inject at task START,
 * so only after this do tasks run on the phase-(b) secret versions.
 */
async function waitForServiceStable(env: EnvBag): Promise<void> {
  const { cluster, service } = resolveClusterService();
  const stop = spinner(`waiting for ${service} to stabilize (aws ecs wait services-stable)`);
  const r = await capture('aws', [
    'ecs',
    'wait',
    'services-stable',
    '--cluster',
    cluster,
    '--services',
    service,
    '--region',
    env.AWS_REGION,
  ]);
  if (r.code === 0) {
    stop(ok(`${service} is stable — tasks restarted onto the new secret versions`));
  } else {
    stop(warn(`services-stable wait did not complete cleanly: ${r.stderr.trim() || `exit ${r.code}`}`));
  }
}

// ─────────────────────────────────────────────────────────────────────
// Utils
// ─────────────────────────────────────────────────────────────────────
function parseEnvFile(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────
// Webhook smoke test
// ─────────────────────────────────────────────────────────────────────
async function webhookSmokeTest(env: EnvBag): Promise<void> {
  section('Webhook smoke test');
  if (!env.TELEGRAM_TOKENS_JSON) {
    // eslint-disable-next-line no-console
    console.log(dim('  no Telegram tokens, skipping'));
    return;
  }
  let mainToken: string;
  try {
    mainToken = (JSON.parse(env.TELEGRAM_TOKENS_JSON) as Record<string, string>).main;
    if (!mainToken) throw new Error('no main token');
  } catch {
    // eslint-disable-next-line no-console
    console.log(dim('  could not parse main bot token, skipping'));
    return;
  }

  // Wait for new tasks to be healthy before testing
  await sleep(30_000);

  // 1. Check getWebhookInfo
  const stop1 = spinner('checking Telegram webhook info');
  try {
    const r = await fetch(`https://api.telegram.org/bot${mainToken}/getWebhookInfo`, {
      signal: AbortSignal.timeout(10_000),
    });
    const data = await r.json() as { ok: boolean; result: { url: string; last_error_message?: string; pending_update_count: number } };
    if (!data.ok || !data.result.url) {
      stop1(warn('webhook not configured'));
      return;
    }
    const webhookUrl = data.result.url;
    stop1(ok(`webhook URL: ${webhookUrl}`));

    // 2. Synthetic POST to the webhook URL
    const stop2 = spinner('sending synthetic webhook POST');
    const secret = env.TELEGRAM_WEBHOOK_SECRET ?? '';
    const probe = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(secret ? { 'X-Telegram-Bot-Api-Secret-Token': secret } : {}),
      },
      body: JSON.stringify({ update_id: 0 }),
      signal: AbortSignal.timeout(10_000),
    });
    if (probe.status === 200) {
      stop2(ok('webhook accepts POST (200)'));
    } else {
      stop2(fail(`webhook returned ${probe.status}. WAF or ALB may be blocking Telegram.`));
      // eslint-disable-next-line no-console
      console.log(
        warn(
          '  This means Telegram cannot deliver messages to your bot.\n' +
          '  Check WAF rules: /tg/ and /slack/ must be excluded from\n' +
          '  AWSManagedRulesCommonRuleSet and AWSManagedRulesAnonymousIpList.',
        ),
      );
    }

    // 3. Check for recent errors
    if (data.result.last_error_message) {
      // eslint-disable-next-line no-console
      console.log(warn(`last webhook error: ${data.result.last_error_message}`));
    }
    if (data.result.pending_update_count > 0) {
      // eslint-disable-next-line no-console
      console.log(warn(`${data.result.pending_update_count} pending updates (messages queued)`));
    }
  } catch (err) {
    stop1(warn(`webhook check failed: ${err instanceof Error ? err.message : String(err)}`));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(red('\nfatal error during deploy:'));
  // eslint-disable-next-line no-console
  console.error(err);
  closePrompt();
  process.exit(1);
});
