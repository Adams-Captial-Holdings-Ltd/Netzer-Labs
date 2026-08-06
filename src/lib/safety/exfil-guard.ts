/**
 * Exfil guard - scans text payloads for sensitive data patterns.
 *
 * Processes text in 64KB chunks with 1KB overlap to handle patterns
 * that span chunk boundaries. Total payload cap: 10MB. Per-pattern
 * timeout: 50ms (auto-disables runaway patterns).
 */

import { isKillSwitchActive } from '../state/kill-switches-repo.js';
import { getCustomPatterns } from '../state/exfil-patterns-repo.js';
import { writeAudit } from '../audit/audit-writer.js';
import { logger } from '../../observability/logger.js';
import { BUILTIN_PATTERNS, type ExfilPattern } from './exfil-patterns.js';

const CHUNK_SIZE = 64 * 1024;
const OVERLAP = 1024;
const MAX_PAYLOAD = 10 * 1024 * 1024;
const PATTERN_TIMEOUT_MS = 50;

// Patterns auto-disabled at runtime after a regex timeout (catastrophic
// backtracking guard). Keyed by pattern id; survives for the process lifetime.
const disabledPatterns = new Set<string>();

export interface EffectivePattern extends ExfilPattern {
  /** true = shipped built-in pattern; false = operator-supplied custom. */
  builtin: boolean;
}

/**
 * The pattern set actually applied to outbound content: enabled built-ins
 * plus enabled custom patterns, unless the exfil_custom_patterns_disabled
 * kill switch is tripped (in which case only built-ins apply).
 */
export async function getEffectivePatterns(): Promise<EffectivePattern[]> {
  const builtin: EffectivePattern[] = BUILTIN_PATTERNS
    .filter((p) => p.enabled)
    .map((p) => ({ ...p, builtin: true }));

  const customDisabled = await isKillSwitchActive('exfil_custom_patterns_disabled').catch(() => ({
    active: false,
  }));
  if (customDisabled.active) return builtin;

  const custom = await getCustomPatterns().catch(() => [] as ExfilPattern[]);
  return [...builtin, ...custom.filter((p) => p.enabled).map((p) => ({ ...p, builtin: false }))];
}

export interface ExfilScanResult {
  blocked: boolean;
  matches: Array<{
    patternId: string;
    patternName: string;
    severity: 'block' | 'warn';
    snippet: string;
  }>;
  scannedBytes: number;
  truncated: boolean;
}

function compilePattern(pattern: ExfilPattern): RegExp | null {
  try {
    return new RegExp(pattern.regex, 'gi');
  } catch {
    logger.warn({ patternId: pattern.id }, 'exfil: invalid pattern regex');
    return null;
  }
}

function scanChunk(
  chunk: string,
  patterns: Array<{ pattern: ExfilPattern; compiled: RegExp }>,
): ExfilScanResult['matches'] {
  const matches: ExfilScanResult['matches'] = [];
  for (const { pattern, compiled } of patterns) {
    if (disabledPatterns.has(pattern.id)) continue;
    compiled.lastIndex = 0;
    const t0 = Date.now();
    let match: RegExpExecArray | null;
    while ((match = compiled.exec(chunk)) !== null) {
      if (Date.now() - t0 > PATTERN_TIMEOUT_MS) {
        logger.warn({ patternId: pattern.id }, 'exfil: pattern timed out, auto-disabling');
        disabledPatterns.add(pattern.id);
        void writeAudit({
          action: 'exfil_pattern_auto_disabled',
          detail: { patternId: pattern.id, reason: 'timeout' },
          result: 'ok',
        });
        break;
      }
      const snippet = match[0].slice(0, 20) + (match[0].length > 20 ? '...' : '');
      matches.push({
        patternId: pattern.id,
        patternName: pattern.name,
        severity: pattern.severity,
        snippet,
      });
    }
  }
  return matches;
}

