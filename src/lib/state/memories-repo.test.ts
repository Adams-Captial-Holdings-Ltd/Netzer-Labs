import { describe, it, expect, vi, beforeEach } from 'vitest';

const send = vi.fn();
vi.mock('./ddb.js', () => ({ ddb: () => ({ send }) }));
vi.mock('../../observability/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { listMemoriesForAgent } from './memories-repo.js';

beforeEach(() => {
  send.mockReset();
});

describe('listMemoriesForAgent', () => {
  it('queries the agent partition for all chats and returns newest-first', async () => {
    send.mockResolvedValue({
      Items: [
        { id: 'a', chatId: 'chat-1', content: 'older', tags: [], importance: 50, source: 'user', createdAt: '2026-01-01T00:00:00.000Z' },
        { id: 'b', chatId: 'chat-2', content: 'newer', tags: [], importance: 50, source: 'user', createdAt: '2026-06-01T00:00:00.000Z' },
      ],
    });

    const out = await listMemoriesForAgent('main', 50);

    // Query is scoped to the agent partition with a chat-agnostic MEM# prefix.
    const input = send.mock.calls[0][0].input;
    expect(input.KeyConditionExpression).toContain('begins_with(SK, :sk)');
    expect(input.ExpressionAttributeValues[':pk']).toBe('AGENT#main');
    expect(input.ExpressionAttributeValues[':sk']).toBe('MEM#');

    // Re-sorted newest-first by createdAt regardless of chat ordering.
    expect(out.map((m) => m.id)).toEqual(['b', 'a']);
    expect(out[0].agentId).toBe('main');
  });

  it('returns an empty list when no memories exist', async () => {
    send.mockResolvedValue({ Items: [] });
    const out = await listMemoriesForAgent('quiet-agent');
    expect(out).toEqual([]);
  });

  it('returns the newest memory even when it sorts after the first SK page', async () => {
    // Regression: SK is MEM#<chatId>#<isoTime>#<id>, so DDB returns rows ordered
    // by chatId first. A DDB-side Limit would slice by chatId order BEFORE
    // recency, dropping a recent memory that lives under a lexicographically-
    // LATER chatId. Here the NEWEST memory ('newest') is under chat-zzz, which
    // DDB pages last. The repo must page through all rows (following
    // LastEvaluatedKey) and sort by createdAt so 'newest' still comes first.
    const limit = 2;
    // Page 1: lexicographically-lower chatIds, older memories. Enough rows that
    // a naive DDB-side `Limit: 2` would have stopped here and never seen page 2.
    const page1 = [
      { id: 'old-a', chatId: 'chat-aaa', content: 'old a', tags: [], importance: 50, source: 'user', createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 'old-b', chatId: 'chat-aaa', content: 'old b', tags: [], importance: 50, source: 'user', createdAt: '2026-02-01T00:00:00.000Z' },
    ];
    // Page 2: lexicographically-later chatId holding the single newest memory.
    const page2 = [
      { id: 'newest', chatId: 'chat-zzz', content: 'newest', tags: [], importance: 50, source: 'user', createdAt: '2026-06-01T00:00:00.000Z' },
    ];

    send
      .mockResolvedValueOnce({ Items: page1, LastEvaluatedKey: { PK: 'AGENT#main', SK: 'MEM#chat-aaa#cursor' } })
      .mockResolvedValueOnce({ Items: page2 });

    const out = await listMemoriesForAgent('main', limit);

    // Both pages were fetched (followed LastEvaluatedKey).
    expect(send).toHaveBeenCalledTimes(2);
    // The second query passed the first page's LastEvaluatedKey as the start.
    expect(send.mock.calls[1][0].input.ExclusiveStartKey).toEqual({
      PK: 'AGENT#main',
      SK: 'MEM#chat-aaa#cursor',
    });
    // No DDB-side Limit: the slice happens after the cross-page createdAt sort.
    expect(send.mock.calls[0][0].input.Limit).toBeUndefined();
    // Newest-first across pages, sliced to the requested limit.
    expect(out.map((m) => m.id)).toEqual(['newest', 'old-b']);
  });
});
