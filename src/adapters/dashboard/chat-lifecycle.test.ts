/**
 * P2 (step 4) — the stream route's half of the turn lifecycle.
 *
 * Written BEFORE the change, as the bar (netzar-chat-plan/p2-proof.sh rows A-5..A-7,
 * B-1..B-4, B-8, B-9, D-1..D-4). Driven through the REAL buildDashboardRouter with
 * the sessions repo, the agent loop and the audit writer mocked, the same harness
 * as sessions-ownership.test.ts, so every branch of the route executes.
 *
 * What it pins, in the plan's words (netzar-chat-plan.md:448, :749):
 *   - "Disconnect/Stop aborts Bedrock work and conditionally persists `stopped`":
 *     the client going away aborts the turn; the partial is saved, marked stopped,
 *     and never as an empty assistant turn (an empty turn poisons a chat — M29/A21).
 *   - "heartbeat prevents silent edge gap": an SSE comment at least every 15 s, so
 *     an idle proxy (Cloudflare closes at ~100 s) never cuts a long tool turn.
 *   - "sanitised pre-/mid-stream failures": an error is {code, message} for a client
 *     that speaks protocol 2, a clean sentence for an older one, and never the raw
 *     exception text (ARNs, account ids, file paths).
 *   - "no error follows final": a failed save after the answer is logged and
 *     reported as `done: not_saved`, not as an error that contradicts the answer
 *     the person already has (the P1 log's A9).
 *   - deltas for a client that asks (`protocol: 2`), positional so a redaction that
 *     rewrites earlier text is expressible; cumulative chunks for everyone else.
 *   - decisions 37 + 41: tool start and end reach the browser correlated by
 *     toolUseId; the saved turn keeps each result and never the arguments.
 *   - WI-2.3: a model outside the published catalog and an agent that does not exist
 *     are refused on BOTH send routes before anything is spent.
 *   - "a retry cannot initiate a second provider call": the same clientMessageId is
 *     refused with 409 once its turn has begun, and reusing an id for a different
 *     message is refused too.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { TokenPrincipal } from '../../lib/auth/dashboard-auth.js';

const {
  authenticateDashboardToken,
  getSession,
  appendTurns,
  beginTurn,
  endTurn,
  runAgentTurn,
  runCommand,
  writeAudit,
  send,
  loggerError,
  loggerWarn,
  listKnownAgents,
  listKnownAgentsAsync,
} = vi.hoisted(() => ({
  authenticateDashboardToken: vi.fn(),
  getSession: vi.fn(),
  appendTurns: vi.fn(),
  beginTurn: vi.fn(),
  endTurn: vi.fn(),
  runAgentTurn: vi.fn(),
  runCommand: vi.fn(),
  writeAudit: vi.fn(),
  send: vi.fn(),
  loggerError: vi.fn(),
  loggerWarn: vi.fn(),
  listKnownAgents: vi.fn(),
  listKnownAgentsAsync: vi.fn(),
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
  logger: {
    info: () => {},
    warn: (...a: unknown[]) => loggerWarn(...a),
    error: (...a: unknown[]) => loggerError(...a),
    debug: () => {},
  },
  truncateForLog: (s: string) => s,
}));

import { buildDashboardRouter } from './handler.js';
import { CostCapExceededError } from '../../agent/agent-loop.js';
import { KillSwitchActiveError } from '../../lib/state/kill-switches-repo.js';
import { humanizeToolName } from '../../lib/tools/humanize.js';

const AGENT = 'main';
const CHAT = 'dashboard:1750000000000';
const SONNET = 'us.anthropic.claude-sonnet-4-6';
const HAIKU = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';

function app() {
  const a = new Hono();
  a.route('/api', buildDashboardRouter());
  return a;
}

function request(who: string, path: string, init: RequestInit = {}) {
  return app().request(path, {
    ...init,
    headers: { Authorization: `Bearer ${who}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

const postStream = (who: string, body: Record<string, unknown> = {}) =>
  request(who, '/api/test-turn/stream', {
    method: 'POST',
    body: JSON.stringify({ text: 'hello again', agentId: AGENT, chatId: CHAT, ...body }),
  });

const postTurn = (who: string, body: Record<string, unknown> = {}) =>
  request(who, '/api/test-turn', {
    method: 'POST',
    body: JSON.stringify({ text: 'hello again', agentId: AGENT, chatId: CHAT, ...body }),
  });

interface SseEvent { event: string; data: string; comment?: string }

/** Split an SSE body into events. A block holding only a `:` line is a comment. */
function parseSse(text: string): SseEvent[] {
  return text
    .split('\n\n')
    .filter((b) => b.trim() !== '')
    .map((block) => {
      const lines = block.split('\n');
      const comment = lines.find((l) => l.startsWith(':'));
      return {
        event: lines.find((l) => l.startsWith('event: '))?.slice(7) ?? '',
        data: lines.filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n'),
        ...(comment ? { comment } : {}),
      };
    });
}

