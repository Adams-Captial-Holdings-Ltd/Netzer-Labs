/**
 * ClaudeClaw Enterprise — private dashboard tunnel (`npm run dashboard:tunnel`)
 *
 * The no-domain `infra-only` deployment mode synthesizes the ALB INTERNAL,
 * so the dashboard is not reachable from the internet at all. This script is
 * the supported access path: it resolves the running orchestrator task and
 * opens an SSM port-forward session against the ECS Exec target
 * (`ecs:<cluster>_<taskId>_<runtimeId>`), exposing the container's port 3000
 * on localhost. Plain HTTP is acceptable here ONLY because the hop is
 * localhost -> SSM-encrypted channel -> container; the dashboard token still
 * applies once the page loads.
 *
 * Flags:
 *   --port=<n>     local port to listen on (default 3000)
 *   --env=<name>   which env file to read (deploy.ts convention:
 *                  prod -> .env, anything else -> .env.<name>)
 *
 * Requirements: AWS CLI v2 + the Session Manager plugin on PATH, credentials
 * for the deployed account, and a RUNNING orchestrator task (the service has
 * enableExecuteCommand, which is what the port-forward rides).
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnvFile, resolveEnvFlag, envFileNameFor } from './lib/env-file.js';
import { bold, cyan, dim, fail, info, ok, warn, yellow } from './lib/ansi.js';
import { maybePrintHelp } from './lib/help.js';
import { ecsExecTarget, taskIdFromArn } from './lib/tunnel-target.js';
import { buildResourceNames } from '../infra/lib/constants.js';

const CONTAINER_NAME = 'orchestrator';
const REMOTE_PORT = 3000;

const __filename = fileURLToPath(import.meta.url);
const repoRoot = dirname(dirname(__filename));

function die(msg: string, remedy?: string): never {
  console.error(fail(msg));
  if (remedy) console.error(dim(`   ${remedy}`));
  process.exit(1);
}

function parsePortFlag(argv: string[]): number {
  const raw = argv.find((a) => a.startsWith('--port='))?.split('=')[1];
  if (raw == null) return REMOTE_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    die(`--port=${raw} is not a valid TCP port (1-65535).`);
  }
  return port;
}

/** Load the env file (if present) without clobbering the live shell env. */
function loadEnv(argv: string[]): void {
  const envFile = envFileNameFor(resolveEnvFlag(argv));
  const envPath = join(repoRoot, envFile);
  if (!existsSync(envPath)) return;
  const parsed = parseEnvFile(readFileSync(envPath, 'utf8'));
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] == null) process.env[key] = value;
  }
}

function onPath(bin: string): boolean {
  return spawnSync(bin, ['--version'], { stdio: 'ignore' }).error == null;
}

function sessionManagerPluginInstallHint(): string {
  switch (process.platform) {
    case 'darwin':
      return 'Install it with: brew install --cask session-manager-plugin';
    case 'win32':
      return (
        'Download the installer from ' +
        'https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html ' +
        '(Windows section) and re-open your terminal.'
      );
    default:
      return (
        'On Debian/Ubuntu: curl -fsSL "https://s3.amazonaws.com/session-manager-downloads/plugin/latest/ubuntu_64bit/session-manager-plugin.deb" -o /tmp/smp.deb && sudo dpkg -i /tmp/smp.deb\n' +
        '   Other distros: https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html'
      );
  }
}

interface AwsCliArgs {
  region?: string;
}

function awsJson<T>(args: string[], { region }: AwsCliArgs): T {
  const full = [...args, '--output', 'json', ...(region ? ['--region', region] : [])];
  const res = spawnSync('aws', full, { encoding: 'utf8' });
  if (res.error) die(`aws CLI not runnable: ${res.error.message}`, 'Install AWS CLI v2.');
  if (res.status !== 0) {
    die(`aws ${args.slice(0, 2).join(' ')} failed:\n${(res.stderr || res.stdout).trim()}`);
  }
  return JSON.parse(res.stdout) as T;
}

