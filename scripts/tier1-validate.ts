/**
 * Netzar OS Enterprise — Tier 1 zero-cost validation (onboarding phases 0-3).
 *
 * Drives the READ-ONLY onboarding gates in order and STOPS at the
 * resource-creation boundary, so it can validate a brand-new standalone account
 * without ever creating a paid AWS resource. It exercises, in sequence:
 *
 *   1. doctor   (Phase 1)  read-only preflight  -> typed envelope
 *   2. early-win(Phase 2)  one tiny guardrailed Bedrock turn (~cents, no resource)
 *   3. bootstrap(Phase 3)  isolation scan + account-profile + credential guard
 *      (the actual primitive CREATION is reported as typed 'pending' and is the
 *      line this driver deliberately stops at)
 *
 * It acts ONLY on the typed I1 envelope each command emits (validateEnvelope),
 * never on prose. Any malformed output, any failing gate, or any unexpected
 * pending fails CLOSED. Bootstrap's provisioning checks (tripwire/toolkit/state/
 * scoped-role/assume-role) are EXPECTED 'pending' and are surfaced as DEFERRED,
 * not failures: crossing that line creates resources and needs explicit opt-in.
 *
 *   npm run validate:tier1                 # run the gates (real AWS reads, $0)
 *   npm run validate:tier1 -- --plan       # print the plan, run nothing
 *   npm run validate:tier1 -- --json       # consolidated machine report
 *   npm run validate:tier1 -- --env=staging
 *
 * SPEND GUARANTEE: this driver runs only read-only AWS calls plus one bounded
 * Bedrock probe (max 32 output tokens, max 3 attempts). It creates NO AWS
 * resource and prints "$0 spent". The next step (creating bootstrap primitives,
 * then `npm run deploy`) is the first thing that can cost money, and this driver
 * never takes it.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bold, dim, fail, gray, info, ok } from './lib/ansi.js';
import { resolveEnvFlag, envFileNameFor } from './lib/env-file.js';
import { validateEnvelope, type Check, type Envelope } from './lib/envelope/envelope.js';
import {
  CHECK_ISOLATION,
  CHECK_ACCOUNT_PROFILE,
  CHECK_CREDENTIAL_GUARD,
  CHECK_TRIPWIRE,
  CHECK_TOOLKIT,
  CHECK_STATE_PRIMITIVES,
  CHECK_SCOPED_ROLE,
  CHECK_ASSUME_ROLE,
} from './bootstrap.js';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = dirname(dirname(__filename));

/** Bootstrap checks that must PASS for the read-only gate to be green. */
export const BOOTSTRAP_READONLY_GATE_IDS: readonly string[] = [
  CHECK_ISOLATION,
  CHECK_ACCOUNT_PROFILE,
  CHECK_CREDENTIAL_GUARD,
];

/** Bootstrap checks that CREATE resources; 'pending' here is the expected stop. */
export const BOOTSTRAP_PROVISIONING_IDS: readonly string[] = [
  CHECK_TRIPWIRE,
  CHECK_TOOLKIT,
  CHECK_STATE_PRIMITIVES,
  CHECK_SCOPED_ROLE,
  CHECK_ASSUME_ROLE,
];

export type StepId = 'doctor' | 'early-win' | 'bootstrap';

export interface StepSpec {
  id: StepId;
  title: string;
  script: string;
  /** The flag that makes the command emit the I1 typed envelope as JSON. */
  flag: string;
  costNote: string;
}

export const TIER1_STEPS: readonly StepSpec[] = [
  {
    id: 'doctor',
    title: 'Phase 1 — doctor (read-only preflight)',
    script: 'scripts/doctor.ts',
    flag: '--envelope',
    costNote: 'read-only AWS describe/list calls; creates nothing',
  },
  {
    id: 'early-win',
    title: 'Phase 2 — early win (one bounded Bedrock turn)',
    script: 'scripts/early-win.ts',
    flag: '--json',
    costNote: 'one guardrailed Bedrock call, max 32 output tokens; no AWS resource',
  },
  {
    id: 'bootstrap',
    title: 'Phase 3 — bootstrap gates (isolation + account-profile + credential guard)',
    script: 'scripts/bootstrap.ts',
    flag: '--json',
    costNote: 'read-only isolation scan; primitive CREATION is reported pending and NOT executed',
  },
];

// ─────────────────────────────────────────────────────────────────────
// Pure core (exported for tests; no I/O)
// ─────────────────────────────────────────────────────────────────────

/**
 * Extract the typed envelope from a command's stdout. The command may print a
 * prose line first (e.g. early-win's "Claude answered: ..."), so try parsing an
 * envelope starting at each `{` and return the first that validates. Throws
 * (fail closed) when no valid envelope is present: non-typed output is never
 * trusted.
 */
