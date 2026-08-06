/**
 * Token generation and PIN hashing for the setup wizard.
 *
 * - Dashboard tokens: 32 bytes of CSPRNG, hex-encoded (64 chars).
 * - Encryption key: 32 bytes of CSPRNG, hex-encoded (64 chars).
 * - PIN hash: `salt:sha256(salt + pin)` so we can verify without storing the PIN.
 */

import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

export function generateHexToken(bytes = 32): string {
  return randomBytes(bytes).toString('hex');
}

export function generateKillPhrase(): string {
  const adj = ['silent', 'rapid', 'careful', 'bright', 'firm', 'distant', 'sharp', 'quiet'];
  const noun = ['arrow', 'beacon', 'cipher', 'lattice', 'meridian', 'sentinel', 'horizon', 'sentry'];
  const pick = <T,>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];
  const suffix = randomBytes(2).toString('hex');
  return `STOP-${pick(adj)}-${pick(noun)}-${suffix}`;
}

export function hashPin(pin: string): string {
  const salt = randomBytes(8).toString('hex');
  const hash = createHash('sha256').update(salt + pin).digest('hex');
  return `${salt}:${hash}`;
}

export function verifyPin(pin: string, hashed: string): boolean {
  const [salt, expected] = hashed.split(':');
  if (!salt || !expected) return false;
  const actual = createHash('sha256').update(salt + pin).digest('hex');
  // Constant-time comparison to prevent timing attacks
  const a = Buffer.from(actual, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
