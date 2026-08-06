import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createNovaSonicSession,
  parseUsageEvent,
  __setNovaClientForTest,
  type NovaSonicCallbacks,
} from './nova-sonic.js';

// The Bedrock hard-stop guard does a real kill-switch DDB read before the send.
// Stub it to a pass-through so this timing-sensitive mock-stream test does not
// depend on a live read (or a cache pre-warmed by test ordering). The guard
// itself is covered by src/lib/bedrock/guard.test.ts.
vi.mock('../bedrock/guard.js', () => ({
  guardedBedrockSend: (send: () => Promise<unknown>) => send(),
  assertBedrockAllowed: async () => {},
}));

const enc = new TextEncoder();
const flush = () => new Promise((r) => setTimeout(r, 15));

/** A controllable async-iterable output stream for the fake Bedrock client. */
function controllableStream() {
  const q: unknown[] = [];
  const waiters: Array<(r: IteratorResult<unknown>) => void> = [];
  let closed = false;
  return {
    push(ev: unknown) {
      const w = waiters.shift();
      if (w) w({ value: ev, done: false });
      else q.push(ev);
    },
    close() {
      closed = true;
      let w;
      while ((w = waiters.shift())) w({ value: undefined, done: true });
    },
    iterable: {
      [Symbol.asyncIterator]() {
        return {
          next: (): Promise<IteratorResult<unknown>> => {
            if (q.length) return Promise.resolve({ value: q.shift(), done: false });
            if (closed) return Promise.resolve({ value: undefined, done: true });
            return new Promise((res) => waiters.push(res));
          },
        };
      },
    },
  };
}

/** A Nova OUTPUT chunk: { chunk: { bytes: utf8(JSON({event:{<type>:payload}})) } }. */
function out(type: string, payload: unknown) {
  return { chunk: { bytes: enc.encode(JSON.stringify({ event: { [type]: payload } })) } };
}

function makeCallbacks(): NovaSonicCallbacks & { calls: Record<string, unknown[]> } {
  const calls: Record<string, unknown[]> = { audio: [], text: [], barge: [], tool: [], err: [], close: [], usage: [] };
  return {
    calls,
    onAudioOut: (b64) => calls.audio.push(b64),
    onTextTranscript: (t, role) => calls.text.push({ t, role }),
    onBargeIn: () => calls.barge.push(true),
    onToolUse: async (id, name, input) => {
      calls.tool.push({ id, name, input });
      return { ok: true };
    },
    onError: (e) => calls.err.push(e.message),
    onClose: () => calls.close.push(true),
    onUsage: (u) => calls.usage.push(u),
  };
}

