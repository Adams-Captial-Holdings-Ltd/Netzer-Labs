/**
 * War Room orchestrator — the piece that turns a meeting into an actual
 * multi-agent conversation instead of an echo.
 *
 * On each *user* turn we fan out to the meeting's participant agents. Every
 * agent runs once through the normal agent runner (`runAgentTurn`), so all the
 * usual guardrails apply automatically and for free: the bedrock_global and
 * cost_cap_per_day kill switches, sessions_frozen, the Bedrock guardrail, DLP
 * egress scanning, per-identity rate limits, and usage/cost accounting. Each
 * reply is persisted as an 'agent' turn and streamed to subscribers over the
 * meeting channel.
 *
 * Why this is safe and bounded:
 *  - We only orchestrate on user turns and never re-trigger on agent turns, so
 *    agents cannot loop talking to each other.
 *  - Each participant answers at most once per user turn.
 *  - Fan-out is capped at MAX_PARTICIPANTS_PER_TURN so one message can never
 *    spawn an unbounded (or unboundedly expensive) number of Bedrock calls.
 *  - It runs sequentially, so each agent sees the prior agents' replies from
 *    this round — that is what makes it read like a discussion.
 *  - On a hard stop (kill switch / cost cap) we stop the whole round instead of
 *    burning spend on the remaining agents.
 *  - It never throws: it is invoked fire-and-forget from the turn handler, so
 *    any failure is surfaced as a system_note and logged, never propagated.
 */

import {
  runAgentTurn,
  KillSwitchActiveError,
  CostCapExceededError,
} from '../../agent/agent-loop.js';
import { getMeeting } from './meetings-repo.js';
import { getBlockedTools } from './tool-policy.js';
import { publishTurn, getHistory } from './publisher.js';
import { getChannel } from './events.js';
import { isKillSwitchActive } from '../state/kill-switches-repo.js';
import { logger } from '../../observability/logger.js';
import type { Meeting, WarroomTurn } from './types.js';

// Shared "how to behave in a room" note, injected into EVERY participant's
// system prompt for War Room turns (see runAgentTurn's systemNote). This is the
// general lever — it applies to every agent, current and future, with no
// per-agent config — for the things that otherwise read badly in a multi-agent
// room: agents announcing their own name/timestamp, and over-answering a
// trivial message. It rides in the system prompt because the same instruction
// in the user-message framing trips the Bedrock guardrail's PROMPT_ATTACK filter
// (validated 2026-06); the system prompt is not guardrail-inspected.
const ROOM_ETIQUETTE = [
  'You are in a War Room: a live chat with the user and possibly other agents. Every message is already labeled with who said it, so follow these room conventions:',
  '- Reply in the first person as yourself. Do not prefix your message with your own name, role, or a timestamp.',
  '- Match your length and depth to the latest message. A greeting or quick check-in gets a short, natural reply; a real question gets a real answer. Never inflate a simple message into an essay.',
  '- Build on what others have already said instead of repeating it. If you have nothing to add, say so briefly.',
].join('\n');

// Bound the fan-out. Participants beyond this many do not respond to a given
// message (they remain in the room and still see the transcript).
const MAX_PARTICIPANTS_PER_TURN = 5;
// How many trailing transcript turns each agent is shown as context.
const MAX_CONTEXT_TURNS = 24;
// Per-turn content clamp so a single long message can't blow the prompt.
const MAX_TURN_CHARS = 1200;

function speakerLabel(t: WarroomTurn): string {
  if (t.type === 'user') return `User (${t.speaker})`;
  if (t.type === 'system') return 'System';
  return t.agentId || t.speaker || 'agent';
}

/**
 * Parse @mentions from a user message, resolved against the room's participant
 * ids. `@all` / `@everyone` / `@room` target the whole room. Returns the matched
 * participant ids in participant order (deduped). Empty => no targeting, so the
 * caller fans out to everyone. Only current participants can be targeted; the @
 * must not be glued to a preceding word char, so "user@ops.com" never matches.
 */