/** A normal agent-turn result. */
function ok(text: string, extra: Record<string, unknown> = {}) {
  return {
    text,
    modelId: SONNET,
    latencyMs: 5,
    costUsd: 0.001,
    inputTokens: 10,
    outputTokens: 5,
    toolCallCount: 0,
    ...extra,
  };
}

interface TurnReq {
  onChunk?: (t: string) => void;
  onToolEvent?: (e: Record<string, unknown>) => void;
  onToolResult?: (e: Record<string, unknown>) => void;
  abortSignal?: AbortSignal;
}

/** Resolve on the signal's abort, or after `ms` so a missing signal cannot hang the file. */
function abortedOrTimeout(signal: AbortSignal | undefined, ms = 1500): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    });
  });
}

/**
 * The saves for ONE conversation. The disconnect tests each use their own chat id:
 * a stopped turn is saved after the request is gone, so its save can land after
 * its test has finished, and counting every save would charge it to the next test.
 */
function savesFor(chatId: string): unknown[][] {
  return appendTurns.mock.calls.filter((call) => call[1] === chatId);
}

/** Read what the stream has, or give up after a few macrotask turns (nothing is coming). */
async function readWithin(reader: ReadableStreamDefaultReader<Uint8Array>, ticks = 30): Promise<string> {
  const idle = new Promise<null>((resolve) => {
    let n = 0;
    const spin = () => (++n >= ticks ? resolve(null) : setImmediate(spin));
    setImmediate(spin);
  });
  const got = await Promise.race([reader.read(), idle]);
  if (!got || got.done || !got.value) return '';
  return new TextDecoder().decode(got.value);
}

