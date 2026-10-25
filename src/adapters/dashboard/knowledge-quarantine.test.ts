import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import type { TokenPrincipal } from '../../lib/auth/dashboard-auth.js';

/**
 * NZR-6 Scenario 10: admins list the quarantined legacy chat files and either
 * reassign one to a dashboard chat (into its owner's chat-private scope, after
 * an awaited audit) or delete it. Drives the real dashboard router.
 */

const h = vi.hoisted(() => ({
  authenticateDashboardToken: vi.fn(),
  iterateRows: vi.fn(),
  readDocumentRows: vi.fn(),
  putDocument: vi.fn(),
  deleteDocument: vi.fn(),
  removeDocument: vi.fn(),
  getSession: vi.fn(),
  writeAudit: vi.fn(),
  writeAuditOrThrow: vi.fn(),
}));

vi.mock('../../lib/auth/dashboard-auth.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/auth/dashboard-auth.js')>();
  return {
    ...actual,
    extractBearerToken: (hdr?: string) => (hdr ?? '').replace(/^Bearer\s+/i, ''),
    authenticateDashboardToken: (raw: string) => h.authenticateDashboardToken(raw),
  };
});
vi.mock('../../lib/vectors/store.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/vectors/store.js')>();
  return {
    ...actual,
    iterateRows: h.iterateRows,
    readDocumentRows: h.readDocumentRows,
    putDocument: h.putDocument,
    deleteDocument: h.deleteDocument,
  };
});
vi.mock('../../lib/vectors/ingest.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/vectors/ingest.js')>();
  return { ...actual, removeDocument: h.removeDocument };
});
vi.mock('../../lib/state/sessions-repo.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/state/sessions-repo.js')>();
  return { ...actual, getSession: h.getSession };
});
vi.mock('../../lib/audit/audit-writer.js', () => ({ writeAudit: h.writeAudit, writeAuditOrThrow: h.writeAuditOrThrow }));
vi.mock('../../observability/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  truncateForLog: (s: string) => s,
}));

import { buildDashboardRouter } from './handler.js';

type Tier = 'viewer' | 'operator' | 'admin';

function principalFor(raw: string): TokenPrincipal | null {
  const id = raw.replace(/^Bearer\s+/i, '');
  if (id === 'viewer' || id === 'operator' || id === 'admin') {
    return { tokenHash: `hash-${id}`, label: id, hashPrefix16: id, role: id };
  }
  return null;
}

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

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const ALICE = 'dashboard:user:alice';
const SA = `chat_${sha(`ops|dashboard:chatA|${ALICE}`).slice(0, 24)}`;

function row(docId: string, i: number, text: string, extra: { tags: string[]; source: string; uploadedAt: string }) {
  return {
    chunkId: `${docId}#${i}`,
    text,
    embedding: [0.1 * (i + 1), 0.2],
    metadata: { docId, docTitle: 'a.pdf', scope: 'chat_quarantine', chunkIndex: i, start: 0, end: text.length, ...extra },
  };
}
const Q1 = 'ops_private__chat-aaa';
const Q2 = 'default__chat-bbb';
const q1Meta = {
  tags: ['chat', 'dashboard', 'agent:ops', 'from:ops_private'],
  source: 's3://raw-bucket/dashboard/dashboard:chatA/2026/10/01/1700000000000-a.pdf',
  uploadedAt: '2026-10-01T00:00:00Z',
};
const q2Meta = {
  tags: ['chat', 'telegram', 'agent:ops', 'from:default'],
  source: 's3://raw-bucket/telegram/telegram:42/2026/09/01/1700000000000-b.pdf',
  uploadedAt: '2026-09-01T00:00:00Z',
};
const Q1_ROWS = [row(Q1, 0, 'abc', q1Meta), row(Q1, 1, 'de', q1Meta)];
const Q2_ROWS = [row(Q2, 0, 'xyz', q2Meta)];

