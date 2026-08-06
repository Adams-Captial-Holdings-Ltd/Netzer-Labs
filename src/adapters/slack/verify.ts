/**
 * Slack request signature verification.
 *
 * Slack signs every webhook with HMAC-SHA256 over `v0:<ts>:<raw_body>`
 * using the signing secret. We reject anything that doesn't match in
 * constant time, plus anything older than 5 minutes (replay defense).
 *
 * https://api.slack.com/authentication/verifying-requests-from-slack
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

const MAX_AGE_SECONDS = 60 * 5;

export interface VerifyResult {
  ok: boolean;
  reason?: 'no_secret' | 'stale_timestamp' | 'bad_signature' | 'missing_headers';
}

export function verifySlackSignature(
  rawBody: string,
  signature: string | undefined,
  timestamp: string | undefined,
  signingSecret: string,
): VerifyResult {
  if (!signingSecret) return { ok: false, reason: 'no_secret' };
  if (!signature || !timestamp) return { ok: false, reason: 'missing_headers' };

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: 'missing_headers' };
  const ageSeconds = Math.abs(Date.now() / 1000 - ts);
  if (ageSeconds > MAX_AGE_SECONDS) return { ok: false, reason: 'stale_timestamp' };

  const base = `v0:${timestamp}:${rawBody}`;
  const expected = 'v0=' + createHmac('sha256', signingSecret).update(base).digest('hex');

  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  if (a.length !== b.length) return { ok: false, reason: 'bad_signature' };
  if (!timingSafeEqual(a, b)) return { ok: false, reason: 'bad_signature' };
  return { ok: true };
}
