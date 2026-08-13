/**
 * Netzar OS Enterprise · Up (one-command install conductor)
 *
 * `npm run up`
 *
 * ONE command from a cloned repo to a verified install. It drives the existing
 * quickstart commands in order and, unlike a human following the README, it
 * ACTS on the typed I1 envelope actions instead of exiting with homework:
 *
 *   1. setup      (only if no env file yet; interactive, or --answers <file>)
 *   2. doctor     (read-only preflight; WAITS through known human gates)
 *   3. early-win  (one bounded Bedrock probe; obeys typed wait_retry /
 *                  human_gate actions, e.g. polls while a Bedrock model-access
 *                  grant propagates instead of asking you to re-run anything)
 *   4. deploy     (the existing phased pipeline, money gate included)
 *   5. verify     (status --strict; the DONE predicate; settles through
 *                  post-deploy eventual consistency instead of failing at
 *                  the finish line)
 *
 * The whole point is the wait loop: when a blocker is something a human fixes
 * out-of-band (granting Bedrock model access in the console, an ACM cert
 * moving to ISSUED, a quota increase landing), `up` prints ONE instruction
 * with the exact console URL, then keeps re-checking until it clears. Leave
 * the terminal open, click the link, come back to a deployed system. Ctrl-C
 * is always safe: every underlying command is idempotent and `npm run up`
 * resumes from wherever it left off.
 *
 * Spend honesty: steps 1-3 are the free/read-only path (early-win is one
 * bounded probe, cents at most). Step 4 is the first standing cost and keeps
 * its own confirmation gate; `--yes` forwards to it for unattended runs and
 * means the human already accepted the tier cost printed by setup.
 *
 * Fail-closed: `up` acts ONLY on validated typed envelopes (extractEnvelope).
 * Prose output, malformed JSON, or an unknown blocker stops the run with the
 * blocker's own remediation text. It never invents a fix.
 *
 * Credential honesty: when a step past doctor fails, `up` re-probes STS once
 * and, on credential-shaped evidence, says plainly that the credentials
 * expired mid-run (SSO sessions on a 30-minute deploy are the common case)
 * and how to refresh and resume, instead of leaving a raw SDK error as the
 * last word.
 *
 * Flags:
 *   --plan              print the plan, run nothing
 *   --answers <file>    forward to setup (noninteractive wizard)
 *   --yes               forward to deploy (skip its confirmation gate)
 *   --no-wait           never poll; print gate instructions and exit 1
 *   --json              machine-readable final report on stdout
 *   --env=staging|<x>   env-file selector, same as every other command
 *
 * Import-safe: NO top-level side effects; everything runs inside main()
 * behind the import.meta.url guard. No em dashes by house rule.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { bold, cyan, dim, fail, gray, info, ok, warn } from './lib/ansi.js';
import { checkDocker } from './lib/docker-check.js';
import { parseEnvFile, resolveEnvFlag, envFileNameFor } from './lib/env-file.js';
import { DEPLOY_EXIT_DECLINED } from './lib/exit-codes.js';
import type { Check, Envelope } from './lib/envelope/envelope.js';
import { resolveAnswersFlag } from './lib/setup-answers.js';
import { extractEnvelope } from './tier1-validate.js';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = dirname(dirname(__filename));

// ─────────────────────────────────────────────────────────────────────
// Pure core (exported for tests; no I/O)
// ─────────────────────────────────────────────────────────────────────

/**
 * Doctor checks whose FAIL clears after an out-of-band human action plus
 * time, so `up` is allowed to wait through them instead of aborting. The
 * legacy doctor envelope carries none-actions (from-legacy.ts), so this
 * allowlist is the conductor's knowledge of which ids are gate-shaped.
 * Everything NOT listed here aborts with the check's own remediation text
 * (wrong credentials, name collisions, etc. need a config change, not time).
 */
export const WAITABLE_DOCTOR_CHECKS: readonly string[] = [
  'bedrock-grant-claude',
  'bedrock-grant-titan-embed',
  'bedrock-grant-image',
  'bedrock-grant-nova-sonic',
  'domain-tls',
  'service-quotas',
  'secrets-pending-deletion',
];

