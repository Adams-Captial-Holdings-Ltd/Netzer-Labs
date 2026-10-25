import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import type { TokenPrincipal } from '../../lib/auth/dashboard-auth.js';

/**
 * NZR-5 frozen tests: every knowledge route checks, before any store, embedding
 * or model call, that the caller may read the scope it names. default/shared
 * are public (vectors:read); every other name (an agent's private scope such as
 * the fixture agents ops -> ops_private and finance -> finance_private, or an
 * unknown name) needs knowledge:private:read (admin tier). Drives the real
 * dashboard router (pattern: vectors-answer-metering.test.ts).
 */

const h = vi.hoisted(() => ({
  authenticateDashboardToken: vi.fn(),
  capsLookup: vi.fn(),
  actualCaps: null as null | ((...a: unknown[]) => unknown),
  listDocuments: vi.fn(),
  search: vi.fn(),
  presignUploadUrl: vi.fn(),
  ingestDocument: vi.fn(),
  removeDocument: vi.fn(),
  embedOne: vi.fn(),
  converseTurn: vi.fn(),
  recordUsage: vi.fn(),
  getDailyCostUsd: vi.fn(),
  getEffectiveCostCap: vi.fn(),
  writeAudit: vi.fn(),
  writeAuditOrThrow: vi.fn(),
  getObjectBuffer: vi.fn(),
  deleteObject: vi.fn(),
}));

type Tier = 'viewer' | 'operator' | 'admin' | 'owner' | 'alice' | 'bob';

function principalFor(raw: string): TokenPrincipal | null {
  const id = raw.replace(/^Bearer\s+/i, '');
  if (id === 'viewer' || id === 'operator' || id === 'admin') {
    return { tokenHash: `hash-${id}`, label: id, hashPrefix16: id, role: id };
  }
  // NZR-6: two signed-in viewers, dashboard:user:alice and dashboard:user:bob.
  if (id === 'alice' || id === 'bob') {
    return { tokenHash: `hash-${id}`, label: id, hashPrefix16: id, role: 'viewer', userId: id };
  }
  if (id === 'owner') {
    return { tokenHash: 'hash-owner', label: 'Root token', hashPrefix16: 'owner', role: 'admin', profileId: 'owner' };
  }
  return null;
}

// A catalog model (the same one vectors-answer-metering.test.ts uses).
const MODEL_ID = 'openai.gpt-oss-120b-1:0';

vi.mock('../../lib/auth/dashboard-auth.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/auth/dashboard-auth.js')>();
  h.actualCaps = actual.capabilitiesForPrincipal as (...a: unknown[]) => unknown;
  return {
    ...actual,
    extractBearerToken: (hdr?: string) => (hdr ?? '').replace(/^Bearer\s+/i, ''),
    authenticateDashboardToken: (raw: string) => h.authenticateDashboardToken(raw),
    capabilitiesForPrincipal: (...a: unknown[]) => h.capsLookup(...a),
  };
});
vi.mock('../../lib/vectors/store.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/vectors/store.js')>();
  return {
    ...actual,
    listDocuments: h.listDocuments,
    search: h.search,
    presignUploadUrl: h.presignUploadUrl,
    getObjectBuffer: h.getObjectBuffer,
    deleteObject: h.deleteObject,
  };
});
vi.mock('../../lib/vectors/ingest.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/vectors/ingest.js')>();
  return { ...actual, ingestDocument: h.ingestDocument, removeDocument: h.removeDocument };
});
vi.mock('../../lib/vectors/embedder.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/vectors/embedder.js')>();
  return { ...actual, embedOne: h.embedOne };
});
vi.mock('../../lib/bedrock/client.js', () => ({ converseTurn: h.converseTurn }));
vi.mock('../../lib/usage/token-tracker.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/usage/token-tracker.js')>();
  return { ...actual, recordUsage: h.recordUsage, getDailyCostUsd: h.getDailyCostUsd };
});
vi.mock('../../lib/state/cost-cap-repo.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/state/cost-cap-repo.js')>();
  return { ...actual, getEffectiveCostCap: h.getEffectiveCostCap };
});
vi.mock('../../lib/state/kill-switches-repo.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/state/kill-switches-repo.js')>();
  return { ...actual, isKillSwitchActive: () => Promise.resolve({ active: false }) };
});
vi.mock('../../lib/audit/audit-writer.js', () => ({ writeAudit: h.writeAudit, writeAuditOrThrow: h.writeAuditOrThrow }));
vi.mock('../../observability/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  truncateForLog: (s: string) => s,
}));

