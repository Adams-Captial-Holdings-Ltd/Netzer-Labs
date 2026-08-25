/**
 * Slash command router. Runs before the agent loop.
 *
 * Commands:
 *   /newchat            wipe conversation history for this chat+agent
 *   /model <label>      set THIS agent's default model (persists, dashboard-visible)
 *   /model              show the agent's current model + the available catalog
 *   /model reset        clear the agent's model back to the platform default
 *   /reset              alias for /newchat
 *   /help               list available commands
 *   /status             show env, model, history length
 *   /agents             list available agents
 *   /agent <id>         set sticky agent for this chat (via session)
 *   /missions [status]  this agent's mission board
 *   /mission <id>|new <title>|done <id>
 *
 * MISSIONS ARE THE CROSS-SURFACE CASE (CLAUDE.md, "chat surface parity"). The
 * board was dashboard-only. It reaches Telegram, both Slack send paths and the
 * dashboard through THIS router and nothing else — every chat entry point
 * already calls runCommand() and posts CommandResult.reply verbatim, so the
 * copy cannot drift between surfaces. The words themselves live in the pure
 * shared module src/lib/missions/format.ts; see missionCommand() below.
 *
 * Returns a CommandResult with the reply text and any side effect already
 * applied. If the input wasn't a command, returns null and the caller
 * proceeds with the normal agent loop.
 */

import {
  clearSession,
  setModelOverride,
  setWarroomMode,
  getSession,
} from '../lib/state/sessions-repo.js';
import { listKnownAgents, loadAgent, invalidateAgentCache } from '../lib/config/agent-loader.js';
import { updateAgent } from '../lib/state/agents-repo.js';
import { publishInvalidation } from '../lib/config/invalidation-publisher.js';
import { pickDefaultModel, resolveModel, listAvailableModels } from '../lib/bedrock/models.js';
import {
  createMeeting,
  getMeeting,
  endMeeting,
} from '../lib/warroom/meetings-repo.js';
import { parseMentions } from '../lib/warroom/orchestrator.js';
import {
  AmbiguousMissionPrefixError,
  createBoardMission,
  listBoardMissions,
  listBoardMissionsByStatus,
  setBoardMissionStatus,
} from '../lib/missions/mission-acl.js';
import {
  MISSION_HELP_LINES,
  MISSION_LIST_LIMIT,
  MISSION_RESOLVE_WINDOW,
  formatAmbiguousRef,
  formatBoardError,
  formatMissionCard,
  formatMissionList,
  formatMissionUsage,
  formatNoMatch,
  formatStatusChanged,
  formatUnknownStatus,
  resolveMissionRef,
} from '../lib/missions/format.js';
import { MISSION_STATUSES, type MissionStatus } from '../lib/state/mission-tasks-repo.js';

export interface CommandResult {
  reply: string;
  /** If the command rerouted the message to an agent, the cleaned text. */
  forwardedText?: string;
  /** Agent the message should be forwarded to (e.g., after /agent ops hi). */
  forwardedAgentId?: string;
}

/**
 * A COMMAND HAS TWO SCOPES, AND CONFLATING THEM CORRUPTS ONE OF THEM.
 *
 * `runCommand`'s first argument is the SESSION scope: the agent whose session
 * row, history and agent record this chat uses. `/newchat`, `/reset`,
 * `/status`, `/context`, `/warroom`, `/endroom` and `/model` all read or write
 * exactly the records the ordinary chat turn in the same conversation reads and
 * writes, so this id MUST be the id that chat turn uses. Hand them a different
 * one and the command reports success against records nobody reads: "Conversation
 * cleared." with the history still there, `history: 0 turn(s)` on a live
 * session, a war-room flag on a session the war-room check never looks at.
 *
 * `boardAgentId` is the BOARD scope, and it is a different kind of thing: the
 * mission board is a REMOTE object named by an agent id, not a record of this
 * conversation. `/missions` and `/mission` are the only commands that address
 * it, and the agent whose board a person means is the bot they typed at (see
 * the Telegram and Slack call sites, and CLAUDE.md "chat surface parity") —
 * which on a per-agent bot is not the agent their session is keyed under.
 *
 * It defaults to the session scope, so a caller with one identity (Slack's
 * per-agent apps, the dashboard) passes nothing and gets the old behaviour.
 */
export interface CommandScope {
  /** Agent whose mission board `/missions` and `/mission` act on. */
  boardAgentId?: string;
}

