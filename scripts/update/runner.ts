/**
 * Per-release UPDATE RUNNER (IaC readiness plan, item 42).
 *
 * This file is TARGET-version code: the shim verifies the release, builds a
 * worktree, runs `npm ci` from the target's lockfile, and execs THIS script
 * inside the worktree. By the time it runs, signature + prerequisites are
 * already proven; its job is the update itself, in two strictly separated
 * stages:
 *
 *  READ-ONLY, LOCK-FREE (a human can review without blocking operators):
 *   1. print the release-notes summary + the machine-readable
 *      REQUIRED-ACTIONS block (between BEGIN-/END-REQUIRED-ACTIONS markers,
 *      with the requiredActionsHash the item-47 approval artifact binds to);
 *   2. print the rollback posture (a forward-only release warns BEFORE
 *      anything applies);
 *   3. run doctor against the NEW version's requirements;
 *   4. `cdk diff` preview;
 *   5. record the currently deployed deployId from the manifest.
 *
 *  MUTATING (lifecycle lock, operation 'update'):
 *   6. acquire the lock at the FIRST mutation — never earlier;
 *   7. revalidate the deployed version (manifest deployId) hasn't changed
 *      since the preview — another operator deploying mid-review aborts us;
 *   8. journal + perform the image import (public gallery → private ECR,
 *      digest-verified, scripts/lib/release/image-import.ts);
 *   9. run EXPAND migrations (journaled, idempotency-keyed, maintenance
 *      gate honored) — expand is additive, so old tasks keep running;
 *  10. hand off to the STANDARD PHASED DEPLOY — as a CHILD PROCESS running
 *      `tsx scripts/deploy.ts --yes` in this worktree. Child process, not a
 *      programmatic import, because deploy.ts is a CLI: importing it would
 *      fire its main(), its readline prompts, and its own process-level
 *      error handling inside our process. The exit-code contract is the
 *      stable seam. deploy.ts acquires the lifecycle lock itself, so the
 *      runner RELEASES its lock immediately before the handoff and the
 *      deploy re-acquires it — the lock stays mandatory across the whole
 *      window, just held by two cooperating operations in sequence (a third
 *      operator grabbing it in the gap makes the deploy refuse, which is
 *      the correct loud outcome);
 *  11. verify-stable (`npm run verify`), then re-acquire the lock and run
 *      BACKFILL, then CONTRACT migrations — contract only after the new
 *      version is verified stable, because contract is what breaks rollback.
 *
 * Everything is injected (RunnerDeps) so unit tests prove the ordering and
 * abort points on fakes; main() wires the real clients.
 */

import { readFileSync } from 'node:fs';
import { hostname, userInfo } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  parseReleaseMetadata,
  requiredActionsHash,
  type ReleaseMetadata,
} from '../lib/release/metadata.js';
import {
  runMigrationPhase,
  type AppliedMigrationStore,
  type Migration,
  type MigrationPhase,
} from '../lib/release/migrations.js';
import { importReleaseImage, type RegistryCopyRunner } from '../lib/release/image-import.js';

/** Markers around the machine-readable block (item 44 consumers grep these). */
export const REQUIRED_ACTIONS_BEGIN = 'BEGIN-REQUIRED-ACTIONS';
export const REQUIRED_ACTIONS_END = 'END-REQUIRED-ACTIONS';

/** A held 'update' lock: journal writes carry its fencing token. */
export interface UpdateLockSession {
  fencingToken: number;
  journal(event: string, data: Record<string, unknown>): Promise<void>;
  /** Throws when the lease was lost (heartbeat failure). */
  assertHeld(): void;
  release(): Promise<void>;
}

