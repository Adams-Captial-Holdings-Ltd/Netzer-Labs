/**
 * Nova 2 Sonic bidirectional-stream wrapper (JARVIS-PLAN.md 01 + §1c).
 *
 * Owns a dedicated HTTP/2 client (the existing Converse client is HTTP/1.1),
 * an async-generator input pipe fed by a backpressure-aware queue, and the
 * output event loop. One wrapper == one bidirectional stream == one session.
 *
 * Verified AWS facts (§1c — do NOT regress):
 *   - model amazon.nova-2-sonic-v1:0; API InvokeModelWithBidirectionalStream
 *     over HTTP/2; IAM action bedrock:InvokeModel (no *BidirectionalStream).
 *   - the stream HARD-CLOSES at 8 min; the HTTP/2 timeout aligns to < 480s.
 *   - audio: input 16kHz PCM in ≥32ms frames; output 24kHz PCM.
 *   - Nova 2 events: sessionStart → promptStart → contentStart → audioInput →
 *     contentEnd → promptEnd → sessionEnd (+ toolUse/toolResult), NOT the
 *     Converse-style contentBlock* names.
 *
 * // SCHEMA-TBD: the exact event field CASING lives inside the chunk bytes
 * (JSON), not the SDK types — confirm it against a live staging stream-open
 * before production. The parser below is intentionally defensive
 * (optional-chaining + first-key dispatch) so a casing surprise degrades to a
 * dropped frame rather than a crash.
 */

import { randomUUID } from 'node:crypto';
import {
  BedrockRuntimeClient,
  InvokeModelWithBidirectionalStreamCommand,
  type InvokeModelWithBidirectionalStreamInput,
} from '@aws-sdk/client-bedrock-runtime';
import { NodeHttp2Handler } from '@smithy/node-http-handler';
import { logger } from '../../observability/logger.js';
import { guardedBedrockSend } from '../bedrock/guard.js';

/** Cumulative token counts from a Nova Sonic `usageEvent`, split speech vs text. */
export interface NovaSonicUsage {
  speechInputTokens: number;
  speechOutputTokens: number;
  textInputTokens: number;
  textOutputTokens: number;
}

export interface NovaSonicCallbacks {
  onAudioOut(base64Pcm24k: string): void;
  onTextTranscript(text: string, role: 'USER' | 'ASSISTANT'): void;
  onBargeIn(): void;
  onToolUse(
    toolUseId: string,
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  onError(err: Error): void;
  onClose(): void;
  /** Cumulative usage from a `usageEvent`, for per-token billing (H5). */
  onUsage?(usage: NovaSonicUsage): void;
}

/**
 * Parse a Nova Sonic `usageEvent` payload into cumulative token counts. The
 * counts are split by speech vs text under `details.total.{input,output}`; when
 * that split is absent (SCHEMA-TBD), fall back to the flat `total*Tokens` and
 * attribute the unknown split to SPEECH — the pricier rate — so a casing
 * surprise never UNDER-charges.
 */
export function parseUsageEvent(u: Record<string, unknown>): NovaSonicUsage {
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
  const details = (u.details ?? {}) as Record<string, unknown>;
  const total = (details.total ?? {}) as Record<string, unknown>;
  const input = (total.input ?? {}) as Record<string, unknown>;
  const output = (total.output ?? {}) as Record<string, unknown>;
  const hasSplit =
    input.speechTokens !== undefined ||
    input.textTokens !== undefined ||
    output.speechTokens !== undefined ||
    output.textTokens !== undefined;
  if (hasSplit) {
    return {
      speechInputTokens: num(input.speechTokens),
      textInputTokens: num(input.textTokens),
      speechOutputTokens: num(output.speechTokens),
      textOutputTokens: num(output.textTokens),
    };
  }
  return {
    speechInputTokens: num(u.totalInputTokens ?? u.inputTokens),
    textInputTokens: 0,
    speechOutputTokens: num(u.totalOutputTokens ?? u.outputTokens),
    textOutputTokens: 0,
  };
}

export interface NovaSonicSessionOptions {
  modelId: string;
  region: string;
  systemPrompt: string;
  tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
  voiceId?: string;
  maxTokens?: number;
}

export interface NovaSonicSession {
  pushAudio(base64Pcm16k: string): void;
  stop(): Promise<void>;
  readonly isActive: boolean;
}

// ── Lazy HTTP/2 client ──────────────────────────────────────────────
let _novaClient: BedrockRuntimeClient | null = null;
function novaSonicBedrockClient(region: string): BedrockRuntimeClient {
  if (!_novaClient) {
    const timeout = Number(process.env.NOVA_HTTP2_TIMEOUT_MS ?? 470_000);
    _novaClient = new BedrockRuntimeClient({
      region,
      requestHandler: new NodeHttp2Handler({
        requestTimeout: timeout,
        sessionTimeout: timeout,
        disableConcurrentStreams: false,
        maxConcurrentStreams: 20,
      }),
    });
  }
  return _novaClient;
}

/** Test seam: inject a fake client (the mock-stream test sets this). */
let _clientOverride: BedrockRuntimeClient | null = null;
export function __setNovaClientForTest(c: BedrockRuntimeClient | null): void {
  _clientOverride = c;
}

// ── Backpressure-aware input queue ──────────────────────────────────
type InputEvent = Record<string, unknown>;

class AsyncQueue<T> {
  private queue: T[] = [];
  private waiting: Array<(r: IteratorResult<T, undefined>) => void> = [];
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    const w = this.waiting.shift();
    if (w) w({ value: item, done: false });
    else this.queue.push(item);
  }