/**
 * Verify checks whose FAIL right after a deploy is usually eventual
 * consistency (ECS reaching steady state, CloudFront/WAF propagation, a
 * throttled Bedrock probe), not a broken install. `up` settles through
 * these on a short bounded window instead of exiting 1 at the very end of
 * a 30-minute run. Anything NOT listed aborts immediately: a missing
 * manifest or a stale secret needs a fix, not time.
 */
export const WAITABLE_VERIFY_CHECKS: readonly string[] = [
  'ecs-service-steady',
  'dashboard-endpoint',
  'waf-cloudfront',
  'bedrock-probe-claude',
  'bedrock-probe-titan-embed',
];

/** Floor for any poll delay; we never hammer AWS faster than this. */
export const MIN_POLL_SEC = 15;
/** Poll cadence while a doctor-level human gate is open. */
export const DOCTOR_GATE_POLL_SEC = 45;
/** Poll cadence while a typed human_gate action is open (early-win). */
export const HUMAN_GATE_POLL_SEC = 60;
/** Overall cap on waiting for any single step's gates to clear. */
export const GATE_MAX_WAIT_SEC = 2700; // 45 minutes
/** Default cap for wait_retry actions that do not carry maxWaitSec. */
export const WAIT_RETRY_DEFAULT_MAX_SEC = 900; // 15 minutes
/** Poll cadence while verify settles post-deploy eventual consistency. */
export const VERIFY_SETTLE_POLL_SEC = 30;
/** Cap on the post-deploy settle window; genuine failures surface fast. */
export const VERIFY_SETTLE_MAX_SEC = 900; // 15 minutes

export type UpStepId = 'setup' | 'doctor' | 'early-win' | 'deploy' | 'verify';

export interface BlockerInfo {
  id: string;
  status: string;
  title: string;
  detail: string;
  consoleUrl?: string;
  gateId?: string;
  /**
   * How the wait should read to a human. 'human' means a browser step is
   * being asked of them (ACTION NEEDED); 'settle' means nothing is asked,
   * the conductor is just waiting out propagation (SETTLING). Only present
   * on wait decisions.
   */
  waitStyle?: 'human' | 'settle';
}

export type StepDecision =
  | { kind: 'proceed' }
  | { kind: 'wait'; delaySec: number; maxWaitSec: number; blockers: BlockerInfo[] }
  | { kind: 'abort'; blockers: BlockerInfo[] };

function toBlocker(c: Check): BlockerInfo {
  const b: BlockerInfo = { id: c.id, status: c.status, title: c.title, detail: c.detail };
  if (c.action.consoleUrl !== undefined) b.consoleUrl = c.action.consoleUrl;
  if (c.action.gateId !== undefined) b.gateId = c.action.gateId;
  return b;
}

/**
 * Decide what the conductor does with one step's envelope. Waiting is only
 * allowed when EVERY blocking check is wait-shaped: a typed wait_retry or
 * human_gate action, or an id on the step's WAITABLE allowlist (doctor's
 * human gates, verify's post-deploy settle set). One non-waitable blocker
 * makes the whole step an abort, because polling cannot fix it and would
 * just burn 45 minutes hiding the real problem.
 */
export function decideFromEnvelope(step: UpStepId, env: Envelope): StepDecision {
  if (env.ok) return { kind: 'proceed' };

  const blocking = (env.checks as Check[]).filter(
    (c) => c.status === 'fail' || c.status === 'pending',
  );

  let delaySec = 0;
  let maxWaitSec = 0;
  const blockers: BlockerInfo[] = [];
  for (const c of blocking) {
    const b = toBlocker(c);
    blockers.push(b);
    if (c.action.kind === 'wait_retry') {
      b.waitStyle = 'settle';
      delaySec = Math.max(delaySec, Math.max(c.action.retryAfterSec ?? MIN_POLL_SEC, MIN_POLL_SEC));
      maxWaitSec = Math.max(maxWaitSec, c.action.maxWaitSec ?? WAIT_RETRY_DEFAULT_MAX_SEC);
      continue;
    }
    if (c.action.kind === 'human_gate') {
      b.waitStyle = 'human';
      delaySec = Math.max(delaySec, HUMAN_GATE_POLL_SEC);
      maxWaitSec = Math.max(maxWaitSec, GATE_MAX_WAIT_SEC);
      continue;
    }
    if (step === 'doctor' && WAITABLE_DOCTOR_CHECKS.includes(c.id)) {
      b.waitStyle = 'human';
      delaySec = Math.max(delaySec, DOCTOR_GATE_POLL_SEC);
      maxWaitSec = Math.max(maxWaitSec, GATE_MAX_WAIT_SEC);
      continue;
    }
    if (step === 'verify' && WAITABLE_VERIFY_CHECKS.includes(c.id)) {
      b.waitStyle = 'settle';
      delaySec = Math.max(delaySec, VERIFY_SETTLE_POLL_SEC);
      maxWaitSec = Math.max(maxWaitSec, VERIFY_SETTLE_MAX_SEC);
      continue;
    }
    // Abort blockers carry no waitStyle: nothing is being waited on.
    return { kind: 'abort', blockers: blocking.map(toBlocker) };
  }
  return { kind: 'wait', delaySec, maxWaitSec, blockers };
}

