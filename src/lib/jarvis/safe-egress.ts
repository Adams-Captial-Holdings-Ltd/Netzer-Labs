/**
 * Fail-closed model-input redaction (JARVIS-PLAN.md §1b H1).
 *
 * Nova 2 Sonic is speech-to-speech: it can SPEAK a secret before any output
 * scan, and a Bedrock Guardrail CANNOT attach to the bidirectional session
 * (§1c). So the ONLY mandatory egress boundary is the data that ever reaches
 * the model — every `query` and `read_view` result is passed through
 * `redactForModel()` BEFORE it reaches Bedrock.
 *
 * This is deliberately stricter than the generic `scanForExfil` /
 * `redactMatches`:
 *   (a) redact on BOTH warn and block severities (not just block);
 *   (b) use the effective custom patterns;
 *   (c) if the exfil guard is disabled, OR the scan errors/times out, OR the
 *       guard state is unknown, WITHHOLD the content entirely (placeholder)
 *       rather than pass raw text. In voice mode that also means refusing to
 *       narrate the value.
 *
 * The generic guard's "warn-only / fail-open when disabled" semantics are
 * explicitly NOT inherited (that is the H1 bug it fixes).
 */

import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../state/ddb.js';
import {
  scanForExfil,
  redactMatches,
  getEffectivePatterns,
} from '../safety/exfil-guard.js';
import { logger } from '../../observability/logger.js';

export const WITHHELD_PLACEHOLDER = '[withheld: content could not be safely shared]';

/** A defensive cap so a runaway repo result cannot stall the scan. */
const SCAN_TIMEOUT_MS = 3_000;

const KILL_SWITCH_TABLE = process.env.TABLE_KILL_SWITCHES ?? 'claudeclaw-kill-switches';

/**
 * Fail-closed read of `exfil_guard_disabled`. THROWS on a DDB error so the
 * caller withholds — unlike the fail-OPEN `isKillSwitchActive`, which collapses
 * a DDB error to "not disabled" and would silently let the scan proceed. A
 * missing item means the guard is not disabled (active:false), the normal path.
 */
async function exfilGuardDisabled(): Promise<boolean> {
  const out = await ddb().send(
    new GetCommand({
      TableName: KILL_SWITCH_TABLE,
      Key: { PK: 'SWITCH#exfil_guard_disabled', SK: 'STATUS' },
    }),
  );
  return Boolean(out.Item && (out.Item as { active?: boolean }).active);
}

export interface RedactionResult {
  /** The text safe to hand the model (redacted, or the placeholder if withheld). */
  text: string;
  /** True when the whole payload was withheld (guard disabled / scan failed). */
  withheld: boolean;
  /** Count of matched patterns (warn + block). */
  matchCount: number;
}

function withhold(matchCount = 0): RedactionResult {
  return { text: WITHHELD_PLACEHOLDER, withheld: true, matchCount };
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return await Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error('scan_timeout')), ms),
    ),
  ]);
}

/**
 * Redact a repo/page result before it reaches the model. Fail-closed at every
 * step. Accepts a string or any JSON-serializable value (it is stringified).
 */
export async function redactForModel(raw: unknown): Promise<RedactionResult> {
  const text = typeof raw === 'string' ? raw : safeStringify(raw);
  if (!text) return { text: '', withheld: false, matchCount: 0 };

  // (a) Guard disabled OR unknown → withhold. The read THROWS on a DDB error,
  //     so an unknown guard state withholds rather than silently scanning.
  let guardDisabled: boolean;
  try {
    guardDisabled = await exfilGuardDisabled();
  } catch {
    return withhold();
  }
  if (guardDisabled) return withhold();

  // (b) Scan (warn + block). A scan failure/timeout → withhold.
  let scan;
  try {
    scan = await withTimeout(scanForExfil(text), SCAN_TIMEOUT_MS);
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'safe-egress: scan failed — withholding');
    return withhold();
  }

  if (scan.matches.length === 0) {
    return { text, withheld: false, matchCount: 0 };
  }

  // (c) Matches (warn or block) → redact with the effective custom patterns.
  try {
    const patterns = await withTimeout(getEffectivePatterns(), SCAN_TIMEOUT_MS);
    const redacted = redactMatches(text, patterns);
    return { text: redacted, withheld: false, matchCount: scan.matches.length };
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'safe-egress: redact failed — withholding');
    return withhold(scan.matches.length);
  }
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v) ?? '';
  } catch {
    return '';
  }
}