import { buildDashboardRouter } from './handler.js';

function req(path: string, tier: Tier, method = 'GET', body?: unknown): Promise<Response> {
  const app = new Hono();
  app.route('/api', buildDashboardRouter());
  const headers: Record<string, string> = { Authorization: `Bearer ${tier}` };
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  return Promise.resolve(app.request(path, init));
}

/** The three read routes for one scope (undefined = no scope given). */
const READS = (scope: string | undefined) => [
  { route: 'GET /vectors', run: (t: Tier) => req(scope === undefined ? '/api/vectors' : `/api/vectors?scope=${encodeURIComponent(scope)}`, t) },
  { route: 'POST /vectors/search', run: (t: Tier) => req('/api/vectors/search', t, 'POST', { query: 'q', ...(scope === undefined ? {} : { scope }) }) },
  { route: 'POST /vectors/answer', run: (t: Tier) => req('/api/vectors/answer', t, 'POST', { query: 'q', modelId: MODEL_ID, ...(scope === undefined ? {} : { scope }) }) },
];

async function expectForbiddenScope(res: Response, label = ''): Promise<void> {
  expect(res.status, label).toBe(403);
  expect(await res.json(), label).toEqual({ error: 'forbidden_scope' });
}

function expectNoKnowledgeIo(): void {
  for (const fn of [h.listDocuments, h.search, h.embedOne, h.converseTurn, h.recordUsage, h.getDailyCostUsd, h.getEffectiveCostCap, h.ingestDocument, h.removeDocument]) {
    expect(fn).not.toHaveBeenCalled();
  }
}

const deniedRows = () =>
  h.writeAudit.mock.calls.map(([e]) => e as { action: string }).filter((e) => e.action === 'knowledge_scope_denied');

const hashOf = (normalized: string) => createHash('sha256').update(normalized).digest('hex').slice(0, 12);

beforeEach(() => {
  h.authenticateDashboardToken.mockReset().mockImplementation(async (raw: string) => principalFor(raw));
  h.capsLookup.mockReset().mockImplementation((...a: unknown[]) => h.actualCaps!(...a));
  h.listDocuments.mockReset().mockResolvedValue([]);
  h.search.mockReset().mockResolvedValue([]);
  h.presignUploadUrl.mockReset().mockResolvedValue('https://staging.example.invalid/put');
  h.ingestDocument.mockReset().mockImplementation(async (a: { scope?: string }) => ({ docId: 'd1', scope: a.scope ?? 'default', chunks: 1, failed: 0 }));
  h.removeDocument.mockReset().mockResolvedValue(undefined);
  h.embedOne.mockReset().mockResolvedValue([0.1, 0.2]);
  h.converseTurn.mockReset().mockResolvedValue({ text: 'answer', inputTokens: 1, outputTokens: 1, stopReason: 'end_turn', latencyMs: 1 });
  h.recordUsage.mockReset().mockResolvedValue(true);
  h.getDailyCostUsd.mockReset().mockResolvedValue(0);
  h.getEffectiveCostCap.mockReset().mockResolvedValue(50);
  h.writeAudit.mockReset().mockResolvedValue(undefined);
  h.writeAuditOrThrow.mockReset().mockResolvedValue(undefined);
  h.getObjectBuffer.mockReset().mockResolvedValue(Buffer.from('%PDF-1.4 fake'));
  h.deleteObject.mockReset().mockResolvedValue(undefined);
});

