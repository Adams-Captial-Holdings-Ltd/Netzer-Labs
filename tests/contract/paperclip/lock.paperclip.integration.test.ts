import { beforeAll, describe, expect, it } from 'vitest';
import { ensureNativeRunnerOff } from '../../../scripts/lib/paperclip/bootstrap-core.js';
import { readRuntimeLockVerdict } from '../../../src/lib/paperclip/runtime-lock.js';
import { bootstrapPaperclip, paperclipAdminRequest, type PaperclipBootstrap } from '../../fixtures/paperclip-bootstrap.js';
import { describeNewPin, freshAuditor, paperclipPin, withBearer } from './harness.js';

const keysOf = (value: unknown): string => Array.isArray(value) ? `array row keys: ${Object.keys(value[0] ?? {}).join(',')}` :
  value && typeof value === 'object' ? Object.keys(value).join(',') : typeof value;
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

describe.skipIf(!process.env.PAPERCLIP_TEST_AUTH_SECRET)('Paperclip runtime lock contracts', () => {
  let fixture: PaperclipBootstrap;
  let pin: 'old' | 'new';

  beforeAll(async () => {
    fixture = await bootstrapPaperclip();
    pin = await paperclipPin();
  }, 120_000);

  it('recognizes the live pin', () => {
    expect(['old', 'new']).toContain(pin);
  });

  describeNewPin('v2026.916.1 lock reads', () => {
    const read = (key: string) => readRuntimeLockVerdict({
      fetchFn: fetch,
      baseUrl: fixture.baseUrl,
      companyId: fixture.companyId,
      auditorKey: key,
    });

    it('returns the six shapes the production reader consumes', async (ctx) => {
      if (pin === 'old') ctx.skip();
      const key = await freshAuditor();
      const company = `/api/companies/${fixture.companyId}`;
      const paths = [
        '/api/health',
        '/api/instance/settings/experimental',
        `${company}/agents`,
        `${company}/remote-agent-profiles`,
        `${company}/tools/applications`,
        `${company}/tools/connections`,
      ];
      const bodies: unknown[] = [];
      for (const [index, path] of paths.entries()) {
        const response = index === 0 ? await fetch(`${fixture.baseUrl}${path}`) : await withBearer(key)(path);
        expect(response.status, `${path} returned HTTP ${response.status}`).toBe(200);
        bodies.push(await response.json());
      }
      const [health, settings, agents, profiles, applications, connections] = bodies;
      expect(object(health) && Array.isArray(health.hiddenSettings) && health.hiddenSettings.every((x) => typeof x === 'string'),
        `/api/health hiddenSettings shape; top-level keys: ${keysOf(health)}`).toBe(true);
      expect(object(settings) && typeof settings.enableNativeRunner === 'boolean',
        `experimental enableNativeRunner shape; top-level keys: ${keysOf(settings)}`).toBe(true);
      expect(Array.isArray(agents) && agents.every((row) => object(row) &&
        typeof row.id === 'string' && typeof row.name === 'string' && typeof row.adapterType === 'string' && object(row.runtimeConfig)),
      `agents runtimeConfig shape; top-level keys: ${keysOf(agents)}`).toBe(true);
      expect(Array.isArray(profiles), `remote-agent-profiles shape; top-level keys: ${keysOf(profiles)}`).toBe(true);
      expect(object(applications) && Array.isArray(applications.applications),
        `tools/applications shape; top-level keys: ${keysOf(applications)}`).toBe(true);
      expect(object(connections) && Array.isArray(connections.connections),
        `tools/connections shape; top-level keys: ${keysOf(connections)}`).toBe(true);
    });

    it('creates a viewer auditor through board-api-keys and company-access, with no write power', async (ctx) => {
      if (pin === 'old') ctx.skip();
      const key = await freshAuditor();
      const me = await withBearer(key)('/api/cli-auth/me');
      expect(me.status).toBe(200);
      const identity = await me.json() as {
        companyIds?: string[]; isInstanceAdmin?: boolean;
        memberships?: Array<{ companyId?: string; membershipRole?: string }>;
      };
      expect(identity.companyIds).toContain(fixture.companyId);
      expect(identity.isInstanceAdmin).toBe(false);
      expect(identity.memberships?.some((member) => member.companyId === fixture.companyId && member.membershipRole === 'viewer')).toBe(true);
      const write = await withBearer(key)(`/api/companies/${fixture.companyId}/issues`, {
        method: 'POST', body: JSON.stringify({ title: 'Auditor write refusal probe' }),
      });
      expect(write.status).toBe(403);
    });

    it('reads a clean runtime through the real auditor', async (ctx) => {
      if (pin === 'old') ctx.skip();
      await ensureNativeRunnerOff(paperclipAdminRequest);
      expect(await read(await freshAuditor())).toEqual({ verdict: 'clean' });
    });

    it('detects the native runner and restores it', async (ctx) => {
      if (pin === 'old') ctx.skip();
      const key = await freshAuditor();
      await ensureNativeRunnerOff(paperclipAdminRequest);
      const path = '/api/instance/settings/experimental';
      const changed = await paperclipAdminRequest(path, { method: 'PATCH', body: JSON.stringify({ enableNativeRunner: true }) });
      expect(changed.status).toBe(200);
      try {
        const verdict = await read(key);
        expect(verdict.verdict).toBe('violated');
        expect(verdict.verdict === 'violated' ? verdict.violations.map((v) => v.code) : []).toContain('native_runner_on');
      } finally {
        await ensureNativeRunnerOff(paperclipAdminRequest);
      }
    });

    it('detects a timer heartbeat and restores the agent runtimeConfig', async (ctx) => {
      if (pin === 'old') ctx.skip();
      const key = await freshAuditor();
      await ensureNativeRunnerOff(paperclipAdminRequest);
      const path = `/api/agents/${fixture.agents.main.id}`;
      const current = await paperclipAdminRequest(path);
      expect(current.status).toBe(200);
      const agent = await current.json() as { runtimeConfig: Record<string, unknown> };
      const original = agent.runtimeConfig;
      const heartbeat = object(original.heartbeat) ? original.heartbeat : {};
      const changed = await paperclipAdminRequest(path, {
        method: 'PATCH', body: JSON.stringify({ runtimeConfig: { ...original, heartbeat: { ...heartbeat, enabled: true } } }),
      });
      expect(changed.status).toBe(200);
      try {
        const verdict = await read(key);
        expect(verdict.verdict).toBe('violated');
        expect(verdict.verdict === 'violated' ? verdict.violations.map((v) => v.code) : []).toContain('agent_timer_heartbeat_on');
      } finally {
        const restored = await paperclipAdminRequest(path, { method: 'PATCH', body: JSON.stringify({ runtimeConfig: original }) });
        expect(restored.status).toBe(200);
        const reread = await paperclipAdminRequest(path);
        expect(reread.status).toBe(200);
        const restoredAgent = await reread.json() as { runtimeConfig: { heartbeat?: { enabled?: unknown } } };
        expect(restoredAgent.runtimeConfig.heartbeat?.enabled).toBeFalsy();
      }
    });

    it('classifies a rejected auditor key without exposing it', async (ctx) => {
      if (pin === 'old') ctx.skip();
      expect(await read('invalid-auditor-key')).toEqual({ verdict: 'unknown', reason: 'auditor_key_rejected' });
    });
  });
});