describe('turn lifecycle (P2) — stream route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authenticateDashboardToken.mockImplementation(async (raw: string) => PRINCIPALS[raw] ?? null);
    getSession.mockResolvedValue(undefined);
    appendTurns.mockResolvedValue(undefined);
    beginTurn.mockResolvedValue({ started: true });
    endTurn.mockResolvedValue(true);
    runCommand.mockResolvedValue(undefined);
    runAgentTurn.mockResolvedValue(ok('Hi.'));
    writeAudit.mockResolvedValue(undefined);
    send.mockResolvedValue({});
    listKnownAgents.mockReturnValue(['main']);
    listKnownAgentsAsync.mockResolvedValue(['main']);
    vi.stubEnv('BEDROCK_DEFAULT_MODEL', SONNET);
    vi.stubEnv('BEDROCK_SONNET_MODEL', SONNET);
    vi.stubEnv('BEDROCK_HAIKU_MODEL', HAIKU);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it('aborts the turn when the client disconnects', async () => {
    let seen: AbortSignal | undefined;
    runAgentTurn.mockImplementation(async (req: TurnReq) => {
      seen = req.abortSignal;
      req.onChunk?.('Hel');
      await abortedOrTimeout(req.abortSignal);
      return ok('Hel', { stopped: true });
    });

    const res = await postStream('member-a1', { protocol: 2, chatId: 'dashboard:1750000000101' });
    const reader = res.body!.getReader();
    await reader.read(); // the first bytes of the answer
    await reader.cancel(); // the person closed the tab, or pressed Stop

    expect(seen).toBeInstanceOf(AbortSignal);
    await vi.waitFor(() => expect(seen!.aborted).toBe(true), { timeout: 1000 });
  });

  it('saves a stopped turn with the text streamed so far', async () => {
    runAgentTurn.mockImplementation(async (req: TurnReq) => {
      req.onChunk?.('Hel');
      await abortedOrTimeout(req.abortSignal);
      return ok('Hel', { stopped: true });
    });

    const chat = 'dashboard:1750000000102';
    const res = await postStream('member-a1', { protocol: 2, clientMessageId: 'cm-stop', chatId: chat });
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel();

    await vi.waitFor(() => expect(savesFor(chat)).toHaveLength(1), { timeout: 2500 });
    const turns = savesFor(chat)[0]![2] as Array<Record<string, unknown>>;
    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({ role: 'user', text: 'hello again' });
    expect(turns[1]).toMatchObject({ role: 'assistant', text: 'Hel', status: 'stopped' });
    await vi.waitFor(() => expect(endTurn).toHaveBeenCalledWith(AGENT, chat, 'cm-stop', 'stopped'));
  });

  it('saves a notice when a turn stops before any text', async () => {
    runAgentTurn.mockImplementation(async (req: TurnReq) => {
      await abortedOrTimeout(req.abortSignal);
      return ok('', { stopped: true });
    });

    const chat = 'dashboard:1750000000103';
    const res = await postStream('member-a1', { protocol: 2, chatId: chat });
    await vi.waitFor(() => expect(runAgentTurn).toHaveBeenCalled());
    await res.body!.cancel();

    await vi.waitFor(() => expect(savesFor(chat)).toHaveLength(1), { timeout: 2500 });
    const reply = (savesFor(chat)[0]![2] as Array<Record<string, unknown>>)[1]!;
    expect(reply).toMatchObject({ role: 'assistant', status: 'stopped' });
    // Never an empty assistant turn: Bedrock rejects the next request in this chat.
    expect(String(reply.text).trim().length).toBeGreaterThan(0);
    expect(String(reply.text)).toMatch(/stopped/i);
  });

  it('sends a heartbeat while the turn is silent', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    let release!: () => void;
    runAgentTurn.mockImplementation(async () => {
      await new Promise<void>((r) => {
        release = r;
      });
      return ok('Done.');
    });

    const res = await postStream('member-a1', { protocol: 2 });
    const reader = res.body!.getReader();
    // Let the route reach the model call (every await before it is a settled mock).
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
    await vi.advanceTimersByTimeAsync(15_000);

    const first = await readWithin(reader);
    expect(first).toMatch(/^: ping$/m);

    release();
    await vi.advanceTimersByTimeAsync(0);
    let rest = '';
    for (let i = 0; i < 20; i++) rest += await readWithin(reader, 5);
    expect(rest).toContain('event: final');
  });

  it('sends a typed error the client can read', async () => {
    const leaky = () =>
      Object.assign(
        new Error('Malformed input request: arn:aws:bedrock:us-east-1:123456789012:inference-profile/x'),
        { name: 'ValidationException' },
      );

    runAgentTurn.mockRejectedValueOnce(leaky());
    const model = parseSse(await (await postStream('member-a1', { protocol: 2 })).text()).find((e) => e.event === 'error');
    expect(model).toBeDefined();
    const typed = JSON.parse(model!.data) as { code: string; message: string };
    expect(typed.code).toBe('model_error');
    expect(typed.message.trim().length).toBeGreaterThan(0);
    expect(model!.data).not.toMatch(/arn:aws|123456789012|Malformed input/);

    runAgentTurn.mockRejectedValueOnce(new Error('boom at /var/task/dist/lib/x.js:12'));
    const internal = parseSse(await (await postStream('member-a1', { protocol: 2 })).text()).find((e) => e.event === 'error');
    expect(JSON.parse(internal!.data).code).toBe('internal_error');
    expect(internal!.data).not.toMatch(/var\/task/);

    runAgentTurn.mockRejectedValueOnce(new CostCapExceededError(61.5, 50));
    const cap = parseSse(await (await postStream('member-a1', { protocol: 2 })).text()).find((e) => e.event === 'error');
    expect(JSON.parse(cap!.data).code).toBe('cost_cap_exceeded');

    // An older client (no protocol) gets a clean sentence, not JSON and not the raw text.
    runAgentTurn.mockRejectedValueOnce(leaky());
    const legacy = parseSse(await (await postStream('member-a1')).text()).find((e) => e.event === 'error');
    expect(legacy).toBeDefined();
    expect(() => JSON.parse(legacy!.data)).toThrow();
    expect(legacy!.data.trim().length).toBeGreaterThan(0);
    expect(legacy!.data).not.toMatch(/arn:aws|123456789012|Malformed input/);
  });

  it('never sends an error after the final answer', async () => {
    runAgentTurn.mockResolvedValueOnce(ok('The answer.'));
    appendTurns.mockRejectedValueOnce(new Error('ProvisionedThroughputExceededException'));

    const events = parseSse(await (await postStream('member-a1', { protocol: 2 })).text());
    const names = events.map((e) => e.event).filter(Boolean);

    expect(names).toContain('final');
    expect(names).not.toContain('error');
    expect(events.find((e) => e.event === 'done')?.data).toBe('not_saved');
    expect(loggerError).toHaveBeenCalled();
  });

  it('sends deltas to a client that asks for them', async () => {
    runAgentTurn.mockImplementationOnce(async (req: TurnReq) => {
      req.onChunk?.('Hel');
      req.onChunk?.('Hello wor');
      req.onChunk?.('Hello world');
      return ok('Hello world');
    });
    const v2 = parseSse(await (await postStream('member-a1', { protocol: 2 })).text());
    expect(v2.filter((e) => e.event === 'delta').map((e) => JSON.parse(e.data))).toEqual([
      { i: 0, t: 'Hel' },
      { i: 3, t: 'lo wor' },
      { i: 9, t: 'ld' },
    ]);
    expect(v2.some((e) => e.event === 'chunk')).toBe(false);

    // The live redactor can rewrite text already sent; the delta restarts where it changed.
    runAgentTurn.mockImplementationOnce(async (req: TurnReq) => {
      req.onChunk?.('key AKIA');
      req.onChunk?.('key [REDACTED] ok');
      return ok('key [REDACTED] ok');
    });
    const rewrite = parseSse(await (await postStream('member-a1', { protocol: 2 })).text());
    expect(rewrite.filter((e) => e.event === 'delta').map((e) => JSON.parse(e.data))).toEqual([
      { i: 0, t: 'key AKIA' },
      { i: 4, t: '[REDACTED] ok' },
    ]);

    // An older client keeps cumulative chunks and never sees a delta.
    runAgentTurn.mockImplementationOnce(async (req: TurnReq) => {
      req.onChunk?.('Hel');
      req.onChunk?.('Hello wor');
      return ok('Hello wor');
    });
    const v1 = parseSse(await (await postStream('member-a1')).text());
    expect(v1.filter((e) => e.event === 'chunk').map((e) => e.data)).toEqual(['Hel', 'Hello wor']);
    expect(v1.some((e) => e.event === 'delta')).toBe(false);
  });

  it('forwards each tool call and its result', async () => {
    runAgentTurn.mockImplementationOnce(async (req: TurnReq) => {
      req.onToolEvent?.({ name: 'web_search', callIndex: 0, toolUseId: 'tu-1', input: '{"query":"x"}', inputTruncated: false });
      req.onToolResult?.({ name: 'web_search', callIndex: 0, toolUseId: 'tu-1', output: '3 pages', isError: false, truncated: false });
      return ok('Done.', { toolCallCount: 1 });
    });

    const events = parseSse(await (await postStream('member-a1', { protocol: 2 })).text());
    const tool = events.find((e) => e.event === 'tool');
    const result = events.find((e) => e.event === 'tool_result');
    expect(tool).toBeDefined();
    expect(result).toBeDefined();
    expect(JSON.parse(tool!.data)).toMatchObject({
      label: humanizeToolName('web_search'),
      step: 1,
      toolUseId: 'tu-1',
      input: '{"query":"x"}',
      inputTruncated: false,
    });
    expect(JSON.parse(result!.data)).toEqual({ toolUseId: 'tu-1', output: '3 pages', isError: false, truncated: false });
    const order = events.map((e) => e.event);
    expect(order.indexOf('tool')).toBeLessThan(order.indexOf('tool_result'));
    expect(order.indexOf('tool_result')).toBeLessThan(order.indexOf('final'));
  });

  it('stores tool results without their arguments', async () => {
    runAgentTurn.mockImplementationOnce(async (req: TurnReq) => {
      req.onToolEvent?.({ name: 'web_search', callIndex: 0, toolUseId: 'tu-1', input: '{"query":"x"}', inputTruncated: false });
      req.onToolResult?.({ name: 'web_search', callIndex: 0, toolUseId: 'tu-1', output: '3 pages', isError: false, truncated: false });
      return ok('Done.', { toolCallCount: 1 });
    });

    await (await postStream('member-a1', { protocol: 2 })).text();

    const turns = appendTurns.mock.calls[0]![2] as Array<Record<string, unknown>>;
    expect(turns[1]).toMatchObject({
      role: 'assistant',
      text: 'Done.',
      tools: [
        { label: humanizeToolName('web_search'), step: 1, toolUseId: 'tu-1', output: '3 pages', isError: false, truncated: false },
      ],
    });
    // Decision 41: arguments are shown live and never written anywhere.
    const stored = JSON.stringify(appendTurns.mock.calls[0]);
    expect(stored).not.toContain('query');
    expect(stored).not.toContain('"input"');
  });

  it('refuses a model outside the catalog on both send routes', async () => {
    for (const post of [postStream, postTurn]) {
      const res = await post('member-a1', { modelOverride: 'us.anthropic.claude-imaginary-9' });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'unknown_model' });
    }
    expect(runAgentTurn).not.toHaveBeenCalled();
    expect(savesFor(CHAT)).toHaveLength(0);

    // A model the catalog publishes still goes through, unchanged.
    const good = await postStream('member-a1', { modelOverride: HAIKU });
    expect(good.status).toBe(200);
    await good.text();
    expect(runAgentTurn).toHaveBeenCalledWith(expect.objectContaining({ modelOverride: HAIKU }));
  });

  it('refuses an unknown agent on both send routes', async () => {
    for (const post of [postStream, postTurn]) {
      const res = await post('member-a1', { agentId: 'ghost-agent' });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'unknown_agent' });
    }
    expect(runAgentTurn).not.toHaveBeenCalled();
    expect(savesFor(CHAT)).toHaveLength(0);

    const good = await postStream('member-a1', { agentId: 'main' });
    expect(good.status).toBe(200);
    await good.text();
    expect(runAgentTurn).toHaveBeenCalledTimes(1);
  });

  it('never starts a second model call for the same message', async () => {
    beginTurn
      .mockResolvedValueOnce({ started: true })
      .mockResolvedValueOnce({ started: false, status: 'complete', sameMessage: true });

    const first = await postStream('member-a1', { protocol: 2, clientMessageId: 'cm-1' });
    expect(first.status).toBe(200);
    await first.text();
    const again = await postStream('member-a1', { protocol: 2, clientMessageId: 'cm-1' });

    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: 'turn_duplicate', status: 'complete' });
    expect(runAgentTurn).toHaveBeenCalledTimes(1);
    expect(beginTurn).toHaveBeenCalledTimes(2);
    expect(beginTurn.mock.calls[0]!.slice(0, 3)).toEqual([AGENT, CHAT, 'cm-1']);
    // The same message has the same fingerprint both times.
    expect(beginTurn.mock.calls[0]![3]).toBe(beginTurn.mock.calls[1]![3]);
    expect(endTurn).toHaveBeenCalledWith(AGENT, CHAT, 'cm-1', 'complete');

    // A client that sends no id keeps today's behaviour: no turn record at all.
    beginTurn.mockClear();
    await (await postStream('member-a1')).text();
    expect(beginTurn).not.toHaveBeenCalled();
  });

  it('refuses a message id reused for a different message', async () => {
    await (await postStream('member-a1', { protocol: 2, clientMessageId: 'cm-a', text: 'first message' })).text();
    await (await postStream('member-a1', { protocol: 2, clientMessageId: 'cm-b', text: 'another message' })).text();
    expect(beginTurn).toHaveBeenCalledTimes(2);
    expect(beginTurn.mock.calls[0]![3]).not.toBe(beginTurn.mock.calls[1]![3]);

    runAgentTurn.mockClear();
    beginTurn.mockResolvedValueOnce({ started: false, status: 'streaming', sameMessage: false });
    const res = await postStream('member-a1', { protocol: 2, clientMessageId: 'cm-a', text: 'a different message' });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'turn_conflict' });
    expect(runAgentTurn).not.toHaveBeenCalled();
  });
});

