/**
 * Slack event types — minimal subset of the Events API. We model what
 * the handler reads and ignore the rest.
 */

/**
 * File attachment on a message event (subtype file_share). Downloading
 * url_private requires the bot token as a Bearer header AND the app's
 * `files:read` scope.
 */
export interface SlackFile {
  id: string;
  name?: string;
  title?: string;
  mimetype?: string;
  filetype?: string;
  size?: number;
  url_private?: string;
  url_private_download?: string;
}

export interface SlackBaseEvent {
  type: string;
  ts: string;
  user?: string;
  bot_id?: string;
  channel?: string;
  text?: string;
  team?: string;
  channel_type?: 'channel' | 'im' | 'group' | 'mpim';
  thread_ts?: string;
  subtype?: string;
  files?: SlackFile[];
}

export interface SlackEventCallback {
  token: string;
  team_id: string;
  api_app_id: string;
  type: 'event_callback';
  event_id: string;
  event_time: number;
  event: SlackBaseEvent;
}

export interface SlackUrlVerification {
  token: string;
  challenge: string;
  type: 'url_verification';
}

export type SlackInbound = SlackEventCallback | SlackUrlVerification;
