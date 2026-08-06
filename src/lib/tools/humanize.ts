/**
 * Turn raw tool names into display copy for live status messages.
 *
 *   web_search                                  -> "Searching the web"? No —
 *   we don't hand-map every tool; the generic rule just de-mangles:
 *   web_search                                  -> "web search"
 *   mcp__slack__slack_search_public             -> "Slack: search public"
 *   mcp__aws-gateway__demo-tools___get_weather  -> "aws gateway: get weather"
 */

import { MCP_TOOL_PREFIX } from '../mcp/mcp-tools.js';

/** Hand-mapped names where the de-mangled form reads poorly in live status. */
const SPECIAL: Record<string, string> = {
  ask_agent: 'Asking another agent',
};

export function humanizeToolName(raw: string): string {
  if (!raw) return 'a tool';
  if (SPECIAL[raw]) return SPECIAL[raw];
  if (raw.startsWith(MCP_TOOL_PREFIX)) {
    const rest = raw.slice(MCP_TOOL_PREFIX.length);
    const sep = rest.indexOf('__');
    if (sep > 0) {
      const server = rest.slice(0, sep).replace(/[_-]+/g, ' ').trim();
      // AgentCore gateways embed the target name as "<target>___<tool>";
      // vendors often re-prefix their own name ("slack_search_public").
      let tool = rest.slice(sep + 2);
      const targetSep = tool.lastIndexOf('___');
      if (targetSep >= 0) tool = tool.slice(targetSep + 3);
      const serverFirstWord = server.split(' ')[0] ?? '';
      if (serverFirstWord && tool.toLowerCase().startsWith(`${serverFirstWord.toLowerCase()}_`)) {
        tool = tool.slice(serverFirstWord.length + 1);
      }
      const serverLabel = server.charAt(0).toUpperCase() + server.slice(1);
      return `${serverLabel}: ${tool.replace(/[_-]+/g, ' ').trim()}`;
    }
  }
  return raw.replace(/[_-]+/g, ' ').trim();
}

/**
 * Live-status step suffix for a tool call. `callIndex` is 0-BASED (the first
 * tool call in a turn is 0), matching the onToolEvent contract emitted by the
 * agent loop. The first call gets NO suffix so a single-tool turn stays clean;
 * subsequent calls are numbered by their 1-based ordinal (" (step 2)",
 * " (step 3)", ...). Shared by the Telegram and Slack surfaces so the numbering
 * can never drift between them — and so a regression like emitting a 1-based
 * callIndex (which rendered the first tool as "(step 2)") is caught by one test.
 */
export function toolStepSuffix(callIndex: number): string {
  return callIndex > 0 ? ` (step ${callIndex + 1})` : '';
}

/** Compact token counts for the footer's context segment ("12.3k", "1.0M"). */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** The turn-result fields the footer renders; a structural subset of AgentTurnResult. */
export interface TurnFooterInput {
  modelId: string;
  latencyMs: number;
  costUsd: number;
  toolCallCount: number;
  inputTokens: number;
}

/**
 * Dev footer appended to a finished turn ("model · latency · cost · tools ·
 * ctx"), gated by CCE_SHOW_FOOTER / CCE_SHOW_CONTEXT. Shared by Telegram and
 * BOTH Slack send paths so the copy can never drift between surfaces (CLAUDE.md
 * "chat surface parity" — footers are on the list). The dashboard Chat tab
 * renders its own JSX version of the same fields; keep its copy in step when
 * changing this (web/src/pages/Chat.tsx).
 */
export function formatTurnFooter(
  result: TurnFooterInput,
  contextWindow: number,
  opts: { showFooter: boolean; showContext: boolean },
): string {
  const contextPct = Math.round((result.inputTokens / contextWindow) * 100);
  const contextInfo = opts.showContext
    ? ` · ${fmtTokens(result.inputTokens)}/${fmtTokens(contextWindow)} ctx (${contextPct}%)`
    : '';
  if (opts.showFooter) {
    const tools =
      result.toolCallCount > 0
        ? ` · ${result.toolCallCount} tool${result.toolCallCount === 1 ? '' : 's'}`
        : '';
    return `\n\n_${result.modelId.split('.').pop()} · ${Math.round(result.latencyMs)}ms · $${result.costUsd.toFixed(4)}${tools}${contextInfo}_`;
  }
  if (opts.showContext) {
    return `\n\n_ctx: ${fmtTokens(result.inputTokens)}/${fmtTokens(contextWindow)} (${contextPct}%)_`;
  }
  return '';
}
