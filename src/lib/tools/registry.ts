/**
 * Tool registry: a minimal abstraction over Bedrock Converse tool use.
 *
 * Each tool exposes a JSON schema (`spec`) that gets passed to Bedrock,
 * and a handler that runs when the model decides to call it. The agent
 * loop iterates: model emits toolUse → handler runs → result goes back
 * to the model → repeat until end_turn.
 *
 * v1 ships with synchronous, single-process tools. Long-running tools
 * (Athena queries, web search, etc.) get deferred to async dispatch
 * later.
 */

import type { Tool as BedrockTool } from '@aws-sdk/client-bedrock-runtime';
import { emitToolMetric } from '../../observability/emf.js';

export interface ToolContext {
  agentId: string;
  chatId: string;
  /** Genuine caller-held Paperclip run id. Ordinary chat turns omit it. */
  runId?: string;
  /** Speaker id if known (Slack user / Telegram chat); used for audit attribution. */
  userId?: string;
  /** Surface this turn came from — lets tools tailor side effects. */
  surface?: 'telegram' | 'slack' | 'dashboard' | 'system';
  /**
   * Surface-native reply id. On every surface that runs more than one bot it
   * ALSO carries the identity that owns the conversation:
   *   "<chatId>:bot-<agentId>"                 Telegram (always; /tg/:agentId)
   *   "slack:<channel>:app-<agentId>[:<ts>]"   Slack per-agent app
   *   "slack:<channel>[:<ts>]"                 Slack main bot (one identity)
   *
   * THE IDENTITY SEGMENT IS ROUTING METADATA, NEVER A chat_id/channel. Do not
   * hand this field to an adapter raw, and do not pass `agentId` as the sender
   * beside it: `agentId` is the TURN's agent (a sticky default such as `main`),
   * not the bot whose webhook received the message, and sending as it delivers
   * over the wrong token — a 403, or the text posted into a different
   * conversation. Parse with parseTelegramChatId/parseSlackChatId, or just call
   * deliverToReplyChat (lib/scheduler/delivery.ts), which does both.
   *
   * chatId may be a principal alias (owner:*) that no API can deliver to —
   * tools that schedule future sends (schedule_task) stamp THIS as the
   * delivery target, identity segment included, and it round-trips to DDB.
   */
  replyChatId?: string;
  /**
   * Whose mission board the mission tools address, when that is not `agentId`.
   * Set by a surface that runs more than one bot per conversation and whose
   * agent picker can answer as somebody else (Telegram: the sticky default
   * answers `main` inside `/tg/research/webhook`). Absent means `agentId`.
   *
   * WHY A TOOL MUST NOT JUST READ `agentId` FOR A BOARD: `/missions` already
   * scopes on the receiving bot (`CommandScope.boardAgentId`), so a tool that
   * scopes on the turn agent puts TWO BOARDS in one conversation — the command
   * prints a ref that `list_missions` then reports as belonging to nobody, and
   * `create_mission` writes where `/mission new` does not.
   */
  boardAgentId?: string;
  /** Agent-to-agent delegation depth; ask_agent refuses past 1. */
  delegationDepth?: number;
}

/**
 * A binary artifact a tool produced (a generated image or a generated
 * document). The model only sees `text`; media rides alongside so the SURFACE
 * can deliver the real thing — a Telegram photo, a Slack file upload, an <img>
 * or a download card in dashboard chat — instead of a bare presigned URL.
 *
 * That distinction is load-bearing. A presigned URL placed in `text` is read
 * by the model and reproduced in its reply, and a signed S3 URL does not
 * survive that round trip: an observed production document link lost its
 * entire X-Amz-* query string and returned AccessDenied. Anything the user
 * must be able to open belongs here, not only in `text`.
 */
export interface ToolMedia {
  /**
   * 'image' renders inline (Telegram photo, dashboard <img>). 'artifact' is a
   * file the user downloads (PDF/DOCX/XLSX) and must NOT be sent down an image
   * path — Telegram's sendPhoto hardcodes `image.png` and dashboard chat
   * renders media as <img>, so a spreadsheet tagged 'image' breaks both.
   */
  kind: 'image' | 'artifact';
  s3Bucket: string;
  s3Key: string;
  contentType: string;
  /** Presigned GET, used by surfaces that render by URL (dashboard chat). */
  presignedUrl?: string;
  caption?: string;
}

export interface ToolResult {
  /** Free-form text returned to the model. */
  text: string;
  /** Mark this as an error result so the model knows. */
  isError?: boolean;
  /** Binary artifacts for the surface to deliver after the turn. */
  media?: ToolMedia[];
}

export interface ToolHandler {
  /** Bedrock spec — what the model sees. */
  spec: BedrockTool;
  /** Implementation. */
  invoke: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
  /** Allowlist gate. Only agents in this set get the tool. Empty = all. */
  allowedAgents?: Set<string>;
}

class ToolRegistry {
  private tools = new Map<string, ToolHandler>();

  register(name: string, handler: ToolHandler): void {
    this.tools.set(name, handler);
  }

  /** Bedrock toolConfig.tools list filtered for a given agent. */
  listFor(agentId: string): BedrockTool[] {
    const out: BedrockTool[] = [];
    for (const [, h] of this.tools) {
      if (h.allowedAgents && h.allowedAgents.size > 0 && !h.allowedAgents.has(agentId)) {
        continue;
      }
      out.push(h.spec);
    }
    return out;
  }

  async invoke(
    name: string,
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const handler = this.tools.get(name);
    if (!handler) {
      // Track dispatch failures too so an "Unknown" bar shows up in the
      // dashboard rather than the call disappearing silently.
      emitToolMetric({
        toolName: name,
        agentId: ctx.agentId,
        latencyMs: 0,
        isError: true,
      });
      return { text: `Unknown tool: ${name}`, isError: true };
    }
    // Enforce the per-agent allowlist at dispatch, not just at listFor()
    // advertisement — the model can name any registered tool, so hiding a
    // tool from listFor is not a control on its own.
    if (
      handler.allowedAgents &&
      handler.allowedAgents.size > 0 &&
      !handler.allowedAgents.has(ctx.agentId)
    ) {
      emitToolMetric({ toolName: name, agentId: ctx.agentId, latencyMs: 0, isError: true });
      return { text: `Tool '${name}' is not authorized for this agent.`, isError: true };
    }
    const startedAt = Date.now();
    try {
      const result = await handler.invoke(args, ctx);
      emitToolMetric({
        toolName: name,
        agentId: ctx.agentId,
        latencyMs: Date.now() - startedAt,
        isError: Boolean(result.isError),
      });
      return result;
    } catch (err) {
      emitToolMetric({
        toolName: name,
        agentId: ctx.agentId,
        latencyMs: Date.now() - startedAt,
        isError: true,
      });
      const msg = err instanceof Error ? err.message : String(err);
      return { text: `Tool '${name}' failed: ${msg}`, isError: true };
    }
  }
}

export const tools = new ToolRegistry();