export interface UpStepSpec {
  id: UpStepId;
  title: string;
  script: string;
  /** Flag that makes the command emit the typed envelope; null = passthrough (inherit stdio). */
  envelopeFlag: string | null;
  costNote: string;
}

export const UP_STEPS: readonly UpStepSpec[] = [
  {
    id: 'setup',
    title: 'Step 1 of 5 · setup, 2-5 min (config wizard; skipped when the env file already exists)',
    script: 'scripts/setup.ts',
    envelopeFlag: null,
    costNote: 'writes .env + claudeclaw.config.yaml; creates nothing in AWS',
  },
  {
    id: 'doctor',
    title: 'Step 2 of 5 · doctor, about 1 min (read-only preflight; waits through model-access gates)',
    script: 'scripts/doctor.ts',
    envelopeFlag: '--envelope',
    costNote: 'read-only AWS describe/list calls; creates nothing',
  },
  {
    id: 'early-win',
    title: 'Step 3 of 5 · early win, seconds (one bounded Bedrock probe; waits while a grant propagates)',
    script: 'scripts/early-win.ts',
    envelopeFlag: '--json',
    costNote: 'one guardrailed Bedrock call, max 32 output tokens; no AWS resource',
  },
  {
    id: 'deploy',
    title: 'Step 4 of 5 · deploy, 15-30 min (phased pipeline; its own confirmation gate before spend)',
    script: 'scripts/deploy.ts',
    envelopeFlag: null,
    costNote: 'FIRST standing cost; the tier estimate is confirmed before anything is created',
  },
  {
    id: 'verify',
    title: 'Step 5 of 5 · verify, 2-3 min (strict; settles brief post-deploy propagation; the DONE predicate)',
    script: 'scripts/status.ts',
    envelopeFlag: '--envelope',
    costNote: 'read-only plus two bounded paid model probes (~a cent)',
  },
];

export interface UpReport {
  command: 'up';
  verdict: 'verified' | 'blocked';
  steps: { id: UpStepId; ok: boolean; skipped?: boolean; waitedSec?: number }[];
  reasons: string[];
  /** Present on a verified install so an unattended driver can hand the
   * operator their login link without parsing the env file. */
  dashboardUrl?: string;
  /** Wall-clock seconds for the whole run, whatever the verdict. */
  elapsedSec?: number;
}