beforeEach(() => {
  h.authenticateDashboardToken.mockReset().mockImplementation(async (raw: string) => principalFor(raw));
  h.iterateRows.mockReset().mockImplementation(async function* (scope: string) {
    if (scope === 'chat_quarantine') yield* [...Q2_ROWS, ...Q1_ROWS];
  });
  h.readDocumentRows.mockReset().mockImplementation(async (scope: string, docId: string) =>
    scope === 'chat_quarantine' && docId === Q1 ? Q1_ROWS : [],
  );
  h.putDocument.mockReset().mockResolvedValue(undefined);
  h.deleteDocument.mockReset().mockResolvedValue(undefined);
  h.removeDocument.mockReset().mockResolvedValue(undefined);
  h.getSession.mockReset().mockImplementation(async (agentId: string, chatId: string) =>
    agentId === 'ops' && chatId === 'dashboard:chatA' ? { agentId, chatId, surface: 'dashboard', userId: ALICE, turns: [] } : null,
  );
  h.writeAudit.mockReset().mockResolvedValue(undefined);
  h.writeAuditOrThrow.mockReset().mockResolvedValue(undefined);
});

const reassign = (tier: Tier, body: unknown, docId = Q1) =>
  req(`/api/knowledge/quarantine/${encodeURIComponent(docId)}/reassign`, tier, 'POST', body);