/**
 * The step 4 review (six read-only reviewers, 2026-09-23), written BEFORE the fix.
 *
 *   - Two reviewers reproduced it on the repo's own hono and node-server: a reader who
 *     leaves BEFORE the response starts (Stop pressed right after Send, a closed tab)
 *     never fires the stream's onAbort. The turn then runs and bills to the end, the
 *     `final` write waits forever on a body nobody reads, the reply is never saved,
 *     the turn record stays `streaming`, and the heartbeat timer leaks for the life of
 *     the process. The request's own signal has already fired by then.
 *   - An operator's refusal (the cost cap, a kill switch) is a state they chose and is
 *     already audited: logging it at error level pages them in the middle of it.
 *   - A turn record that cannot be written is a typed 503, logged with the turn's id,
 *     not an anonymous "unhandled error".
 *   - The known-agent check must not scan the agents table on every send.
 */
describe('turn lifecycle (P2) — stream route, review fixes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authenticateDashboardToken.mockImplementation(async (raw: string) => PRINCIPALS[raw] ?? null);
    getSession.mockResolvedValue(undefined);
    appendTurns.mockResolvedValue(undefined);
    beginTurn.mockResolvedValue({ started: true });
    endTurn.mockResolvedValue(true);
    runCommand.mockResolvedValue(undefined);
    runAgentTurn.mockResolvedValue(ok('Hi.'));
    writeAudit.mockResolvedValue(undefined);
    send.mockResolvedValue({});
    listKnownAgents.mockReturnValue(['main']);
    listKnownAgentsAsync.mockResolvedValue(['main']);
    vi.stubEnv('BEDROCK_DEFAULT_MODEL', SONNET);
    vi.stubEnv('BEDROCK_SONNET_MODEL', SONNET);
    vi.stubEnv('BEDROCK_HAIKU_MODEL', HAIKU);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it('stops the turn when the reader leaves before the stream starts', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }); // the heartbeat only
    const ac = new AbortController();
    const chat = 'dashboard:1750000000201';
    // The person presses Stop, or closes the tab, while the route is still reading the
    // conversation: the response has not begun.
    getSession.mockImplementationOnce(async () => {
      ac.abort();
      return undefined;
    });
    let seen: AbortSignal | undefined;
    runAgentTurn.mockImplementation(async (req: TurnReq) => {
      seen = req.abortSignal;
      await abortedOrTimeout(req.abortSignal, 1000);
      return req.abortSignal?.aborted ? ok('', { stopped: true }) : ok('A whole answer nobody waited for.');
    });

    await request('member-a1', '/api/test-turn/stream', {
      method: 'POST',
      body: JSON.stringify({ text: 'hello again', agentId: AGENT, chatId: chat, protocol: 2, clientMessageId: 'cm-gone' }),
      signal: ac.signal,
    });
    // Nobody reads the response: the reader is gone.

    await vi.waitFor(() => expect(seen?.aborted).toBe(true), { timeout: 2000 });
    await vi.waitFor(() => expect(endTurn).toHaveBeenCalledWith(AGENT, chat, 'cm-gone', 'stopped'), { timeout: 2500 });
    const reply = (savesFor(chat)[0]![2] as Array<Record<string, unknown>>)[1]!;
    expect(reply).toMatchObject({ role: 'assistant', status: 'stopped' });
    // The route finished: its heartbeat is gone.
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(0), { timeout: 2000 });
  });

  it("never shows the operator's kill-switch reason", async () => {
    // Codex's inspection of the review fixes: the reason is free text an operator
    // typed (it can name an incident, an ARN, an account id), and it reached every
    // chat surface. The operator keeps it in the audit and the logs.
    runAgentTurn.mockRejectedValueOnce(new KillSwitchActiveError('incident 42: arn:aws:iam::123456789012:role/ops-break-glass'));

    const typed = parseSse(await (await postStream('member-a1', { protocol: 2 })).text()).find((e) => e.event === 'error');

    const body = JSON.parse(typed!.data) as { code: string; message: string };
    expect(body.code).toBe('kill_switch_active');
    expect(body.message.trim().length).toBeGreaterThan(0);
    expect(body.message).not.toMatch(/incident|arn:aws|123456789012/);
  });

  it('finishes a slash command whose reader left before the stream started', async () => {
    // Codex's inspection: only the model branch saved before writing. A command (and
    // a media-only turn) still awaited a second write to a body nobody reads, so the
    // route never finished and its heartbeat leaked.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const ac = new AbortController();
    const chat = 'dashboard:1750000000203';
    getSession.mockImplementationOnce(async () => {
      ac.abort();
      return undefined;
    });
    runCommand.mockResolvedValueOnce({ reply: 'pong' });

    await request('member-a1', '/api/test-turn/stream', {
      method: 'POST',
      body: JSON.stringify({ text: '/ping', agentId: AGENT, chatId: chat, protocol: 2, clientMessageId: 'cm-cmd-gone' }),
      signal: ac.signal,
    });

    await vi.waitFor(() => expect(endTurn).toHaveBeenCalledWith(AGENT, chat, 'cm-cmd-gone', 'complete'), { timeout: 2000 });
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(0), { timeout: 2000 });
  });

  it('leaves no timer behind when a turn ends', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });

    await (await postStream('member-a1', { protocol: 2 })).text();

    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps the tool results of a stopped turn', async () => {
    runAgentTurn.mockImplementation(async (req: TurnReq) => {
      req.onToolEvent?.({ name: 'web_search', callIndex: 0, toolUseId: 'tu-1', input: '{"query":"x"}', inputTruncated: false });
      req.onToolResult?.({ name: 'web_search', callIndex: 0, toolUseId: 'tu-1', output: '3 pages', isError: false, truncated: false });
      req.onChunk?.('Partial');
      await abortedOrTimeout(req.abortSignal);
      return ok('Partial', { stopped: true, toolCallCount: 1 });
    });

    const chat = 'dashboard:1750000000202';
    const res = await postStream('member-a1', { protocol: 2, chatId: chat });
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel();

    await vi.waitFor(() => expect(savesFor(chat)).toHaveLength(1), { timeout: 2500 });
    const reply = (savesFor(chat)[0]![2] as Array<Record<string, unknown>>)[1]!;
    expect(reply).toMatchObject({
      status: 'stopped',
      tools: [expect.objectContaining({ toolUseId: 'tu-1', output: '3 pages' })],
    });
  });

  it("logs an operator's refusal as a warning, not an error", async () => {
    runAgentTurn.mockRejectedValueOnce(new CostCapExceededError(61.5, 50));
    const cap = parseSse(await (await postStream('member-a1', { protocol: 2 })).text()).find((e) => e.event === 'error');
    // The message keeps the hint the Chat tab gave before P2.
    expect(JSON.parse(cap!.data).message).toMatch(/Raise it in Cost/);

    runAgentTurn.mockRejectedValueOnce(new KillSwitchActiveError('maintenance window'));
    const paused = parseSse(await (await postStream('member-a1', { protocol: 2 })).text()).find((e) => e.event === 'error');
    expect(JSON.parse(paused!.data).code).toBe('kill_switch_active');

    // Both are states an operator chose, and both are audited already.
    expect(loggerError).not.toHaveBeenCalled();
    expect(loggerWarn).toHaveBeenCalled();
  });

  it('answers 503 when the turn record cannot be written, and names the turn in the log', async () => {
    beginTurn.mockRejectedValueOnce(
      Object.assign(new Error('Throughput exceeds the current capacity'), { name: 'ProvisionedThroughputExceededException' }),
    );

    const res = await postStream('member-a1', { protocol: 2, clientMessageId: 'cm-503' });

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'turn_record_unavailable' });
    expect(runAgentTurn).not.toHaveBeenCalled();
    expect(JSON.stringify(loggerError.mock.calls)).toContain('cm-503');
  });

  it('logs a refused send as a warning', async () => {
    expect((await postStream('member-a1', { agentId: 'ghost-agent' })).status).toBe(404);
    expect((await postStream('member-a1', { modelOverride: 'us.anthropic.claude-imaginary-9' })).status).toBe(400);

    const warned = JSON.stringify(loggerWarn.mock.calls);
    expect(warned).toContain('unknown_agent');
    expect(warned).toContain('unknown_model');
    expect(loggerError).not.toHaveBeenCalled();
  });

  it('does not scan the agents table for an agent it already knows', async () => {
    await (await postStream('member-a1', { agentId: 'main' })).text();
    expect(listKnownAgentsAsync).not.toHaveBeenCalled();

    // An agent it has not seen yet is still looked up before it is refused.
    const res = await postStream('member-a1', { agentId: 'ghost-agent' });
    expect(res.status).toBe(404);
    expect(listKnownAgentsAsync).toHaveBeenCalledTimes(1);
  });
});
