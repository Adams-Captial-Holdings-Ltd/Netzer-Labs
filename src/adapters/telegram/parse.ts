/**
 * Parse a Telegram Update object into our normalized IncomingMessage.
 *
 * Returns null for updates we don't yet handle (callback_query, edits, etc.)
 * so the route handler can ack 200 without processing them.
 */

import type { TelegramUpdate, IncomingMessage, IncomingAttachment } from './types.js';

export function parseUpdate(
  agentId: string,
  update: TelegramUpdate,
): IncomingMessage | null {
  const msg = update.message;
  if (!msg) return null;
  // Bots talking to bots = feedback loop. Drop.
  if (msg.from?.is_bot) return null;
  const text = msg.text ?? msg.caption ?? '';

  // Attachment extraction — photo / voice / audio / document
  let attachment: IncomingAttachment | undefined;
  if (msg.photo && msg.photo.length > 0) {
    // Take the largest size (last element)
    const largest = msg.photo[msg.photo.length - 1]!;
    attachment = {
      kind: 'photo',
      fileId: largest.file_id,
      size: largest.file_size,
    };
  } else if (msg.voice) {
    attachment = {
      kind: 'voice',
      fileId: msg.voice.file_id,
      mimeType: msg.voice.mime_type,
      size: msg.voice.file_size,
    };
  } else if (msg.audio) {
    attachment = {
      kind: 'audio',
      fileId: msg.audio.file_id,
      fileName: msg.audio.file_name,
      mimeType: msg.audio.mime_type,
      size: msg.audio.file_size,
    };
  } else if (msg.document) {
    attachment = {
      kind: 'document',
      fileId: msg.document.file_id,
      fileName: msg.document.file_name,
      mimeType: msg.document.mime_type,
      size: msg.document.file_size,
    };
  } else if (msg.video) {
    attachment = {
      kind: 'video',
      fileId: msg.video.file_id,
      fileName: msg.video.file_name,
      mimeType: msg.video.mime_type ?? 'video/mp4',
      size: msg.video.file_size,
    };
  } else if (msg.video_note) {
    // Round in-app video message — always MP4.
    attachment = {
      kind: 'video',
      fileId: msg.video_note.file_id,
      mimeType: 'video/mp4',
      size: msg.video_note.file_size,
    };
  }

  if (!text && !attachment) return null;

  return {
    surface: 'telegram',
    agentId,
    chatId: String(msg.chat.id),
    userId: msg.from ? String(msg.from.id) : 'unknown',
    messageId: String(msg.message_id),
    text,
    receivedAt: new Date(msg.date * 1000).toISOString(),
    ...(attachment ? { attachment } : {}),
  };
}
