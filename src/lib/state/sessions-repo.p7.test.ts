/**
 * P7 (step 9) — work order A at the storage layer: each saved reply keeps the id of the request that
 * produced it (A233; owner decision 65).
 *
 * Written BEFORE the change, as the bar (netzar-chat-plan/p7-proof.sh row T-1).
 *
 * The repository stamps the id CENTRALLY, the way it already stamps `surface`: `appendTurns(..., enrichment)`
 * takes a new optional `enrichment.requestId` (the `clientMessageId` of the request) and writes it on the
 * ASSISTANT turn it saves, in both places a turn lives: the window turn (what the route's regenerate tie
 * reads) and the message record (what the transcript reads). A person's message never carries it, and a
 * turn saved without one has none. The repository's own reads return it: `getSession` for the tie,
 * `getFullHistory` for the transcript (today both drop any field they do not name, so feeding an id in and
 * reading it back cannot pass by construction; M41/P54).
 *
 * `replaceLastReply` stamps the new reply the same way; the id a regenerate saves is pinned through the route
 * against this real repository (chat-regenerate.p7.test.ts, T-4..T-6). What is pinned here is the half the
 * route cannot see: a replacement never inherits the id of the reply it replaced. The record keeps the old
 * record's other fields, so an inherited id would tie a stale page to a reply it never showed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeDynamo } from '../../__test-utils__/fake-dynamo.js';
import { S3Client, DeleteObjectsCommand } from '@aws-sdk/client-s3';

const { send, log } = vi.hoisted(() => ({
  send: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('./ddb.js', async (importActual) => {
  const actual = await importActual<typeof import('./ddb.js')>();
  return { ...actual, ddb: () => ({ send }) };
});
vi.mock('./runtime-config-repo.js', () => ({ getConfig: async () => undefined }));
vi.mock('../../agent/memory-ingest.js', () => ({ ingestEvictedTurns: () => undefined }));
vi.mock('../observability/xray.js', () => ({ captureAwsClient: <T,>(c: T): T => c }));
// Spies, not no-ops: E-4 reads what a refused save logged.
vi.mock('../../observability/logger.js', () => ({ logger: log, truncateForLog: (s: string) => s }));

import {
  appendTurns, getFullHistory, getSession, replaceLastReply,
  clearSession, setModelOverride, setWarroomMode, acquireConversationChildLock,
} from './sessions-repo.js';

const AGENT = 'main';
const CHAT = 'dashboard:1750000000900';
const OWNER = 'dashboard:user:user-a';
const PERSON = { surface: 'dashboard' as const, userId: OWNER, ephemeral: false };

let table: ReturnType<typeof createFakeDynamo>;

beforeEach(() => {
  table = createFakeDynamo();
  send.mockReset();
  send.mockImplementation((cmd: never) => table.send(cmd));
  log.info.mockClear();
  log.warn.mockClear();
  log.error.mockClear();
  log.debug.mockClear();
});

type Item = Record<string, unknown>;
const rowKey = (chatId = CHAT) => `AGENT#${AGENT}|CHAT#${chatId}`;
const lockKey = (chatId: string) => `AGENT#${AGENT}|CHAT#${chatId}#CHILD_LOCK`;
const windowOf = (chatId = CHAT) => (table.rows.get(rowKey(chatId))!.turns as Item[]);
const recordsOf = (chatId = CHAT) =>
  [...table.rows.entries()]
    .filter(([k]) => k.startsWith(`AGENT#${AGENT}|CHAT#${chatId}#MSG#`))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, v]) => v);
/** Each stored turn as [text, requestId or null]. */
const ids = (turns: Item[]) => turns.map((t) => [t.text, t.requestId ?? null]);
/** Every line the repository logged, at any level. */
const logged = () => (['debug', 'info', 'warn', 'error'] as const)
  .flatMap((level) => log[level].mock.calls.map((args) => ({ level, args: args as unknown[] })));
const serialized = (value: unknown) =>
  JSON.stringify(value, (_k, v: unknown) => (v instanceof Error ? { name: v.name, message: v.message } : v));

/**
 * A DynamoDB stand-in for the CHILD_LOCK Put/Delete conditions
 * acquireConversationChildLock uses (L-1, L-2, L-3): the fake table (A170)
 * evaluates only a lone key-existence condition, so it cannot tell a stale
 * lock from a fresh one, nor evaluate the release's token equality. This
 * answers as real DynamoDB would for exactly those two commands; every other
 * command falls through to the ordinary fake table.
 */
