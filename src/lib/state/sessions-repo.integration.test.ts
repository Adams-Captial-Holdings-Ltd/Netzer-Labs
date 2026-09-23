/**
 * Integration test: conversation persistence against a real DynamoDB.
 *
 * The whole feature rests on one claim about DynamoDB: TTL only deletes items
 * that CARRY the ttl attribute, so a persistent conversation is one where the
 * attribute is absent — not one with a far-future value. That is documented AWS
 * behaviour, but it is load-bearing enough to prove rather than assume, and a
 * unit test against a mock would only re-assert what the mock was told.
 *
 * Also covers the trap that makes this easy to get wrong: THREE code paths
 * write the ttl (appendTurns, setModelOverride, clearSession). Missing any one
 * silently re-arms the 7-day expiry on a conversation the user can see listed.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import {
  ensureLocalStack,
  configureLocalAwsEnv,
  createDdbTable,
} from '../../__test-utils__/localstack.js';

const TABLE = 'claudeclaw-integ-sessions';

beforeAll(async () => {
  configureLocalAwsEnv();
  process.env.TABLE_SESSIONS = TABLE;
  // Keep memory ingest inert: it would call Bedrock, which is not emulated here.
  process.env.BEDROCK_HAIKU_MODEL = 'integ-noop';
  await ensureLocalStack();
  await createDdbTable({
    name: TABLE,
    partitionKey: { name: 'PK', type: 'S' },
    sortKey: { name: 'SK', type: 'S' },
  });
});

async function loadRepo(): Promise<typeof import('./sessions-repo.js')> {
  return await import('./sessions-repo.js');
}

/** Read the raw item so we can assert on attribute PRESENCE, not just value. */
async function rawItem(agentId: string, chatId: string): Promise<Record<string, unknown> | undefined> {
  const { ddb } = await import('./ddb.js');
  const out = await ddb().send(
    new GetCommand({ TableName: TABLE, Key: { PK: `AGENT#${agentId}`, SK: `CHAT#${chatId}` } }),
  );
  return out.Item;
}

const TURNS = [
  { role: 'user' as const, text: 'hello', ts: 1 },
  { role: 'assistant' as const, text: 'hi', ts: 2 },
];

/**
 * A dashboard turn, as every dashboard route sends one since P1: it says who is
 * sending (conversationOwner). Whether a dashboard conversation lasts is settled
 * by whoever creates it — a person's lasts — so a turn that says nothing starts
 * one that expires (owner decisions 1 and 46).
 */
const PERSON = { surface: 'dashboard' as const, userId: 'dashboard:user:integ', ephemeral: false };

describe('conversation persistence (real DynamoDB)', () => {
  it('appendTurns writes NO ttl attribute for a dashboard chat', async () => {
    const repo = await loadRepo();
    await repo.appendTurns('a1', 'dashboard:1001', TURNS, undefined, PERSON);

    const item = await rawItem('a1', 'dashboard:1001');
    expect(item).toBeDefined();
    expect(item).not.toHaveProperty('ttl');
    // The row is otherwise intact — this is persistence, not a dropped write.
    expect((item?.turns as unknown[]).length).toBe(2);
  });

  it('appendTurns still writes a ttl for a bot chat', async () => {
    const repo = await loadRepo();
    await repo.appendTurns('a1', 'slack:C123', TURNS, undefined, { surface: 'slack' });

    const item = await rawItem('a1', 'slack:C123');
    expect(item).toHaveProperty('ttl');
    expect(typeof item?.ttl).toBe('number');
    expect(item?.ttl as number).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('never turns an expiring dashboard conversation durable, whoever continues it', async () => {
    // This used to strip a ttl left on a dashboard row by the code that ran before
    // dashboard conversations persisted (f132a9c). That code left staging and
    // production on 2026-08-13 and 2026-08-14, so every such ttl has long since
    // expired or been stripped. Since P1 a dashboard row carries a ttl only because
    // a principal with no person started it, and that is settled when it is
    // created: turning it durable later would also leave its first records to
    // expire under it (the P1 critic's NEW-2).
    const { ddb } = await import('./ddb.js');
    const { PutCommand } = await import('@aws-sdk/lib-dynamodb');
    await ddb().send(
      new PutCommand({
        TableName: TABLE,
        Item: {
          PK: 'AGENT#a2',
          SK: 'CHAT#dashboard:2002',
          turns: [],
          ttl: Math.floor(Date.now() / 1000) + 999,
        },
      }),
    );
    expect(await rawItem('a2', 'dashboard:2002')).toHaveProperty('ttl');

    const repo = await loadRepo();
    await repo.appendTurns('a2', 'dashboard:2002', TURNS, undefined, PERSON);

    expect(await rawItem('a2', 'dashboard:2002')).toHaveProperty('ttl');
  });

  it('setModelOverride does not re-arm expiry on a dashboard chat', async () => {
    const repo = await loadRepo();
    await repo.appendTurns('a3', 'dashboard:3003', TURNS, undefined, PERSON);
    await repo.setModelOverride('a3', 'dashboard:3003', 'some.model.id');

    const item = await rawItem('a3', 'dashboard:3003');
    expect(item?.modelOverride).toBe('some.model.id');
    expect(item).not.toHaveProperty('ttl');
  });

  it('setModelOverride still refreshes expiry on a bot chat', async () => {
    const repo = await loadRepo();
    await repo.appendTurns('a3', 'slack:C999', TURNS, undefined, { surface: 'slack' });
    await repo.setModelOverride('a3', 'slack:C999', 'some.model.id');

    const item = await rawItem('a3', 'slack:C999');
    expect(item?.modelOverride).toBe('some.model.id');
    expect(item).toHaveProperty('ttl');
  });

  it('clearSession does not re-arm expiry on a dashboard chat', async () => {
    const repo = await loadRepo();
    await repo.appendTurns('a4', 'dashboard:4004', TURNS, undefined, PERSON);
    await repo.clearSession('a4', 'dashboard:4004');

    const item = await rawItem('a4', 'dashboard:4004');
    expect(item?.turns).toEqual([]);
    expect(item).not.toHaveProperty('ttl');
  });

  it('clearSession still refreshes expiry on a bot chat', async () => {
    const repo = await loadRepo();
    await repo.appendTurns('a4', '987654321', TURNS, undefined, { surface: 'telegram' });
    await repo.clearSession('a4', '987654321');

    const item = await rawItem('a4', '987654321');
    expect(item).toHaveProperty('ttl');
  });
});