/** "23m" / "1h 04m"; runs under 90 seconds read as "about a minute". */
export function formatDuration(sec: number): string {
  if (sec < 90) return 'about a minute';
  const mins = Math.round(sec / 60);
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`;
}

/**
 * Credential-death signatures across SDK v3 error names and STS message
 * text, matched against "name: message" from the post-failure STS re-probe.
 * Network noise (ENOTFOUND, timeouts) and permission errors deliberately do
 * NOT match: the conductor never blames credentials without evidence.
 */
export function looksLikeDeadCredentials(text: string): boolean {
  return /(ExpiredToken|TokenRefreshRequired|InvalidClientTokenId|UnrecognizedClientException|CredentialsProviderError|security token.{0,40}(expired|invalid)|could not load credentials|sso session.{0,40}expired|token has expired)/i.test(
    text,
  );
}

// ─────────────────────────────────────────────────────────────────────
// I/O shell
// ─────────────────────────────────────────────────────────────────────

const log = (msg: string): void => {
  // eslint-disable-next-line no-console
  console.log(msg);
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function tsxBin(): string {
  return join(repoRoot, 'node_modules', '.bin', 'tsx');
}

/** Run an envelope-emitting step once and parse its typed output. */
function runEnvelopeOnce(
  spec: UpStepSpec,
  envFlag: string,
  extraArgs: string[] = [],
): { env?: Envelope; error?: string; rawTail?: string } {
  const args = [join(repoRoot, spec.script), spec.envelopeFlag as string, `--env=${envFlag}`, ...extraArgs];
  const result = spawnSync(tsxBin(), args, {
    cwd: repoRoot,
    encoding: 'utf-8',
    env: process.env,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) return { error: `failed to spawn ${spec.script}: ${result.error.message}` };
  const stdout = result.stdout ?? '';
  try {
    return { env: extractEnvelope(stdout) };
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : String(err),
      rawTail: (result.stderr || stdout).slice(-400),
    };
  }
}

/** Run a passthrough step (setup / deploy) with inherited stdio. */
function runPassthrough(spec: UpStepSpec, args: string[]): number {
  const result = spawnSync(tsxBin(), [join(repoRoot, spec.script), ...args], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: process.env,
  });
  if (result.error) {
    log(fail(`failed to spawn ${spec.script}: ${result.error.message}`));
    return 1;
  }
  return result.status ?? 1;
}

function printBlockers(blockers: BlockerInfo[], gate: boolean): void {
  for (const b of blockers) {
    log((gate ? warn : fail)(`${b.id} (${b.status}) · ${b.title}`));
    for (const line of b.detail.split('\n')) if (line.trim()) log(dim(`     ${line}`));
    if (b.consoleUrl) log(cyan(`     open: ${b.consoleUrl}`));
  }
}

const RESUME_NOTE = 'Ctrl-C is safe; every step is idempotent. Re-run `npm run up` to resume.';

/**
 * By the time early-win/deploy/verify fail, doctor has already proven the
 * credentials in THIS run, so a dead STS re-probe here means they expired
 * mid-run; an SSO session lapsing during the 15-30 minute deploy is the
 * common case, and its raw SDK error is famously unhelpful as a last word.
 * One bounded probe (single attempt, no retries); prints ONLY on
 * credential-shaped evidence and never changes the step's own exit path.
 */
async function explainIfCredentialsDied(envFlag: string): Promise<void> {
  let region = 'us-east-1';
  try {
    const env = parseEnvFile(readFileSync(join(repoRoot, envFileNameFor(envFlag)), 'utf-8'));
    if (env.AWS_REGION) region = env.AWS_REGION;
  } catch {
    /* any region can answer a GetCallerIdentity probe */
  }
  try {
    // Bound the probe: on a dead network the SDK can block for the OS TCP
    // timeout (~75s), and this runs on the conductor's exit path. A timeout
    // error does not match looksLikeDeadCredentials, so it stays silent.
    const timer = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('sts probe timed out')), 5000).unref();
    });
    await Promise.race([
      new STSClient({ region, maxAttempts: 1 }).send(new GetCallerIdentityCommand({})),
      timer,
    ]);
  } catch (err) {
    const e = err as { name?: string; message?: string };
    const text = `${e?.name ?? 'Error'}: ${e?.message ?? String(err)}`;
    if (!looksLikeDeadCredentials(text)) return;
    log('');
    log(warn(bold('Your AWS credentials stopped working mid-run; that is the failure above.')));
    log(dim(`     STS re-check: ${text}`));
    log(
      info(
        'Refresh them (`aws sso login`, or re-export your keys), then re-run `npm run up`; it resumes where it left off.',
      ),
    );
  }
}

/**
 * Docker is OPTIONAL: with a running daemon, deploy builds the image
 * locally (fastest); without one, deploy builds in AWS CodeBuild inside
 * the operator's account (a few cents, ~10 minutes). This is a
 * two-second detection and a one-line expectation setter, never a gate.
 */
async function noteDockerMode(): Promise<void> {
  const status = await checkDocker();
  if (status.running) {
    log(ok(`docker daemon running${status.version ? ` · v${status.version}` : ''} · deploy builds locally`));
    return;
  }
  log(
    info(
      'no running Docker found · deploy will build in AWS CodeBuild inside your account (a few cents, ~10 min). Docker stays optional.',
    ),
  );
}

/**
 * Drive one envelope step to completion, obeying typed actions: re-run on
 * wait_retry, print-and-poll on human gates, abort on anything else.
 */
async function driveEnvelopeStep(
  spec: UpStepSpec,
  envFlag: string,
  opts: { noWait: boolean },
  extraArgs: string[] = [],
): Promise<{ ok: boolean; env?: Envelope; waitedSec: number; reasons: string[] }> {
  const startedMs = Date.now();
  const announced = new Set<string>();
  for (;;) {
    const res = runEnvelopeOnce(spec, envFlag, extraArgs);
    if (res.error || !res.env) {
      log(fail(`${spec.id}: ${res.error ?? 'no typed envelope in output'}`));
      if (res.rawTail) log(dim(`  …${res.rawTail}`));
      return {
        ok: false,
        waitedSec: Math.round((Date.now() - startedMs) / 1000),
        reasons: [`${spec.id}: ${res.error ?? 'unreadable output'}`],
      };
    }
    const decision = decideFromEnvelope(spec.id, res.env);
    const waitedSec = Math.round((Date.now() - startedMs) / 1000);
    if (decision.kind === 'proceed') {
      const s = res.env.summary;
      log(ok(`${spec.id} passed · ${s.pass} pass · ${s.warn} warn`));
      // A warn the human never sees might as well not exist. Name each one
      // (title only) so nobody has to re-run the command by hand to learn
      // what "2 warn" was; the underlying command has the full detail.
      for (const c of (res.env.checks as Check[]).filter((x) => x.status === 'warn')) {
        log(dim(`     ⚠ ${c.id} · ${c.title}`));
      }
      return { ok: true, env: res.env, waitedSec, reasons: [] };
    }
    if (decision.kind === 'abort') {
      log(fail(`${spec.id} blocked; the checks below need a fix, not waiting:`));
      printBlockers(decision.blockers, false);
      log(dim(`  ${RESUME_NOTE}`));
      return {
        ok: false,
        waitedSec,
        reasons: decision.blockers.map((b) => `${spec.id}: ${b.id} is ${b.status}`),
      };
    }
    // decision.kind === 'wait'
    for (const b of decision.blockers) {
      if (!announced.has(b.id)) {
        announced.add(b.id);
        log('');
        if (b.waitStyle === 'settle') {
          log(warn(bold(`SETTLING · ${b.title}`)));
          printBlockers([b], true);
          log(info('Nothing is asked of you here; this usually clears on its own. I will keep re-checking.'));
        } else {
          log(warn(bold(`ACTION NEEDED · ${b.title}`)));
          printBlockers([b], true);
          log(info('Do the step above in your browser. I will keep checking and continue automatically.'));
        }
      }
    }
    if (opts.noWait) {
      const anyHuman = decision.blockers.some((b) => b.waitStyle !== 'settle');
      log(
        warn(
          anyHuman
            ? `${spec.id}: gate open and --no-wait set; finish the step above, then re-run \`npm run up\`.`
            : `${spec.id}: still settling and --no-wait set; give it a few minutes, then re-run \`npm run up\`.`,
        ),
      );
      return {
        ok: false,
        waitedSec,
        reasons: decision.blockers.map((b) => `${spec.id}: ${b.id} gate open (--no-wait)`),
      };
    }
    if (waitedSec + decision.delaySec > decision.maxWaitSec) {
      log(fail(`${spec.id}: still blocked after ${Math.round(waitedSec / 60)} minutes; stopping.`));
      log(dim(`  ${RESUME_NOTE}`));
      return {
        ok: false,
        waitedSec,
        reasons: decision.blockers.map((b) => `${spec.id}: ${b.id} gate timed out`),
      };
    }
    log(
      dim(
        `  re-checking in ${decision.delaySec}s ` +
          `(waited ${Math.round(waitedSec / 60)}m of max ${Math.round(decision.maxWaitSec / 60)}m) · ${RESUME_NOTE}`,
      ),
    );
    await sleep(decision.delaySec * 1000);
  }
}