export interface RunnerDeps {
  /** Deployed manifest identity, or null on a never-deployed install. */
  readDeployedManifest(): Promise<{ deployId: string } | null>;
  /** New version's doctor; exit code (read-only). */
  runDoctor(): Promise<number>;
  /** `cdk diff` preview; exit code (read-only). */
  runCdkDiff(): Promise<number>;
  /** Acquire the lifecycle lock, operation 'update', heartbeat running. */
  acquireLock(): Promise<UpdateLockSession>;
  /** Registry-native copy runner (crane/skopeo) for the image import. */
  craneRunner: RegistryCopyRunner;
  /** Private ECR repo URI to import into (bootstrap-state primitive). */
  privateRepo: string;
  /** Child process: `tsx scripts/deploy.ts --yes` in the worktree. Exit code. */
  runDeploy(): Promise<number>;
  /** `npm run verify`; exit code. */
  runVerify(): Promise<number>;
  /** The target release's migration registry (scripts/migrations/index.ts). */
  migrations: readonly Migration[];
  applied: AppliedMigrationStore;
  maintenance: {
    enter(): Promise<void>;
    exit(): Promise<void>;
    isActive(): boolean;
  };
  /** Interactive gate for manual-preflight/approval-required actions. */
  confirm(message: string): Promise<boolean>;
  log(line: string): void;
  /** Image platform to import; Fargate runs ARM64. */
  platform?: string;
}

export interface RunnerArgs {
  targetTag: string;
  installedTag: string;
  /** Bytes of the shim-verified metadata (never re-fetched unverified). */
  verifiedMetadataJson: string;
}

/** Render the machine-readable required-actions block. */
export function renderRequiredActionsBlock(metadata: ReleaseMetadata): string {
  const block = {
    tag: metadata.tag,
    commit: metadata.commit,
    requiredActionsHash: requiredActionsHash(metadata),
    requiredActions: metadata.requiredActions,
    migrationFlags: metadata.migrationFlags,
    rollbackPosture: metadata.rollbackPosture,
    upgradingUrl: metadata.upgradingUrl,
  };
  return `${REQUIRED_ACTIONS_BEGIN}\n${JSON.stringify(block, null, 2)}\n${REQUIRED_ACTIONS_END}`;
}

async function runPhaseWithMaintenance(
  phase: MigrationPhase,
  metadata: ReleaseMetadata,
  deps: RunnerDeps,
  lock: UpdateLockSession,
): Promise<void> {
  const needsMaintenance =
    metadata.migrationFlags.maintenanceModePhases.includes(phase) ||
    deps.migrations.some((m) => m.phase === phase && m.requiresMaintenanceMode);
  const entered = needsMaintenance && !deps.maintenance.isActive();
  if (entered) {
    deps.log(`entering maintenance mode for migration phase "${phase}"`);
    await deps.maintenance.enter();
  }
  try {
    const result = await runMigrationPhase(phase, deps.migrations, {
      applied: deps.applied,
      journal: (event, data) => lock.journal(event, { ...data, fencingToken: lock.fencingToken }),
      maintenanceModeActive: () => deps.maintenance.isActive(),
      assertLockHeld: () => lock.assertHeld(),
      ctx: { log: deps.log, deps: {} },
    });
    deps.log(
      `migration phase "${phase}": ran [${result.ran.join(', ') || 'none'}], ` +
        `skipped [${result.skipped.join(', ') || 'none'}]`,
    );
  } finally {
    if (entered) {
      await deps.maintenance.exit();
      deps.log(`exited maintenance mode after phase "${phase}"`);
    }
  }
}

