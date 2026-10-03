/**
 * Memory tools — give the model durable per-chat recall.
 *
 * The model decides when to call add_memory based on the system prompt
 * guidance. Default importance scale: 0-100, 50 = neutral. Use higher
 * for facts the user is likely to want preserved (preferences, names,
 * goals); lower for transient context.
 *
 * forget_memory is intentionally exposed so the user can say "forget X"
 * and the model can find the right row and delete it.
 */

import type { Tool as BedrockTool } from '@aws-sdk/client-bedrock-runtime';
import { tools } from './registry.js';
import {
  addMemory,
  listMemoriesForChat,
  forgetMemory,
  topMemoriesByImportance,
} from '../state/memories-repo.js';
import { listConsolidations } from '../state/consolidations-repo.js';
import { isKillSwitchActive } from '../state/kill-switches-repo.js';
import { writeAudit } from '../audit/audit-writer.js';

function spec(name: string, description: string, schema: unknown): BedrockTool {
  return {
    toolSpec: {
      name,
      description,
      // Bedrock's typed surface expects DocumentType. The actual wire
      // format is a JSON schema object; cast to any to keep the spec
      // readable.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      inputSchema: { json: schema as any },
    },
  };
}

tools.register('add_memory', {
  spec: spec(
    'add_memory',
    'Save a fact to long-term memory for this conversation. ' +
      'Use this when the user shares a preference, a name, a goal, or any ' +
      'fact they likely want you to remember across future turns.',
    {
      type: 'object',
      required: ['content'],
      properties: {
        content: { type: 'string', description: 'The fact to remember.' },
        importance: {
          type: 'integer',
          minimum: 0,
          maximum: 100,
          description: 'How important is this fact? Default 50.',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional tags for grouping (preference, fact, etc.).',
        },
      },
    },
  ),
  async invoke(args, ctx) {
    const killed = await isKillSwitchActive('memory_writes');
    if (killed.active) {
      return {
        text: `Memory writes are disabled: ${killed.reason ?? 'no reason given'}`,
        isError: true,
      };
    }
    const content = String(args.content ?? '').trim();
    if (!content) return { text: 'content is required', isError: true };
    const importance = Number.isFinite(args.importance)
      ? Number(args.importance)
      : 50;
    const tags = Array.isArray(args.tags) ? (args.tags as string[]) : [];
    const mem = await addMemory({
      agentId: ctx.agentId,
      chatId: ctx.chatId,
      content,
      importance,
      tags,
      source: 'agent',
      ...(ctx.userId ? { userId: ctx.userId } : {}),
    });
    void writeAudit({
      action: 'memory_add',
      agentId: ctx.agentId,
      chatId: ctx.chatId,
      ...(ctx.userId ? { userId: ctx.userId } : {}),
      detail: { id: mem.id, importance, tags },
      result: 'ok',
    });
    return { text: `Saved memory ${mem.id}: ${content.slice(0, 120)}` };
  },
});

tools.register('list_memories', {
  readOnly: true,
  spec: spec(
    'list_memories',
    'Recall facts you previously saved for this conversation.',
    {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 50,
          description: 'Maximum memories to return. Default 10.',
        },
      },
    },
  ),
  async invoke(args, ctx) {
    const limit = Number.isFinite(args.limit) ? Number(args.limit) : 10;
    const rows = await listMemoriesForChat(ctx.agentId, ctx.chatId, limit);
    if (rows.length === 0) return { text: 'No memories yet for this chat.' };
    const lines = rows.map(
      (m) => `- [${m.id.slice(0, 8)}] (imp ${m.importance}) ${m.content}`,
    );
    return { text: `${rows.length} memories:\n${lines.join('\n')}` };
  },
});

tools.register('forget_memory', {
  spec: spec(
    'forget_memory',
    'Delete a previously saved memory. Use after the user asks to forget something.',
    {
      type: 'object',
      required: ['memory_id'],
      properties: {
        memory_id: {
          type: 'string',
          description: 'The id of the memory to forget (from list_memories).',
        },
      },
    },
  ),
  async invoke(args, ctx) {
    const killed = await isKillSwitchActive('memory_writes');
    if (killed.active) {
      return {
        text: `Memory writes are disabled: ${killed.reason ?? 'no reason given'}`,
        isError: true,
      };
    }
    const id = String(args.memory_id ?? '').trim();
    if (!id) return { text: 'memory_id is required', isError: true };
    // Allow either full id or 8-char prefix
    const all = await listMemoriesForChat(ctx.agentId, ctx.chatId, 100);
    const target = all.find((m) => m.id === id || m.id.startsWith(id));
    if (!target) return { text: `No memory with id ${id}.`, isError: true };
    await forgetMemory(ctx.agentId, ctx.chatId, target.id);
    void writeAudit({
      action: 'memory_forget',
      agentId: ctx.agentId,
      chatId: ctx.chatId,
      detail: { id: target.id },
      result: 'ok',
    });
    return { text: `Forgot memory ${target.id}.` };
  },
});

tools.register('search_memories', {
  readOnly: true,
  spec: spec(
    'search_memories',
    'Search your memories by keyword or concept. Returns the most relevant ' +
      'memories and any consolidation insights. Use when you need to recall ' +
      'something specific from past conversations.',
    {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string', description: 'What to search for.' },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 20,
          description: 'Maximum results. Default 5.',
        },
      },
    },
  ),
  async invoke(args, ctx) {
    const query = String(args.query ?? '').trim().toLowerCase();
    if (!query) return { text: 'query is required', isError: true };
    const limit = Number.isFinite(args.limit) ? Number(args.limit) : 5;

    const [memories, consolidations] = await Promise.all([
      topMemoriesByImportance(ctx.agentId, ctx.chatId, 50).catch(() => []),
      listConsolidations(ctx.agentId, ctx.chatId, 10).catch(() => []),
    ]);

    const scored = memories
      .map((m) => ({
        m,
        score: (m.content.toLowerCase().includes(query) ? 2 : 0)
          + (m.tags.some((t) => t.toLowerCase().includes(query)) ? 1 : 0),
      }))
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score || b.m.importance - a.m.importance)
      .slice(0, limit);

    const consolidationHits = consolidations
      .filter((c) => c.summary.toLowerCase().includes(query))
      .slice(0, 3);

    const lines: string[] = [];
    if (scored.length > 0) {
      lines.push(`${scored.length} matching memories:`);
      for (const s of scored) {
        lines.push(`- [${s.m.id.slice(0, 8)}] (imp ${s.m.importance}) ${s.m.content}`);
      }
    }
    if (consolidationHits.length > 0) {
      lines.push(`\n${consolidationHits.length} consolidation insights:`);
      for (const c of consolidationHits) {
        lines.push(`- ${c.summary.slice(0, 200)}`);
      }
    }
    if (lines.length === 0) {
      return { text: `No memories matching "${query}".` };
    }
    return { text: lines.join('\n') };
  },
});
