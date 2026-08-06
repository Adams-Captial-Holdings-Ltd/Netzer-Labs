import { describe, it, expect } from 'vitest';
import { isMagicTokenExpired } from './magic-link.js';

describe('isMagicTokenExpired', () => {
  const now = Date.parse('2026-07-10T12:00:00.000Z');

  it('is false while expiresAt is in the future', () => {
    expect(isMagicTokenExpired({ expiresAt: '2026-07-10T13:00:00.000Z' }, now)).toBe(false);
  });

  it('is true once expiresAt has passed', () => {
    expect(isMagicTokenExpired({ expiresAt: '2026-07-10T11:00:00.000Z' }, now)).toBe(true);
  });

  it('treats a missing expiresAt as not expired (no-expiry rows)', () => {
    expect(isMagicTokenExpired({}, now)).toBe(false);
  });

  it('fails closed on an unparseable expiresAt', () => {
    // Corrupted data must never read as a forever-valid token.
    expect(isMagicTokenExpired({ expiresAt: 'not-a-date' }, now)).toBe(true);
  });
});
