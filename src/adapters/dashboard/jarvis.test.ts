import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';

const { listDocuments, writeAudit } = vi.hoisted(() => ({
  listDocuments: vi.fn(async (_scope: string) => [] as unknown[]),
  writeAudit: vi.fn(async (_e: unknown) => {}),
}));
vi.mock('../../lib/vectors/store.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/vectors/store.js')>();
  return { ...actual, listDocuments };
});
vi.mock('../../lib/audit/audit-writer.js', () => ({ writeAudit }));

import { executeQueryTool, buildGreetingLine } from './jarvis.js';
import type { TokenPrincipal } from '../../lib/auth/dashboard-auth.js';

const viewer: TokenPrincipal = { tokenHash: 'h', label: 'V', hashPrefix16: 'h', role: 'viewer' };

// The DB-backed greeting: profile/first_name fills the {name} token. The
// empty-name case must NOT emit stray punctuation (regression: the compute-stack
// default greeting templates {name}, so a fresh install / cleared name hit it).
describe('buildGreetingLine', () => {
  const TPL = 'Good to see you, {name}. What can I help you with?';

  it('substitutes a configured name into a {name} template', () => {
    expect(buildGreetingLine('Emmanuel', TPL)).toBe('Good to see you, Emmanuel. What can I help you with?');
  });

  it('uses the neutral form (no stray comma) for a {name} template when no name is set', () => {
    expect(buildGreetingLine('', TPL)).toBe('Good to see you. What can I help you with?');
    expect(buildGreetingLine(null, TPL)).toBe('Good to see you. What can I help you with?');
  });

  it('ignores a static (no-{name}) override and uses the by-name default', () => {
    expect(buildGreetingLine('Emmanuel', 'Hello, sir. How may I help you?')).toBe(
      'Good to see you, Emmanuel. What can I help you with?',
    );
  });

  it('neutral default with neither name nor template', () => {
    expect(buildGreetingLine('', undefined)).toBe('Good to see you. What can I help you with?');
  });
});

/**
 * The blocked paths return at the authorizeRead guard BEFORE any repo/DDB call,
 * so they are deterministic without infra. The happy paths (which hit DDB) are
 * exercised by jarvis.integration.test.ts under LocalStack.
 */
describe('executeQueryTool — authorizeRead gating (H3)', () => {
  it('blocks a viewer from the operator-only audit resource', async () => {
    const r = await executeQueryTool(viewer, 'audit', {});
    expect(r).toEqual({ ok: false, code: 'RESOURCE_FORBIDDEN', param: undefined });
  });

  it('rejects an excluded resource (tokens) as unknown', async () => {
    const r = await executeQueryTool(viewer, 'tokens', {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('UNKNOWN_RESOURCE');
  });

  it('requires chatId for memories', async () => {
    const r = await executeQueryTool(viewer, 'memories', {});
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('PARAM_REQUIRED');
      expect(r.param).toBe('chatId');
    }
  });
});

describe('executeQueryTool — vectors scope rule (NZR-5)', () => {
  beforeEach(() => {
    listDocuments.mockClear();
    writeAudit.mockClear();
  });

  it('F5-12 the vectors resource refuses a scope the principal cannot read', async () => {
    const denied = await executeQueryTool(viewer, 'vectors', { scope: 'finance_private' });
    expect(denied).toMatchObject({ ok: false, code: 'RESOURCE_FORBIDDEN' });
    expect(listDocuments).not.toHaveBeenCalled();
    const rows = writeAudit.mock.calls.map(([e]) => e as { action: string; surface: string; result: string; detail: Record<string, unknown> });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'knowledge_scope_denied',
      surface: 'dashboard',
      result: 'blocked',
      detail: {
        route: 'jarvis:vectors',
        scopeHash: createHash('sha256').update('finance_private').digest('hex').slice(0, 12),
        reason: 'private_scope',
        event: 'security.scope_denied',
      },
    });
    expect(JSON.stringify(rows)).not.toContain('finance');

    const ok = await executeQueryTool(viewer, 'vectors', { scope: 'shared' });
    expect(ok.ok).toBe(true);
    expect(listDocuments).toHaveBeenCalledWith('shared');
  });
});
