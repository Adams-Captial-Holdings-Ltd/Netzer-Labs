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

export interface CommandResult {
  reply: string;
  /** If the command rerouted the message to an agent, the cleaned text. */
  forwardedText?: string;
  /** Agent the message should be forwarded to (e.g., after /agent ops hi). */
  forwardedAgentId?: string;
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
  '/dashboard — get the dashboard URL',
  '/status — show env, model, history length',
  '/help — show this list',
].join('\n');

export async function runCommand(
  agentId: string,
  chatId: string,
  text: string,
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
      // (one source of truth). The agent here is the one the message routed to
      // (a per-agent bot's own agent, or the picker's choice on the main bot).
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

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
