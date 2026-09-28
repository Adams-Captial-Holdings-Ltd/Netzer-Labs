/**
 * P7 (step 9) — work order A on the dashboard stream route: Regenerate acts on the reply the page shows (A233).
 *
 * Written BEFORE the change, as the bar (netzar-chat-plan/p7-proof.sh rows T-2..T-6 and O-1).
 *
 * The decided design (owner decision 65; Jev a233_fallback null_as_id 0.98):
 *   - Each saved reply stores `requestId`, the `clientMessageId` of the request that produced it. The route
 *     passes its clientMessageId to the repository on the send and the regenerate paths, and
 *     GET /sessions/transcript returns each reply with it (absent or null for a reply saved before).
 *   - A regenerate may name the reply the page shows: `replyTo`, that reply's requestId, or null for a reply
 *     saved before request ids. Checked with the structural checks, before the turn record and any model call:
 *       absent  -> today's behaviour, no tie (a tab opened before this change);
 *       present -> compared with the stored last reply's requestId, a missing one counting as null:
 *                    different -> 409 { error: 'reply_changed' }: no turn record, no model call, nothing saved;
 *                    equal     -> as today, and the new reply is saved with the regenerate's own clientMessageId.
 *   - A refusal writes one log line naming the agent and the chat, and none of the conversation's text.
 *
 * Harness: chat-regenerate.p6.test.ts's mocks, app and SSE reading. The repository's five route-facing
 * functions stay spies, so a test can say "never called", but each defaults to the REAL repository over the
 * in-memory table (src/__test-utils__/fake-dynamo.ts), so a test reads what was STORED rather than what the
 * route passed. The transcript route spreads each turn through unchanged: a test that fed a requestId into a
 * mocked read and read it back would pass on today's code (M41/P54). Every test uses a chat of its own (M96)
 * and reads each response to its end before asserting (P135).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { TokenPrincipal } from '../../lib/auth/dashboard-auth.js';
import { createFakeDynamo } from '../../__test-utils__/fake-dynamo.js';

type Repo = typeof import('../../lib/state/sessions-repo.js');

const {
  authenticateDashboardToken,
  getSession,
  appendTurns,
  replaceLastReply,
  beginTurn,
  endTurn,
  runAgentTurn,
  runCommand,
  writeAudit,
  send,
  listKnownAgents,
  listKnownAgentsAsync,
  getRawObject,
  processMedia,
  deleteObject,
  ingestChatMedia,
  isKillSwitchActive,
  headChatUpload,
  getObjectBuffer,
  isUploadKey,
  log,
  actualRepo,
} = vi.hoisted(() => ({
  authenticateDashboardToken: vi.fn(),
  getSession: vi.fn(),
  appendTurns: vi.fn(),
  replaceLastReply: vi.fn(),
  beginTurn: vi.fn(),
  endTurn: vi.fn(),
  runAgentTurn: vi.fn(),
  runCommand: vi.fn(),
  writeAudit: vi.fn(),
  send: vi.fn(),
  listKnownAgents: vi.fn(),
  listKnownAgentsAsync: vi.fn(),
  getRawObject: vi.fn(),
  processMedia: vi.fn(),
  deleteObject: vi.fn(),
  ingestChatMedia: vi.fn(),
  isKillSwitchActive: vi.fn(),
  // B (C-1): a fresh (non-regenerate) file-only send goes through the upload
  // preflight and read, never through getRawObject (that is the STORED-replay
  // read used by a regenerate; see work order A's mocks above).
  headChatUpload: vi.fn(),
  getObjectBuffer: vi.fn(),
  isUploadKey: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  actualRepo: { current: undefined as unknown },
}));

const PRINCIPALS: Record<string, TokenPrincipal> = {
  'member-a1': {
    tokenHash: 'hash-login-1', label: 'member:a', hashPrefix16: 'login1', role: 'operator',
    profileId: 'operator', userId: 'user-a',
  },
};

vi.mock('../../lib/auth/dashboard-auth.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/auth/dashboard-auth.js')>();
  return {
    ...actual,
    extractBearerToken: (h?: string) => (h ?? '').replace(/^Bearer\s+/i, ''),
    authenticateDashboardToken: (raw: string) => authenticateDashboardToken(raw),
  };
});

vi.mock('../../lib/state/sessions-repo.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/state/sessions-repo.js')>();
  actualRepo.current = actual;
  return {
    ...actual,
    getSession: (...a: unknown[]) => getSession(...a),
    appendTurns: (...a: unknown[]) => appendTurns(...a),
    replaceLastReply: (...a: unknown[]) => replaceLastReply(...a),
    beginTurn: (...a: unknown[]) => beginTurn(...a),
    endTurn: (...a: unknown[]) => endTurn(...a),
  };
});

vi.mock('../../agent/agent-loop.js', async (importActual) => {
  const actual = await importActual<typeof import('../../agent/agent-loop.js')>();
  return { ...actual, runAgentTurn: (...a: unknown[]) => runAgentTurn(...a) };
});

vi.mock('../../agent/commands.js', () => ({
  runCommand: (...a: unknown[]) => runCommand(...a),
}));

vi.mock('../../lib/media/process.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/media/process.js')>();
  return {
    ...actual,
    getRawObject: (...a: unknown[]) => getRawObject(...a),
    processMedia: (...a: unknown[]) => processMedia(...a),
  };
});

vi.mock('../../lib/vectors/store.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/vectors/store.js')>();
  return {
    ...actual,
    deleteObject: (...a: unknown[]) => deleteObject(...a),
    headChatUpload: (...a: unknown[]) => headChatUpload(...a),
    getObjectBuffer: (...a: unknown[]) => getObjectBuffer(...a),
    isUploadKey: (...a: unknown[]) => isUploadKey(...a),
  };
});

vi.mock('../../lib/media/chat-kb-ingest.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/media/chat-kb-ingest.js')>();
  return { ...actual, ingestChatMedia: (...a: unknown[]) => ingestChatMedia(...a) };
});

vi.mock('../../lib/audit/audit-writer.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/audit/audit-writer.js')>();
  return { ...actual, writeAudit: (event: unknown) => writeAudit(event), writeAuditOrThrow: vi.fn(async () => {}) };
});

vi.mock('../../lib/config/agent-loader.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/config/agent-loader.js')>();
  return {
    ...actual,
    listKnownAgents: () => listKnownAgents(),
    listKnownAgentsAsync: () => listKnownAgentsAsync(),
  };
});

vi.mock('../../lib/state/kill-switches-repo.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/state/kill-switches-repo.js')>();
  return { ...actual, isKillSwitchActive };
});

// A plain function, not a vi.fn: vi.resetAllMocks() would reset a spy to return undefined, and the real
// appendTurns calls getConfig(...).catch(...) (M95: every mock a harmless default).
vi.mock('../../lib/state/runtime-config-repo.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/state/runtime-config-repo.js')>();
  return { ...actual, getConfig: async () => undefined };
});

vi.mock('../../lib/state/ddb.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/state/ddb.js')>();
  return { ...actual, ddb: () => ({ send }) };
});

// Spies, not no-ops: O-1 reads what the route logged.
vi.mock('../../observability/logger.js', () => ({
  logger: log,
  truncateForLog: (s: string) => s,
}));

import { buildDashboardRouter } from './handler.js';
// The real error class the admission step throws (KillSwitchActiveError is
// re-exported from agent-loop.js); passes through unchanged since only
// runAgentTurn itself is replaced above.
import { KillSwitchActiveError } from '../../agent/agent-loop.js';
import { createHash } from 'node:crypto';

const AGENT = 'main';
const SONNET = 'us.anthropic.claude-sonnet-4-6';
const OWNER = 'dashboard:user:user-a';
const PERSON = { surface: 'dashboard' as const, userId: OWNER, ephemeral: false };

// handler.ts's chatUploadPrefix(c): uploads/chat/<sha256(dashboardIdentity)[:16]>/.
// dashboardIdentity() for PRINCIPALS['member-a1'] (userId: 'user-a') is OWNER.
const uploadPrefix = () => `uploads/chat/${createHash('sha256').update(OWNER).digest('hex').slice(0, 16)}/`;

const repo = () => actualRepo.current as Repo;

function app() {
  const a = new Hono();
  a.route('/api', buildDashboardRouter());
  return a;
}

function post(body: Record<string, unknown>) {
  return app().request('/api/test-turn/stream', {
    method: 'POST',
    headers: { Authorization: 'Bearer member-a1', 'content-type': 'application/json' },
    body: JSON.stringify({ agentId: AGENT, protocol: 2, ...body }),
  });
}

const regenerate = (chatId: string, extra: Record<string, unknown>) =>
  post({ chatId, regenerate: true, clientMessageId: 'regen-1', ...extra });

interface SseEvent { event: string; data: string }
function parseSse(text: string): SseEvent[] {
  return text.split('\n\n').filter((b) => b.trim() !== '' && !b.startsWith(':')).map((block) => {
    const lines = block.split('\n');
    return {
      event: lines.find((l) => l.startsWith('event: '))?.slice(7) ?? '',
      data: lines.filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n'),
    };
  });
}

/** A JSON body, or the start of whatever else came back (today a regenerate answers with a stream). */
function jsonOrText(text: string): unknown {
  try { return JSON.parse(text); } catch { return text.slice(0, 120); }
}