/** The runner. Throws on any abort; main() maps that to exit 1. */
export async function runUpdateRunner(args: RunnerArgs, deps: RunnerDeps): Promise<void> {
  const platform = deps.platform ?? 'linux/arm64';
  const { metadata, warnings } = parseReleaseMetadata(args.verifiedMetadataJson);
  for (const w of warnings) deps.log(`warning: ${w}`);

  // ── READ-ONLY, LOCK-FREE ──────────────────────────────────────────
  deps.log(`update ${args.installedTag} -> ${args.targetTag} (commit ${metadata.commit})`);
  deps.log(`release notes / UPGRADING: ${metadata.upgradingUrl || '(none provided)'}`);
  deps.log(renderRequiredActionsBlock(metadata));

  if (metadata.rollbackPosture !== 'reversible') {
    deps.log(
      `ROLLBACK POSTURE: ${metadata.rollbackPosture} — this release is NOT plainly ` +
        'rollback-able once its migrations apply. Make sure your restore plan exists ' +
        'BEFORE continuing.',
    );
  }

  const manualActions = metadata.requiredActions.filter(
    (a) => a.classification !== 'automatic',
  );
  if (manualActions.length > 0) {
    const listing = manualActions
      .map((a) => `  - [${a.classification}] ${a.id}: ${a.description}`)
      .join('\n');
    const proceed = await deps.confirm(
      `this release has ${manualActions.length} non-automatic required action(s):\n` +
        `${listing}\nConfirm they are handled before the update mutates anything.`,
    );
    if (!proceed) {
      throw new Error(
        'update aborted: non-automatic required actions are not confirmed. Nothing was changed.',
      );
    }
  }

  const doctorCode = await deps.runDoctor();
  if (doctorCode !== 0) {
    throw new Error(
      `doctor (against the NEW version's requirements) failed with exit ${doctorCode}; ` +
        'fix the reported checks and re-run. Nothing was changed.',
    );
  }

  const diffCode = await deps.runCdkDiff();
  if (diffCode !== 0) {
    throw new Error(`cdk diff preview failed with exit ${diffCode}. Nothing was changed.`);
  }

  const previewed = await deps.readDeployedManifest();
  const previewedDeployId = previewed?.deployId ?? null;
  deps.log(`deployed version at preview time: ${previewedDeployId ?? '(no deploy recorded)'}`);

  // ── MUTATING: lock at the FIRST mutation ──────────────────────────
  const lock = await deps.acquireLock();
  try {
    // Revalidate: did another operator deploy while the human reviewed?
    const current = await deps.readDeployedManifest();
    const currentDeployId = current?.deployId ?? null;
    if (currentDeployId !== previewedDeployId) {
      throw new Error(
        `the deployed version changed while the preview was being reviewed ` +
          `(${previewedDeployId ?? 'none'} -> ${currentDeployId ?? 'none'}); the doctor/diff ` +
          'preview no longer describes reality. Re-run the update to preview again.',
      );
    }

    // Journaled image import (item 41): public gallery → private ECR.
    const image = metadata.images.find((i) => i.platform === platform);
    if (!image) {
      throw new Error(
        `release ${args.targetTag} publishes no ${platform} image (platforms: ` +
          `${metadata.images.map((i) => i.platform).join(', ')}); cannot deploy on Fargate ${platform}`,
      );
    }
    await lock.journal('update-image-import-start', {
      platform,
      digest: image.digest,
      publicRepo: image.publicRepo,
      privateRepo: deps.privateRepo,
    });
    const verifiedDigest = await importReleaseImage({
      craneRunner: deps.craneRunner,
      expectedDigest: image.digest,
      publicRef: `${image.publicRepo}@${image.digest}`,
      privateRepo: deps.privateRepo,
      log: deps.log,
    });
    await lock.journal('update-image-imported', {
      platform,
      digest: verifiedDigest,
      privateRepo: deps.privateRepo,
    });

    // EXPAND before the rollout (additive; old tasks keep running).
    await runPhaseWithMaintenance('expand', metadata, deps, lock);
  } catch (err) {
    await lock.release();
    throw err;
  }

  // Hand off to the standard phased deploy. deploy.ts takes the lifecycle
  // lock itself, so release ours immediately before the child starts (see
  // module header for why this is a child process and how the gap behaves).
  await lock.release();
  deps.log('handing off to the standard phased deploy (tsx scripts/deploy.ts --yes)');
  const deployCode = await deps.runDeploy();
  if (deployCode !== 0) {
    throw new Error(
      `the phased deploy exited ${deployCode}; the update did not complete. The deploy ` +
        'journal records exactly where it stopped — re-running the update is safe ' +
        '(migrations are idempotency-keyed and the deploy resumes its failed phase).',
    );
  }

  const verifyCode = await deps.runVerify();
  if (verifyCode !== 0) {
    throw new Error(
      `post-deploy verify exited ${verifyCode}; NOT running backfill/contract migrations ` +
        'against an unverified rollout. Fix verification, then re-run the update (expand ' +
        'migrations and the deploy will no-op; the remaining phases resume).',
    );
  }

  // BACKFILL + CONTRACT only after verify-stable.
  const postLock = await deps.acquireLock();
  try {
    await runPhaseWithMaintenance('backfill', metadata, deps, postLock);
    await runPhaseWithMaintenance('contract', metadata, deps, postLock);
  } finally {
    await postLock.release();
  }

  deps.log(`update to ${args.targetTag} complete`);
}

