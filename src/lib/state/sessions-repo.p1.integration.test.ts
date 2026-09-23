/**
 * Integration test: P1's durable transcript against a real DynamoDB (Floci
 * locally, LocalStack in CI).
 *
 * The unit tests follow the same flows against an in-memory stand-in that does
 * NOT evaluate condition expressions. What only a real DynamoDB can prove is
 * here: that a conversation row and its message records land in ONE
 * all-or-nothing transaction, that a lost race re-reads instead of losing a
 * turn, that a taken sequence number fails the whole write, and that the
 * legacy migration's conditions hold.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { GetCommand, PutCommand, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import {
  ensureLocalStack,
  configureLocalAwsEnv,
  createDdbTable,
} from '../../__test-utils__/localstack.js';

const SESSIONS = 'claudeclaw-integ-p1-sessions';
const TOKENS = 'claudeclaw-integ-p1-tokens';

beforeAll(async () => {
  configureLocalAwsEnv();
  process.env.TABLE_SESSIONS = SESSIONS;
  process.env.TABLE_DASHBOARD_TOKENS = TOKENS;
  // Keep memory ingest inert: it would call Bedrock, which is not emulated here.
  process.env.BEDROCK_HAIKU_MODEL = 'integ-noop';
  await ensureLocalStack();
  for (const name of [SESSIONS, TOKENS]) {
    await createDdbTable({ name, partitionKey: { name: 'PK', type: 'S' }, sortKey: { name: 'SK', type: 'S' } });
  }
});

const repo = () => import('./sessions-repo.js');
const client = async () => (await import('./ddb.js')).ddb();
const PERSON = { surface: 'dashboard' as const, userId: 'dashboard:user:user-a', ephemeral: false };
const u = (text: string) => ({ role: 'user' as const, text, ts: 1 });
const a = (text: string) => ({ role: 'assistant' as const, text, ts: 1 });

async function row(agentId: string, chatId: string): Promise<Record<string, any> | undefined> {
  const out = await (await client()).send(
    new GetCommand({ TableName: SESSIONS, Key: { PK: `AGENT#${agentId}`, SK: `CHAT#${chatId}` }, ConsistentRead: true }),
  );
  return out.Item;
}

async function children(agentId: string, chatId: string): Promise<Record<string, any>[]> {
  const out = await (await client()).send(
    new QueryCommand({
      TableName: SESSIONS,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :p)',
      ExpressionAttributeValues: { ':pk': `AGENT#${agentId}`, ':p': `CHAT#${chatId}#` },
      ConsistentRead: true,
    }),
  );
  return out.Items ?? [];
}

const records = async (agentId: string, chatId: string) =>
  (await children(agentId, chatId)).filter((r) => String(r.SK).includes('#MSG#'));

describe('P1 durable transcript (real DynamoDB)', () => {
  it('two turns racing into one conversation both land, numbered without a gap or a clash', async () => {
    const r = await repo();
    await Promise.all([
      r.appendTurns('p1', 'dashboard:race', [u('q1'), a('a1')], undefined, PERSON),
      r.appendTurns('p1', 'dashboard:race', [u('q2'), a('a2')], undefined, PERSON),
    ]);

    const recs = await records('p1', 'dashboard:race');
    expect(recs.map((x) => x.seq)).toEqual([0, 1, 2, 3]);
    expect(new Set(recs.map((x) => x.text))).toEqual(new Set(['q1', 'a1', 'q2', 'a2']));
    const conv = await row('p1', 'dashboard:race');
    expect(conv?.turnsTotal).toBe(4);
    expect(conv?.turns).toHaveLength(4);
  });

  it('is all or nothing: a taken sequence number fails the whole write, window included', async () => {
    const r = await repo();
    await r.appendTurns('p1', 'dashboard:atomic', [u('q1'), a('a1')], undefined, PERSON);
    // Occupy sequence 2, the number the next message would take.
    await (await client()).send(new PutCommand({
      TableName: SESSIONS,
      Item: { PK: 'AGENT#p1', SK: 'CHAT#dashboard:atomic#MSG#0000000002', seq: 2, role: 'user', text: 'squatter' },
    }));

    await expect(r.appendTurns('p1', 'dashboard:atomic', [u('q2'), a('a2')], undefined, PERSON)).rejects.toThrow();

    const conv = await row('p1', 'dashboard:atomic');
    expect(conv?.turnsTotal).toBe(2);
    expect(conv?.turns.map((t: { text: string }) => t.text)).toEqual(['q1', 'a1']);
    expect((await records('p1', 'dashboard:atomic')).map((x) => x.text)).toEqual(['q1', 'a1', 'squatter']);
  });

  it('/newchat empties the window, keeps every record, and the sequence carries on', async () => {
    const r = await repo();
    await r.appendTurns('p1', 'dashboard:newchat', [u('q1'), a('a1')], undefined, PERSON);
    await r.clearSession('p1', 'dashboard:newchat');
    await r.appendTurns('p1', 'dashboard:newchat', [u('q2'), a('a2')], undefined, PERSON);

    expect((await records('p1', 'dashboard:newchat')).map((x) => [x.seq, x.text])).toEqual([
      [0, 'q1'], [1, 'a1'], [2, 'q2'], [3, 'a2'],
    ]);
    const session = await r.getSession('p1', 'dashboard:newchat');
    expect(session?.turns.map((t) => t.text)).toEqual(['q2', 'a2']);
    expect((await r.getFullHistory('p1', 'dashboard:newchat', session!)).turns.map((t) => t.text)).toEqual([
      'q1', 'a1', 'q2', 'a2',
    ]);
  });

  it('returns the whole history beyond the 20-turn window', async () => {
    const r = await repo();
    for (let i = 1; i <= 11; i++) {
      await r.appendTurns('p1', 'dashboard:long', [u(`q${i}`), a(`a${i}`)], undefined, PERSON);
    }
    const session = await r.getSession('p1', 'dashboard:long');
    expect(session?.turns).toHaveLength(20);

    const history = await r.getFullHistory('p1', 'dashboard:long', session!);
    expect(history.turns).toHaveLength(22);
    expect(history.turns[0]?.text).toBe('q1');
    expect(history.truncated).toBe(false);
  });

  it('gives records the conversation\'s expiry on an expiring chat and none on a durable one', async () => {
    const r = await repo();
    await r.appendTurns('p1', 'slack:C9:U9', [u('hi'), a('yo')], undefined, { surface: 'slack', userId: 'U9' });
    await r.appendTurns('p1', 'dashboard:keep', [u('hi'), a('yo')], undefined, PERSON);

    const ttl = (await row('p1', 'slack:C9:U9'))?.ttl;
    expect(typeof ttl).toBe('number');
    expect((await records('p1', 'slack:C9:U9')).map((x) => x.ttl)).toEqual([ttl, ttl]);
    for (const x of await records('p1', 'dashboard:keep')) expect(x).not.toHaveProperty('ttl');
  });

  it('deleteSession removes the conversation and every record, and leaves a neighbour alone', async () => {
    const r = await repo();
    for (let i = 1; i <= 3; i++) await r.appendTurns('p1', 'dashboard:del', [u(`q${i}`), a(`a${i}`)], undefined, PERSON);
    await r.appendTurns('p1', 'dashboard:del2', [u('q'), a('a')], undefined, PERSON);

    await r.deleteSession('p1', 'dashboard:del');

    expect(await row('p1', 'dashboard:del')).toBeUndefined();
    expect(await children('p1', 'dashboard:del')).toEqual([]);
    expect(await row('p1', 'dashboard:del2')).toBeDefined();
    expect(await records('p1', 'dashboard:del2')).toHaveLength(2);
  });
});

describe('P1 legacy migration (real DynamoDB)', () => {
  const HASH = { session: 'e'.repeat(64), linked: 'f'.repeat(64), none: '9'.repeat(64) };

  async function seed() {
    const c = await client();
    const token = (hash: string, extra: Record<string, unknown>) =>
      c.send(new PutCommand({
        TableName: TOKENS,
        Item: { PK: `TOKEN#${hash}`, SK: 'META', tokenHash: hash, label: 'l', createdAt: 'x', lastUsedAt: 'x', createdBy: 'system', active: true, role: 'admin', ...extra },
      }));
    await token(HASH.session, { userId: 'user-m', createdBy: 'user:user-m' });
    await token(HASH.linked, { linkedUserId: 'user-owner' });
    await token(HASH.none, { createdBy: 'dashboard:ops' });
    const legacy = (chatId: string, owner: string) =>
      c.send(new PutCommand({
        TableName: SESSIONS,
        Item: {
          PK: 'AGENT#mig', SK: `CHAT#${chatId}`, userId: owner, updatedAt: 1,
          turns: [{ role: 'user', text: `${chatId} q`, ts: 1 }, { role: 'assistant', text: `${chatId} a`, ts: 1 }],
        },
      }));
    await legacy('dashboard:m1', `dashboard:${HASH.session}`);
    await legacy('dashboard:m2', `dashboard:${HASH.linked}`);
    await legacy('dashboard:m3', `dashboard:${HASH.none}`);
  }

  async function partition(): Promise<string> {
    const out = await (await client()).send(new ScanCommand({ TableName: SESSIONS, ConsistentRead: true }));
    return JSON.stringify(
      (out.Items ?? []).filter((i) => i.PK === 'AGENT#mig').sort((x, y) => String(x.SK).localeCompare(String(y.SK))),
    );
  }

  it('maps, backfills and deletes as decided, only when applied, and only once', async () => {
    await seed();
    const { migrateLegacyConversations } = await import('./legacy-chat-migration.js');

    const before = await partition();
    const dry = await migrateLegacyConversations({ apply: false });
    expect(await partition()).toBe(before);
    expect(dry).toMatchObject({ mapped: { session: 1, link: 1 }, unprovable: { noPerson: 1 }, reowned: 0, deleted: 0 });

    const applied = await migrateLegacyConversations({ apply: true });
    expect(applied).toMatchObject({ reowned: 2, deleted: 1, backfilled: 4, failures: [] });

    const m1 = await row('mig', 'dashboard:m1');
    expect(m1?.userId).toBe('dashboard:user:user-m');
    expect(m1?.version).toBe(1);
    const m1Children = await children('mig', 'dashboard:m1');
    expect(m1Children.find((x) => String(x.SK).endsWith('#SRC'))).toMatchObject({
      legacyOwner: `dashboard:${HASH.session}`, provenBy: 'session',
    });
    expect(m1Children.filter((x) => String(x.SK).includes('#MSG#')).map((x) => x.text)).toEqual([
      'dashboard:m1 q', 'dashboard:m1 a',
    ]);
    expect((await row('mig', 'dashboard:m2'))?.userId).toBe('dashboard:user:user-owner');
    expect(await row('mig', 'dashboard:m3')).toBeUndefined();

    const afterFirst = await partition();
    const again = await migrateLegacyConversations({ apply: true });
    expect(await partition()).toBe(afterFirst);
    expect(again).toMatchObject({ legacy: 0, reowned: 0, deleted: 0 });
  });
});