function ok(text: string, extra: Record<string, unknown> = {}) {
  return { text, modelId: SONNET, latencyMs: 5, costUsd: 0.001, inputTokens: 10, outputTokens: 5, toolCallCount: 0, ...extra };
}

let table: ReturnType<typeof createFakeDynamo>;
type Item = Record<string, unknown>;
const rowKey = (chatId: string) => `AGENT#${AGENT}|CHAT#${chatId}`;
const recordKey = (chatId: string, seq: number) => `${rowKey(chatId)}#MSG#${String(seq).padStart(10, '0')}`;
/** The window the next regenerate's tie reads. */
const windowOf = (chatId: string) => table.rows.get(rowKey(chatId))!.turns as Item[];
/** Each turn as [text, requestId or null]. */
const ids = (turns: Item[]) => turns.map((t) => [t.text, t.requestId ?? null]);
const snapshot = () => JSON.stringify([...table.rows.entries()].sort(([a], [b]) => a.localeCompare(b)));

/** [question, reply, the requestId the reply was saved with (none: saved before request ids)]. */
type Exchange = [question: string, reply: string, requestId?: string];

/**
 * A conversation as the repository stores it after this change: written by today's appendTurns, then each
 * reply's id stamped on its window turn and its message record. T-1 pins the repository's own stamping; these
 * tests pin the route's rule over what is stored.
 */
