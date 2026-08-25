/**
 * Scheduled-reply delivery — the ONE place that decides where a fired task's
 * answer goes. Replaces the duplicated private deliverScheduledReply copies
 * in src/agent/scheduler.ts and src/lib/scheduler/queue-drain.ts.
 *
 * Bug this fixes: prefix routing alone sent owner-aliased chatIds
 * ("owner:emmanuel" — exactly the principals who schedule a morning brief from
 * chat) to the Telegram API as a literal chat_id, which failed. Resolution
 * order now:
 *   1. task.deliveryTarget when present (explicit, set by the dashboard CRUD
 *      or auto-stamped by the schedule_task tool from the originating surface)
 *   2. chatId prefix routing (slack: -> Slack; dashboard:/system: -> none)
 *   3. principal-scoped ids: owner:* -> first CCE_OWNER_TELEGRAM_CHATS entry;
 *      user:<canonicalId> -> claimed links (telegram preferred, then slack DM)
 *   4. anything else -> Telegram with chatId as chat_id (legacy numeric)
 *
 * AND WHO SENDS IT, which is the other half of "where does this go" rather than
 * a detail of it: BOTH chat surfaces here run more than one bot. Telegram has a
 * token per agent (`TELEGRAM_TOKENS_JSON`, `.env.example`: "Telegram tokens
 * (one per agent)", route `/tg/:agentId/webhook`), and Slack has the workspace
 * bot plus one app per agent. A target that records only WHERE therefore lets
 * the WRONG identity deliver it — on Telegram that is a 403 "bot can't initiate
 * conversation with a user", or, when the user has met the other bot, the same
 * text posted into a DIFFERENT conversation. So the identity rides IN the id —
 * `app-<agentId>` on Slack, `bot-<agentId>` on Telegram — and `send()` below
 * resolves it back to a token. Ids stamped without one keep working: the
 * caller's own agent id is the fallback, which is what a single-identity
 * surface wants.
 *
 * `send()` RETURNS WHETHER THE MESSAGE ACTUALLY LEFT, because an undelivered
 * push that reports success is worse than one that reports failure.
 * `deliverToReplyChat` propagates that boolean to its caller — create_mission
 * tells the model the chat was not notified rather than implying it was.
 * `deliverScheduledReply` is the one place that drops it, deliberately: a task
 * fired by EventBridge or the SQS drain has no caller left to inform, so the
 * warn inside `send()` is the only place the failure can go.
 */

import { logger } from '../../observability/logger.js';
import { sendMessage as sendTelegram } from '../../adapters/telegram/send.js';
import { postMessage as sendSlack } from '../../adapters/slack/send.js';
import { getSlackAgentCredsAsync } from '../../adapters/slack/multi-agent.js';
import { listLinks } from '../state/identities-repo.js';
import { isPrincipalScopedChatId } from '../identity/owner-alias.js';
import type { ScheduledTask } from '../state/scheduled-tasks-repo.js';

export interface DeliveryTarget {
  surface: 'telegram' | 'slack';
  /** Telegram chat_id, or a Slack channel (optionally "channel:threadTs"). */
  chatId: string;
}

/**
 * Parse the slack:* chatId shapes into channel + optional thread ts + optional
 * app identity.
 * Possible shapes (Phase B2 multi-user awareness):
 *   slack:CXXXX                       (DM, legacy pre-v3)
 *   slack:CXXXX:UYYYY                 (channel, user-scoped)
 *   slack:CXXXX:1234567890.123456     (DM thread, legacy)
 *   slack:CXXXX:UYYYY:1234567890.123  (channel thread, user-scoped)
 *   slack:CXXXX:app-research:123.456  (per-agent Slack app, any of the above)
 * Channel ids start C/G/D, user ids U/W; thread ts is numeric.decimal.
 *
 * WHY THERE IS AN `app-` SEGMENT AT ALL — CLAUDE.md, "chat surface parity",
 * and specifically its warning that Slack has **TWO** send paths. The main bot
 * posts with the workspace token from `SLACK_BOT_TOKEN`; a per-agent Slack app
 * posts with its OWN token and appears in the channel as its own bot. An
 * out-of-band push built from a `replyChatId` that records only the channel is
 * therefore delivered by the WRONG BOT on the per-agent path — and if that bot
 * is not in the channel, Slack answers `not_in_channel` and the push is lost to
 * a logged warning nobody reads. Recording the app in the id costs one segment
 * that every pre-existing parser already skips (it is not numeric, so the
 * thread-ts scan ignores it, and it is not `parts[0]`, so the channel is
 * unchanged), which is why ids stamped before this existed keep working
 * untouched.
 *
 * IT IS NOT A SLACK-ONLY PROBLEM, and reading it as one is how the Telegram
 * half shipped broken: Telegram runs a bot per agent too. Same scheme, same
 * parser shape, one surface over — `parseTelegramChatId` below.
 */
