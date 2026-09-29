import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeDynamo } from '../../__test-utils__/fake-dynamo.js';

/**
 * P1 — the durable transcript, at the repository.
 *
 * Driven against an in-memory stand-in for DynamoDB (src/__test-utils__/
 * fake-dynamo.ts) so a sequence of appends can be followed end to end: what the
 * replay window holds, what each message record holds, what a delete leaves.
 * Condition expressions are NOT evaluated there beyond a lone key-existence
 * check (see the fake); the version fence and the all-or-nothing transaction are
 * proved against Floci in sessions-repo.integration.test.ts and
 * sessions-repo.p1.integration.test.ts.
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
  setModelOverride,
  setWarroomMode,
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
const NO_PERSON = { surface: 'dashboard' as const, userId: 'dashboard:hash-root', ephemeral: true };

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

  it('never makes a durable conversation expire when a principal with no person continues it', async () => {
    // The master token's chats from before P1 are durable and owned by its hash.
    // Continued before the token is linked, an expiry here would drop them out of
    // the legacy migration, which skips expiring rows, and delete them a week
    // later (the first critic's F3).
    table.rows.set(`AGENT#${AGENT}|CHAT#${CHAT}`, {
      PK: `AGENT#${AGENT}`,
      SK: `CHAT#${CHAT}`,
      userId: 'dashboard:hash-root',
      turns: [turn('user', 'old q'), turn('assistant', 'old a')],
      turnsTotal: 2,
    });

    await appendTurns(AGENT, CHAT, [turn('user', 'q'), turn('assistant', 'a')], undefined, NO_PERSON);

    expect(conversation()?.turns).toHaveLength(4);
    expect(conversation()).not.toHaveProperty('ttl');
    expect(records()).toHaveLength(2);
    for (const r of records()) expect(r).not.toHaveProperty('ttl');
  });

  it('never lets a writer that cannot say who is sending — a scheduled task — make an expiring conversation durable', async () => {
    // scheduler.ts and queue-drain.ts append with no enrichment at all. A dashboard
    // chat with no ephemeral flag used to count as durable, so the first scheduled
    // reply made a person-less principal's chat permanent (the second critic's NEW-3).
    await appendTurns(AGENT, CHAT, [turn('user', 'q'), turn('assistant', 'a')], undefined, NO_PERSON);

    await appendTurns(AGENT, CHAT, [turn('user', '[scheduled] q'), turn('assistant', 'a')]);

    expect(conversation()?.ttl).toEqual(expect.any(Number));
    expect(conversation()?.userId).toBe('dashboard:hash-root');
    expect(records()).toHaveLength(4);
    for (const r of records()) expect(r.ttl).toEqual(expect.any(Number));
  });

  it('keeps a conversation that began with no person expiring when a person continues it', async () => {
    // A token linked after it started this chat. Decision 46 makes a linked token's
    // NEW chats durable; this one is not new. Turning it durable here also left its
    // first records to expire under it (the second critic's NEW-2).
    await appendTurns(AGENT, CHAT, [turn('user', 'q1'), turn('assistant', 'a1')], undefined, NO_PERSON);

    await appendTurns(AGENT, CHAT, [turn('user', 'q2'), turn('assistant', 'a2')], undefined, PERSON);

    expect(conversation()?.ttl).toEqual(expect.any(Number));
    expect(records()).toHaveLength(4);
    for (const r of records()) expect(r.ttl).toEqual(expect.any(Number));
  });

  it('gives a conversation started by a writer that cannot say who is sending an expiry, never a durable row nobody owns', async () => {
    // A scheduled task whose chat is gone — deleted, or never saved — would
    // otherwise leave a permanent row only an admin can see.
    await appendTurns(AGENT, CHAT, [turn('user', '[scheduled] q'), turn('assistant', 'a')]);

    expect(conversation()?.turns).toHaveLength(2);
    expect(conversation()).not.toHaveProperty('userId');
    expect(conversation()?.ttl).toEqual(expect.any(Number));
  });

  it('never starts a durable conversation nobody owns, even from a turn that says a person is sending', async () => {
    // Every dashboard route names its caller, so this shape is not produced
    // today; the rule is what keeps a durable row from ever having no owner.
    await appendTurns(AGENT, CHAT, [turn('user', 'q'), turn('assistant', 'a')], undefined, {
      surface: 'dashboard',
      ephemeral: false,
    });

    expect(conversation()?.turns).toHaveLength(2);
    expect(conversation()).not.toHaveProperty('userId');
    expect(conversation()?.ttl).toEqual(expect.any(Number));
  });

  it('lets a person\'s first turn settle a conversation a scheduled reply started: theirs, and lasting, records and all', async () => {
    // The first message of a new chat can schedule a task for right away. If that
    // reply is saved first, the conversation starts with no owner and an expiry;
    // the person's own turn, saved a moment later, must settle it as theirs (the
    // third critic's C3-1).
    await appendTurns(AGENT, CHAT, [turn('user', '[scheduled] q'), turn('assistant', 'a')]);

    await appendTurns(AGENT, CHAT, [turn('user', 'q'), turn('assistant', 'a')], undefined, PERSON);

    expect(conversation()?.userId).toBe('dashboard:user:user-a');
    expect(conversation()).not.toHaveProperty('ttl');
    expect(records()).toHaveLength(4);
    for (const r of records().slice(2)) expect(r).not.toHaveProperty('ttl');
    // The scheduled reply's records 0-1 take the owner and lose their expiry. The
    // fake does not apply updates, so the commands are pinned here; Floci runs it.
    const adopted = send.mock.calls.map((c) => c[0]).filter((c) => c.constructor.name === 'UpdateCommand');
    expect(adopted.map((u) => u.input.Key.SK)).toEqual([`CHAT#${CHAT}#MSG#0000000000`, `CHAT#${CHAT}#MSG#0000000001`]);
    for (const u of adopted) {
      expect(u.input).toMatchObject({ UpdateExpression: 'SET userId = :o REMOVE #t', ExpressionAttributeValues: { ':o': 'dashboard:user:user-a' } });
    }
  });

  it('lets a principal with no person settle such a conversation as its own, still expiring', async () => {
    await appendTurns(AGENT, CHAT, [turn('user', '[scheduled] q'), turn('assistant', 'a')]);

    await appendTurns(AGENT, CHAT, [turn('user', 'q'), turn('assistant', 'a')], undefined, NO_PERSON);

    expect(conversation()).toMatchObject({ userId: 'dashboard:hash-root', ttl: expect.any(Number) });
    const adopted = send.mock.calls.map((c) => c[0]).filter((c) => c.constructor.name === 'UpdateCommand');
    expect(adopted).toHaveLength(2);
    for (const u of adopted) expect(u.input.UpdateExpression).toBe('SET userId = :o');
  });

  it('keeps a conversation with no person behind it expiring as it continues', async () => {
    await appendTurns(AGENT, CHAT, [turn('user', 'q1'), turn('assistant', 'a1')], undefined, NO_PERSON);
    await appendTurns(AGENT, CHAT, [turn('user', 'q2'), turn('assistant', 'a2')], undefined, NO_PERSON);

    expect(conversation()?.ttl).toEqual(expect.any(Number));
    expect(records()).toHaveLength(4);
    for (const r of records()) expect(r.ttl).toEqual(expect.any(Number));
  });
});

describe('a slash command never leaves a conversation nobody owns (decision 9, the first critic\'s F2)', () => {
  // A row with no owner is refused to everyone but an admin, so a command that
  // CREATED one — /newchat, /model or /warroom as the first thing typed into a
  // new chat — locked its own author out of that chat for good.
  const updates = () =>
    send.mock.calls.map((c) => c[0]).filter((c) => c.constructor.name === 'UpdateCommand');

  it('/newchat in a chat that does not exist writes nothing: there is nothing to clear', async () => {
    await clearSession(AGENT, CHAT);

    expect(send).toHaveBeenCalled();
    expect(updates()).toHaveLength(0);
  });

  it('/newchat and dropping the model override only ever update a conversation that exists', async () => {
    await exchanges(1);
    await clearSession(AGENT, CHAT);
    await setModelOverride(AGENT, CHAT, null);

    expect(updates()).toHaveLength(2);
    for (const u of updates()) expect(u.input.ConditionExpression).toBe('attribute_exists(PK)');
  });

  it('/warroom in a new chat creates it, owned by whoever entered it', async () => {
    await setWarroomMode(AGENT, CHAT, 'meeting-1', PERSON);

    expect(conversation()).toMatchObject({ activeWarroomId: 'meeting-1', userId: 'dashboard:user:user-a' });
    expect(conversation()).not.toHaveProperty('ttl');
  });

  it('/warroom in a new chat of a principal with no person creates it expiring', async () => {
    await setWarroomMode(AGENT, CHAT, 'meeting-1', NO_PERSON);

    expect(conversation()).toMatchObject({ userId: 'dashboard:hash-root', ttl: expect.any(Number) });
  });

  it('/warroom in a new chat with no caller to name starts it expiring, like any conversation nobody owns', async () => {
    // Every route that reaches this names its caller today; the rule is the same
    // as appendTurns' for a new conversation (the third critic's C3-5).
    await setWarroomMode(AGENT, CHAT, 'meeting-1');

    expect(conversation()).not.toHaveProperty('userId');
    expect(conversation()?.ttl).toEqual(expect.any(Number));
  });

  it('/warroom in an existing conversation changes neither its owner nor its expiry', async () => {
    await exchanges(1);

    await setWarroomMode(AGENT, CHAT, 'meeting-1', NO_PERSON);

    // The fake does not apply updates, so the command is what is pinned; Floci
    // runs the same sequence end to end (sessions-repo.p1.integration.test.ts).
    expect(updates()).toHaveLength(1);
    expect(updates()[0]?.input.UpdateExpression).not.toMatch(/userId|ttl|#t/);
    expect(conversation()?.userId).toBe('dashboard:user:user-a');
  });
});

describe('a chat id whose earlier conversation expired (the second critic\'s NEW-1)', () => {
  // DynamoDB's TTL deletes expired items in no set order, so a conversation's row
  // can go before its records. The next conversation under the same id — a
  // Telegram or Slack chat keeps its id for good — numbers from 0 again and finds
  // those numbers taken.
  const BOT = 'slack:C1:U1';
  const leftover = (seq: number, ttl?: number) => {
    const SK = `CHAT#${BOT}#MSG#${String(seq).padStart(10, '0')}`;
    table.rows.set(`AGENT#${AGENT}|${SK}`, {
      PK: `AGENT#${AGENT}`, SK, seq, role: 'user', text: `old ${seq}`, ts: 1, ...(ttl === undefined ? {} : { ttl }),
    });
  };
  /** DynamoDB's `attribute_not_exists(SK)` on each record, which the fake does not evaluate in a transaction. */
  const takenNumbersFail = () =>
    send.mockImplementation(async (cmd: { constructor: { name: string }; input: { TransactItems?: Array<{ Put: { Item: Record<string, unknown> } }> } }) => {
      if (cmd.constructor.name === 'TransactWriteCommand') {
        const reasons = cmd.input.TransactItems!.map((t, i) => ({
          Code: i > 0 && table.rows.has(`${String(t.Put.Item.PK)}|${String(t.Put.Item.SK)}`) ? 'ConditionalCheckFailed' : 'None',
        }));
        if (reasons.some((r) => r.Code !== 'None')) {
          throw Object.assign(new Error('Transaction cancelled'), { name: 'TransactionCanceledException', CancellationReasons: reasons });
        }
      }
      return table.send(cmd as Parameters<typeof table.send>[0]);
    });
  const now = () => Math.floor(Date.now() / 1000);

  it('clears the records already past their expiry, and writes the new conversation', async () => {
    leftover(0, now() - 60);
    leftover(1, now() - 60);
    takenNumbersFail();

    await appendTurns(AGENT, BOT, [turn('user', 'new q'), turn('assistant', 'new a')], undefined, { surface: 'slack' });

    expect(records(BOT).map((r) => r.text)).toEqual(['new q', 'new a']);
  });

  it('reports the write\'s own error when the sweep itself fails', async () => {
    // A failing sweep used to replace the error it was handling (the third
    // critic's C3-4).
    leftover(0, now() - 60);
    leftover(1, now() - 60);
    takenNumbersFail();
    const inner = send.getMockImplementation()!;
    send.mockImplementation(async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
      if (cmd.constructor.name === 'QueryCommand' && cmd.input.ProjectionExpression === 'PK, SK, #t') {
        throw new Error('sweep failed');
      }
      return inner(cmd);
    });

    await expect(
      appendTurns(AGENT, BOT, [turn('user', 'q'), turn('assistant', 'a')], undefined, { surface: 'slack' }),
    ).rejects.toThrow('Transaction cancelled');
  });

  it('never clears a record that has not expired: the write fails and the record stays', async () => {
    leftover(0);
    leftover(1, now() + 3600);
    takenNumbersFail();

    await expect(
      appendTurns(AGENT, BOT, [turn('user', 'q'), turn('assistant', 'a')], undefined, { surface: 'slack' }),
    ).rejects.toThrow('Transaction cancelled');
    expect(records(BOT).map((r) => r.text)).toEqual(['old 0', 'old 1']);
  });
});