async function seed(chatId: string, exchanges: Exchange[]): Promise<void> {
  for (const [i, [question, reply]] of exchanges.entries()) {
    await repo().appendTurns(AGENT, chatId, [
      { role: 'user', text: question, ts: 100 + i * 2 },
      { role: 'assistant', text: reply, ts: 101 + i * 2 },
    ], undefined, PERSON);
  }
  const stamp = (item: Item, seq: number): Item => {
    const id = seq % 2 === 1 ? exchanges[(seq - 1) / 2]?.[2] : undefined;
    return id === undefined ? item : { ...item, requestId: id };
  };
  const row = table.rows.get(rowKey(chatId))!;
  const turns = row.turns as Item[];
  table.rows.set(rowKey(chatId), { ...row, turns: turns.map(stamp) });
  for (const seq of turns.keys()) table.rows.set(recordKey(chatId, seq), stamp(table.rows.get(recordKey(chatId, seq))!, seq));
}

async function transcript(chatId: string): Promise<Item[]> {
  const res = await app().request(`/api/sessions/transcript?agentId=${AGENT}&chatId=${encodeURIComponent(chatId)}`, {
    headers: { Authorization: 'Bearer member-a1' },
  });
  return ((await res.json()) as { turns?: Item[] }).turns ?? [];
}

