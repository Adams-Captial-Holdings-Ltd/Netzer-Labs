/**
 * Integration test: P6's regenerate replace and conversation title/pin against a real
 * DynamoDB (Floci locally, LocalStack in CI).
 *
 * Written BEFORE the change, as the bar (netzar-chat-plan/p6-proof.sh rows I-1, I-2). The unit
 * tests' in-memory table applies no update expression and evaluates no compound or
 * transaction condition (P95), so the rules that live in those conditions are proved here:
 *   - regenerate's replace is ONE version-fenced transaction that overwrites the last reply's
 *     record in place: afterwards the history reads the new reply exactly once, every other
 *     record is untouched, and no record is added;
 *   - a rename bumps the conversation's version, so a writer that read the row BEFORE the
 *     rename is refused by the fence (appendTurns then re-reads) instead of writing the
 *     title away; a turn after the rename keeps the title and pin, and /newchat keeps them;
 *   - a rename or pin of a missing or foreign conversation writes nothing at all.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { ensureLocalStack, configureLocalAwsEnv, createDdbTable } from '../../__test-utils__/localstack.js';

const SESSIONS = 'claudeclaw-integ-p6-sessions';

beforeAll(async () => {
  configureLocalAwsEnv();
  process.env.TABLE_SESSIONS = SESSIONS;
  // Keep memory ingest inert: it would call Bedrock, which is not emulated here.
  process.env.BEDROCK_HAIKU_MODEL = 'integ-noop';
  await ensureLocalStack();
  await createDdbTable({ name: SESSIONS, partitionKey: { name: 'PK', type: 'S' }, sortKey: { name: 'SK', type: 'S' } });
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

async function records(chatId: string): Promise<Record<string, unknown>[]> {
  const out = await (await client()).send(
    new QueryCommand({
      TableName: SESSIONS,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :p)',
      ExpressionAttributeValues: { ':pk': 'AGENT#main', ':p': `CHAT#${chatId}#MSG#` },
      ConsistentRead: true,
    }),
  );
  return (out.Items ?? []).sort((a, b) => Number(a.seq) - Number(b.seq));
}

async function twoExchanges(chatId: string) {
  const { appendTurns } = await repo();
  await appendTurns('main', chatId, [
    { role: 'user', text: 'Who wrote the Q3 plan?', ts: 100 },
    { role: 'assistant', text: 'The finance team.', ts: 101 },
  ], undefined, PERSON);
  await appendTurns('main', chatId, [
    { role: 'user', text: 'What is 2+2?', ts: 200 },
    { role: 'assistant', text: 'Five.', ts: 201 },
  ], undefined, PERSON);
}

describe('P6 on DynamoDB — regenerate replace and conversation title and pin', () => {
  it('P6 on Floci a replaced reply reads back once and every other record stays', async () => {
    const { replaceLastReply, getSession, getFullHistory } = await repo();
    const chat = 'dashboard:p6-replace';
    await twoExchanges(chat);
    const before = await records(chat);
    const rowBefore = (await row(chat))!;

    expect(await replaceLastReply('main', chat, { role: 'assistant', text: 'Four.', ts: 300 })).toBe(true);

    const after = await records(chat);
    expect(after).toHaveLength(4);
    expect(after.slice(0, 3)).toEqual(before.slice(0, 3));
    expect(after[3]).toMatchObject({ SK: before[3]!.SK, seq: 3, role: 'assistant', text: 'Four.', userId: OWNER });
    const rowAfter = (await row(chat))!;
    expect(rowAfter.turnsTotal).toBe(rowBefore.turnsTotal);
    expect(rowAfter.version).toBe(Number(rowBefore.version) + 1);

    const session = (await getSession('main', chat))!;
    const { turns } = await getFullHistory('main', chat, session);
    expect(turns.map((t) => t.text)).toEqual(['Who wrote the Q3 plan?', 'The finance team.', 'What is 2+2?', 'Four.']);

    // The next turn still numbers after the four: nothing was added and nothing was taken.
    const { appendTurns } = await repo();
    await appendTurns('main', chat, [
      { role: 'user', text: 'And 3+3?', ts: 400 },
      { role: 'assistant', text: 'Six.', ts: 401 },
    ], undefined, PERSON);
    expect((await records(chat)).map((r) => r.seq)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('P6 on Floci a rename racing a turn keeps both', async () => {
    const { setConversationMeta, appendTurns, clearSession } = await repo();
    const chat = 'dashboard:p6-race';
    await twoExchanges(chat);
    const read = (await row(chat))!; // what a turn in flight read before the rename

    expect(await setConversationMeta('main', chat, OWNER, { title: 'Budget review', pinned: true })).toBe(true);
    const renamed = (await row(chat))!;
    expect(renamed).toMatchObject({ title: 'Budget review', pinned: true });
    expect(renamed.version).toBe(Number(read.version) + 1);

    // A writer still holding the pre-rename row is refused by the version fence, exactly as
    // appendTurns' own write would be (it then re-reads and merges).
    const stale = (await client()).send(new TransactWriteCommand({ TransactItems: [{
      Put: {
        TableName: SESSIONS,
        Item: { ...read, version: Number(read.version) + 1 },
        ConditionExpression: '#v = :v',
        ExpressionAttributeNames: { '#v': 'version' },
        ExpressionAttributeValues: { ':v': read.version },
      },
    }] }));
    await expect(stale).rejects.toMatchObject({ name: 'TransactionCanceledException' });
    expect(await row(chat)).toMatchObject({ title: 'Budget review', pinned: true });

    // A turn after the rename keeps the title and the pin; so does /newchat.
    await appendTurns('main', chat, [
      { role: 'user', text: 'And 3+3?', ts: 300 },
      { role: 'assistant', text: 'Six.', ts: 301 },
    ], undefined, PERSON);
    expect(await row(chat)).toMatchObject({ title: 'Budget review', pinned: true });
    await clearSession('main', chat);
    expect(await row(chat)).toMatchObject({ title: 'Budget review', pinned: true, turns: [] });

    // An empty title clears it; the pin is its own switch.
    expect(await setConversationMeta('main', chat, OWNER, { title: null, pinned: false })).toBe(true);
    const cleared = (await row(chat))!;
    expect(cleared.title).toBeUndefined();
    expect(cleared.pinned === undefined || cleared.pinned === false).toBe(true);
  });

  it('P6 on Floci renaming a missing or foreign conversation writes nothing', async () => {
    const { setConversationMeta } = await repo();
    expect(await setConversationMeta('main', 'dashboard:p6-missing', OWNER, { title: 'Ghost' })).toBe(false);
    expect(await row('dashboard:p6-missing')).toBeUndefined();

    const chat = 'dashboard:p6-foreign';
    await twoExchanges(chat);
    const before = (await row(chat))!;
    expect(await setConversationMeta('main', chat, 'dashboard:user:someone-else', { title: 'Mine now', pinned: true })).toBe(false);
    expect(await row(chat)).toEqual(before);
  });
});
