import { describe, it, expect, vi, beforeEach } from 'vitest';

const send = vi.fn();
vi.mock('./ddb.js', () => ({ ddb: () => ({ send }) }));
vi.mock('../../observability/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  conversationOwnerId,
  newConversationId,
  isConversationChatId,
  getConversation,
  listConversations,
  listMessages,
  persistTurn,
  deleteConversationData,
} from './conversations-repo.js';

beforeEach(() => {
  send.mockReset();
});

function conditionalFailure(): Error {
  const err = new Error('conditional check failed');
  err.name = 'ConditionalCheckFailedException';
  return err;
}

describe('conversationOwnerId', () => {
  it('uses the users-table id when present (stable across logins)', () => {
    expect(
      conversationOwnerId({ userId: 'u-123', label: 'Session token', hashPrefix16: 'abc', profileId: 'admin' }),
    ).toBe('u-123');
  });

  it('maps the env break-glass token to the stable root owner', () => {
    expect(conversationOwnerId({ label: 'Root token', hashPrefix16: 'aaaa' })).toBe('root');
    expect(conversationOwnerId({ label: 'anything', profileId: 'owner', hashPrefix16: 'bbbb' })).toBe('root');
  });

  it('falls back to the token hash prefix for legacy minted tokens', () => {
    expect(conversationOwnerId({ label: 'ops laptop', hashPrefix16: 'deadbeef00112233' })).toBe(
      'token:deadbeef00112233',
    );
  });
});

describe('newConversationId / isConversationChatId', () => {
  it('mints a dashboard-prefixed unguessable id that safeDashboardChatId passes through', () => {
    const id = newConversationId();
    expect(id).toMatch(/^dashboard:c_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(isConversationChatId(id)).toBe(true);
  });

  it('rejects legacy timestamp chatIds', () => {
    expect(isConversationChatId('dashboard:1755100000000')).toBe(false);
    expect(isConversationChatId('slack:C123:U456')).toBe(false);
  });
});

describe('getConversation', () => {
  it('reads the meta under the OWNER partition — the lookup is the ownership check', async () => {
    send.mockResolvedValue({
      Item: {
        PK: 'USER#u-123',
        SK: 'CONV#dashboard:c_abc',
        conversationId: 'dashboard:c_abc',
        ownerId: 'u-123',
        agentId: 'main',
        title: 'hello',
        messageCount: 4,
        createdAt: 100,
        updatedAt: 200,
      },
    });

    const meta = await getConversation('u-123', 'dashboard:c_abc');

    const input = send.mock.calls[0][0].input;
    expect(input.Key).toEqual({ PK: 'USER#u-123', SK: 'CONV#dashboard:c_abc' });
    expect(meta).toMatchObject({
      conversationId: 'dashboard:c_abc',
      ownerId: 'u-123',
      agentId: 'main',
      title: 'hello',
      messageCount: 4,
    });
  });

  it('returns null when the caller does not own it (or it does not exist)', async () => {
    send.mockResolvedValue({});
    expect(await getConversation('u-999', 'dashboard:c_abc')).toBeNull();
  });
});

describe('listConversations', () => {
  it('queries the owner partition for CONV# items and sorts newest-updated first', async () => {
    send.mockResolvedValue({
      Items: [
        { conversationId: 'dashboard:c_old', ownerId: 'u-1', agentId: 'main', title: 'old', messageCount: 2, createdAt: 1, updatedAt: 10 },
        { conversationId: 'dashboard:c_new', ownerId: 'u-1', agentId: 'ops', title: 'new', messageCount: 2, createdAt: 2, updatedAt: 20 },
      ],
    });

    const out = await listConversations('u-1');

    const input = send.mock.calls[0][0].input;
    expect(input.KeyConditionExpression).toContain('begins_with(SK, :sk)');
    expect(input.ExpressionAttributeValues[':pk']).toBe('USER#u-1');
    expect(input.ExpressionAttributeValues[':sk']).toBe('CONV#');
    expect(out.map((c) => c.conversationId)).toEqual(['dashboard:c_new', 'dashboard:c_old']);
  });

  it('follows LastEvaluatedKey and caps the result at 100', async () => {
    const page = (start: number, n: number, withCursor: boolean) => ({
      Items: Array.from({ length: n }, (_, i) => ({
        conversationId: `dashboard:c_${start + i}`,
        ownerId: 'u-1',
        agentId: 'main',
        title: `t${start + i}`,
        messageCount: 2,
        createdAt: start + i,
        updatedAt: start + i,
      })),
      ...(withCursor ? { LastEvaluatedKey: { PK: 'USER#u-1', SK: `CONV#cursor-${start}` } } : {}),
    });
    send
      .mockResolvedValueOnce(page(0, 90, true))
      .mockResolvedValueOnce(page(90, 90, false));

    const out = await listConversations('u-1');

    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0].input.ExclusiveStartKey).toEqual({
      PK: 'USER#u-1',
      SK: 'CONV#cursor-0',
    });
    expect(out).toHaveLength(100);
    // Newest updatedAt (179) first after the cross-page sort.
    expect(out[0].conversationId).toBe('dashboard:c_179');
  });
});

describe('listMessages', () => {
  it('queries the conversation partition newest-first with a limit, then returns oldest-first', async () => {
    send.mockResolvedValue({
      Items: [
        { role: 'assistant', text: 'second reply', ts: 4 },
        { role: 'user', text: 'second ask', ts: 3 },
        { role: 'assistant', text: 'first reply', ts: 2 },
        { role: 'user', text: 'first ask', ts: 1 },
      ],
    });

    const out = await listMessages('dashboard:c_abc', 200);

    const input = send.mock.calls[0][0].input;
    expect(input.KeyConditionExpression).toContain('begins_with(SK, :sk)');
    expect(input.ExpressionAttributeValues[':pk']).toBe('CONV#dashboard:c_abc');
    expect(input.ExpressionAttributeValues[':sk']).toBe('MSG#');
    expect(input.ScanIndexForward).toBe(false);
    expect(input.Limit).toBe(200);
    expect(out.map((m) => m.text)).toEqual(['first ask', 'first reply', 'second ask', 'second reply']);
  });
});

