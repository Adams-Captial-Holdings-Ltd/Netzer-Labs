import { describe, it, expect, vi } from 'vitest';
import { streamTurn } from '../../../web/src/lib/chat/stream.js';
import type { TurnCallbacks } from '../../../web/src/lib/chat/stream.js';
import { friendlyStreamError, friendlyTurnError, newMessageId, transcriptToMessages } from '../../../web/src/lib/chat/helpers.js';

// P2 (step 4) — the web client's half of the turn lifecycle. Written BEFORE the
// change, as the bar (netzar-chat-plan/p2-proof.sh rows B-11..B-18). The golden
// tests in chat-stream.test.ts keep pinning the old protocol, which every other
// consumer still speaks; this file pins what a protocol-2 client adds:
//
//   - `delta` events `{i, t}`: keep text[0..i) and append t. Positional, because
//     the server's live redactor can rewrite text it already sent.
//   - `tool` carries `toolUseId`, the capped `input` and `inputTruncated`;
//     `tool_result` carries `{toolUseId, output, isError, truncated}` and lands on
//     the matching call (decisions 37 + 41).
//   - `error` data is `{code, message}` JSON; an older server's plain string still
//     works.
//   - `done: not_saved` means the answer arrived but the server could not store it.
//   - `: ping` heartbeat comments carry nothing (a guard: this already holds).
//   - a reopened conversation keeps the `stopped` mark and the tool results.
//
// Imports stay DOM-free (see chat-stream.test.ts's note on the root tsc program).

interface FetchCall {
  url: string;
  init: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal };
}

function sseFetch(reads: string[]) {
  const calls: FetchCall[] = [];
  const impl = ((url: unknown, init?: unknown) => {
    calls.push({ url: String(url), init: (init ?? {}) as FetchCall['init'] });
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const r of reads) controller.enqueue(encoder.encode(r));
        controller.close();
      },
    });
    return Promise.resolve({ ok: true, body });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function recorder() {
  const chunks: string[] = [];
  const statuses: string[] = [];
  const toolSnapshots: unknown[] = [];
  const cb: TurnCallbacks = {
    onChunk: (t) => chunks.push(t),
    onToolStatus: (s) => statuses.push(s),
    onTools: (tools) => toolSnapshots.push(structuredClone(tools)),
  };
  return { cb, chunks, statuses, toolSnapshots };
}

const body = { text: 'hi', agentId: 'a1', chatId: 'dashboard:1' };
const FINAL = (text: string) =>
  `event: final\ndata: ${JSON.stringify({ text, modelId: 'm', latencyMs: 1, costUsd: 0.01, toolCallCount: 0 })}\n\n`;

async function run(reads: string[]) {
  const { impl, calls } = sseFetch(reads);
  const rec = recorder();
  const outcome = await streamTurn(body, 'tok', rec.cb, { fetchImpl: impl });
  return { outcome, calls, ...rec };
}