function lockAwareSend(rows: Map<string, Item>) {
  return async (cmd: { constructor: { name: string }; input: Record<string, any> }) => {
    const name = cmd.constructor.name;
    const input = cmd.input;
    const keyOf = (k: Record<string, unknown>) => `${String(k.PK)}|${String(k.SK)}`;
    if (name === 'PutCommand' && String((input.Item as Item).SK).endsWith('#CHILD_LOCK')) {
      const k = keyOf(input.Item as Item);
      const existing = rows.get(k);
      const cond = String(input.ConditionExpression ?? '');
      const cutoff = input.ExpressionAttributeValues?.[':cutoff'] as string | undefined;
      const canTakeOverStale = /createdAt\s*<\s*:cutoff/.test(cond);
      const stale = existing !== undefined && canTakeOverStale && cutoff !== undefined &&
        typeof existing.createdAt === 'string' && existing.createdAt < cutoff;
      if (existing === undefined || stale) {
        rows.set(k, input.Item as Item);
        return input.ReturnValues === 'ALL_OLD' && existing ? { Attributes: existing } : {};
      }
      throw Object.assign(new Error('The conditional request failed'), { name: 'ConditionalCheckFailedException' });
    }
    if (name === 'DeleteCommand' && String((input.Key as Item).SK).endsWith('#CHILD_LOCK')) {
      const k = keyOf(input.Key as Item);
      const existing = rows.get(k);
      const wantToken = input.ExpressionAttributeValues?.[':token'];
      if (existing === undefined || (wantToken !== undefined && existing.lockToken !== wantToken)) {
        throw Object.assign(new Error('The conditional request failed'), { name: 'ConditionalCheckFailedException' });
      }
      rows.delete(k);
      return {};
    }
    return table.send(cmd as never);
  };
}

