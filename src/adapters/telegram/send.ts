/**
 * Telegram sendMessage wrapper.
 *
 * Tokens are loaded from the `TELEGRAM_TOKENS_JSON` env var, which is a
 * JSON map of agent id to bot token (populated by the deploy script from
 * Secrets Manager). Each agent has its own bot identity.
 */

import { logger, truncateForLog } from '../../observability/logger.js';
import { getAgent } from '../../lib/state/agents-repo.js';
import { isKillSwitchActive } from '../../lib/state/kill-switches-repo.js';
import { toTelegramHtml } from './format.js';

/** A Telegram error description that means our HTML/markup didn't parse. */
function isParseError(description: string | undefined): boolean {
  return /can't parse|parse entities|unsupported start tag|unclosed|tag .* mismatch|entity/i.test(
    description ?? '',
  );
}

interface TokenMap {
  [agentId: string]: string;
}

let cachedTokens: TokenMap | null = null;
let dynamicTokens: TokenMap = {};
let dynamicTokensExpiry = 0;
const DYNAMIC_TTL_MS = 60_000;

function loadTokens(): TokenMap {
  if (cachedTokens) return cachedTokens;
  const raw = process.env.TELEGRAM_TOKENS_JSON ?? '';
  if (!raw) {
    cachedTokens = {};
    return cachedTokens;
  }
  try {
    cachedTokens = JSON.parse(raw) as TokenMap;
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      'failed to parse TELEGRAM_TOKENS_JSON',
    );
    cachedTokens = {};
  }
  return cachedTokens;
}

export function getBotToken(agentId: string): string | undefined {
  const tokens = loadTokens();
  return tokens[agentId] ?? dynamicTokens[agentId];
}

export async function getBotTokenAsync(agentId: string): Promise<string | undefined> {
  const sync = getBotToken(agentId);
  if (sync) return sync;
  if (Date.now() < dynamicTokensExpiry && agentId in dynamicTokens) {
    return dynamicTokens[agentId];
  }
  try {
    const agent = await getAgent(agentId);
    if (agent?.telegramBotToken) {
      dynamicTokens[agentId] = agent.telegramBotToken;
      dynamicTokensExpiry = Date.now() + DYNAMIC_TTL_MS;
      return agent.telegramBotToken;
    }
  } catch (err) {
    logger.warn(
      { agentId, err: err instanceof Error ? err.message : String(err) },
      'failed to fetch dynamic telegram token from DDB',
    );
  }
  return undefined;
}

export function refreshTokenCache(): void {
  cachedTokens = null;
  dynamicTokens = {};
  dynamicTokensExpiry = 0;
}

export function knownAgents(): string[] {
  return Object.keys(loadTokens());
}

/**
 * Send a chat action ("typing", "upload_document", etc.) to give the
 * user feedback while the bot is thinking. Telegram shows it for ~5s
 * or until the next message goes out, whichever is sooner.
 */
export async function sendChatAction(
  agentId: string,
  chatId: string | number,
  action: 'typing' | 'upload_photo' | 'upload_document' = 'typing',
): Promise<void> {
  const token = getBotToken(agentId);
  if (!token) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendChatAction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, action }),
    });
  } catch {
    // fire-and-forget; never let typing indicator failure block a reply
  }
}

export interface SendMessageResult {
  ok: boolean;
  messageId?: number;
  error?: string;
}

export async function sendMessage(
  agentId: string,
  chatId: string | number,
  text: string,
  options: {
    replyToMessageId?: number;
    parseMode?: 'MarkdownV2' | 'HTML';
  } = {},
): Promise<SendMessageResult> {
  const token = getBotToken(agentId);
  if (!token) {
    return { ok: false, error: `no Telegram token for agent '${agentId}'` };
  }
  const posting = await isKillSwitchActive('telegram_posting');
  if (posting.active) {
    logger.warn(
      { agentId, chatId },
      'telegram_posting kill switch active; skipping sendMessage',
    );
    return { ok: false, error: 'telegram_posting kill switch active' };
  }
  const base: Record<string, unknown> = { chat_id: chatId };
  if (options.replyToMessageId) base.reply_to_message_id = options.replyToMessageId;

  // Render Markdown into Telegram's HTML subset (tables -> mobile cards, **bold**
  // -> <b>, etc.) so replies look clean on a phone. If the caller asked for a
  // specific parse mode, respect it verbatim. Otherwise try HTML first and fall
  // back to the original plain text if Telegram rejects the markup, so a stray
  // tag can never drop a message.
  const attempts: Array<Record<string, unknown>> = options.parseMode
    ? [{ ...base, text, parse_mode: options.parseMode }]
    : [
        { ...base, text: toTelegramHtml(text), parse_mode: 'HTML' },
        { ...base, text },
      ];

  let lastError = 'unknown';
  for (let a = 0; a < attempts.length; a++) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(attempts[a]),
      });
      const json = (await r.json().catch(() => null)) as
        | { ok?: boolean; result?: { message_id?: number }; description?: string }
        | null;
      if (r.ok && json?.ok) return { ok: true, messageId: json.result?.message_id };
      lastError = json?.description ?? `HTTP ${r.status}`;
      // Retry as plain text only when the failure was the markup itself.
      if (a < attempts.length - 1 && isParseError(json?.description)) continue;
      logger.warn(
        { agentId, chatId, status: r.status, description: truncateForLog(lastError, 200) },
        'telegram sendMessage failed',
      );
      return { ok: false, error: lastError };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      logger.warn({ agentId, chatId, err: lastError }, 'telegram sendMessage threw');
      return { ok: false, error: lastError };
    }
  }
  return { ok: false, error: lastError };
}