describe('persistTurn', () => {
  it('writes the user and assistant messages so the pair sorts adjacently, then touches the meta', async () => {
    send.mockResolvedValue({});

    await persistTurn({
      ownerId: 'u-1',
      conversationId: 'dashboard:c_abc',
      agentId: 'main',
      userText: 'hello there',
      assistantText: 'hi!',
      clientMessageId: 'cmid-1',
    });

    // Two message puts + one meta update.
    expect(send).toHaveBeenCalledTimes(3);
    const userPut = send.mock.calls[0][0].input;
    const assistantPut = send.mock.calls[1][0].input;

    expect(userPut.Item.PK).toBe('CONV#dashboard:c_abc');
    expect(userPut.Item.SK).toMatch(/^MSG#\d{13}#0#/);
    expect(userPut.Item.role).toBe('user');
    expect(userPut.Item.text).toBe('hello there');
    expect(userPut.Item.ownerId).toBe('u-1');
    expect(typeof userPut.Item.ts).toBe('number');
    expect(userPut.Item.ttl).toBeUndefined();

    expect(assistantPut.Item.SK).toMatch(/^MSG#\d{13}#1#/);
    expect(assistantPut.Item.role).toBe('assistant');
    // Same millisecond prefix: the pair sorts together, user first.
    expect(assistantPut.Item.SK.slice(0, 18)).toBe(userPut.Item.SK.slice(0, 18));
    expect(userPut.Item.SK < assistantPut.Item.SK).toBe(true);

    const metaUpdate = send.mock.calls[2][0].input;
    expect(metaUpdate.Key).toEqual({ PK: 'USER#u-1', SK: 'CONV#dashboard:c_abc' });
    expect(metaUpdate.ConditionExpression).toContain('attribute_exists');
    expect(metaUpdate.UpdateExpression).toContain('ADD messageCount');
    expect(metaUpdate.ExpressionAttributeValues[':m']).toBe('cmid-1');
  });

  it('creates the meta (title from the first user text) when the conversation is new', async () => {
    send
      .mockResolvedValueOnce({}) // user message put
      .mockResolvedValueOnce({}) // assistant message put
      .mockRejectedValueOnce(conditionalFailure()) // meta update: row absent
      .mockResolvedValueOnce({}); // meta create

    const longFirst = 'x'.repeat(300);
    await persistTurn({
      ownerId: 'u-1',
      conversationId: 'dashboard:c_new',
      agentId: 'ops',
      userText: longFirst,
      assistantText: 'ok',
    });

    expect(send).toHaveBeenCalledTimes(4);
    const create = send.mock.calls[3][0].input;
    expect(create.ConditionExpression).toBe('attribute_not_exists(PK)');
    expect(create.Item).toMatchObject({
      PK: 'USER#u-1',
      SK: 'CONV#dashboard:c_new',
      conversationId: 'dashboard:c_new',
      ownerId: 'u-1',
      agentId: 'ops',
      messageCount: 2,
    });
    // firstMessage convention: 120 chars.
    expect(create.Item.title).toBe(longFirst.slice(0, 120));
    expect(create.Item.ttl).toBeUndefined();
  });

  it('retries the update once when the create races another writer', async () => {
    send
      .mockResolvedValueOnce({}) // user put
      .mockResolvedValueOnce({}) // assistant put
      .mockRejectedValueOnce(conditionalFailure()) // update: absent
      .mockRejectedValueOnce(conditionalFailure()) // create: raced
      .mockResolvedValueOnce({}); // update again

    await persistTurn({
      ownerId: 'u-1',
      conversationId: 'dashboard:c_race',
      agentId: 'main',
      userText: 'hi',
      assistantText: 'yo',
    });

    expect(send).toHaveBeenCalledTimes(5);
    expect(send.mock.calls[4][0].input.ConditionExpression).toContain('attribute_exists');
  });
});

describe('deleteConversationData', () => {
  it('deletes every message and the owner meta row', async () => {
    send
      .mockResolvedValueOnce({
        Items: [
          { PK: 'CONV#dashboard:c_abc', SK: 'MSG#0000000000001#0#a', ownerId: 'u-1' },
          { PK: 'CONV#dashboard:c_abc', SK: 'MSG#0000000000001#1#b', ownerId: 'u-1' },
        ],
      }) // key query
      .mockResolvedValueOnce({}) // batch delete
      .mockResolvedValueOnce({}); // meta delete

    const out = await deleteConversationData('dashboard:c_abc');

    expect(out).toEqual({ messagesDeleted: 2, metaDeleted: true });
    const batch = send.mock.calls[1][0].input;
    const requests = batch.RequestItems['claudeclaw-sessions'];
    expect(requests).toHaveLength(2);
    expect(requests[0].DeleteRequest.Key.SK).toBe('MSG#0000000000001#0#a');
    const metaDelete = send.mock.calls[2][0].input;
    expect(metaDelete.Key).toEqual({ PK: 'USER#u-1', SK: 'CONV#dashboard:c_abc' });
  });

  it('is a no-op for a conversation with no messages', async () => {
    send.mockResolvedValueOnce({ Items: [] });
    const out = await deleteConversationData('dashboard:c_none');
    expect(out).toEqual({ messagesDeleted: 0, metaDeleted: false });
    expect(send).toHaveBeenCalledTimes(1);
  });
});
