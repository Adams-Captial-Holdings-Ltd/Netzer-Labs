/**
 * Netzar OS Enterprise — Status / Verify (IaC readiness plan, P2)
 *
 * Runs the post-deploy verification registry (scripts/lib/verify/checks.ts)
 * against the resolved env and prints per-check pass/warn/fail/skip with the
 * SAME renderer doctor uses. Three layers, all mode-aware:
 *
 *   A — CFN-derived resource checks (stacks, ECS steady, dashboard endpoint
 *       per mode, private-posture scan, plain-HTTP exposure, DDB/SQS/SNS/S3/
 *       ECR/scheduler, WAF+CloudFront when tier-enabled)
 *   B — value checks (manifest, secret version freshness, seed rows)
 *   C — external + Bedrock probes (feature-aware)
 *
 *   npm run status                   # read-only checks, exit 1 on any FAIL
 *   npm run status -- --strict       # + paid Bedrock probes (Converse/Titan)
 *                                    #   and external deliverability checks
 *   npm run status -- --json         # machine-readable JSON on stdout (legacy)
 *   npm run status -- --envelope     # I1 typed command Envelope on stdout
 *   npm run status -- --env=staging  # resolve .env.staging like deploy.ts
 *
 * `npm run verify` is wired by the deploy orchestrator as
 * `tsx scripts/status.ts --strict` — verify IS status in strict mode.
 *
 * Mutation contract: read-only, except under --strict exactly two PAID model
 * invocations (one Converse with the configured guardrail, one Titan
 * embedding when knowledge is enabled) plus external vendor-API reads.
 * Verify never registers webhooks, never writes secrets, never touches infra.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bold, dim, fail, gray, ok, warn } from './lib/ansi.js';
import { maybePrintHelp } from './lib/help.js';
import { parseEnvFile, resolveEnvFlag, envFileNameFor } from './lib/env-file.js';
import {
  allChecks,
  buildVerifyContext,
  getManifest,
  runVerify,
  summarize,
  type VerifyLayer,
} from './lib/verify/checks.js';
// Shared with doctor/deploy so verification prints identically.
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

const LAYER_HEADERS: Record<VerifyLayer, string> = {
  A: 'Layer A · CFN-derived resource checks',
  B: 'Layer B · value checks (manifest, secrets, seed)',
  C: 'Layer C · external + Bedrock probes',
};

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (
    maybePrintHelp(args, {
      command: 'npm run status (npm run verify = status --strict)',
      oneLiner: 'post-deploy verification: stacks, values, external + Bedrock probes',
      flags: [
        ['--env=<name>', 'target .env.<name> instead of .env'],
        ['--strict', 'the verify gate: adds two PAID Bedrock probes (~a cent) + external checks'],
        ['--json', 'legacy machine-readable output'],
        ['--envelope', 'typed I1 command envelope on stdout'],
      ],
      contract: 'Read-only, except exactly two paid model invocations under --strict; never registers webhooks or writes secrets.',
      docs: 'AGENTS.md',
    })
  ) {
    process.exit(0);
  }
  const jsonMode = args.includes('--json');
  const envelopeMode = args.includes('--envelope');
  const quiet = jsonMode || envelopeMode;
  const strict = args.includes('--strict');
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
  // Same suffix derivation as deploy.ts: `--env=staging` implies the
  // `staging` suffix even when .env.staging never sets CCE_NAME_SUFFIX.
  // Without this, a staging verify would check the UNSUFFIXED (prod)
  // resources and report the wrong install's health.
  env.CCE_NAME_SUFFIX = env.CCE_NAME_SUFFIX ?? (envFlag === 'prod' ? '' : envFlag);
  const ctx = buildVerifyContext(env, { strict });

  if (!quiet) {
    // Name the file being read, not the internal flag ('prod' reads as a
    // choice the first-timer never made).
    log('\n' + bold(`Netzar OS Enterprise · Status${strict ? ' (strict / verify)' : ''} (${envFileNameFor(envFlag)})`));
    log(gray('─'.repeat(40)));
    log(
      dim(
        `mode ${ctx.mode}${ctx.privateAccessOnly ? ' (private access only)' : ''} · region ${ctx.region} · tier ${ctx.tier}` +
          ` · stack prefix ${ctx.stackPrefix}` +
          (ctx.nameSuffix ? ` · suffix ${ctx.nameSuffix}` : ''),
      ),
    );
    const features = Object.entries(ctx.features)
      .map(([k, v]) => `${k}=${v ? 'on' : 'off'}`)
      .join(' · ');
    log(dim(`features ${features}`));
    log(
      dim(
        strict
          ? 'strict mode — includes two PAID Bedrock probes (~a cent total) and external vendor-API checks\n'
          : 'read-only — paid probes and external deliverability checks are skipped (run --strict)\n',
      ),
    );
  }

  const results = await runVerify(ctx);
  const summary = summarize(results);

  // The manifest load is memoized by the checks; this re-read costs nothing
  // and feeds both the JSON contract and the human footer.
  const { manifest } = await getManifest(ctx);
  const manifestInfo = manifest
    ? { deployId: manifest.deployId, gitSha: manifest.gitSha, imageTag: manifest.imageTag }
    : null;

  if (envelopeMode) {
    // I1 typed contract: emit the Envelope and exit on its typed `ok`.
    const envelope = legacyChecksToEnvelope({
      command: 'verify',
      results,
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
          manifest: manifestInfo,
        },
        null,
        2,
      ),
    );
    process.exit(summary.fail > 0 ? 1 : 0);
  }

  // Render grouped by layer, with the shared per-check renderer.
  const byId = new Map(allChecks.map((c) => [c.id, c.layer] as const));
  for (const layer of ['A', 'B', 'C'] as VerifyLayer[]) {
    const layerResults = results.filter((r) => byId.get(r.id) === layer);
    if (layerResults.length === 0) continue;
    log(bold(LAYER_HEADERS[layer]));
    renderCheckResults(layerResults, log);
    log('');
  }

  renderSummary(summary, log);
  if (manifestInfo) {
    log(dim(`  manifest: deploy ${manifestInfo.deployId} · git ${manifestInfo.gitSha} · image ${manifestInfo.imageTag}`));
  } else {
    log(dim('  manifest: none readable in the state bucket'));
  }
  if (summary.fail > 0) {
    log(fail('verification found blocking problems — fix the FAIL items above'));
    process.exit(1);
  }
  if (summary.warn > 0) {
    log(warn('verification passed with warnings — review the WARN items above'));
  } else {
    log(ok('all verification checks passed'));
  }
  process.exit(0);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(fail(`fatal error during status: ${err instanceof Error ? err.message : String(err)}`));
  process.exit(1);
});
