import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';

/**
 * NZR-6 frozen tests: s3_vectors_search adds exactly one chat-private scope,
 * the current chat's own (bound to the turn's userId), and never another's.
 */

const h = vi.hoisted(() => ({
  embedOne: vi.fn(),
  search: vi.fn(),
  ingestDocument: vi.fn(),
  loadAgent: vi.fn(),
}));

vi.mock('../vectors/embedder.js', () => ({ embedOne: h.embedOne }));
vi.mock('../vectors/store.js', () => ({ search: h.search }));
vi.mock('../vectors/ingest.js', () => ({ ingestDocument: h.ingestDocument }));
vi.mock('../config/agent-loader.js', () => ({
  loadAgent: h.loadAgent,
  DEFAULT_KNOWLEDGE_SCOPE: 'default',
  SHARED_KNOWLEDGE_SCOPE: 'shared',
}));

import './vector-tools.js'; // side-effect registration
import { tools } from './registry.js';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const scopeOf = (agentId: string, chatId: string, userId: string) =>
  `chat_${sha(`${agentId}|${chatId}|${userId}`).slice(0, 24)}`;
const SA = scopeOf('ops', 'dashboard:chatA', 'dashboard:user:alice');
const SB = scopeOf('ops', 'dashboard:chatB', 'dashboard:user:bob');

const ctxA = { agentId: 'ops', chatId: 'dashboard:chatA', userId: 'dashboard:user:alice', surface: 'dashboard' as const };
const ctxB = { agentId: 'ops', chatId: 'dashboard:chatB', userId: 'dashboard:user:bob', surface: 'dashboard' as const };

const passage = (scope: string) => ({
  score: 0.9,
  row: {
    chunkId: 'chat-a#0',
    text: 'ALICE PRIVATE PASSAGE',
    embedding: [],
    metadata: { docId: 'chat-a', docTitle: 'report.pdf', scope, chunkIndex: 0, start: 0, end: 1, uploadedAt: '' },
  },
});

const searched = () => h.search.mock.calls.map((c) => (c[0] as { scope: string }).scope);

beforeEach(() => {
  vi.clearAllMocks();
  h.loadAgent.mockResolvedValue({ knowledgeScope: 'ops_private' });
  h.embedOne.mockResolvedValue([0.1, 0.2]);
  // Only A's chat scope holds A's file.
  h.search.mockImplementation(async ({ scope }: { scope: string }) => (scope === SA ? [passage(SA)] : []));
});

describe("NZR-6 s3_vectors_search reads only the current chat's private scope", () => {
  it("F6-6 s3_vectors_search in user A's chat finds A's chat-added passage", async () => {
    const out = await tools.invoke('s3_vectors_search', { query: 'what is in my report' }, ctxA);
    expect(out.isError).toBeFalsy();
    expect(searched()).toEqual(['ops_private', 'default', 'shared', SA]);
    expect(out.text).toContain('ALICE PRIVATE PASSAGE');
  });

  it("F6-5 s3_vectors_search in user B's chat never searches user A's chat scope", async () => {
    const out = await tools.invoke('s3_vectors_search', { query: 'what is in the report' }, ctxB);
    expect(searched()).toEqual(['ops_private', 'default', 'shared', SB]);
    expect(searched()).not.toContain(SA);
    expect(out.text).not.toContain('ALICE PRIVATE PASSAGE');
  });

  it("F6-7 refuses a model-supplied scope naming another chat's private scope", async () => {
    for (const scope of [SA, 'chat_quarantine']) {
      const out = await tools.invoke('s3_vectors_search', { query: 'q', scope }, ctxB);
      expect(out.isError, scope).toBe(true);
    }
    expect(h.search).not.toHaveBeenCalled();
    // Narrowing to the chat's own scope is allowed.
    const own = await tools.invoke('s3_vectors_search', { query: 'q', scope: SA }, ctxA);
    expect(own.isError).toBeFalsy();
    expect(searched()).toEqual([SA]);
  });

  it('F6-11 a Slack or Telegram turn adds no chat-private scope it did not write', async () => {
    const slack = { agentId: 'ops', chatId: 'slack:C1', userId: 'U123', surface: 'slack' as const };
    const telegram = { agentId: 'ops', chatId: 'telegram:42', userId: '42', surface: 'telegram' as const };
    for (const ctx of [slack, telegram]) {
      h.search.mockClear();
      const out = await tools.invoke('s3_vectors_search', { query: 'report' }, ctx);
      expect(searched()).toEqual(['ops_private', 'default', 'shared', scopeOf('ops', ctx.chatId, ctx.userId)]);
      expect(out.text).not.toContain('ALICE PRIVATE PASSAGE');
    }
    // No userId on the turn: no chat scope at all.
    h.search.mockClear();
    await tools.invoke('s3_vectors_search', { query: 'report' }, { agentId: 'ops', chatId: 'dashboard:chatA' });
    expect(searched()).toEqual(['ops_private', 'default', 'shared']);
  });
});
