/**
 * Slack chat.postMessage + chat.update wrappers with per-agent persona override.
 *
 * Persona override uses Slack's `chat:write.customize` scope which lets
 * us spoof `username` and `icon_url` per message. Works in channels and
 * groups but NOT in DMs (Slack strips overrides there); the adapter
 * silently falls back to the default bot identity in that case.
 */

import { logger, truncateForLog } from '../../observability/logger.js';
import { markdownToMrkdwn } from './mrkdwn.js';
import { isKillSwitchActive } from '../../lib/state/kill-switches-repo.js';

function botToken(): string | undefined {
  return process.env.SLACK_BOT_TOKEN || undefined;
}

/** Main-app bot token (env). File downloads need it as a Bearer header. */
export function defaultBotToken(): string | undefined {
  return botToken();
}

export interface SlackPostOptions {
  threadTs?: string;
  persona?: { displayName?: string; iconUrl?: string };
  /** Override the bot token (for per-agent Slack apps). Falls back to env. */
  tokenOverride?: string;
}

export interface SlackPostResult {
  ok: boolean;
  ts?: string;
  error?: string;
}

export async function postMessage(
  channel: string,
  text: string,
  opts: SlackPostOptions = {},
): Promise<SlackPostResult> {
  const token = opts.tokenOverride || botToken();
  if (!token || token === 'REPLACE_ME') {
    return { ok: false, error: 'slack token not configured' };
  }
  const posting = await isKillSwitchActive('slack_posting');
  if (posting.active) {
    logger.warn(
      { channel, reason: posting.reason },
      'slack_posting kill switch active; skipping postMessage',
    );
    return { ok: false, error: 'slack_posting kill switch active' };
  }
  const body: Record<string, unknown> = {
    channel,
    text: markdownToMrkdwn(text),
    mrkdwn: true,
  };
  if (opts.threadTs) body.thread_ts = opts.threadTs;
  if (opts.persona?.displayName) body.username = opts.persona.displayName;
  if (opts.persona?.iconUrl) body.icon_url = opts.persona.iconUrl;

  try {
    const r = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(body),
    });
    const json = (await r.json()) as { ok: boolean; ts?: string; error?: string };
    if (!json.ok) {
      logger.warn(
        { channel, status: r.status, slackError: json.error },
        'slack postMessage failed',
      );
      return { ok: false, error: json.error ?? `HTTP ${r.status}` };
    }
    return { ok: true, ts: json.ts };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ channel, err: msg }, 'slack postMessage threw');
    return { ok: false, error: msg };
  }
}

/** Update an existing message (used for streaming). */
export async function updateMessage(
  channel: string,
  ts: string,
  text: string,
  tokenOverride?: string,
): Promise<SlackPostResult> {
  const token = tokenOverride || botToken();
  if (!token || token === 'REPLACE_ME') return { ok: false, error: 'no token' };
  if (!text) return { ok: false, error: 'empty text' };
  const posting = await isKillSwitchActive('slack_posting');
  if (posting.active) {
    logger.warn(
      { channel, reason: posting.reason },
      'slack_posting kill switch active; skipping updateMessage',
    );
    return { ok: false, error: 'slack_posting kill switch active' };
  }
  try {
    const r = await fetch('https://slack.com/api/chat.update', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({
        channel,
        ts,
        text: markdownToMrkdwn(text),
        mrkdwn: true,
      }),
    });
    const json = (await r.json()) as { ok: boolean; error?: string };
    if (!json.ok) return { ok: false, error: json.error ?? `HTTP ${r.status}` };
    return { ok: true, ts };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Upload a file (generated images) to a channel via Slack's external-upload
 * flow: files.getUploadURLExternal -> raw POST of the bytes ->
 * files.completeUploadExternal (which shares it into the channel/thread).
 * Requires the `files:write` bot scope. Honors slack_posting.
 */
export async function uploadFile(
  channel: string,
  file: { bytes: Buffer; filename: string; title?: string },
  opts: { threadTs?: string; tokenOverride?: string } = {},
): Promise<SlackPostResult> {
  const token = opts.tokenOverride || botToken();
  if (!token || token === 'REPLACE_ME') {
    return { ok: false, error: 'slack token not configured' };
  }
  const posting = await isKillSwitchActive('slack_posting');
  if (posting.active) {
    logger.warn(
      { channel, reason: posting.reason },
      'slack_posting kill switch active; skipping uploadFile',
    );
    return { ok: false, error: 'slack_posting kill switch active' };
  }
  try {
    // 1. reserve an upload URL
    const urlResp = await fetch(
      `https://slack.com/api/files.getUploadURLExternal?filename=${encodeURIComponent(file.filename)}&length=${file.bytes.length}`,
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
    );
    const urlJson = (await urlResp.json()) as {
      ok: boolean;
      upload_url?: string;
      file_id?: string;
      error?: string;
    };
    if (!urlJson.ok || !urlJson.upload_url || !urlJson.file_id) {
      return { ok: false, error: urlJson.error ?? 'getUploadURLExternal failed' };
    }
    // 2. post the raw bytes
    const put = await fetch(urlJson.upload_url, {
      method: 'POST',
      body: new Uint8Array(file.bytes),
    });
    if (!put.ok) return { ok: false, error: `upload POST HTTP ${put.status}` };
    // 3. complete + share into the channel
    const complete = await fetch('https://slack.com/api/files.completeUploadExternal', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({
        files: [{ id: urlJson.file_id, title: file.title ?? file.filename }],
        channel_id: channel,
        ...(opts.threadTs ? { thread_ts: opts.threadTs } : {}),
      }),
    });
    const completeJson = (await complete.json()) as { ok: boolean; error?: string };
    if (!completeJson.ok) {
      logger.warn(
        { channel, error: completeJson.error },
        'slack files.completeUploadExternal failed (missing files:write scope?)',
      );
      return { ok: false, error: completeJson.error ?? 'completeUploadExternal failed' };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Tiny convenience for typing-indicator-like UX: post an ephemeral first then update. */
export function describeSenderError(error?: string): string {
  if (!error) return 'unknown error';
  if (error === 'not_in_channel') return 'I need to be invited to this channel first.';
  if (error === 'channel_not_found') return 'Channel not found.';
  if (error === 'no token') return 'Slack token not configured on the orchestrator.';
  return truncateForLog(error, 200);
}
