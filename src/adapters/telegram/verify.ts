/**
 * Timing-safe verification of the Telegram webhook secret token.
 *
 * Telegram sends the configured secret in the
 * `X-Telegram-Bot-Api-Secret-Token` header on every webhook request.
 * A naive `===` comparison leaks timing information that can be used to
 * recover the secret byte-by-byte, so we compare with
 * crypto.timingSafeEqual over equal-length buffers.
 */

import { timingSafeEqual } from 'node:crypto';

/**
 * Returns true when the provided header value matches the expected secret.
 *
 * Guards against a length mismatch first because timingSafeEqual throws
 * when the two buffers differ in length. A length mismatch is itself a
 * non-match, so we short-circuit to false.
 */
export function verifyTelegramSecret(
  provided: string | undefined | null,
  expected: string | undefined | null,
): boolean {
  if (!provided || !expected) return false;
  const providedBuf = Buffer.from(provided, 'utf8');
  const expectedBuf = Buffer.from(expected, 'utf8');
  if (providedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(providedBuf, expectedBuf);
}