  get depth(): number {
    return this.queue.length;
  }

  close(): void {
    this.closed = true;
    let w: ((r: IteratorResult<T, undefined>) => void) | undefined;
    while ((w = this.waiting.shift())) w({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T, undefined> {
    return {
      next: (): Promise<IteratorResult<T, undefined>> => {
        if (this.queue.length) return Promise.resolve({ value: this.queue.shift() as T, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiting.push(resolve));
      },
    };
  }
}

// Drop audio frames if the queue backs up beyond ~1s of 20ms frames so a slow
// stream cannot grow memory unbounded (a counter surfaces the drops).
const MAX_QUEUE_DEPTH = 50;

const enc = new TextEncoder();
const dec = new TextDecoder();
const wrap = (event: InputEvent): InvokeModelWithBidirectionalStreamInput =>
  ({ chunk: { bytes: enc.encode(JSON.stringify({ event })) } }) as InvokeModelWithBidirectionalStreamInput;

export function createNovaSonicSession(
  opts: NovaSonicSessionOptions,
  callbacks: NovaSonicCallbacks,
): NovaSonicSession {
  const promptName = randomUUID();
  const audioContentName = randomUUID();
  const queue = new AsyncQueue<InputEvent>();
  let active = true;
  let droppedFrames = 0;
  let barInterrupted = false;

  // ── input event builders (SCHEMA-TBD casing) ──────────────────────
  const sessionStart: InputEvent = {
    sessionStart: {
      inferenceConfiguration: { maxTokens: opts.maxTokens ?? 1024, topP: 0.9, temperature: 0.7 },
    },
  };
  const promptStart: InputEvent = {
    promptStart: {
      promptName,
      textOutputConfiguration: { mediaType: 'text/plain' },
      audioOutputConfiguration: {
        mediaType: 'audio/lpcm',
        sampleRateHertz: 24000,
        sampleSizeBits: 16,
        channelCount: 1,
        // Nova Sonic voice ids are lowercase (e.g. 'tiffany'); 'Tiffany' is
        // rejected as an invalid id. This is Jarvis's REAL spoken voice now — the
        // relay forwards Nova's native audioOutput straight to the browser.
        voiceId: (opts.voiceId ?? 'tiffany').toLowerCase(),
        encoding: 'base64',
        audioType: 'SPEECH',
      },
      toolUseOutputConfiguration: { mediaType: 'application/json' },
      toolConfiguration: {
        // Nova Sonic's bidirectional API wants the tool input schema as a JSON
        // STRING (unlike Converse, which takes an object). Passing the raw object
        // makes Nova fail to deserialize the promptStart chunk ("Unable to parse
        // input chunk"), which tore down every voice turn with a stream error.
        tools: opts.tools.map((t) => ({
          toolSpec: { name: t.name, description: t.description, inputSchema: { json: JSON.stringify(t.inputSchema) } },
        })),
      },
    },
  };
  const sysContentName = randomUUID();
  const systemContentStart: InputEvent = {
    contentStart: { promptName, contentName: sysContentName, type: 'TEXT', role: 'SYSTEM', textInputConfiguration: { mediaType: 'text/plain' } },
  };
  const systemTextInput: InputEvent = { textInput: { promptName, contentName: sysContentName, content: opts.systemPrompt } };
  const systemContentEnd: InputEvent = { contentEnd: { promptName, contentName: sysContentName } };
  const audioContentStart: InputEvent = {
    contentStart: {
      promptName,
      contentName: audioContentName,
      type: 'AUDIO',
      role: 'USER',
      audioInputConfiguration: { mediaType: 'audio/lpcm', sampleRateHertz: 16000, sampleSizeBits: 16, channelCount: 1, audioType: 'SPEECH', encoding: 'base64' },
    },
  };

  async function* inputGenerator(): AsyncGenerator<InvokeModelWithBidirectionalStreamInput> {
    yield wrap(sessionStart);
    yield wrap(promptStart);
    yield wrap(systemContentStart);
    yield wrap(systemTextInput);
    yield wrap(systemContentEnd);
    yield wrap(audioContentStart);
    for await (const ev of queue) {
      yield wrap(ev);
    }
  }

  // ── output dispatch ───────────────────────────────────────────────
  const pendingTool: { toolUseId?: string; toolName?: string; content: string } = { content: '' };

  function dispatch(event: Record<string, unknown>): void {
    const e = event as Record<string, Record<string, unknown> | undefined>;
    if (e.audioOutput) {
      const content = e.audioOutput.content;
      if (typeof content === 'string') callbacks.onAudioOut(content);
      return;
    }
    if (e.textOutput) {
      const content = String(e.textOutput.content ?? '');
      const role = (e.textOutput.role === 'USER' ? 'USER' : 'ASSISTANT') as 'USER' | 'ASSISTANT';
      // A real user turn resets the per-turn barge-in latch so the next
      // interruption is detected again.
      if (role === 'USER') barInterrupted = false;
      // Nova marks an interrupted assistant turn with an "{interrupted:true}"
      // textOutput. Handle it as a barge-in, but NEVER forward it — otherwise the
      // marker gets spoken/shown as a turn.
      if (/interrupted/i.test(content)) {
        if (!barInterrupted) {
          barInterrupted = true;
          callbacks.onBargeIn();
        }
        return;
      }
      callbacks.onTextTranscript(content, role);
      return;
    }
    if (e.usageEvent) {
      callbacks.onUsage?.(parseUsageEvent(e.usageEvent as Record<string, unknown>));
      return;
    }
    if (e.toolUse) {
      const tu = e.toolUse;
      if (tu.toolUseId) pendingTool.toolUseId = String(tu.toolUseId);
      if (tu.toolName) pendingTool.toolName = String(tu.toolName);
      if (tu.content !== undefined) pendingTool.content += typeof tu.content === 'string' ? tu.content : JSON.stringify(tu.content);
      return;
    }
    if (e.contentEnd) {
      const type = String((e.contentEnd as { type?: string }).type ?? '');
      // A TOOL contentEnd closes a tool-input block — drive the tool round trip
      // and do NOT close the turn (that would break the navigate/read_view loop:
      // the turn is still in flight, waiting on the tool result).
      if (type === 'TOOL') {
        if (pendingTool.toolUseId && pendingTool.toolName) void finishToolUse();
        return;
      }
      // Any non-TOOL contentEnd (TEXT or AUDIO) is the assistant turn closing.
      // Nova Sonic NEVER emits `completionEnd`; `contentEnd` is the real per-turn
      // close. Emit the empty-text ASSISTANT marker so the relay routes it to
      // speaking_stop and the client returns to listening (which also restores
      // the input glow). The marker text MUST stay empty — a non-empty string
      // would be routed to a spoken/captioned transcript instead of speaking_stop.
      callbacks.onTextTranscript('', 'ASSISTANT');
      return;
    }
    // `completionEnd` is kept as a harmless fallback only: Nova Sonic does not
    // emit it in practice, but if a future schema does, treat it as end-of-turn.
    if (e.completionEnd) {
      callbacks.onTextTranscript('', 'ASSISTANT'); // marks end-of-turn for speaking_stop
      return;
    }
  }

  async function finishToolUse(): Promise<void> {
    const id = pendingTool.toolUseId!;
    const name = pendingTool.toolName!;
    let input: Record<string, unknown> = {};
    try {
      input = pendingTool.content ? (JSON.parse(pendingTool.content) as Record<string, unknown>) : {};
    } catch {
      input = {};
    }
    pendingTool.toolUseId = undefined;
    pendingTool.toolName = undefined;
    pendingTool.content = '';
    let result: Record<string, unknown>;
    try {
      result = await callbacks.onToolUse(id, name, input);
    } catch (err) {
      result = { error: err instanceof Error ? err.message : String(err) };
    }
    // Feed the result back into the stream (contentStart TOOL → toolResult → contentEnd).
    const toolContentName = randomUUID();
    // Nova requires the tool-result media type to be text/plain (NOT
    // application/json) — application/json fails the turn with "Tool result
    // media type must be one of: [text/plain]" and kills the stream. The content
    // is still the JSON string; Nova reads it as a text blob.
    queue.push({ contentStart: { promptName, contentName: toolContentName, type: 'TOOL', role: 'TOOL', toolResultInputConfiguration: { toolUseId: id, type: 'TEXT', textInputConfiguration: { mediaType: 'text/plain' } } } });
    queue.push({ toolResult: { promptName, contentName: toolContentName, content: JSON.stringify(result) } });
    queue.push({ contentEnd: { promptName, contentName: toolContentName } });
  }

  // ── open the stream + run the output loop ─────────────────────────
  const outputDone = (async () => {
    try {
      const client = _clientOverride ?? novaSonicBedrockClient(opts.region);
      const resp = await guardedBedrockSend(() =>
        client.send(
          new InvokeModelWithBidirectionalStreamCommand({ modelId: opts.modelId, body: inputGenerator() }),
        ),
      );
      const body = resp.body;
      if (!body) return;
      for await (const out of body as AsyncIterable<{ chunk?: { bytes?: Uint8Array } } & Record<string, unknown>>) {
        const exc = out.modelStreamErrorException ?? out.internalServerException ?? out.validationException ?? out.throttlingException;
        if (exc) {
          const detail = errMessage(exc);
          logger.warn({ detail }, 'nova-sonic stream error event');
          callbacks.onError(new Error(`nova stream error: ${detail}`));
          continue;
        }
        const bytes = out.chunk?.bytes;
        if (!bytes) continue;
        try {
          const parsed = JSON.parse(dec.decode(bytes)) as { event?: Record<string, unknown> };
          dispatch(parsed.event ?? (parsed as Record<string, unknown>));
        } catch {
          /* unparseable frame — skip (SCHEMA-TBD tolerance) */
        }
      }
    } catch (err) {
      // Surface the REAL cause: the SDK can throw a non-Error object on a
      // deserialization failure, which String()'d to "[object Object]" before.
      const msg = errMessage(err);
      logger.warn({ err: msg }, 'nova-sonic output stream threw');
      if (active) callbacks.onError(new Error(msg));
    } finally {
      active = false;
      callbacks.onClose();
    }
  })();

  return {
    pushAudio(base64Pcm16k: string): void {
      if (!active) return;
      if (queue.depth >= MAX_QUEUE_DEPTH) {
        droppedFrames += 1;
        if (droppedFrames % 50 === 1) logger.warn({ droppedFrames }, 'nova-sonic input queue saturated — dropping audio');
        return;
      }
      queue.push({ audioInput: { promptName, contentName: audioContentName, content: base64Pcm16k } });
    },
    async stop(): Promise<void> {
      if (!active) {
        await Promise.race([outputDone, delay(5000)]);
        return;
      }
      active = false;
      queue.push({ contentEnd: { promptName, contentName: audioContentName } });
      queue.push({ promptEnd: { promptName } });
      queue.push({ sessionEnd: {} });
      queue.close();
      // Bound the drain so a stuck completion event cannot hang shutdown.
      await Promise.race([outputDone, delay(5000)]);
    },
    get isActive(): boolean {
      return active;
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref?.());
}

/** Pull a readable string out of an unknown error/exception (the Bedrock SDK can
 *  throw a non-Error object on a deserialization failure). */
function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === 'object') {
    const o = e as Record<string, unknown>;
    if (typeof o.message === 'string') return o.message;
    try {
      return JSON.stringify(o).slice(0, 400);
    } catch {
      return '[unserializable error]';
    }
  }
  return String(e);
}
