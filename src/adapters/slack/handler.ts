/**
 * Slack Events API + slash command handlers.
 *
 * Mounted at /slack/* from server.ts. Three routes:
 *   POST /slack/events       Events API (app_mention, message.im, etc.)
 *   POST /slack/commands     Slash commands (/claw, /model, /agent)
 *   POST /slack/interactive  Modal + button callbacks (placeholder)
 *
 * Signature verification runs first on raw body. 3-second ack pattern:
 *   - URL verification handshake replies inline with the challenge
 *   - Everything else acks 200 immediately, processes async
 */

import { Hono } from 'hono';
import { logger, truncateForLog } from '../../observability/logger.js';
import { verifySlackSignature } from './verify.js';
import { confirmActionBlocks } from './blocks.js';
import {
  dispatch as dispatchInteractive,
  parseInteractivePayload,
} from './interactive-dispatch.js';
import { postMessage, updateMessage, uploadFile, describeSenderError, defaultBotToken } from './send.js';
import { splitLongText } from '../../lib/split-text.js';
import type { SlackEventCallback, SlackInbound } from './types.js';
import { processSlackFiles, stageLabel } from './media.js';
import { getRawObject } from '../../lib/media/process.js';
import type { ToolMedia } from '../../lib/tools/registry.js';
import { runAgentTurn, type AttachmentBlock } from '../../agent/agent-loop.js';
import { runCommand } from '../../agent/commands.js';
import { pickAgent } from '../../agent/picker.js';
import { appendTurns, getSession } from '../../lib/state/sessions-repo.js';
import { loadAgent } from '../../lib/config/agent-loader.js';
import { resolveModel } from '../../lib/bedrock/models.js';
import { resolveOwnerChatId } from '../../lib/identity/owner-alias.js';
import { resolveCanonical } from '../../lib/state/identities-repo.js';
import { getSlackAgentCredsAsync } from './multi-agent.js';
import { formatTurnFooter, humanizeToolName, toolStepSuffix } from '../../lib/tools/humanize.js';

const SHOW_FOOTER = process.env.CCE_SHOW_FOOTER === '1';
const SHOW_CONTEXT = process.env.CCE_SHOW_CONTEXT_USAGE === '1';

/** In-memory dedup set (Slack retries on non-200 within 3s). */
const seenEventIds = new Set<string>();
function rememberEvent(id: string): boolean {
  if (seenEventIds.has(id)) return false;
  seenEventIds.add(id);
  // Cap memory: drop oldest 100 entries when the set gets big
  if (seenEventIds.size > 500) {
    const it = seenEventIds.values();
    for (let i = 0; i < 100; i++) seenEventIds.delete(it.next().value!);
  }
  return true;
}

