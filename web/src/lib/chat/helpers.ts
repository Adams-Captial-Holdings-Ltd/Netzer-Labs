// Pure chat helpers, moved verbatim from web/src/pages/Chat.tsx (Phase 0 of
// the chat UI port — zero behavior change; the comments document paid-for bug
// fixes and travel with the code). NOTE: this module is imported by tests
// under src/, so it enters the ROOT tsc program: keep it DOM-light and keep
// relative imports `.js`-suffixed (NodeNext).

import { parseArtifactRef } from './artifacts.js';
import type { Conversation, Message, MessageAttachment, Model, ToolCall } from './types.js';

/** Restore transcript results and stopped state; arguments belong only to the live tab. */
export function transcriptToMessages(
  turns: Array<{ role: string; text: string; ts: number; status?: string; tools?: ToolCall[]; attachments?: MessageAttachment[]; artifacts?: unknown[] }>,
): Message[] {
  return turns.map((turn) => {
    if (turn.role === 'user') return {
      role: 'user', text: turn.text, ts: turn.ts,
      ...(turn.attachments?.length ? { attachments: turn.attachments } : {}),
    };
    const artifactRefs = turn.artifacts?.map(parseArtifactRef).filter((ref) => ref !== null);
    return {
      role: 'assistant',
      text: turn.text,
      ts: turn.ts,
      ...(turn.status === 'stopped' ? { stopped: true } : {}),
      ...(turn.tools?.length ? {
        tools: turn.tools.map(({ input: _input, inputTruncated: _inputTruncated, ...tool }) => tool),
      } : {}),
      ...(artifactRefs?.length ? { artifactRefs } : {}),
    };
  });
}

// Friendly names for the env-driven model labels the backend returns.
export const MODEL_NAMES: Record<string, string> = {
  opus: 'Opus',
  'opus-1m': 'Opus 1M',
  sonnet: 'Sonnet',
  'sonnet-1m': 'Sonnet 1M',
  haiku: 'Haiku',
  default: 'Default',
};

// "Sonnet 1M · 1M ctx" — name plus a compact context-window hint so the picker
// conveys why you'd reach for one model over another.
export function modelOptionLabel(m: Model): string {
  const name = MODEL_NAMES[m.label] ?? m.label;
  const ctx = m.contextWindow >= 1_000_000
    ? '1M ctx'
    : `${Math.round(m.contextWindow / 1000)}K ctx`;
  return `${name} · ${ctx}`;
}

// Each conversation gets its own chatId. Reusing a single id across agent
// switches let one agent's accumulated context leak into the next turn, which
// tripped Bedrock guardrails on later turns (the multi-turn false-positive).
// A fresh id per agent (and per explicit "new chat") keeps server-side history
// scoped to the conversation actually on screen.
export function freshChatId(): string {
  return `dashboard:${Date.now()}`;
}

// The active conversation survives a reload. Without this the Chat tab minted a
// fresh chatId on every mount and silently abandoned the previous conversation
// — which is what made history feel non-existent even though it was stored.
export const ACTIVE_CHAT_KEY = 'cce_chat_active';

export function storedChatId(agentId: string): string | null {
  try {
    const raw = sessionStorage.getItem(ACTIVE_CHAT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { agentId?: string; chatId?: string };
    return parsed.agentId === agentId && parsed.chatId ? parsed.chatId : null;
  } catch {
    return null;
  }
}

export function rememberChatId(agentId: string, chatId: string): void {
  try {
    sessionStorage.setItem(ACTIVE_CHAT_KEY, JSON.stringify({ agentId, chatId }));
  } catch {
    /* private mode or quota — the sidebar still works, only resume-on-reload is lost */
  }
}

/** Sidebar label for a conversation: its opening message, else the raw id. */
export function conversationTitle(c: Conversation): string {
  const first = (c.firstMessage ?? '').trim();
  return first.length > 0 ? first : c.chatId;
}

/** Compact relative age for the sidebar ("3m", "5h", "2d"). */
export function relativeAge(epochSeconds: number, nowMs = Date.now()): string {
  const secs = Math.max(0, Math.floor(nowMs / 1000) - epochSeconds);
  if (secs < 60) return 'now';
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
  return `${Math.floor(secs / 86400)}d`;
}

// Turn the stream's `event: error` payload into a plain-English sentence. The
// backend emits either a code-prefixed string (e.g. "kill_switch_active: ...")
// or a raw Error message (e.g. "daily cost cap exceeded: $1.50 >= $1.00", "No
// Bedrock model configured"). A CISO should never see the raw token or a dollar
// dump, so match known codes first, then substrings of the raw message.
export function friendlyStreamError(raw: string): string {
  const code = raw.trim();
  const n = code.toLowerCase();
  if (/kill.?switch|killed\b/.test(n)) return 'This was blocked by an active kill switch.';
  if (/cost.?cap|daily cost|spend cap|spending limit/.test(n)) return 'The daily spending limit has been reached. Raise it in Cost or try again tomorrow.';
  if (/rate.?limit|too many requests/.test(n)) return 'Too many requests right now. Wait a moment and try again.';
  if (/sessions?.?frozen/.test(n)) return 'New messages are paused by a kill switch (sessions frozen).';
  if (/guardrail|blocked by/.test(n)) return 'The response was blocked by a safety guardrail.';
  if (/no .*model|model .*config|model.?error|no bedrock/.test(n)) return 'No model is configured for this agent, or the model failed. Try a different model.';
  // Unknown: a clean fallback, never a raw token or a long dump.
  return code && code.length < 140 && !/[{}$]/.test(code)
    ? `Something went wrong: ${code}`
    : 'The agent could not finish this response. Please try again.';
}

// A refusal before the stream starts says what to do about it. Every other typed
// error is shown as the server wrote it: since P2 its message is plain English
// already (src/agent/turn-errors.ts), and the sanitiser above, written for raw
// codes, would prefix it with "Something went wrong:" and drop the cost cap's hint.
const REFUSAL_WORDS: Record<string, string> = {
  unknown_model: 'That model is no longer available. Pick another one.',
  unknown_agent: 'This agent is no longer available.',
  turn_record_unavailable: 'Could not start the reply. Try again.',
  turn_duplicate: 'Could not start the reply. Try again.',
  turn_conflict: 'Could not start the reply. Try again.',
  too_many_attachments: 'You can attach up to 3 files to a message.',
  upload_not_found: 'Please reload the page and attach the file again.',
  upload_unavailable: 'Could not check your file right now. Please try again.',
  file_too_large: 'An attachment exceeds the 30 MB limit.',
  unsupported_type: 'An attachment type cannot be attached.',
};

/** The words a failed turn shows. No code means an older server, whose wire text still goes through friendlyStreamError. */
export function friendlyTurnError(text: string, code?: string): string {
  if (code === undefined) return friendlyStreamError(text);
  return REFUSAL_WORDS[code] ?? text;
}

/**
 * A message id the server accepts (`^[A-Za-z0-9._:-]{1,64}$`, handler.ts).
 * `crypto.randomUUID` exists only on a secure page; served over plain HTTP the
 * page has none, and Send used to die silently on it.
 */
export function newMessageId(): string {
  const webCrypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return typeof webCrypto?.randomUUID === 'function'
    ? webCrypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