export function parseSlackChatId(chatId: string): {
  channel: string;
  threadTs?: string;
  appAgentId?: string;
} {
  const rest = chatId.startsWith('slack:') ? chatId.slice('slack:'.length) : chatId;
  const parts = rest.split(':');
  const channel = parts[0];
  let threadTs: string | undefined;
  let appAgentId: string | undefined;
  for (const seg of parts.slice(1)) {
    if (!threadTs && /^\d+\.\d+$/.test(seg)) {
      threadTs = seg;
      continue;
    }
    // THE LAST `app-` SEGMENT WINS, not the first, mirroring
    // `parseTelegramChatId`. Trusted code APPENDS the identity, so on the only
    // way two can occur — an untrusted channel value that already carried one —
    // the appended one is the one to believe. `threadTs` keeps first-match:
    // it is data, not an identity, and nothing appends a second.
    if (seg.startsWith('app-') && seg.length > 'app-'.length) {
      appAgentId = seg.slice('app-'.length);
    }
  }
  return { channel, ...(threadTs ? { threadTs } : {}), ...(appAgentId ? { appAgentId } : {}) };
}

/**
 * Parse a Telegram target into chat id + optional BOT identity.
 * Shapes:
 *   42                 (legacy / single identity — the caller's agent sends it)
 *   42:bot-research    (the research bot owns this conversation)
 *   -1001234:bot-main  (group chat ids are negative; still no colon in them)
 *
 * THE SAME SCHEME AS `app-` ON SLACK, and here for the same reason, restated
 * because this is the surface where forgetting it was the shipped defect: a
 * Telegram chat is owned by ONE bot token, and `sendMessage(agentId, …)`
 * chooses that token by agent id. A push built from a bare chat id had to guess
 * — it used the TURN agent, which is the sticky default (`main`), not the bot
 * whose webhook received the message (`/tg/research/webhook`). The wire call
 * then went to `api.telegram.org/bot<TOKEN-MAIN>/sendMessage` for a chat every
 * other message in reached over TOKEN-RESEARCH, which Telegram answers with
 * 403 "bot can't initiate conversation with a user" — or, if that user HAS
 * talked to the main bot, delivers into that other conversation instead, since
 * a private chat_id IS the user id.
 *
 * The marker is `bot-` and not `app-` because the id is read by people and
 * Telegram's noun is "bot"; the mechanism, the position and the skip-what-you-
 * don't-recognise parse are Slack's, deliberately, so there is one scheme to
 * learn and not two.
 */
export function parseTelegramChatId(chatId: string): {
  chatId: string;
  botAgentId?: string;
} {
  const parts = chatId.split(':');
  // THE LAST `bot-` SEGMENT WINS. The identity is APPENDED by trusted code
  // (`${replyChatId}:bot-${botAgentId}` in the Telegram handler), so if a chat
  // id ever arrives already carrying one — `parseUpdate` now refuses a
  // non-numeric `chat.id`, but a stored id predates that check — the segment
  // this repo added is the last one, and it is the one that names the bot whose
  // webhook actually received the message. Taking the FIRST let an injected
  // identity pre-empt the trusted one.
  const seg = parts
    .slice(1)
    .filter((s) => s.startsWith('bot-') && s.length > 'bot-'.length)
    .pop();
  return {
    chatId: parts[0],
    ...(seg ? { botAgentId: seg.slice('bot-'.length) } : {}),
  };
}

export { isPrincipalScopedChatId };