export function buildSlackRouter(): Hono {
  const router = new Hono();

  router.post('/events', async (c) => {
    const rawBody = await c.req.text();
    const signature = c.req.header('x-slack-signature');
    const timestamp = c.req.header('x-slack-request-timestamp');
    const signingSecret = process.env.SLACK_SIGNING_SECRET ?? '';

    // Wave A (A-kill prohibition): signature verification is UNCONDITIONAL.
    // The old slack_signature_check_disabled kill switch accepted UNSIGNED
    // requests, whose sender principal is attacker-controlled — an
    // authentication-bypass primitive that would defeat the F13 allowlist and
    // A0 provenance outright. Break-glass for a broken/missing secret is
    // DISABLE INGRESS (this 401), never "accept unsigned traffic".
    if (signingSecret && signingSecret !== 'REPLACE_ME') {
      const v = verifySlackSignature(rawBody, signature, timestamp, signingSecret);
      if (!v.ok) {
        logger.warn({ reason: v.reason }, 'slack signature rejected');
        return c.json({ error: 'unauthorized', reason: v.reason }, 401);
      }
    } else {
      logger.warn(
        {},
        'slack signing secret not configured; rejecting unsigned request (set SLACK_SIGNING_SECRET; ingress stays closed until it is)',
      );
      return c.json({ error: 'unauthorized', reason: 'no_secret' }, 401);
    }

    let payload: SlackInbound;
    try {
      payload = JSON.parse(rawBody) as SlackInbound;
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }

    // URL verification handshake (one-time, when wiring the app)
    if (payload.type === 'url_verification') {
      return c.json({ challenge: payload.challenge });
    }

    if (payload.type !== 'event_callback') {
      return c.json({ ok: true, ignored: (payload as { type: string }).type });
    }
    const callback = payload;

    // Dedupe Slack retries
    if (!rememberEvent(callback.event_id)) {
      return c.json({ ok: true, duplicate: true });
    }

    // Drop bot messages (avoid feedback loops) and contentless events.
    // File-only messages (no text) are real content — they carry files[].
    const ev = callback.event;
    if (ev.bot_id) return c.json({ ok: true, ignored: 'bot_message' });
    if ((!ev.text && !ev.files?.length) || !ev.channel) {
      return c.json({ ok: true, ignored: 'no_text' });
    }

    logger.info(
      {
        type: ev.type,
        channel: ev.channel,
        channelType: ev.channel_type,
        text: truncateForLog(ev.text ?? '', 80),
        files: ev.files?.length ?? 0,
      },
      'slack event received',
    );

    void handleSlackEvent(callback);
    return c.json({ ok: true });
  });

  router.post('/commands', async (c) => {
    const rawBody = await c.req.text();
    const signature = c.req.header('x-slack-signature');
    const timestamp = c.req.header('x-slack-request-timestamp');
    const signingSecret = process.env.SLACK_SIGNING_SECRET ?? '';
    // Same A-kill prohibition as /events: no unsigned slash commands, ever.
    if (signingSecret && signingSecret !== 'REPLACE_ME') {
      const v = verifySlackSignature(rawBody, signature, timestamp, signingSecret);
      if (!v.ok) return c.json({ error: 'unauthorized', reason: v.reason }, 401);
    } else {
      logger.warn(
        {},
        'slack signing secret not configured; rejecting unsigned slash command (set SLACK_SIGNING_SECRET; ingress stays closed until it is)',
      );
      return c.json({ error: 'unauthorized', reason: 'no_secret' }, 401);
    }
    // Slash commands come as form-encoded
    const params = new URLSearchParams(rawBody);
    const channel = params.get('channel_id') ?? '';
    const text = params.get('text') ?? '';
    const command = params.get('command') ?? '';
    const userId = params.get('user_id') ?? '';

    logger.info(
      { command, channel, userId, text: truncateForLog(text, 80) },
      'slack slash command',
    );

    // C2: destructive commands get a Slack-native confirm gate before
    // the agent loop sees them. Right now: /claw forget-me. The button
    // click hits /slack/interactive → forget_me_confirm action_id →
    // purgeChatData.
    if (command === '/claw' && text.trim().toLowerCase() === 'forget-me') {
      const chatId = `slack:${channel}:${userId}`;
      return c.json({
        response_type: 'ephemeral',
        text: 'Confirm memory purge?',
        blocks: confirmActionBlocks({
          title: 'Forget me',
          detail:
            'This permanently deletes memories, scheduled tasks, inbox items, and session history scoped to *you* in this channel. The pre-delete state is hashed and recorded in the audit log so we can prove what was removed, but the data itself does not come back.',
          confirmActionId: 'forget_me_confirm',
          cancelActionId: 'forget_me_cancel',
          confirmLabel: 'Purge my data',
          cancelLabel: 'Cancel',
          value: chatId,
        }),
      });
    }

    // Run command synchronously and reply ephemerally.
    //
    // Parity gap, deliberate (see CLAUDE.md, "chat surface parity"). The agent
    // id here is HARDCODED 'main'. Every agent-scoped command is therefore
    // answered for 'main': /model edits main's model, and the missions commands
    // added in this phase (/missions, /mission) read and write MAIN'S board,
    // never the board of whichever agent the user last spoke to.
    //
    // THE MISSING PRIMITIVE, stated precisely rather than as "Slack gives us
    // nothing". The message path DOES resolve an agent, and it resolves it from
    // the MESSAGE TEXT: `pickAgent(rawText, sticky)` reads an @mention, and its
    // `sticky` input is `getSession('main', chatId)`, which by construction can
    // only ever yield 'main'. A slash-command payload's `text` is the command's
    // ARGUMENTS ("all", "done abc12345") — an @mention there would be an
    // argument, not an addressee — so the one resolver this repo has is fed
    // nothing to resolve. What is genuinely absent is a channel-or-user → agent
    // binding; per-agent apps carry it in the URL of their own event endpoint,
    // which this workspace-level endpoint is not.
    //
    // The fallback, and it is a real one: the same command typed as an ordinary
    // message ("@research /missions" in a DM or channel) routes through the
    // message path and reaches the addressed agent, with the identical reply,
    // because both call the same `runCommand`.
    //
    // UNVERIFIED, and stated rather than glossed: that fallback is proven on
    // the RAW text this handler receives. No probe in this repo drives a real
    // Slack client, and a real client with the per-agent app installed
    // autocompletes a typed "@research" into a `<@U…>` user mention, which
    // `stripSlackMentions` removes before `pickAgent` ever sees it. Whether the
    // fallback survives that autocomplete is untested here.
    const result = await runCommand('main', `slack:${channel}`, `${command} ${text}`);
    return c.json({
      response_type: 'ephemeral',
      text: result?.reply ?? `Unknown command ${command}.`,
    });
  });

  // C2: Slack interactive endpoint. Slack POSTs here when a Block Kit
  // button is clicked or a modal is submitted. Signature is verified
  // (same HMAC pattern as /events + /commands); payload is parsed from
  // the form-encoded body; dispatch routes by payload.type.
  router.post('/interactive', async (c) => {
    const rawBody = await c.req.text();
    const signature = c.req.header('x-slack-signature');
    const timestamp = c.req.header('x-slack-request-timestamp');
    const signingSecret = process.env.SLACK_SIGNING_SECRET ?? '';
    // Same A-kill prohibition as /events: no unsigned interactive payloads.
    if (signingSecret && signingSecret !== 'REPLACE_ME') {
      const v = verifySlackSignature(rawBody, signature, timestamp, signingSecret);
      if (!v.ok) return c.json({ error: 'unauthorized', reason: v.reason }, 401);
    } else {
      logger.warn(
        {},
        'slack signing secret not configured; rejecting unsigned interactive payload (set SLACK_SIGNING_SECRET; ingress stays closed until it is)',
      );
      return c.json({ error: 'unauthorized', reason: 'no_secret' }, 401);
    }

    const payload = parseInteractivePayload(rawBody);
    if (!payload) {
      logger.warn({}, 'slack interactive payload missing or unparseable');
      return c.json({ error: 'bad_request' }, 400);
    }

    logger.info(
      {
        type: payload.type,
        userId: payload.user?.id,
        channel: payload.channel?.id,
        actionId: payload.actions?.[0]?.action_id,
        callbackId: payload.view?.callback_id,
      },
      'slack interactive received',
    );

    const result = await dispatchInteractive(payload);
    return c.json(result.body, (result.status ?? 200) as 200);
  });

  // ── Per-agent Slack routes ──────────────────────────────────────
  // Each agent gets its own Slack app with separate bot token + signing
  // secret. Routes mirror the main routes but use agent-specific credentials.

  router.post('/:agentId/events', async (c) => {
    const agentId = c.req.param('agentId');
    const rawBody = await c.req.text();

    // Parse first so the one-time URL-verification handshake can be answered
    // BEFORE we require stored credentials or a valid signature. When an
    // operator creates this agent's Slack app from the generated manifest,
    // Slack immediately pings the events URL with a `url_verification`
    // challenge, but the bot token + signing secret don't exist yet (Slack
    // only hands those out after the app is created and installed). Gating the
    // challenge behind creds makes app creation fail with "Your URL didn't
    // respond", the exact chicken-and-egg that makes Slack setup painful. The
    // handshake just echoes a random challenge nonce and performs no action,
    // so answering it unauthenticated is safe. Real events below still require
    // stored creds AND a valid signature.
    let payload: SlackInbound;
    try {
      payload = JSON.parse(rawBody) as SlackInbound;
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    if (payload.type === 'url_verification') {
      return c.json({ challenge: (payload as { challenge: string }).challenge });
    }

    const creds = await getSlackAgentCredsAsync(agentId);
    if (!creds) {
      logger.warn({ agentId }, 'no slack credentials for agent');
      return c.json({ error: 'agent_not_configured' }, 404);
    }

    const signature = c.req.header('x-slack-signature');
    const timestamp = c.req.header('x-slack-request-timestamp');

    // Same A-kill prohibition as the main bot path: per-agent events are
    // verified unconditionally against the agent's own signing secret.
    {
      const v = verifySlackSignature(rawBody, signature, timestamp, creds.signingSecret);
      if (!v.ok) {
        logger.warn({ agentId, reason: v.reason }, 'per-agent slack signature rejected');
        return c.json({ error: 'unauthorized', reason: v.reason }, 401);
      }
    }

    // Event callback. File-only messages (no text) are real content.
    if (payload.type !== 'event_callback') return c.text('ok');
    const callback = payload as SlackEventCallback;
    const event = callback.event;
    if (!event || event.bot_id || (!event.text && !event.files?.length)) return c.text('ok');

    const eventId = callback.event_id ?? '';
    if (eventId && !rememberEvent(`${agentId}:${eventId}`)) return c.text('ok');

    logger.info(
      {
        agentId,
        type: event.type,
        channel: event.channel,
        channelType: event.channel_type,
        text: truncateForLog(event.text, 80),
      },
      'per-agent slack event received',
    );

    // Ack immediately, process async
    void handlePerAgentSlackEvent(agentId, callback, creds.botToken);
    return c.json({ ok: true });
  });

  return router;
}

/**
 * Process a Slack event for a per-agent Slack app. Mirrors handleSlackEvent
 * but uses the agent-specific bot token for all API calls.
 */
async function handlePerAgentSlackEvent(
  agentId: string,
  callback: SlackEventCallback,
  botToken: string,
): Promise<void> {
  const ev = callback.event;
  const channel = ev.channel!;
  const rawText = stripSlackMentions(ev.text ?? '');
  const userSeg = ev.channel_type === 'im' || !ev.user ? '' : `:${ev.user}`;
  const nativeChatId = `slack:${channel}${userSeg}${ev.thread_ts ? ':' + ev.thread_ts : ''}`;
  const ownerAlias = resolveOwnerChatId('slack', ev.user);
  let chatId = ownerAlias ?? nativeChatId;
  if (!ownerAlias && ev.user) {
    const canonical = await resolveCanonical('slack', ev.user);
    if (canonical) chatId = `user:${canonical}`;
  }

  let userText = rawText;
  const agent = await loadAgent(agentId);

  // Slash commands (/model, /newchat, /status, ...) run before the agent turn —
  // same as the main Slack app's message path. Without this, a per-agent app
  // forwarded every "/..." straight to the model as chat text, so /model (and
  // the rest) silently no-oped. Scoped to THIS agent, which is exactly the agent
  // the user is addressing on a per-agent bot. Skipped when files are attached —
  // a caption starting with '/' is data, not a command.
  if (!ev.files?.length) {
    const cmd = await runCommand(agentId, chatId, userText);
    if (cmd && cmd.reply) {
      // THE RESULT IS NOT DISCARDED (A3-10), mirroring the identical site on
      // Telegram (`telegram/handler.ts`, same comment). `postMessage` NEVER
      // THROWS: a missing or placeholder token and the `slack_posting` kill
      // switch both come back as `{ ok: false, error }`, so an unsent command
      // reply was previously lost in total silence, on Slack only. There is no
      // second channel to apologise on — the channel is the thing that failed —
      // so the honest remedy is to say so where an operator can see it.
      //
      // Only the ERROR half of A3-10 is mirrored: the oversize half is
      // unreachable here. Slack's ceiling is ~40000 and `mrkdwn` does not
      // escape-expand, so a reply bounded at MISSION_REPLY_MAX_CHARS (3000)
      // source characters cannot exceed it. Telegram needs splitting because
      // its HTML render expands by up to 5x against a 4096 cap; Slack does not,
      // and adding a splitter here would be dead code.
      const sent = await postMessage(channel, cmd.reply, {
        threadTs: ev.thread_ts,
        persona: { displayName: agent.displayName, iconUrl: agent.iconUrl },
        tokenOverride: botToken,
      });
      if (!sent.ok) {
        logger.error(
          { agentId, channel, replyChars: cmd.reply.length, error: sent.error },
          'command reply undelivered; the user saw nothing',
        );
      }
      return;
    }
  }

  const session = await getSession(agentId, chatId);
  const history = session?.turns ?? [];
  const modelOverride = session?.modelOverride;

  // Post a placeholder we'll edit as the stream flows in
  const placeholder = await postMessage(channel, '…', {
    threadTs: ev.thread_ts,
    persona: { displayName: agent.displayName, iconUrl: agent.iconUrl },
    tokenOverride: botToken,
  });
  if (!placeholder.ok || !placeholder.ts) {
    logger.error(
      { channel, agentId, err: describeSenderError(placeholder.error) },
      'per-agent slack placeholder send failed',
    );
    return;
  }
  const placeholderTs = placeholder.ts;

  // File attachments: download with THIS app's bot token (per-agent identity),
  // then run the shared media pipeline — parity with the main Slack path.
  let attachmentBlocks: AttachmentBlock[] = [];
  const kbConfirmations: string[] = [];
  if (ev.files?.length) {
    const fileResult = await processSlackFiles({
      files: ev.files,
      botToken,
      agentId,
      targetAgentId: agentId,
      chatId,
      onStage: (stage, fileName) =>
        void updateMessage(channel, placeholderTs, stageLabel(stage, fileName), botToken),
    });
    if (fileResult.blocks.length === 0 && fileResult.transcripts.length === 0) {
      const ackLines = fileResult.acks.length
        ? fileResult.acks
        : ["I couldn't fetch that file from Slack — the app may be missing the files:read scope."];
      await updateMessage(channel, placeholderTs, ackLines.join('\n'), botToken);
      return;
    }
    attachmentBlocks = fileResult.blocks;
    for (const t of fileResult.transcripts) {
      const label = t.kind === 'video' ? '[video transcript]' : '[transcribed audio]';
      userText = userText ? `${userText}\n\n${label} ${t.text}` : t.text;
    }
    kbConfirmations.push(...fileResult.kbConfirmations, ...fileResult.acks);
    if (!userText) userText = 'What is this?';
    void updateMessage(channel, placeholderTs, '…', botToken);
  }

  let lastEditAt = 0;
  let lastSent = '';
  const onChunk = (text: string): void => {
    const now = Date.now();
    if (now - lastEditAt < 1_400) return;
    if (text === lastSent) return;
    lastSent = text;
    lastEditAt = now;
    void updateMessage(channel, placeholderTs, text, botToken);
  };
  // Live tool status: tool dispatch emits no text, so without this the
  // placeholder sits silent at "…" while the agent works MCP/gateway tools.
  // Mirrors the Telegram surface (see CLAUDE.md "Chat surface parity").
  const onToolEvent = ({ name, callIndex }: { name: string; callIndex: number }): void => {
    lastSent = '';
    lastEditAt = Date.now();
    void updateMessage(
      channel,
      placeholderTs,
      `⚙️ ${humanizeToolName(name)}…${toolStepSuffix(callIndex)}`,
      botToken,
    );
  };

  try {
    const result = await runAgentTurn({
      agentId,
      chatId,
      userText,
      history,
      modelOverride,
      onChunk,
      // PARITY SKIP (CLAUDE.md): onToolResult is not passed — a chat bubble cannot host the dashboard's tool-result panel; the live tool status (onToolEvent) is unchanged.
      onToolEvent,
      surface: 'slack',
      // A person typed this in a chat window. `origin` is the ONLY thing that
      // lets the emergency kill phrase halt the fleet, it defaults to 'machine',
      // and this is one of the five chat-surface call sites allowed to say so.
      origin: 'human_chat',
      // THE `app-` SEGMENT IS THIS PATH'S IDENTITY, and it is the whole of
      // CLAUDE.md's "Slack has TWO send paths" warning applied to out-of-band
      // pushes. Everything this handler sends carries `tokenOverride: botToken`
      // so it appears as THIS agent's own Slack app; a push built later from
      // `replyChatId` has no handler to inherit that from, so the id records
      // which app owns the conversation and `deliverToReplyChat` resolves the
      // token back. Omit it and the assignment push arrives from the MAIN bot —
      // or, when the main bot is not in this channel, not at all. The main-bot
      // path below deliberately emits NO segment: the workspace token is right
      // there.
      replyChatId: `slack:${channel}:app-${agentId}${ev.thread_ts ? `:${ev.thread_ts}` : ''}`,
      ...(ev.user ? { userId: ev.user } : {}),
      ...(attachmentBlocks.length > 0 ? { attachments: attachmentBlocks } : {}),
    });

    const modelSpec = resolveModel(result.modelId);
    const footer = formatTurnFooter(result, modelSpec.contextWindow, {
      showFooter: SHOW_FOOTER,
      showContext: SHOW_CONTEXT,
    });
    const finalUpdate = await updateMessage(channel, placeholderTs, result.text + footer, botToken);
    if (!finalUpdate.ok) {
      // chat.update rejects oversized text (msg_too_long at 40k) and a few
      // other cases instead of truncating. Deliver the reply as split thread
      // posts rather than silently persisting a turn the user never saw.
      // Parity with the Telegram final-edit fallback.
      logger.warn(
        { channel, error: truncateForLog(finalUpdate.error ?? '', 200) },
        'final placeholder update failed; delivering reply as split posts',
      );
      for (const piece of splitLongText(result.text + footer, 35000)) {
        await postMessage(channel, piece, {
          threadTs: ev.thread_ts,
          persona: { displayName: agent.displayName, iconUrl: agent.iconUrl },
          tokenOverride: botToken,
        });
      }
    }

    // Surface-parity note (deliberate gap): Telegram answers a voice note
    // with a Polly voice reply (telegram/handler.ts); Slack does not. Slack
    // has no inline voice-bubble primitive, an audio upload renders as a
    // plain file attachment, so voice-in gets a text reply here. Marked per
    // the CLAUDE.md parity rule rather than silently omitted.

    // KB confirmations as a separate thread reply — parity with main path.
    // Suppressed on a guardrail-blocked turn so a blocked exchange can't leak KB
    // citations (the main path guards this the same way).
    if (kbConfirmations.length > 0 && !result.blocked) {
      void postMessage(channel, kbConfirmations.join('\n'), {
        threadTs: ev.thread_ts,
        persona: { displayName: agent.displayName, iconUrl: agent.iconUrl },
        tokenOverride: botToken,
      }).catch(() => {});
    }

    // Generated images: upload as real Slack files (parity with Telegram).
    await deliverSlackMedia(channel, result.media, ev.thread_ts, botToken);

    // Guardrail-blocked exchanges are NOT persisted: keeping them poisons the
    // session (the guardrail re-scans the whole transcript every turn, so one
    // blocked message blocks everything after it until /newchat). Mirrors the
    // main Slack path; the per-agent path previously persisted unconditionally.
    if (result.blocked) return;
    const now = Math.floor(Date.now() / 1000);
    const spec = resolveModel(result.modelId);
    await appendTurns(agentId, chatId, [
      { role: 'user', text: userText, ts: now },
      { role: 'assistant', text: result.text, ts: now },
    ], {
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      contextWindow: spec.contextWindow,
      modelId: result.modelId,
    }, { surface: 'slack', userId: ev.user });
  } catch (err) {
    const errMessage = err instanceof Error ? err.message : String(err);
    logger.error({ channel, agentId, errMessage }, 'per-agent slack turn failed');
    await updateMessage(channel, placeholderTs, `Something went wrong: ${errMessage.slice(0, 300)}`, botToken);
  }
}

async function handleSlackEvent(callback: SlackEventCallback): Promise<void> {
  const ev = callback.event;
  const channel = ev.channel!;
  const rawText = stripSlackMentions(ev.text ?? '');
  // Per-user chatId scope. Channel + user keeps each speaker's memory
  // lineage distinct in shared channels. DMs (channel_type === 'im')
  // skip the user segment because the channel itself is 1:1.
  const userSeg = ev.channel_type === 'im' || !ev.user ? '' : `:${ev.user}`;
  const nativeChatId = `slack:${channel}${userSeg}${ev.thread_ts ? ':' + ev.thread_ts : ''}`;
  // C3 owner aliasing: if the speaker is on the configured CCE_OWNER_SLACK_USERS
  // list, route this turn into the shared `owner:<label>` namespace so it
  // shares memory with the matching Telegram chat.
  //
  // C4 identity claim: if the speaker explicitly linked this Slack
  // user to a canonical identity, route into `user:<canonicalId>`.
  // C3 wins when set (operator config beats user claim by design).
  const ownerAlias = resolveOwnerChatId('slack', ev.user);
  let chatId = ownerAlias ?? nativeChatId;
  if (!ownerAlias && ev.user) {
    const canonical = await resolveCanonical('slack', ev.user);
    if (canonical) chatId = `user:${canonical}`;
  }
  const userId = ev.user;

  // Backwards-compat: pre-v3 sessions were keyed `slack:<channel>` (no
  // user segment). If the new key has no session but the legacy key
  // does, migrate it on read so we don't orphan history.
  const legacyChatId =
    userSeg.length > 0
      ? `slack:${channel}${ev.thread_ts ? ':' + ev.thread_ts : ''}`
      : null;
  const sticky = (await getSession('main', chatId))?.turns.length ? 'main' : undefined;
  const picked = pickAgent(rawText, sticky);
  const targetAgentId = picked.agentId;
  let userText = picked.cleanText || rawText;

  // Slash command routing inside a regular message (rare, but supported).
  // Skipped when files are attached — a caption starting with '/' is data,
  // not a command (parity with the Telegram handler).
  //
  // MIRRORED FROM TELEGRAM (CLAUDE.md, "chat surface parity"), including the
  // TWO SCOPES. A mission command acts on the board of the bot that received it
  // unless the message OPENS by addressing an agent; every other command stays
  // on the SESSION scope, because it reads and writes the same session records
  // the ordinary turn below does. This endpoint IS the workspace bot and its
  // identity is 'main' — that is why the literal is not a fallback but this
  // bot's own name, the Slack analogue of Telegram's `botAgentId` (the
  // per-agent apps carry theirs in their URL; a workspace-level endpoint has no
  // segment to carry one because there is only ever one of it).
  //
  // The board half is therefore a near no-op here — but the TEXT half is not.
  // Scoping on `targetAgentId`/`cleanText` sent `/mission new Ask @research
  // about the reconciler` to research's board and stored the title as "Ask
  // about the reconciler", the same content-as-routing mistake Telegram had.
  // Same words, same user, must mean the same thing on every surface.
  //
  // And the session half is not a no-op either: `targetAgentId` is the picker's
  // answer, so a mid-sentence `@ops` makes it 'ops' while the board literal is
  // 'main'. Keeping `/newchat` and friends on `targetAgentId` is what keeps
  // them pointed at the session `getSession`/`appendTurns` use below — the same
  // rule Telegram's call site states at length.
  const boardAgentId = picked.addressed ? picked.agentId : 'main';
  const commandText = picked.addressed ? userText : rawText;
  if (!ev.files?.length) {
    const cmd = await runCommand(targetAgentId, chatId, commandText, { boardAgentId });
    if (cmd && cmd.reply) {
      // THE RESULT IS NOT DISCARDED (A3-10) — the main bot's half of the same
      // mirror, see the per-agent path above for why `postMessage` returning
      // `{ ok: false }` rather than throwing is what made this silent, and why
      // only the error half of A3-10 applies on Slack.
      const sent = await postMessage(channel, cmd.reply, { threadTs: ev.thread_ts });
      if (!sent.ok) {
        logger.error(
          { agentId: targetAgentId, boardAgentId, channel, replyChars: cmd.reply.length, error: sent.error },
          'command reply undelivered; the user saw nothing',
        );
      }
      return;
    }
  }

  // Load context — try new key, fall back to pre-v3 legacy key.
  let session = await getSession(targetAgentId, chatId);
  if ((!session || session.turns.length === 0) && legacyChatId) {
    const legacy = await getSession(targetAgentId, legacyChatId);
    if (legacy && legacy.turns.length > 0) {
      session = legacy;
      logger.info(
        { chatId, legacyChatId, turns: legacy.turns.length },
        'slack chatId legacy fallback used (pre-v3 session)',
      );
    }
  }
  const history = session?.turns ?? [];
  const modelOverride = session?.modelOverride;
  const agent = await loadAgent(targetAgentId);

  // Post a placeholder we'll edit as the stream flows in
  const placeholder = await postMessage(channel, '…', {
    threadTs: ev.thread_ts,
    persona: { displayName: agent.displayName, iconUrl: agent.iconUrl },
  });
  if (!placeholder.ok || !placeholder.ts) {
    logger.error(
      { channel, err: describeSenderError(placeholder.error) },
      'slack placeholder send failed',
    );
    return;
  }
  const placeholderTs = placeholder.ts;

  // File attachments: download with the main bot token, run the shared media
  // pipeline (S3 store, inline blocks, Transcribe, KB auto-ingest). The
  // placeholder doubles as the stage indicator while files process.
  let attachmentBlocks: AttachmentBlock[] = [];
  const kbConfirmations: string[] = [];
  if (ev.files?.length) {
    const token = defaultBotToken();
    const fileResult = token
      ? await processSlackFiles({
          files: ev.files,
          botToken: token,
          agentId: 'main',
          targetAgentId,
          chatId,
          onStage: (stage, fileName) =>
            void updateMessage(channel, placeholderTs, stageLabel(stage, fileName)),
        })
      : null;
    if (!fileResult || (fileResult.blocks.length === 0 && fileResult.transcripts.length === 0)) {
      // Nothing the model can see this turn. KB-only docs land here too —
      // their acks already carry the "indexed, ask me anything" line.
      const ackLines = fileResult?.acks.length
        ? fileResult.acks
        : ["I couldn't fetch that file from Slack — the app may be missing the files:read scope."];
      await updateMessage(channel, placeholderTs, ackLines.join('\n'));
      return;
    }
    attachmentBlocks = fileResult.blocks;
    for (const t of fileResult.transcripts) {
      const label = t.kind === 'video' ? '[video transcript]' : '[transcribed audio]';
      userText = userText ? `${userText}\n\n${label} ${t.text}` : t.text;
    }
    kbConfirmations.push(...fileResult.kbConfirmations, ...fileResult.acks);
    if (!userText) userText = 'What is this?';
    // Repaint the placeholder back to "thinking" after the stage labels.
    void updateMessage(channel, placeholderTs, '…');
  }

  let lastEditAt = 0;
  let lastSent = '';
  const onChunk = (text: string): void => {
    const now = Date.now();
    if (now - lastEditAt < 1_400) return;
    if (text === lastSent) return;
    lastSent = text;
    lastEditAt = now;
    void updateMessage(channel, placeholderTs, text);
  };
  // Live tool status: tool dispatch emits no text, so without this the
  // placeholder sits silent at "…" while the agent works MCP/gateway tools.
  // Mirrors the Telegram surface (see CLAUDE.md "Chat surface parity").
  const onToolEvent = ({ name, callIndex }: { name: string; callIndex: number }): void => {
    lastSent = '';
    lastEditAt = Date.now();
    void updateMessage(
      channel,
      placeholderTs,
      `⚙️ ${humanizeToolName(name)}…${toolStepSuffix(callIndex)}`,
    );
  };

  try {
    const result = await runAgentTurn({
      agentId: targetAgentId,
      chatId,
      userText,
      history,
      modelOverride,
      onChunk,
      // PARITY SKIP (CLAUDE.md): onToolResult is not passed — a chat bubble cannot host the dashboard's tool-result panel; the live tool status (onToolEvent) is unchanged.
      onToolEvent,
      surface: 'slack',
      // A person typed this in a chat window. `origin` is the ONLY thing that
      // lets the emergency kill phrase halt the fleet, it defaults to 'machine',
      // and this is one of the five chat-surface call sites allowed to say so.
      origin: 'human_chat',
      // NO `app-` segment, deliberately: this is the workspace bot, and an
      // out-of-band push delivered with `SLACK_BOT_TOKEN` is delivered by the
      // same identity that posted every other message in this thread. The
      // per-agent path above is the one that has to say who it is.
      replyChatId: `slack:${channel}${ev.thread_ts ? `:${ev.thread_ts}` : ''}`,
      // AND THE TOOLS ADDRESS THE SAME BOARD THE COMMANDS DO — the exact
      // counterpart of the `{ boardAgentId }` handed to `runCommand` above, and
      // the same one-line gap Telegram had: the command half alone left ONE
      // CONVERSATION WITH TWO BOARDS. `/mission new ask @research about it`
      // wrote to MAIN's board (a mid-sentence mention is not an address, so the
      // scope is this bot) while `hey there @research open one for me` sent the
      // tool to RESEARCH's, because without this the tool falls back to
      // `ctx.agentId` — the picker's answer. It is the RECEIVING BOT that wins,
      // for the same reason as on Telegram and for one more that is specific
      // here: this endpoint IS the workspace bot and its identity is 'main', so
      // the board a person sees in this conversation is main's whatever the
      // picker did with their prose.
      boardAgentId,
      ...(userId ? { userId } : {}),
      ...(attachmentBlocks.length > 0 ? { attachments: attachmentBlocks } : {}),
    });

    const modelSpec = resolveModel(result.modelId);
    const footer = formatTurnFooter(result, modelSpec.contextWindow, {
      showFooter: SHOW_FOOTER,
      showContext: SHOW_CONTEXT,
    });
    const finalUpdate = await updateMessage(channel, placeholderTs, result.text + footer);
    if (!finalUpdate.ok) {
      // chat.update rejects oversized text (msg_too_long at 40k) and a few
      // other cases instead of truncating. Deliver the reply as split thread
      // posts rather than silently persisting a turn the user never saw.
      // Parity with the Telegram final-edit fallback.
      logger.warn(
        { channel, error: truncateForLog(finalUpdate.error ?? '', 200) },
        'final placeholder update failed; delivering reply as split posts',
      );
      for (const piece of splitLongText(result.text + footer, 35000)) {
        await postMessage(channel, piece, { threadTs: ev.thread_ts });
      }
    }

    // Surface-parity note (deliberate gap): Telegram answers a voice note
    // with a Polly voice reply (telegram/handler.ts); Slack does not. Slack
    // has no inline voice-bubble primitive, an audio upload renders as a
    // plain file attachment, so voice-in gets a text reply here. Marked per
    // the CLAUDE.md parity rule rather than silently omitted.

    // Knowledge-base confirmations: a separate thread reply (not a footer)
    // so they survive footer flags — parity with the Telegram follow-up.
    if (kbConfirmations.length > 0 && !result.blocked) {
      void postMessage(channel, kbConfirmations.join('\n'), {
        threadTs: ev.thread_ts,
      }).catch(() => {});
    }

    // Generated images: upload as real Slack files (parity with Telegram).
    await deliverSlackMedia(channel, result.media, ev.thread_ts);

    // Guardrail-blocked exchanges are NOT persisted: keeping them poisoned the
    // session (the guardrail re-scans the whole transcript every turn, so one
    // blocked message blocked everything after it until /newchat).
    if (result.blocked) return;
    const now = Math.floor(Date.now() / 1000);
    const spec = resolveModel(result.modelId);
    await appendTurns(targetAgentId, chatId, [
      { role: 'user', text: userText, ts: now },
      { role: 'assistant', text: result.text, ts: now },
    ], {
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      contextWindow: spec.contextWindow,
      modelId: result.modelId,
    }, { surface: 'slack', userId });
  } catch (err) {
    const errMessage = err instanceof Error ? err.message : String(err);
    logger.error({ channel, agentId: targetAgentId, errMessage }, 'agent turn failed');
    await updateMessage(channel, placeholderTs, `Something went wrong: ${errMessage.slice(0, 300)}`);
  }
}

/**
 * Deliver generated media — images and documents alike — as native Slack file
 * uploads after the text reply. Fail soft: the presigned URL stays in the
 * reply text as fallback (and a missing files:write scope logs loudly inside
 * uploadFile).
 */
async function deliverSlackMedia(
  channel: string,
  media: ToolMedia[] | undefined,
  threadTs?: string,
  botToken?: string,
): Promise<void> {
  for (const m of media ?? []) {
    try {
      const bytes = await getRawObject(m.s3Key, m.s3Bucket);
      // Slack's uploadFile is format-agnostic, so generated documents deliver
      // natively here — only the filename differs. Images keep the historical
      // 'image.png'; artifacts carry their real name so the download is usable.
      const filename = m.kind === 'artifact' ? (m.caption ?? 'document') : 'image.png';
      await uploadFile(
        channel,
        { bytes, filename, title: m.caption },
        { threadTs, ...(botToken ? { tokenOverride: botToken } : {}) },
      );
    } catch (err) {
      logger.warn(
        { errMessage: err instanceof Error ? err.message : String(err), s3Key: m.s3Key, kind: m.kind },
        'slack media delivery failed; URL fallback remains in the reply',
      );
    }
  }
}

/** Strip <@U123> mentions Slack inserts around the bot user. */
function stripSlackMentions(text: string): string {
  return text.replace(/<@[A-Z0-9]+>/g, '').replace(/\s+/g, ' ').trim();
}

