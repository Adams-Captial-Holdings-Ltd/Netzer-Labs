/**
 * Prove the I2/I4 scoped-deploy permission boundary DENIES the off-account
 * foothold catalog against AWS's real policy-evaluation engine, via
 * iam:SimulateCustomPolicy. Read-only, creates NO resource, costs nothing, and
 * needs no fresh standalone account: any working AWS credentials will do.
 *
 *   npm run verify:boundary                # run; SKIP (exit 0) if no creds
 *   npm run verify:boundary -- --require   # FAIL (exit 1) if creds are missing
 *   npm run verify:boundary -- --json      # emit the typed I1 envelope
 *
 * Without credentials it emits a single `skip` check and exits 0 so it is safe
 * in CI; with credentials every forbidden action must come back NOT allowed and
 * the needed-actions sample must come back allowed, or it exits non-zero.
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IAMClient, SimulateCustomPolicyCommand } from '@aws-sdk/client-iam';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { makeCheck, makeEnvelope, noneAction, printEnvelope, type Check } from './lib/envelope/envelope.js';
import { buildBoundarySimCases, simulateCase, summarizeSim, type IamSimClient } from './lib/onboarding/boundary-sim.js';

const __filename = fileURLToPath(import.meta.url);

function looksLikeMissingCreds(err: unknown): boolean {
  const name = (err as { name?: string })?.name ?? '';
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  // NOTE: AccessDenied / AccessDeniedException is deliberately NOT here. A denied
  // call means credentials ARE present (just not permitted for this action), which
  // is the opposite of "no credentials". Treating it as missing-creds would let a
  // tight-SCP principal whose sts:GetCallerIdentity is denied SILENTLY SKIP the
  // boundary proof with exit 0 — a fail-open in the security gate.
  return (
    /CredentialsProviderError|UnrecognizedClientException|InvalidClientTokenId|ExpiredToken/i.test(name) ||
    msg.includes('could not load credentials') ||
    msg.includes('credential is missing') ||
    msg.includes('unable to locate credentials') ||
    msg.includes('security token') && msg.includes('invalid')
  );
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const json = argv.includes('--json');
  const require = argv.includes('--require');
  const region = process.env.AWS_REGION ?? 'us-east-1';

  // Preflight: confirm we have usable credentials (and learn the account id).
  let account: string | undefined;
  try {
    const sts = new STSClient({ region });
    const id = await sts.send(new GetCallerIdentityCommand({}));
    account = id.Account;
  } catch (err) {
    if (looksLikeMissingCreds(err)) {
      // Genuinely no credentials. Skip (exit 0) unless --require makes it a gate.
      const env = makeEnvelope({
        command: 'verify',
        region,
        checks: [
          makeCheck({
            id: 'boundary-simulation',
            title: 'IAM boundary simulation (iam:SimulateCustomPolicy)',
            status: require ? 'fail' : 'skip',
            detail: require
              ? 'No usable AWS credentials and --require was set: failing the boundary gate.'
              : 'No usable AWS credentials, skipping the live boundary proof. ' +
                'Configure read-only creds (any account) and re-run, or pass --require to make this a hard failure.',
            action: noneAction(),
          }),
        ],
      });
      printEnvelope(env, { json });
      return require ? 1 : 0;
    }
    // Credentials ARE present but GetCallerIdentity failed (e.g. an SCP/boundary
    // denies sts:GetCallerIdentity). Do NOT skip and do NOT fail here: fall
    // through to the simulation, which is the real gate. The account id is only
    // cosmetic for the envelope, so leaving it undefined is fine.
  }

  const iam: IamSimClient = new IAMClient({ region });
  const cases = buildBoundarySimCases();
  const checks: Check[] = [];
  for (const c of cases) {
    let status: Check['status'] = 'pass';
    let detail = c.description;
    let data: unknown;
    try {
      const results = await simulateCase(
        iam,
        c,
        SimulateCustomPolicyCommand as unknown as new (input: unknown) => unknown,
      );
      const summary = summarizeSim(results);
      if (summary.failed > 0) {
        status = 'fail';
        detail = `${c.description} — ${summary.failed}/${summary.total} actions resolved the WRONG way`;
        data = summary.failures.map((f) => ({ action: f.action, decision: f.decision, expected: f.expect }));
      } else {
        detail = `${c.description} — all ${summary.total} actions resolved as ${c.expect}`;
      }
    } catch (err) {
      status = 'fail';
      detail = `${c.description} — simulation call failed: ${err instanceof Error ? err.message : String(err)}`;
    }
    checks.push(makeCheck({ id: c.id, title: c.description, status, detail, ...(data !== undefined ? { data } : {}), action: noneAction() }));
  }

  const env = makeEnvelope({ command: 'verify', account, region, checks });
  printEnvelope(env, { json });
  return env.ok ? 0 : 1;
}

// Compare resolved paths (import.meta.url percent-encodes spaces; a string
// compare would no-op the CLI on a spaced/Windows path).
if (process.argv[1] !== undefined && resolve(process.argv[1]) === __filename) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error(`fatal error during verify-boundary: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    });
}