export async function resolveDeliveryTarget(
  task: ScheduledTask,
): Promise<DeliveryTarget | null> {
  // 1. explicit target wins
  if (task.deliveryTarget?.surface && task.deliveryTarget.chatId) {
    return task.deliveryTarget;
  }
  const chatId = task.chatId;
  // 2. prefix routing
  if (chatId.startsWith('slack:')) {
    return { surface: 'slack', chatId };
  }
  if (chatId.startsWith('dashboard:') || chatId.startsWith('system:') || chatId.startsWith('delegation:')) {
    // No outbound surface — the response persists as a session turn and the
    // dashboard polls /api/sessions for it.
    return null;
  }
  // 3. principal-scoped ids
  if (chatId.startsWith('owner:')) {
    const ownerChats = (process.env.CCE_OWNER_TELEGRAM_CHATS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (ownerChats.length > 0) {
      return { surface: 'telegram', chatId: ownerChats[0] };
    }
    logger.warn(
      { taskId: task.id, chatId },
      'owner-scoped scheduled task has no CCE_OWNER_TELEGRAM_CHATS to deliver to',
    );
    return null;
  }
  if (chatId.startsWith('user:')) {
    const canonicalId = chatId.slice('user:'.length);
    try {
      const links = await listLinks(canonicalId);
      const telegram = links.find((l) => l.surface === 'telegram');
      if (telegram) return { surface: 'telegram', chatId: telegram.surfaceUserId };
      const slack = links.find((l) => l.surface === 'slack');
      // A Slack user id is not a channel; a DM channel must be opened by id.
      // postMessage accepts a user id for DMs when the bot has im:write —
      // Slack resolves it. Best-effort.
      if (slack) return { surface: 'slack', chatId: `slack:${slack.surfaceUserId}` };
    } catch (err) {
      logger.warn(
        { taskId: task.id, errMessage: err instanceof Error ? err.message : String(err) },
        'identity-link lookup failed for scheduled delivery',
      );
    }
    return null;
  }
  // 4. legacy numeric Telegram chat id
  return { surface: 'telegram', chatId };
}

/**
 * The send half, shared by scheduled replies and by out-of-band pushes.
 *
 * ON SLACK IT RESOLVES THE APP, NOT JUST THE CHANNEL. An id carrying an `app-`
 * segment is posted with that agent's own bot token, so a message pushed into a
 * conversation the user is having with the "research" app arrives FROM the
 * research app — the same identity the per-agent event path already posts every
 * placeholder and every reply with (`tokenOverride: creds.botToken`). Without
 * the segment nothing changes: `tokenOverride` stays undefined and
 * `postMessage` falls back to the workspace `SLACK_BOT_TOKEN`, which is exactly
 * what the main bot path wants.
 *
 * If the creds lookup comes back empty — the agent's app was deleted, or DDB is
 * unhappy — this falls back to the workspace token rather than dropping the
 * message, and says so, because a message from the wrong bot is still better
 * than a message nobody sent.
 *
 * AND THE TWO SURFACES ANSWER AN UNRESOLVABLE IDENTITY OPPOSITELY, ON PURPOSE.
 * Slack falls back (above) and reports SUCCESS; Telegram refuses and reports
 * FAILURE (see below, pinned by `delivery.telegram-identity.test.ts`). The
 * asymmetry is in the surfaces, not in this file: a Slack channel is a room
 * both apps can post into, so the fallback lands in the right conversation
 * wearing the wrong name. A private Telegram chat_id IS the user id, so the
 * same fallback does not land in the right conversation at all — it either 403s
 * or arrives in a DIFFERENT chat, the user's DM with the other bot. Delivering
 * to the wrong room is worse than not delivering, so Telegram would rather say
 * it failed and let `formatMissionCreated({pushFailed:true})` tell the room.
 *
 * ON TELEGRAM IT RESOLVES THE BOT, NOT JUST THE CHAT, for exactly the same
 * reason and by exactly the same means: `bot-<agentId>` in the id names the bot
 * that owns the conversation and `sendMessage` turns that agent id into that
 * bot's token. `agentId` — the turn's agent — is only the FALLBACK, for ids
 * stamped before the segment existed and for targets a human typed into the
 * dashboard's scheduled-task form, where there is nothing better to use.
 *
 * WHERE THE FALLBACK CANNOT RESOLVE A BOT, THIS SURFACE REFUSES AND REPORTS
 * FAILURE — the opposite of the Slack branch above, which falls back to the
 * workspace app and reports success. Both are deliberate and the reason is the
 * shape of the address, not a preference: a Slack channel is a room every app
 * can post into, so the wrong app still reaches the right people; a private
 * Telegram chat_id is the USER id, so sending it over another bot's token
 * reaches a different conversation entirely, or nothing. `false` is the honest
 * answer and the receipt says so.
 *
 * IT RETURNS WHETHER THE MESSAGE LEFT. Both adapters report failure by
 * returning `{ ok: false }`, never by throwing — a 403 from a bot that cannot
 * open a conversation, a `not_in_channel` from an app that was never invited, a
 * kill switch. Dropping that on the floor is what let an assignment push that
 * Telegram refused be reported to the model as delivered.
 */
async function send(agentId: string, target: DeliveryTarget, text: string): Promise<boolean> {
  if (target.surface === 'slack') {
    const { channel, threadTs, appAgentId } = parseSlackChatId(target.chatId);
    let tokenOverride: string | undefined;
    if (appAgentId) {
      tokenOverride = (await getSlackAgentCredsAsync(appAgentId))?.botToken;
      if (!tokenOverride) {
        logger.warn(
          { appAgentId, channel },
          'per-agent slack app has no stored creds; falling back to the workspace bot token',
        );
      }
    }
    const res = await sendSlack(channel, text, {
      ...(threadTs ? { threadTs } : {}),
      ...(tokenOverride ? { tokenOverride } : {}),
    });
    if (!res.ok) {
      logger.warn({ channel, appAgentId, error: res.error }, 'slack delivery failed');
    }
    return res.ok;
  }
  const { chatId, botAgentId } = parseTelegramChatId(target.chatId);
  const res = await sendTelegram(botAgentId ?? agentId, chatId, text, {});
  if (!res.ok) {
    logger.warn(
      { chatId, botAgentId: botAgentId ?? agentId, error: res.error },
      'telegram delivery failed',
    );
  }
  return res.ok;
}

export async function deliverScheduledReply(
  task: ScheduledTask,
  text: string,
): Promise<void> {
  const target = await resolveDeliveryTarget(task);
  if (!target) return;
  await send(task.agentId, target, text);
}

/**
 * Post an unprompted message into the chat a turn came from — the plumbing an
 * out-of-band push needs, and the only push primitive in the codebase.
 *
 * Takes `ToolContext.replyChatId`, which is a SURFACE-NATIVE id by definition
 * AND CARRIES THE BOT THAT OWNS THE CONVERSATION on every surface that runs
 * more than one: `<chatId>:bot-<agentId>` from Telegram's per-agent webhook,
 * `slack:<channel>:app-<agentId>[:<threadTs>]` from Slack's per-agent apps,
 * `slack:<channel>[:<threadTs>]` from the Slack main bot, which has only the
 * workspace identity to be. That is why this routes on the prefix alone and
 * skips `resolveDeliveryTarget`'s principal ladder — the `owner:*` / `user:*`
 * aliases live on `chatId`, and `replyChatId` exists precisely so a caller
 * never has to resolve one.
 *
 * Returns whether the message was DELIVERED, and never throws for a surface
 * that simply refused it, so a caller can tell "the room was told" from "the
 * room was not" without a try/catch. Two things are false, and the caller is
 * meant to treat them the same way — as "not delivered", because that is all
 * either one means to a reader:
 *   - the surface has no out-of-band channel at all (`dashboard:` / `system:` /
 *     `delegation:` are request/response, with nothing listening between
 *     turns), so nothing was attempted;
 *   - the send was attempted and the adapter reported `{ ok: false }` — a 403,
 *     a `not_in_channel`, a kill switch, an unknown bot.
 */
export async function deliverToReplyChat(
  agentId: string,
  replyChatId: string,
  text: string,
): Promise<boolean> {
  if (!replyChatId) return false;
  if (
    replyChatId.startsWith('dashboard:') ||
    replyChatId.startsWith('system:') ||
    replyChatId.startsWith('delegation:')
  ) {
    return false;
  }
  const target: DeliveryTarget = replyChatId.startsWith('slack:')
    ? { surface: 'slack', chatId: replyChatId }
    : { surface: 'telegram', chatId: replyChatId };
  return send(agentId, target, text);
}