describe('NZR-5 knowledge routes enforce scope access', () => {
  it("F5-1 GET /vectors refuses a viewer another agent's private scope", async () => {
    await expectForbiddenScope(await req('/api/vectors?scope=finance_private', 'viewer'));
    expectNoKnowledgeIo();
  });

  it("F5-2 POST /vectors/search refuses a viewer another agent's private scope", async () => {
    await expectForbiddenScope(await req('/api/vectors/search', 'viewer', 'POST', { query: 'q', scope: 'finance_private' }));
    expectNoKnowledgeIo();
  });

  it("F5-3 POST /vectors/answer refuses a viewer another agent's private scope before any spend", async () => {
    await expectForbiddenScope(
      await req('/api/vectors/answer', 'viewer', 'POST', { query: 'q', scope: 'finance_private', modelId: MODEL_ID }),
    );
    expectNoKnowledgeIo();
  });

  it('F5-4 refuses a scope that reaches a private corpus only after normalization', async () => {
    for (const scope of ['finance.private', 'finance private', 'finance/private', 'FINANCE_PRIVATE', 'DEFAULT', 'Default', 'shared ']) {
      for (const r of READS(scope)) await expectForbiddenScope(await r.run('viewer'), `${r.route} ${JSON.stringify(scope)}`);
    }
    expectNoKnowledgeIo();
  });

  it('F5-5 answers an unknown scope exactly like a private one', async () => {
    const priv = await req('/api/vectors?scope=finance_private', 'viewer');
    const unknown = await req('/api/vectors?scope=no_such_scope', 'viewer');
    expect(unknown.status).toBe(403);
    expect(unknown.status).toBe(priv.status);
    expect(await unknown.text()).toBe(await priv.text());
    expect(h.listDocuments).not.toHaveBeenCalled();
  });

  it('F5-6 DELETE /vectors/:scope/:docId refuses an operator a scope they cannot read', async () => {
    await expectForbiddenScope(await req('/api/vectors/finance_private/doc1', 'operator', 'DELETE'));
    expect(h.removeDocument).not.toHaveBeenCalled();
    const ok = await req('/api/vectors/shared/doc1', 'operator', 'DELETE');
    expect(ok.status).toBe(200);
    expect(h.removeDocument).toHaveBeenCalledWith('shared', 'doc1');
  });

  it('F5-7 still lets a viewer read the default and shared corpora', async () => {
    for (const scope of [undefined, 'default', 'shared']) {
      const expected = scope ?? 'default';
      const [list, search, answer] = READS(scope);
      const l = await list!.run('viewer');
      expect(l.status).toBe(200);
      expect(await l.json()).toEqual({ scope: expected, count: 0, docs: [] });
      const s = await search!.run('viewer');
      expect(s.status).toBe(200);
      expect(await s.json()).toEqual({ scope: expected, query: 'q', hits: [] });
      const a = await answer!.run('viewer');
      expect(a.status).toBe(200);
      expect(await a.json()).toMatchObject({ ok: true, modelId: MODEL_ID });
    }
    expect(h.listDocuments.mock.calls.map((c) => c[0])).toEqual(['default', 'default', 'shared']);
    expect(deniedRows()).toEqual([]);
  });

  it('F5-8 lets a principal with knowledge:private:read read a private scope', async () => {
    for (const tier of ['admin', 'owner'] as const) {
      for (const r of READS('finance_private')) expect((await r.run(tier)).status, `${tier} ${r.route}`).toBe(200);
      const del = await req('/api/vectors/finance_private/doc1', tier, 'DELETE');
      expect(del.status).toBe(200);
    }
    expect(h.listDocuments).toHaveBeenCalledWith('finance_private');
    expect(h.search).toHaveBeenCalledWith(expect.objectContaining({ scope: 'finance_private' }));
    expect(h.removeDocument).toHaveBeenCalledWith('finance_private', 'doc1');
    expect(deniedRows()).toEqual([]);
  });

  it('F5-9 audits each refusal as knowledge_scope_denied with a scope hash only', async () => {
    await expectForbiddenScope(await req('/api/vectors?scope=finance_private', 'viewer'));
    expect(h.writeAudit).toHaveBeenCalledTimes(1);
    expect(h.writeAudit).toHaveBeenCalledWith({
      action: 'knowledge_scope_denied',
      surface: 'dashboard',
      result: 'blocked',
      userId: 'dashboard:hash-viewer',
      detail: {
        route: 'GET /vectors',
        scopeHash: hashOf('finance_private'),
        reason: 'private_scope',
        event: 'security.scope_denied',
      },
    });

    // Folded names hash on their normalized form; the raw name never appears.
    h.writeAudit.mockClear();
    await expectForbiddenScope(await req('/api/vectors/search', 'viewer', 'POST', { query: 'secret query', scope: 'finance.private' }));
    const row = h.writeAudit.mock.calls[0]![0] as { detail: Record<string, unknown> };
    expect(row.detail).toEqual({
      route: 'POST /vectors/search',
      scopeHash: hashOf('finance_private'),
      reason: 'private_scope',
      event: 'security.scope_denied',
    });
    const raw = JSON.stringify(h.writeAudit.mock.calls);
    expect(raw).not.toContain('finance');
    expect(raw).not.toContain('secret query');
  });

  it('F5-9b rejects an empty, non-string or over-long scope with 400', async () => {
    for (const scope of ['', 123, 'a'.repeat(200)]) {
      const res = await req('/api/vectors/search', 'viewer', 'POST', { query: 'q', scope });
      expect(res.status, JSON.stringify(scope).slice(0, 20)).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid_scope' });
    }
    expectNoKnowledgeIo();
    expect(h.writeAudit).not.toHaveBeenCalled();
  });

  it('F5-10 /ingest and /ingest/stream refuse an operator a scope they cannot read', async () => {
    await expectForbiddenScope(await req('/api/ingest', 'operator', 'POST', { content: 'x', scope: 'finance_private' }));
    const stream = await req('/api/ingest/stream', 'operator', 'POST', { content: 'x', scope: 'finance_private' });
    expect(stream.headers.get('content-type') ?? '').toContain('application/json');
    await expectForbiddenScope(stream);
    expect(h.ingestDocument).not.toHaveBeenCalled();
    expect(deniedRows().length).toBe(2);

    const ok = await req('/api/ingest', 'operator', 'POST', { content: 'x', scope: 'shared' });
    expect(ok.status).toBe(200);
    expect(h.ingestDocument).toHaveBeenCalledWith(expect.objectContaining({ scope: 'shared' }));
  });

  it('F5-13 POST /vectors/upload-url needs agents:write', async () => {
    const res = await req('/api/vectors/upload-url', 'viewer', 'POST', { filename: 'a.txt' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden', requiredCapability: 'agents:write' });
    expect(h.presignUploadUrl).not.toHaveBeenCalled();
    const ok = await req('/api/vectors/upload-url', 'operator', 'POST', { filename: 'a.txt' });
    expect(ok.status).toBe(200);
  });

  it('F5-14 a failing capability lookup or audit write fails closed', async () => {
    // The route's own vectors:read gate resolves first; every later lookup throws.
    for (const tier of ['viewer', 'admin'] as const) {
      let calls = 0;
      h.capsLookup.mockImplementation((...a: unknown[]) => {
        calls += 1;
        if (calls > 1) throw new Error('profile store down');
        return h.actualCaps!(...a);
      });
      await expectForbiddenScope(await req('/api/vectors?scope=finance_private', tier), tier);
    }
    h.capsLookup.mockImplementation((...a: unknown[]) => h.actualCaps!(...a));
    h.writeAudit.mockRejectedValue(new Error('audit table down'));
    await expectForbiddenScope(await req('/api/vectors?scope=finance_private', 'viewer'));
    expect(h.listDocuments).not.toHaveBeenCalled();
  });
});

/** NZR-6: chat-private scopes, derived from the caller's own identity. */
const chatScope = (agentId: string, chatId: string, uploaderId: string) =>
  `chat_${createHash('sha256').update(`${agentId}|${chatId}|${uploaderId}`).digest('hex').slice(0, 24)}`;
const SA = chatScope('ops', 'dashboard:chatA', 'dashboard:user:alice');
const SB = chatScope('ops', 'dashboard:chatB', 'dashboard:user:bob');

describe('NZR-6 knowledge routes keep chat files private', () => {
  it('F6-8 /vectors* refuse a chat-private scope to anyone but its owner', async () => {
    for (const tier of ['viewer', 'operator', 'alice'] as const) {
      for (const r of READS(SA)) await expectForbiddenScope(await r.run(tier), `${tier} ${r.route}`);
    }
    await expectForbiddenScope(await req(`/api/vectors/${SA}/doc1`, 'operator', 'DELETE'));
    // A viewer cannot delete at all (agents:write comes first).
    expect((await req(`/api/vectors/${SA}/doc1`, 'viewer', 'DELETE')).status).toBe(403);
    // Writes into chat_* come only from the chat pipeline and the reassign route.
    for (const tier of ['operator', 'admin'] as const) {
      await expectForbiddenScope(await req('/api/ingest', tier, 'POST', { content: 'x', scope: SA }), `${tier} /ingest`);
      await expectForbiddenScope(await req('/api/ingest/stream', tier, 'POST', { content: 'x', scope: 'chat_quarantine' }), `${tier} /ingest/stream`);
    }
    expectNoKnowledgeIo();
    expect(h.writeAuditOrThrow).not.toHaveBeenCalled();
    const raw = JSON.stringify(h.writeAudit.mock.calls);
    expect(raw).not.toContain(SA);
  });

  it('F6-12 a user lists their own chat files by agentId and chatId', async () => {
    h.listDocuments.mockImplementation(async (scope: string) =>
      scope === SA ? [{ docId: 'chat-a', title: 'report.pdf', chunkCount: 2, createdAt: '2026-10-25T00:00:00Z' }] : [],
    );
    const a = await req('/api/vectors?agentId=ops&chatId=dashboard%3AchatA', 'alice');
    expect(a.status).toBe(200);
    const aBody = (await a.json()) as { scope: string; count: number; docs: Array<{ docId: string }> };
    expect(aBody.scope).toBe(SA);
    expect(aBody.count).toBe(1);
    expect(aBody.docs.map((d) => d.docId)).toEqual(['chat-a']);

    // Same URL for B derives B's own (empty) scope, never A's.
    const b = await req('/api/vectors?agentId=ops&chatId=dashboard%3AchatA', 'bob');
    expect(b.status).toBe(200);
    expect(await b.json()).toEqual({
      scope: chatScope('ops', 'dashboard:chatA', 'dashboard:user:bob'),
      count: 0,
      docs: [],
    });

    // search and answer accept {agentId, chatId} in place of scope.
    const s = await req('/api/vectors/search', 'bob', 'POST', { query: 'q', agentId: 'ops', chatId: 'dashboard:chatB' });
    expect(s.status).toBe(200);
    expect(((await s.json()) as { scope: string }).scope).toBe(SB);
    const ans = await req('/api/vectors/answer', 'alice', 'POST', { query: 'q', modelId: MODEL_ID, agentId: 'ops', chatId: 'dashboard:chatA' });
    expect(ans.status).toBe(200);
    expect(h.search.mock.calls.map((c) => (c[0] as { scope: string }).scope)).toEqual([SB, SA]);

    // Both a scope and agentId/chatId, or only half of the pair: 400.
    for (const path of [
      `/api/vectors?scope=default&agentId=ops&chatId=dashboard%3AchatA`,
      '/api/vectors?agentId=ops',
      '/api/vectors?chatId=dashboard%3AchatA',
    ]) {
      const res = await req(path, 'alice');
      expect(res.status, path).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid_scope' });
    }
    expect(h.writeAuditOrThrow).not.toHaveBeenCalled();
  });

  it('accepts every chat id the send route accepts, however long', async () => {
    // safeDashboardChatId passes a prefixed id through unchanged at any length.
    const chatId = `dashboard:${'x'.repeat(300)}`;
    const want = chatScope('ops', chatId, 'dashboard:user:alice');
    const l = await req(`/api/vectors?agentId=ops&chatId=${encodeURIComponent(chatId)}`, 'alice');
    expect(l.status).toBe(200);
    expect(((await l.json()) as { scope: string }).scope).toBe(want);
    const s = await req('/api/vectors/search', 'alice', 'POST', { query: 'q', agentId: 'ops', chatId });
    expect(s.status).toBe(200);
    const ans = await req('/api/vectors/answer', 'alice', 'POST', { query: 'q', modelId: MODEL_ID, agentId: 'ops', chatId });
    expect(ans.status).toBe(200);
    expect(h.search.mock.calls.map((c) => (c[0] as { scope: string }).scope)).toEqual([want, want]);
  });

  it('F6-13 an admin reads a chat scope only through an audited override', async () => {
    const ok = await req(`/api/vectors?scope=${SA}`, 'admin');
    expect(ok.status).toBe(200);
    expect(h.writeAuditOrThrow).toHaveBeenCalledTimes(1);
    expect(h.writeAuditOrThrow).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'session_read_override',
        detail: { scope: 'knowledge', requestedBy: 'dashboard:hash-admin' },
        result: 'ok',
      }),
    );
    expect(h.listDocuments).toHaveBeenCalledWith(SA);

    h.listDocuments.mockClear();
    h.writeAuditOrThrow.mockRejectedValue(new Error('audit table down'));
    const refused = await req(`/api/vectors?scope=${SA}`, 'admin');
    expect(refused.status).toBe(500);
    expect(await refused.json()).toEqual({ error: 'override_not_audited' });
    expect(h.listDocuments).not.toHaveBeenCalled();
  });

  it("F6-9 /ingest/stream refuses an s3Key under another caller's chat upload prefix", async () => {
    const tag = createHash('sha256').update('dashboard:user:alice').digest('hex').slice(0, 16);
    const res = await req('/api/ingest/stream', 'operator', 'POST', { s3Key: `uploads/chat/${tag}/id-1/a.pdf`, docTitle: 'a.pdf' });
    const text = await res.text();
    expect(text).toContain('"stage":"error"');
    expect(text).toContain('invalid upload key');
    expect(h.getObjectBuffer).not.toHaveBeenCalled();
    expect(h.deleteObject).not.toHaveBeenCalled();
    expect(h.ingestDocument).not.toHaveBeenCalled();
  });
});
