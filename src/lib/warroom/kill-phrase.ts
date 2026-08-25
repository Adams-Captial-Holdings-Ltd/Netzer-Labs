/**
 * The emergency kill phrase, for a person typing into a live War Room.
 *
 * WHY THIS EXISTS AS ITS OWN PIECE. A room message never reaches the five chat
 * call sites that declare `origin: 'human_chat'`: both entry points hand the
 * message to `orchestrateWarroomTurn`, which calls `runAgentTurn` with a
 * `buildContextPrompt` TRANSCRIPT as `userText` and no origin — machine text,
 * by design. Without this check a person in an active room types the phrase
 * and gets nothing, on the two surfaces the origin gate promised to leave
 * alone.
 *
 * WHY IT IS NOT IN THE ORCHESTRATOR. The orchestrator only ever sees the
 * assembled transcript, which also carries AGENTS' replies and older turns.
 * Honouring the phrase there would let an agent's own words halt the fleet, and
 * would re-halt from a stale line on every later round. So the check runs on
 * the RAW message, once, at the moment it is received — before `publishTurn`,
 * so the phrase never becomes a transcript line at all.
 *
 * WHY IT IS HERE AND NOT IN AN ADAPTER. Telegram and the dashboard must behave
 * identically (CLAUDE.md's surface-parity rule); the one copy of the decision
 * lives in this surface-agnostic module and each adapter only renders the
 * result. The freeze and the confirmation copy come from `engageEmergencyHalt`,
 * the same code the chat call sites use, so the person gets the same words they
 * would get outside a room.
 */

import { matchesKillPhrase, engageEmergencyHalt } from '../../agent/agent-loop.js';
import { publishTurn } from './publisher.js';
import { getChannel } from './events.js';
import { logger } from '../../observability/logger.js';

/**
 * Check a human's raw War Room message for the kill phrase.
 *
 * Returns the confirmation text to show the person when the phrase fired (the
 * fleet is halted by then), or null when it did not — in which case the caller
 * proceeds with the turn exactly as before. Never throws.
 *
 * On a hit it also records the confirmation as a `system` turn and emits it on
 * the meeting channel, so the dashboard's SSE transcript shows it; surfaces
 * without a channel (Telegram) deliver the returned text themselves.
 */
export async function haltWarroomOnKillPhrase(opts: {
  meetingId: string;
  /** The message EXACTLY as the person typed it. Never a transcript. */
  rawText: string;
  surface: 'telegram' | 'dashboard';
}): Promise<string | null> {
  if (!matchesKillPhrase(opts.rawText)) return null;

  const text = await engageEmergencyHalt({
    // The room, not any one participant: the halt is fleet-wide, and this is
    // the same chatId namespace the room's agent turns run under.
    agentId: 'warroom',
    chatId: `warroom:${opts.meetingId}`,
    surface: opts.surface,
  });

  // Best effort: the halt already happened and the caller must be told, so a
  // transcript write that fails can never swallow the confirmation.
  try {
    const note = await publishTurn(opts.meetingId, 'system', 'system', text);
    getChannel(opts.meetingId).emit({ type: 'system_note', text: note.content, seq: note.seq });
  } catch (err) {
    logger.warn(
      { meetingId: opts.meetingId, err: err instanceof Error ? err.message : String(err) },
      'warroom: kill phrase halted the fleet but the transcript note failed',
    );
  }

  return text;
}
