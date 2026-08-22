/**
 * Telegram webhook route handler.
 *
 * Flow:
 *   1. Verify secret token
 *   2. Parse update (drop bot_message + non-text)
 *   3. Slash-command router runs first (handles /newchat, /model, etc.)
 *   4. Picker selects which agent should respond
 *   5. Load session history from DDB
 *   6. Stream the response via ConverseStream, editing the placeholder
 *      Telegram message every ~1.5s with the cumulative text
 *   7. Append both turns to the session
 *   8. Optional dev-mode status footer
 */

import { Hono } from 'hono';
import { logger, truncateForLog } from '../../observability/logger.js';
import { parseUpdate } from './parse.js';
import {
  sendMessage,
  sendChatAction,
  editMessage,
  sendVoice,
  sendPhoto,
  knownAgents,
} from './send.js';
import { splitLongText } from '../../lib/split-text.js';
import { isKillSwitchActive } from '../../lib/state/kill-switches-repo.js';
import { verifyTelegramSecret } from './verify.js';
import { synthesize } from '../../lib/polly/synth.js';
import { transcodeToOpusOgg } from '../../lib/audio/opus.js';
import type { IncomingAttachment, TelegramUpdate } from './types.js';
import { downloadAndStore } from './media.js';
import { buildKbConfirmation, stageLabel, getRawObject } from '../../lib/media/process.js';
import { runAgentTurn, type AttachmentBlock } from '../../agent/agent-loop.js';
import { runCommand } from '../../agent/commands.js';
import { pickAgent } from '../../agent/picker.js';
import { appendTurns, getSession } from '../../lib/state/sessions-repo.js';
import { loadAgent } from '../../lib/config/agent-loader.js';
import { resolveModel } from '../../lib/bedrock/models.js';
import { publishTurn } from '../../lib/warroom/publisher.js';
import { haltWarroomOnKillPhrase } from '../../lib/warroom/kill-phrase.js';
import { getMeeting } from '../../lib/warroom/meetings-repo.js';
import { orchestrateWarroomTurn } from '../../lib/warroom/orchestrator.js';
import { resolveOwnerChatId } from '../../lib/identity/owner-alias.js';
import { resolveCanonical } from '../../lib/state/identities-repo.js';
import { formatTurnFooter, humanizeToolName, toolStepSuffix } from '../../lib/tools/humanize.js';

const SHOW_FOOTER = process.env.CCE_SHOW_FOOTER === '1';
const SHOW_CONTEXT = process.env.CCE_SHOW_CONTEXT_USAGE === '1';

export function buildTelegramRouter(): Hono {
  const router = new Hono();

  router.get('/agents', (c) => c.json({ agents: knownAgents() }));

  router.post('/:agentId/webhook', async (c) => {
    const botAgentId = c.req.param('agentId');
    const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
    const providedSecret = c.req.header('x-telegram-bot-api-secret-token');

    // Wave A (A-kill prohibition): signature verification is UNCONDITIONAL.
    // The old telegram_signature_check_disabled kill switch accepted UNSIGNED
    // requests, whose sender principal is attacker-controlled — an
    // authentication-bypass primitive that would defeat the F13 allowlist and
    // A0 provenance outright. Break-glass for a broken/missing secret is
    // DISABLE INGRESS (this 401), never "accept unsigned traffic".
    if (expectedSecret && expectedSecret !== 'REPLACE_ME') {
      if (!verifyTelegramSecret(providedSecret, expectedSecret)) {
        logger.warn({ botAgentId }, 'telegram webhook secret mismatch');
        return c.json({ error: 'unauthorized' }, 401);
      }
    } else {
      logger.warn(
        { botAgentId },
        'telegram webhook secret not configured; rejecting unsigned request (set TELEGRAM_WEBHOOK_SECRET; ingress stays closed until it is)',
      );
      return c.json({ error: 'unauthorized', reason: 'no_secret' }, 401);
    }

    const update = await c.req.json<TelegramUpdate>().catch(() => null);
    if (!update) return c.json({ error: 'invalid_json' }, 400);

    const msg = parseUpdate(botAgentId, update);
    if (!msg) {
      return c.json({ ok: true, handled: false });
    }

    logger.info(
      {
        botAgentId,
        chatId: msg.chatId,
        userId: msg.userId,
        text: truncateForLog(msg.text, 80),
        attachment: msg.attachment?.kind,
      },
      'telegram message received',
    );

    // C3 owner aliasing: if the chat is on CCE_OWNER_TELEGRAM_CHATS, all
    // memory operations key on the shared owner namespace. Replies still
    // go to the original Telegram chat (replyChatId).
    //
    // C4 identity claim: if the user explicitly linked this Telegram
    // chat to a canonical identity via the claim flow, all memory and
    // session work key on `user:<canonicalId>`. C3 takes precedence
    // because operator-configured owner mapping is the strongest signal.
    let logicalChatId = resolveOwnerChatId('telegram', msg.chatId) ?? msg.chatId;
    if (logicalChatId === msg.chatId) {
      const canonical = await resolveCanonical('telegram', String(msg.chatId));
      if (canonical) logicalChatId = `user:${canonical}`;
    }

    // Ack first, process async. Telegram retries on non-200 within ~60s.
    void handleMessage(
      botAgentId,
      msg.chatId, // replyChatId — used for all Telegram API calls
      logicalChatId, // chatId — used for sessions, memories, audit
      msg.text,
      Number(msg.messageId),
      msg.attachment,
      msg.userId ? String(msg.userId) : undefined,
    );
    return c.json({ ok: true, handled: true });
  });

  return router;
}

