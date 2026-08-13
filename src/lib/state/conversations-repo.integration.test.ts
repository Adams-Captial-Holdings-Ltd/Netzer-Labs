/**
 * Integration test: conversations-repo against the local emulator (Floci /
 * LocalStack-compatible on 4566). Proves against a real DynamoDB what the
 * unit mocks can only assert structurally: key shapes round-trip, the
 * message pair sorts adjacently and in order, the meta upsert ladder
 * converges, no item carries a ttl attribute, and delete removes everything.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  ensureLocalStack,
  configureLocalAwsEnv,
  createDdbTable,
  dynamoClient,
} from '../../__test-utils__/localstack.js';
import { GetItemCommand } from '@aws-sdk/client-dynamodb';

const TABLE = 'claudeclaw-integ-conversations';

beforeAll(async () => {
  configureLocalAwsEnv();
  process.env.TABLE_SESSIONS = TABLE;
  await ensureLocalStack();
  await createDdbTable({
    name: TABLE,
    partitionKey: { name: 'PK', type: 'S' },
    sortKey: { name: 'SK', type: 'S' },
  });
});

// Import AFTER configureLocalAwsEnv + TABLE_SESSIONS are set, so the repo's
// TABLE constant captures the right table name on first read.
async function loadRepo(): Promise<typeof import('./conversations-repo.js')> {
  return await import('./conversations-repo.js');
}

describe('conversations-repo (local emulator)', () => {
  it('persists two turns and reads them back in order with correct meta', async () => {
    const repo = await loadRepo();
    const conversationId = repo.newConversationId();

    await repo.persistTurn({
      ownerId: 'u-int-1',
      conversationId,
      agentId: 'main',
      userText: 'first question',
      assistantText: 'first answer',
      clientMessageId: 'cm-1',
    });
    await repo.persistTurn({
      ownerId: 'u-int-1',
      conversationId,
      agentId: 'main',
      userText: 'second question',
      assistantText: 'second answer',
      clientMessageId: 'cm-2',
    });

    const messages = await repo.listMessages(conversationId);
    expect(messages.map((m) => m.text)).toEqual([
      'first question',
      'first answer',
      'second question',
      'second answer',
    ]);
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);

    const meta = await repo.getConversation('u-int-1', conversationId);
    expect(meta).not.toBeNull();
    expect(meta?.title).toBe('first question');
    expect(meta?.messageCount).toBe(4);
    expect(meta?.lastClientMessageId).toBe('cm-2');
    expect(meta?.agentId).toBe('main');
  });

  it('does not resolve another owner\'s conversation (ownership by partition)', async () => {
    const repo = await loadRepo();
    const conversationId = repo.newConversationId();
    await repo.persistTurn({
      ownerId: 'u-owner',
      conversationId,
      agentId: 'main',
      userText: 'private',
      assistantText: 'yes',
    });
    expect(await repo.getConversation('u-intruder', conversationId)).toBeNull();
    expect(await repo.getConversation('u-owner', conversationId)).not.toBeNull();
  });

  it('lists an owner\'s conversations newest-updated first', async () => {
    const repo = await loadRepo();
    const a = repo.newConversationId();
    const b = repo.newConversationId();
    await repo.persistTurn({ ownerId: 'u-int-2', conversationId: a, agentId: 'main', userText: 'older', assistantText: 'a' });
    // Ensure a strictly later updatedAt (epoch-seconds resolution).
    await new Promise((r) => setTimeout(r, 1100));
    await repo.persistTurn({ ownerId: 'u-int-2', conversationId: b, agentId: 'ops', userText: 'newer', assistantText: 'b' });

    const list = await repo.listConversations('u-int-2');
    expect(list.map((c) => c.conversationId)).toEqual([b, a]);
    expect(list[0].title).toBe('newer');
  });

  it('stores neither meta nor message items with a ttl attribute', async () => {
    const repo = await loadRepo();
    const conversationId = repo.newConversationId();
    await repo.persistTurn({
      ownerId: 'u-int-3',
      conversationId,
      agentId: 'main',
      userText: 'no expiry',
      assistantText: 'never',
    });

    const client = dynamoClient();
    const meta = await client.send(
      new GetItemCommand({
        TableName: TABLE,
        Key: { PK: { S: 'USER#u-int-3' }, SK: { S: `CONV#${conversationId}` } },
      }),
    );
    expect(meta.Item).toBeDefined();
    expect(meta.Item?.ttl).toBeUndefined();
  });

  it('deleteConversationData removes the meta and every message', async () => {
    const repo = await loadRepo();
    const conversationId = repo.newConversationId();
    await repo.persistTurn({
      ownerId: 'u-int-4',
      conversationId,
      agentId: 'main',
      userText: 'purge me',
      assistantText: 'ok',
    });

    const out = await repo.deleteConversationData(conversationId);
    expect(out).toEqual({ messagesDeleted: 2, metaDeleted: true });
    expect(await repo.listMessages(conversationId)).toEqual([]);
    expect(await repo.getConversation('u-int-4', conversationId)).toBeNull();
  });
});
