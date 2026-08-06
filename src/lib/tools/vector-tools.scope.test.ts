import { describe, it, expect, vi, beforeEach } from 'vitest';

const { embedOneMock, searchMock, ingestDocumentMock, loadAgentMock } = vi.hoisted(() => ({
  embedOneMock: vi.fn(),
  searchMock: vi.fn(),
  ingestDocumentMock: vi.fn(),
  loadAgentMock: vi.fn(),
}));

vi.mock('../vectors/embedder.js', () => ({ embedOne: embedOneMock }));
vi.mock('../vectors/store.js', () => ({ search: searchMock }));
vi.mock('../vectors/ingest.js', () => ({ ingestDocument: ingestDocumentMock }));
vi.mock('../config/agent-loader.js', () => ({
  loadAgent: loadAgentMock,
  DEFAULT_KNOWLEDGE_SCOPE: 'default',
  SHARED_KNOWLEDGE_SCOPE: 'shared',
}));

import './vector-tools.js'; // side-effect registration
import { tools } from './registry.js';

const ctx = { agentId: 'research', chatId: 'owner:emmanuel' };

beforeEach(() => {
  vi.clearAllMocks();
  loadAgentMock.mockResolvedValue({ knowledgeScope: 'research-corpus' });
  embedOneMock.mockResolvedValue([0.1, 0.2]);
  searchMock.mockResolvedValue([]);
  ingestDocumentMock.mockResolvedValue({ chunks: 1, failed: 0, docId: 'd1', scope: 'research-corpus' });
});

// The scope arg is model-controlled, i.e. attacker-controlled under prompt
// injection. Writes must land only in the agent's own corpus (a write to
// 'shared' would poison retrieval for every agent), and reads must not reach
// into another agent's private corpus.
describe('ingest_document scope containment', () => {
  it('ignores the arg and writes to the agent\'s own scope by default', async () => {
    await tools.invoke('ingest_document', { content: 'a fact' }, ctx);
    expect(ingestDocumentMock).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'research-corpus' }),
    );
  });

  it('refuses a shared-scope write', async () => {
    const out = await tools.invoke(
      'ingest_document',
      { content: 'poison', scope: 'shared' },
      ctx,
    );
    expect(out.isError).toBe(true);
    expect(ingestDocumentMock).not.toHaveBeenCalled();
  });

  it('refuses another agent\'s scope', async () => {
    const out = await tools.invoke(
      'ingest_document',
      { content: 'poison', scope: 'ops-corpus' },
      ctx,
    );
    expect(out.isError).toBe(true);
    expect(ingestDocumentMock).not.toHaveBeenCalled();
  });

  it('accepts an explicit scope equal to the agent\'s own', async () => {
    const out = await tools.invoke(
      'ingest_document',
      { content: 'a fact', scope: 'research-corpus' },
      ctx,
    );
    expect(out.isError).toBeFalsy();
    expect(ingestDocumentMock).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'research-corpus' }),
    );
  });
});

describe('s3_vectors_search scope containment', () => {
  it('searches own scope plus shared by default', async () => {
    await tools.invoke('s3_vectors_search', { query: 'q' }, ctx);
    const scopes = searchMock.mock.calls.map((c) => c[0].scope).sort();
    expect(scopes).toEqual(['research-corpus', 'shared']);
  });

  it('refuses an arbitrary scope override', async () => {
    const out = await tools.invoke(
      's3_vectors_search',
      { query: 'q', scope: 'ops-corpus' },
      ctx,
    );
    expect(out.isError).toBe(true);
    expect(searchMock).not.toHaveBeenCalled();
  });

  it('allows narrowing to shared explicitly', async () => {
    const out = await tools.invoke(
      's3_vectors_search',
      { query: 'q', scope: 'shared' },
      ctx,
    );
    expect(out.isError).toBeFalsy();
    const scopes = searchMock.mock.calls.map((c) => c[0].scope);
    expect(scopes).toEqual(['shared']);
  });
});
