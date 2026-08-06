/**
 * Belt-and-suspenders PII redaction for log lines + audit detail.
 *
 * The Bedrock Guardrail handles redaction at the model layer (input
 * AND output). This module adds a second pass on text that lands in
 * places the guardrail doesn't see: pino log messages, audit detail
 * blobs, scheduled task prompt_text.
 *
 * Gated on the `pii_redaction_enabled` kill switch — when "active" we
 * redact aggressively; otherwise we pass through unchanged.
 */

import { isKillSwitchActive } from '../state/kill-switches-repo.js';

const PATTERNS: Array<{ name: string; re: RegExp; replace: string }> = [
  { name: 'email', re: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, replace: '[email]' },
  { name: 'ssn', re: /\b\d{3}-\d{2}-\d{4}\b/g, replace: '[ssn]' },
  { name: 'cc', re: /\b(?:\d[ -]*?){13,19}\b/g, replace: '[card]' },
  { name: 'phone', re: /(?:\+?1[ .-]?)?\(?\d{3}\)?[ .-]?\d{3}[ .-]?\d{4}/g, replace: '[phone]' },
  { name: 'aws_access_key', re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, replace: '[aws_access_key]' },
  { name: 'aws_secret', re: /\b[A-Za-z0-9/+=]{40}\b/g, replace: '[secret-40-char]' },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, replace: '[jwt]' },
  { name: 'ipv4', re: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g, replace: '[ip]' },
];

let cachedActive: { value: boolean; expiresAt: number } | null = null;
const CACHE_TTL_MS = 10_000;

async function piiActive(): Promise<boolean> {
  if (cachedActive && cachedActive.expiresAt > Date.now()) {
    return cachedActive.value;
  }
  const state = await isKillSwitchActive('pii_redaction_enabled').catch(() => ({
    active: false,
  }));
  cachedActive = { value: state.active, expiresAt: Date.now() + CACHE_TTL_MS };
  return state.active;
}

/**
 * Redact synchronously (using last-known kill switch state) so this can
 * be called from log-emit paths that can't await.
 */
export function redactSync(text: string): string {
  if (!cachedActive?.value) return text;
  let out = text;
  for (const { re, replace } of PATTERNS) {
    out = out.replace(re, replace);
  }
  return out;
}

/** Force the cached state to current. Call at the top of risky paths. */
export async function refreshPiiCache(): Promise<boolean> {
  return piiActive();
}

export function invalidatePiiCache(): void {
  cachedActive = null;
}

/**
 * B3: synchronous PII detector. Returns whether any of the configured
 * PATTERNS match, and the list of pattern names that matched. Does NOT
 * consult the kill switch — this is for outbound-PII filtering on
 * web-search queries and similar paths where the call MUST be checked
 * before leaving our network regardless of kill-switch state.
 */
export function detectPii(text: string): { found: boolean; types: string[] } {
  const types: string[] = [];
  for (const { name, re } of PATTERNS) {
    re.lastIndex = 0;
    if (re.test(text)) {
      types.push(name);
    }
  }
  return { found: types.length > 0, types };
}

/**
 * Unconditional sync redact: runs every PATTERN regardless of the
 * kill-switch cache. Used by outbound filters (web search) that decide
 * policy upstream rather than via the kill switch.
 */
export function redactPiiUnconditional(text: string): string {
  let out = text;
  for (const { re, replace } of PATTERNS) {
    re.lastIndex = 0;
    out = out.replace(re, replace);
  }
  return out;
}
