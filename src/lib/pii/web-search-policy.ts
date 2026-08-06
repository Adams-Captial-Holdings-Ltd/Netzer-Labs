/**
 * B3 outbound-PII policy for web_search.
 *
 *   refuse   — block the call entirely, write audit, return error
 *   redact   — replace matched patterns with placeholders, proceed
 *   allow    — no-op (deployer explicitly wants raw queries to vendor)
 *
 * Default is `redact`. Set `CCE_WEB_SEARCH_PII_POLICY` to override.
 */

export type WebSearchPiiPolicy = 'refuse' | 'redact' | 'allow';

export function resolveWebSearchPiiPolicy(
  raw: string | undefined = process.env.CCE_WEB_SEARCH_PII_POLICY,
): WebSearchPiiPolicy {
  const v = (raw ?? '').toLowerCase().trim();
  if (v === 'refuse' || v === 'allow') return v;
  return 'redact';
}