describe('turn lifecycle (P2) — web client', () => {
  it('applies delta events by position', async () => {
    const { outcome, chunks } = await run([
      'event: delta\ndata: {"i":0,"t":"Hel"}\n\n',
      'event: delta\ndata: {"i":3,"t":"lo wor"}\n\n',
      'event: delta\ndata: {"i":6,"t":"there\\n\\nNext"}\n\n',
      FINAL('Hello there\n\nNext'),
    ]);
    expect(chunks).toEqual(['Hel', 'Hello wor', 'Hello there\n\nNext']);
    expect(outcome.text).toBe('Hello there\n\nNext');
  });

  it('attaches each tool result to its call', async () => {
    const { outcome } = await run([
      'event: tool\ndata: {"label":"web search","step":1,"toolUseId":"tu-1","input":"{\\"q\\":\\"x\\"}","inputTruncated":false}\n\n',
      'event: tool_result\ndata: {"toolUseId":"tu-1","output":"3 pages","isError":false,"truncated":false}\n\n',
      'event: tool\ndata: {"label":"Slack: search public","step":2,"toolUseId":"tu-2","input":"{}","inputTruncated":false}\n\n',
      'event: tool_result\ndata: {"toolUseId":"tu-2","output":"not connected","isError":true,"truncated":false}\n\n',
      FINAL('Done.'),
    ]);
    expect(outcome.tools).toEqual([
      { label: 'web search', step: 1, toolUseId: 'tu-1', input: '{"q":"x"}', inputTruncated: false, output: '3 pages', isError: false, truncated: false },
      { label: 'Slack: search public', step: 2, toolUseId: 'tu-2', input: '{}', inputTruncated: false, output: 'not connected', isError: true, truncated: false },
    ]);
  });

  it('reads a typed error and an old plain one', async () => {
    const typed = await run([
      'event: error\ndata: {"code":"model_error","message":"The model could not answer. Try again."}\n\n',
    ]);
    expect(typed.outcome.errorText).toBe('The model could not answer. Try again.');
    expect(typed.outcome.errorCode).toBe('model_error');

    const legacy = await run(['event: error\ndata: cost_cap_exceeded\n\n']);
    expect(legacy.outcome.errorText).toBe('cost_cap_exceeded');
    expect(legacy.outcome.errorCode).toBeUndefined();
  });

  it('notices a turn the server could not save', async () => {
    const lost = await run([FINAL('Answer.'), 'event: done\ndata: not_saved\n\n']);
    expect(lost.outcome.text).toBe('Answer.');
    expect(lost.outcome.saved).toBe(false);

    const kept = await run([FINAL('Answer.'), 'event: done\ndata: ok\n\n']);
    expect(kept.outcome.saved).toBe(true);
  });

  it('ignores heartbeat comments', async () => {
    const { outcome, chunks, statuses } = await run([
      ': ping\n\n',
      'event: chunk\ndata: Hi\n\n',
      ': ping\n\n',
      FINAL('Hi there'),
    ]);
    expect(chunks).toEqual(['Hi']);
    expect(statuses).toEqual(['']);
    expect(outcome.text).toBe('Hi there');
  });

  it('sends the message id and asks for deltas', async () => {
    const { impl, calls } = sseFetch([FINAL('ok')]);
    await streamTurn({ ...body, clientMessageId: 'cm-9', protocol: 2 }, 'tok', recorder().cb, { fetchImpl: impl });
    expect(JSON.parse(calls[0]!.init.body ?? '')).toEqual({
      text: 'hi',
      agentId: 'a1',
      chatId: 'dashboard:1',
      clientMessageId: 'cm-9',
      protocol: 2,
    });
  });

  it('hands over tool calls as they arrive', async () => {
    const { toolSnapshots } = await run([
      'event: tool\ndata: {"label":"web search","step":1,"toolUseId":"tu-1","input":"{}","inputTruncated":false}\n\n',
      'event: tool_result\ndata: {"toolUseId":"tu-1","output":"found","isError":false,"truncated":false}\n\n',
      FINAL('Done.'),
    ]);
    // Once when the call starts, once when its result lands — so a turn the person
    // stops mid-way still has the calls that already ran.
    expect(toolSnapshots).toEqual([
      [{ label: 'web search', step: 1, toolUseId: 'tu-1', input: '{}', inputTruncated: false }],
      [{ label: 'web search', step: 1, toolUseId: 'tu-1', input: '{}', inputTruncated: false, output: 'found', isError: false, truncated: false }],
    ]);
  });

  it('rebuilds stopped turns and tool results from a transcript', () => {
    const messages = transcriptToMessages([
      { role: 'user', text: 'what broke?', ts: 1 },
      {
        role: 'assistant',
        text: 'The deploy pointed at',
        ts: 2,
        status: 'stopped',
        tools: [{ label: 'web search', step: 1, toolUseId: 'tu-1', output: 'found', isError: false, truncated: false }],
      },
      { role: 'user', text: 'and now?', ts: 3 },
      { role: 'assistant', text: 'Fixed.', ts: 4 },
    ]);
    expect(messages).toEqual([
      { role: 'user', text: 'what broke?', ts: 1 },
      {
        role: 'assistant',
        text: 'The deploy pointed at',
        ts: 2,
        stopped: true,
        tools: [{ label: 'web search', step: 1, toolUseId: 'tu-1', output: 'found', isError: false, truncated: false }],
      },
      { role: 'user', text: 'and now?', ts: 3 },
      { role: 'assistant', text: 'Fixed.', ts: 4 },
    ]);
  });
});

