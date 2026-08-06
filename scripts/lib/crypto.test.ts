import { describe, it, expect } from 'vitest';
import {
  generateHexToken,
  generateKillPhrase,
  hashPin,
  verifyPin,
} from './crypto.js';

describe('crypto', () => {
  describe('generateHexToken', () => {
    it('returns 64 hex chars for 32 bytes by default', () => {
      const t = generateHexToken();
      expect(t).toMatch(/^[a-f0-9]{64}$/);
    });

    it('returns 32 hex chars for 16 bytes', () => {
      const t = generateHexToken(16);
      expect(t).toMatch(/^[a-f0-9]{32}$/);
    });

    it('produces different tokens on consecutive calls', () => {
      const a = generateHexToken();
      const b = generateHexToken();
      expect(a).not.toBe(b);
    });
  });

  describe('generateKillPhrase', () => {
    it('starts with STOP-', () => {
      expect(generateKillPhrase()).toMatch(/^STOP-/);
    });

    it('produces different phrases on consecutive calls', () => {
      const a = generateKillPhrase();
      const b = generateKillPhrase();
      expect(a).not.toBe(b);
    });
  });

  describe('hashPin + verifyPin', () => {
    it('hash format is salt:sha256hex', () => {
      const h = hashPin('1234');
      expect(h).toMatch(/^[a-f0-9]{16}:[a-f0-9]{64}$/);
    });

    it('verifyPin returns true for the correct pin', () => {
      const h = hashPin('correct-pin');
      expect(verifyPin('correct-pin', h)).toBe(true);
    });

    it('verifyPin returns false for a wrong pin', () => {
      const h = hashPin('correct');
      expect(verifyPin('wrong', h)).toBe(false);
    });

    it('verifyPin returns false for malformed hash input', () => {
      expect(verifyPin('any', 'not-a-valid-hash')).toBe(false);
      expect(verifyPin('any', '')).toBe(false);
    });

    it('two hashes of the same pin differ (random salt)', () => {
      const a = hashPin('same');
      const b = hashPin('same');
      expect(a).not.toBe(b);
      expect(verifyPin('same', a)).toBe(true);
      expect(verifyPin('same', b)).toBe(true);
    });
  });
});
