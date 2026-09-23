import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeDynamo } from '../../__test-utils__/fake-dynamo.js';

/**
 * P1 — the durable transcript, at the repository.
 *
 * Driven against an in-memory stand-in for DynamoDB (src/__test-utils__/
 * fake-dynamo.ts) so a sequence of appends can be followed end to end: what the
 * replay window holds, what each message record holds, what a delete leaves.
 * Condition expressions are NOT evaluated there; the version fence and the
 * all-or-nothing transaction are proved against Floci in
 * sessions-repo.integration.test.ts.
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

import {
  appendTurns,
  clearSession,
  deleteSession,
  getFullHistory,
  getSession,
  type Turn,
} from './sessions-repo.js';

let table: ReturnType<typeof createFakeDynamo>;

beforeEach(() => {
  table = createFakeDynamo();
  send.mockReset();
  ingestEvictedTurns.mockReset();
  send.mockImplementation(table.send);
});

const AGENT = 'main';
const CHAT = 'dashboard:1750000000000';
const turn = (role: Turn['role'], text: string, ts = 1): Turn => ({ role, text, ts });
const PERSON = { surface: 'dashboard' as const, userId: 'dashboard:user:user-a', ephemeral: false };

/** The stored conversation row. */
const conversation = (chatId = CHAT) => table.rows.get(`AGENT#${AGENT}|CHAT#${chatId}`);

/** Every per-message record of a conversation, in key order. */
const records = (chatId = CHAT) =>
  [...table.rows.values()]
    .filter((r) => r.PK === `AGENT#${AGENT}` && String(r.SK).startsWith(`CHAT#${chatId}#MSG#`))
    .sort((a, b) => String(a.SK).localeCompare(String(b.SK)));

/** Append `n` question/answer exchanges, one appendTurns call each. */
async function exchanges(n: number, chatId = CHAT, from = 1) {
  for (let i = from; i < from + n; i++) {
    await appendTurns(AGENT, chatId, [turn('user', `q${i}`, i), turn('assistant', `a${i}`, i)], undefined, PERSON);
  }
}

describe('appendTurns — the owner is stamped once (WI-1.1, A131)', () => {
  it('stamps the owner on a new conversation', async () => {
    await exchanges(1);

    expect(conversation()?.userId).toBe('dashboard:user:user-a');
  });

  it('keeps the stored owner when a later append names someone else', async () => {
    // The route refuses a non-owner before it gets here. This is the second
    // line: even a caller that reached appendTurns cannot re-own the row, which
    // is the link in the takeover chain that the route check alone left open.
    await exchanges(1);
    await appendTurns(AGENT, CHAT, [turn('user', 'mine now'), turn('assistant', 'no')], undefined, {
      surface: 'dashboard',
      userId: 'dashboard:user:user-b',
    });

    expect(conversation()?.userId).toBe('dashboard:user:user-a');
  });
});