describe('appendTurns — a lost race, and the last attempt (the third critic\'s C3-4 and C3-7)', () => {
  const cancelled = (codes: string[]) =>
    Object.assign(new Error('Transaction cancelled'), {
      name: 'TransactionCanceledException',
      CancellationReasons: codes.map((Code) => ({ Code })),
    });
  const sweeps = () =>
    send.mock.calls.map((c) => c[0]).filter((c) => c.constructor.name === 'QueryCommand' && c.input.ProjectionExpression === 'PK, SK, #t');

  it('re-reads after losing a race to another turn, without sweeping records', async () => {
    // Losing the fence also collides on the records the winner wrote. Those are
    // live, so there is nothing to sweep: re-read and number after them.
    await exchanges(1);
    let lost = false;
    send.mockImplementation(async (cmd: { constructor: { name: string } }) => {
      if (cmd.constructor.name === 'TransactWriteCommand' && !lost) {
        lost = true;
        throw cancelled(['ConditionalCheckFailed', 'ConditionalCheckFailed', 'ConditionalCheckFailed']);
      }
      return table.send(cmd as Parameters<typeof table.send>[0]);
    });

    await exchanges(1, CHAT, 2);

    expect(lost).toBe(true);
    expect(sweeps()).toHaveLength(0);
    expect(records()).toHaveLength(4);
  });

  it('throws after its last attempt rather than resolve without having written', async () => {
    send.mockImplementation(async (cmd: { constructor: { name: string } }) => {
      if (cmd.constructor.name === 'TransactWriteCommand') throw cancelled(['ConditionalCheckFailed']);
      return table.send(cmd as Parameters<typeof table.send>[0]);
    });

    await expect(exchanges(1)).rejects.toThrow();
    expect(send.mock.calls.filter((c) => c[0].constructor.name === 'TransactWriteCommand')).toHaveLength(3);
  });
});