describe('nova-sonic wrapper (mock stream)', () => {
  let inputEvents: string[];
  let stream: ReturnType<typeof controllableStream>;

  beforeEach(() => {
    inputEvents = [];
    stream = controllableStream();
    const fakeClient = {
      send: (cmd: { input: { body: AsyncIterable<{ chunk: { bytes: Uint8Array } }> } }) => {
        // Drain the input generator in the background, recording event types.
        void (async () => {
          for await (const chunk of cmd.input.body) {
            const parsed = JSON.parse(new TextDecoder().decode(chunk.chunk.bytes));
            inputEvents.push(Object.keys(parsed.event)[0]);
          }
        })();
        return Promise.resolve({ body: stream.iterable });
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    __setNovaClientForTest(fakeClient as any);
  });
  afterEach(() => __setNovaClientForTest(null));

  it('emits the init event sequence, then audioInput, then the stop sequence', async () => {
    const cb = makeCallbacks();
    const session = createNovaSonicSession(
      { modelId: 'amazon.nova-2-sonic-v1:0', region: 'us-east-1', systemPrompt: 'hi', tools: [] },
      cb,
    );
    session.pushAudio('AAAA');
    await flush();
    stream.close();
    await session.stop();
    await flush();

    expect(inputEvents.slice(0, 2)).toEqual(['sessionStart', 'promptStart']);
    expect(inputEvents).toContain('audioInput');
    expect(inputEvents.slice(-2)).toEqual(['promptEnd', 'sessionEnd']);
    expect(session.isActive).toBe(false);
  });

  it('dispatches audioOutput → onAudioOut and textOutput → onTextTranscript', async () => {
    const cb = makeCallbacks();
    createNovaSonicSession(
      { modelId: 'm', region: 'us-east-1', systemPrompt: 's', tools: [] },
      cb,
    );
    stream.push(out('audioOutput', { content: 'PCM24K', role: 'ASSISTANT' }));
    stream.push(out('textOutput', { content: 'two agents healthy', role: 'ASSISTANT' }));
    await flush();
    expect(cb.calls.audio).toEqual(['PCM24K']);
    expect(cb.calls.text).toContainEqual({ t: 'two agents healthy', role: 'ASSISTANT' });
  });

  it('forwards a barge-in on an interrupted assistant turn', async () => {
    const cb = makeCallbacks();
    createNovaSonicSession({ modelId: 'm', region: 'us-east-1', systemPrompt: 's', tools: [] }, cb);
    stream.push(out('textOutput', { content: '(interrupted)', role: 'ASSISTANT' }));
    await flush();
    expect(cb.calls.barge).toEqual([true]);
  });

  it('drives a tool-use round trip: accumulate → onToolUse → feed result back', async () => {
    const cb = makeCallbacks();
    createNovaSonicSession({ modelId: 'm', region: 'us-east-1', systemPrompt: 's', tools: [] }, cb);
    stream.push(out('toolUse', { toolUseId: 't1', toolName: 'query', content: '{"resource":"agents"}' }));
    stream.push(out('contentEnd', { type: 'TOOL' }));
    await flush();
    expect(cb.calls.tool).toContainEqual({ id: 't1', name: 'query', input: { resource: 'agents' } });
    // The tool result was fed back into the input stream.
    expect(inputEvents).toContain('toolResult');
  });

  it('emits the empty ASSISTANT end-of-turn marker on an assistant-content contentEnd', async () => {
    const cb = makeCallbacks();
    createNovaSonicSession({ modelId: 'm', region: 'us-east-1', systemPrompt: 's', tools: [] }, cb);
    // The assistant turn closes with a TEXT/AUDIO contentEnd (Nova never emits
    // `completionEnd`). The wrapper must surface the empty-text ASSISTANT marker
    // so the relay routes it to speaking_stop and the client returns to listening.
    stream.push(out('textOutput', { content: 'two agents healthy', role: 'ASSISTANT' }));
    stream.push(out('contentEnd', { type: 'TEXT' }));
    await flush();
    expect(cb.calls.text).toContainEqual({ t: '', role: 'ASSISTANT' });
  });

  it('does NOT close the turn on a TOOL contentEnd (preserves the navigate/read_view loop)', async () => {
    const cb = makeCallbacks();
    createNovaSonicSession({ modelId: 'm', region: 'us-east-1', systemPrompt: 's', tools: [] }, cb);
    stream.push(out('toolUse', { toolUseId: 't1', toolName: 'navigate', content: '{"to":"agents"}' }));
    stream.push(out('contentEnd', { type: 'TOOL' }));
    await flush();
    // The tool loop ran...
    expect(cb.calls.tool).toContainEqual({ id: 't1', name: 'navigate', input: { to: 'agents' } });
    // ...but a TOOL contentEnd must NOT emit the end-of-turn marker (turn is still
    // in flight, waiting on the tool result).
    expect(cb.calls.text).not.toContainEqual({ t: '', role: 'ASSISTANT' });
  });

  it('surfaces a stream error to onError', async () => {
    const cb = makeCallbacks();
    createNovaSonicSession({ modelId: 'm', region: 'us-east-1', systemPrompt: 's', tools: [] }, cb);
    stream.push({ modelStreamErrorException: { message: 'boom' } });
    await flush();
    expect(cb.calls.err.length).toBeGreaterThanOrEqual(1);
  });

  it('calls onClose when the output stream ends', async () => {
    const cb = makeCallbacks();
    const session = createNovaSonicSession({ modelId: 'm', region: 'us-east-1', systemPrompt: 's', tools: [] }, cb);
    stream.close();
    await session.stop();
    await flush();
    expect(cb.calls.close).toEqual([true]);
  });

  it('dispatches a usageEvent → onUsage with the parsed token counts', async () => {
    const cb = makeCallbacks();
    createNovaSonicSession({ modelId: 'm', region: 'us-east-1', systemPrompt: 's', tools: [] }, cb);
    stream.push(
      out('usageEvent', {
        details: { total: { input: { speechTokens: 120, textTokens: 4 }, output: { speechTokens: 240, textTokens: 8 } } },
      }),
    );
    await flush();
    expect(cb.calls.usage).toContainEqual({
      speechInputTokens: 120,
      textInputTokens: 4,
      speechOutputTokens: 240,
      textOutputTokens: 8,
    });
  });
});

describe('parseUsageEvent', () => {
  it('reads the speech/text split from details.total', () => {
    expect(
      parseUsageEvent({
        details: { total: { input: { speechTokens: 100, textTokens: 5 }, output: { speechTokens: 200, textTokens: 10 } } },
      }),
    ).toEqual({ speechInputTokens: 100, textInputTokens: 5, speechOutputTokens: 200, textOutputTokens: 10 });
  });

  it('falls back to flat totals, attributing the unknown split to speech (no under-charge)', () => {
    expect(parseUsageEvent({ totalInputTokens: 50, totalOutputTokens: 80 })).toEqual({
      speechInputTokens: 50,
      textInputTokens: 0,
      speechOutputTokens: 80,
      textOutputTokens: 0,
    });
  });

  it('returns all-zero for an empty or unrecognised payload (degrades, no crash)', () => {
    expect(parseUsageEvent({})).toEqual({
      speechInputTokens: 0,
      textInputTokens: 0,
      speechOutputTokens: 0,
      textOutputTokens: 0,
    });
  });
});
