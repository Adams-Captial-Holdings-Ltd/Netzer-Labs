/**
 * Multi-agent tools — send_dm (queue a task to another agent),
 * read_inbox (drain my own queue), log_to_hive + search_hive
 * (cross-agent shared notes).
 *
 * Sending is deliberately fire-and-forget: the recipient picks up its
 * inbox on its next turn (or via /api/inter-agent/drain). Keeping it
 * asynchronous avoids an N+1 model invocation cascade when ops asks
 * research to do something at the end of a long turn.
 */

import type { Tool as BedrockTool } from '@aws-sdk/client-bedrock-runtime';
import { tools } from './registry.js';
import {
  listInbox,
  markStatus,
  sendInterAgent,
} from '../state/inter-agent-tasks-repo.js';
import {
  logToHive,
  recentHive,
  searchHiveByTopic,
  searchHiveText,
} from '../state/hive-mind-repo.js';
import { listKnownAgents } from '../config/agent-loader.js';
import { getConfig } from '../state/runtime-config-repo.js';
import { writeAudit } from '../audit/audit-writer.js';
import { logger } from '../../observability/logger.js';

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

// ── ask_agent: synchronous delegation ───────────────────────────────────────
// Unlike send_dm (fire-and-forget inbox), ask_agent runs a one-shot turn for
// the target agent INSIDE this turn and returns its answer — "ask @research
// to dig into this" from any chat surface. Guards (each unit-tested):
//   1. delegation/enabled runtime flag (default on; 30s-propagation kill)
//   2. hard recursion cap: depth 1 (the nested turn's ask_agent refuses)
//   3. no self-ask; target must exist and pass delegation/allowed_agents
//   4. input <= 2000 chars; reply truncated to delegation/max_reply_chars
// The nested turn re-runs cost-cap / guardrail / rate limits for free, and
// its usage is attributed to the TARGET agent under a delegation: chatId.
tools.register('ask_agent', {
  spec: spec(
    'ask_agent',
    'Ask another agent a question and wait for its answer in this turn. Use when the user wants another agent\'s expertise NOW ("ask research to dig into this"). For fire-and-forget handoffs or FYIs use send_dm instead.',
    {
      type: 'object',
      required: ['to_agent', 'question'],
      properties: {
        to_agent: {
          type: 'string',
          description: 'The agent id to ask (e.g. "research", "ops").',
        },
        question: {
          type: 'string',
          description:
            'The question or subtask. Be self-contained — the target agent cannot see this conversation.',
        },
        context: {
          type: 'string',
          description: 'Optional background the target agent needs (it has no access to this chat).',
        },
      },
    },
  ),
  async invoke(args, ctx) {
    const enabled = (await getConfig('delegation', 'enabled')) ?? '1';
    if (enabled === '0') {
      return { text: 'Agent delegation is switched off (delegation/enabled).', isError: true };
    }
    if ((ctx.delegationDepth ?? 0) >= 1) {
      return {
        text: 'Delegation depth limit reached — answer with what you have instead of asking further agents.',
        isError: true,
      };
    }
    const toAgent = String(args.to_agent ?? '').trim();
    const question = String(args.question ?? '').trim();
    const context = String(args.context ?? '').trim();
    if (!toAgent || !question) {
      return { text: 'to_agent and question are required', isError: true };
    }
    if (toAgent === ctx.agentId) {
      return { text: 'You cannot ask yourself — answer directly.', isError: true };
    }
    if (!listKnownAgents().includes(toAgent)) {
      return {
        text: `Unknown agent "${toAgent}". Known agents: ${listKnownAgents().join(', ')}`,
        isError: true,
      };
    }
    const allowed = (await getConfig('delegation', 'allowed_agents')) ?? '*';
    if (allowed !== '*') {
      const list = allowed.split(',').map((s) => s.trim()).filter(Boolean);
      if (!list.includes(toAgent)) {
        return { text: `Delegation to "${toAgent}" is not allowed (delegation/allowed_agents).`, isError: true };
      }
    }
    if (question.length + context.length > 2000) {
      return { text: 'question + context must be under 2000 characters', isError: true };
    }
    // Dynamic import keeps module init order independent of the agent loop.
    const { runAgentTurn } = await import('../../agent/agent-loop.js');
    const t0 = Date.now();
    try {
      const result = await runAgentTurn({
        agentId: toAgent,
        // Isolated namespace: keeps the nested turn out of any user session
        // and makes its cost/audit rows trivially attributable.
        chatId: `delegation:${ctx.agentId}:${ctx.chatId}`.slice(0, 100),
        userText: context
          ? `${question}\n\nContext from ${ctx.agentId}: ${context}`
          : question,
        history: [], // stateless one-shot; nothing is persisted afterwards
        surface: 'system',
        delegationDepth: (ctx.delegationDepth ?? 0) + 1,
      });
      const maxChars = Math.max(200, Number((await getConfig('delegation', 'max_reply_chars')) ?? 2400));
      const reply = result.text.length > maxChars
        ? `${result.text.slice(0, maxChars)}…`
        : result.text;
      void writeAudit({
        action: 'agent_delegation',
        agentId: ctx.agentId,
        chatId: ctx.chatId,
        toolName: 'ask_agent',
        detail: {
          toAgent,
          costUsd: result.costUsd,
          latencyMs: Date.now() - t0,
          blocked: result.blocked ?? false,
        },
        result: result.blocked ? 'blocked' : 'ok',
      });
      if (result.blocked) {
        return { text: `${toAgent} could not answer (response was blocked).`, isError: true };
      }
      return { text: `${toAgent} answered:\n${reply}` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ toAgent, errMessage: msg }, 'ask_agent delegation failed');
      return { text: `Asking ${toAgent} failed: ${msg}`, isError: true };
    }
  },
});

