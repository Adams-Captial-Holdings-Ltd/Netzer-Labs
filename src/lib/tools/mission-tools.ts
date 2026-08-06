/**
 * Mission tasks tools.
 *
 * create_mission spawns a tracked work unit and asks Haiku 4.5 to pick
 * the right owner agent. Haiku reads the title + body + the known
 * agents' system-prompt previews and returns a single agent id plus a
 * one-sentence rationale.
 *
 * The model creating the mission may also pass `owner` explicitly to
 * skip the Haiku step (faster, cheaper).
 *
 * Once assigned, the recipient gets a notification in their inter-agent
 * inbox so they see it on the next turn.
 */

import type { Tool as BedrockTool } from '@aws-sdk/client-bedrock-runtime';
import { tools } from './registry.js';
import {
  createMission,
  listMissionsByStatus,
  listMissionsForAgent,
  updateMissionStatus,
  type MissionStatus,
} from '../state/mission-tasks-repo.js';
import { sendInterAgent } from '../state/inter-agent-tasks-repo.js';
import { listKnownAgents, loadAgent } from '../config/agent-loader.js';
import { converseTurn } from '../bedrock/client.js';
import { logger } from '../../observability/logger.js';

const HAIKU =
  process.env.BEDROCK_HAIKU_MODEL ?? 'us.anthropic.claude-haiku-4-5-20251001-v1:0';

const ASSIGN_SYSTEM = `You assign work to one of several AI agents in a multi-agent deployment. Read the mission title and body, plus each agent's one-line role, and pick the single best owner. Reply in this exact format:
AGENT: <agent id>
REASON: <one-sentence rationale, <= 25 words>
Do not include anything else.`;

function spec(name: string, description: string, schema: unknown): BedrockTool {
  return {
    toolSpec: {
      name,
      description,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      inputSchema: { json: schema as any },
    },
  };
}

interface AssignResult {
  owner: string;
  reason: string;
}

export async function autoAssign(
  title: string,
  body: string,
): Promise<AssignResult> {
  const ids = listKnownAgents();
  if (ids.length === 0) {
    throw new Error('no agents configured to assign to');
  }
  if (ids.length === 1) {
    return { owner: ids[0], reason: 'only agent available' };
  }
  const briefs = await Promise.all(
    ids.map(async (id) => {
      const a = await loadAgent(id);
      const oneLine = a.systemPrompt
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 240);
      return `- ${id} (${a.displayName ?? id}): ${oneLine}`;
    }),
  );
  const out = await converseTurn({
    modelId: HAIKU,
    systemPrompt: ASSIGN_SYSTEM,
    userText: `Available agents:\n${briefs.join('\n')}\n\nMission title: ${title}\n\nMission body:\n${body}`,
    maxTokens: 120,
    temperature: 0,
  });
  return parseAssignResponse(out.text, ids);
}

