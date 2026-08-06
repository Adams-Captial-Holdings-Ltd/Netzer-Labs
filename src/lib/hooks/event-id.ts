/**
 * Stable event ID derivation. Uses persisted turn state (not wall clock)
 * so retries and redrives produce the same eventId.
 */

import { createHash } from 'node:crypto';

export function deriveEventId(
  hookId: string,
  agentId: string,
  chatId: string,
  turnSeq: number,
): string {
  return createHash('sha256')
    .update(`${hookId}:${agentId}:${chatId}:${turnSeq}`)
    .digest('hex')
    .slice(0, 24);
}