async function handleMessage(
  botAgentId: string,
  replyChatId: string,
  chatId: string,
  rawText: string,
  replyTo: number,
  attachment?: IncomingAttachment,
  userId?: string,
): Promise<void> {
  // Voice-in → voice-out hint: if the user sent a voice/audio note,
  // synthesize the reply with Polly and post via sendVoice.
  const shouldSpeakReply = attachment?.kind === 'voice' || attachment?.kind === 'audio';
  // Determine sticky agent from previous turns (use main's session as the
  // sticky source — we don't have multi-agent sessions yet)
  const sticky = (await getSession('main', chatId))?.turns.length ? 'main' : undefined;
  const picked = pickAgent(rawText, sticky);
  const targetAgentId = picked.agentId;
  let userText = picked.cleanText || rawText;

  // Slash command router only when there's no attachment — attachments
  // always go to the agent loop (a photo caption that starts with '/'
  // is data, not a command).
  if (!attachment) {
    const cmd = await runCommand(targetAgentId, chatId, userText);
    if (cmd) {
      if (cmd.forwardedAgentId && cmd.forwardedText) {
        return handleMessage(
          botAgentId,
          replyChatId,
          chatId,
          `/${cmd.forwardedAgentId} ${cmd.forwardedText}`,
          replyTo,
        );
      }
      if (cmd.reply) {
        await sendMessage(botAgentId, replyChatId, cmd.reply, { replyToMessageId: replyTo });
      }
      return;
    }
  }

  // War room mode: if active, route message as a war room turn
  const wrCheck = await getSession('main', chatId);
  if (wrCheck?.activeWarroomId && !attachment) {
    const room = await getMeeting(wrCheck.activeWarroomId).catch(() => null);
    if (room?.status === 'active') {
      try {
        // A person is typing into a live room, so the emergency kill phrase must
        // work here exactly as it does outside one. It is checked on the RAW
        // message, before publishTurn — the orchestrator only ever sees an
        // assembled transcript. Shared with the dashboard entry point so the two
        // cannot drift; see src/lib/warroom/kill-phrase.ts.
        const halt = await haltWarroomOnKillPhrase({
          meetingId: room.meetingId,
          rawText,
          surface: 'telegram',
        });
        if (halt) {
          await sendMessage(botAgentId, replyChatId, halt, { replyToMessageId: replyTo });
          return;
        }
        const turn = await publishTurn(room.meetingId, userId ?? chatId, 'user', rawText);
        void sendChatAction(botAgentId, replyChatId, 'typing');
        // Fan the turn out to the room's agents and deliver each reply back to
        // this chat as it lands (Telegram has no SSE). Fire-and-forget so the
        // webhook returns fast; the orchestrator never throws. @mentions in the
        // message target specific agents; otherwise everyone weighs in.
        void orchestrateWarroomTurn({
          meetingId: room.meetingId,
          userTurnSeq: turn.seq,
          userText: rawText,
          deliver: async (m) => {
            const body = m.kind === 'system' ? `ℹ️ ${m.text}` : `${m.agentId}:\n${m.text}`;
            await sendMessage(botAgentId, replyChatId, body).catch(() => {});
          },
        });
      } catch (err) {
        await sendMessage(botAgentId, replyChatId, `War room error: ${err instanceof Error ? err.message : String(err)}`, { replyToMessageId: replyTo });
      }
      return;
    }
  }

  // Streaming setup: post a placeholder, then edit it as text streams in.
  // Posted BEFORE the media path so long-running media work (video
  // transcription, frame extraction, KB indexing) can narrate progress by
  // editing it — parity with the Slack placeholder-as-stage-indicator.
  void sendChatAction(
    botAgentId,
    replyChatId,
    attachment ? 'upload_document' : 'typing',
  );
  const placeholder = await sendMessage(botAgentId, replyChatId, '…', {
    replyToMessageId: replyTo,
  });
  if (!placeholder.ok || !placeholder.messageId) {
    logger.error({ chatId }, 'placeholder send failed; aborting turn');
    return;
  }
  const placeholderId = placeholder.messageId;

  // Media path: download + store + decide if we can analyze inline. The
  // pipeline also auto-ingests documents into the knowledge base (scoped to
  // the picked agent), so the file is queryable later from any surface.
  let attachmentBlocks: AttachmentBlock[] = [];
  let kbConfirmation: string | undefined;
  if (attachment) {
    const mediaFileName = attachment.fileName ?? attachment.kind;
    const media = await downloadAndStore(botAgentId, chatId, attachment, {
      targetAgentId,
      onStage: (stage) =>
        void editMessage(
          botAgentId,
          replyChatId,
          placeholderId,
          stageLabel(stage, mediaFileName),
        ),
    });
    if (!media) {
      await editMessage(
        botAgentId,
        replyChatId,
        placeholderId,
        "I couldn't grab that file from Telegram. Try again?",
      );
      return;
    }
    if (media.ackText) {
      // Non-analyzable media (large doc, transcribe failure) — ack + stop.
      // KB-only docs (docx/pptx/txt/…) land here too: the ack already
      // carries the "indexed, ask me anything" line.
      await editMessage(botAgentId, replyChatId, placeholderId, media.ackText);
      return;
    }
    // Voice / audio / video with transcript: feed the transcript text into
    // the agent loop as if the user had typed it. The transcript replaces
    // any caption — most voice notes don't have one anyway.
    if (media.transcript) {
      const label =
        media.transcriptKind === 'video' ? '[video transcript]' : '[transcribed audio]';
      userText = userText
        ? `${userText}\n\n${label} ${media.transcript}`
        : media.transcript;
    }
    // Analyzable media — inline blocks built by the shared pipeline.
    attachmentBlocks = media.blocks;
    if (media.kb) {
      kbConfirmation = buildKbConfirmation(
        media.kb,
        attachment.fileName ?? 'the file',
      );
    }
    if (!userText) userText = 'What is this?';
    // Repaint back to "thinking" after the stage labels.
    void editMessage(botAgentId, replyChatId, placeholderId, '…');
    void sendChatAction(botAgentId, replyChatId, 'typing');
  }

  // Per-chat agent config + model override
  const session = await getSession(targetAgentId, chatId);
  const modelOverride = session?.modelOverride;
  const history = session?.turns ?? [];
  const agent = await loadAgent(targetAgentId);

  // Throttle edits so Telegram doesn't 429
  let lastEditAt = 0;
  let lastSent = '';
  const onChunk = (text: string): void => {
    const now = Date.now();
    if (now - lastEditAt < 1_400) return; // ~1.4s throttle
    if (text === lastSent) return;
    lastSent = text;
    lastEditAt = now;
    const visible = decorateForStream(text, agent.personaPrefix);
    void editMessage(botAgentId, replyChatId, placeholderId, visible);
    void sendChatAction(botAgentId, replyChatId, 'typing');
  };

  // Live tool status: tool dispatch produces no text chunks, so without this
  // the placeholder sits silent at "…" while the agent works Slack/gateway
  // tools. Tool events are rare (max 5/turn) so they bypass the edit throttle;
  // lastSent resets so the next real text chunk repaints over the status.
  const onToolEvent = ({ name, callIndex }: { name: string; callIndex: number }): void => {
    const label = humanizeToolName(name);
    lastSent = '';
    lastEditAt = Date.now();
    void editMessage(
      botAgentId,
      replyChatId,
      placeholderId,
      `⚙️ ${label}…${toolStepSuffix(callIndex)}`,
    );
    void sendChatAction(botAgentId, replyChatId, 'typing');
  };

  try {
    const result = await runAgentTurn({
      agentId: targetAgentId,
      chatId,
      userText,
      history,
      modelOverride,
      onChunk,
      onToolEvent,
      surface: 'telegram',
      // A person typed this in a chat window. `origin` is the ONLY thing that
      // lets the emergency kill phrase halt the fleet, it defaults to 'machine',
      // and this is one of the five chat-surface call sites allowed to say so.
      origin: 'human_chat',
      replyChatId,
      ...(userId ? { userId } : {}),
      ...(attachmentBlocks.length > 0 ? { attachments: attachmentBlocks } : {}),
    });

    // Final edit (full text + optional footer + persona)
    const modelSpec = resolveModel(result.modelId);
    const footer = formatTurnFooter(result, modelSpec.contextWindow, {
      showFooter: SHOW_FOOTER,
      showContext: SHOW_CONTEXT,
    });
    const finalText = decorateForStream(result.text, agent.personaPrefix) + footer;
    const finalEdit = await editMessage(botAgentId, replyChatId, placeholderId, finalText);
    if (!finalEdit.ok) {
      // Telegram rejects edits over 4096 chars ("message is too long") and a
      // few other cases (placeholder deleted, edit window expired) instead of
      // truncating. Deliver the reply as split messages rather than silently
      // persisting a turn the user never saw: the placeholder takes the first
      // piece, the rest arrive as follow-ups. 3000 leaves headroom for the
      // HTML render's tag/entity expansion.
      logger.warn(
        { agentId: botAgentId, chatId: replyChatId, error: truncateForLog(finalEdit.error ?? '', 200) },
        'final placeholder edit failed; delivering reply as split messages',
      );
      const pieces = splitLongText(finalText, 3000);
      const first = pieces.shift();
      if (first) {
        const retry = await editMessage(botAgentId, replyChatId, placeholderId, first);
        if (!retry.ok) pieces.unshift(first);
      }
      for (const piece of pieces) {
        await sendMessage(botAgentId, replyChatId, piece);
      }
    }

    // Knowledge-base confirmation: a separate follow-up message (not a
    // footer) so it survives footer flags and is visible at a glance.
    if (kbConfirmation && !result.blocked) {
      void sendMessage(botAgentId, replyChatId, kbConfirmation).catch(() => {});
    }

    // Generated images: deliver as real photos after the text reply. Fail
    // soft — the presigned URL is already in the reply text as fallback.
    for (const m of result.media ?? []) {
      // Parity gap, deliberate (see CLAUDE.md): generated documents ride the
      // same media channel but Telegram has no sendDocument helper yet, and
      // sendPhoto would post a .xlsx as a photo named image.png. Until that
      // helper exists, documents reach Telegram only via the presigned URL in
      // the reply text.
      if (m.kind !== 'image') continue;
      try {
        const bytes = await getRawObject(m.s3Key, m.s3Bucket);
        await sendPhoto(
          botAgentId,
          replyChatId,
          { bytes, filename: 'image.png', contentType: m.contentType },
          { caption: m.caption },
        );
      } catch (err) {
        logger.warn(
          { errMessage: err instanceof Error ? err.message : String(err), s3Key: m.s3Key },
          'telegram image delivery failed; URL fallback remains in the reply',
        );
      }
    }

    // Voice reply: if the user spoke and TTS is enabled, follow up with
    // a voice note. We send the text edit first so the user always sees
    // the transcript even if Polly is rate-limited.
    const ttsKilled = await isKillSwitchActive('tts_disabled');
    if (
      shouldSpeakReply &&
      process.env.CCE_TTS_ENABLED !== '0' &&
      !ttsKilled.active &&
      !result.blocked &&
      result.text
    ) {
      try {
        // Polly can't emit Opus, which Telegram voice notes require — synth MP3
        // then transcode to OGG/Opus via ffmpeg so the note actually plays.
        const mp3 = await synthesize({ text: result.text, format: 'mp3' });
        const opus = await transcodeToOpusOgg(mp3.bytes);
        await sendVoice(
          botAgentId,
          replyChatId,
          {
            bytes: opus,
            filename: 'reply.ogg',
            contentType: 'audio/ogg',
          },
          { replyToMessageId: replyTo },
        );
      } catch (err) {
        logger.warn(
          { errMessage: err instanceof Error ? err.message : String(err) },
          'tts reply failed; text-only reply already sent',
        );
      }
    }

    // Persist turns + context usage. Guardrail-blocked exchanges are NOT
    // persisted: keeping them poisoned the session (the guardrail re-scans the
    // whole transcript every turn, so one blocked message blocked everything
    // after it until /newchat).
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
    }, { surface: 'telegram', userId: String(chatId) });
  } catch (err) {
    const errMessage = err instanceof Error ? err.message : String(err);
    logger.error({ chatId, agentId: targetAgentId, errMessage }, 'agent turn failed');
    await editMessage(
      botAgentId,
      replyChatId,
      placeholderId,
      `Something went wrong: ${errMessage.slice(0, 300)}`,
    );
  }
}

function decorateForStream(text: string, personaPrefix?: string): string {
  if (!text) return '…';
  return personaPrefix ? `${personaPrefix}\n${text}` : text;
}
