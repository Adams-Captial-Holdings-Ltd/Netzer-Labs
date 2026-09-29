/**
 * Integration test: P2's turn records against a real DynamoDB (Floci locally,
 * LocalStack in CI).
 *
 * Written BEFORE the change, as the bar (netzar-chat-plan/p2-proof.sh rows D-5..D-7).
 * The plan's turn state machine (netzar-chat-plan.md:228, left to P2 by the P1 log
 * 6.8): a client-generated message id is the idempotency key; the turn record is
 * created ONCE, conditionally, before any model call, and reaches exactly one final
 * state. A retry with the same id must never start a second paid call, and an id
 * reused for a different message is refused. The unit tests' in-memory stand-in does
 * not evaluate update conditions (P95), so these rules are proved here.
 *
 * Record shape, pinned: PK `AGENT#<agentId>`, SK `CHAT#<chatId>#TURN#<clientMessageId>`
 * — a child of the conversation, so WI-1.0's containment predicate already hides it
 * from every list and P1's delete cascade already removes it — with a `ttl`, because
 * it only needs to outlive a retry, not the conversation.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ensureLocalStack, configureLocalAwsEnv, createDdbTable } from '../../__test-utils__/localstack.js';

const SESSIONS = 'claudeclaw-integ-p2-sessions';

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
const PERSON = { surface: 'dashboard' as const, userId: 'dashboard:user:user-a', ephemeral: false };

async function turnRecord(agentId: string, chatId: string, id: string): Promise<Record<string, unknown> | undefined> {
  const out = await (await client()).send(
    new GetCommand({
      TableName: SESSIONS,
      Key: { PK: `AGENT#${agentId}`, SK: `CHAT#${chatId}#TURN#${id}` },
      ConsistentRead: true,
    }),
  );
  return out.Item;
}

async function everything(agentId: string, chatId: string): Promise<Record<string, unknown>[]> {
  const out = await (await client()).send(
    new QueryCommand({
      TableName: SESSIONS,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :p)',
      ExpressionAttributeValues: { ':pk': `AGENT#${agentId}`, ':p': `CHAT#${chatId}` },
      ConsistentRead: true,
    }),
  );
  return out.Items ?? [];
}

describe('turn lifecycle (P2) — turn records on DynamoDB', () => {
  it('records exactly one final state per turn', async () => {
    const { beginTurn, endTurn } = await repo();
    const chat = 'dashboard:p2-final';

    expect(await beginTurn('main', chat, 'cm-1', 'fp-a')).toEqual({ started: true });
    const begun = await turnRecord('main', chat, 'cm-1');
    expect(begun).toMatchObject({ status: 'streaming', payloadHash: 'fp-a' });
    expect(typeof begun?.ttl).toBe('number');

    expect(await endTurn('main', chat, 'cm-1', 'complete')).toBe(true);
    // A second final state never overwrites the first.
    expect(await endTurn('main', chat, 'cm-1', 'stopped')).toBe(false);
    expect((await turnRecord('main', chat, 'cm-1'))?.status).toBe('complete');
  });

  it('refuses a repeated turn and names what it was', async () => {
    const { beginTurn, endTurn } = await repo();
    const chat = 'dashboard:p2-repeat';

    expect(await beginTurn('main', chat, 'cm-2', 'fp-a')).toEqual({ started: true });
    expect(await beginTurn('main', chat, 'cm-2', 'fp-a')).toEqual({ started: false, status: 'streaming', sameMessage: true });
    expect(await beginTurn('main', chat, 'cm-2', 'fp-b')).toEqual({ started: false, status: 'streaming', sameMessage: false });

    await endTurn('main', chat, 'cm-2', 'stopped');
    expect(await beginTurn('main', chat, 'cm-2', 'fp-a')).toEqual({ started: false, status: 'stopped', sameMessage: true });
  });

  it('removes turn records when the conversation is deleted', async () => {
    const { beginTurn, appendTurns, deleteSession } = await repo();
    const chat = 'dashboard:p2-delete';

    await appendTurns('main', chat, [
      { role: 'user', text: 'q', ts: 1 },
      { role: 'assistant', text: 'r', ts: 1 },
    ], undefined, PERSON);
    await beginTurn('main', chat, 'cm-3', 'fp-a');
    expect(await turnRecord('main', chat, 'cm-3')).toBeDefined();

    await deleteSession('main', chat);

    expect(await everything('main', chat)).toEqual([]);
  });
});
