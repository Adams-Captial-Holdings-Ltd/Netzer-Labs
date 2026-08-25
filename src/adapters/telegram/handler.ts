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

  // A MISSION COMMAND ACTS ON THE BOARD OF THE BOT THAT RECEIVED IT (CLAUDE.md,
  // "chat surface parity"). `pickAgent` answers "who should TALK", and its two
  // fallbacks — the `sticky` line above, which can only ever read `'main'`, and
  // Rule 4's `'main'` default — are blind to which bot token answered.
  // `/mission new …` typed at the research bot therefore reached `runCommand`
  // as `'main'` and `createBoardMission({ownerAgent:'main'})`: the mission
  // landed on main's board and `/mission done <id>` transitioned main's rows.
  // That is data corruption, not a rendering difference — Slack's per-agent app
  // passes its own `agentId` to `runCommand` (handler.ts,
  // `handlePerAgentSlackEvent`) and got the same command right, so the two
  // surfaces disagreed about whose board a user was editing.
  //
  // The BOARD scope is therefore the BOT IDENTITY, except when the message
  // OPENS BY ADDRESSING an agent — `/research /missions`, `@research /missions`
  // — in which case the person out-ranks the token they happened to type it at.
  //
  // "Opens by addressing", not "names anywhere", and the difference is load
  // bearing (`picked.addressed`, see picker.ts). Rule 2 of the picker matches
  // `@agent` ANYWHERE in the message, so scoping on `reason === 'mention'`
  // handed `/mission new Ask @main to review the ACL`, typed at the research
  // bot, straight back to main's board — the same wrong-board corruption in a
  // new disguise — and stored the title as "Ask to review the ACL", because
  // `cleanText` deletes the marker it thought was routing. `/mission new` is
  // the first command in this repo whose argument is free-form prose, so an
  // `@agent` inside it is content and must be treated as content: when the
  // message is not addressed, the command runs on the receiving bot's board AND
  // on the RAW text, so nothing is silently deleted from what the user wrote.
  // (Feeding the raw text also un-breaks `/warroom @ops planning`, whose
  // `parseMentions` was being starved by the picker stripping the first `@ops`.)
  const boardAgentId = picked.addressed ? picked.agentId : botAgentId;
  // The picker's `cleanText` is only trustworthy when what it stripped really
  // WAS an addressee; otherwise the command must see exactly what was typed.
  const commandText = picked.addressed ? userText : rawText;

  // PARITY GAP, DELIBERATE (see CLAUDE.md, "chat surface parity"). ONLY the
  // board scope moves to the bot identity. The SESSION scope — `runCommand`'s
  // first argument — stays `targetAgentId`, so `/newchat`, `/reset`, `/status`,
  // `/context`, `/warroom`, `/endroom` and `/model` still answer for the agent
  // ordinary chat in this conversation uses, which on a non-main Telegram bot
  // is `'main'` and not the bot the user typed at.
  //
  // THE TWO SCOPES GENUINELY CANNOT BE SEPARATED HERE, and this is the reason
  // rather than a preference. Those seven commands are not one-shots against a
  // named object the way `/mission` is: they read and WRITE the very session
  // and agent records the next ordinary message reads. Their scope is therefore
  // not free — it is whatever `getSession`/`appendTurns` use below, and that is
  // the pre-existing `'main'` hardcode on the sticky line (one session per chat,
  // keyed on main). Pointing them at `botAgentId` while chat still keys on
  // `'main'` is strictly worse than leaving them: it was measured to make
  // `/newchat` reply "Conversation cleared." while the history survived,
  // `/status` report `history: 0 turn(s)` against a live session, and `/warroom`
  // set a flag on a session the war-room check 40 lines below never reads, so
  // the room never engaged and left an orphaned `active` meeting row.
  //
  // THE MISSING PRIMITIVE is per-bot sessions: one session row per
  // (botAgentId, chatId) instead of the single `'main'`-keyed row. Closing it
  // means migrating every existing Telegram conversation's history to a new key,
  // which is a session-model change and not this phase.
  //
  // THE FALLBACK, and it is real: on the main bot — where the overwhelming
  // majority of these commands are typed, because it is the bot with the whole
  // command surface — the two scopes coincide and every command is correct. On
  // a per-agent bot the session commands act on the session that bot's chat
  // actually uses, so the reply and the behaviour agree even though the agent
  // named in it is not the bot's. Nothing is silently written to the wrong
  // place; the id shown is just `main`'s.
  const sessionAgentId = targetAgentId;

  // Slash command router only when there's no attachment — attachments
  // always go to the agent loop (a photo caption that starts with '/'
  // is data, not a command).
  if (!attachment) {
    const cmd = await runCommand(sessionAgentId, chatId, commandText, { boardAgentId });
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
        // THE RESULT IS NOT DISCARDED (A3-10). This was the last link in the
        // silent-loss chain: an oversize reply was rejected by Telegram, the
        // rejection was thrown away here, and the command reported success to
        // nobody. `sendMessage` now bounds on the RENDERED length so the reply
        // arrives, but if it still cannot be delivered the only honest thing
        // left is to say so loudly — there is no second channel to apologise
        // on, since the channel is the thing that failed.
        const sent = await sendMessage(botAgentId, replyChatId, cmd.reply, {
          replyToMessageId: replyTo,
        });
        if (!sent.ok) {
          logger.error(
            {
              agentId: botAgentId,
              boardAgentId,
              sessionAgentId,
              chatId: replyChatId,
              replyChars: cmd.reply.length,
              error: truncateForLog(sent.error ?? '', 200),
            },
            'command reply undelivered; the user saw nothing',
          );
        }
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
      // THE `bot-` SEGMENT IS THIS SURFACE'S IDENTITY, the exact mirror of the
      // `app-` segment Slack's per-agent path stamps, and CLAUDE.md's "chat
      // surface parity" is why it is here rather than only there. Telegram runs
      // ONE BOT PER AGENT (`.env.example`: "Telegram tokens (one per agent)";
      // this route is `/tg/:agentId/webhook`), and every call this handler
      // makes passes `botAgentId` so it answers as the bot that was written to.
      // An out-of-band push built later from `replyChatId` has no handler to
      // inherit that from, and the turn agent is NOT it — the sticky default
      // routinely answers as `main` inside the research bot's chat. Omit the
      // segment and the push goes out over the wrong bot's token: 403 "bot
      // can't initiate conversation with a user", or delivery into the user's
      // DM with that other bot, since a private chat_id is the user id.
      replyChatId: `${replyChatId}:bot-${botAgentId}`,
      // AND THE TOOLS ADDRESS THE SAME BOARD THE COMMANDS DO. `boardAgentId` is
      // the exact counterpart of the `{ boardAgentId }` handed to `runCommand`
      // above, and it is here because the command half alone left ONE
      // CONVERSATION WITH TWO BOARDS: `/missions` at the research bot listed
      // `[abc12345]` while `list_missions`, one message later in the same chat,
      // answered "No Open missions for main" — the ref this phase teaches the
      // user to copy, refused by the agent standing next to the board that
      // printed it — and `create_mission` wrote where `/mission new` did not.
      // Same class as the command defect: data corruption, not a rendering
      // difference. Slack's per-agent path passes ONE id to both `runCommand`
      // and `runAgentTurn` and was already right, so before this the two
      // surfaces disagreed about whose board a user was editing.
      boardAgentId,
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