const HELP_TEXT = [
  '/newchat — start a fresh conversation (wipes history for this chat)',
  '/model — show this agent\'s model + the available models with context windows',
  '/model <label> — set this agent\'s default model (opus, opus-1m, sonnet, sonnet-1m, haiku); applies everywhere',
  '/context — show context window usage (tokens used / remaining)',
  '/warroom [title] — start a war room (messages auto-route until /endroom)',
  '/endroom — leave war room and return to normal chat',
  '/agents — list available agents',
  '/agent <id> [message] — talk to a specific agent',
  // The two mission lines are the shared module's, not this file's: the
  // advertisement is user-visible copy like every other mission string (A3-4).
  ...MISSION_HELP_LINES,
  '/dashboard — get the dashboard URL',
  '/status — show env, model, history length',
  '/help — show this list',
].join('\n');

export async function runCommand(
  agentId: string,
  chatId: string,
  text: string,
  scope: CommandScope = {},
): Promise<CommandResult | null> {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;
  const match = trimmed.match(/^\/(\w+)(?:\s+(.*))?$/s);
  if (!match) return null;
  const cmd = match[1].toLowerCase();
  const rest = (match[2] ?? '').trim();
  const known = listKnownAgents();

  switch (cmd) {
    case 'start':
    case 'help':
      return {
        reply:
          `Netzar OS Enterprise on AWS Bedrock.\n\n${HELP_TEXT}\n\nJust send a message to chat — by default you talk to the 'main' agent.`,
      };

    case 'newchat':
    case 'reset':
      await clearSession(agentId, chatId);
      return { reply: 'Conversation cleared. Send a message to start fresh.' };

    case 'model': {
      // /model sets the AGENT'S saved default — the same field the dashboard
      // edits — so it propagates to every task and every chat and shows in the UI
      // (one source of truth). The agent here is the SESSION scope: the agent
      // the message routed to (a per-agent bot's own agent, or the picker's
      // choice on the main bot), which is the agent that will answer the next
      // ordinary message in this conversation and load the model set here.
      // Deliberately NOT the board scope — editing the receiving bot's record
      // while the next turn loads a different agent's would confirm a change
      // the user never gets.
      const available = listAvailableModels(process.env);
      const agent = await loadAgent(agentId);
      const envDefault = pickDefaultModel(process.env);
      const current = agent.model || envDefault;

      if (!rest) {
        const currentSpec = resolveModel(current);
        const lines = [
          `Agent: ${agentId}`,
          `Current model: ${current}${agent.model ? '' : '  (platform default — no per-agent model set)'}`,
          `Context: ${formatTokenCount(currentSpec.contextWindow)}`,
          '',
          'Available models:',
          ...available.map(m => {
            const active = m.id === current ? ' (active)' : '';
            return `  ${m.label} — ${formatTokenCount(m.contextWindow)}${active}`;
          }),
          '',
          "Switch (sets this agent's default everywhere): /model <label>  e.g. /model opus",
          'Reset to the platform default: /model reset',
        ];
        return { reply: lines.join('\n') };
      }

      if (rest === 'reset' || rest === 'default') {
        await updateAgent(agentId, { model: undefined });
        invalidateAgentCache(agentId);
        void publishInvalidation('agent', agentId);
        // Drop any legacy per-chat override so the reset default actually applies.
        await setModelOverride(agentId, chatId, null);
        return { reply: `Model reset. ${agentId} now uses the platform default: ${envDefault}` };
      }

      const match = available.find(m => m.label === rest.toLowerCase() || m.id === rest);
      if (!match) {
        // Reject unknown ids: an invalid default would ValidationException on
        // every future turn for this agent. Show the valid labels instead.
        const labels = available.map(m => m.label).join(', ');
        return { reply: `Unknown model "${rest}". Available: ${labels}. Usage: /model <label>` };
      }
      await updateAgent(agentId, { model: match.id });
      invalidateAgentCache(agentId);
      void publishInvalidation('agent', agentId);
      // Clear any old per-chat override so the new default takes effect right now,
      // not just after the 7-day session TTL retires the stale override.
      await setModelOverride(agentId, chatId, null);
      return {
        reply:
          `${agentId} model set to ${match.label} (${formatTokenCount(match.contextWindow)} context).\n${match.id}\n\n` +
          "That's this agent's default now — it applies in every chat and shows in the dashboard.",
      };
    }

    case 'context': {
      const session = await getSession(agentId, chatId);
      if (!session?.lastInputTokens || !session?.contextWindow) {
        return { reply: 'No context data yet. Send a message first, then try /context again.' };
      }
      const used = session.lastInputTokens;
      const total = session.contextWindow;
      const remaining = total - used;
      const pct = Math.round((used / total) * 100);
      const barLen = 20;
      const filled = Math.round((pct / 100) * barLen);
      const bar = '█'.repeat(filled) + '░'.repeat(barLen - filled);
      const model = session.lastModelId ?? 'unknown';
      const lines = [
        `Context usage: ${formatTokenCount(used)} / ${formatTokenCount(total)} (${pct}%)`,
        `[${bar}]`,
        `Remaining: ~${formatTokenCount(remaining)}`,
        `Model: ${model}`,
        `History: ${session.turns.length} turns`,
      ];
      return { reply: lines.join('\n') };
    }

    case 'status': {
      const session = await getSession(agentId, chatId);
      const agent = await loadAgent(agentId);
      const model = session?.modelOverride ?? agent.model ?? pickDefaultModel(process.env);
      const lines = [
        `agent: ${agentId}`,
        `model: ${model}`,
        `history: ${session?.turns.length ?? 0} turn(s)`,
        `env: ${process.env.NODE_ENV ?? 'unknown'}`,
        `region: ${process.env.AWS_REGION ?? 'unknown'}`,
      ];
      return { reply: lines.join('\n') };
    }

    case 'warroom': {
      // Participants: any @agents tagged in the command, otherwise all known
      // agents (capped). An empty room can't respond, so it always gets agents.
      const tagged = parseMentions(rest, known);
      const participants = tagged.length ? tagged : known.slice(0, 5);
      const title = rest.replace(/(?:^|\s)@[\w-]+/g, '').trim() || 'War Room';
      try {
        const room = await createMeeting({ createdBy: chatId, title, participants });
        await setWarroomMode(agentId, chatId, room.meetingId);
        return {
          reply:
            `War Room started: ${room.title}\n` +
            `Participants: ${participants.join(', ')}\n\n` +
            `Every message goes to the room and all of them weigh in. Tag one with @id (e.g. "@${participants[0] ?? 'ops'} ...") to ask just that agent. Type /endroom to leave.`,
        };
      } catch (err) {
        return { reply: `Failed to create war room: ${err instanceof Error ? err.message : String(err)}` };
      }
    }

    case 'endroom': {
      const session = await getSession(agentId, chatId);
      if (!session?.activeWarroomId) {
        return { reply: 'No active war room.' };
      }
      const room = await getMeeting(session.activeWarroomId);
      if (room?.status === 'active') await endMeeting(session.activeWarroomId);
      await setWarroomMode(agentId, chatId, null);
      return { reply: `Left war room${room ? `: ${room.title}` : ''}. Back to normal chat.` };
    }

    case 'dashboard': {
      const host = process.env.CCE_DASHBOARD_URL ?? process.env.CCE_TUNNEL_DOMAIN;
      if (host) {
        return { reply: `Dashboard: https://${host}/dashboard` };
      }
      return { reply: 'Dashboard is available at /dashboard on the ALB. Set CCE_DASHBOARD_URL or CCE_TUNNEL_DOMAIN to get a direct link.' };
    }

    case 'missions':
    case 'mission':
      // THE ONE PLACE THE BOARD SCOPE IS USED (see CommandScope above). Every
      // other case in this switch is session- or agent-record-scoped and stays
      // on `agentId`, because those records are the ones ordinary chat in this
      // same conversation reads.
      return missionCommand(scope.boardAgentId ?? agentId, chatId, cmd, rest);

    case 'agents':
      return {
        reply:
          `Available agents: ${known.join(', ')}.\n` +
          "Talk to one with '/agent <id> message' or '@<id> message'.",
      };

    case 'agent': {
      if (!rest) {
        return { reply: `Available agents: ${known.join(', ')}. Usage: /agent <id> [message]` };
      }
      const parts = rest.match(/^(\w+)(?:\s+(.*))?$/s);
      if (!parts || !known.includes(parts[1].toLowerCase())) {
        return { reply: `Unknown agent '${parts?.[1] ?? rest}'. Available: ${known.join(', ')}` };
      }
      const targetAgent = parts[1].toLowerCase();
      const remainder = (parts[2] ?? '').trim();
      if (!remainder) {
        return { reply: `Switched to ${targetAgent}. Send a message.` };
      }
      return {
        reply: '',
        forwardedAgentId: targetAgent,
        forwardedText: remainder,
      };
    }
  }

  // Unknown slash command. If the first segment matches an agent id,
  // treat it as an agent prefix (already handled by the picker too).
  if (known.includes(cmd)) {
    return {
      reply: '',
      forwardedAgentId: cmd,
      forwardedText: rest,
    };
  }
  return null; // let the agent see it; some users send /vibes etc as part of normal chat
}

