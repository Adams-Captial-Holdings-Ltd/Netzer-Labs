import { beforeAll, describe, expect, it } from 'vitest';
import { ensureNativeRunnerOff } from '../../../scripts/lib/paperclip/bootstrap-core.js';
import { bootstrapPaperclip, paperclipAdminRequest, type PaperclipBootstrap } from '../../fixtures/paperclip-bootstrap.js';
import { describeNewPin, paperclipPin } from './harness.js';

describe.skipIf(!process.env.PAPERCLIP_TEST_AUTH_SECRET)('Paperclip operator settings contracts', () => {
  let fixture: PaperclipBootstrap;

  beforeAll(async () => {
    fixture = await bootstrapPaperclip();
    await paperclipPin();
  }, 120_000);

  describeNewPin('v2026.916.1 managed settings', () => {
    it('stores enableNativeRunner=false after the production bootstrap write', async () => {
      const path = '/api/instance/settings/experimental';
      const first = await paperclipAdminRequest(path);
      expect(first.status).toBe(200);
      expect(typeof (await first.json() as { enableNativeRunner?: unknown }).enableNativeRunner).toBe('boolean');
      await ensureNativeRunnerOff(paperclipAdminRequest);
      for (let read = 0; read < 2; read += 1) {
        const response = await paperclipAdminRequest(path);
        expect(response.status).toBe(200);
        expect((await response.json() as { enableNativeRunner?: unknown }).enableNativeRunner).toBe(false);
      }
    });

    it('publishes exactly the operator hiddenSettings without hiding experimental', async () => {
      const response = await fetch(`${fixture.baseUrl}/api/health`);
      expect(response.status).toBe(200);
      const body = await response.json() as { hiddenSettings?: unknown };
      expect(Array.isArray(body.hiddenSettings)).toBe(true);
      const hidden = body.hiddenSettings as string[];
      expect(new Set(hidden)).toEqual(new Set([
        'instance.adapters', 'instance.plugins', 'instance.general.feedbackDataSharingPreference',
      ]));
      expect(hidden.some((setting) => setting.startsWith('instance.experimental'))).toBe(false);
    });

    it('floors a changed feedback value with settings_operator_managed, but accepts the same value', async () => {
      const path = '/api/instance/settings/general';
      const current = await paperclipAdminRequest(path);
      expect(current.status).toBe(200);
      expect((await current.json() as { feedbackDataSharingPreference?: unknown }).feedbackDataSharingPreference).toBe('not_allowed');
      const changed = await paperclipAdminRequest(path, {
        method: 'PATCH', body: JSON.stringify({ feedbackDataSharingPreference: 'allowed' }),
      });
      expect(changed.status).toBe(403);
      expect((await changed.json() as { code?: unknown }).code).toBe('settings_operator_managed');
      const same = await paperclipAdminRequest(path, {
        method: 'PATCH', body: JSON.stringify({ feedbackDataSharingPreference: 'not_allowed' }),
      });
      expect(same.status).toBe(200);
      const again = await paperclipAdminRequest(path);
      expect((await again.json() as { feedbackDataSharingPreference?: unknown }).feedbackDataSharingPreference).toBe('not_allowed');
    });

    it('disables non-http adapters and refuses a process agent', async () => {
      const adapters = await paperclipAdminRequest('/api/adapters');
      expect(adapters.status).toBe(200);
      const rows = await adapters.json() as Array<{ type: string; disabled: boolean }>;
      expect(Array.isArray(rows)).toBe(true);
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) expect(row.disabled, `${row.type} disabled state`).toBe(row.type !== 'http');
      const refused = await paperclipAdminRequest(`/api/companies/${fixture.companyId}/agents`, {
        method: 'POST',
        body: JSON.stringify({
          name: 'Process adapter refusal probe', role: 'general', reportsTo: fixture.agents.main.id,
          adapterType: 'process', adapterConfig: {}, metadata: { netzarAgentId: 'process-probe' },
        }),
      });
      expect(refused.status).toBe(422);
      const body = await refused.json() as { error?: unknown };
      expect(body.error).toMatch(/Adapter "process" is not available on this instance/);
    });

    it('creates an http agent with heartbeat off and removes it', async () => {
      const response = await paperclipAdminRequest(`/api/companies/${fixture.companyId}/agents`, {
        method: 'POST',
        body: JSON.stringify({
          name: 'HTTP adapter contract probe', role: 'general', reportsTo: fixture.agents.main.id,
          adapterType: 'http',
          adapterConfig: { url: 'http://127.0.0.1:9/api/paperclip/dispatch', method: 'POST', payloadTemplate: { netzarAgentId: 'contract-probe' } },
          metadata: { netzarAgentId: 'contract-probe' },
        }),
      });
      expect(response.status).toBe(201);
      const created = await response.json() as { id: string; runtimeConfig?: { heartbeat?: { enabled?: unknown } } };
      try {
        expect(created.runtimeConfig?.heartbeat?.enabled).toBeFalsy();
      } finally {
        const removed = await paperclipAdminRequest(`/api/agents/${created.id}`, { method: 'DELETE' });
        expect(removed.status).toBe(200);
      }
    });
  });
});
