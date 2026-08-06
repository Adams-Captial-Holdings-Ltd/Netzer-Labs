import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { completeClaim, resolveCanonical } from './identities-repo.js';

const ORIG_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIG_ENV };
});

afterEach(() => {
  process.env = ORIG_ENV;
});

describe('completeClaim — code validation', () => {
  it('rejects non-numeric codes', async () => {
    const r = await completeClaim({
      code: 'abc123',
      surface: 'slack',
      surfaceUserId: 'U1',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/6-digit/);
  });

  it('rejects codes that are too short', async () => {
    const r = await completeClaim({
      code: '12345',
      surface: 'slack',
      surfaceUserId: 'U1',
    });
    expect(r.ok).toBe(false);
  });

  it('rejects codes that are too long', async () => {
    const r = await completeClaim({
      code: '1234567',
      surface: 'slack',
      surfaceUserId: 'U1',
    });
    expect(r.ok).toBe(false);
  });
});

describe('resolveCanonical — disable flag', () => {
  it('returns undefined immediately when CCE_IDENTITY_RESOLUTION_DISABLED=1', async () => {
    process.env.CCE_IDENTITY_RESOLUTION_DISABLED = '1';
    // Should not even hit DDB; if it did, this test would fail in the
    // CI environment because the table does not exist there.
    const result = await resolveCanonical('telegram', '12345');
    expect(result).toBeUndefined();
  });
});
