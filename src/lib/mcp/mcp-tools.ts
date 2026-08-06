/**
 * Bridge between configured MCP servers and the Bedrock tool pipeline.
 *
 * mcpToolsFor(agentId) merges every reachable server's tools/list into
 * Bedrock toolSpec entries, namespaced "mcp__<serverId>__<tool>" so they can
 * never shadow built-in tools. The agent loop routes any tool_use whose name
 * carries that prefix to invokeMcpTool(). Tool lists are cached for 5 minutes
 * per server and fail soft: an unreachable gateway costs the agent its tools
 * for one cache window, never the turn.
 */

import type { Tool as BedrockTool } from '@aws-sdk/client-bedrock-runtime';
import { emitToolMetric } from '../../observability/emf.js';
import { logger } from '../../observability/logger.js';
import { mcpListTools, mcpCallTool } from './client.js';
import { mcpServersForAgent, listMcpServers } from './servers-repo.js';
import type { McpServerConfig, McpToolInfo } from './types.js';
import type { ToolContext, ToolResult } from '../tools/registry.js';

export const MCP_TOOL_PREFIX = 'mcp__';
const TOOLS_CACHE_TTL_MS = 5 * 60 * 1000;
/** Hard cap on tool-result text fed back into the model. */
const RESULT_CHAR_LIMIT = 16_000;
/** Bedrock toolSpec name limit. */
const NAME_LIMIT = 64;

interface CacheEntry {
  tools: McpToolInfo[];
  expiresAt: number;
}

const toolsCache = new Map<string, CacheEntry>();
// namespaced bedrock name -> {server config snapshot, original tool name}
const nameMap = new Map<string, { server: McpServerConfig; tool: string }>();

function sanitizeName(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function namespacedName(serverId: string, tool: string): string {
  const base = `${MCP_TOOL_PREFIX}${sanitizeName(serverId)}__${sanitizeName(tool)}`;
  return base.slice(0, NAME_LIMIT);
}

async function toolsForServer(server: McpServerConfig): Promise<McpToolInfo[]> {
  const cached = toolsCache.get(server.id);
  if (cached && cached.expiresAt > Date.now()) return cached.tools;
  try {
    const tools = await mcpListTools(server);
    toolsCache.set(server.id, { tools, expiresAt: Date.now() + TOOLS_CACHE_TTL_MS });
    return tools;
  } catch (err) {
    logger.warn(
      { serverId: server.id, url: server.url, err: err instanceof Error ? err.message : String(err) },
      'mcp tools/list failed — server contributes no tools this cache window',
    );
    // Negative-cache for one window so a dead gateway doesn't add latency to
    // every turn.
    toolsCache.set(server.id, { tools: [], expiresAt: Date.now() + TOOLS_CACHE_TTL_MS });
    return [];
  }
}

/** Bedrock toolSpec entries for every MCP tool this agent can use. */
export async function mcpToolsFor(agentId: string): Promise<BedrockTool[]> {
  const servers = await mcpServersForAgent(agentId);
  if (servers.length === 0) return [];
  const out: BedrockTool[] = [];
  const lists = await Promise.all(servers.map((s) => toolsForServer(s)));
  servers.forEach((server, i) => {
    for (const tool of lists[i] ?? []) {
      const name = namespacedName(server.id, tool.name);
      nameMap.set(name, { server, tool: tool.name });
      out.push({
        toolSpec: {
          name,
          description: tool.description ?? `${tool.name} (via ${server.name})`,
          inputSchema: {
            json: (tool.inputSchema ?? { type: 'object', properties: {} }) as never,
          },
        },
      });
    }
  });
  return out;
}

export function isMcpToolName(name: string): boolean {
  return name.startsWith(MCP_TOOL_PREFIX);
}

/** Dispatch one MCP tool call. Mirrors ToolRegistry.invoke's error contract. */
export async function invokeMcpTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const mapped = nameMap.get(name);
  const startedAt = Date.now();
  if (!mapped) {
    emitToolMetric({ toolName: name, agentId: ctx.agentId, latencyMs: 0, isError: true });
    return { text: `Unknown MCP tool: ${name}`, isError: true };
  }
  // nameMap is module-global — once ANY agent lists a server's tools, the
  // mapping is visible to every agent's dispatch. Re-check at invoke that the
  // resolved server is actually one THIS agent is allowed to reach, so
  // per-agent MCP scoping is a control on execution, not just on listing.
  const allowed = await mcpServersForAgent(ctx.agentId);
  if (!allowed.some((s) => s.id === mapped.server.id)) {
    emitToolMetric({ toolName: name, agentId: ctx.agentId, latencyMs: 0, isError: true });
    return { text: `MCP tool '${name}' is not authorized for this agent.`, isError: true };
  }
  try {
    const result = await mcpCallTool(mapped.server, mapped.tool, args);
    const text =
      result.text.length > RESULT_CHAR_LIMIT
        ? `${result.text.slice(0, RESULT_CHAR_LIMIT)}\n[truncated ${result.text.length - RESULT_CHAR_LIMIT} chars]`
        : result.text;
    emitToolMetric({
      toolName: name,
      agentId: ctx.agentId,
      latencyMs: Date.now() - startedAt,
      isError: result.isError,
    });
    return { text, ...(result.isError ? { isError: true } : {}) };
  } catch (err) {
    emitToolMetric({
      toolName: name,
      agentId: ctx.agentId,
      latencyMs: Date.now() - startedAt,
      isError: true,
    });
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(
      { serverId: mapped.server.id, tool: mapped.tool, agentId: ctx.agentId, err: msg },
      'mcp tool call failed',
    );
    return { text: `Tool '${name}' failed: ${msg}`, isError: true };
  }
}

/** Live tool listing for the dashboard "test" button (no cache, surfaces errors). */
export async function probeMcpServer(
  serverId: string,
): Promise<{ ok: boolean; tools: McpToolInfo[]; error?: string }> {
  const server = (await listMcpServers()).find((s) => s.id === serverId);
  if (!server) return { ok: false, tools: [], error: `unknown MCP server: ${serverId}` };
  try {
    const tools = await mcpListTools(server);
    // Refresh the dispatch cache too so a successful probe arms the agents
    // immediately instead of waiting out a stale negative cache.
    toolsCache.set(server.id, { tools, expiresAt: Date.now() + TOOLS_CACHE_TTL_MS });
    return { ok: true, tools };
  } catch (err) {
    return { ok: false, tools: [], error: err instanceof Error ? err.message : String(err) };
  }
}

/** Test hook. */
export function resetMcpToolsState(): void {
  toolsCache.clear();
  nameMap.clear();
}