/**
 * Edit an existing message's text. Used for streaming.
 * Telegram throws "message is not modified" if the text matches the
 * current value verbatim — we swallow that since it's harmless.
 */
export async function editMessage(
  agentId: string,
  chatId: string | number,
  messageId: number,
  text: string,
): Promise<{ ok: boolean; error?: string }> {
  const token = getBotToken(agentId);
  if (!token) return { ok: false, error: 'no token' };
  if (!text) return { ok: false, error: 'empty text' };
  // Same HTML-first, plain-text-fallback strategy as sendMessage, so streaming
  // edits render Markdown (tables -> cards, **bold** -> <b>) and a mid-stream
  // stray tag never wedges the edit.
  const attempts: Array<Record<string, unknown>> = [
    { chat_id: chatId, message_id: messageId, text: toTelegramHtml(text), parse_mode: 'HTML' },
    { chat_id: chatId, message_id: messageId, text },
  ];
  let lastError = 'unknown';
  for (let a = 0; a < attempts.length; a++) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(attempts[a]),
      });
      const json = (await r.json().catch(() => null)) as
        | { ok?: boolean; description?: string }
        | null;
      if (r.ok && json?.ok) return { ok: true };
      // "message is not modified" is benign — same text as before.
      if (json?.description?.includes('not modified')) return { ok: true };
      lastError = json?.description ?? `HTTP ${r.status}`;
      if (a < attempts.length - 1 && isParseError(json?.description)) continue;
      return { ok: false, error: lastError };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      return { ok: false, error: lastError };
    }
  }
  return { ok: false, error: lastError };
}

/**
 * Send a voice note. Telegram accepts OGG/Opus (preferred for voice
 * notes; shows the waveform) or MP3 (renders as a file). Uses
 * multipart/form-data per the Bot API spec.
 */
export async function sendVoice(
  agentId: string,
  chatId: string | number,
  audio: { bytes: Buffer; filename: string; contentType: string },
  options: { replyToMessageId?: number; caption?: string } = {},
): Promise<SendMessageResult> {
  const token = getBotToken(agentId);
  if (!token) {
    return { ok: false, error: `no Telegram token for agent '${agentId}'` };
  }
  const posting = await isKillSwitchActive('telegram_posting');
  if (posting.active) {
    logger.warn(
      { agentId, chatId },
      'telegram_posting kill switch active; skipping sendVoice',
    );
    return { ok: false, error: 'telegram_posting kill switch active' };
  }
  const fd = new FormData();
  fd.append('chat_id', String(chatId));
  if (options.replyToMessageId) {
    fd.append('reply_to_message_id', String(options.replyToMessageId));
  }
  if (options.caption) fd.append('caption', options.caption);
  fd.append(
    'voice',
    new Blob([new Uint8Array(audio.bytes)], { type: audio.contentType }),
    audio.filename,
  );
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendVoice`, {
      method: 'POST',
      body: fd,
    });
    const json = (await r.json().catch(() => null)) as
      | { ok?: boolean; result?: { message_id?: number }; description?: string }
      | null;
    if (!r.ok || !json?.ok) {
      logger.warn(
        { agentId, chatId, status: r.status, description: json?.description },
        'telegram sendVoice failed',
      );
      return { ok: false, error: json?.description ?? `HTTP ${r.status}` };
    }
    return { ok: true, messageId: json.result?.message_id };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Send a photo (generated images, video keyframes). Multipart per the Bot
 * API spec — mirrors sendVoice, honors the telegram_posting kill switch.
 */
export async function sendPhoto(
  agentId: string,
  chatId: string | number,
  photo: { bytes: Buffer; filename: string; contentType: string },
  options: { replyToMessageId?: number; caption?: string } = {},
): Promise<SendMessageResult> {
  const token = getBotToken(agentId);
  if (!token) {
    return { ok: false, error: `no Telegram token for agent '${agentId}'` };
  }
  const posting = await isKillSwitchActive('telegram_posting');
  if (posting.active) {
    logger.warn(
      { agentId, chatId },
      'telegram_posting kill switch active; skipping sendPhoto',
    );
    return { ok: false, error: 'telegram_posting kill switch active' };
  }
  const fd = new FormData();
  fd.append('chat_id', String(chatId));
  if (options.replyToMessageId) {
    fd.append('reply_to_message_id', String(options.replyToMessageId));
  }
  if (options.caption) fd.append('caption', options.caption.slice(0, 1024));
  fd.append(
    'photo',
    new Blob([new Uint8Array(photo.bytes)], { type: photo.contentType }),
    photo.filename,
  );
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
      method: 'POST',
      body: fd,
    });
    const json = (await r.json().catch(() => null)) as
      | { ok?: boolean; result?: { message_id?: number }; description?: string }
      | null;
    if (!r.ok || !json?.ok) {
      logger.warn(
        { agentId, chatId, status: r.status, description: json?.description },
        'telegram sendPhoto failed',
      );
      return { ok: false, error: json?.description ?? `HTTP ${r.status}` };
    }
    return { ok: true, messageId: json.result?.message_id };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Test-only: reset the token cache so unit tests can mutate env between cases. */
export function resetTokenCache(): void {
  cachedTokens = null;
}