export function extractEnvelope(stdout: string): Envelope {
  let from = stdout.indexOf('{');
  let lastErr: unknown;
  while (from !== -1) {
    try {
      return validateEnvelope(stdout.slice(from));
    } catch (err) {
      lastErr = err;
      from = stdout.indexOf('{', from + 1);
    }
  }
  throw new Error(
    `no valid command envelope in output (${lastErr instanceof Error ? lastErr.message : String(lastErr)}). ` +
      'Refusing to act on non-typed output.',
  );
}

export interface StepVerdict {
  id: StepId;
  ok: boolean;
  /** Checks that block the gate (a fail, or an unexpected pending). */
  blocking: { id: string; status: string; detail: string }[];
  /** Checks intentionally deferred (provisioning steps reported pending). */
  deferred: { id: string; status: string }[];
}

/**
 * Classify one command's envelope into the tier-1 gate decision.
 * - doctor / early-win: green only when there is no fail AND no pending.
 * - bootstrap: the read-only gate ids must PASS; the provisioning ids are
 *   allowed to be 'pending' (deferred) but a provisioning 'fail' still blocks;
 *   any other check that fails or is unexpectedly pending blocks.
 */
export function classifyStep(id: StepId, env: Envelope): StepVerdict {
  const blocking: StepVerdict['blocking'] = [];
  const deferred: StepVerdict['deferred'] = [];

  for (const c of env.checks as Check[]) {
    const isProvisioning = id === 'bootstrap' && BOOTSTRAP_PROVISIONING_IDS.includes(c.id);
    if (isProvisioning) {
      if (c.status === 'pending' || c.status === 'skip') {
        deferred.push({ id: c.id, status: c.status });
      } else if (c.status === 'fail') {
        blocking.push({ id: c.id, status: c.status, detail: c.detail });
      }
      continue;
    }
    if (c.status === 'fail' || c.status === 'pending') {
      blocking.push({ id: c.id, status: c.status, detail: c.detail });
    }
  }

  return { id, ok: blocking.length === 0, blocking, deferred };
}

export interface Tier1Report {
  tier: 1;
  verdict: 'green' | 'blocked';
  spentUsd: 0;
  resourcesCreated: 0;
  steps: StepVerdict[];
  deferred: string[];
  reasons: string[];
  nextStep: string;
}

export function decideTier1(steps: StepVerdict[]): Pick<Tier1Report, 'verdict' | 'reasons' | 'deferred'> {
  const reasons: string[] = [];
  for (const s of steps) {
    for (const b of s.blocking) reasons.push(`${s.id}: ${b.id} is ${b.status}`);
  }
  const deferred = steps.flatMap((s) => s.deferred.map((d) => `${s.id}: ${d.id}`));
  return { verdict: reasons.length === 0 ? 'green' : 'blocked', reasons, deferred };
}

const NEXT_STEP =
  'Tier 1 is read-only and free. The NEXT step creates real resources: bootstrap ' +
  'primitives (state bucket, lock table, ECR, scoped role, TTL tripwire — pennies), ' +
  'then `npm run deploy` (standing infra, ~$50-90/mo until `npm run destroy`). ' +
  'Run those only after you accept that spend.';

// ─────────────────────────────────────────────────────────────────────
// I/O shell
// ─────────────────────────────────────────────────────────────────────

interface RunStepResult {
  env?: Envelope;
  error?: string;
  rawTail?: string;
}