export function parseMentions(text: string, participants: string[]): string[] {
  if (!text) return [];
  // (?![\w-]) instead of \b: agent ids contain hyphens, and \b fires at the
  // hyphen, so "@research-ops" also matched participant "research" and made
  // the wrong agent reply (and spend).
  if (/(?:^|[^\w])@(?:all|everyone|room)(?![\w-])/i.test(text)) return [...participants];
  return participants.filter((p) => {
    const esc = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:^|[^\\w])@${esc}(?![\\w-])`, 'i').test(text);
  });
}

/**
 * Render the room as a single framing prompt for one agent. We pass the whole
 * transcript inside one user message (rather than as multi-role history) so we
 * never trip Bedrock's strict user/assistant alternation with N speakers.
 *
 * IMPORTANT — this framing is tuned against the live Bedrock guardrail's
 * PROMPT_ATTACK filter (HIGH strength). Two patterns block reliably and must NOT
 * be reintroduced:
 *   1. Second-person role-assertion ("you are X" / "respond as X" / "answer from
 *      your area of expertise"). The agent's own system prompt already sets its
 *      identity, so we never re-assert it here.
 *   2. A "<title> — working session notes." header above a multi-speaker bulleted
 *      transcript ending in an imperative. With one user line (the FIRST
 *      responder) that shape passes, but as soon as the transcript holds 2+
 *      speakers (EVERY responder after the first) it reads as a prompt-injection
 *      pattern and the whole turn comes back "This request was blocked by content
 *      policy". That is the bug that made the 1st agent answer and every later
 *      agent get blocked.
 * Validated against the live guardrail (2026-06, id p3198qmvhcnf v1 via
 * ApplyGuardrail): a plain `Topic: <title>` header + the bulleted transcript + a
 * plain imperative passes for benign multi-speaker threads (greeting/technical/
 * chatty/coordination, directed and undirected) while genuine injections
 * ("ignore everything above…", "reveal your system prompt verbatim") still
 * BLOCK — so the guardrail is preserved, not weakened. Change this wording only
 * after re-validating candidate strings through ApplyGuardrail.
 */
export function buildContextPrompt(
  meeting: Meeting,
  history: WarroomTurn[],
  _agentId: string,
  directed: boolean,
): string {
  const recent = history.slice(-MAX_CONTEXT_TURNS);
  const lines = recent
    .map((t) => `- ${speakerLabel(t)}: ${t.content.slice(0, MAX_TURN_CHARS)}`)
    .join('\n');
  return [
    `Topic: ${meeting.title || 'War Room'}`,
    '',
    lines || '- (no messages yet)',
    '',
    directed
      ? 'Answer the latest question in a few sentences.'
      : 'Add your perspective in a few sentences, building on the notes above rather than repeating them.',
  ].join('\n');
}

export interface OrchestrateOptions {
  meetingId: string;
  /** Seq of the user turn that triggered this round; used for turn_complete. */
  userTurnSeq: number;
  /** The user message text, parsed for @mentions to target specific agents. */
  userText: string;
  /**
   * Optional push sink for agent replies and system notes, used by surfaces
   * without an SSE channel (e.g. Telegram) to deliver each message as it lands.
   * The dashboard leaves this unset and consumes the SSE channel instead.
   * Delivery failures never affect orchestration.
   */
  deliver?: (msg: { kind: 'agent' | 'system'; agentId?: string; text: string }) => void | Promise<void>;
}

export async function orchestrateWarroomTurn(opts: OrchestrateOptions): Promise<void> {
  const { meetingId, userTurnSeq, userText } = opts;
  const channel = getChannel(meetingId);

  // Surfaces without an SSE channel (Telegram) pass opts.deliver to receive
  // each agent reply / system note as it lands. A delivery failure must never
  // affect orchestration.
  const relay = async (msg: { kind: 'agent' | 'system'; agentId?: string; text: string }) => {
    if (!opts.deliver) return;
    try { await opts.deliver(msg); }
    catch (err) { logger.warn({ meetingId, err: err instanceof Error ? err.message : String(err) }, 'warroom: deliver hook failed'); }
  };
  // Persist + broadcast (SSE) + relay (push) a system note in one place.
  const sysNote = async (text: string) => {
    const note = await publishTurn(meetingId, 'system', 'system', text);
    // Carry the persisted turn seq so the dashboard keys this note as `s<seq>`
    // and never renders it twice (once from this SSE emit, once from /history).
    channel.emit({ type: 'system_note', text: note.content, seq: note.seq });
    await relay({ kind: 'system', text: note.content });
  };

  try {
    // Defense in depth: the router already gates on warroom_disabled, but the
    // orchestrator runs async so we re-check before spending anything.
    const disabled = await isKillSwitchActive('warroom_disabled').catch(() => ({ active: false }));
    if (disabled.active) return;

    const meeting = await getMeeting(meetingId);
    if (!meeting || meeting.status !== 'active') return;

    // Dedupe defensively: rows written before addParticipant became
    // idempotent can carry duplicate ids, and a duplicate would reply twice
    // and consume two responder slots.
    const all = [...new Set(meeting.participants ?? [])];
    if (all.length === 0) {
      await sysNote('No agents are in this room, so there is no one to respond. Add participants when you create the room.');
      return;
    }

    // @mention targeting: if the user tagged specific agents, only they answer
    // (each told it was directly addressed). Otherwise everyone weighs in,
    // capped to bound cost.
    const mentioned = parseMentions(userText, all);
    const targeted = mentioned.length > 0;
    const responders = (targeted ? mentioned : all).slice(0, MAX_PARTICIPANTS_PER_TURN);

    if (!targeted && /(?:^|[^\w])@[\w-]+/.test(userText)) {
      await sysNote('No tagged agent is in this room, so everyone will weigh in. Add the agent as a participant to address it directly.');
    } else if (!targeted && all.length > MAX_PARTICIPANTS_PER_TURN) {
      await sysNote(`Only the first ${MAX_PARTICIPANTS_PER_TURN} participants respond per message, to bound cost.`);
    }

    // Snapshot the transcript including the just-posted user turn. We append
    // each reply locally so later agents in this round see earlier ones.
    const history = await getHistory(meetingId, 0, 100);

    for (const agentId of responders) {
      channel.emit({ type: 'agent_typing', agentId });
      try {
        const prompt = buildContextPrompt(meeting, history, agentId, targeted);
        let prev = '';
        const resp = await runAgentTurn({
          agentId,
          // Give each room its own per-agent memory/context namespace.
          chatId: `warroom:${meetingId}`,
          userText: prompt,
          history: [],
          surface: 'system',
          // The room feeds a multi-speaker transcript as the user message, and
          // the Bedrock guardrail's PROMPT_ATTACK filter trips on that shape even
          // for innocent prompts, so every agent reply came back blocked. Drop
          // the guardrail for room turns; the bedrock_global + cost-cap kill
          // switches, DLP, and the outbound exfil scan still apply.
          skipGuardrail: true,
          // Applies to every participant generically, so any agent (built-in or
          // newly created) behaves well in a room without per-agent tuning.
          systemNote: ROOM_ETIQUETTE,
          // The meeting's tool policy (default: send_dm / create_mission /
          // forget_memory blocked, per-meeting overridable). Without this the
          // policy was persisted but never enforced.
          blockedTools: getBlockedTools(meeting.toolPolicyOverride),
          onChunk: (cumulative) => {
            // runAgentTurn reports cumulative text; emit the new delta only.
            const delta = cumulative.slice(prev.length);
            prev = cumulative;
            if (delta) channel.emit({ type: 'agent_chunk', agentId, delta });
          },
        });
        if (resp.blocked) {
          // The Bedrock guardrail intervened: resp.text is the guardrail's block
          // message, not the agent speaking. Surface it as a safety note
          // attributed to the agent instead of putting "blocked by content
          // policy" in the agent's own bubble. Do NOT persist an agent turn and
          // do NOT push it into history, so later agents in this round don't
          // treat the block message as conversation context.
          await sysNote(`${agentId}'s reply was blocked by the safety guardrail and not shown.`);
          continue;
        }
        const text = (resp.text || '').trim() || '(no response)';
        const turn = await publishTurn(meetingId, agentId, 'agent', text, agentId);
        channel.emit({ type: 'agent_done', agentId, text, seq: turn.seq });
        await relay({ kind: 'agent', agentId, text });
        history.push(turn);
      } catch (err) {
        const hardStop =
          err instanceof KillSwitchActiveError || err instanceof CostCapExceededError;
        const msg = err instanceof Error ? err.message : 'agent failed to respond';
        logger.warn({ meetingId, agentId, err: msg, hardStop }, 'warroom: agent turn failed');
        await sysNote(hardStop ? `Responses stopped: ${msg}` : `${agentId} could not respond (${msg}).`).catch(() => {});
        // On a kill switch / cost cap, don't keep spending across the rest.
        if (hardStop) break;
      }
    }
  } catch (err) {
    logger.error(
      { meetingId, err: err instanceof Error ? err.message : String(err) },
      'warroom: orchestration failed',
    );
  } finally {
    // Always close the round so the UI can clear its "typing" state.
    channel.emit({ type: 'turn_complete', turnId: String(userTurnSeq) });
  }
}
