/**
 * C2 · Slack interactive dispatcher.
 *
 * Slack POSTs to /slack/interactive whenever a user clicks a button or
 * submits a modal view. The payload is application/x-www-form-urlencoded
 * with a single `payload=<JSON>` field; the JSON has a `type` discriminator:
 *
 *   block_actions  — a button or other Block Kit element was clicked
 *   view_submission — a modal view was submitted
 *   view_closed    — a modal was dismissed without submitting
 *
 * We respond with a JSON body Slack uses to update the message. The
 * dispatch table below maps `payload.actions[0].action_id` (for
 * block_actions) or `payload.view.callback_id` (for view_submission) to
 * the handler that does the actual work.
 */

import { logger } from '../../observability/logger.js';
import { writeAudit } from '../../lib/audit/audit-writer.js';
import { purgeChatData } from '../../lib/tools/privacy-tools.js';
import { resolvedMessage } from './blocks.js';

export interface BlockAction {
  action_id: string;
  block_id?: string;
  type: string;
  value?: string;
}

export interface InteractivePayload {
  type: string;
  user?: { id?: string; username?: string };
  channel?: { id?: string };
  trigger_id?: string;
  actions?: BlockAction[];
  view?: { callback_id?: string; state?: { values?: Record<string, unknown> } };
  response_url?: string;
}

export interface DispatchResult {
  /** JSON body to return to Slack. Use {} when no response is needed. */
  body: Record<string, unknown>;
  /** HTTP status; defaults to 200. */
  status?: number;
}

/**
 * Parse the form-encoded body Slack sends. Returns null when the
 * payload is missing or invalid JSON.
 */
export function parseInteractivePayload(rawBody: string): InteractivePayload | null {
  const params = new URLSearchParams(rawBody);
  const payload = params.get('payload');
  if (!payload) return null;
  try {
    return JSON.parse(payload) as InteractivePayload;
  } catch {
    return null;
  }
}

export async function dispatch(payload: InteractivePayload): Promise<DispatchResult> {
  switch (payload.type) {
    case 'block_actions':
      return dispatchBlockAction(payload);
    case 'view_submission':
      return dispatchViewSubmission(payload);
    case 'view_closed':
      return { body: {} };
    default:
      logger.warn({ type: payload.type }, 'unknown slack interactive payload type');
      return { body: {} };
  }
}

async function dispatchBlockAction(payload: InteractivePayload): Promise<DispatchResult> {
  const action = payload.actions?.[0];
  if (!action) return { body: {} };

  const userId = payload.user?.id ?? 'unknown';
  const channel = payload.channel?.id ?? 'unknown';

  switch (action.action_id) {
    case 'forget_me_confirm':
      return forgetMeConfirm(userId, channel, action.value);
    case 'forget_me_cancel':
    case 'cancel':
      logger.info({ userId, channel, action_id: action.action_id }, 'slack action cancelled');
      return {
        body: resolvedMessage(':white_check_mark: Cancelled. Nothing was deleted.'),
      };
    default:
      logger.warn(
        { action_id: action.action_id, userId },
        'no handler for slack block action',
      );
      return {
        body: resolvedMessage(`No handler for action \`${action.action_id}\`.`),
      };
  }
}

async function forgetMeConfirm(
  userId: string,
  channel: string,
  value: string | undefined,
): Promise<DispatchResult> {
  // `value` carries the chatId we want to purge. The slash command
  // sets it to the same chatId the agent loop uses for this user.
  const chatId = value && value.length > 0 ? value : `slack:${channel}:${userId}`;
  const agentId = 'main';

  try {
    const report = await purgeChatData(agentId, chatId, `slack-interactive:${userId}`);
    void writeAudit({
      action: 'data_purged',
      agentId,
      chatId,
      detail: {
        surface: 'slack',
        trigger: 'interactive_confirm',
        userId,
        counts: report.counts,
        preDeleteHash: report.preDeleteHash,
      },
      result: 'ok',
    });
    return {
      body: resolvedMessage(
        `:wastebasket: Purged. Removed ${report.counts.memories} memories, ${report.counts.scheduledTasks} scheduled tasks, ${report.counts.inboxItems} inbox items. Pre-delete hash recorded in audit log.`,
      ),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ userId, chatId, errMessage: msg }, 'forget_me purge failed');
    return {
      body: resolvedMessage(
        `:x: Purge failed: ${msg.slice(0, 200)}. Audit log untouched.`,
      ),
    };
  }
}

async function dispatchViewSubmission(
  payload: InteractivePayload,
): Promise<DispatchResult> {
  const callbackId = payload.view?.callback_id ?? '';
  logger.info({ callbackId }, 'slack view_submission (no handler registered yet)');
  // No modals wired in yet; future schedule-quick-add modal lands here.
  return { body: {} };
}