function runStep(step: StepSpec, envFlag: string): RunStepResult {
  const tsxBin = join(repoRoot, 'node_modules', '.bin', 'tsx');
  const scriptPath = join(repoRoot, step.script);
  const result = spawnSync(tsxBin, [scriptPath, step.flag, `--env=${envFlag}`], {
    cwd: repoRoot,
    encoding: 'utf-8',
    env: process.env, // inherit AWS credentials from the operator's shell
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) {
    return { error: `failed to spawn ${step.script}: ${result.error.message}` };
  }
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

const log = (msg: string): void => {
  // eslint-disable-next-line no-console
  console.log(msg);
};

function printPlan(envFlag: string): void {
  log('\n' + bold('Netzar OS Enterprise · Tier 1 zero-cost validation (plan)'));
  log(gray('─'.repeat(48)));
  log(dim(`env ${envFlag} · runs nothing in --plan mode`));
  for (const [i, step] of TIER1_STEPS.entries()) {
    log(`  ${i + 1}. ${bold(step.title)}`);
    log(dim(`     ${step.script} ${step.flag} · ${step.costNote}`));
  }
  log('');
  log(info('SPEND GUARANTEE: read-only AWS calls + one bounded Bedrock probe. $0, no resource created.'));
  log(dim('  ' + NEXT_STEP));
  log('');
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const planMode = argv.includes('--plan');
  const jsonMode = argv.includes('--json');
  const envFlag = resolveEnvFlag(argv);

  if (planMode) {
    if (jsonMode) {
      log(JSON.stringify({ tier: 1, plan: TIER1_STEPS, spendGuarantee: '$0, no resource created', nextStep: NEXT_STEP }, null, 2));
    } else {
      printPlan(envFlag);
    }
    return 0;
  }

  const envPath = join(repoRoot, envFileNameFor(envFlag));
  if (!existsSync(envPath)) {
    const message =
      `No env file at ${envPath}. Tier 1 needs region + Bedrock model ids. ` +
      'Create a minimal .env (AWS_REGION + BEDROCK_*_MODEL) or run `npm run setup` first.';
    log(jsonMode ? JSON.stringify({ tier: 1, verdict: 'blocked', error: message }, null, 2) : fail(message));
    return 1;
  }
  // Touch the file so a malformed env surfaces here, not mid-step.
  readFileSync(envPath, 'utf-8');

  if (!jsonMode) {
    log('\n' + bold(`Netzar OS Enterprise · Tier 1 zero-cost validation (${envFlag})`));
    log(gray('─'.repeat(48)));
    log(dim('read-only gates for a brand-new standalone account; creates NO AWS resource\n'));
  }

  const verdicts: StepVerdict[] = [];
  for (const step of TIER1_STEPS) {
    if (!jsonMode) log(bold(step.title));
    const res = runStep(step, envFlag);
    if (res.error || !res.env) {
      // Fail closed: a step we cannot read typed output from stops the run.
      if (!jsonMode) {
        log(fail(`  ${step.id}: ${res.error ?? 'no envelope'}`));
        if (res.rawTail) log(dim(`  …${res.rawTail}`));
      }
      const decision = decideTier1(verdicts);
      const report: Tier1Report = {
        tier: 1,
        verdict: 'blocked',
        spentUsd: 0,
        resourcesCreated: 0,
        steps: verdicts,
        deferred: decision.deferred,
        reasons: [...decision.reasons, `${step.id}: ${res.error ?? 'unreadable output'}`],
        nextStep: NEXT_STEP,
      };
      if (jsonMode) log(JSON.stringify(report, null, 2));
      else printVerdict(report);
      return 1;
    }
    const verdict = classifyStep(step.id, res.env);
    verdicts.push(verdict);
    if (!jsonMode) {
      const s = res.env.summary;
      log(
        dim(
          `  ${verdict.ok ? ok('gate ok') : fail('gate blocked')} · ` +
            `${s.pass} pass · ${s.warn} warn · ${s.fail} fail · ${s.pending} pending` +
            (verdict.deferred.length ? ` · ${verdict.deferred.length} deferred (resource creation)` : ''),
        ),
      );
      for (const b of verdict.blocking) log(fail(`    blocked: ${b.id} (${b.status}) ${b.detail}`));
    }
    // Stop the run on the first blocking gate (don't spend the next Bedrock cent
    // or run the isolation scan if creds/region/model are already wrong).
    if (!verdict.ok) {
      const decision = decideTier1(verdicts);
      const report: Tier1Report = {
        tier: 1,
        verdict: 'blocked',
        spentUsd: 0,
        resourcesCreated: 0,
        steps: verdicts,
        deferred: decision.deferred,
        reasons: decision.reasons,
        nextStep: NEXT_STEP,
      };
      if (jsonMode) log(JSON.stringify(report, null, 2));
      else printVerdict(report);
      return 1;
    }
  }

  const decision = decideTier1(verdicts);
  const report: Tier1Report = {
    tier: 1,
    verdict: decision.verdict,
    spentUsd: 0,
    resourcesCreated: 0,
    steps: verdicts,
    deferred: decision.deferred,
    reasons: decision.reasons,
    nextStep: NEXT_STEP,
  };
  if (jsonMode) log(JSON.stringify(report, null, 2));
  else printVerdict(report);
  return report.verdict === 'green' ? 0 : 1;
}

function printVerdict(report: Tier1Report): void {
  log('');
  log(gray('─'.repeat(48)));
  if (report.verdict === 'green') {
    log(ok('Tier 1 GREEN — read-only gates passed.'));
  } else {
    log(fail('Tier 1 BLOCKED — fix the items above before going further.'));
    for (const r of report.reasons) log(fail(`  ${r}`));
  }
  if (report.deferred.length) {
    log(dim(`  deferred (would create resources, not run): ${report.deferred.join(', ')}`));
  }
  log(info('spend this run: $0.00 · AWS resources created: 0'));
  log(dim('  ' + report.nextStep));
  log('');
}

// Compare resolved paths, not `file://` URLs (import.meta.url percent-encodes
// spaces, so a string compare no-ops the CLI on a spaced/Windows path).
if (process.argv[1] !== undefined && resolve(process.argv[1]) === __filename) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error(fail(`fatal error during tier1-validate: ${err instanceof Error ? err.message : String(err)}`));
      process.exit(1);
    });
}