tools.register('send_dm', {
  spec: spec(
    'send_dm',
    'Queue a message for another agent in this deployment. Use when you need to delegate work ("research, dig into X") or just brief another agent ("ops, fyi, the user is on vacation next week"). The recipient picks up the message the next time it runs.',
    {
      type: 'object',
      required: ['to_agent', 'message'],
      properties: {
        to_agent: {
          type: 'string',
          description: 'The agent id (e.g. "ops", "research"). Use list_agents to discover.',
        },
        message: {
          type: 'string',
          description: 'The message body. Be specific — the recipient has no access to our conversation.',
        },
        intent: {
          type: 'string',
          enum: ['fyi', 'request'],
          description: '"fyi" if no reply expected, "request" if you want the recipient to act and report back. Defaults to "fyi".',
        },
      },
    },
  ),
  async invoke(args, ctx) {
    const toAgent = String(args.to_agent ?? '').trim();
    if (!toAgent) return { text: 'to_agent is required', isError: true };
    if (toAgent === ctx.agentId) {
      return {
        text: `You cannot DM yourself (${toAgent}). Use add_memory if you want to save a note for later.`,
        isError: true,
      };
    }
    const known = listKnownAgents();
    if (!known.includes(toAgent)) {
      return {
        text: `Unknown agent '${toAgent}'. Known: ${known.join(', ')}.`,
        isError: true,
      };
    }
    const message = String(args.message ?? '').trim();
    if (!message) return { text: 'message is required', isError: true };
    const intent =
      args.intent === 'request' ? 'request' : ('fyi' as const);
    const task = await sendInterAgent({
      fromAgent: ctx.agentId,
      fromChat: ctx.chatId,
      toAgent,
      toChat: ctx.chatId,
      messageText: message,
      intent,
    });
    return {
      text: `Queued ${intent} for ${toAgent} (task ${task.id.slice(0, 8)}).`,
    };
  },
});

