/**
 * P6 (step 8) — regenerate's replace and a conversation's title and pin, at the storage layer.
 *
 * Written BEFORE the change, as the bar (netzar-chat-plan/p6-proof.sh rows Q-1..Q-4).
 *
 * `replaceLastReply(agentId, chatId, reply)` is regenerate's one write (the P6 design council:
 * overwrite in place). In ONE transaction, fenced on the conversation's version, it replaces the
 * window's last turn — which must be the assistant's — and overwrites that same message record,
 * keeping its number. Nothing else moves: the user message, every earlier record, `turnsTotal`
 * and `messageCount` stay as they were, so the window is still the newest suffix of the records
 * and the history reader, the migration back-fill and the expiry sweep need no change.
 *
 * `setConversationMeta(agentId, chatId, owner, { title?, pinned? })` renames or pins with ONE
 * conditional update that requires the row to exist and to belong to `owner`, and bumps the
 * version so a turn that read the row before the rename re-reads it instead of writing the old
 * row back. It never creates a row (an owner-less row locks its author out, P96). Every writer
 * that rebuilds the whole row keeps the title and the pin.
 *
 * The in-memory table applies Puts and transactions but no update expression or compound
 * condition (fake-dynamo.ts), so the conditional update is pinned here by the command it sends
 * and proved on Floci (sessions-repo.p6.integration.test.ts, P95).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeDynamo } from '../../__test-utils__/fake-dynamo.js';

const { send } = vi.hoisted(() => ({ send: vi.fn() }));

vi.mock('./ddb.js', async (importActual) => {
  const actual = await importActual<typeof import('./ddb.js')>();
  return { ...actual, ddb: () => ({ send }) };
});
vi.mock('./runtime-config-repo.js', () => ({ getConfig: async () => undefined }));
vi.mock('../../agent/memory-ingest.js', () => ({ ingestEvictedTurns: () => undefined }));
vi.mock('../observability/xray.js', () => ({ captureAwsClient: <T,>(c: T): T => c }));

import {
  appendTurns,
  getFullHistory,
  getSession,
  reownLegacyConversation,
  replaceLastReply,
  setConversationMeta,
} from './sessions-repo.js';

const AGENT = 'main';
const CHAT = 'dashboard:1750000000800';
const OWNER = 'dashboard:user:user-a';
const PERSON = { surface: 'dashboard' as const, userId: OWNER, ephemeral: false };

let table: ReturnType<typeof createFakeDynamo>;

beforeEach(() => {
  table = createFakeDynamo();
  send.mockReset();
  send.mockImplementation((cmd: never) => table.send(cmd));
});

const rowKey = (chatId = CHAT) => `AGENT#${AGENT}|CHAT#${chatId}`;
const recordsOf = (chatId = CHAT) =>
  [...table.rows.entries()]
    .filter(([k]) => k.startsWith(`AGENT#${AGENT}|CHAT#${chatId}#MSG#`))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, v]) => v);

async function twoExchanges(chatId = CHAT, who = PERSON) {
  await appendTurns(AGENT, chatId, [
    { role: 'user', text: 'Who wrote the Q3 plan?', ts: 100 },
    { role: 'assistant', text: 'The finance team.', ts: 101 },
  ], undefined, who);
  await appendTurns(AGENT, chatId, [
    { role: 'user', text: 'What is 2+2?', ts: 200 },
    { role: 'assistant', text: 'Five.', ts: 201 },
  ], undefined, who);
}

describe('P6 regenerate replace and conversation meta — sessions repository', () => {
  it('P6 replacing the last reply rewrites that reply and nothing else', async () => {
    await twoExchanges();
    const before = (await getSession(AGENT, CHAT))!;
    const recordsBefore = recordsOf();
    expect(recordsBefore).toHaveLength(4);

    const replaced = await replaceLastReply(AGENT, CHAT, { role: 'assistant', text: 'Four.', ts: 300 });
    expect(replaced).toBe(true);

    const after = (await getSession(AGENT, CHAT))!;
    // The window: same length, same user messages, only its last turn is new.
    expect(after.turns.map((t) => t.text)).toEqual(['Who wrote the Q3 plan?', 'The finance team.', 'What is 2+2?', 'Four.']);
    expect(after.turns.at(-1)).toMatchObject({ role: 'assistant', text: 'Four.' });
    // The counters that number the records do not move; the version does.
    expect(after.turnsTotal).toBe(before.turnsTotal);
    expect(after.messageCount).toBe(before.messageCount);
    expect(after.userId).toBe(OWNER);
    expect(after.version).toBe((before.version ?? 0) + 1);

    // The records: the same four, the last one overwritten in place, the others untouched.
    const recordsAfter = recordsOf();
    expect(recordsAfter).toHaveLength(4);
    expect(recordsAfter.slice(0, 3)).toEqual(recordsBefore.slice(0, 3));
    expect(recordsAfter[3]).toMatchObject({ SK: recordsBefore[3]!.SK, seq: 3, role: 'assistant', text: 'Four.', userId: OWNER });

    // The whole-conversation read shows the new reply once, and not the old one.
    const { turns } = await getFullHistory(AGENT, CHAT, after);
    expect(turns.map((t) => t.text)).toEqual(['Who wrote the Q3 plan?', 'The finance team.', 'What is 2+2?', 'Four.']);
  });

  it('P6 replacing the last reply writes nothing when the last turn is not a reply', async () => {
    // A conversation that does not exist.
    expect(await replaceLastReply(AGENT, 'dashboard:1750000000801', { role: 'assistant', text: 'x', ts: 1 })).toBe(false);
    expect(table.rows.size).toBe(0);

    // A window that ends with the person's message (its reply was never saved).
    await appendTurns(AGENT, CHAT, [{ role: 'user', text: 'Still waiting', ts: 1 }], undefined, PERSON);
    const snapshot = new Map([...table.rows.entries()].map(([k, v]) => [k, JSON.stringify(v)]));
    expect(await replaceLastReply(AGENT, CHAT, { role: 'assistant', text: 'x', ts: 2 })).toBe(false);
    expect(new Map([...table.rows.entries()].map(([k, v]) => [k, JSON.stringify(v)]))).toEqual(snapshot);

    // A window /newchat emptied.
    table.rows.set(rowKey('dashboard:1750000000802'), {
      ...table.rows.get(rowKey())!, SK: 'CHAT#dashboard:1750000000802', turns: [],
    });
    const before = JSON.stringify(table.rows.get(rowKey('dashboard:1750000000802')));
    expect(await replaceLastReply(AGENT, 'dashboard:1750000000802', { role: 'assistant', text: 'x', ts: 3 })).toBe(false);
    expect(JSON.stringify(table.rows.get(rowKey('dashboard:1750000000802')))).toBe(before);
  });

  it('P6 every conversation writer keeps the title and the pin', async () => {
    await twoExchanges();
    // The row as a rename and a pin leave it (the update itself is proved on Floci).
    table.rows.set(rowKey(), { ...table.rows.get(rowKey())!, title: 'Budget review', pinned: true });

    await appendTurns(AGENT, CHAT, [
      { role: 'user', text: 'And 3+3?', ts: 300 },
      { role: 'assistant', text: 'Six.', ts: 301 },
    ], undefined, PERSON);
    expect(table.rows.get(rowKey())).toMatchObject({ title: 'Budget review', pinned: true });

    expect(await replaceLastReply(AGENT, CHAT, { role: 'assistant', text: 'Six, still.', ts: 302 })).toBe(true);
    expect(table.rows.get(rowKey())).toMatchObject({ title: 'Budget review', pinned: true });

    // The legacy migration rebuilds the whole row under its new owner.
    const legacy = 'dashboard:1750000000803';
    await twoExchanges(legacy, { surface: 'dashboard', userId: 'dashboard:hash-legacy', ephemeral: false });
    table.rows.set(rowKey(legacy), { ...table.rows.get(rowKey(legacy))!, title: 'Old chat', pinned: true });
    await reownLegacyConversation(AGENT, legacy, 'dashboard:hash-legacy', OWNER, 'link');
    expect(table.rows.get(rowKey(legacy))).toMatchObject({ userId: OWNER, title: 'Old chat', pinned: true });
  });

  it('P6 renaming or pinning never creates a conversation', async () => {
    const commands: Array<{ name: string; input: Record<string, unknown> }> = [];
    send.mockReset();
    send.mockImplementation(async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
      commands.push({ name: cmd.constructor.name, input: cmd.input });
      if (cmd.constructor.name === 'UpdateCommand') {
        throw Object.assign(new Error('The conditional request failed'), { name: 'ConditionalCheckFailedException' });
      }
      return {};
    });

    // DynamoDB refuses (no such row, or not this owner's): the answer is false, not an error.
    expect(await setConversationMeta(AGENT, CHAT, OWNER, { title: 'Budget review' })).toBe(false);
    expect(await setConversationMeta(AGENT, CHAT, OWNER, { pinned: true })).toBe(false);
    expect(await setConversationMeta(AGENT, CHAT, OWNER, { title: null })).toBe(false);

    // Each is ONE conditional update: nothing that could create a row is ever sent.
    expect(commands.map((c) => c.name)).toEqual(['UpdateCommand', 'UpdateCommand', 'UpdateCommand']);
    for (const { input } of commands) {
      expect(input.Key).toEqual({ PK: `AGENT#${AGENT}`, SK: `CHAT#${CHAT}` });
      const condition = String(input.ConditionExpression);
      expect(condition).toMatch(/attribute_exists\(PK\)/);
      expect(Object.values(input.ExpressionAttributeValues as Record<string, unknown>)).toContain(OWNER);
      // The version moves, so a turn that read the row before this write re-reads it.
      expect(String(input.UpdateExpression)).toMatch(/version|#v/);
    }

    // When DynamoDB accepts, the answer is true.
    send.mockReset();
    send.mockResolvedValue({});
    expect(await setConversationMeta(AGENT, CHAT, OWNER, { title: 'Budget review', pinned: false })).toBe(true);
  });
});