interface TurnRequest { userText: string; history: Array<{ role: string; text: string }> }
const turnRequest = (): TurnRequest => runAgentTurn.mock.calls[0]![0] as TurnRequest;

/** Every line the route logged, at any level. */
const logged = () => (['debug', 'info', 'warn', 'error'] as const)
  .flatMap((level) => log[level].mock.calls.map((args) => ({ level, args: args as unknown[] })));
/** Serialized with Error messages, which JSON.stringify would otherwise drop. */
const serialized = (value: unknown) =>
  JSON.stringify(value, (_k, v: unknown) => (v instanceof Error ? { name: v.name, message: v.message } : v));

const EARLIER: Exchange = ['Who wrote the Q3 plan?', 'The finance team.', 'send-1'];
const LAST: Exchange = ['What is 2+2?', 'Five.', 'send-2'];

describe('P7 work order A — stream route', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    table = createFakeDynamo();
    send.mockImplementation((cmd: never) => table.send(cmd));
    authenticateDashboardToken.mockImplementation(async (raw: string) => PRINCIPALS[raw] ?? null);
    // The real repository over the in-memory table, behind spies.
    getSession.mockImplementation((...a: Parameters<Repo['getSession']>) => repo().getSession(...a));
    appendTurns.mockImplementation((...a: Parameters<Repo['appendTurns']>) => repo().appendTurns(...a));
    replaceLastReply.mockImplementation((...a: Parameters<Repo['replaceLastReply']>) => repo().replaceLastReply(...a));
    beginTurn.mockImplementation((...a: Parameters<Repo['beginTurn']>) => repo().beginTurn(...a));
    endTurn.mockImplementation((...a: Parameters<Repo['endTurn']>) => repo().endTurn(...a));
    runCommand.mockResolvedValue(undefined);
    runAgentTurn.mockResolvedValue(ok('Four.'));
    writeAudit.mockResolvedValue(undefined);
    listKnownAgents.mockReturnValue([AGENT]);
    listKnownAgentsAsync.mockResolvedValue([AGENT]);
    processMedia.mockRejectedValue(new Error('processMedia must not run in these tests'));
    getRawObject.mockRejectedValue(new Error('no stored file is read in these tests'));
    deleteObject.mockResolvedValue(undefined);
    ingestChatMedia.mockRejectedValue(new Error('nothing is ingested in these tests'));
    isKillSwitchActive.mockResolvedValue({ active: false });
    // Harmless defaults (M95): only C-1 exercises a fresh file-only send, which
    // overrides these; everything else never reaches the upload preflight.
    isUploadKey.mockReturnValue(true);
    headChatUpload.mockResolvedValue(null);
    getObjectBuffer.mockRejectedValue(new Error('no staged upload is read in these tests'));
    vi.stubEnv('BEDROCK_DEFAULT_MODEL', SONNET);
    vi.stubEnv('BEDROCK_SONNET_MODEL', SONNET);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('P7 the transcript returns each reply with its request id', async () => {
    const chatId = 'dashboard:1750000000702';
    await seed(chatId, [['Who wrote the Q3 plan?', 'The finance team.']]); // saved before request ids
    runAgentTurn.mockResolvedValue(ok('Six.'));

    const sent = await post({ chatId, text: 'And 3+3?', clientMessageId: 'send-2' });
    const events = parseSse(await sent.text());
    expect(sent.status).toBe(200);
    expect(events.at(-1)).toEqual({ event: 'done', data: 'ok' });

    const turns = await transcript(chatId);
    expect(turns.map((t) => [t.role, t.text])).toEqual([
      ['user', 'Who wrote the Q3 plan?'],
      ['assistant', 'The finance team.'],
      ['user', 'And 3+3?'],
      ['assistant', 'Six.'],
    ]);
    // Each reply with the clientMessageId of the request that produced it; the one saved before, none.
    expect(ids(turns)).toEqual([
      ['Who wrote the Q3 plan?', null],
      ['The finance team.', null],
      ['And 3+3?', null],
      ['Six.', 'send-2'],
    ]);
    // A person's message never carries one.
    expect(turns[0]).not.toHaveProperty('requestId');
    expect(turns[2]).not.toHaveProperty('requestId');
  });

  it('P7 regenerate naming a reply that is not the stored last reply is refused before any model call', async () => {
    const chatId = 'dashboard:1750000000703';
    const oldOnly = 'dashboard:1750000000713';
    await seed(chatId, [EARLIER, LAST]);
    await seed(oldOnly, [['Who wrote the Q3 plan?', 'The finance team.']]); // its last reply has no id
    const before = snapshot();

    const cases: Array<[chatId: string, replyTo: string | null, why: string]> = [
      [chatId, 'send-1', 'an earlier reply: another tab has answered since'],
      [chatId, null, 'a reply saved before request ids, while the stored last reply is newer'],
      [oldOnly, 'send-9', 'a reply the server does not hold, while its last reply has no id'],
    ];
    for (const [id, replyTo, why] of cases) {
      const res = await regenerate(id, { replyTo, clientMessageId: `regen-${String(replyTo)}` });
      const body = await res.text();
      expect([res.status, jsonOrText(body)], why).toEqual([409, { error: 'reply_changed' }]);
    }
    // Refused with the structural checks: no model call, no turn record, nothing saved anywhere.
    expect(runAgentTurn).not.toHaveBeenCalled();
    expect(beginTurn).not.toHaveBeenCalled();
    expect(replaceLastReply).not.toHaveBeenCalled();
    expect(appendTurns).not.toHaveBeenCalled();
    expect(snapshot()).toBe(before);
  });

  it('P7 regenerate naming the stored last reply answers it again', async () => {
    const chatId = 'dashboard:1750000000704';
    await seed(chatId, [EARLIER, LAST]);

    const res = await regenerate(chatId, { replyTo: 'send-2', clientMessageId: 'regen-4' });
    const events = parseSse(await res.text());
    expect(res.status).toBe(200);
    expect(events.at(-1)).toEqual({ event: 'done', data: 'ok' });
    // The stored last message is answered again, exactly as today.
    expect(runAgentTurn).toHaveBeenCalledTimes(1);
    expect(turnRequest().userText).toBe('What is 2+2?');
    expect(turnRequest().history.map((t) => t.text)).toEqual(['Who wrote the Q3 plan?', 'The finance team.']);

    // The new reply is saved in place with the id of the regenerate that produced it: in the window the next
    // tie reads, and in the transcript the page reads. The earlier reply keeps its own.
    const expected = [
      ['Who wrote the Q3 plan?', null],
      ['The finance team.', 'send-1'],
      ['What is 2+2?', null],
      ['Four.', 'regen-4'],
    ];
    expect(ids(windowOf(chatId))).toEqual(expected);
    expect(ids(await transcript(chatId))).toEqual(expected);
  });

  it('P7 regenerate of a reply saved before request ids matches it as an empty id', async () => {
    const chatId = 'dashboard:1750000000705';
    await seed(chatId, [['Who wrote the Q3 plan?', 'The finance team.'], ['What is 2+2?', 'Five.']]); // no ids

    // The page shows that old reply, so it names it as null.
    const res = await regenerate(chatId, { replyTo: null, clientMessageId: 'regen-5' });
    const events = parseSse(await res.text());
    expect(res.status).toBe(200);
    expect(events.at(-1)).toEqual({ event: 'done', data: 'ok' });
    expect(runAgentTurn).toHaveBeenCalledTimes(1);
    expect(turnRequest().userText).toBe('What is 2+2?');

    // Answered again, and from now on the reply has an id of its own.
    const expected = [
      ['Who wrote the Q3 plan?', null],
      ['The finance team.', null],
      ['What is 2+2?', null],
      ['Four.', 'regen-5'],
    ];
    expect(ids(windowOf(chatId))).toEqual(expected);
    expect(ids(await transcript(chatId))).toEqual(expected);
  });

  it('P7 regenerate from a page opened before this change keeps working', async () => {
    const chatId = 'dashboard:1750000000706';
    await seed(chatId, [EARLIER, LAST]);

    // A tab opened before this change sends no replyTo at all: no tie, even though the stored reply has an id.
    const res = await regenerate(chatId, { clientMessageId: 'regen-6' });
    const events = parseSse(await res.text());
    expect(res.status).toBe(200);
    expect(events.some((e) => e.event === 'final' && JSON.parse(e.data).text === 'Four.')).toBe(true);
    expect(events.at(-1)).toEqual({ event: 'done', data: 'ok' });
    expect(runAgentTurn).toHaveBeenCalledTimes(1);
    expect(turnRequest().userText).toBe('What is 2+2?');

    // Its new reply still carries the id of the request that produced it, so a newer tab can tie to it.
    expect(ids(windowOf(chatId))).toEqual([
      ['Who wrote the Q3 plan?', null],
      ['The finance team.', 'send-1'],
      ['What is 2+2?', null],
      ['Four.', 'regen-6'],
    ]);
  });

  it('P7 a refused regenerate is logged without the conversation text', async () => {
    const chatId = 'dashboard:1750000000707';
    const texts = [
      'Where did the Q3 audit find the ledger gap?',
      'In the Frankfurt export, rows 4410 to 4420.',
      'Which of those rows was wrong?',
      'Row 4417 carried the duplicated invoice.',
    ];
    await seed(chatId, [[texts[0]!, texts[1]!, 'send-1'], [texts[2]!, texts[3]!, 'send-2']]);

    const res = await regenerate(chatId, { replyTo: 'send-1', clientMessageId: 'regen-7' });
    const body = await res.text();

    const lines = logged();
    // One line names the conversation it refused...
    const named = lines.filter(({ args }) => args.some((a) =>
      typeof a === 'object' && a !== null && (a as Item).agentId === AGENT && (a as Item).chatId === chatId));
    expect(named, `logged: ${serialized(lines)}`).toHaveLength(1);
    // ...and no line carries any of the conversation's text.
    const written = serialized(lines);
    for (const text of texts) expect(written).not.toContain(text);
    // It is the refusal that was logged.
    expect([res.status, jsonOrText(body)]).toEqual([409, { error: 'reply_changed' }]);
  });

  // ── work order B: the file note is a notice (A241) ────────────────────────
  //
  // A241 (owner decision 66): the dashboard's file-only path (handler.ts's
  // media-only branch, ~:2380-2391) saves its canned acknowledgement with
  // `status: 'notice'` (today Turn.status is only 'stopped'). The regenerate
  // route refuses a stored notice with the EXISTING structural refusal (409
  // nothing_to_regenerate), before beginTurn and before any model call.

  it('P7 the file stored but not read note is saved as a notice', async () => {
    const chatId = 'dashboard:1750000000801';
    const key = `${uploadPrefix()}c1-upload/notes.pdf`;
    headChatUpload.mockResolvedValue({ size: 900, type: 'application/pdf' });
    getObjectBuffer.mockResolvedValue(Buffer.from('%PDF-1.4 test'));
    // Nothing the model can see: no inline block, only a canned ack — the same
    // shape a KB-only or unreadable document produces today.
    processMedia.mockResolvedValue({
      s3Key: undefined, blocks: [], ackText: 'notes.pdf was stored but not read.', kb: null, kind: 'document',
    });

    const res = await post({
      chatId, text: '', clientMessageId: 'send-notice-1',
      attachments: [{ s3Key: key, fileName: 'notes.pdf', mimeType: 'application/pdf' }],
    });
    expect(res.status).toBe(200);
    const sse = await res.text();
    // The existing media-only shape is unchanged: a plain reply, done: media_only.
    expect(sse).toContain('event: reply');
    expect(sse).toContain('media_only');
    expect(runAgentTurn).not.toHaveBeenCalled();

    const turns = await transcript(chatId);
    const reply = turns.find((t) => t.role === 'assistant');
    expect(reply, `stored turns: ${JSON.stringify(turns)}`).toMatchObject({ status: 'notice' });
  });

  it('P7 regenerate refuses a notice', async () => {
    const chatId = 'dashboard:1750000000802';
    await seed(chatId, [['Here is the file', 'Stored the file.']]);
    // Stamp the last reply as a notice, the way A241 will save it (a manual
    // poke, like O-1's requestId stamping above: no builder code exists yet).
    const row = table.rows.get(rowKey(chatId))!;
    const turns = row.turns as Item[];
    const stamped = turns.map((t, i) => (i === turns.length - 1 ? { ...t, status: 'notice' } : t));
    table.rows.set(rowKey(chatId), { ...row, turns: stamped });

    const res = await regenerate(chatId, { clientMessageId: 'regen-notice-1' });
    const body = await res.text();
    expect([res.status, jsonOrText(body)], 'a stored notice must be refused like any other structural refusal')
      .toEqual([409, { error: 'nothing_to_regenerate' }]);
    expect(runAgentTurn).not.toHaveBeenCalled();
    expect(beginTurn).not.toHaveBeenCalled();
    expect(replaceLastReply).not.toHaveBeenCalled();
  });

  // The security review's INFO-8 (owner decision 66's revisit trigger): the kill-phrase confirmation is a canned
  // reply too. Stored as an ordinary reply, Regenerate replayed the phrase and re-engaged the fleet-wide halt.
  it('P7 the kill-phrase confirmation is saved as a notice', async () => {
    const chatId = 'dashboard:1750000000803';
    runAgentTurn.mockResolvedValue(ok('Emergency halt engaged.', { refusal: { kind: 'kill_phrase', retryable: false } }));
    const res = await post({ chatId, text: 'the kill phrase', clientMessageId: 'kill-1' });
    expect(res.status).toBe(200);
    await res.text();
    const reply = (await transcript(chatId)).find((t) => t.role === 'assistant');
    expect(reply, 'Regenerate must never replay the kill phrase').toMatchObject({ status: 'notice' });
  });

  // ── work order B: admission before the stored-file replay (A238) ─────────
  //
  // Today replayStoredAttachments (handler.ts:667-697, called at :2331) runs
  // BEFORE runAgentTurn, so a regenerate refused at admission has already read
  // every stored file. Decided: the route must pass the replay to runAgentTurn
  // as a function it calls only after its own admission checks.
  //
  // Driven via the real KillSwitchActiveError class (imported from
  // agent-loop.js, unmocked) rather than a hand-rolled rejection: this is
  // exactly the error runAgentTurn's own bedrock_global admission check
  // throws, so the route's isOperatorRefusal/classifyTurnError handling
  // exercises the same path a genuine kill-switch refusal takes. runAgentTurn
  // itself stays mocked in this suite (as in every other test above) rather
  // than delegated to the real implementation, which would also exercise
  // loadAgent's S3 read and the rate limiter for no added value here.
  it('P7 a regenerate refused at admission reads no stored file', async () => {
    const chatId = 'dashboard:1750000000803';
    const pdf = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');
    await repo().appendTurns(AGENT, chatId, [
      { role: 'user', text: 'Summarize this', ts: 100, attachments: [
        { id: 'f1', name: 'q3.pdf', type: 'application/pdf', size: pdf.length, key: `dashboard/${chatId}/2026/09/27/1-q3.pdf` },
      ] },
      { role: 'assistant', text: 'Here you go.', ts: 101 },
    ], undefined, PERSON);
    getRawObject.mockResolvedValue(pdf);
    runAgentTurn.mockRejectedValue(new KillSwitchActiveError('maintenance window', 'bedrock_global'));

    const res = await regenerate(chatId, { clientMessageId: 'regen-g1' });
    const events = parseSse(await res.text());
    const error = events.find((e) => e.event === 'error');
    expect(error, `no error event; events: ${JSON.stringify(events)}`).toBeDefined();
    expect(JSON.parse(error!.data).code, 'refused by the real admission error, not a generic failure').toBe('kill_switch_active');

    expect(getRawObject, 'a regenerate refused at admission must read no stored file').not.toHaveBeenCalled();
    expect(replaceLastReply).not.toHaveBeenCalled();
  });
});
