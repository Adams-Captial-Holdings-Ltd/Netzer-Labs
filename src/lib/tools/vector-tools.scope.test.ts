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
  // Every agent reads three corpora in one query: its own, the default, and
  // the shared one. When its own scope IS one of the other two the list
  // collapses, so no corpus is ever scanned twice.
  it.each([
    ['research-corpus', ['research-corpus', 'default', 'shared']],
    ['default', ['default', 'shared']],
    ['shared', ['shared', 'default']],
  ] as const)('fans out over three corpora when own scope is %s', async (ownScope, expected) => {
    loadAgentMock.mockResolvedValue({ knowledgeScope: ownScope });
    await tools.invoke('s3_vectors_search', { query: 'q' }, ctx);
    const scopes = searchMock.mock.calls.map((c) => c[0].scope);
    expect(scopes).toEqual(expected);
    expect(scopes.length).toBe(new Set(scopes).size);
  });

  it('allows narrowing to default explicitly', async () => {
    const out = await tools.invoke(
      's3_vectors_search',
      { query: 'q', scope: 'default' },
      ctx,
    );
    expect(out.isError).toBeFalsy();
    const scopes = searchMock.mock.calls.map((c) => c[0].scope);
    expect(scopes).toEqual(['default']);
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
  // A corpus that returned nothing must be visibly distinct from a corpus that
  // returned something and lost the blended ranking. Collapsing both to "absent"
  // is the silent-corpus defect this whole fan-out exists to kill.
  const hit = (scope: string, score: number, chunkId: string) => ({
    score,
    row: {
      chunkId,
      text: 'passage text',
      embedding: [],
      metadata: {
        docId: 'd',
        scope,
        chunkIndex: 0,
        start: 0,
        end: 1,
        uploadedAt: '',
      },
    },
  });

  it('reports an own-scope shutout as kept/found, not as absence', async () => {
    searchMock.mockImplementation(({ scope }: { scope: string }) =>
      Promise.resolve(
        scope === 'default'
          ? [hit('default', 0.9, 'a'), hit('default', 0.8, 'b')]
          : scope === 'research-corpus'
            ? [hit('research-corpus', 0.3, 'c')]
            : [],
      ),
    );
    const out = await tools.invoke('s3_vectors_search', { query: 'q', top_k: 2 }, ctx);
    // own corpus offered one passage and lost it; that is not the same as empty
    expect(out.text).toContain('research-corpus 0/1');
    expect(out.text).toContain('default 2/2');
    expect(out.text).toContain('shared 0/0');
  });

  // Regression guard. `scopes` holds the raw agent.yaml value while
  // metadata.scope holds the normalizeScope-folded form, so counting by scope
  // string prints 0 above passages tagged with that very scope. Count by chunk
  // identity instead; this test fails if anyone reintroduces a string compare.
  it('counts a colon-scoped corpus by chunk identity, not by scope string', async () => {
    loadAgentMock.mockResolvedValue({ knowledgeScope: 'agent:ops' });
    searchMock.mockImplementation(({ scope }: { scope: string }) =>
      Promise.resolve(scope === 'agent:ops' ? [hit('agent_ops', 0.9, 'c1')] : []),
    );
    const out = await tools.invoke('s3_vectors_search', { query: 'q' }, ctx);
    expect(out.text).toContain('agent:ops 1/1');
  });

  it('F5-11 refuses an agent knowledgeScope in the reserved chat_ namespace', async () => {
    for (const knowledgeScope of ['chat_abc', 'chat:abc']) {
      loadAgentMock.mockResolvedValue({ knowledgeScope });
      const search = await tools.invoke('s3_vectors_search', { query: 'q' }, ctx);
      expect(search.isError).toBe(true);
      expect(search.text).toContain('invalid knowledge scope');
      const ingest = await tools.invoke('ingest_document', { content: 'x' }, ctx);
      expect(ingest.isError).toBe(true);
      expect(ingest.text).toContain('invalid knowledge scope');
    }
    expect(searchMock).not.toHaveBeenCalled();
    expect(embedOneMock).not.toHaveBeenCalled();
    expect(ingestDocumentMock).not.toHaveBeenCalled();
  });

  it('states the filters in force rather than guessing a cause when empty', async () => {
    const out = await tools.invoke('s3_vectors_search', { query: 'q' }, ctx);
    expect(out.text).toContain('research-corpus');
    expect(out.text).not.toContain('broader phrasing');
  });
});
