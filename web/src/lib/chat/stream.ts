// The turn-stream client: the SSE parser MOVED out of web/src/pages/Chat.tsx
// send() (Phase 0 of the chat UI port — zero behavior change). streamTurn()
// owns transport and parsing only: it does not touch app state and does not
// prettify errors (friendlyStreamError is the caller's job). The flushEvent
// dispatch, the line buffering, and the post-loop final parse are the moved
// code, verbatim where the old code did not touch component state.
//
// NOTE: this module is imported by tests under src/, so it enters the ROOT tsc
// program: keep it DOM-free and keep relative imports `.js`-suffixed
// (NodeNext).

import type { ToolCall, TurnMeta } from './types.js';

export interface TurnAttachment { s3Key: string; fileName: string; mimeType?: string; addToKnowledge?: true }

export interface TurnBody {
  text: string;
  agentId: string;
  chatId: string;
  modelOverride?: string;
  clientMessageId?: string;
  protocol?: 2;
  attachments?: TurnAttachment[];
}

export interface TurnCallbacks {
  /** Live preview text. Chunk data is CUMULATIVE: each call replaces, never appends. */
  onChunk: (cumulativeText: string) => void;
  /** Live tool/media status line; '' clears it (text resumed). */
  onToolStatus: (status: string) => void;
  onTools?: (tools: ToolCall[]) => void;
}

export interface TurnOutcome {
  text: string;
  isReply: boolean;
  errorText: string;
  errorCode?: string;
  saved?: boolean;
  meta?: TurnMeta;
  kb: string[];
  images: Array<{ url: string; caption: string }>;
  artifacts: Array<{ url: string; name: string }>;
  tools: ToolCall[];
}

export interface TurnStreamOptions {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  endpoint?: string;
}

/** A `tool` event's data, as the server writes it. Legacy calls have only label/step. */
interface WireTool { label: string; step: number; toolUseId?: string; input?: string; inputTruncated?: boolean }
/** A `tool_result` event's data. */
interface WireToolResult { toolUseId: string; output: string; isError: boolean; truncated: boolean }

/**
 * One event's JSON, or undefined when malformed. Parsing is the ONLY thing in
 * the try, so a UI callback that throws is not swallowed as a bad event.
 */
function parseEvent<T>(data: string): T | undefined {
  try {
    return JSON.parse(data) as T;
  } catch {
    return undefined;
  }
}

/**
 * A positional delta, or null when it is not well formed: `i` an integer from 0
 * to the current text length and `t` a string. One bad delta used to corrupt
 * every later one.
 */
function wellFormedDelta(data: string, textLength: number): { i: number; t: string } | null {
  const delta = parseEvent<{ i?: unknown; t?: unknown }>(data);
  const i = delta?.i;
  const t = delta?.t;
  return Number.isInteger(i) && (i as number) >= 0 && (i as number) <= textLength && typeof t === 'string'
    ? { i: i as number, t }
    : null;
}

/**
 * A refusal before the stream starts (`{error: code}` JSON: an unknown model or
 * agent, a turn record that could not be written) keeps its code for the page's
 * words; the message stays what the golden tests pin. Anything else is the bare
 * failure it always was.
 */
async function streamFailure(res: Response): Promise<Error> {
  const failure = new Error('Stream failed');
  try {
    const parsed: unknown = await res.json();
    const code = (parsed as { error?: unknown } | null)?.error;
    return typeof code === 'string' ? Object.assign(failure, { code }) : failure;
  } catch {
    return failure;
  }
}