/**
 * THE ONE PLACE MISSION COPY IS PRODUCED FOR A HUMAN — the A3-3 analogue of
 * `onToolEvent`'s single emission site. Every chat surface reaches this
 * function and only this function, and every sentence it can answer with —
 * board, card, usage, unknown status, no match, ambiguous ref, status changed,
 * outage — is a call into `src/lib/missions/format.ts`. **This function
 * contains no user-visible string literal of its own**, which is the property
 * `format.test.ts` scans `src/` to prove: a shared formatter whose refusals are
 * still hand-typed at the call site is the A3-4 defect one layer down, and the
 * refusals are the strings a user actually hits.
 */
async function missionCommand(
  agentId: string,
  chatId: string,
  cmd: string,
  rest: string,
): Promise<CommandResult> {
  try {
    if (cmd === 'missions') {
      const requested = rest.toLowerCase();
      const status = (requested || 'open') as MissionStatus | 'all';
      if (status !== 'all' && !MISSION_STATUSES.includes(status as MissionStatus)) {
        return { reply: formatUnknownStatus(rest) };
      }
      const rows =
        status === 'all'
          ? await listBoardMissions(agentId, MISSION_LIST_LIMIT)
          : await listBoardMissionsByStatus(agentId, status, MISSION_LIST_LIMIT);
      return { reply: formatMissionList(rows, { owner: agentId, status }) };
    }

    const [verb = '', ...tail] = rest.split(/\s+/);
    const arg = tail.join(' ').trim();

    if (verb === 'new') {
      if (!arg) return { reply: formatMissionUsage('new') };
      // No Haiku auto-assign here, deliberately: a slash command is the
      // deterministic path and the person typing it is talking to THIS agent.
      // `create_mission` remains the tool that can hand work to someone else.
      const mission = await createBoardMission({
        ownerAgent: agentId,
        createdByAgent: agentId,
        createdByChat: chatId,
        title: arg,
        body: arg,
        priority: 'medium',
        assignmentReason: 'opened from a chat command',
      });
      return { reply: formatMissionCard(mission) };
    }

    if (verb === 'done') {
      if (!arg) return { reply: formatMissionUsage('done') };
      // The raw ref goes to the ACL, which resolves it owner-scoped and throws
      // AmbiguousMissionPrefixError rather than transitioning the wrong row.
      // A MUTATION NEVER RESOLVES A PREFIX IN THIS FILE. That throw is caught
      // BELOW the outage catch, on purpose: an ambiguous prefix is a user error
      // and used to be answered "Mission board unavailable: …", which is an
      // outage sentence for a working board — different condition, different
      // words, and both words live in the shared module.
      const ok = await setBoardMissionStatus(agentId, arg, 'done');
      return {
        reply: ok
          ? formatStatusChanged({ ref: arg, status: 'done' })
          : formatNoMatch({ owner: agentId, ref: arg }),
      };
    }

    if (!verb) return { reply: formatMissionUsage() };

    // A READ RESOLVES THE REF THE SAME WAY A MUTATION DOES — same window, same
    // matcher, same refusal. It previously read `MISSION_LIST_LIMIT` (15) rows
    // and picked the nearest prefix match, so on a 40-row board `/mission
    // <ref>` answered "no mission matches" for a mission `/mission done <ref>`
    // transitioned in the same turn, and an ambiguous prefix rendered ONE card
    // while the ACL refused the identical input. Both halves of the rule now
    // come from the shared module.
    const rows = await listBoardMissions(agentId, MISSION_RESOLVE_WINDOW);
    const match = resolveMissionRef(rows, verb);
    if (match.kind === 'none') return { reply: formatNoMatch({ owner: agentId, ref: verb }) };
    if (match.kind === 'ambiguous') {
      return {
        reply: formatAmbiguousRef({
          owner: agentId,
          ref: verb,
          ids: match.matches.map((m) => m.id),
        }),
      };
    }
    return { reply: formatMissionCard(match.mission) };
  } catch (err) {
    // AN AMBIGUOUS PREFIX IS NOT AN OUTAGE. The ACL raises this from the
    // mutation path; answering it with the board-unavailable sentence told the
    // user their board was down when it was working and their ref was short.
    // Same words as the read path, from the same function.
    if (err instanceof AmbiguousMissionPrefixError) {
      return {
        reply: formatAmbiguousRef({ owner: err.owner, ref: err.prefix, ids: err.matches }),
      };
    }
    // THE SWALLOWING CATCH, and the reason it is not empty. Every one of
    // runCommand's chat call sites `await`s it unguarded, so a throw here 500s
    // the Telegram webhook (which then retries the same message for ~60s) and
    // both Slack event routes. The board is REMOTE now — Paperclip down, the
    // paperclip_disabled kill switch — so unlike /status it really can throw. A
    // surface bug must not kill the turn; an empty body here would post a blank
    // message instead, and the dashboard's Missions tab already settled that
    // argument by drawing an ErrorState ("this is an error, not an empty
    // board"). The sentence itself is `formatBoardError` in the shared module.
    return { reply: formatBoardError(err) };
  }
}

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
