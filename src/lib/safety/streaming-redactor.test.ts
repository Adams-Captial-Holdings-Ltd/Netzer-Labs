import { describe, it, expect, vi } from 'vitest';

// Keep the config/DDB reads deterministic: no custom patterns, guard enabled.
vi.mock('../state/kill-switches-repo.js', () => ({
  isKillSwitchActive: vi.fn(async () => ({ active: false })),
}));
vi.mock('../state/exfil-patterns-repo.js', () => ({
  getCustomPatterns: vi.fn(async () => []),
}));
vi.mock('../audit/audit-writer.js', () => ({ writeAudit: vi.fn(async () => {}) }));

import { buildStreamingRedactor } from './exfil-guard.js';

// The streaming surface re-renders the latest accumulated text each chunk, so
// redacting block-severity secrets out of each accumulated string before it is
// forwarded means the raw secret is never shown live.
describe('buildStreamingRedactor', () => {
  const AKIA = 'AKIAIOSFODNN7EXAMPLE'; // matches the block-severity aws_access_key pattern

  it('redacts a block-severity secret out of a streamed chunk', async () => {
    const redact = await buildStreamingRedactor();
    const out = redact(`your key is ${AKIA} ok`);
    expect(out).not.toContain(AKIA);
    expect(out).toContain('[REDACTED]');
  });

  it('passes ordinary text through unchanged', async () => {
    const redact = await buildStreamingRedactor();
    expect(redact('just a normal streamed reply')).toBe('just a normal streamed reply');
  });

  it('does NOT redact warn-severity matches (log-only parity with the final scan)', async () => {
    const redact = await buildStreamingRedactor();
    // A 40-char base64 run trips the warn-only aws_secret_key pattern, which the
    // streaming redactor must leave intact (collides with SHAs/digests).
    const fortyChars = 'abcdefghijklmnopqrstuvwxyz0123456789ABCD';
    expect(redact(`digest ${fortyChars}`)).toContain(fortyChars);
  });
});
