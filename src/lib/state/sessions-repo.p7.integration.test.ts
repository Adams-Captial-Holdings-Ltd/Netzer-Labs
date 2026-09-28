/**
 * P7 (step 9) — work order C against a real DynamoDB (Floci locally,
 * LocalStack in CI). Follows src/lib/state/sessions-repo.p6.integration.test.ts
 * (its table setup/cleanup and how its "rename racing a turn" test forces an
 * interleaving).
 *
 * Written BEFORE the change, as the bar (netzar-chat-plan/p7-proof.sh rows
 * E-3, L-4, N-2). The unit table double (fake-dynamo.ts) evaluates only a
 * lone key-existence condition on a standalone Put/Update (A170): not an OR,
 * not a comparison, not an update expression, not a transaction's
 * conditions. These rows prove the BEHAVIOUR the unit rows (sessions-repo.p7.
 * test.ts) can only pin the command shape and code paths for (P95):
 *   - E-3 (M1, council 3-0 dashboard_marker): a chat deleted while its reply
 *     is generating stays deleted — the in-flight save's marker check fails
 *     against the marker deleteSession purged, so it never re-creates the
 *     chat.
 *   - L-4 (M3, owner decision 67): a child lock's 15-minute lease from
 *     createdAt — a stale lock is taken over, a fresh one still refuses.
 *   - N-2 (A232, council 3-0 bump_rows): /newchat bumps the row's version, so
 *     a whole-row save that read the row before /newchat and writes after it
 *     fails its version fence, re-reads and applies on top — the stored
 *     history stays cleared.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DynamoDBClient, DeleteTableCommand } from '@aws-sdk/client-dynamodb';
import { GetCommand, PutCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { ensureLocalStack, configureLocalAwsEnv, createDdbTable } from '../../__test-utils__/localstack.js';

const SESSIONS = 'claudeclaw-integ-p7-sessions';

beforeAll(async () => {
  configureLocalAwsEnv();
  process.env.TABLE_SESSIONS = SESSIONS;
  // Keep memory ingest inert: it would call Bedrock, which is not emulated here.
  process.env.BEDROCK_HAIKU_MODEL = 'integ-noop';
  await ensureLocalStack();
  await createDdbTable({ name: SESSIONS, partitionKey: { name: 'PK', type: 'S' }, sortKey: { name: 'SK', type: 'S' } });
});

afterAll(async () => {
  const raw = new DynamoDBClient({
    endpoint: process.env.AWS_ENDPOINT_URL, region: process.env.AWS_REGION ?? 'us-east-1',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });
  await raw.send(new DeleteTableCommand({ TableName: SESSIONS })).catch(() => undefined);
});

const repo = () => import('./sessions-repo.js');
const client = async () => (await import('./ddb.js')).ddb();
const OWNER = 'dashboard:user:user-a';
const PERSON = { surface: 'dashboard' as const, userId: OWNER, ephemeral: false };

async function row(chatId: string): Promise<Record<string, unknown> | undefined> {
  const out = await (await client()).send(
    new GetCommand({ TableName: SESSIONS, Key: { PK: 'AGENT#main', SK: `CHAT#${chatId}` }, ConsistentRead: true }),
  );
  return out.Item;
}

async function lockRow(chatId: string): Promise<Record<string, unknown> | undefined> {
  const out = await (await client()).send(
    new GetCommand({ TableName: SESSIONS, Key: { PK: 'AGENT#main', SK: `CHAT#${chatId}#CHILD_LOCK` }, ConsistentRead: true }),
  );
  return out.Item;
}

describe('P7 on DynamoDB — delete mid-turn, the lock lease, and the version bump', () => {
  it('P7 on Floci a chat deleted while its reply is generating stays deleted', async () => {
    const { appendTurns, beginTurn, deleteSession, getSession } = await repo();
    const chat = 'dashboard:p7-e3-deleted-mid-turn';
    await appendTurns('main', chat, [
      { role: 'user', text: 'first question', ts: 100 },
      { role: 'assistant', text: 'first reply', ts: 101 },
    ], undefined, PERSON);
    const clientMessageId = 'e3-inflight-turn';
    expect(await beginTurn('main', chat, clientMessageId, 'e3-hash')).toEqual({ started: true });

    // The chat is deleted while that turn is still generating: its marker is
    // purged along with everything else the conversation owns.
    await deleteSession('main', chat);
    expect(await getSession('main', chat)).toBeNull();

    // The in-flight reply tries to save, naming the turn that started it.
    await expect(appendTurns('main', chat, [
      { role: 'user', text: 'first question', ts: 100 },
      { role: 'assistant', text: 'the reply that arrived too late', ts: 200 },
    ], undefined, { ...PERSON, requestId: clientMessageId }),
    'a save whose chat was deleted mid-turn must refuse, not recreate the chat').rejects.toThrow();

    // Deleted stays deleted.
    expect(await getSession('main', chat)).toBeNull();
  });

  it('P7 on Floci a stale child lock is taken over and a fresh one is not', async () => {
    const { acquireConversationChildLock } = await repo();
    const stale = 'dashboard:p7-l4-stale-lock';
    const fresh = 'dashboard:p7-l4-fresh-lock';
    // Seeded directly, the way a crashed process would leave a lock behind.
    await (await client()).send(new PutCommand({
      TableName: SESSIONS,
      Item: { PK: 'AGENT#main', SK: `CHAT#${stale}#CHILD_LOCK`, lockToken: 'old-token',
        createdAt: new Date(Date.now() - 16 * 60 * 1000).toISOString() },
    }));
    await (await client()).send(new PutCommand({
      TableName: SESSIONS,
      Item: { PK: 'AGENT#main', SK: `CHAT#${fresh}#CHILD_LOCK`, lockToken: 'fresh-token',
        createdAt: new Date(Date.now() - 60 * 1000).toISOString() },
    }));

    let release: (() => Promise<void>) | undefined;
    let error: unknown;
    try {
      release = await acquireConversationChildLock('main', stale);
    } catch (e) {
      error = e;
    }
    expect(error, 'a lock sixteen minutes old must be taken over, not refused as busy').toBeUndefined();
    expect((await lockRow(stale))?.lockToken).not.toBe('old-token');

    await expect(acquireConversationChildLock('main', fresh)).rejects.toThrow(/busy/i);
    expect((await lockRow(fresh))?.lockToken, 'a lock one minute old must still refuse').toBe('fresh-token');

    await release?.();
    expect(await lockRow(stale)).toBeUndefined();
    // The fresh lock was never acquired by this test; clean it up directly.
    await (await client()).send(new TransactWriteCommand({ TransactItems: [{
      Delete: { TableName: SESSIONS, Key: { PK: 'AGENT#main', SK: `CHAT#${fresh}#CHILD_LOCK` } },
    }] }));
  });

  it('P7 on Floci a reply saved after a new chat keeps the history cleared', async () => {
    const { appendTurns, clearSession } = await repo();
    const chat = 'dashboard:p7-n2-newchat-race';
    await appendTurns('main', chat, [
      { role: 'user', text: 'Old question', ts: 100 },
      { role: 'assistant', text: 'Old answer', ts: 101 },
    ], undefined, PERSON);
    const readBeforeNewchat = (await row(chat))!; // what a save in flight read before /newchat

    await clearSession('main', chat);

    // A save that read the row BEFORE /newchat and writes AFTER it is fenced
    // exactly like appendTurns' own version check — /newchat must have bumped
    // the version, or this stale write silently restores the old history.
    const stale = (await client()).send(new TransactWriteCommand({ TransactItems: [{
      Put: {
        TableName: SESSIONS,
        Item: { ...readBeforeNewchat, turns: [...(readBeforeNewchat.turns as unknown[]), { role: 'user', text: 'Stale question', ts: 150 }],
          version: Number(readBeforeNewchat.version ?? 0) + 1 },
        ConditionExpression: '#v = :v',
        ExpressionAttributeNames: { '#v': 'version' },
        ExpressionAttributeValues: { ':v': readBeforeNewchat.version },
      },
    }] }));
    await expect(stale, '/newchat must bump the version, fencing a save that read the row before it')
      .rejects.toMatchObject({ name: 'TransactionCanceledException' });
    expect(await row(chat)).toMatchObject({ turns: [] });

    // A real writer racing the same way re-reads and applies on top instead:
    // the history /newchat cleared does not come back.
    await appendTurns('main', chat, [
      { role: 'user', text: 'New question', ts: 200 },
      { role: 'assistant', text: 'New answer', ts: 201 },
    ], undefined, PERSON);
    const after = (await row(chat))!;
    expect((after.turns as Array<{ text: string }>).map((t) => t.text)).toEqual(['New question', 'New answer']);
  });
});
