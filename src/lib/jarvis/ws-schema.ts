/**
 * Canonical Jarvis WebSocket message + close-code schema (JARVIS-PLAN.md
 * §1b H9 and the NORMATIVE Reference Contracts A). This is the single source
 * of truth both the relay and the browser import — there is exactly ONE
 * message union and ONE close-code enum, and every workstream defers to it.
 *
 * Hard rules baked in here (enforced by the doc/code consistency test, H12):
 *   - audio payloads are keyed `b64`, NEVER `data`.
 *   - message types are `audio_in` / `audio_out`, NEVER `audio_input` /
 *     `audio_output` (those were the deleted Converse-style variants).
 *   - ALL browser tools (navigate, read_view, highlight) flow through the
 *     single `tool_call` → `tool_result` envelope. There is NO
 *     `read_view_result`, NO `view_summary`, and NO direct `navigate` /
 *     `highlight` message.
 *   - there is NO client `session_end` / takeover message (a second session
 *     for a token is rejected at the lease, the incumbent is untouched).
 *
 * NOTE: Phase 0 (text-only) does not open this socket — the text path is the
 * SSE `POST /api/jarvis/text-turn` endpoint — but it reuses the
 * `tool_call` / `tool_result` envelope shape defined here so the two sides
 * stay contract-compatible when Phase 1 lands the live relay.
 */

/** Voice transcript speaker. The browser labels `assistant` as "Jarvis". */
export type TranscriptRole = 'user' | 'assistant';

/** The launch tools. navigate/read_view/highlight/show_card run in the browser; query runs server-side. */
export type JarvisToolName = 'navigate' | 'read_view' | 'highlight' | 'show_card' | 'query';

/** Tools the BROWSER executes (relay sends `tool_call`, browser replies `tool_result`). */
export const BROWSER_SIDE_TOOLS: ReadonlySet<JarvisToolName> = new Set([
  'navigate',
  'read_view',
  'highlight',
  // Display-only: renders a HUD insight card from model-provided text/numbers.
  // The model has only ever seen redacted data (H1), so the card cannot carry
  // anything the user was not already cleared to read. The browser renders it
  // as text nodes (no markup), and the relay only needs ok/fail back.
  'show_card',
]);

/** Tools the RELAY executes server-side (never leaves the trust boundary). */
export const SERVER_SIDE_TOOLS: ReadonlySet<JarvisToolName> = new Set(['query']);

// ── Client → relay ──────────────────────────────────────────────────
export type JarvisClientMessage =
  | { type: 'audio_in'; b64: string }
  | { type: 'barge_in' }
  | { type: 'tool_result'; toolUseId: string; ok: boolean; result: unknown }
  | { type: 'ping' };

// ── Relay → client ──────────────────────────────────────────────────
export type JarvisRelayMessage =
  | { type: 'session_ready'; voiceEnabled: boolean }
  // `rate` is the PCM sample rate of this frame (Hz). Jarvis renders its voice
  // through Polly at 16 kHz; absent → the browser decodes at the 24 kHz default.
  | { type: 'audio_out'; b64: string; rate?: number }
  | { type: 'transcript'; text: string; role: TranscriptRole; final: boolean }
  | { type: 'tool_call'; toolUseId: string; toolName: JarvisToolName; input: Record<string, unknown> }
  | { type: 'speaking_start' }
  | { type: 'speaking_stop' }
  // Stop playing Jarvis's audio immediately (the user started talking). Distinct
  // from barge_in_ack: the client stops playback but keeps accepting the NEXT reply.
  | { type: 'interrupt' }
  | { type: 'barge_in_ack' }
  | { type: 'error'; code: string; message: string }
  | { type: 'close'; code: number; reason: string }
  | { type: 'pong' };

/**
 * Canonical close codes. The browser distinguishes the rejection reasons
 * (e.g. NEWCOMER_REJECTED → "active in another tab", VOICE_DISABLED →
 * redirect to the text path). The consistency test rejects non-canonical
 * variants in the four-thousand-four-hundred range.
 */
export const JARVIS_CLOSE = {
  /** Ticket missing / consumed / expired. */
  UNAUTHORIZED: 4001,
  /** Token already has a live session — the NEWCOMER is closed; incumbent untouched. */
  NEWCOMER_REJECTED: 4000,
  /** Launch flag off / kill switch / panic at handshake. */
  DISABLED: 4003,
  /** JARVIS_MAX_SESSION_SECONDS reached. */
  MAX_SESSION: 4008,
  /** Mid-session emergency kill (jarvis_disabled / dashboard_read_disabled / bedrock_global / panic). */
  MID_SESSION_KILL: 4009,
  /** Bedrock bidirectional stream error. */
  STREAM_ERROR: 4010,
  /** Token revoked or expired (handshake re-validation or mid-session). */
  TOKEN_REVOKED: 4011,
  /** jarvis_voice_disabled — client redirects to the Phase-0 text path. */
  VOICE_DISABLED: 4012,
  /** Daily spend cap reached. */
  SPEND_CAP: 4013,
  /** Handshake rate limit. */
  RATE_LIMITED: 4029,
} as const;

export type JarvisCloseCode = (typeof JARVIS_CLOSE)[keyof typeof JARVIS_CLOSE];
