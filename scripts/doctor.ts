/**
 * Netzar OS Enterprise — Doctor (pre-deploy preflight)
 *
 * PURE READ-ONLY. Runs the registry of preflight checks from
 * scripts/lib/preflight/checks.ts against the resolved env and prints
 * per-check pass/warn/fail/skip with remediation. Never creates,
 * modifies, or deletes any AWS resource.
 *
 *   npm run doctor                 # human-readable, exit 1 on any FAIL
 *   npm run doctor -- --json       # machine-readable JSON on stdout (legacy)
 *   npm run doctor -- --envelope   # I1 typed command Envelope on stdout
 *   npm run doctor -- --env=staging  # resolve .env.staging like deploy.ts
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bold, dim, fail, gray, info, ok, warn } from './lib/ansi.js';
import { maybePrintHelp } from './lib/help.js';
import { parseEnvFile, resolveEnvFlag, envFileNameFor } from './lib/env-file.js';
import { buildContext, runPreflight, summarize } from './lib/preflight/checks.js';
// Shared with deploy.ts so the embedded preflight prints identically.
import { renderCheckResults, renderSummary } from './lib/preflight/render.js';
// I1 typed command contract (ONBOARDING-PLAN.md). `--envelope` emits the typed
// Envelope; legacy `--json` and prose output are unchanged.
import { printEnvelope } from './lib/envelope/envelope.js';
import { legacyChecksToEnvelope } from './lib/envelope/from-legacy.js';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = dirname(dirname(__filename));

const log = (msg: string): void => {
  // eslint-disable-next-line no-console
  console.log(msg);
};

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (
    maybePrintHelp(args, {
      command: 'npm run doctor',
      oneLiner: 'read-only pre-deploy preflight with a remediation per failure',
      flags: [
        ['--env=<name>', 'target .env.<name> instead of .env'],
        ['--json', 'legacy machine-readable output'],
        ['--envelope', 'typed I1 command envelope on stdout'],
      ],
      contract: 'Read-only AWS describe/list calls; creates, modifies, and deletes nothing.',
      docs: 'AGENTS.md',
    })
  ) {
    process.exit(0);
  }
  const jsonMode = args.includes('--json');
  const envelopeMode = args.includes('--envelope');
  const quiet = jsonMode || envelopeMode;
  const envFlag = resolveEnvFlag(args);
  const envPath = join(repoRoot, envFileNameFor(envFlag));

  if (!existsSync(envPath)) {
    const message =
      `No env file at ${envPath}. ` +
      (envFlag === 'prod'
        ? 'Run `npm run setup` first.'
        : 'Create it by copying .env.staging.example or following docs/staging.md.');
    if (quiet) {
      log(JSON.stringify({ error: message }, null, 2));
    } else {
      log(fail(message));
    }
    process.exit(1);
  }

  const env = parseEnvFile(readFileSync(envPath, 'utf-8'));
  const ctx = buildContext(env);

  if (!quiet) {
    // Name the file being read, not the internal flag ('prod' reads as a
    // choice the first-timer never made).
    log('\n' + bold(`Netzar OS Enterprise · Doctor (${envFileNameFor(envFlag)})`));
    log(gray('─'.repeat(40)));
    log(
      dim(
        `mode ${ctx.mode} · region ${ctx.region} · tier ${ctx.tier} · account ${ctx.account || '(from credentials)'}` +
          (ctx.nameSuffix ? ` · suffix ${ctx.nameSuffix}` : ''),
      ),
    );
    const features = Object.entries(ctx.features)
      .map(([k, v]) => `${k}=${v ? 'on' : 'off'}`)
      .join(' · ');
    log(dim(`features ${features}`));
    log(dim('read-only preflight — no AWS resource is created, modified, or deleted\n'));
  }

  const results = await runPreflight(ctx);
  const summary = summarize(results);

  if (envelopeMode) {
    // I1 typed contract: emit the Envelope and exit on its typed `ok`.
    const envelope = legacyChecksToEnvelope({
      command: 'doctor',
      results,
      account: ctx.resolvedAccount ?? ctx.account,
      region: ctx.region,
      mode: ctx.mode,
    });
    printEnvelope(envelope, { json: true });
    process.exit(envelope.ok ? 0 : 1);
  }

  if (jsonMode) {
    log(
      JSON.stringify(
        {
          checks: results,
          summary,
          mode: ctx.mode,
          account: ctx.resolvedAccount ?? ctx.account,
          region: ctx.region,
        },
        null,
        2,
      ),
    );
    process.exit(summary.fail > 0 ? 1 : 0);
  }

  renderCheckResults(results, log);
  warnTrackedFileDrift(log);
  renderSummary(summary, log);
  if (summary.fail > 0) {
    log(fail('doctor found blocking problems — fix the FAIL items above before deploying'));
    process.exit(1);
  }
  if (summary.warn > 0) {
    log(warn('doctor passed with warnings — review the WARN items above'));
  } else {
    log(ok('all preflight checks passed'));
  }
  log(info('Next: `npm run deploy` (doctor is also auto-run by deploy).'));
  process.exit(0);
}

/**
 * Tracked-files drift check (IaC readiness item 43, the code/config
 * separation contract — see docs/code-config-contract.md). The repo is
 * CODE; configuration belongs in .env / Secrets Manager / runtime-config,
 * never in tracked files. A locally modified TRACKED file is the early
 * warning for merge pain at the next release-tag checkout, so doctor
 * WARNs (never fails) with the list. Read-only (`git status --porcelain`);
 * skips cleanly when git is unavailable or this is not a work tree.
 * Untracked files (`??`) are fine by design — .env itself is untracked.
 * Human output only: the JSON path returns before this section runs.
 */
function warnTrackedFileDrift(log: (msg: string) => void): void {
  let porcelain: string;
  try {
    porcelain = execFileSync('git', ['status', '--porcelain'], {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    log(dim('tracked-files drift: skipped (git unavailable or not a git work tree)'));
    return;
  }
  const modified = porcelain
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0 && !l.startsWith('??') && !l.startsWith('!!'))
    .map((l) => l.slice(3));
  if (modified.length === 0) return;
  log(warn(`tracked-files drift: ${modified.length} locally modified tracked file(s):`));
  const shown = modified.slice(0, 20);
  for (const f of shown) log(warn(`  ${f}`));
  if (modified.length > shown.length) log(warn(`  ... and ${modified.length - shown.length} more`));
  log(
    dim(
      'early warning for merge pain; configuration belongs in .env/runtime-config, not tracked ' +
        'files — see docs/code-config-contract.md (fork-and-modify has a documented rebase path)',
    ),
  );
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(fail(`fatal error during doctor: ${err instanceof Error ? err.message : String(err)}`));
  process.exit(1);
});
