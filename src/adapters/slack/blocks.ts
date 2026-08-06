/**
 * Slack Block Kit JSON builders (C2).
 *
 * Slack accepts a `blocks` array in any chat.postMessage / response. We
 * return JSON-serializable objects here; callers stringify or pass them
 * directly via the Slack Web API.
 *
 * https://api.slack.com/reference/block-kit/blocks
 */

export interface Block {
  type: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

export interface ConfirmActionParams {
  /** Human title rendered above the buttons. */
  title: string;
  /** Sub-text rendered between the title and the buttons. */
  detail?: string;
  /** Identifier the interactive handler matches on for the confirm click. */
  confirmActionId: string;
  /** Identifier the interactive handler matches on for the cancel click. */
  cancelActionId?: string;
  /** Label on the confirm button. */
  confirmLabel?: string;
  /** Label on the cancel button. */
  cancelLabel?: string;
  /** Opaque value(s) passed back to the interactive handler. */
  value?: string;
}

/**
 * Confirm + cancel buttons under a header. Used by /claw forget-me
 * (and any future destructive command that wants a Slack-native gate).
 */
export function confirmActionBlocks(p: ConfirmActionParams): Block[] {
  const blocks: Block[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: p.title, emoji: false },
    },
  ];
  if (p.detail) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: p.detail },
    });
  }
  blocks.push({
    type: 'actions',
    block_id: 'confirm_block',
    elements: [
      {
        type: 'button',
        action_id: p.confirmActionId,
        style: 'danger',
        text: { type: 'plain_text', text: p.confirmLabel ?? 'Confirm', emoji: false },
        ...(p.value ? { value: p.value } : {}),
      },
      {
        type: 'button',
        action_id: p.cancelActionId ?? 'cancel',
        text: { type: 'plain_text', text: p.cancelLabel ?? 'Cancel', emoji: false },
        ...(p.value ? { value: p.value } : {}),
      },
    ],
  });
  return blocks;
}

/**
 * Replaces the current message with a static result line, removing the
 * buttons. Used as the response to an interactive button click so the
 * UI clearly transitions out of "awaiting confirm".
 */
export function resolvedMessage(text: string): Record<string, unknown> {
  return {
    response_type: 'ephemeral',
    replace_original: true,
    text,
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text },
      },
    ],
  };
}
