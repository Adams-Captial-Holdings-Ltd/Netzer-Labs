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
 */

import { logger } from '../../observability/logger.js';
import { sendMessage as sendTelegram } from '../../adapters/telegram/send.js';
import { postMessage as sendSlack } from '../../adapters/slack/send.js';
import { listLinks } from '../state/identities-repo.js';
import { isPrincipalScopedChatId } from '../identity/owner-alias.js';
import type { ScheduledTask } from '../state/scheduled-tasks-repo.js';

export interface DeliveryTarget {
  surface: 'telegram' | 'slack';
  /** Telegram chat_id, or a Slack channel (optionally "channel:threadTs"). */
  chatId: string;
}

/**
 * Parse the slack:* chatId shapes into channel + optional thread ts.
 * Possible shapes (Phase B2 multi-user awareness):
 *   slack:CXXXX                       (DM, legacy pre-v3)
 *   slack:CXXXX:UYYYY                 (channel, user-scoped)
 *   slack:CXXXX:1234567890.123456     (DM thread, legacy)
 *   slack:CXXXX:UYYYY:1234567890.123  (channel thread, user-scoped)
 * Channel ids start C/G/D, user ids U/W; thread ts is numeric.decimal.
 */
export function parseSlackChatId(chatId: string): { channel: string; threadTs?: string } {
  const rest = chatId.startsWith('slack:') ? chatId.slice('slack:'.length) : chatId;
  const parts = rest.split(':');
  const channel = parts[0];
  let threadTs: string | undefined;
  for (const seg of parts.slice(1)) {
    if (/^\d+\.\d+$/.test(seg)) {
      threadTs = seg;
      break;
    }
  }
  return { channel, ...(threadTs ? { threadTs } : {}) };
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

export async function deliverScheduledReply(
  task: ScheduledTask,
  text: string,
): Promise<void> {
  const target = await resolveDeliveryTarget(task);
  if (!target) return;
  if (target.surface === 'slack') {
    const { channel, threadTs } = parseSlackChatId(target.chatId);
    await sendSlack(channel, text, threadTs ? { threadTs } : {});
    return;
  }
  await sendTelegram(task.agentId, target.chatId, text, {});
}
