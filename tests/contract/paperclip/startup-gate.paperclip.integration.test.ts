import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ensureNativeRunnerOff } from '../../../scripts/lib/paperclip/bootstrap-core.js';
import {
  __resetPaperclipLockForTest, enforceStartupLock, getPaperclipLockState, readRuntimeLockVerdict,
} from '../../../src/lib/paperclip/runtime-lock.js';
import { bootstrapPaperclip, paperclipAdminRequest, type PaperclipBootstrap } from '../../fixtures/paperclip-bootstrap.js';
import { describeNewPin, freshAuditor, paperclipPin } from './harness.js';

describe.skipIf(!process.env.PAPERCLIP_TEST_AUTH_SECRET)('Paperclip startup lock gate', () => {
  let fixture: PaperclipBootstrap;

  beforeAll(async () => {
    fixture = await bootstrapPaperclip();
    await paperclipPin();
  }, 120_000);
  beforeEach(() => __resetPaperclipLockForTest());
  afterEach(() => __resetPaperclipLockForTest());

  describeNewPin('v2026.916.1 startup decisions', () => {
    const read = (auditorKey: string | undefined, baseUrl = fixture.baseUrl) => () =>
      readRuntimeLockVerdict({ fetchFn: fetch, baseUrl, companyId: fixture.companyId, auditorKey });

    it('opens after a clean real read', async () => {
      await ensureNativeRunnerOff(paperclipAdminRequest);
      expect(await enforceStartupLock({ read: read(await freshAuditor()) })).toEqual({ verdict: 'clean' });
      expect(getPaperclipLockState().closed).toBe(false);
    });

    it('refuses startup while the native runner is on, then restores it', async () => {
      const key = await freshAuditor();
      await ensureNativeRunnerOff(paperclipAdminRequest);
      const changed = await paperclipAdminRequest('/api/instance/settings/experimental', {
        method: 'PATCH', body: JSON.stringify({ enableNativeRunner: true }),
      });
      expect(changed.status).toBe(200);
      try {
        await expect(enforceStartupLock({ read: read(key) })).rejects.toThrow(/Refusing to start.*native_runner_on/);
        expect(getPaperclipLockState().closed).toBe(true);
      } finally {
        await ensureNativeRunnerOff(paperclipAdminRequest);
      }
    });

    it('starts latched closed when Paperclip is unreachable', async () => {
      const verdict = await enforceStartupLock({
        read: read(await freshAuditor(), 'http://127.0.0.1:9'), attempts: 1, sleep: async () => {},
      });
      expect(verdict.verdict).toBe('unknown');
      expect(getPaperclipLockState().closed).toBe(true);
      expect(getPaperclipLockState().code).toMatch(/^unknown:/);
    });

    it('starts latched closed when the auditor key is missing', async () => {
      const verdict = await enforceStartupLock({ read: read(undefined), attempts: 1, sleep: async () => {} });
      expect(verdict).toEqual({ verdict: 'unknown', reason: 'lock_auditor_key_missing' });
      expect(getPaperclipLockState()).toEqual({ closed: true, code: 'unknown:lock_auditor_key_missing' });
    });
  });
});
