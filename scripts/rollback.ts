/**
 * Rollback CLI — thin wiring over scripts/lib/lifecycle/rollback-classes.ts.
 *
 *   npm run deploy:rollback -- --class=image|infra|config --to=<deployId|previous>
 *                              [--dry-run] [--env=staging] [--yes]
 *                              [--accept-schema-downgrade --migration-plan="..."]
 *                              [--rebuild-from-git]
 *   npm run deploy:rollback -- --list      # show recent promoted deploys
 *
 * Classes (IaC readiness plan items 18 / 19 / 21):
 *   image  — swap the live task definition's orchestrator container to the
 *            target manifest's image digest, roll the service, wait stable.
 *   infra  — redeploy the target's ARCHIVED cdk.out (always `cdk diff`
 *            first); --rebuild-from-git gates the synth-from-source fallback.
 *   config — move AWSCURRENT on every recorded secret to the target's
 *            VersionIds, then force an ECS redeploy (secrets inject at task
 *            START) and wait stable.
 *
 * All classes: manifests from the state bucket, mandatory lifecycle lock
 * with heartbeat, journaled steps, schema-version downgrade refusal, and
 * --dry-run prints the plan with zero mutations. The data class (restore)
 * is deliberately NOT a one-liner — see docs/lifecycle.md.
 */

import { dirname, join } from 'node:path';
import { hostname, userInfo } from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { S3Client } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import {
  DescribeTaskDefinitionCommand,
  ECSClient,
  RegisterTaskDefinitionCommand,
  UpdateServiceCommand,
  waitUntilServicesStable,
  type RegisterTaskDefinitionCommandInput,
} from '@aws-sdk/client-ecs';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { bold, fail, gray, info, warn } from './lib/ansi.js';
import { maybePrintHelp } from './lib/help.js';
import { confirm, closePrompt } from './lib/prompt.js';
import { run, capture } from './lib/shell.js';
import { envFileNameFor, parseEnvFile, resolveEnvFlag } from './lib/env-file.js';
import { resolveStateNames } from './lib/lifecycle/bootstrap-state.js';
import {
  listDeployIds,
  runRollback,
  type CfnClientLike,
  type EcrImagesClientLike,
  type EcsClientLike,
  type RollbackClass,
  type ShellLike,
} from './lib/lifecycle/rollback-classes.js';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = dirname(dirname(__filename));

function flagValue(argv: string[], name: string): string | undefined {
  return argv
    .find((a) => a.startsWith(`--${name}=`))
    ?.split('=')
    .slice(1)
    .join('=');
}

// ── client adapters ───────────────────────────────────────────────────

/** ECR via the aws CLI (no @aws-sdk/client-ecr dependency; same pattern as
 * deploy.ts's bootstrap adapter). */
function cliEcrImagesClient(region: string): EcrImagesClientLike {
  return {
    async describeImages(input): Promise<unknown> {
      const r = await capture('aws', [
        'ecr',
        'describe-images',
        '--repository-name',
        input.repositoryName,
        '--image-ids',
        ...input.imageIds.map((i) => `imageDigest=${i.imageDigest}`),
        '--region',
        region,
        '--output',
        'json',
        '--no-cli-pager',
      ]);
      if (r.code !== 0) {
        const err = new Error(r.stderr.trim() || 'aws ecr describe-images failed');
        err.name = /ImageNotFoundException/.test(r.stderr)
          ? 'ImageNotFoundException'
          : /RepositoryNotFoundException/.test(r.stderr)
            ? 'RepositoryNotFoundException'
            : 'CliError';
        throw err;
      }
      return r.stdout.trim() ? JSON.parse(r.stdout) : {};
    },
  };
}

function sdkEcsClient(region: string): EcsClientLike {
  const client = new ECSClient({ region });
  return {
    async describeTaskDefinition(family): Promise<Record<string, unknown>> {
      const res = await client.send(new DescribeTaskDefinitionCommand({ taskDefinition: family }));
      if (!res.taskDefinition) throw new Error(`task definition ${family} not found`);
      return res.taskDefinition as unknown as Record<string, unknown>;
    },
    async registerTaskDefinition(def): Promise<{ revision: number }> {
      const res = await client.send(
        new RegisterTaskDefinitionCommand(def as unknown as RegisterTaskDefinitionCommandInput),
      );
      return { revision: res.taskDefinition?.revision ?? 0 };
    },
    async updateService(input): Promise<void> {
      await client.send(
        new UpdateServiceCommand({
          cluster: input.cluster,
          service: input.service,
          ...(input.taskDefinition ? { taskDefinition: input.taskDefinition } : {}),
          forceNewDeployment: true,
        }),
      );
    },
    async waitServicesStable(input): Promise<void> {
      await waitUntilServicesStable(
        { client, maxWaitTime: 900 },
        { cluster: input.cluster, services: [input.service] },
      );
    },
  };
}

function sdkCfnClient(region: string): CfnClientLike {
  const client = new CloudFormationClient({ region });
  return {
    async stackStatus(stackName): Promise<string | null> {
      try {
        const res = await client.send(new DescribeStacksCommand({ StackName: stackName }));
        return res.Stacks?.[0]?.StackStatus ?? null;
      } catch (err) {
        if (/does not exist/.test(err instanceof Error ? err.message : String(err))) return null;
        throw err;
      }
    },
  };
}