export function parseAssignResponse(
  raw: string,
  validAgents: string[],
): AssignResult {
  const lines = raw.split(/\r?\n/).map((l) => l.trim());
  let owner = '';
  let reason = '';
  for (const line of lines) {
    const a = /^AGENT:\s*(.+)$/i.exec(line);
    if (a) owner = a[1].trim().replace(/^[`'"]+|[`'"]+$/g, '');
    const r = /^REASON:\s*(.+)$/i.exec(line);
    if (r) reason = r[1].trim();
  }
  if (!owner || !validAgents.includes(owner)) {
    // Fall back: lowercase match, then first agent.
    const lower = owner.toLowerCase();
    const match = validAgents.find((a) => a.toLowerCase() === lower);
    owner = match ?? validAgents[0];
    if (!reason) reason = `auto-fallback (Haiku output unclear: ${raw.slice(0, 80)})`;
  }
  return { owner, reason: reason || 'no rationale given' };
}

tools.register('create_mission', {
  spec: spec(
    'create_mission',
    'Create a tracked mission task. If `owner` is omitted, Haiku 4.5 picks the best agent based on the title and body. Use this when the user asks you to "open a ticket", "track this work", "follow up on X next week", or any persistent multi-step item that should outlive this conversation.',
    {
      type: 'object',
      required: ['title', 'body'],
      properties: {
        title: { type: 'string', description: 'Short headline (under 80 chars).' },
        body: { type: 'string', description: 'Full task description with acceptance criteria.' },
        owner: {
          type: 'string',
          description: 'Optional explicit owner agent id. Skip to let Haiku auto-assign.',
        },
        priority: {
          type: 'integer',
          minimum: 0,
          maximum: 100,
          description: '0-100, default 50.',
        },
        due_at: {
          type: 'string',
          description: 'Optional ISO 8601 deadline.',
        },
      },
    },
  ),
  async invoke(args, ctx) {
    const title = String(args.title ?? '').trim();
    const body = String(args.body ?? '').trim();
    if (!title) return { text: 'title is required', isError: true };
    if (!body) return { text: 'body is required', isError: true };
    const priority = Number.isFinite(args.priority) ? Number(args.priority) : 50;
    const due = typeof args.due_at === 'string' && args.due_at ? args.due_at : undefined;

    let owner: string;
    let reason: string;
    if (typeof args.owner === 'string' && args.owner) {
      owner = args.owner;
      reason = 'explicit assignment';
      const known = listKnownAgents();
      if (!known.includes(owner)) {
        return {
          text: `Unknown owner '${owner}'. Known: ${known.join(', ')}.`,
          isError: true,
        };
      }
    } else {
      try {
        const assign = await autoAssign(title, body);
        owner = assign.owner;
        reason = assign.reason;
      } catch (err) {
        logger.warn(
          { errMessage: err instanceof Error ? err.message : String(err) },
          'auto-assign failed; defaulting to creator',
        );
        owner = ctx.agentId;
        reason = 'auto-assign failed; defaulted to creating agent';
      }
    }

    const mission = await createMission({
      ownerAgent: owner,
      createdByAgent: ctx.agentId,
      createdByChat: ctx.chatId,
      title,
      body,
      priority,
      assignmentReason: reason,
      ...(due ? { dueAt: due } : {}),
    });

    // Drop a note in the owner's inbox if it's not the creating agent.
    if (owner !== ctx.agentId) {
      await sendInterAgent({
        fromAgent: ctx.agentId,
        fromChat: ctx.chatId,
        toAgent: owner,
        messageText: `New mission [${mission.id.slice(0, 8)}] "${title}" (priority ${priority}). ${reason}`,
        intent: 'request',
      }).catch((err) => {
        logger.warn(
          { errMessage: err instanceof Error ? err.message : String(err) },
          'mission inbox notification failed',
        );
      });
    }
    return {
      text: `Mission ${mission.id.slice(0, 8)} created. Owner: ${owner} (${reason}). Priority ${priority}.`,
    };
  },
});

tools.register('list_missions', {
  spec: spec(
    'list_missions',
    'List your own missions. Defaults to your open missions.',
    {
      type: 'object',
      properties: {
        owner: {
          type: 'string',
          description: 'Owner agent id; must be your own agent id (the default).',
        },
        status: {
          type: 'string',
          enum: ['open', 'in_progress', 'done', 'cancelled', 'all'],
          description: 'Filter; defaults to "open".',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 50,
          description: 'Max rows; defaults to 15.',
        },
      },
    },
  ),
  async invoke(args, ctx) {
    const owner = typeof args.owner === 'string' && args.owner ? args.owner : ctx.agentId;
    // Missions are per-agent state: another agent's queue may carry context
    // this agent (or whoever is steering it) was never meant to see.
    if (owner !== ctx.agentId) {
      return {
        text: `You can only list your own missions (owner '${ctx.agentId}').`,
        isError: true,
      };
    }
    const status =
      typeof args.status === 'string' && args.status
        ? (args.status as MissionStatus | 'all')
        : 'open';
    const limit = Number.isFinite(args.limit) ? Number(args.limit) : 15;

    const rows =
      status === 'all'
        ? await listMissionsForAgent(owner, limit)
        : await listMissionsByStatus(owner, status as MissionStatus, limit);
    if (rows.length === 0) {
      return { text: `No ${status} missions for ${owner}.` };
    }
    const lines = rows.map(
      (m) =>
        `- [${m.id.slice(0, 8)}] p${m.priority} ${m.status} | ${m.title}${m.dueAt ? ` (due ${m.dueAt})` : ''}`,
    );
    return { text: `${rows.length} missions for ${owner}:\n${lines.join('\n')}` };
  },
});

tools.register('update_mission', {
  spec: spec(
    'update_mission',
    'Transition a mission to a new status. Use to mark a mission in_progress, done, or cancelled.',
    {
      type: 'object',
      required: ['mission_id', 'status'],
      properties: {
        mission_id: {
          type: 'string',
          description: 'Full id or 8-char prefix from list_missions.',
        },
        owner: {
          type: 'string',
          description: 'Owner agent id; must be your own agent id (the default).',
        },
        status: {
          type: 'string',
          enum: ['open', 'in_progress', 'done', 'cancelled'],
          description: 'New status.',
        },
      },
    },
  ),
  async invoke(args, ctx) {
    const id = String(args.mission_id ?? '').trim();
    if (!id) return { text: 'mission_id is required', isError: true };
    const owner = typeof args.owner === 'string' && args.owner ? args.owner : ctx.agentId;
    // Only the owning agent may transition a mission. Without this, any agent
    // that learns an id prefix could cancel another agent's work.
    if (owner !== ctx.agentId) {
      return {
        text: `You can only update your own missions (owner '${ctx.agentId}').`,
        isError: true,
      };
    }
    const status = String(args.status ?? '') as MissionStatus;
    const ok = await updateMissionStatus(owner, id, status);
    return ok
      ? { text: `Mission ${id} updated to ${status}.` }
      : { text: `No mission matches ${id} for ${owner}.`, isError: true };
  },
});