function printPlan(envFlag: string): void {
  log('\n' + bold('Netzar OS Enterprise · up (one-command install, plan)'));
  log(gray('─'.repeat(48)));
  log(dim(`env file ${envFileNameFor(envFlag)} · runs nothing in --plan mode`));
  for (const [i, step] of UP_STEPS.entries()) {
    log(`  ${i + 1}. ${bold(step.title)}`);
    log(dim(`     ${step.script} · ${step.costNote}`));
  }
  log('');
  log(info('Steps 1-3 are free/read-only (the probe costs cents at most).'));
  log(info('Step 4 is the first standing cost and confirms the tier estimate before creating anything.'));
  log(dim('  Unattended: npm run up -- --answers examples/answers/infra-only-t0.json --yes'));
  log('');
}

function printEpilogue(verifyEnv: Envelope | undefined, envFlag: string, elapsedSec?: number): void {
  const mode = verifyEnv?.mode;
  // Tailor the checklist to what THIS install actually configured, so nobody
  // hunts for a Slack page they never made. Reading the env file is best
  // effort: on any problem we fall back to the mode-level items.
  let env: Record<string, string> = {};
  try {
    env = parseEnvFile(readFileSync(join(repoRoot, envFileNameFor(envFlag)), 'utf-8'));
  } catch {
    /* fall back to mode-level items */
  }
  const hasSlack = Boolean(env.SLACK_BOT_TOKEN);
  const hasTelegram = Boolean(env.TELEGRAM_TOKENS_JSON);
  const hasEmail = Boolean(env.CCE_EMAIL_FROM);
  log('');
  log(gray('─'.repeat(48)));
  const took = elapsedSec !== undefined ? ` in ${formatDuration(elapsedSec)}` : '';
  log(ok(bold(`Install verified${took}. What is left needs a human (one-time clicks):`)));
  const items: string[] = [
    'Confirm the SNS ops-alerts email (check your inbox for the AWS confirmation link).',
    // Print the login link itself when we can read it; nobody should have to
    // grep an env file for a URL the conductor already knows.
    env.DASHBOARD_URL
      ? `Log into the dashboard: ${env.DASHBOARD_URL} (the bearer DASHBOARD_TOKEN from setup, in ${envFileNameFor(envFlag)}, is the way in).`
      : 'Log into the dashboard: DASHBOARD_URL is in your ' + envFileNameFor(envFlag) + '; the bearer DASHBOARD_TOKEN from setup is the way in.',
    // The payoff, not plumbing: a built-in default agent answers the moment
    // the service is up (agent-loader falls back when no agent is configured).
    'Say hello: the dashboard Chat tab answers right away (a built-in default agent is live out of the box). Add your own agents from examples/README.md.',
  ];
  if (mode === 'chat') {
    // Print the events URL itself when the domain is known (chat mode with
    // Slack requires one): "the printed URL" scrolled away during a
    // 20-minute deploy, and nobody should have to dig for it. Same shape
    // deploy prints: https://<domain>/slack/events.
    const eventsUrl = env.DOMAIN_NAME ? `https://${env.DOMAIN_NAME}/slack/events` : undefined;
    const slackItem = eventsUrl
      ? `Slack: paste ${eventsUrl} into your Slack app Event Subscriptions page (api.slack.com).`
      : 'Slack: paste the /slack/events URL deploy printed into your Slack app Event Subscriptions page.';
    if (hasSlack) {
      items.push(slackItem);
    }
    if (hasTelegram) {
      items.push('Telegram: nothing to do; the webhook was registered and validated during deploy.');
    }
    if (!hasSlack && !hasTelegram) {
      items.push(slackItem);
    }
  }
  if (hasEmail) {
    items.push(`Email: verify ${env.CCE_EMAIL_FROM} as an SES identity before send_email works.`);
  }
  items.push('Recommended: `npm run power:setup` wires the pause/wake panel so an idle install stops costing compute.');
  items.push('Optional features created out-of-band (MCP gateways, feature IAM policies): docs/out-of-band-catalog.md.');
  items.push('Exit path any time: `npm run destroy` removes everything and proves the account is clean.');
  items.push(
    'Good to know: re-running `npm run up` re-deploys (image rebuild plus stack walk, 10-15 min). For a quick health check, `npm run verify` is the 2-minute answer.',
  );
  for (const [i, item] of items.entries()) log(`  ${i + 1}. ${item}`);
  log('');
}