export async function scanForExfil(text: string): Promise<ExfilScanResult> {
  const guardDisabled = await isKillSwitchActive('exfil_guard_disabled').catch(() => ({
    active: false,
  }));
  if (guardDisabled.active) {
    return { blocked: false, matches: [], scannedBytes: 0, truncated: false };
  }

  const truncated = text.length > MAX_PAYLOAD;
  const payload = truncated ? text.slice(0, MAX_PAYLOAD) : text;

  // Oversized payloads are scanned up to MAX_PAYLOAD; anything past the cap
  // is silently dropped from inspection. Audit it so a deliberately bloated
  // payload used to push secrets past the scan window is not invisible.
  if (truncated) {
    void writeAudit({
      action: 'exfil_payload_too_large',
      detail: { totalBytes: text.length, scannedBytes: payload.length, capBytes: MAX_PAYLOAD },
      result: 'ok',
    });
  }

  const effective = await getEffectivePatterns();
  const compiledPatterns = effective
    .filter((p) => !disabledPatterns.has(p.id))
    .map((pattern) => ({ pattern, compiled: compilePattern(pattern) }))
    .filter((p): p is { pattern: EffectivePattern; compiled: RegExp } => p.compiled !== null);

  const allMatches: ExfilScanResult['matches'] = [];

  for (let offset = 0; offset < payload.length; offset += CHUNK_SIZE - OVERLAP) {
    const chunk = payload.slice(offset, offset + CHUNK_SIZE);
    const chunkMatches = scanChunk(chunk, compiledPatterns);
    allMatches.push(...chunkMatches);
  }

  const uniqueMatches = allMatches.filter(
    (m, i, arr) => arr.findIndex((a) => a.patternId === m.patternId && a.snippet === m.snippet) === i,
  );

  const blocked = uniqueMatches.some((m) => m.severity === 'block');

  if (blocked) {
    void writeAudit({
      action: 'exfil_blocked',
      detail: {
        matchCount: uniqueMatches.length,
        patterns: uniqueMatches.map((m) => m.patternId),
      },
      result: 'blocked',
    });
  }

  return {
    blocked,
    matches: uniqueMatches,
    scannedBytes: payload.length,
    truncated,
  };
}

export function redactMatches(text: string, patterns?: ExfilPattern[]): string {
  const pats = (patterns ?? BUILTIN_PATTERNS.filter((p) => p.enabled)).filter(
    (p) => !disabledPatterns.has(p.id),
  );
  let result = text;
  for (const pattern of pats) {
    const compiled = compilePattern(pattern);
    if (!compiled) continue;
    // Same elapsed-time budget as scanChunk: a runaway (catastrophically
    // backtracking) admin-authored pattern is auto-disabled instead of
    // stalling the event loop on every streamed chunk. The module header
    // promises this guard universally, but it used to exist only on the
    // detection path, not this redaction path.
    const t0 = Date.now();
    let out = '';
    let cursor = 0;
    compiled.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = compiled.exec(result)) !== null) {
      if (Date.now() - t0 > PATTERN_TIMEOUT_MS) {
        logger.warn({ patternId: pattern.id }, 'exfil: redact pattern timed out, auto-disabling');
        disabledPatterns.add(pattern.id);
        void writeAudit({
          action: 'exfil_pattern_auto_disabled',
          detail: { patternId: pattern.id, reason: 'timeout' },
          result: 'ok',
        });
        break;
      }
      out += result.slice(cursor, match.index) + '[REDACTED]';
      cursor = match.index + match[0].length;
      // A zero-length match would otherwise loop forever at the same index.
      if (match[0].length === 0) compiled.lastIndex++;
    }
    // Redactions found before a timeout still apply; the unscanned remainder
    // passes through, matching scanChunk's break-mid-pattern semantics.
    result = out + result.slice(cursor);
  }
  return result;
}

/** Effective pattern set (built-in + custom), with disabled ones removed. */
export async function getActivePatterns(): Promise<EffectivePattern[]> {
  const effective = await getEffectivePatterns();
  return effective.filter((p) => !disabledPatterns.has(p.id));
}

/**
 * Build a synchronous block-severity redactor for STREAMED output. The async
 * config read (active patterns + guard kill switch) happens ONCE up front; the
 * returned function then redacts block-severity secrets out of each accumulated
 * chunk before it is forwarded to the client, with no further awaits. Because
 * the surface re-renders the latest accumulated text on every chunk, redacting
 * it the moment a block pattern completes means the raw secret is never shown
 * live — closing the streaming exfil window that the post-hoc final scan can't.
 * Warn-severity patterns are intentionally NOT redacted here (log-only, parity
 * with scanOutboundReply). No-ops to a passthrough when the guard is disabled or
 * there are no block patterns, so non-secret streams keep their exact UX.
 */
export async function buildStreamingRedactor(): Promise<(text: string) => string> {
  const guardDisabled = await isKillSwitchActive('exfil_guard_disabled').catch(() => ({
    active: false,
  }));
  if (guardDisabled.active) return (t) => t;
  const active = await getActivePatterns().catch(() => [] as EffectivePattern[]);
  const blockPatterns = active.filter((p) => p.severity === 'block');
  if (blockPatterns.length === 0) return (t) => t;
  return (text: string): string => redactMatches(text, blockPatterns);
}