export async function streamTurn(
  body: TurnBody,
  token: string,
  cb: TurnCallbacks,
  opts: TurnStreamOptions = {},
): Promise<TurnOutcome> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const res = await fetchImpl(opts.endpoint ?? '/api/test-turn/stream', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: body.text,
      agentId: body.agentId,
      chatId: body.chatId,
      ...(body.modelOverride ? { modelOverride: body.modelOverride } : {}),
      ...(body.clientMessageId !== undefined ? { clientMessageId: body.clientMessageId } : {}),
      ...(body.protocol !== undefined ? { protocol: body.protocol } : {}),
      ...(body.attachments && body.attachments.length > 0 ? { attachments: body.attachments } : {}),
    }),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  if (!res.ok) throw await streamFailure(res);
  if (!res.body) throw new Error('Stream failed');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let fullText = '';
  let isReply = false;
  // The backend emits `event: error` with the message string as `data` when a
  // turn fails mid-stream. We capture it here and surface it as a red bubble
  // after the loop instead of pushing an empty assistant reply.
  let errorText = '';
  let errorCode: string | undefined;
  let saved: boolean | undefined;
  const kbChips: string[] = [];
  const images: Array<{ url: string; caption: string }> = [];
  const artifacts: Array<{ url: string; name: string }> = [];
  const tools: ToolCall[] = [];
  const publishTools = () => cb.onTools?.(tools.map((tool) => ({ ...tool })));
  let curEvent = 'chunk'; // SSE without an event: line defaults to "message"; we treat bare data as a chunk
  let curData = '';
  let buffer = '';

  // Flush one fully-received SSE event (event + its accumulated data lines).
  const flushEvent = () => {
    if (curEvent === 'done') saved = curData !== 'not_saved';
    if (curData === '') return;
    if (curEvent === 'reply') {
      // Slash-command reply: plain text, surfaced directly (not JSON).
      fullText = curData;
      isReply = true;
      cb.onChunk(curData);
    } else if (curEvent === 'final') {
      fullText = curData; // JSON; parsed after the loop
    } else if (curEvent === 'chunk') {
      fullText = curData; // cumulative plain text for the live preview
      cb.onChunk(curData);
      cb.onToolStatus(''); // text resumed; drop the tool-status line
    } else if (curEvent === 'delta') {
      const delta = wellFormedDelta(curData, fullText.length);
      if (delta) {
        fullText = fullText.slice(0, delta.i) + delta.t;
        cb.onChunk(fullText);
        cb.onToolStatus('');
      }
    } else if (curEvent === 'tool') {
      // Legacy calls have only label/step; P2 also carries live arguments.
      const t = parseEvent<WireTool>(curData);
      if (t) {
        cb.onToolStatus(t.step > 1 ? `${t.label}… (step ${t.step})` : `${t.label}…`);
        tools.push({
          label: t.label,
          step: t.step,
          ...(t.toolUseId !== undefined ? { toolUseId: t.toolUseId } : {}),
          ...(t.input !== undefined ? { input: t.input, inputTruncated: t.inputTruncated } : {}),
        });
        publishTools();
      }
    } else if (curEvent === 'tool_result') {
      const result = parseEvent<WireToolResult>(curData);
      const index = result ? tools.findIndex((tool) => tool.toolUseId !== undefined && tool.toolUseId === result.toolUseId) : -1;
      if (result && index !== -1) {
        tools[index] = { ...tools[index]!, output: result.output, isError: result.isError, truncated: result.truncated };
        publishTools();
      }
    } else if (curEvent === 'media') {
      // { fileName, stage, label } — media pipeline progress (transcribe,
      // frames, indexing). Rides the same status row as tool events.
      const m = parseEvent<{ fileName?: string; label?: string }>(curData);
      if (m) cb.onToolStatus(m.label ?? `Processing ${m.fileName}…`);
    } else if (curEvent === 'kb') {
      // { text } — knowledge-base confirmation chip for the final bubble.
      try {
        const k = JSON.parse(curData);
        if (k.text) kbChips.push(k.text);
      } catch { /* ignore malformed kb event */ }
    } else if (curEvent === 'image') {
      // { url, caption } — generated image, rendered inline under the reply.
      try {
        const im = JSON.parse(curData);
        if (im.url) images.push({ url: im.url, caption: im.caption ?? '' });
      } catch { /* ignore malformed image event */ }
    } else if (curEvent === 'artifact') {
      // { url, name } — generated document, rendered as a download card.
      // This URL comes straight off the tool result, so unlike a link the
      // model retypes into its reply, its signature is intact.
      try {
        const a = JSON.parse(curData);
        if (a.url) artifacts.push({ url: a.url, name: a.name || a.caption || 'document' });
      } catch { /* ignore malformed artifact event */ }
    } else if (curEvent === 'error') {
      errorText = curData;
      errorCode = undefined;
      try {
        const error = JSON.parse(curData);
        if (error && typeof error.code === 'string' && typeof error.message === 'string') {
          errorText = error.message;
          errorCode = error.code;
        }
      } catch { /* legacy errors are plain text */ }
    }
    // done / unknown events carry no assistant text we surface here.
    curData = '';
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (line === '') {
        // Blank line terminates an SSE event.
        flushEvent();
        curEvent = 'chunk';
      } else if (line.startsWith('event: ')) {
        curEvent = line.slice(7).trim();
      } else if (line.startsWith('data: ')) {
        // Multiline data arrives as repeated "data: " lines; rejoin them.
        curData = curData === '' ? line.slice(6) : `${curData}\n${line.slice(6)}`;
      }
    }
  }
  flushEvent();

  let meta: TurnMeta | undefined;
  if (!errorText && fullText && !isReply) {
    // chunk/final payloads carry the assistant turn as JSON {text,...}. The
    // `final` event also carries the run metadata for the footer.
    try {
      const parsed = JSON.parse(fullText);
      fullText = parsed.text ?? fullText;
      if (typeof parsed.costUsd === 'number') {
        meta = {
          modelId: parsed.modelId ?? '',
          latencyMs: parsed.latencyMs ?? 0,
          costUsd: parsed.costUsd,
          toolCallCount: parsed.toolCallCount ?? 0,
        };
      }
    } catch { /* not JSON (e.g. a raw chunk); use raw text */ }
  }

  return { text: fullText, isReply, errorText, errorCode, saved, meta, kb: kbChips, images, artifacts, tools };
}