function printHelp(): void {
  log('\n' + bold('npm run up · one command from clone to verified install'));
  log(gray('─'.repeat(48)));
  log('  npm run up                                   interactive install (resumes safely)');
  log('  npm run up -- --plan                         print the plan, run nothing');
  log('  npm run up -- --answers <file>               unattended setup (see examples/answers/)');
  log('  npm run up -- --yes                          pre-accept the deploy cost gate');
  log('  npm run up -- --no-wait                      never poll; print gate instructions and exit');
  log('  npm run up -- --json                         machine-readable final report');
  log('  npm run up -- --env=staging                  target a different env file');
  log('');
  log(dim('  Order of operations, docs, and the phase-by-phase alternative: AGENTS.md at the repo root.'));
  log('');
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const planMode = argv.includes('--plan');
  const jsonMode = argv.includes('--json');
  const yes = argv.includes('--yes') || argv.includes('-y');
  const noWait = argv.includes('--no-wait');
  const envFlag = resolveEnvFlag(argv);
  const answersPath = resolveAnswersFlag(argv);

  if (argv.includes('--help') || argv.includes('-h')) {
    printHelp();
    return 0;
  }
  if (planMode) {
    printPlan(envFlag);
    return 0;
  }

  // Banners name the FILE being read, not the internal flag: the default
  // path's flag is 'prod', which a first-timer never chose and can read as
  // "am I touching production?". "(.env)" says exactly what is loaded.
  log('\n' + bold(`Netzar OS Enterprise · up (${envFileNameFor(envFlag)})`));
  log(gray('─'.repeat(48)));
  log(dim('one command from clone to verified install; every step idempotent\n'));

  const startedMs = Date.now();
  const report: UpReport = { command: 'up', verdict: 'blocked', steps: [], reasons: [] };
  const finish = (code: number): number => {
    report.elapsedSec = Math.round((Date.now() - startedMs) / 1000);
    if (jsonMode) log(JSON.stringify(report, null, 2));
    return code;
  };

  // Step 1 · setup (only when the env file does not exist yet). The wizard
  // only ever writes .env, so auto-running it is correct ONLY for the default
  // env; for --env=staging|<x> with a missing file, running setup would write
  // the wrong file and doctor would then fail confusingly. Fail clearly here.
  const envPath = join(repoRoot, envFileNameFor(envFlag));
  if (existsSync(envPath)) {
    log(ok(`setup skipped · ${envFileNameFor(envFlag)} already exists (run \`npm run setup\` to reconfigure)`));
    if (answersPath) {
      // Silent no-ops breed "I changed the answers file and nothing happened"
      // confusion; say out loud that the file was not consulted.
      log(
        warn(
          `--answers is ignored because ${envFileNameFor(envFlag)} already exists. ` +
            `To apply it, run \`npm run setup -- --answers ${answersPath}\` (it merges into the existing file), then re-run \`npm run up\`.`,
        ),
      );
    }
    report.steps.push({ id: 'setup', ok: true, skipped: true });
  } else if (envFlag !== 'prod') {
    log(
      fail(
        `no ${envFileNameFor(envFlag)} found, and the setup wizard only writes .env. ` +
          `Create ${envFileNameFor(envFlag)} by copying .env.staging.example (see docs/staging.md), then re-run.`,
      ),
    );
    report.reasons.push(`setup: ${envFileNameFor(envFlag)} missing (wizard cannot create it)`);
    return finish(1);
  } else {
    if (!answersPath && !process.stdin.isTTY) {
      log(fail('no env file and no TTY: pass `--answers <file>` for unattended setup (see examples/answers/).'));
      report.reasons.push('setup: no env file, no TTY, no --answers');
      return finish(1);
    }
    log(bold(UP_STEPS[0].title));
    // --from-up suppresses the wizard's own "Next steps" block; the
    // conductor continues into doctor by itself and prints the real path.
    const setupArgs = [...(answersPath ? ['--answers', answersPath] : []), '--from-up'];
    const code = runPassthrough(UP_STEPS[0], setupArgs);
    report.steps.push({ id: 'setup', ok: code === 0 });
    if (code !== 0) {
      report.reasons.push('setup exited non-zero');
      return finish(1);
    }
  }

  // Docker detection (optional: without it, deploy builds in CodeBuild)
  await noteDockerMode();

  // Steps 2-3 · doctor + early-win, driving typed actions
  for (const spec of UP_STEPS.filter((s) => s.id === 'doctor' || s.id === 'early-win')) {
    log('');
    log(bold(spec.title));
    const res = await driveEnvelopeStep(spec, envFlag, { noWait });
    report.steps.push({ id: spec.id, ok: res.ok, waitedSec: res.waitedSec });
    if (!res.ok) {
      report.reasons.push(...res.reasons);
      // Doctor is excluded: its own aws-identity check already explains
      // credential problems, and on a FIRST run "expired mid-run" would lie.
      if (spec.id === 'early-win') await explainIfCredentialsDied(envFlag);
      return finish(1);
    }
    // The early win IS the model's first answer; show it instead of burying
    // the moment under a pass count. check.data is display-only by the I1
    // contract (never an instruction), and the probe caps output at 32
    // tokens, so a short slice is belt and braces.
    if (spec.id === 'early-win' && res.env) {
      const ew = (res.env.checks as Check[]).find((c) => c.id === 'early-win-bedrock-turn');
      const data = ew?.data as { answer?: unknown; modelId?: unknown } | undefined;
      if (typeof data?.answer === 'string' && data.answer.trim()) {
        const modelNote = typeof data.modelId === 'string' ? ` (${data.modelId})` : '';
        log(info(`your model's first words${modelNote}: ${JSON.stringify(data.answer.trim().slice(0, 160))}`));
      }
    }
  }

  // Step 4 · deploy (passthrough; keeps its own money gate unless --yes)
  const deploySpec = UP_STEPS.find((s) => s.id === 'deploy') as UpStepSpec;
  log('');
  log(bold(deploySpec.title));
  if (!yes) {
    log(dim('  deploy will show the tier cost estimate and ask for confirmation before creating anything.'));
  }
  const deployCode = runPassthrough(deploySpec, [`--env=${envFlag}`, ...(yes ? ['--yes'] : [])]);
  report.steps.push({ id: 'deploy', ok: deployCode === 0 });
  if (deployCode === DEPLOY_EXIT_DECLINED) {
    // Saying No at the money gate is a decision, not a failure: no scary
    // copy, no credentials probe, and above all no verify against an
    // account where nothing was created.
    report.reasons.push('deploy: operator declined the cost gate');
    log(
      info(
        'You declined the cost gate; no stacks were created. The bootstrap primitives (state bucket, lock table, ECR repo) and the pushed image are already in the account and cost pennies; `npm run destroy` removes even those.',
      ),
    );
    log(info('Re-run `npm run up` when ready (it resumes here), or pre-accept with `npm run up -- --yes`.'));
    return finish(1);
  }
  if (deployCode !== 0) {
    report.reasons.push('deploy exited non-zero');
    log(fail('deploy did not finish. It is idempotent: fix the failure it printed, then re-run `npm run up`.'));
    await explainIfCredentialsDied(envFlag);
    return finish(1);
  }

  // Step 5 · verify (strict). Right after a deploy some checks are pure
  // eventual consistency (ECS steady state, CloudFront/WAF propagation, a
  // throttled Bedrock probe), so verify settles through the allowlisted
  // transients on a bounded window instead of exiting 1 at the finish line.
  const verifySpec = UP_STEPS.find((s) => s.id === 'verify') as UpStepSpec;
  log('');
  log(bold(verifySpec.title));
  const verifyRes = await driveEnvelopeStep(verifySpec, envFlag, { noWait }, ['--strict']);
  report.steps.push({ id: 'verify', ok: verifyRes.ok, waitedSec: verifyRes.waitedSec });
  if (!verifyRes.ok) {
    report.reasons.push(...verifyRes.reasons);
    log(dim('  deploy itself succeeded; fix the items above, then run `npm run verify` (or `npm run up`) again.'));
    await explainIfCredentialsDied(envFlag);
    return finish(1);
  }
  report.verdict = 'verified';
  try {
    const envVals = parseEnvFile(readFileSync(envPath, 'utf-8'));
    if (envVals.DASHBOARD_URL) report.dashboardUrl = envVals.DASHBOARD_URL;
  } catch {
    /* report simply omits the url */
  }
  printEpilogue(verifyRes.env, envFlag, Math.round((Date.now() - startedMs) / 1000));
  return finish(0);
}

// Compare resolved paths, not `file://` URLs (import.meta.url percent-encodes
// spaces, so a string compare no-ops the CLI on a spaced/Windows path).
if (process.argv[1] !== undefined && resolve(process.argv[1]) === __filename) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error(fail(`fatal error during up: ${err instanceof Error ? err.message : String(err)}`));
      process.exit(1);
    });
}
