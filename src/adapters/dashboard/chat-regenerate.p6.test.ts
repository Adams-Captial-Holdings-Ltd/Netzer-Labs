/**
 * P6 (step 8) — regenerate, and what a stopped reply keeps, on the dashboard stream route.
 *
 * Written BEFORE the change, as the bar (netzar-chat-plan/p6-proof.sh rows R-1..R-7, S-1, S-2).
 * Driven through the REAL buildDashboardRouter with the sessions repo, the agent loop, the
 * media pipeline's storage boundaries and the audit writer mocked — the chat-lifecycle.test.ts
 * harness — so every branch of the route executes.
 *
 * Regenerate (the P6 design council, p6-runs/council-design/chairman.md):
 *   - `POST /test-turn/stream` with `regenerate: true` and no text answers the conversation's
 *     STORED last user message again: a new paid model turn with that message's text, the
 *     history before it, and the files it carried (their blocks rebuilt from the stored copies,
 *     never archived, transcribed or added to knowledge again).
 *   - Only the new reply is saved, through `replaceLastReply`, which overwrites the last reply
 *     in place; no second user message is stored (`appendTurns` is never called).
 *   - A stranger gets the missing chat's 404; a conversation with no reply to answer again is
 *     refused before any model call; text or files in the same request are refused.
 *   - It is metered and attributed exactly like a send, and one message id starts one turn.
 * Stops (owner decision 52, the P4 critic's F2): a stopped reply saves what the reader SAW —
 * never the withheld :::artifact source, never an empty reply when text had already streamed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { TokenPrincipal } from '../../lib/auth/dashboard-auth.js';

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

// The media pipeline's real block building runs; only its storage and side-effect
// boundaries are replaced: the raw-bucket read, and processMedia itself (which a
// regenerate must never run: it archives, transcribes and may ingest).
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
  return { ...actual, deleteObject: (...a: unknown[]) => deleteObject(...a) };
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
  return { ...actual, isKillSwitchActive: () => Promise.resolve({ active: false }) };
});

vi.mock('../../lib/state/runtime-config-repo.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/state/runtime-config-repo.js')>();
  return { ...actual, getConfig: vi.fn(async () => undefined) };
});

vi.mock('../../lib/state/ddb.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/state/ddb.js')>();
  return { ...actual, ddb: () => ({ send }) };
});

vi.mock('../../observability/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  truncateForLog: (s: string) => s,
}));

import { buildDashboardRouter } from './handler.js';
import { CostCapExceededError } from '../../agent/agent-loop.js';

const AGENT = 'main';
const CHAT = 'dashboard:1750000000600';
const SONNET = 'us.anthropic.claude-sonnet-4-6';
const OWNER = 'dashboard:user:user-a';

function app() {
  const a = new Hono();
  a.route('/api', buildDashboardRouter());
  return a;
}

function post(body: Record<string, unknown>) {
  return app().request('/api/test-turn/stream', {
    method: 'POST',
    headers: { Authorization: 'Bearer member-a1', 'content-type': 'application/json' },
    body: JSON.stringify({ agentId: AGENT, chatId: CHAT, protocol: 2, ...body }),
  });
}

const regenerate = (extra: Record<string, unknown> = {}) => post({ regenerate: true, clientMessageId: 'regen-1', ...extra });

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

function ok(text: string, extra: Record<string, unknown> = {}) {
  return { text, modelId: SONNET, latencyMs: 5, costUsd: 0.001, inputTokens: 10, outputTokens: 5, toolCallCount: 0, ...extra };
}

type T = { role: 'user' | 'assistant'; text: string; ts: number; status?: 'stopped'; attachments?: unknown[] };
const EARLIER: T[] = [
  { role: 'user', text: 'Who wrote the Q3 plan?', ts: 100 },
  { role: 'assistant', text: 'The finance team.', ts: 101 },
];
const LAST_USER: T = { role: 'user', text: 'What is 2+2?', ts: 200 };
const LAST_REPLY: T = { role: 'assistant', text: 'Five.', ts: 201 };

function stored(turns: T[], extra: Record<string, unknown> = {}) {
  return {
    turns, userId: OWNER, surface: 'dashboard', messageCount: turns.filter((t) => t.role === 'user').length,
    turnsTotal: turns.length, version: 3, updatedAt: 201, createdAt: 100, ...extra,
  };
}

interface TurnRequest {
  userText: string;
  history: T[];
  attachments?: Array<{ kind: string; format: string; bytes: Buffer; name?: string }>;
  userId?: string;
  dashboardUserId?: string;
  origin?: string;
  surface?: string;
  modelOverride?: string;
  onChunk?: (t: string) => void;
}
const turnRequest = (): TurnRequest => runAgentTurn.mock.calls[0]![0] as TurnRequest;

describe('P6 regenerate and stopped text — stream route', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    authenticateDashboardToken.mockImplementation(async (raw: string) => PRINCIPALS[raw] ?? null);
    getSession.mockResolvedValue(stored([...EARLIER, LAST_USER, LAST_REPLY]));
    appendTurns.mockResolvedValue(undefined);
    replaceLastReply.mockResolvedValue(true);
    beginTurn.mockResolvedValue({ started: true });
    endTurn.mockResolvedValue(true);
    runCommand.mockResolvedValue(undefined);
    runAgentTurn.mockResolvedValue(ok('Four.'));
    writeAudit.mockResolvedValue(undefined);
    send.mockResolvedValue({});
    listKnownAgents.mockReturnValue(['main']);
    listKnownAgentsAsync.mockResolvedValue(['main']);
    processMedia.mockRejectedValue(new Error('processMedia must not run for a regenerate'));
    deleteObject.mockResolvedValue(undefined);
    ingestChatMedia.mockRejectedValue(new Error('a regenerate must not ingest'));
    vi.stubEnv('BEDROCK_DEFAULT_MODEL', SONNET);
    vi.stubEnv('BEDROCK_SONNET_MODEL', SONNET);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('P6 regenerate answers the stored last message again and saves only the new reply', async () => {
    const res = await regenerate();
    expect(res.status).toBe(200);
    const events = parseSse(await res.text());

    expect(runAgentTurn).toHaveBeenCalledTimes(1);
    const req = turnRequest();
    // The STORED message is answered again, with only what came before it as history.
    expect(req.userText).toBe('What is 2+2?');
    expect(req.history.map((t) => [t.role, t.text])).toEqual([
      ['user', 'Who wrote the Q3 plan?'],
      ['assistant', 'The finance team.'],
    ]);
    // Only the reply is saved: in place of the old one, and no second user message.
    expect(appendTurns).not.toHaveBeenCalled();
    expect(replaceLastReply).toHaveBeenCalledTimes(1);
    const [agentId, chatId, reply] = replaceLastReply.mock.calls[0]! as [string, string, T];
    expect([agentId, chatId]).toEqual([AGENT, CHAT]);
    expect(reply).toMatchObject({ role: 'assistant', text: 'Four.' });
    expect(events.some((e) => e.event === 'final' && JSON.parse(e.data).text === 'Four.')).toBe(true);
    expect(events.at(-1)).toEqual({ event: 'done', data: 'ok' });
  });

  it('P6 regenerate gives a stranger the missing conversation refusal', async () => {
    // A conversation that does not exist, and one that is someone else's, read the same.
    getSession.mockResolvedValue(undefined);
    const missing = await regenerate();
    getSession.mockResolvedValue(stored([...EARLIER, LAST_USER, LAST_REPLY], { userId: 'dashboard:user:someone-else' }));
    const foreign = await regenerate();
    for (const res of [missing, foreign]) {
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'not_found' });
    }
    expect(runAgentTurn).not.toHaveBeenCalled();
    expect(replaceLastReply).not.toHaveBeenCalled();
    expect(beginTurn).not.toHaveBeenCalled();
  });

  it('P6 regenerate with no reply to answer again is refused before any model call', async () => {
    for (const session of [
      stored([]), // emptied by /newchat
      stored([...EARLIER, LAST_USER]), // ends with a message that has no reply
    ]) {
      getSession.mockResolvedValue(session);
      const res = await regenerate();
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'nothing_to_regenerate' });
    }
    expect(runAgentTurn).not.toHaveBeenCalled();
    expect(replaceLastReply).not.toHaveBeenCalled();
    expect(beginTurn).not.toHaveBeenCalled();
  });

  it('P6 regenerate refuses a request that also carries text or files', async () => {
    const withText = await regenerate({ text: 'a different question' });
    expect(withText.status).toBe(400);
    expect(await withText.json()).toEqual({ error: 'invalid_regenerate' });
    const withFiles = await regenerate({
      attachments: [{ s3Key: 'uploads/chat/0123456789abcdef/11111111-1111-4111-8111-111111111111/a.pdf', fileName: 'a.pdf', mimeType: 'application/pdf' }],
    });
    expect(withFiles.status).toBe(400);
    expect(await withFiles.json()).toEqual({ error: 'invalid_regenerate' });
    expect(runAgentTurn).not.toHaveBeenCalled();
  });

  it('P6 regenerate gives the model the same files again without storing or ingesting them again', async () => {
    const pdf = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082', 'hex');
    const withFiles: T = {
      ...LAST_USER,
      text: 'Summarise these',
      attachments: [
        { id: 'f1', name: 'q3.pdf', type: 'application/pdf', size: pdf.length, key: `dashboard/${CHAT}/2026/09/27/1-q3.pdf` },
        { id: 'f2', name: 'chart.png', type: 'image/png', size: png.length, key: `dashboard/${CHAT}/2026/09/27/2-chart.png` },
      ],
    };
    getSession.mockResolvedValue(stored([...EARLIER, withFiles, LAST_REPLY]));
    getRawObject.mockImplementation(async (key: string) => (key.endsWith('.pdf') ? pdf : png));

    const res = await regenerate();
    expect(res.status).toBe(200);
    await res.text();

    // Read back from the stored copies, by their raw-bucket keys.
    expect(getRawObject.mock.calls.map((c) => c[0])).toEqual([
      `dashboard/${CHAT}/2026/09/27/1-q3.pdf`,
      `dashboard/${CHAT}/2026/09/27/2-chart.png`,
    ]);
    // The model sees the same files again, as blocks.
    const req = turnRequest();
    expect(req.userText).toBe('Summarise these');
    const blocks = req.attachments ?? [];
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ kind: 'document', format: 'pdf' });
    expect(Buffer.compare(blocks[0]!.bytes, pdf)).toBe(0);
    expect(blocks[1]).toMatchObject({ kind: 'image', format: 'png' });
    expect(Buffer.compare(blocks[1]!.bytes, png)).toBe(0);
    // Nothing is archived, staged, transcribed or ingested a second time.
    expect(processMedia).not.toHaveBeenCalled();
    expect(deleteObject).not.toHaveBeenCalled();
    expect(ingestChatMedia).not.toHaveBeenCalled();
    expect(appendTurns).not.toHaveBeenCalled();
    expect(replaceLastReply).toHaveBeenCalledTimes(1);
  });

  it('P6 regenerate is metered and attributed like any send', async () => {
    await (await regenerate({ modelOverride: SONNET })).text();
    expect(runAgentTurn).toHaveBeenCalledTimes(1);
    const req = turnRequest();
    expect(req).toMatchObject({
      userId: OWNER,
      dashboardUserId: 'user-a',
      origin: 'human_chat',
      surface: 'dashboard',
      modelOverride: SONNET,
    });

    // A spend refusal reads exactly as it does for a send of the same conversation, and saves nothing.
    replaceLastReply.mockClear();
    runAgentTurn.mockReset();
    runAgentTurn.mockRejectedValue(new CostCapExceededError(10, 10.5));
    const regenerated = parseSse(await (await regenerate({ clientMessageId: 'regen-2' })).text());
    const sent = parseSse(await (await post({ text: 'What is 2+2?', clientMessageId: 'send-2' })).text());
    const errorOf = (events: SseEvent[]) => events.find((e) => e.event === 'error')?.data;
    expect(errorOf(regenerated)).toBeDefined();
    expect(errorOf(regenerated)).toBe(errorOf(sent));
    expect(replaceLastReply).not.toHaveBeenCalled();
  });

  it('P6 one regenerate message id starts one model call', async () => {
    await (await regenerate({ clientMessageId: 'regen-7' })).text();
    expect(beginTurn).toHaveBeenCalledTimes(1);
    expect(beginTurn.mock.calls[0]!.slice(0, 3)).toEqual([AGENT, CHAT, 'regen-7']);

    // The same id again: the turn record says it has begun, so no second model call.
    beginTurn.mockResolvedValue({ started: false, status: 'complete', sameMessage: true });
    const again = await regenerate({ clientMessageId: 'regen-7' });
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: 'turn_duplicate', status: 'complete' });
    expect(runAgentTurn).toHaveBeenCalledTimes(1);
  });

  it('P6 a stop inside a file block saves only the text the reader saw', async () => {
    const raw = 'Here is the page:\n\n:::artifact{identifier="page" type="text/html" title="Page"}\n<html><body>secret draft';
    runAgentTurn.mockImplementation(async (req: TurnRequest) => {
      req.onChunk?.(raw);
      return ok(raw, { stopped: true });
    });
    await (await post({ text: 'Make me a page', clientMessageId: 'send-3' })).text();

    expect(appendTurns).toHaveBeenCalledTimes(1);
    const [, , turns] = appendTurns.mock.calls[0]! as [string, string, T[]];
    const reply = turns.find((t) => t.role === 'assistant')!;
    expect(reply.status).toBe('stopped');
    expect(reply.text).toContain('Here is the page:');
    expect(reply.text).not.toContain(':::artifact');
    expect(reply.text).not.toContain('secret draft');
  });

  it('P6 a stop that interrupts a tool round keeps the text already shown', async () => {
    runAgentTurn.mockImplementation(async (req: TurnRequest) => {
      req.onChunk?.('Checking the three regions now');
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      throw err;
    });
    await (await post({ text: 'Check the regions', clientMessageId: 'send-4' })).text();

    expect(appendTurns).toHaveBeenCalledTimes(1);
    const [, , turns] = appendTurns.mock.calls[0]! as [string, string, T[]];
    const reply = turns.find((t) => t.role === 'assistant')!;
    expect(reply.status).toBe('stopped');
    expect(reply.text).toBe('Checking the three regions now');
  });
});