/** ShellLike contract: merge opts.env OVER process.env. */
const shell: ShellLike = {
  run: (cmd, args, opts) =>
    run(cmd, args, {
      ...(opts?.cwd ? { cwd: opts.cwd } : {}),
      ...(opts?.env ? { env: { ...process.env, ...opts.env } } : {}),
    }),
  capture: (cmd, args, opts) =>
    capture(cmd, args, {
      ...(opts?.cwd ? { cwd: opts.cwd } : {}),
      ...(opts?.env ? { env: { ...process.env, ...opts.env } } : {}),
    }),
};

// ── main ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (
    maybePrintHelp(argv, {
      command: 'npm run deploy:rollback',
      oneLiner: 'roll back by class: image (task def swap), infra (archived cdk.out), config (secret versions)',
      flags: [
        ['--list', 'show recent promoted deploys (read-only)'],
        ['--class=image|infra|config', 'which rollback class to run'],
        ['--to=<deployId|previous>', 'target manifest'],
        ['--dry-run', 'plan only; no mutation'],
        ['--yes, -y', 'skip the confirmation'],
        ['--accept-schema-downgrade', 'override the schema-version refusal (pair with --migration-plan="...")'],
        ['--rebuild-from-git', 'infra class: allow synth-from-source when the archived cdk.out is missing'],
        ['--env=<name>', 'target .env.<name> instead of .env'],
      ],
      contract: 'Mutates the live service or stacks under the lifecycle lock; --list and --dry-run are read-only.',
      docs: 'docs/lifecycle.md',
    })
  ) {
    return;
  }
  const envFlag = resolveEnvFlag(argv);
  const envPath = join(repoRoot, envFileNameFor(envFlag));
  const fileEnv = existsSync(envPath) ? parseEnvFile(readFileSync(envPath, 'utf8')) : {};
  // No secret VALUES are needed by any class — only names/region/account —
  // so a machine with just AWS credentials and this file's non-secret keys
  // can run a rollback.
  const env: Record<string, string | undefined> = { ...process.env, ...fileEnv };
  // Same suffix derivation as deploy.ts: `--env=staging` implies the
  // `staging` suffix even when the env file never sets CCE_NAME_SUFFIX,
  // so --list and resolveStateNames target the right state bucket.
  env.CCE_NAME_SUFFIX = env.CCE_NAME_SUFFIX ?? (envFlag === 'prod' ? '' : envFlag);

  const region = env.AWS_REGION ?? 'us-east-1';
  const s3 = new S3Client({ region });

  if (argv.includes('--list')) {
    const names = resolveStateNames(env);
    const ids = await listDeployIds(s3, names.stateBucket);
    if (ids.length === 0) {
      console.log(warn(`no promoted deploys in s3://${names.stateBucket}/deploys/`));
      return;
    }
    console.log(bold('Promoted deploys (newest first):'));
    for (const id of ids.slice(0, 15)) console.log(`  ${id}`);
    console.log(gray('  target one with --to=<deployId>, or --to=previous for the newest non-live'));
    return;
  }

  const klass = flagValue(argv, 'class') as RollbackClass | undefined;
  if (klass !== 'image' && klass !== 'infra' && klass !== 'config') {
    console.log(fail('--class=image|infra|config is required'));
    console.log(
      info(
        'usage: npm run deploy:rollback -- --class=image --to=<deployId|previous> ' +
          '[--dry-run] [--env=staging] [--yes]',
      ),
    );
    console.log(info('data restore is a runbook, not a flag: see docs/lifecycle.md'));
    process.exitCode = 1;
    return;
  }
  const to = flagValue(argv, 'to') ?? 'previous';
  const dryRun = argv.includes('--dry-run');
  const yes = argv.includes('--yes') || argv.includes('-y');
  const acceptSchemaDowngrade = argv.includes('--accept-schema-downgrade');
  const migrationPlan = flagValue(argv, 'migration-plan');
  const rebuildFromGit = argv.includes('--rebuild-from-git');

  console.log('\n' + bold(`ClaudeClaw Enterprise · Rollback (${klass}, env ${envFlag})`));
  console.log(gray('─'.repeat(44)));

  if (!dryRun && !yes) {
    const go = await confirm(`Proceed with ${klass} rollback to "${to}"?`, false);
    if (!go) {
      console.log(warn('aborted by operator'));
      closePrompt();
      return;
    }
  }

  const result = await runRollback(
    {
      s3,
      ddb: new DynamoDBClient({ region }),
      secrets: new SecretsManagerClient({ region }),
      ecr: cliEcrImagesClient(region),
      ecs: sdkEcsClient(region),
      cfn: sdkCfnClient(region),
      shell,
      env,
      log: (line) => console.log(line),
    },
    {
      rollbackClass: klass,
      to,
      dryRun,
      acceptSchemaDowngrade,
      ...(migrationPlan !== undefined ? { migrationPlan } : {}),
      rebuildFromGit,
      owner: `${userInfo().username}@${hostname()}#${process.pid}`,
      envFlag,
      repoRoot,
    },
  );

  if (!result.dryRun) {
    console.log(
      '\n' +
        bold(
          `Rollback (${result.rollbackClass}) ${result.currentDeployId} → ${result.targetDeployId} done.`,
        ),
    );
  }
  closePrompt();
}

main().catch((err) => {
  console.error(fail(err instanceof Error ? err.message : String(err)));
  closePrompt();
  process.exit(1);
});
