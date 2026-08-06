/**
 * Phase 0 Jarvis text client. POSTs a prompt to the SSE endpoint
 * `POST /api/jarvis/text-turn` and drives the shared signals: assistant
 * `transcript` events become turns + caption, and `tool_call` events are
 * dispatched to the browser tool registry (navigate updates wouter, etc.).
 *
 * Mirrors the streaming-consumption pattern in pages/Chat.tsx (fetch +
 * ReadableStream reader) but parses Hono SSE blocks (`event:`/`data:`).
 * Phase 1 replaces this with the WebSocket voice client; the signals stay.
 */

import { getToken } from '../api';
import {
  jarvisState,
  jarvisCaption,
  jarvisTextModel,
  dispatchToolCall,
  pushTurn,
  streamJarvisTurn,
  resetJarvisStream,
  freshestViewForRoute,
  friendlyJarvisError,
  currentRoute,
} from './tools';

// Multi-turn conversation history for the TEXT path. The SSE turn is one-way, so
// the server cannot keep state between requests; the client owns the transcript
// and replays prior turns each turn instead of rebuilding from scratch. We keep a
// compact role/text list (the model never needs tool-call internals) and append
// the committed assistant reply when the turn closes. Capped so a long session
// can't grow the request unbounded.
interface HistoryTurn {
  role: 'user' | 'assistant';
  text: string;
}
const MAX_HISTORY_TURNS = 16;
let history: HistoryTurn[] = [];
// The route the carried history belongs to. The text path's history is module
// state that would otherwise outlive a page/session context: if the user walks to
// an unrelated page (not a Jarvis-driven navigate) and starts a new question, the
// old thread is stale. We scope history to a page context and reset it when that
// context changes, so it stays bounded AND doesn't bleed across unrelated views.
let historyRoute: string | null = null;

/** Clear the carried conversation (e.g. when the user opens a fresh session or
 *  the page/session context resets). Bounds and scopes the text-path history. */
export function resetJarvisHistory(): void {
  history = [];
  historyRoute = null;
}

// ── Navigation pacing ───────────────────────────────────────────────
// A guided tour arrives as ONE streamed response carrying several navigate
// tool_calls back to back — dispatched raw, the pages flash by in a second.
// Chain same-turn navigations with a minimum dwell so each stop is actually
// seen. The first navigate of a turn fires immediately; voice is naturally
// paced by speech and doesn't go through this path.
const NAV_DWELL_MS = 3500;
let navChain: Promise<void> = Promise.resolve();
let lastNavAt = 0;

function scheduleNavigate(toolName: string, input: Record<string, unknown>): void {
  navChain = navChain.then(async () => {
    const wait = Math.max(0, lastNavAt + NAV_DWELL_MS - Date.now());
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastNavAt = Date.now();
    dispatchToolCall(toolName, input);
  });
}

// ── Narrated step pacing (speak turns) ──────────────────────────────
// On a narrated routine the caption TEXT, the tab switch, and the spoken VOICE
// for each stop must land together. The server streams each stop as
// transcript(final) then audio then navigate, but the text/navigate arrive in a
// burst while the audio plays slowly, so showing them on arrival made the
// caption race ahead and the tabs outrun the voice. Instead we buffer each stop
// as a step and REVEAL it (set the caption, commit the bubble, fire its
// navigate) at the exact moment its audio clip begins. If audio never shows up
// (synth off or failed) we fall back to showing text immediately and pacing the
// tabs on the old fixed dwell, so a silent tour still works. Reset per turn.
const AUDIO_WAIT_MS = 3000;
interface NarrationStep {
  text: string;
  nav: Record<string, unknown> | null;
  revealed: boolean;
}
let narrationTurn = false;
let sawNarrationAudio = false;
let pendingStepText = ''; // committed sentence awaiting its clip
let lastStep: NarrationStep | null = null; // most recent clip step, awaiting its navigate
let narrationFallback = false; // audio unavailable -> show text now, time the tabs
let audioWatchdog: ReturnType<typeof setTimeout> | null = null;
const revealTimers = new Set<ReturnType<typeof setTimeout>>();

