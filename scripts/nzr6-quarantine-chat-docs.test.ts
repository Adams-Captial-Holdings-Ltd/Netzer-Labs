import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * NZR-6 Scenario 9: legacy chat-tagged docs move out of agent/default/shared
 * scopes into the admin-only chat_quarantine scope. Copy, then an awaited
 * audit, then delete; idempotent; nothing lost. In-memory store.
 */

type Row = {
  chunkId: string;
  text: string;
  embedding: number[];
  metadata: { docId: string; docTitle?: string; scope: string; chunkIndex: number; start: number; end: number; uploadedAt: string; tags?: string[] };
};

const h = vi.hoisted(() => ({
  data: new Map<string, Map<string, unknown[]>>(),
  writeAuditOrThrow: vi.fn(),
  putDocument: vi.fn(),
  deleteDocument: vi.fn(),
}));

vi.mock('../src/lib/vectors/store.js', () => ({
  listScopePrefixes: async () => [...h.data.keys()],
  iterateRows: async function* (scope: string) {
    for (const rows of h.data.get(scope)?.values() ?? []) yield* rows;
  },
  putDocument: h.putDocument,
  deleteDocument: h.deleteDocument,
}));
vi.mock('../src/lib/audit/audit-writer.js', () => ({ writeAuditOrThrow: h.writeAuditOrThrow }));

import { quarantineChatDocs, countChatDocsOutsideChatScopes } from './nzr6-quarantine-chat-docs.js';

function doc(scope: string, docId: string, tags: string[], n = 2): Row[] {
  return Array.from({ length: n }, (_, i) => ({
    chunkId: `${docId}#${i}`,
    text: `text ${docId} ${i}`,
    embedding: [i, 0.5, 0.25],
    metadata: { docId, docTitle: `${docId}.pdf`, scope, chunkIndex: i, start: 0, end: 4, uploadedAt: '2026-09-01T00:00:00Z', tags },
  }));
}

function seed(): void {
  h.data.clear();
  const put = (scope: string, rows: Row[]) => {
    if (!h.data.has(scope)) h.data.set(scope, new Map());
    h.data.get(scope)!.set(rows[0]!.metadata.docId, rows);
  };
  // The same content-hash docId in two scopes must not collide in quarantine.
  put('ops_private', doc('ops_private', 'chat-same', ['chat', 'telegram', 'agent:ops']));
  put('default', doc('default', 'chat-same', ['chat', 'slack', 'agent:main'], 3));
  put('shared', doc('shared', 'chat-shared1', ['chat', 'dashboard', 'agent:ops'], 1));
  // Untagged docs stay where they are.
  put('ops_private', doc('ops_private', 'handbook', ['policy']));
  put('default', doc('default', 'faq', []));
  // Already-private chat scopes are not touched.
  put('chat_0123456789abcdef01234567', doc('chat_0123456789abcdef01234567', 'chat-mine', ['chat', 'dashboard', 'agent:ops']));
}

const docIds = (scope: string) => [...(h.data.get(scope)?.keys() ?? [])].sort();

beforeEach(() => {
  seed();
  h.writeAuditOrThrow.mockReset().mockResolvedValue(undefined);
  h.putDocument.mockReset().mockImplementation(async (scope: string, docId: string, rows: Row[]) => {
    if (!h.data.has(scope)) h.data.set(scope, new Map());
    h.data.get(scope)!.set(docId, rows.map((r) => ({ ...r, metadata: { ...r.metadata, scope } })));
  });
  h.deleteDocument.mockReset().mockImplementation(async (scope: string, docId: string) => {
    h.data.get(scope)?.delete(docId);
  });
});