// ─────────────────────────────────────────────────────────────────────
// CLI main — real wiring. The shim execs this file inside the target
// worktree: npx tsx scripts/update/runner.ts --target <tag> --primary <dir>
//           --metadata <verified-metadata-path> --installed <tag>
// ─────────────────────────────────────────────────────────────────────

function flagValue(argv: string[], name: string): string | undefined {
  const withEq = argv.find((a) => a.startsWith(`${name}=`));
  if (withEq) return withEq.split('=').slice(1).join('=');
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const targetTag = flagValue(argv, '--target');
  const metadataPath = flagValue(argv, '--metadata');
  const installedTag = flagValue(argv, '--installed') ?? '(unknown)';
  if (!targetTag || !metadataPath) {
    console.error(
      'usage: tsx scripts/update/runner.ts --target <tag> --primary <dir> ' +
        '--metadata <verified-metadata.json> --installed <tag>',
    );
    process.exit(2);
  }

  // Real deps are wired lazily so the import graph stays light for tests.
  const { S3Client } = await import('@aws-sdk/client-s3');
  const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb');
  const { capture, run } = await import('../lib/shell.js');
  const { confirm, closePrompt } = await import('../lib/prompt.js');
  const { resolveStateNames } = await import('../lib/lifecycle/bootstrap-state.js');
  const { acquireLock, releaseLock, startHeartbeat } = await import('../lib/lifecycle/lock.js');
  const { appendJournal, readLatestManifest } = await import('../lib/lifecycle/journal.js');
  const { newDeployId } = await import('../lib/lifecycle/ids.js');
  const { MIGRATIONS } = await import('../../scripts/migrations/index.js');

  const region = process.env.AWS_REGION ?? 'us-east-1';
  const env = process.env as Record<string, string | undefined>;
  const names = resolveStateNames(env);
  const account = env.AWS_ACCOUNT_ID?.trim();
  if (!account) {
    throw new Error(
      'AWS_ACCOUNT_ID must be set for the update runner: the verified release ' +
        'image is imported into YOUR private ECR registry, addressed as ' +
        '<account>.dkr.ecr.<region>.amazonaws.com/<repo>.',
    );
  }
  // Full registry URI, not the bare repo name: importReleaseImage builds
  // `${privateRepo}@<digest>` refs for crane, and a bare name would target
  // the wrong (default) registry.
  const privateRepoUri = `${account}.dkr.ecr.${region}.amazonaws.com/${names.ecrRepo}`;
  const s3 = new S3Client({ region });
  const ddb = new DynamoDBClient({ region });
  const owner = `${userInfo().username}@${hostname()} update`;
  const gitSha = (await capture('git', ['rev-parse', 'HEAD'])).stdout.trim();
  const updateId = newDeployId(gitSha);
  let seq = 0;

  const craneRunner: RegistryCopyRunner = {
    async copy(srcRef, dstRef) {
      const code = await run('crane', ['copy', srcRef, dstRef]);
      if (code !== 0) throw new Error(`crane copy exited ${code} (install: brew install crane)`);
    },
    async digest(ref) {
      const res = await capture('crane', ['digest', ref]);
      if (res.code !== 0) throw new Error(`crane digest exited ${res.code}: ${res.stderr}`);
      return res.stdout.trim();
    },
  };

  const deps: RunnerDeps = {
    readDeployedManifest: async () => {
      const m = await readLatestManifest(s3, names.stateBucket);
      return m ? { deployId: m.deployId } : null;
    },
    runDoctor: () => run('npx', ['tsx', 'scripts/doctor.ts']),
    runCdkDiff: () => run('npx', ['cdk', 'diff']),
    acquireLock: async (): Promise<UpdateLockSession> => {
      const handle = await acquireLock(ddb, names.lockTable, {
        owner,
        operation: 'update',
        leaseMs: 15 * 60 * 1000,
      });
      let lost: unknown = null;
      const stopHeartbeat = startHeartbeat(ddb, names.lockTable, handle, 60 * 1000, (err) => {
        lost = err;
      });
      return {
        fencingToken: handle.fencingToken,
        journal: async (event, data) => {
          await appendJournal(s3, names.stateBucket, {
            deployId: updateId,
            seq: seq++,
            event,
            at: new Date().toISOString(),
            fencingToken: handle.fencingToken,
            data,
          });
        },
        assertHeld: () => {
          if (lost) {
            throw new Error(`update lock lost mid-operation: ${String(lost)}; aborting mutations`);
          }
        },
        release: async () => {
          stopHeartbeat();
          // releaseLock is conditional on owner + fencing token, so a lost
          // lease is a clean no-op false, never an error.
          await releaseLock(ddb, names.lockTable, handle);
        },
      };
    },
    craneRunner,
    privateRepo: privateRepoUri,
    runDeploy: () => run('npx', ['tsx', 'scripts/deploy.ts', '--yes']),
    runVerify: () => run('npx', ['tsx', 'scripts/status.ts', '--strict']),
    migrations: MIGRATIONS,
    applied: {
      // Applied-keys live in the state bucket as immutable objects: a GET
      // 404 means not applied; the marker object is the durable record.
      has: async (key) => {
        const { GetObjectCommand } = await import('@aws-sdk/client-s3');
        try {
          await s3.send(
            new GetObjectCommand({ Bucket: names.stateBucket, Key: `migrations/applied/${key}` }),
          );
          return true;
        } catch {
          return false;
        }
      },
      markApplied: async (key) => {
        const { PutObjectCommand } = await import('@aws-sdk/client-s3');
        await s3.send(
          new PutObjectCommand({
            Bucket: names.stateBucket,
            Key: `migrations/applied/${key}`,
            Body: JSON.stringify({ appliedAt: new Date().toISOString(), updateId }) + '\n',
            ContentType: 'application/json',
          }),
        );
      },
    },
    maintenance: {
      // Maintenance-mode automation is item 22 machinery; until a release
      // ships a maintenance-requiring migration this honest stub refuses,
      // which is exactly what the executor's gate needs.
      enter: async () => {
        throw new Error(
          'maintenance-mode automation is not wired yet; this release should not declare ' +
            'maintenance-requiring migrations (scripts/migrations/index.ts is empty)',
        );
      },
      exit: async () => {},
      isActive: () => false,
    },
    confirm: (message) => confirm(`\n${message}\nProceed?`),
    log: (line) => console.log(line),
  };

  try {
    await runUpdateRunner(
      {
        targetTag,
        installedTag,
        verifiedMetadataJson: readFileSync(metadataPath, 'utf8'),
      },
      deps,
    );
  } catch (err) {
    console.error(`\nupdate runner failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  } finally {
    closePrompt();
  }
}

// Only run main() when executed directly (the shim execs this file); a
// vitest import must never fire the CLI.
const invokedDirectly = (() => {
  const arg = process.argv[1];
  if (!arg) return false;
  try {
    return fileURLToPath(import.meta.url) === arg || arg.endsWith('/update/runner.ts');
  } catch {
    return false;
  }
})();
if (invokedDirectly) void main();