describe('appendTurns retries a transaction DynamoDB throttled (the first critic\'s A4)', () => {
  it('retries when an item of the transaction was throttled, instead of losing the turn', async () => {
    // A throttled item cancels the whole transaction, and the SDK does not retry
    // a cancelled transaction — the single Put this replaced, it did retry.
    let throttled = 0;
    send.mockImplementation(async (cmd: { constructor: { name: string } }) => {
      if (cmd.constructor.name === 'TransactWriteCommand' && throttled === 0) {
        throttled++;
        throw Object.assign(new Error('Transaction cancelled'), {
          name: 'TransactionCanceledException',
          CancellationReasons: [{ Code: 'None' }, { Code: 'ThrottlingError' }],
        });
      }
      return table.send(cmd as Parameters<typeof table.send>[0]);
    });

    await exchanges(1);

    expect(throttled).toBe(1);
    expect(conversation()?.turns).toHaveLength(2);
    expect(records()).toHaveLength(2);
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

  it('leaves a conversation whose id merely starts with the deleted one\'s', async () => {
    // The '#' closing the prefix is what keeps `…000` from matching `…0000`. The
    // neighbour above shares no prefix, so nothing pinned this (mutation M9).
    await exchanges(1);
    await exchanges(1, `${CHAT}0`);

    await deleteSession(AGENT, CHAT);

    expect(conversation(`${CHAT}0`)).toBeDefined();
    expect(records(`${CHAT}0`)).toHaveLength(2);
  });

  it('finds the records it deletes with a strongly consistent read', async () => {
    // An eventually consistent read can miss a message written a moment earlier,
    // and once the row is gone nothing finds that message again (the first
    // critic's A3). Floci is always consistent, so only the command can show it.
    await exchanges(1);

    await deleteSession(AGENT, CHAT);

    const query = send.mock.calls.map((c) => c[0]).find((c) => c.constructor.name === 'QueryCommand');
    expect(query?.input).toMatchObject({ ConsistentRead: true });
  });
});