function main(): void {
  const argv = process.argv.slice(2);
  if (
    maybePrintHelp(argv, {
      command: 'npm run dashboard:tunnel',
      oneLiner: 'private dashboard access for no-domain infra-only installs (SSM port-forward)',
      flags: [
        ['--port=<n>', 'local port to listen on (default 3000)'],
        ['--env=<name>', 'which env file to read'],
      ],
      contract: 'Read-only against AWS; needs the AWS CLI v2 + Session Manager plugin and a running task.',
    })
  ) {
    return;
  }
  loadEnv(argv);
  const localPort = parsePortFlag(argv);
  const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;

  // Same suffix convention as the CDK app: claudeclaw[-suffix]-cluster/-service.
  const names = buildResourceNames(process.env.CCE_NAME_SUFFIX ?? '');
  const cluster = names.ecsCluster;
  const service = names.fargateService;

  console.log(bold('ClaudeClaw dashboard tunnel'));
  console.log(dim(`cluster=${cluster} service=${service} region=${region ?? '(profile default)'}`));

  // ── Preflight ─────────────────────────────────────────────────
  if (!onPath('aws')) {
    die(
      'AWS CLI not found on PATH.',
      'Install AWS CLI v2: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html',
    );
  }
  if (!onPath('session-manager-plugin')) {
    die(
      'The AWS Session Manager plugin is not on your PATH; the SSM port-forward cannot start without it.',
      sessionManagerPluginInstallHint(),
    );
  }
  console.log(ok('aws CLI and session-manager-plugin found'));

  // ── Resolve the running task ──────────────────────────────────
  const listed = awsJson<{ taskArns?: string[] }>(
    ['ecs', 'list-tasks', '--cluster', cluster, '--service-name', service, '--desired-status', 'RUNNING'],
    { region },
  );
  const taskArns = listed.taskArns ?? [];
  if (taskArns.length === 0) {
    die(
      `No RUNNING tasks for service ${service} on cluster ${cluster}.`,
      'Is the stack deployed and the service healthy? Check: npm run status',
    );
  }
  if (taskArns.length > 1) {
    console.log(warn(`${taskArns.length} running tasks; tunneling to the first one.`));
  }
  const taskArn = taskArns[0];
  const taskId = taskIdFromArn(taskArn);

  const described = awsJson<{
    tasks?: Array<{
      taskArn?: string;
      lastStatus?: string;
      containers?: Array<{ name?: string; runtimeId?: string; lastStatus?: string }>;
    }>;
  }>(['ecs', 'describe-tasks', '--cluster', cluster, '--tasks', taskArn], { region });

  const task = described.tasks?.[0];
  const container = task?.containers?.find((c) => c.name === CONTAINER_NAME);
  if (!container?.runtimeId) {
    die(
      `Could not find a '${CONTAINER_NAME}' container with a runtimeId on task ${taskId} ` +
        `(container status: ${container?.lastStatus ?? 'absent'}).`,
      'The task may still be starting, or ECS Exec may not be enabled on the service. Re-run in a minute.',
    );
  }

  const target = ecsExecTarget(cluster, taskId, container.runtimeId);
  console.log(ok(`task ${taskId} (${task?.lastStatus ?? 'RUNNING'}), container runtime resolved`));
  console.log(info(`SSM target: ${dim(target)}`));

  // ── Start the port-forward session ────────────────────────────
  console.log('');
  console.log(bold(`Dashboard: ${cyan(`http://localhost:${localPort}/dashboard`)}`));
  console.log(
    yellow('Reminder: the dashboard token still applies — this tunnel is transport, not auth.'),
  );
  console.log(dim('Press Ctrl+C to close the tunnel.'));
  console.log('');

  const ssmArgs = [
    'ssm',
    'start-session',
    '--target',
    target,
    '--document-name',
    'AWS-StartPortForwardingSession',
    '--parameters',
    JSON.stringify({ portNumber: [String(REMOTE_PORT)], localPortNumber: [String(localPort)] }),
    ...(region ? ['--region', region] : []),
  ];
  // Inherit stdio so the session stays interactive and Ctrl+C tears it down.
  const session = spawn('aws', ssmArgs, { stdio: 'inherit' });
  session.on('exit', (code) => process.exit(code ?? 0));
  session.on('error', (err) => die(`failed to start ssm session: ${err.message}`));
}

main();