function clearAudioWatchdog(): void {
  if (audioWatchdog !== null) {
    clearTimeout(audioWatchdog);
    audioWatchdog = null;
  }
}

// Land a stop: its caption + bubble appear and its tab turns, all on the beat
// the clip starts. The navigate may bind a touch after the reveal (it streams
// just after the audio), so reveal also fires a nav that arrives late.
function revealStep(step: NarrationStep): void {
  step.revealed = true;
  jarvisCaption.value = step.text;
  streamJarvisTurn(step.text, true);
  if (step.nav) dispatchToolCall('navigate', step.nav);
}

// Audio never arrived: stop holding text/navigates, show what we have, and
// revert to plain typed-tour behavior (live caption, fixed-dwell tabs).
function tripNarrationFallback(): void {
  if (narrationFallback) return;
  narrationFallback = true;
  clearAudioWatchdog();
  if (pendingStepText) {
    jarvisCaption.value = pendingStepText;
    streamJarvisTurn(pendingStepText, true);
    pendingStepText = '';
  }
  if (lastStep && lastStep.nav && !lastStep.revealed) {
    scheduleNavigate('navigate', lastStep.nav);
    lastStep.revealed = true;
  }
  lastStep = null;
}

function resetNarration(): void {
  clearAudioWatchdog();
  for (const t of revealTimers) clearTimeout(t);
  revealTimers.clear();
  sawNarrationAudio = false;
  pendingStepText = '';
  lastStep = null;
  narrationFallback = false;
}

// ── Spoken narration (text path) ────────────────────────────────────
// Guided routine chips ask the server (speak:true) to narrate each sentence;
// the server streams `audio` SSE frames (base64 PCM @16kHz). We decode and play
// them back-to-back through one AudioContext so a tour is narrated, not silent.
// Mirrors voiceClient.playback; the text path otherwise has no audio stage. The
// context must be created/resumed inside the chip-click gesture (ensureAudioCtx
// is called synchronously at turn start) or the browser blocks autoplay.
let audioCtx: AudioContext | null = null;
let playbackUntil = 0; // ctx.currentTime up to which audio is already scheduled
let pendingClips = 0; // queued clips not yet finished — keeps the orb 'speaking'
const activeSources = new Set<AudioBufferSourceNode>();

function ensureAudioCtx(): AudioContext | null {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return null;
    if (!audioCtx) audioCtx = new Ctx();
    if (audioCtx.state === 'suspended') void audioCtx.resume();
    return audioCtx;
  } catch {
    return null;
  }
}

/** True while text-path narration is still queued or playing. Lets the orb tell
 *  a text-narration 'speaking' state apart from a live voice session. */
export function isNarrating(): boolean {
  return pendingClips > 0;
}

/** Public stop used by the orb: halt narration and settle the orb to idle.
 *  (The internal stopNarration is state-agnostic — turn-start/error set their
 *  own next state — so this wrapper owns the 'speaking' → idle transition.) */
export function stopJarvisNarration(): void {
  stopNarration();
  if (jarvisState.value === 'speaking') jarvisState.value = 'idle';
}

/** Stop + drop all scheduled narration immediately (a new turn supersedes it). */
function stopNarration(): void {
  for (const s of activeSources) {
    try {
      s.stop();
    } catch {
      /* already stopped */
    }
  }
  activeSources.clear();
  playbackUntil = 0;
  pendingClips = 0;
  resetNarration();
}

