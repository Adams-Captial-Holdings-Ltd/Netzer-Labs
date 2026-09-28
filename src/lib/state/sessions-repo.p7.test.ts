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

const { send } = vi.hoisted(() => ({ send: vi.fn() }));

vi.mock('./ddb.js', async (importActual) => {
  const actual = await importActual<typeof import('./ddb.js')>();
  return { ...actual, ddb: () => ({ send }) };
});
vi.mock('./runtime-config-repo.js', () => ({ getConfig: async () => undefined }));
vi.mock('../../agent/memory-ingest.js', () => ({ ingestEvictedTurns: () => undefined }));
vi.mock('../observability/xray.js', () => ({ captureAwsClient: <T,>(c: T): T => c }));

import { appendTurns, getFullHistory, getSession, replaceLastReply } from './sessions-repo.js';

const AGENT = 'main';
const CHAT = 'dashboard:1750000000900';
const OWNER = 'dashboard:user:user-a';
const PERSON = { surface: 'dashboard' as const, userId: OWNER, ephemeral: false };

let table: ReturnType<typeof createFakeDynamo>;

beforeEach(() => {
  table = createFakeDynamo();
  send.mockReset();
  send.mockImplementation((cmd: never) => table.send(cmd));
});

type Item = Record<string, unknown>;
const rowKey = (chatId = CHAT) => `AGENT#${AGENT}|CHAT#${chatId}`;
const windowOf = (chatId = CHAT) => (table.rows.get(rowKey(chatId))!.turns as Item[]);
const recordsOf = (chatId = CHAT) =>
  [...table.rows.entries()]
    .filter(([k]) => k.startsWith(`AGENT#${AGENT}|CHAT#${chatId}#MSG#`))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, v]) => v);
/** Each stored turn as [text, requestId or null]. */
const ids = (turns: Item[]) => turns.map((t) => [t.text, t.requestId ?? null]);

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
});