describe('NZR-6 quarantined legacy chat files', () => {
  it('lists quarantined docs to admins only', async () => {
    for (const tier of ['viewer', 'operator'] as const) {
      const res = await req('/api/knowledge/quarantine', tier);
      expect(res.status, tier).toBe(403);
      expect(await res.json()).toEqual({ error: 'forbidden', requiredCapability: 'knowledge:private:read' });
    }
    expect(h.iterateRows).not.toHaveBeenCalled();

    const res = await req('/api/knowledge/quarantine', 'admin');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      count: 2,
      docs: [
        { docId: Q1, title: 'a.pdf', agentId: 'ops', surface: 'dashboard', fromScope: 'ops_private', uploadedAt: '2026-10-01T00:00:00Z', chunks: 2, chars: 5, suggestedChatId: 'dashboard:chatA' },
        { docId: Q2, title: 'a.pdf', agentId: 'ops', surface: 'telegram', fromScope: 'default', uploadedAt: '2026-09-01T00:00:00Z', chunks: 1, chars: 3, suggestedChatId: 'telegram:42' },
      ],
    });
    expect(h.iterateRows).toHaveBeenCalledWith('chat_quarantine');
  });

  it("reassigns a doc into the chat owner's scope after an awaited audit", async () => {
    const res = await reassign('admin', { agentId: 'ops', chatId: 'dashboard:chatA' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, docId: 'chat-aaa', agentId: 'ops', chatId: 'dashboard:chatA' });

    expect(h.writeAuditOrThrow).toHaveBeenCalledTimes(1);
    expect(h.writeAuditOrThrow).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'knowledge_reassigned', agentId: 'ops', chatId: 'dashboard:chatA', result: 'ok' }),
    );
    const [scope, docId, rows] = h.putDocument.mock.calls[0]! as [string, string, typeof Q1_ROWS];
    expect(scope).toBe(SA);
    expect(docId).toBe('chat-aaa');
    expect(rows.map((r) => r.embedding)).toEqual(Q1_ROWS.map((r) => r.embedding));
    expect(rows.map((r) => r.text)).toEqual(['abc', 'de']);
    for (const r of rows) {
      expect(r.metadata.docId).toBe('chat-aaa');
      expect(r.metadata.tags).toEqual(['chat', 'dashboard', 'agent:ops', `owner:${sha(ALICE).slice(0, 16)}`]);
    }
    expect(h.deleteDocument).toHaveBeenCalledWith('chat_quarantine', Q1);
    // Audit, then copy, then delete.
    const order = [h.writeAuditOrThrow, h.putDocument, h.deleteDocument].map((m) => m.mock.invocationCallOrder[0]!);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // No file names in the (viewer-readable) audit log.
    expect(JSON.stringify(h.writeAuditOrThrow.mock.calls)).not.toContain('a.pdf');
  });

  it('refuses to reassign to a chat with no dashboard owner', async () => {
    h.getSession.mockImplementation(async (agentId: string, chatId: string) =>
      chatId === 'slack:C1' ? { agentId, chatId, surface: 'slack', userId: 'U123', turns: [] }
        // Legacy token-hash owner: chat search uses dashboard:user:<person>, so this scope would be unreachable.
        : chatId === 'dashboard:legacy' ? { agentId, chatId, surface: 'dashboard', userId: 'dashboard:abc123tokenhash', turns: [] }
        : null,
    );
    for (const chatId of ['dashboard:nobody', 'slack:C1', 'dashboard:legacy']) {
      const res = await reassign('admin', { agentId: 'ops', chatId });
      expect(res.status, chatId).toBe(409);
      expect(await res.json()).toEqual({ error: 'no_dashboard_owner' });
    }
    // Not in quarantine / malformed body / not an admin.
    expect((await reassign('admin', { agentId: 'ops', chatId: 'dashboard:chatA' }, 'nope')).status).toBe(404);
    for (const body of [{}, { agentId: 'ops' }, { agentId: 1, chatId: 'x' }]) {
      const res = await reassign('admin', body);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid_body' });
    }
    expect((await reassign('operator', { agentId: 'ops', chatId: 'dashboard:chatA' })).status).toBe(403);
    expect(h.putDocument).not.toHaveBeenCalled();
    expect(h.deleteDocument).not.toHaveBeenCalled();
    expect(h.writeAuditOrThrow).not.toHaveBeenCalled();
  });

  it("merges into the owner's existing copy instead of overwriting it", async () => {
    // The owner re-uploaded the file after the fix: chunks 0 and 2 are already in SA.
    const mine = { tags: ['chat', 'dashboard', 'agent:ops', `owner:${sha(ALICE).slice(0, 16)}`], source: 's3://raw-bucket/x', uploadedAt: '2026-10-20T00:00:00Z' };
    const existing = [row('chat-aaa', 0, 'NEW0', mine), row('chat-aaa', 2, 'NEW2', mine)];
    h.readDocumentRows.mockImplementation(async (scope: string, docId: string) =>
      scope === 'chat_quarantine' && docId === Q1 ? Q1_ROWS : scope === SA && docId === 'chat-aaa' ? existing : [],
    );
    const res = await reassign('admin', { agentId: 'ops', chatId: 'dashboard:chatA' });
    expect(res.status).toBe(200);
    const [, , rows] = h.putDocument.mock.calls[0]! as [string, string, typeof Q1_ROWS];
    // Existing chunks win; the quarantine copy only fills the gap.
    expect(rows.map((r) => [r.metadata.chunkIndex, r.text])).toEqual([[0, 'NEW0'], [1, 'de'], [2, 'NEW2']]);
    expect(h.deleteDocument).toHaveBeenCalledWith('chat_quarantine', Q1);
  });

  it('a failed audit leaves the doc in quarantine', async () => {
    h.writeAuditOrThrow.mockRejectedValue(new Error('audit table down'));
    const res = await reassign('admin', { agentId: 'ops', chatId: 'dashboard:chatA' });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'override_not_audited' });
    expect(h.putDocument).not.toHaveBeenCalled();
    expect(h.deleteDocument).not.toHaveBeenCalled();
  });

  it('an admin deletes a quarantined doc through the audited override', async () => {
    const res = await req(`/api/vectors/chat_quarantine/${Q1}`, 'admin', 'DELETE');
    expect(res.status).toBe(200);
    expect(h.removeDocument).toHaveBeenCalledWith('chat_quarantine', Q1);
    expect(h.writeAuditOrThrow).toHaveBeenCalledWith(expect.objectContaining({ action: 'session_read_override' }));
    expect(h.writeAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'knowledge_delete' }));
  });
});