tools.register('read_inbox', {
  spec: spec(
    'read_inbox',
    'Read messages other agents have sent to you. Returns up to N un-completed inbox items. Use at the start of a long turn when the user asks "any messages from ops?" or "what does research want me to do".',
    {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 25,
          description: 'Max items to return. Defaults to 10.',
        },
        mark_delivered: {
          type: 'boolean',
          description: 'If true (default), each returned item is marked delivered so it won\'t reappear unless you explicitly re-list.',
        },
      },
    },
  ),
  async invoke(args, ctx) {
    const limit = Number.isFinite(args.limit) ? Number(args.limit) : 10;
    const markDelivered = args.mark_delivered !== false;
    const rows = await listInbox(ctx.agentId, limit, ['queued', 'delivered']);
    if (rows.length === 0) return { text: 'Inbox is empty.' };
    if (markDelivered) {
      await Promise.all(
        rows
          .filter((r) => r.status === 'queued')
          .map((r) => markStatus(r, 'delivered')),
      );
    }
    const lines = rows.map(
      (r) =>
        `- [${r.id.slice(0, 8)}] from ${r.fromAgent} (${r.intent}, ${r.status}): ${r.messageText.slice(0, 200)}`,
    );
    return { text: `${rows.length} inbox items:\n${lines.join('\n')}` };
  },
});

tools.register('log_to_hive', {
  spec: spec(
    'log_to_hive',
    'Save a note to the Hive Mind — a cross-agent, cross-chat shared scratchpad. Use for facts ANY agent on ANY chat should know later (e.g. "Emmanuel prefers Sonnet 4.6 for code review", "the product launch is on 2026-06-01"). For per-chat preferences use add_memory instead.',
    {
      type: 'object',
      required: ['content'],
      properties: {
        content: {
          type: 'string',
          description: 'The note text.',
        },
        topic: {
          type: 'string',
          description: 'Optional short topic so search_hive can find related notes. Examples: "product", "users.emmanuel", "ops.outages".',
        },
        importance: {
          type: 'integer',
          minimum: 0,
          maximum: 100,
          description: 'Importance 0-100, default 50.',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional tags for filtering.',
        },
      },
    },
  ),
  async invoke(args, ctx) {
    const content = String(args.content ?? '').trim();
    if (!content) return { text: 'content is required', isError: true };
    const topic = typeof args.topic === 'string' ? args.topic.trim() : undefined;
    const importance = Number.isFinite(args.importance)
      ? Number(args.importance)
      : 50;
    const tags = Array.isArray(args.tags) ? (args.tags as string[]) : [];
    const note = await logToHive({
      authorAgentId: ctx.agentId,
      authorChatId: ctx.chatId,
      content,
      ...(topic ? { topic } : {}),
      importance,
      tags,
    });
    return {
      text: `Logged hive note ${note.id.slice(0, 8)}${topic ? ` under topic '${topic}'` : ''}.`,
    };
  },
});

tools.register('search_hive', {
  readOnly: true,
  spec: spec(
    'search_hive',
    'Search the Hive Mind for relevant cross-agent notes. Pass a topic for an exact-match index lookup, or a free-text query for a slower substring scan, or neither for the most recent notes.',
    {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          description: 'Exact topic to look up.',
        },
        query: {
          type: 'string',
          description: 'Free-text search (case-insensitive substring).',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 25,
          description: 'Max notes to return. Defaults to 10.',
        },
      },
    },
  ),
  async invoke(args) {
    const limit = Number.isFinite(args.limit) ? Number(args.limit) : 10;
    let notes;
    if (typeof args.topic === 'string' && args.topic.trim()) {
      notes = await searchHiveByTopic(args.topic.trim(), limit);
    } else if (typeof args.query === 'string' && args.query.trim()) {
      notes = await searchHiveText(args.query.trim(), limit);
    } else {
      notes = await recentHive(limit);
    }
    if (notes.length === 0) return { text: 'No hive notes match.' };
    const lines = notes.map(
      (n) =>
        `- [${n.id.slice(0, 8)}] (${n.authorAgentId}, imp ${n.importance}${n.topic ? `, ${n.topic}` : ''}) ${n.content}`,
    );
    return { text: `${notes.length} hive notes:\n${lines.join('\n')}` };
  },
});