// The step 4 review, written BEFORE the fix:
//   - the refusals P2 added before a stream starts (unknown model or agent, a turn
//     record that could not be written) reached the page as a bare "Stream failed";
//   - a typed error's message is plain English already, and the old sanitiser, written
//     for raw codes, prefixed it with "Something went wrong:" and dropped the cost cap's
//     hint;
//   - one malformed positional delta corrupted every later one;
//   - `crypto.randomUUID` exists only on a secure page, and Send died silently without it.
describe('turn lifecycle (P2) — web client, review fixes', () => {
  it('carries the reason when the server refuses a turn before it starts', async () => {
    const impl = (() =>
      Promise.resolve(new Response(JSON.stringify({ error: 'unknown_model' }), { status: 400 }))) as unknown as typeof fetch;

    const err = await streamTurn(body, 'tok', recorder().cb, { fetchImpl: impl }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('Stream failed'); // what the golden tests pin
    expect((err as { code?: string }).code).toBe('unknown_model');
  });

  it('ignores a delta that is not well formed', async () => {
    const { impl } = sseFetch([
      'event: delta\ndata: {"i":0,"t":"Hel"}\n\n',
      'event: delta\ndata: {"i":3}\n\n',
      'event: delta\ndata: {"i":"x","t":"??"}\n\n',
      'event: delta\ndata: {"i":3,"t":"lo"}\n\n',
    ]);
    const r = recorder();

    const out = await streamTurn(body, 'tok', r.cb, { fetchImpl: impl });

    expect(out.text).toBe('Hello');
    expect(r.chunks.at(-1)).toBe('Hello');
  });

  it('shows a typed error in the words the server chose, and an old one as before', () => {
    expect(friendlyTurnError('Something went wrong on our side. Try again.', 'internal_error'))
      .toBe('Something went wrong on our side. Try again.');
    expect(friendlyTurnError('An operator has paused this: maintenance window', 'kill_switch_active'))
      .toBe('An operator has paused this: maintenance window');
    // No code: an older server's wire text still goes through the old sanitiser.
    expect(friendlyTurnError('kill_switch_active: tool_use')).toBe(friendlyStreamError('kill_switch_active: tool_use'));
    // A refusal before the stream says what to do about it.
    expect(friendlyTurnError('Stream failed', 'unknown_model')).toMatch(/model/i);
    expect(friendlyTurnError('Stream failed', 'unknown_agent')).toMatch(/agent/i);
    expect(friendlyTurnError('Stream failed', 'turn_record_unavailable')).toMatch(/try again/i);
    for (const code of ['unknown_model', 'unknown_agent', 'turn_record_unavailable']) {
      expect(friendlyTurnError('Stream failed', code)).not.toMatch(/Stream failed/);
    }
  });

  it('makes a message id the server accepts, even where randomUUID is missing', () => {
    const accepted = /^[A-Za-z0-9._:-]{1,64}$/; // src/adapters/dashboard/handler.ts
    expect(newMessageId()).toMatch(accepted);

    vi.stubGlobal('crypto', {}); // a page served over plain HTTP
    try {
      const a = newMessageId();
      const b = newMessageId();
      expect(a).toMatch(accepted);
      expect(a).not.toBe(b);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