describe('NZR-6 quarantine script', () => {
  it('F6-14 moves chat-tagged docs to chat_quarantine, audits each before delete, and is idempotent', async () => {
    const before = JSON.stringify([...h.data.entries()].map(([s, m]) => [s, [...m.entries()]]));
    const lines: string[] = [];
    const dry = await quarantineChatDocs({ apply: false, log: (l) => lines.push(l) });
    expect(dry.candidates.map((c) => `${c.fromScope}/${c.docId}`).sort()).toEqual([
      'default/chat-same',
      'ops_private/chat-same',
      'shared/chat-shared1',
    ]);
    const out = lines.join('\n');
    for (const want of ['ops_private', 'chat-same', 'chat-same.pdf', 'chat-shared1']) expect(out).toContain(want);
    expect(JSON.stringify([...h.data.entries()].map(([s, m]) => [s, [...m.entries()]]))).toBe(before);
    expect(h.putDocument).not.toHaveBeenCalled();
    expect(h.writeAuditOrThrow).not.toHaveBeenCalled();
    expect(await countChatDocsOutsideChatScopes()).toBe(3);

    const first = await quarantineChatDocs({ apply: true, log: () => {} });
    expect(first.moved).toBe(3);
    expect(first.failures).toEqual([]);
    expect(docIds('chat_quarantine')).toEqual(['default__chat-same', 'ops_private__chat-same', 'shared__chat-shared1']);
    expect(docIds('ops_private')).toEqual(['handbook']);
    expect(docIds('default')).toEqual(['faq']);
    expect(docIds('shared')).toEqual([]);
    expect(docIds('chat_0123456789abcdef01234567')).toEqual(['chat-mine']);

    // Chunks and embeddings unchanged; docId prefixed; from: tag added.
    const q = h.data.get('chat_quarantine')!.get('default__chat-same') as Row[];
    expect(q.length).toBe(3);
    expect(q.map((r) => r.embedding)).toEqual(doc('default', 'chat-same', [], 3).map((r) => r.embedding));
    expect(q.map((r) => r.text)).toEqual(doc('default', 'chat-same', [], 3).map((r) => r.text));
    for (const r of q) {
      expect(r.metadata.docId).toBe('default__chat-same');
      expect(r.metadata.tags).toEqual(['chat', 'slack', 'agent:main', 'from:default']);
      expect(r.metadata.scope).toBe('chat_quarantine');
    }

    // One awaited audit row per doc, each after its copy and before its delete.
    expect(h.writeAuditOrThrow).toHaveBeenCalledTimes(3);
    for (let i = 0; i < 3; i++) {
      expect(h.putDocument.mock.invocationCallOrder[i]!).toBeLessThan(h.writeAuditOrThrow.mock.invocationCallOrder[i]!);
      expect(h.writeAuditOrThrow.mock.invocationCallOrder[i]!).toBeLessThan(h.deleteDocument.mock.invocationCallOrder[i]!);
    }
    expect(h.writeAuditOrThrow).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'knowledge_quarantined', agentId: 'ops', result: 'ok' }),
    );
    expect(JSON.stringify(h.writeAuditOrThrow.mock.calls)).not.toContain('.pdf');
    // No source scope names either (qDocId embeds them).
    expect(JSON.stringify(h.writeAuditOrThrow.mock.calls)).not.toContain('ops_private');

    const second = await quarantineChatDocs({ apply: true, log: () => {} });
    expect(second.moved).toBe(0);
    expect(second.candidates).toEqual([]);
    expect(h.writeAuditOrThrow).toHaveBeenCalledTimes(3);
    expect(await countChatDocsOutsideChatScopes()).toBe(0);
  });

  it('keeps a doc in place when its audit write fails', async () => {
    h.writeAuditOrThrow.mockImplementation(async (e: { detail: { docId?: string } }) => {
      if (e.detail.docId === 'chat-shared1') throw new Error('audit table down');
    });
    const res = await quarantineChatDocs({ apply: true, log: () => {} });
    expect(res.moved).toBe(2);
    expect(res.failures.length).toBe(1);
    expect(docIds('shared')).toEqual(['chat-shared1']);
    expect(h.deleteDocument).not.toHaveBeenCalledWith('shared', 'chat-shared1');
    expect(await countChatDocsOutsideChatScopes()).toBe(1);
  });
});