describe('P7 work order A — sessions repository', () => {
  it('P7 a saved reply keeps the id of the request that produced it', async () => {
    // A reply saved before request ids: no enrichment id.
    await appendTurns(AGENT, CHAT, [
      { role: 'user', text: 'Who wrote the Q3 plan?', ts: 100 },
      { role: 'assistant', text: 'The finance team.', ts: 101 },
    ], undefined, PERSON);
    // A reply saved by a request whose clientMessageId was send-2.
    await appendTurns(AGENT, CHAT, [
      { role: 'user', text: 'What is 2+2?', ts: 200 },
      { role: 'assistant', text: 'Five.', ts: 201 },
    ], undefined, { ...PERSON, requestId: 'send-2' });

    const expected = [
      ['Who wrote the Q3 plan?', null],
      ['The finance team.', null],
      ['What is 2+2?', null],
      ['Five.', 'send-2'],
    ];
    // The window turn the route's tie reads, and the message record the transcript reads.
    expect(ids(windowOf())).toEqual(expected);
    expect(ids(recordsOf())).toEqual(expected);
    // Stamped on the reply alone: a person's message never carries it, and a reply saved without one has none.
    for (const turns of [windowOf(), recordsOf()]) {
      expect(turns[0]).not.toHaveProperty('requestId');
      expect(turns[1]).not.toHaveProperty('requestId');
      expect(turns[2]).not.toHaveProperty('requestId');
    }

    // The repository's own reads return it: getSession for the tie, getFullHistory for the transcript.
    const session = (await getSession(AGENT, CHAT))!;
    expect(session.turns.at(-1)?.requestId).toBe('send-2');
    const { turns } = await getFullHistory(AGENT, CHAT, session);
    expect(ids(turns as unknown as Item[])).toEqual(expected);

    // A replacement saved without an id has none: it never inherits the id of the reply it replaced.
    expect(await replaceLastReply(AGENT, CHAT, { role: 'assistant', text: 'Four.', ts: 300 })).toBe(true);
    expect(windowOf().at(-1)).toMatchObject({ text: 'Four.' });
    expect(windowOf().at(-1)).not.toHaveProperty('requestId');
    expect(recordsOf()[3]).toMatchObject({ text: 'Four.' });
    expect(recordsOf()[3]).not.toHaveProperty('requestId');
  });

  // ── work order C: a chat deleted mid-turn stays deleted (M1) ──────────────
  //
  // A dashboard turn writes a marker CHAT#<chatId>#TURN#<clientMessageId> at
  // its start (beginTurn); chat delete purges it with the other children.
  // Decided: when the enrichment carries a requestId, appendTurns adds a
  // ConditionCheck on that marker (attribute_exists(SK)) to its
  // TransactWriteCommand, AFTER item 0 (the row). A failed check refuses the
  // save: nothing written, no retry. Telegram/Slack/scheduled turns carry no
  // id and keep today's behaviour (not tested here; the builder adds skip
  // comments at those call sites).
  const markerKey = (chatId: string, clientMessageId: string) =>
    `AGENT#${AGENT}|CHAT#${chatId}#TURN#${clientMessageId}`;

  /**
   * A DynamoDB stand-in for appendTurns' transaction (E-1, E-4): the fake table
   * (A170) applies a transaction's writes without evaluating any condition, so
   * it cannot refuse a save whose turn marker is gone. This answers as real
   * DynamoDB would for a TransactWriteCommand carrying a ConditionCheck that
   * the item exists: when that key is missing, the whole transaction is
   * cancelled, with ConditionalCheckFailed at that item's index and None
   * elsewhere, and nothing is written. Every transaction is recorded (shape
   * and retries); every other command falls through to the fake table.
   */
  function markerAwareSend(rows: Map<string, Item>, transactions: Array<{ TransactItems: Item[] }>) {
    return async (cmd: { constructor: { name: string }; input: Record<string, any> }) => {
      if (cmd.constructor.name === 'TransactWriteCommand') {
        const items = cmd.input.TransactItems as Array<{ ConditionCheck?: { Key: Item; ConditionExpression?: string } }>;
        transactions.push(cmd.input as { TransactItems: Item[] });
        const reasons = items.map(({ ConditionCheck: check }) =>
          check && /^attribute_exists\((?:PK|SK)\)$/.test(String(check.ConditionExpression ?? '')) &&
          !rows.has(`${String(check.Key.PK)}|${String(check.Key.SK)}`)
            ? { Code: 'ConditionalCheckFailed' } : { Code: 'None' });
        if (reasons.some((r) => r.Code === 'ConditionalCheckFailed')) {
          throw Object.assign(new Error('Transaction cancelled, please refer cancellation reasons for specific reasons'),
            { name: 'TransactionCanceledException', CancellationReasons: reasons });
        }
      }
      return table.send(cmd as never);
    };
  }

  it('P7 a dashboard save whose turn marker is gone writes nothing', async () => {
    const chatId = 'dashboard:e1-marker-gone';
    // A conversation already exists, so the row's OWN version fence trivially
    // passes; only the dashboard turn marker is missing (purged by a delete
    // mid-turn, or never begun).
    await appendTurns(AGENT, chatId, [
      { role: 'user', text: 'first question', ts: 1 },
      { role: 'assistant', text: 'first reply', ts: 2 },
    ], undefined, PERSON);
    const before = { window: windowOf(chatId), records: recordsOf(chatId), row: table.rows.get(rowKey(chatId)) };
    expect(table.rows.has(markerKey(chatId, 'gone-marker-1')), 'the marker must not already exist').toBe(false);
    const transactions: Array<{ TransactItems: Item[] }> = [];
    send.mockImplementation(markerAwareSend(table.rows, transactions));

    let refused = false;
    try {
      await appendTurns(AGENT, chatId, [
        { role: 'user', text: 'second question', ts: 3 },
        { role: 'assistant', text: 'second reply', ts: 4 },
      ], undefined, { ...PERSON, requestId: 'gone-marker-1' });
    } catch {
      refused = true;
    }
    expect(refused, 'a save whose turn marker is gone must refuse, not silently succeed').toBe(true);
    expect({ window: windowOf(chatId), records: recordsOf(chatId), row: table.rows.get(rowKey(chatId)) }).toEqual(before);
    // The shape that makes DynamoDB refuse it: the save's own transaction checks the turn's marker exists,
    // after the row (item 0), and a refused check is not retried.
    expect(transactions, 'one transaction, no retry').toHaveLength(1);
    const checks = transactions[0]!.TransactItems.slice(1).filter((t) => t.ConditionCheck);
    expect(checks).toEqual([{ ConditionCheck: expect.objectContaining({
      Key: { PK: `AGENT#${AGENT}`, SK: `CHAT#${chatId}#TURN#gone-marker-1` },
      ConditionExpression: expect.stringMatching(/^attribute_exists\((?:PK|SK)\)$/),
    }) }]);
  });

  it('P7 a save refused because its chat was deleted mid-turn is logged', async () => {
    const chatId = 'dashboard:e4-logged';
    const secretText = 'the Q3 numbers nobody outside finance should see';
    await appendTurns(AGENT, chatId, [
      { role: 'user', text: 'seed question', ts: 1 },
      { role: 'assistant', text: 'seed reply', ts: 2 },
    ], undefined, PERSON);
    log.warn.mockClear(); log.error.mockClear(); log.info.mockClear(); log.debug.mockClear();
    send.mockImplementation(markerAwareSend(table.rows, []));

    await appendTurns(AGENT, chatId, [
      { role: 'user', text: secretText, ts: 3 },
      { role: 'assistant', text: 'a reply that must never be logged either', ts: 4 },
    ], undefined, { ...PERSON, requestId: 'gone-marker-4' }).catch(() => undefined);

    const lines = logged();
    const named = lines.filter(({ args }) => args.some((a) =>
      typeof a === 'object' && a !== null && (a as Item).agentId === AGENT && (a as Item).chatId === chatId));
    expect(named, `logged: ${serialized(lines)}`).toHaveLength(1);
    const written = serialized(lines);
    expect(written).not.toContain(secretText);
    expect(written).not.toContain('a reply that must never be logged either');
  });

  // The security review's LOW-4: a turn refused because its chat was deleted mid-turn must not leave its
  // uploaded files in the raw bucket. Nothing references them any more, so nothing would ever delete them.
  it('P7 a save refused because its chat was deleted mid-turn leaves none of its files behind', async () => {
    const chatId = 'dashboard:lo4-files';
    await appendTurns(AGENT, chatId, [
      { role: 'user', text: 'seed question', ts: 1 },
      { role: 'assistant', text: 'seed reply', ts: 2 },
    ], undefined, PERSON);
    send.mockImplementation(markerAwareSend(table.rows, []));
    const raw = process.env.RAW_BUCKET;
    process.env.RAW_BUCKET = 'p7-unit-raw';
    const s3 = vi.spyOn(S3Client.prototype, 'send').mockResolvedValue({} as never);
    try {
      await appendTurns(AGENT, chatId, [
        { role: 'user', text: 'here is the plan', ts: 3,
          attachments: [{ id: 'f1', name: 'plan.pdf', type: 'application/pdf', size: 10, key: 'chat-uploads/main/lo4/plan.pdf' }] },
        { role: 'assistant', text: 'a reply', ts: 4 },
      ], undefined, { ...PERSON, requestId: 'gone-marker-lo4' }).catch(() => undefined);
      const deletes = s3.mock.calls.map(([cmd]) => cmd).filter((cmd) => cmd instanceof DeleteObjectsCommand);
      expect(deletes.map((cmd) => (cmd as DeleteObjectsCommand).input), 'the refused turn\'s file is deleted from the raw bucket')
        .toEqual([expect.objectContaining({ Bucket: 'p7-unit-raw', Delete: { Objects: [{ Key: 'chat-uploads/main/lo4/plan.pdf' }] } })]);
    } finally {
      s3.mockRestore();
      if (raw === undefined) delete process.env.RAW_BUCKET; else process.env.RAW_BUCKET = raw;
    }
  });

  // ── work order C: the child lock's 15-minute lease (M3) ───────────────────
  //
  // acquireConversationChildLock puts the lock with ConditionExpression:
  // 'attribute_not_exists(PK) OR createdAt < :cutoff' (cutoff = now - 15
  // minutes, ISO) and ReturnValues: 'ALL_OLD'; an old item coming back means a
  // takeover, logged with its age. A lock younger than 15 minutes refuses, as
  // today. The release's Delete stays conditioned on lockToken = :token; a
  // ConditionalCheckFailedException there logs instead of throwing.
  //
  // The fake table (A170) evaluates only a lone key-existence condition, so
  // it cannot arbitrate stale-vs-fresh itself: these rows drive
  // acquireConversationChildLock against lockAwareSend, a small DynamoDB
  // stand-in built for exactly this condition and this Delete (defined above,
  // "make the mocked client answer as DynamoDB would"), which pins both the
  // COMMAND SHAPE and the resulting code path; the Floci row (L-4) proves the
  // behaviour against a real table.
  it('P7 a child lock older than fifteen minutes is taken over and the takeover is logged with its age', async () => {
    const chatId = 'dashboard:l1-stale-lock';
    const ageSeconds = 16 * 60;
    table.rows.set(lockKey(chatId), {
      PK: `AGENT#${AGENT}`, SK: `CHAT#${chatId}#CHILD_LOCK`,
      lockToken: 'old-token', createdAt: new Date(Date.now() - ageSeconds * 1000).toISOString(),
    });
    send.mockImplementation(lockAwareSend(table.rows));

    let release: (() => Promise<void>) | undefined;
    let error: unknown;
    try {
      release = await acquireConversationChildLock(AGENT, chatId);
    } catch (e) {
      error = e;
    }
    expect(error, 'a lock older than fifteen minutes must be taken over, not refused as busy').toBeUndefined();
    expect(table.rows.get(lockKey(chatId))?.lockToken, 'the new holder replaces the stale token').not.toBe('old-token');

    expect(log.warn, 'the takeover must be logged with the old lock\'s age in seconds').toHaveBeenCalledWith(
      expect.objectContaining({ agentId: AGENT, chatId, ageSeconds: expect.any(Number) }),
      expect.any(String),
    );
    const loggedAge = (log.warn.mock.calls.find((c) => (c[0] as Item)?.chatId === chatId)?.[0] as Item | undefined)?.ageSeconds;
    expect(loggedAge).toBeGreaterThanOrEqual(ageSeconds - 5);

    await release?.();
  });

  it('P7 a child lock younger than fifteen minutes still refuses', async () => {
    const chatId = 'dashboard:l2-fresh-lock';
    const ageSeconds = 60;
    table.rows.set(lockKey(chatId), {
      PK: `AGENT#${AGENT}`, SK: `CHAT#${chatId}#CHILD_LOCK`,
      lockToken: 'fresh-token', createdAt: new Date(Date.now() - ageSeconds * 1000).toISOString(),
    });
    let captured: Record<string, unknown> | undefined;
    const aware = lockAwareSend(table.rows);
    send.mockImplementation(async (cmd: never) => {
      const input = (cmd as { input: Record<string, unknown> }).input;
      if ((cmd as { constructor: { name: string } }).constructor.name === 'PutCommand' &&
        String((input.Item as Item).SK).endsWith('#CHILD_LOCK')) captured = input;
      return aware(cmd as never);
    });

    await expect(acquireConversationChildLock(AGENT, chatId)).rejects.toThrow(/busy/i);
    expect(table.rows.get(lockKey(chatId))?.lockToken, 'a lock younger than fifteen minutes must not be taken over').toBe('fresh-token');

    // COMMAND SHAPE (A170): the put must be able to see the lock's age at all,
    // or a stale lock (L-1) could never be told from a fresh one.
    expect(String(captured?.ConditionExpression), 'the condition must compare the lock\'s age').toMatch(/createdAt/);
    expect(captured?.ReturnValues, 'ALL_OLD is what lets a takeover log the old lock\'s age (L-1)').toBe('ALL_OLD');
  });

  it('P7 a late release that finds another holder logs instead of throwing', async () => {
    const chatId = 'dashboard:l3-late-release';
    send.mockImplementation(lockAwareSend(table.rows));
    const release = await acquireConversationChildLock(AGENT, chatId);
    // Another holder has since taken the lock (a stale takeover, L-1): the
    // stored token no longer matches the one this caller holds.
    table.rows.set(lockKey(chatId), { ...table.rows.get(lockKey(chatId))!, lockToken: 'someone-elses-token' });
    log.warn.mockClear();

    await expect(release()).resolves.toBeUndefined();
    expect(log.warn, 'a late release finding another holder must log, not throw').toHaveBeenCalled();
  });

  // ── work order C: /newchat, /model and /warroom bump the version (A232) ───
  //
  // clearSession, setModelOverride and setWarroomMode bump the row's version
  // (if_not_exists(version, 0) + 1) through a row-only variant of
  // updateIfExists; adoptRecords stays as it is. The fake table's UpdateCommand
  // never applies its expression (A170; see fake-dynamo.ts), so this pins the
  // three update expressions themselves — the Floci row (N-2) proves the
  // version fence this bump exists to create.
  it('P7 new chat model and war room changes bump the conversation version', async () => {
    const chatId = 'dashboard:n1-version-bump';
    await appendTurns(AGENT, chatId, [
      { role: 'user', text: 'hi', ts: 1 },
      { role: 'assistant', text: 'hello', ts: 2 },
    ], undefined, PERSON);

    const captured: Array<{ label: string; input: Record<string, unknown> }> = [];
    send.mockImplementation(async (cmd: never) => {
      const name = (cmd as { constructor: { name: string } }).constructor.name;
      const input = (cmd as { input: Record<string, unknown> }).input;
      if (name === 'UpdateCommand') captured.push({ label: String(input.UpdateExpression), input });
      return table.send(cmd);
    });

    await clearSession(AGENT, chatId);
    await setModelOverride(AGENT, chatId, 'us.anthropic.claude-opus-4-1');
    await setWarroomMode(AGENT, chatId, 'meeting-1');

    expect(captured, 'clearSession, setModelOverride and setWarroomMode must each send one row update').toHaveLength(3);
    for (const { label, input } of captured) {
      expect(String(input.UpdateExpression), `update: ${label}`).toMatch(/version/i);
      expect(String(input.UpdateExpression), `update: ${label}`).toMatch(/if_not_exists/i);
    }
  });
});
