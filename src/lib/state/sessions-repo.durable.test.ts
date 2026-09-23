import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * P1 — the durable transcript, at the repository.
 *
 * Driven against a small in-memory stand-in for DynamoDB that keeps rows by
 * PK+SK and answers the command shapes sessions-repo sends, so a sequence of
 * appends can be followed end to end: what the window holds, what each message
 * record holds, and what a delete leaves behind. Condition expressions are NOT
 * evaluated here — the version fence and the immutability conditions are proved
 * against Floci in sessions-repo.integration.test.ts, where DynamoDB's own
 * semantics apply.
 */

const { send, ingestEvictedTurns } = vi.hoisted(() => ({
  send: vi.fn(),
  ingestEvictedTurns: vi.fn(),
}));

vi.mock('./ddb.js', async (importActual) => {
  const actual = await importActual<typeof import('./ddb.js')>();
  return { ...actual, ddb: () => ({ send }) };
});
vi.mock('./runtime-config-repo.js', () => ({ getConfig: async () => undefined }));
vi.mock('../../agent/memory-ingest.js', () => ({
  ingestEvictedTurns: (a: unknown) => ingestEvictedTurns(a),
}));

import { appendTurns, type Turn } from './sessions-repo.js';

type Row = Record<string, unknown>;
const store = new Map<string, Row>();
const keyOf = (k: Row) => `${String(k.PK)}|${String(k.SK)}`;

function applyWrite(t: { Put?: { Item: Row }; Delete?: { Key: Row } }) {
  if (t.Put) store.set(keyOf(t.Put.Item), t.Put.Item);
  if (t.Delete) store.delete(keyOf(t.Delete.Key));
}

beforeEach(() => {
  store.clear();
  send.mockReset();
  ingestEvictedTurns.mockReset();
  send.mockImplementation(async (cmd: { constructor: { name: string }; input: Record<string, any> }) => {
    const input = cmd.input;
    switch (cmd.constructor.name) {
      case 'GetCommand':
        return { Item: store.get(keyOf(input.Key)) };
      case 'PutCommand':
        applyWrite({ Put: { Item: input.Item } });
        return {};
      case 'TransactWriteCommand':
        for (const t of input.TransactItems) applyWrite(t);
        return {};
      case 'DeleteCommand':
        applyWrite({ Delete: { Key: input.Key } });
        return {};
      case 'BatchWriteCommand':
        for (const reqs of Object.values(input.RequestItems) as Array<Array<{ DeleteRequest?: { Key: Row } }>>) {
          for (const r of reqs) if (r.DeleteRequest) applyWrite({ Delete: { Key: r.DeleteRequest.Key } });
        }
        return {};
      case 'QueryCommand': {
        const v = input.ExpressionAttributeValues as Record<string, string>;
        const items = [...store.values()]
          .filter((i) => i.PK === v[':pk'] && String(i.SK).startsWith(v[':prefix'] ?? ''))
          .sort((a, b) => String(a.SK).localeCompare(String(b.SK)));
        return { Items: items };
      }
      default:
        throw new Error(`unexpected command ${cmd.constructor.name}`);
    }
  });
});

const AGENT = 'main';
const CHAT = 'dashboard:1750000000000';
const turn = (role: Turn['role'], text: string, ts = 1): Turn => ({ role, text, ts });

/** The conversation row as it is stored now. */
const conversation = (chatId = CHAT) => store.get(`AGENT#${AGENT}|CHAT#${chatId}`);

describe('appendTurns — the owner is stamped once (WI-1.1, A131)', () => {
  it('stamps the owner on a new conversation', async () => {
    await appendTurns(AGENT, CHAT, [turn('user', 'hi'), turn('assistant', 'hello')], undefined, {
      surface: 'dashboard',
      userId: 'dashboard:user:user-a',
    });

    expect(conversation()?.userId).toBe('dashboard:user:user-a');
  });

  it('keeps the stored owner when a later append names someone else', async () => {
    // The route refuses a non-owner before it gets here. This is the second
    // line: even a caller that reached appendTurns cannot re-own the row, which
    // is the link in the takeover chain that the route check alone left open.
    await appendTurns(AGENT, CHAT, [turn('user', 'hi'), turn('assistant', 'hello')], undefined, {
      surface: 'dashboard',
      userId: 'dashboard:user:user-a',
    });
    await appendTurns(AGENT, CHAT, [turn('user', 'mine now'), turn('assistant', 'no')], undefined, {
      surface: 'dashboard',
      userId: 'dashboard:user:user-b',
    });

    expect(conversation()?.userId).toBe('dashboard:user:user-a');
  });
});

describe('appendTurns — durable or not (owner decision 1)', () => {
  it('keeps a person\'s dashboard conversation durable: no ttl at all', async () => {
    await appendTurns(AGENT, CHAT, [turn('user', 'hi'), turn('assistant', 'hello')], undefined, {
      surface: 'dashboard',
      userId: 'dashboard:user:user-a',
      ephemeral: false,
    });

    expect(conversation()).not.toHaveProperty('ttl');
  });

  it('gives a dashboard conversation with no person behind it the expiring ttl', async () => {
    await appendTurns(AGENT, CHAT, [turn('user', 'hi'), turn('assistant', 'hello')], undefined, {
      surface: 'dashboard',
      userId: 'dashboard:hash-operator',
      ephemeral: true,
    });

    const ttl = conversation()?.ttl as number;
    const now = Math.floor(Date.now() / 1000);
    expect(ttl).toBeGreaterThan(now);
    expect(ttl).toBeLessThanOrEqual(now + 7 * 24 * 60 * 60);
  });
});