// On-camera safety net for the absolute no-em-dash rule: turn any em/en dash (or
// horizontal bar), with its surrounding spaces, into a plain comma so a caption
// never shows a dash even if a model line slips one through. Then tidy up any
// doubled comma or stray space the swap can leave behind.
function cleanForDisplay(text: string): string {
  return text
    .replace(/\s*[—–―]\s*/g, ', ')
    .replace(/,\s*,/g, ',')
    .replace(/\s+,/g, ',')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// Decode + schedule one PCM clip. `step` (when present) is revealed exactly as
// this clip begins, so its caption, bubble, and tab land in time with the voice.
function playNarration(b64: string, sampleRate: number, step: NarrationStep | null): void {
  const ctx = ensureAudioCtx();
  if (!ctx) return;
  const bytes = fromBase64(b64);
  const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
  if (pcm.length === 0) return;
  // Audio is confirmed flowing: cancel the no-audio watchdog so we don't fall
  // back to showing text early.
  if (!sawNarrationAudio) {
    sawNarrationAudio = true;
    clearAudioWatchdog();
  }
  // Native rate = source rate; the AudioContext resamples to the device, so the
  // 16kHz Polly PCM plays correctly when tagged.
  const buf = ctx.createBuffer(1, pcm.length, sampleRate);
  const ch = buf.getChannelData(0);
  for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  const start = Math.max(ctx.currentTime, playbackUntil);
  src.start(start);
  playbackUntil = start + buf.duration;
  pendingClips += 1;
  activeSources.add(src);
  // Reveal this stop's caption + tab on the beat the clip starts, so text and
  // voice stay in lockstep instead of the text racing ahead.
  if (step) {
    const delayMs = Math.max(0, (start - ctx.currentTime) * 1000);
    const timer = setTimeout(() => {
      revealTimers.delete(timer);
      revealStep(step);
    }, delayMs);
    revealTimers.add(timer);
  }
  // Glow the orb while narration plays; settle to idle when the last clip ends.
  jarvisState.value = 'speaking';
  src.onended = () => {
    activeSources.delete(src);
    if (--pendingClips <= 0) {
      pendingClips = 0;
      if (jarvisState.value === 'speaking') jarvisState.value = 'idle';
    }
  };
}

export async function runJarvisTextTurn(text: string, opts: { speak?: boolean } = {}): Promise<void> {
  const prompt = text.trim();
  if (!prompt) return;
  const speak = opts.speak === true;

  resetJarvisStream();
  // A new turn supersedes any narration still playing from the previous one.
  stopNarration();
  // Only a narration (speak) turn holds its caption/tabs for the audio clips; a
  // plain typed tour shows text live and paces tabs on the fixed dwell.
  narrationTurn = speak;
  // Unlock audio inside the originating click gesture (routine chips), before
  // the awaited fetch — otherwise the browser's autoplay policy mutes playback.
  // Arm a watchdog: if no clip arrives shortly, fall back to live text + timed
  // tabs so a silent (synth off/failed) tour still works.
  if (speak) {
    ensureAudioCtx();
    audioWatchdog = setTimeout(() => {
      audioWatchdog = null;
      if (!sawNarrationAudio) tripNarrationFallback();
    }, AUDIO_WAIT_MS);
  }
  jarvisState.value = 'thinking';
  jarvisCaption.value = '';
  lastNavAt = 0; // new turn → its first navigate fires immediately
  pushTurn('user', prompt);

  // Snapshot what is on screen NOW so the model is screen-aware on the text path
  // too: read_view can return real content and the system prompt knows the route.
  // freshestViewForRoute prefers the view a PRIOR turn's navigate auto-read into
  // the shared signal once that page mounted (the SSE turn that navigated was
  // one-way, so the new page surfaces here, on the next turn).
  const { route, query } = currentRoute();
  const view = { route, query, summary: freshestViewForRoute(route) };

  // Page-context reset: if the user moved to an unrelated page between turns (not
  // a Jarvis-driven navigate, which keeps the thread coherent), drop the carried
  // thread so history stays bounded and scoped to the current view. This is the
  // real caller for resetJarvisHistory — it fires whenever the context resets.
  const here = route.split('?')[0].replace(/\/+$/, '') || '/';
  if (historyRoute !== null && historyRoute !== here) resetJarvisHistory();
  historyRoute = here;

  // The history to SEND is everything before this user turn.
  const priorHistory = history.slice(-MAX_HISTORY_TURNS);
  let assistantReply = '';

  let res: Response;
  try {
    res = await fetch('/api/jarvis/text-turn', {
      method: 'POST',
      headers: { Authorization: `Bearer ${getToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: prompt,
        history: priorHistory,
        view,
        // Ask for spoken narration (guided routine chips only); the server still
        // gates on the audio kill switches before emitting any `audio` frame.
        ...(speak ? { speak: true } : {}),
        // '' = deploy default; the server validates any explicit choice.
        ...(jarvisTextModel.value ? { model: jarvisTextModel.value } : {}),
      }),
    });
  } catch {
    stopNarration();
    jarvisState.value = 'error';
    jarvisCaption.value = friendlyJarvisError('connection_failed');
    return;
  }

  if (res.status === 503) {
    stopNarration();
    jarvisState.value = 'disabled';
    jarvisCaption.value = 'Jarvis is disabled.';
    return;
  }
  if (!res.ok || !res.body) {
    stopNarration();
    jarvisState.value = 'error';
    jarvisCaption.value = 'Request failed.';
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  // The final assistant text for THIS turn, accumulated so it can be committed to
  // the carried history once the stream closes cleanly.
  const ctx = { assistantText: '', errored: false };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        handleBlock(block, ctx);
      }
    }
  } catch {
    // A mid-stream network drop must also tear down narration, or queued reveal
    // timers would still fire (rogue tab navigation + caption changes) under the
    // error state. stopNarration clears the timers, watchdog, and audio.
    stopNarration();
    resetJarvisStream();
    jarvisState.value = 'error';
    ctx.errored = true;
  }

  resetJarvisStream();
  // Don't snap to idle while narration is still playing — the clip's onended
  // settles the orb. Only a turn with no pending audio goes idle here.
  if (jarvisState.value === 'thinking') jarvisState.value = pendingClips > 0 ? 'speaking' : 'idle';

  // Commit this turn to the carried history only if it produced a reply (a failed
  // turn is not recorded, so a retry sees the same prior context). The user prompt
  // is paired with the assistant reply so the next turn replays a coherent thread.
  assistantReply = ctx.assistantText.trim();
  if (!ctx.errored && assistantReply) {
    const turnPair: HistoryTurn[] = [
      { role: 'user', text: prompt },
      { role: 'assistant', text: assistantReply },
    ];
    history = [...history, ...turnPair].slice(-MAX_HISTORY_TURNS);
  }
  // Re-anchor the history scope to where we ENDED this turn. A Jarvis-driven
  // navigate during this turn (the model calling navigate) lands us on a new
  // route, but that thread is coherent ("take me to Cost" → "what's the spend?"),
  // so we keep history and just move the anchor. Only a user manually walking to
  // an unrelated page between turns trips the start-of-turn reset above.
  historyRoute = (currentRoute().route.split('?')[0].replace(/\/+$/, '') || '/');
  // If this turn navigated, the new page auto-reads into the shared view on mount;
  // because the SSE turn is one-way, the NEXT runJarvisTextTurn snapshots that via
  // freshestViewForRoute and so carries the page Jarvis just opened — same-turn is
  // not possible here, so the navigated view is reflected on the next turn.
}

function handleBlock(raw: string, ctx: { assistantText: string; errored: boolean }): void {
  let event = 'message';
  const dataLines: string[] = [];
  for (const line of raw.split('\n')) {
    // Per the SSE spec, multiple data: lines join with '\n' and one leading
    // space after the colon is stripped.
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
  }
  const data = dataLines.join('\n');
  if (!data && event === 'message') return;

  switch (event) {
    case 'transcript': {
      try {
        const t = JSON.parse(data) as { text: string; role?: string; final?: boolean };
        if (t.text) {
          // Hard guarantee no em dash (or en/horizontal bar) ever renders on
          // screen, whatever the model emits. The system prompt already bans
          // them; this is the on-camera safety net for that absolute rule.
          const text = cleanForDisplay(t.text);
          // Always track the latest cumulative assistant text for history.
          ctx.assistantText = text;
          if (narrationTurn && !narrationFallback) {
            // Hold this stop's sentence; it is revealed when its clip starts so
            // the caption never races ahead of the voice. Partials are ignored.
            if (t.final !== false) pendingStepText = text;
          } else {
            jarvisCaption.value = text;
            // Partials arrive final:false (cumulative); the closing frame is final:true.
            // A frame with no `final` (any legacy full-text transcript) commits at once.
            streamJarvisTurn(text, t.final !== false);
          }
        }
      } catch {
        /* ignore malformed frame */
      }
      break;
    }
    case 'tool_call': {
      try {
        const tc = JSON.parse(data) as { toolUseId: string; toolName: string; input?: Record<string, unknown> };
        // On a narration turn the navigate belongs to the stop just spoken: bind
        // it to that step so it fires when the step is revealed (on the clip's
        // beat). If the step already revealed, fire now (the navigate streamed a
        // beat late). Outside narration, the old fixed-dwell pacing applies.
        if (tc.toolName === 'navigate') {
          if (narrationTurn && !narrationFallback) {
            if (lastStep && lastStep.nav === null) {
              lastStep.nav = tc.input ?? {};
              if (lastStep.revealed) dispatchToolCall('navigate', lastStep.nav);
            } else {
              // No step to bind to (navigate before any clip); dwell-pace it.
              scheduleNavigate('navigate', tc.input ?? {});
            }
          } else scheduleNavigate(tc.toolName, tc.input ?? {});
        } else dispatchToolCall(tc.toolName, tc.input ?? {});
      } catch {
        /* ignore malformed frame */
      }
      break;
    }
    case 'audio': {
      // Spoken narration frame (base64 PCM @16kHz). On a narration turn it opens
      // a new step carrying the held sentence, revealed when this clip starts.
      try {
        const a = JSON.parse(data) as { b64?: string; rate?: number };
        if (a.b64) {
          const rate = typeof a.rate === 'number' ? a.rate : 16000;
          if (narrationTurn && !narrationFallback) {
            const step: NarrationStep = { text: pendingStepText, nav: null, revealed: false };
            pendingStepText = '';
            lastStep = step;
            playNarration(a.b64, rate, step);
          } else {
            playNarration(a.b64, rate, null);
          }
        }
      } catch {
        /* ignore malformed frame */
      }
      break;
    }
    case 'error': {
      resetJarvisStream();
      // An error supersedes any narration that was already queued for this turn.
      stopNarration();
      jarvisState.value = 'error';
      // Render plain English while keeping the raw code for support (debug log).
      // The friendly text lands in the caption; the code is what the server sent.
      console.debug('[jarvis] error code:', data);
      jarvisCaption.value = friendlyJarvisError(data);
      ctx.errored = true;
      break;
    }
    case 'done': {
      resetJarvisStream();
      // A final sentence whose audio clip never arrived (e.g. a sign-off, or a
      // mid-tour synth failure) is still held in pendingStepText. Flush it so the
      // last line is never silently dropped.
      if (!ctx.errored && data !== 'error' && narrationTurn && !narrationFallback && pendingStepText) {
        jarvisCaption.value = pendingStepText;
        streamJarvisTurn(pendingStepText, true);
        pendingStepText = '';
      }
      if (data === 'error' || ctx.errored) {
        // Honor an error already raised this turn; don't reset the orb to idle.
        stopNarration();
        jarvisState.value = 'error';
        ctx.errored = true;
      } else if (pendingClips > 0) {
        // The server finished streaming but narration clips are still playing;
        // keep the orb 'speaking' so it doesn't blink to idle mid-sentence. The
        // last clip's onended settles it (and advances the final nav stops).
        jarvisState.value = 'speaking';
      } else {
        jarvisState.value = 'idle';
      }
      break;
    }
    default:
      break;
  }
}
