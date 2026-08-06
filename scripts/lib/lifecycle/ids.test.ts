import { describe, it, expect } from 'vitest';
import { DEPLOY_ID_RE, deployLabel, newDeployId } from './ids.js';

const SHA = '0123456789abcdef0123456789abcdef01234567';

describe('newDeployId', () => {
  it('produces CCE-<utc ts>-<12 char sha>-<4 hex>', () => {
    const id = newDeployId(SHA, new Date('2026-06-11T12:34:56.789Z'));
    expect(id).toMatch(DEPLOY_ID_RE);
    expect(id.startsWith('CCE-20260611123456-0123456789ab-')).toBe(true);
  });

  it('is unique for the same sha (same commit can deploy twice)', () => {
    const now = new Date('2026-06-11T12:34:56Z');
    const ids = new Set(Array.from({ length: 32 }, () => newDeployId(SHA, now)));
    expect(ids.size).toBeGreaterThan(1);
  });

  it('lowercases the short sha', () => {
    const id = newDeployId(SHA.toUpperCase(), new Date('2026-06-11T00:00:00Z'));
    expect(id).toMatch(DEPLOY_ID_RE);
  });

  it('rejects non-sha input', () => {
    expect(() => newDeployId('main')).toThrow(/not a git sha/);
    expect(() => newDeployId('abc123')).toThrow(/not a git sha/); // too short
  });
});

describe('deployLabel', () => {
  it('uses the full deployId as the staging label', () => {
    const id = newDeployId(SHA);
    expect(deployLabel(id)).toBe(id);
    expect(deployLabel(id).length).toBeLessThanOrEqual(256);
  });

  it('rejects garbage', () => {
    expect(() => deployLabel('not-a-deploy-id')).toThrow(/not a valid deploy id/);
  });
});