describe('appendTurns — durable or not (owner decision 1)', () => {
  it('keeps a person\'s dashboard conversation durable: no ttl at all', async () => {
    await exchanges(1);

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

describe('appendTurns — one record per message (WI-1.2, AC-1.2-1)', () => {
  it('writes a per-message record for each turn, keyed CHAT#<chatId>#MSG#<sequence>, carrying the owner', async () => {
    await exchanges(1);

    expect(records().map((r) => r.SK)).toEqual([
      `CHAT#${CHAT}#MSG#0000000000`,
      `CHAT#${CHAT}#MSG#0000000001`,
    ]);
    expect(records()[0]).toMatchObject({ role: 'user', text: 'q1', ts: 1, userId: 'dashboard:user:user-a' });
    expect(records()[1]).toMatchObject({ role: 'assistant', text: 'a1', userId: 'dashboard:user:user-a' });
  });

  it('continues the per-message sequence across appends', async () => {
    await exchanges(2);

    expect(records().map((r) => r.seq)).toEqual([0, 1, 2, 3]);
  });

  it('writes the conversation row and its per-message records in ONE transaction', async () => {
    // One all-or-nothing write means a turn can never be in the window without
    // its record, or the reverse — and the version fence guards both at once.
    await exchanges(1);

    const writes = send.mock.calls.map((c) => c[0].constructor.name).filter((n) => n !== 'GetCommand');
    expect(writes).toEqual(['TransactWriteCommand']);
    const items = send.mock.calls.find((c) => c[0].constructor.name === 'TransactWriteCommand')?.[0].input
      .TransactItems as Array<{ Put: { Item: Record<string, unknown>; ConditionExpression?: string } }>;
    expect(items).toHaveLength(3);
    // Records are immutable once written.
    expect(items[1]?.Put.ConditionExpression).toBe('attribute_not_exists(SK)');
  });

  it('gives a per-message record the conversation\'s expiry when the conversation expires', async () => {
    await appendTurns(AGENT, 'slack:C01:U01', [turn('user', 'hi'), turn('assistant', 'yo')], undefined, {
      surface: 'slack',
      userId: 'U01',
    });

    const ttl = conversation('slack:C01:U01')?.ttl;
    expect(ttl).toBeTypeOf('number');
    expect(records('slack:C01:U01').map((r) => r.ttl)).toEqual([ttl, ttl]);
  });

  it('gives a durable conversation\'s per-message records no expiry at all', async () => {
    await exchanges(1);

    // Two records must exist first, or the loop below passes on none (M41).
    expect(records()).toHaveLength(2);
    for (const r of records()) expect(r).not.toHaveProperty('ttl');
  });

  it('caps a per-message record below DynamoDB\'s item limit and says so', async () => {
    const huge = 'x'.repeat(500_000);
    await appendTurns(AGENT, CHAT, [turn('user', 'big'), turn('assistant', huge)], undefined, PERSON);

    const stored = records()[1]!;
    expect(Buffer.byteLength(String(stored.text), 'utf8')).toBeLessThanOrEqual(350_000);
    expect(stored.truncated).toBe(true);
    expect(records()[0]).not.toHaveProperty('truncated');
  });
});

describe('the replay window and the durable record (WI-1.2, AC-1.2-2/-3)', () => {
  it('a turn evicted from the replay window is still readable from its own record', async () => {
    // 11 exchanges = 22 turns. The window keeps the newest 20, so q1/a1 are
    // evicted from it — and must still be in the durable history.
    await exchanges(11);

    const session = await getSession(AGENT, CHAT);
    expect(session?.turns).toHaveLength(20);
    expect(session?.turns.map((t) => t.text)).not.toContain('q1');

    const history = await getFullHistory(AGENT, CHAT, session!);
    expect(history.turns).toHaveLength(22);
    expect(history.turns.slice(0, 2).map((t) => t.text)).toEqual(['q1', 'a1']);
    expect(history.truncated).toBe(false);
  });

  it('the memory-ingest evict backstop still fires once turns are per-message records', async () => {
    // Stop evicting, and decideIngest's backstop never fires, so long-term
    // memory quietly stops being written. Keep destroying the evicted turn, and
    // there is no durable history. Both halves are checked here.
    table.rows.set(`AGENT#${AGENT}|CHAT#${CHAT}`, {
      PK: `AGENT#${AGENT}`,
      SK: `CHAT#${CHAT}`,
      turns: Array.from({ length: 20 }, (_, i) => turn(i % 2 ? 'assistant' : 'user', `old${i}`)),
      turnsTotal: 20,
      turnsIngested: 19,
      userId: PERSON.userId,
      version: 1,
    });

    await appendTurns(AGENT, CHAT, [turn('user', 'q21'), turn('assistant', 'a21')], undefined, PERSON);

    expect(ingestEvictedTurns).toHaveBeenCalledTimes(1);
    const evicted = (ingestEvictedTurns.mock.calls[0]?.[0] as { evicted: Turn[] }).evicted;
    expect(evicted.map((t) => t.text)).toEqual(['old19', 'q21', 'a21']);
    expect(records().map((r) => r.text)).toEqual(['q21', 'a21']);
  });
});

describe('full history (WI-1.3, AC-1.3-1)', () => {
  // These two pass against a window-only reader by design: they guard the
  // OTHER direction — a reader built only from records would silently drop
  // every turn written before P1, which exists nowhere but the window (P84).
  it('merges a pre-P1 window, which has no records, with the records written since', async () => {
    // A conversation written before P1 holds its turns ONLY in the window.
    table.rows.set(`AGENT#${AGENT}|CHAT#${CHAT}`, {
      PK: `AGENT#${AGENT}`,
      SK: `CHAT#${CHAT}`,
      turns: [turn('user', 'legacy-q'), turn('assistant', 'legacy-a')],
      userId: PERSON.userId,
    });

    await appendTurns(AGENT, CHAT, [turn('user', 'new-q'), turn('assistant', 'new-a')], undefined, PERSON);

    const session = await getSession(AGENT, CHAT);
    const history = await getFullHistory(AGENT, CHAT, session!);
    expect(history.turns.map((t) => t.text)).toEqual(['legacy-q', 'legacy-a', 'new-q', 'new-a']);
  });

  it('repairs an empty stored message on read, as the window already is', async () => {
    await appendTurns(AGENT, CHAT, [turn('user', 'make a pdf'), turn('assistant', '')], undefined, PERSON);

    const history = await getFullHistory(AGENT, CHAT, (await getSession(AGENT, CHAT))!);
    expect(history.turns[1]?.text).toBe('(no response)');
  });
});

describe('/newchat keeps the durable record (WI-1.2)', () => {
  // The fake does not apply update expressions, so this pins the command; the
  // append → /newchat → append sequence itself runs against Floci in
  // sessions-repo.integration.test.ts.
  it('empties the window without resetting the counter the per-message sequence is built on', async () => {
    await exchanges(1);
    await clearSession(AGENT, CHAT);

    const update = send.mock.calls.map((c) => c[0]).find((c) => c.constructor.name === 'UpdateCommand')
      ?.input as { UpdateExpression: string };
    expect(update.UpdateExpression).toMatch(/turns = :empty/);
    // Resetting turnsTotal to 0 would make the next message reuse sequence 0,
    // whose record already exists, and the append would fail forever.
    expect(update.UpdateExpression).not.toMatch(/turnsTotal\s*=/);
  });
});

describe('chat ids never carry a # into a key (owner decision 47)', () => {
  it('stores a chat id\'s # as _, and finds it again by the id it was given', async () => {
    await exchanges(1, 'dashboard:a#MSG#0000000000');

    expect(table.rows.has(`AGENT#${AGENT}|CHAT#dashboard:a_MSG_0000000000`)).toBe(true);
    expect([...table.rows.keys()].some((k) => k.includes('dashboard:a#'))).toBe(false);
    expect(await getSession(AGENT, 'dashboard:a#MSG#0000000000')).not.toBeNull();
  });
});

describe('delete cascades (WI-1.3, AC-1.3-2)', () => {
  it('removes the conversation and every one of its records, and nothing else', async () => {
    await exchanges(3);
    await exchanges(2, 'dashboard:other');

    await deleteSession(AGENT, CHAT);

    expect(conversation()).toBeUndefined();
    expect(records()).toHaveLength(0);
    // The neighbour in the same partition is untouched.
    expect(conversation('dashboard:other')).toBeDefined();
    expect(records('dashboard:other')).toHaveLength(4);
  });

  it('deletes the records BEFORE the conversation row, so a failure leaves something to retry', async () => {
    await exchanges(1);
    const real = table.send;
    send.mockImplementation(async (cmd: { constructor: { name: string } }) => {
      if (cmd.constructor.name === 'BatchWriteCommand') throw new Error('throttled');
      return real(cmd as never);
    });

    await expect(deleteSession(AGENT, CHAT)).rejects.toThrow('throttled');
    expect(conversation()).toBeDefined();
  });
});
