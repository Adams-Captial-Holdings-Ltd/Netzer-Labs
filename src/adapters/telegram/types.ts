/**
 * Shared types for the Telegram adapter.
 *
 * The full Telegram Bot API is large; we only model the fields the
 * orchestrator currently uses. Add fields as features land.
 */

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

export interface TelegramChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}

export interface TelegramPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TelegramVoice {
  file_id: string;
  file_unique_id: string;
  duration: number;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramAudio {
  file_id: string;
  file_unique_id: string;
  duration: number;
  mime_type?: string;
  file_name?: string;
  file_size?: number;
}

export interface TelegramDocument {
  file_id: string;
  file_unique_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramVideo {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  duration: number;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

/** Round "video message" recorded in-app. Always MP4, square, <=60s. */
export interface TelegramVideoNote {
  file_id: string;
  file_unique_id: string;
  length: number;
  duration: number;
  file_size?: number;
}

export interface TelegramMessage {
  message_id: number;
  date: number;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
  caption?: string;
  photo?: TelegramPhotoSize[];
  voice?: TelegramVoice;
  audio?: TelegramAudio;
  document?: TelegramDocument;
  video?: TelegramVideo;
  video_note?: TelegramVideoNote;
  reply_to_message?: TelegramMessage;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  callback_query?: unknown;
}

export interface IncomingAttachment {
  kind: 'photo' | 'voice' | 'audio' | 'document' | 'video';
  fileId: string;
  fileName?: string;
  mimeType?: string;
  size?: number;
}

/**
 * Normalized inbound message handed off to the orchestrator core
 * regardless of surface (Slack, Telegram, etc.).
 */
export interface IncomingMessage {
  surface: 'telegram';
  agentId: string;
  chatId: string;
  userId: string;
  messageId: string;
  text: string;
  receivedAt: string; // ISO 8601
  attachment?: IncomingAttachment;
}
