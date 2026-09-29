import { describe, it, expect } from 'vitest';
import { streamTurn } from '../../../web/src/lib/chat/stream.js';
import type { TurnCallbacks } from '../../../web/src/lib/chat/stream.js';

// Golden tests for streamTurn(), the SSE turn-stream parser extracted from
// web/src/pages/Chat.tsx send(). Almost all of these encode the parser's
// PRE-refactor semantics exactly — where a test and the source disagree, the
// source wins.
//
// TWO BLOCKS ARE NOT GOLDEN. `outcome.tools` accumulation and the
// abort/AbortSignal plumbing are ADDITIVE in Phase 0: send() had no
// counterpart for either, so those tests pin NEW behavior rather than
// pre-refactor behavior. They are marked inline where they appear.
//
// NOTE on the import path: a web/ module imported from a test under src/
// enters the ROOT tsc program (tsconfig `exclude: ["web"]` only filters the
// include globs, not import-reachable files). That is why the chat lib's
// internal imports carry `.js` extensions (NodeNext) and why this test only
// imports DOM-free modules (stream/helpers/types — never markdown or uploads).

interface FetchCall {
  url: string;
  init: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal };
}

/** A fake fetch whose response body replays `reads` as separate read() results. */
function sseFetch(reads: string[], opts: { ok?: boolean; nullBody?: boolean } = {}) {
  const calls: FetchCall[] = [];
  const impl = ((url: unknown, init?: unknown) => {
    calls.push({ url: String(url), init: (init ?? {}) as FetchCall['init'] });
    if (opts.ok === false) return Promise.resolve({ ok: false, body: null });
    if (opts.nullBody) return Promise.resolve({ ok: true, body: null });
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

/** Callback recorder. */
function recorder() {
  const chunks: string[] = [];
  const statuses: string[] = [];
  const cb: TurnCallbacks = {
    onChunk: (t) => chunks.push(t),
    onToolStatus: (s) => statuses.push(s),
  };
  return { cb, chunks, statuses };
}

const body = { text: 'hi', agentId: 'a1', chatId: 'dashboard:1' };

async function run(reads: string[]) {
  const { impl } = sseFetch(reads);
  const { cb, chunks, statuses } = recorder();
  const outcome = await streamTurn(body, 'tok', cb, { fetchImpl: impl });
  return { outcome, chunks, statuses };
}

describe('streamTurn request shape', () => {
  it('POSTs the default endpoint with bearer auth and a minimal JSON body', async () => {
    const { impl, calls } = sseFetch(['data: ok\n\n']);
    const { cb } = recorder();
    await streamTurn(body, 'tok', cb, { fetchImpl: impl });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('/api/test-turn/stream');
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.headers).toEqual({
      Authorization: 'Bearer tok',
      'Content-Type': 'application/json',
    });
    // No modelOverride and no attachments keys when absent — byte-parity with
    // the pre-refactor conditional spreads in Chat.tsx send().
    expect(JSON.parse(calls[0].init.body ?? '')).toEqual({
      text: 'hi',
      agentId: 'a1',
      chatId: 'dashboard:1',
    });
  });

  it('includes modelOverride and attachments only when present/non-empty', async () => {
    const { impl, calls } = sseFetch(['data: ok\n\n']);
    const { cb } = recorder();
    await streamTurn(
      {
        ...body,
        modelOverride: 'm-1',
        attachments: [{ s3Key: 'k', fileName: 'f.pdf', mimeType: 'application/pdf' }],
      },
      'tok',
      cb,
      { fetchImpl: impl },
    );
    expect(JSON.parse(calls[0].init.body ?? '')).toEqual({
      text: 'hi',
      agentId: 'a1',
      chatId: 'dashboard:1',
      modelOverride: 'm-1',
      attachments: [{ s3Key: 'k', fileName: 'f.pdf', mimeType: 'application/pdf' }],
    });
  });

  it('omits an empty modelOverride and an empty attachments array', async () => {
    const { impl, calls } = sseFetch(['data: ok\n\n']);
    const { cb } = recorder();
    await streamTurn({ ...body, modelOverride: '', attachments: [] }, 'tok', cb, {
      fetchImpl: impl,
    });
    expect(JSON.parse(calls[0].init.body ?? '')).toEqual({
      text: 'hi',
      agentId: 'a1',
      chatId: 'dashboard:1',
    });
  });

  it('omits the signal KEY entirely when no AbortSignal is passed', async () => {
    const { impl, calls } = sseFetch(['data: ok\n\n']);
    const { cb } = recorder();
    await streamTurn(body, 'tok', cb, { fetchImpl: impl });
    // The source spreads `...(opts.signal ? { signal: opts.signal } : {})`, so
    // the key is ABSENT — not present-and-undefined. Some fetch polyfills treat
    // an explicit `signal: undefined` as a type error, which is why the
    // conditional spread (not `signal: opts.signal`) is the shape to pin.
    expect('signal' in calls[0].init).toBe(false);
    expect(Object.keys(calls[0].init).sort()).toEqual(['body', 'headers', 'method']);
  });

  it('honours the endpoint override', async () => {
    const { impl, calls } = sseFetch(['data: ok\n\n']);
    const { cb } = recorder();
    await streamTurn(body, 'tok', cb, { fetchImpl: impl, endpoint: '/api/other' });
    expect(calls[0].url).toBe('/api/other');
  });

  it('throws "Stream failed" on a non-ok response', async () => {
    const { impl } = sseFetch([], { ok: false });
    const { cb } = recorder();
    await expect(streamTurn(body, 'tok', cb, { fetchImpl: impl })).rejects.toThrow('Stream failed');
  });

  it('throws "Stream failed" on an ok response with no body', async () => {
    const { impl } = sseFetch([], { nullBody: true });
    const { cb } = recorder();
    await expect(streamTurn(body, 'tok', cb, { fetchImpl: impl })).rejects.toThrow('Stream failed');
  });
});

describe('streamTurn delta semantics', () => {
  it('rejoins multiple "data:" lines of one event with \\n', async () => {
    // The rejoin happens BEFORE the JSON parse: split the delta object itself
    // across two "data:" lines (at a point where JSON permits insignificant
    // whitespace) and it must still come out as one object.
    const { chunks } = await run(['event: delta\ndata: {\ndata: "i":0,"t":"joined"}\n\n']);
    expect(chunks).toEqual(['joined']);
  });

  it("preserves leading whitespace inside a delta's text verbatim — no implicit trim", async () => {
    // Delta text can carry markdown, where leading spaces ARE the code block.
    // `delta.t` is spliced into fullText and handed to onChunk exactly as
    // JSON.parse produced it — nothing trims it.
    const { outcome, chunks } = await run(['event: delta\ndata: {"i":0,"t":"    indented code"}\n\n']);
    expect(chunks).toEqual(['    indented code']);
    expect(outcome.text).toBe('    indented code');
  });

  it("preserves interior and trailing whitespace in a delta's text too", async () => {
    const { outcome } = await run(['event: delta\ndata: {"i":0,"t":"  a  b  "}\n\n']);
    expect(outcome.text).toBe('  a  b  ');
  });

  it('trims the "event:" name, so a trailing space still routes as delta', async () => {
    // `line.slice(7).trim()` — without the trim the event would be 'delta ',
    // fall through every branch, and the text would vanish.
    const { outcome, chunks } = await run(['event: delta \ndata: {"i":0,"t":"x"}\n\n']);
    expect(chunks).toEqual(['x']);
    expect(outcome.text).toBe('x');
  });

  it('parses an event split across read() boundaries mid-line', async () => {
    const { chunks, outcome } = await run(['event: del', 'ta\ndata: {"i":0,"t":"he', 'llo"}\n\n']);
    expect(chunks).toEqual(['hello']);
    expect(outcome.text).toBe('hello');
  });

  it('a blank line resets the event type, so unprefixed data after it is ignored', async () => {
    const { chunks, statuses } = await run([
      'event: tool\ndata: {"label":"web search","step":1}\n\ndata: resumed\n\n',
    ]);
    // curEvent resets to '' after the blank line — NOT to the previous event
    // name — so the un-prefixed data that follows matches no branch and is
    // silently dropped.
    expect(statuses).toEqual(['web search…']);
    expect(chunks).toEqual([]);
  });

  it('flushes a trailing event whose terminating blank line never arrived', async () => {
    const { chunks, outcome } = await run(['event: delta\ndata: {"i":0,"t":"done-ish"}\n']);
    expect(chunks).toEqual(['done-ish']);
    expect(outcome.text).toBe('done-ish');
  });

  it('drops a final line with no terminating newline (stays in the buffer)', async () => {
    const { outcome, chunks } = await run([
      'event: delta\ndata: {"i":0,"t":"kept"}\n\nevent: delta\ndata: {"i":4,"t":"lost"}',
    ]);
    expect(chunks).toEqual(['kept']);
    expect(outcome.text).toBe('kept');
  });

  it('documents the pre-existing CRLF limitation — the server uses LF', async () => {
    // KNOWN LIMITATION, inherited verbatim from the pre-refactor parser. The
    // loop splits on '\n' only, so under CRLF the event-terminator line is
    // '\r', not '' — it matches none of the three branches and flushEvent()
    // therefore never fires mid-stream. Everything collapses into ONE
    // trailing flush, and the two delta payloads below get rejoined by the
    // multiline "data:" rule into a single blob that is no longer valid
    // JSON — so the trailing flush's wellFormedDelta parse fails and BOTH
    // deltas are lost, not just corrupted the way cumulative chunk text was.
    //
    // This is not hit in practice: the server side is Hono's streamSSE, which
    // emits LF line endings. The assertion below pins the CURRENT behavior so
    // that changing it is a deliberate decision rather than an accident — do
    // NOT "fix" the parser to satisfy this test.
    const { outcome, chunks, statuses } = await run([
      'event: delta\r\ndata: {"i":0,"t":"Hello"}\r\n\r\n',
      'event: delta\r\ndata: {"i":5,"t":" world"}\r\n\r\n',
    ]);
    expect(chunks).toEqual([]);
    expect(outcome.text).toBe('');
    expect(statuses).toEqual([]);
  });
});

describe('streamTurn final/meta semantics', () => {
  it('parses final JSON after the loop; meta only when costUsd is a number', async () => {
    const final = JSON.stringify({
      text: 'Hi there',
      modelId: 'us.anthropic.claude-sonnet-4-5',
      latencyMs: 1234,
      costUsd: 0.0123,
      toolCallCount: 2,
    });
    const { outcome } = await run([`event: final\ndata: ${final}\n\n`]);
    expect(outcome.text).toBe('Hi there');
    expect(outcome.meta).toEqual({
      modelId: 'us.anthropic.claude-sonnet-4-5',
      latencyMs: 1234,
      costUsd: 0.0123,
      toolCallCount: 2,
    });
  });

  it('applies the meta field fallbacks for absent modelId/latencyMs/toolCallCount', async () => {
    const { outcome } = await run(['event: final\ndata: {"text":"T","costUsd":0.5}\n\n']);
    expect(outcome.meta).toEqual({ modelId: '', latencyMs: 0, costUsd: 0.5, toolCallCount: 0 });
  });

  it('keeps an EXPLICIT empty text as empty — `??`, not `||`', async () => {
    // `parsed.text ?? fullText` is nullish-coalescing on purpose. Under `||` an
    // empty (but present) text would be falsy and the raw JSON payload would be
    // dumped into the bubble instead of an empty reply.
    const { outcome } = await run(['event: final\ndata: {"text":"","costUsd":0.01}\n\n']);
    expect(outcome.text).toBe('');
    expect(outcome.meta).toEqual({ modelId: '', latencyMs: 0, costUsd: 0.01, toolCallCount: 0 });
  });

  it('still yields meta when costUsd is exactly 0', async () => {
    // The guard is `typeof parsed.costUsd === 'number'`, not truthiness — a
    // free turn still gets a footer, showing $0.00 rather than showing nothing.
    const { outcome } = await run(['event: final\ndata: {"text":"free","costUsd":0}\n\n']);
    expect(outcome.text).toBe('free');
    expect(outcome.meta).toEqual({ modelId: '', latencyMs: 0, costUsd: 0, toolCallCount: 0 });
  });

  it('yields NO meta when costUsd is not a number', async () => {
    const { outcome } = await run(['event: final\ndata: {"text":"T","costUsd":"0.5"}\n\n']);
    expect(outcome.text).toBe('T');
    expect(outcome.meta).toBeUndefined();
  });

  it('falls back to the raw payload when final is not JSON', async () => {
    const { outcome } = await run(['event: final\ndata: not json at all\n\n']);
    expect(outcome.text).toBe('not json at all');
    expect(outcome.meta).toBeUndefined();
  });

  it('keeps the raw JSON string as text when the final JSON has no text field', async () => {
    const { outcome } = await run(['event: final\ndata: {"costUsd":0.02}\n\n']);
    expect(outcome.text).toBe('{"costUsd":0.02}');
    expect(outcome.meta).toEqual({ modelId: '', latencyMs: 0, costUsd: 0.02, toolCallCount: 0 });
  });

  it('a final event does not invoke onChunk', async () => {
    const { chunks } = await run(['event: final\ndata: {"text":"quiet"}\n\n']);
    expect(chunks).toEqual([]);
  });
});

describe('streamTurn reply semantics', () => {
  it('a reply event sets isReply, surfaces the text directly, and skips JSON parsing', async () => {
    const { outcome, chunks } = await run(['event: reply\ndata: {"text":"not parsed"}\n\n']);
    expect(outcome.isReply).toBe(true);
    // Reply payloads are plain text — even JSON-looking ones stay raw.
    expect(outcome.text).toBe('{"text":"not parsed"}');
    expect(outcome.meta).toBeUndefined();
    // The live preview is updated with the reply text.
    expect(chunks).toEqual(['{"text":"not parsed"}']);
  });
});

describe('streamTurn error semantics', () => {
  it('captures an error event and preserves the prior partial text unparsed', async () => {
    const { outcome } = await run([
      `event: delta\ndata: ${JSON.stringify({ i: 0, t: '{"text":"partial"}' })}\n\n`,
      'event: error\ndata: boom\n\n',
    ]);
    expect(outcome.errorText).toBe('boom');
    // Error path skips the post-loop JSON parse: raw partial stays raw.
    expect(outcome.text).toBe('{"text":"partial"}');
    expect(outcome.meta).toBeUndefined();
  });

  it('captures an error that arrives before any chunk', async () => {
    const { outcome, chunks } = await run(['event: error\ndata: kill_switch_active: tool_use\n\n']);
    expect(outcome.errorText).toBe('kill_switch_active: tool_use');
    expect(outcome.text).toBe('');
    expect(chunks).toEqual([]);
  });

  it('keeps the LAST error when two error events arrive in one stream', async () => {
    // `errorText = curData` assigns, it does not append or first-write-wins:
    // the most recent failure is the one the user sees.
    const { outcome } = await run([
      'event: error\ndata: first failure\n\n',
      'event: error\ndata: second failure\n\n',
    ]);
    expect(outcome.errorText).toBe('second failure');
  });

  it('does not map the error to friendly copy — that is the caller job', async () => {
    const { outcome } = await run(['event: error\ndata: daily cost cap exceeded: $1.50 >= $1.00\n\n']);
    expect(outcome.errorText).toBe('daily cost cap exceeded: $1.50 >= $1.00');
  });
});

describe('streamTurn tool/media status events', () => {
  it('formats tool status exactly: label… for step 1, label… (step N) above', async () => {
    const { statuses } = await run([
      'event: tool\ndata: {"label":"web search","step":1}\n\n',
      'event: tool\ndata: {"label":"Slack: search public","step":3}\n\n',
    ]);
    expect(statuses).toEqual(['web search…', 'Slack: search public… (step 3)']);
  });

  it('step 2 is the first step to carry the "(step N)" suffix — the > 1 boundary', async () => {
    // The suffix threshold is `t.step > 1`. Testing only steps 1 and 3 leaves
    // `> 2` indistinguishable from `> 1`; step 2 is the value that separates
    // them, and it DOES get the suffix.
    const { statuses } = await run([
      'event: tool\ndata: {"label":"Slack: search public","step":2}\n\n',
    ]);
    expect(statuses).toEqual(['Slack: search public… (step 2)']);
  });

  it('a media event with an EMPTY label yields an empty status — `??`, not `||`', async () => {
    // `m.label ?? \`Processing ${m.fileName}…\`` keeps a deliberately blank
    // label blank (it clears the status row). Under `||` the fileName fallback
    // would fire and resurrect a status line the server asked to clear.
    const { statuses } = await run(['event: media\ndata: {"label":"","fileName":"a.mp3"}\n\n']);
    expect(statuses).toEqual(['']);
  });

  // additive in Phase 0 — no pre-refactor counterpart (see docs/features/netzar-chat/plan.md)
  it('accumulates tool events into outcome.tools', async () => {
    const { outcome } = await run([
      'event: tool\ndata: {"label":"web search","step":1}\n\n',
      'event: tool\ndata: {"label":"Slack: search public","step":2}\n\n',
      'event: final\ndata: {"text":"done"}\n\n',
    ]);
    expect(outcome.tools).toEqual([
      { label: 'web search', step: 1 },
      { label: 'Slack: search public', step: 2 },
    ]);
  });

  it('uses media label when present, else "Processing <fileName>…"', async () => {
    const { statuses } = await run([
      'event: media\ndata: {"fileName":"a.mp3","stage":"transcribe","label":"Transcribing a.mp3…"}\n\n',
      'event: media\ndata: {"fileName":"b.mp4","stage":"frames"}\n\n',
    ]);
    expect(statuses).toEqual(['Transcribing a.mp3…', 'Processing b.mp4…']);
  });

  it('silently ignores malformed JSON in tool and media events', async () => {
    const { outcome, statuses } = await run([
      'event: tool\ndata: not-json\n\n',
      'event: media\ndata: {broken\n\n',
      'event: delta\ndata: {"i":0,"t":"fine"}\n\n',
    ]);
    expect(statuses).toEqual(['']); // only the chunk's status clear
    expect(outcome.tools).toEqual([]);
    expect(outcome.text).toBe('fine');
  });
});

describe('streamTurn kb/image/artifact accumulation', () => {
  it('accumulates kb chips, images and artifacts with their field fallbacks', async () => {
    const { outcome } = await run([
      'event: kb\ndata: {"text":"Indexed report.pdf"}\n\n',
      'event: kb\ndata: {"nope":true}\n\n',
      'event: image\ndata: {"url":"https://x/i.png","caption":"a chart"}\n\n',
      'event: image\ndata: {"url":"https://x/j.png"}\n\n',
      'event: image\ndata: {"caption":"no url"}\n\n',
      'event: artifact\ndata: {"url":"https://x/d.pdf","name":"report.pdf"}\n\n',
      'event: artifact\ndata: {"url":"https://x/e.pdf","caption":"fallback cap"}\n\n',
      'event: artifact\ndata: {"url":"https://x/f.pdf"}\n\n',
      'event: artifact\ndata: {"name":"no url"}\n\n',
      'event: final\ndata: {"text":"done"}\n\n',
    ]);
    expect(outcome.kb).toEqual(['Indexed report.pdf']);
    expect(outcome.images).toEqual([
      { url: 'https://x/i.png', caption: 'a chart' },
      { url: 'https://x/j.png', caption: '' },
    ]);
    expect(outcome.artifacts).toEqual([
      { url: 'https://x/d.pdf', name: 'report.pdf' },
      { url: 'https://x/e.pdf', name: 'fallback cap' },
      { url: 'https://x/f.pdf', name: 'document' },
    ]);
  });

  it('an EMPTY artifact name falls through to caption — `||`, not `??`', async () => {
    // `a.name || a.caption || 'document'` is a truthiness chain on purpose: an
    // empty name is as useless as a missing one, so it must fall through. Under
    // `??` the card would render with a blank label.
    const { outcome } = await run([
      'event: artifact\ndata: {"url":"u","name":"","caption":"cap"}\n\n',
      'event: artifact\ndata: {"url":"u2","name":"","caption":""}\n\n',
    ]);
    expect(outcome.artifacts).toEqual([
      { url: 'u', name: 'cap' },
      { url: 'u2', name: 'document' }, // both empty — the whole chain falls to the literal
    ]);
  });

  it('an EMPTY image caption stays empty — `??` keeps the blank string', async () => {
    // `im.caption ?? ''` — a present-but-empty caption is preserved as '', so
    // the image renders with no caption row rather than a placeholder.
    const { outcome } = await run(['event: image\ndata: {"url":"u","caption":""}\n\n']);
    expect(outcome.images).toEqual([{ url: 'u', caption: '' }]);
  });

  it('image caption coalesces on NULLISH only, not on falsy', async () => {
    // The empty-string case above cannot tell `??` from `||` (both yield '').
    // A falsy-but-not-nullish caption is the only input that separates them:
    // `??` passes it through untouched, `||` would swap in ''. Malformed server
    // input, but it is what pins the operator.
    const { outcome } = await run([
      'event: image\ndata: {"url":"u","caption":0}\n\n',
      'event: image\ndata: {"url":"v","caption":null}\n\n',
    ]);
    expect(outcome.images).toEqual([
      { url: 'u', caption: 0 }, // `??` does not fire on 0
      { url: 'v', caption: '' }, // null IS nullish, so the '' fallback fires
    ]);
  });

  it('silently ignores malformed JSON in kb/image/artifact events', async () => {
    const { outcome } = await run([
      'event: kb\ndata: {bad\n\n',
      'event: image\ndata: bad\n\n',
      'event: artifact\ndata: [}\n\n',
      'event: delta\ndata: {"i":0,"t":"ok"}\n\n',
    ]);
    expect(outcome.kb).toEqual([]);
    expect(outcome.images).toEqual([]);
    expect(outcome.artifacts).toEqual([]);
    expect(outcome.text).toBe('ok');
  });
});

describe('streamTurn done and unknown events', () => {
  it('ignores done events and unknown event types', async () => {
    const { outcome, chunks, statuses } = await run([
      'event: delta\ndata: {"i":0,"t":"hello"}\n\n',
      'event: done\ndata: {"ok":true}\n\n',
      'event: mystery\ndata: whatever\n\n',
    ]);
    expect(outcome.text).toBe('hello');
    expect(chunks).toEqual(['hello']);
    expect(statuses).toEqual(['']);
  });
});

describe('streamTurn abort', () => {
  // additive in Phase 0 — no pre-refactor counterpart (see docs/features/netzar-chat/plan.md)
  it('passes the signal to fetch and rejects cleanly when the read aborts', async () => {
    let received: AbortSignal | undefined;
    const impl = ((_url: unknown, init?: unknown) => {
      const i = (init ?? {}) as { signal?: AbortSignal };
      received = i.signal;
      const encoder = new TextEncoder();
      const bodyStream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('event: delta\ndata: {"i":0,"t":"partial"}\n\n'));
          i.signal?.addEventListener('abort', () => {
            controller.error(new DOMException('The operation was aborted.', 'AbortError'));
          });
          // Never closes: the abort is the only way out, as with a live stream.
        },
      });
      return Promise.resolve({ ok: true, body: bodyStream });
    }) as unknown as typeof fetch;

    const ac = new AbortController();
    const chunks: string[] = [];
    const cb: TurnCallbacks = {
      onChunk: (t) => {
        chunks.push(t);
        ac.abort(); // abort as soon as the first chunk lands
      },
      onToolStatus: () => {},
    };
    const p = streamTurn(body, 'tok', cb, { fetchImpl: impl, signal: ac.signal });
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(received).toBe(ac.signal);
    expect(chunks).toEqual(['partial']);
  });
});
