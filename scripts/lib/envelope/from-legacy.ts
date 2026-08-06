/**
 * Bridge: legacy CheckResult[] -> the I1 typed Envelope.
 *
 * `doctor` and `status`/`verify` were built before the typed command contract
 * (I1, scripts/lib/envelope/envelope.ts). They emit a CheckResult[] with prose
 * remediation. ONBOARDING-PLAN.md asks for these commands to speak the typed
 * contract. Rather than rewrite their check registries, this adapter LIFTS the
 * existing results into a typed Envelope so the commands gain an additive
 * `--envelope` emission while keeping their prose + legacy `--json` output for
 * backward compatibility.
 *
 * The legacy `remediation` is prose, so it folds (inert) into the check detail.
 * The typed `action` stays a none-action until each underlying check is
 * upgraded to carry its own typed action. No legacy or AWS-sourced text ever
 * becomes an executable action: that is the I1 guarantee, preserved here.
 */

import { makeCheck, makeEnvelope, type Check, type CommandId, type Envelope } from './envelope.js';

/** The shape doctor/verify checks already emit (scripts/lib/preflight/checks.ts). */
export interface LegacyCheck {
  id: string;
  title: string;
  status: 'pass' | 'warn' | 'fail' | 'skip';
  detail: string;
  remediation?: string;
}

export interface LegacyToEnvelopeInput {
  command: CommandId;
  results: LegacyCheck[];
  account?: string;
  region?: string;
  /** Free-form mode string; only 'chat'/'infra-only' are carried onto the envelope. */
  mode?: string;
  runId?: string;
}

function narrowMode(mode: string | undefined): 'chat' | 'infra-only' | undefined {
  return mode === 'chat' || mode === 'infra-only' ? mode : undefined;
}

export function legacyChecksToEnvelope(input: LegacyToEnvelopeInput): Envelope {
  const checks: Check[] = input.results.map((r) =>
    makeCheck({
      id: r.id,
      title: r.title,
      status: r.status,
      detail: r.remediation ? `${r.detail}\nremediation: ${r.remediation}` : r.detail,
    }),
  );
  const mode = narrowMode(input.mode);
  return makeEnvelope({
    command: input.command,
    checks,
    ...(input.runId !== undefined ? { runId: input.runId } : {}),
    ...(input.account !== undefined ? { account: input.account } : {}),
    ...(input.region !== undefined ? { region: input.region } : {}),
    ...(mode !== undefined ? { mode } : {}),
  });
}
