/**
 * Agent loop. Builds a request from the agent's configured system prompt
 * + prior turns + the new user message, calls Bedrock (streaming when a
 * callback is provided), dispatches any tool_use blocks the model emits,
 * and returns the final text + usage.
 *
 * Tool dispatch is iterative: model emits toolUse → handler runs →
 * result appended → call Converse again → repeat until end_turn. Capped
 * at TOOL_TURN_LIMIT to avoid runaway loops.
 */

import { randomUUID } from 'node:crypto';
import {
  ConverseCommand,
  type ContentBlock,
  type ImageFormat as BedrockImageFormat,
  type DocumentFormat as BedrockDocumentFormat,
  type Message,
  type Tool as BedrockTool,
  type ToolUseBlock,
} from '@aws-sdk/client-bedrock-runtime';
import {
  bedrockClient,
  converseStreamTurnWithFallback,
  getAffinityModel,
  modelRejectsTemperature,
  withRetry,
  type ConverseStreamCallbacks,
} from '../lib/bedrock/client.js';
import { pickDefaultModel, turnCost, resolveModel, resolveModelInvocation } from '../lib/bedrock/models.js';
import { loadAgent } from '../lib/config/agent-loader.js';
import { tools, type ToolMedia, type ToolResult } from '../lib/tools/registry.js';
import { mcpToolsFor, isMcpToolName, invokeMcpTool } from '../lib/mcp/mcp-tools.js';
import { logger, truncateForLog } from '../observability/logger.js';
import { NO_RESPONSE_NOTICE, type Turn } from '../lib/state/sessions-repo.js';
import { getConfig } from '../lib/state/runtime-config-repo.js';
import { isKillSwitchActive, KillSwitchActiveError } from '../lib/state/kill-switches-repo.js';
import { assertBedrockAllowed } from '../lib/bedrock/guard.js';
import { buildMemoryContext } from '../lib/memory/context-builder.js';
import { listInbox, markStatus } from '../lib/state/inter-agent-tasks-repo.js';
import { recentHive } from '../lib/state/hive-mind-repo.js';
import { writeAudit } from '../lib/audit/audit-writer.js';
import { recordUsage } from '../lib/usage/token-tracker.js';
import { admitTurnSpend, type TurnSpendAdmission } from '../lib/cost/ledger-gate.js';
import { checkAndConsume } from '../lib/state/rate-limits-repo.js';
import { tryAcquirePanic } from '../lib/state/panic-state-repo.js';
import {
  scanForExfil,
  redactMatches,
  getActivePatterns,
  buildStreamingRedactor,
} from '../lib/safety/exfil-guard.js';


// Max tool-dispatch rounds before we force a final answer. Agents now carry
// many MCP tools and sometimes spend a round or two finding the right call
// (e.g. Slack: search to find a DM channel, then read it), so 5 was too tight
// — turns were hitting the cap mid-work and returning "(no response)".
const TOOL_TURN_LIMIT = 8;

/**
 * Output-token ceiling for EVERY model call in a turn — the initial streamed
 * call and each tool-loop round alike.
 *
 * 1024 was too low to emit a document: `generate_document` needs the entire
 * spec inline as tool-call JSON, so a real report ran past the ceiling and came
 * back `stopReason: max_tokens` with no text and no usable tool call. That is
 * what made PDF, DOCX and XLSX all appear broken at once — the ceiling is
 * shared, the libraries were never the problem.
 *
 * It must be passed to the INITIAL call too, not just the tool loop. Raising
 * only the loop left the first call falling through to `?? 1024` in
 * `lib/bedrock/client.ts`, and for a turn that never reaches tool use that is
 * the only call there is — so the truncation survived the first fix.
 *
 * Spend is bounded by the daily cost cap, not by this; the cap is the control
 * that actually stops runaway cost.
 */
const TURN_MAX_TOKENS = 8192;

/** Hard bounds on the runtime override. Below the floor a document cannot be
 * emitted at all; above the ceiling latency and per-turn cost climb without a
 * matching gain. Stored size is not the reason: MAX_TURN_WINDOW_BYTES in
 * sessions-repo caps the window at 300,000 bytes whatever the ceiling. */
const TURN_MAX_TOKENS_FLOOR = 1024;
const TURN_MAX_TOKENS_CEILING = 32_768;

/**
 * Output ceiling for this turn, tunable at runtime without a deploy.
 *
 * Set it the same way every other tunable in this repo is set — the
 * `runtime-config` table, category `agent`, key `max_output_tokens` — which the
 * dashboard's `/config` route already writes and which propagates within the
 * repo's 30s config cache. Global, not per-agent: every agent shares it, so a
 * newly created agent inherits the same ceiling with no extra setup.
 *
 * Falls back to TURN_MAX_TOKENS and never throws: a config lookup failure must
 * not be able to break a turn.
 */
export async function resolveTurnMaxTokens(): Promise<number> {
  const raw = await getConfig('agent', 'max_output_tokens').catch(() => undefined);
  // `typeof`, not `raw?.trim()`: getConfig returns the stored attribute
  // unchecked, and a value stored as a number would throw here and fail the turn.
  const trimmed = typeof raw === 'string' ? raw.trim() : raw;
  const parsed = Number(trimmed);
  if (!trimmed || !Number.isFinite(parsed)) return TURN_MAX_TOKENS;
  return Math.min(TURN_MAX_TOKENS_CEILING, Math.max(TURN_MAX_TOKENS_FLOOR, Math.trunc(parsed)));
}

export interface AttachmentBlock {
  /** image or document */
  kind: 'image' | 'document';
  format: BedrockImageFormat | BedrockDocumentFormat;
  /** raw bytes (base64-decoded). Bedrock SDK accepts Uint8Array. */
  bytes: Uint8Array;
  /** Required for document blocks; ignored for images. */
  name?: string;
}

/**
 * WHO AUTHORED `userText` — and nothing else.
 *
 * This is deliberately NOT `surface`, which names the RENDERER. A
 * machine-driven turn can legitimately want a chat surface's rendering, audit
 * and delivery shape, so reading authorship off `surface` would silently hand
 * fleet-halt power to any such caller. The one decision that hangs off this
 * type is whether the emergency kill phrase is honoured (see `runAdmittedTurn`).
 *
 *   'human_chat' — a PERSON typed this into a chat window, and the WHOLE of
 *                  `userText` is what they typed. Exactly five call sites set
 *                  it and they are the only `runAgentTurn` callers that may:
 *                  Telegram, both Slack send paths, and the dashboard chat
 *                  console's streamed and non-streamed routes.
 *   'machine'    — the text was assembled by us or handed to us by a remote
 *                  system: a scheduled prompt, a War Room transcript, an
 *                  `ask_agent` delegation, a Paperclip issue body.
 *
 * 'machine' IS THE DEFAULT, and that is the point of the field: a new caller
 * that never thinks about this gets the safe behaviour. Gaining the ability to
 * halt the fleet requires typing the words `origin: 'human_chat'`.
 *
 * A person's message can still reach a 'machine' turn — a War Room turn wraps
 * the human's latest line in a multi-speaker transcript — so this type is NOT
 * the only place the kill phrase is honoured. It is the only place it is
 * honoured on a `runAgentTurn` request. The War Room checks the human's RAW
 * message at its entry points instead (`src/lib/warroom/kill-phrase.ts`);
 * see `engageEmergencyHalt` for why the transcript is the wrong thing to test.
 */
export type TurnOrigin = 'human_chat' | 'machine';

export const TOOL_INPUT_CAP = 1024;
export const TOOL_OUTPUT_CAP = 2048;

/**
 * The estimate a stopped turn settles with errs on the safe side — the ledger's
 * own rule (ledger-gate.ts): over-count, never under-count. An image counts at
 * the most one costs after Bedrock scales it down; a request larger than the
 * model's context window is refused, not billed, so the estimate is capped there
 * (200,000 when the spec names none).
 */
const IMAGE_TOKEN_ESTIMATE = 1_600;
const DEFAULT_CONTEXT_WINDOW = 200_000;

/** Input tokens one content block is billed for: text and tool JSON at four characters a token, a document by its size. */
function blockInputEstimate(block: ContentBlock): number {
  const resultChars = block.toolResult?.content?.reduce((n, c) => n + (c.text?.length ?? 0), 0) ?? 0;
  const argumentChars = block.toolUse ? JSON.stringify(block.toolUse.input ?? {}).length : 0;
  return Math.ceil(((block.text?.length ?? 0) + resultChars + argumentChars) / 4)
    + (block.image ? IMAGE_TOKEN_ESTIMATE : 0)
    + Math.ceil((block.document?.source?.bytes?.byteLength ?? 0) / 4);
}

/** The input estimate of one model call: the system prompt, every message block and the tool list it sends. */
function callInputEstimate(modelId: string, systemPrompt: string, sent: Message[], sentTools: BedrockTool[]): number {
  const messageTokens = sent.reduce((n, m) => n + (m.content ?? []).reduce((k, b) => k + blockInputEstimate(b), 0), 0);
  const toolTokens = sentTools.length > 0 ? Math.ceil(JSON.stringify(sentTools).length / 4) : 0;
  const contextWindow = resolveModel(modelId).contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  return Math.min(contextWindow, Math.ceil(systemPrompt.length / 4) + messageTokens + toolTokens);
}

/**
 * Owner decision 53: the database lookup tool can return other people's
 * conversation text, so its result is never passed on to a surface (who it may
 * read is the owner's open question A172). The model still receives it.
 */
const TOOL_RESULT_HIDDEN_NOTICE = "(This tool's result is not shown here.)";

/** A failed tool's text loses its ARNs and account ids before it leaves the loop. */
function scrubAwsIdentifiers(text: string): string {
  return text.replace(/arn:aws[^\s"']*/g, '[arn]').replace(/\b\d{12}\b/g, '[account]');
}

/**
 * A tool's result as a surface may show it: through the same block-severity
 * redactor as the reply, then capped. The model receives the raw text as ever.
 */
function toolResultForDisplay(
  name: string, result: ToolResult, redact: (text: string) => string,
): { output: string; truncated: boolean } {
  if (name === 'dynamodb_query') return { output: TOOL_RESULT_HIDDEN_NOTICE, truncated: false };
  const redacted = redact(result.text);
  const shown = result.isError ? scrubAwsIdentifiers(redacted) : redacted;
  return { output: shown.slice(0, TOOL_OUTPUT_CAP), truncated: shown.length > TOOL_OUTPUT_CAP };
}

export interface AgentTurnRequest {
  abortSignal?: AbortSignal;
  agentId: string;
  chatId: string;
  /** Genuine caller-held Paperclip run id. Chat turns leave this absent. */
  runId?: string;
  userText: string;
  history: Turn[];
  modelOverride?: string;
  onChunk?: (cumulativeText: string) => void;
  /**
   * Fired right before each tool call dispatches, so surfaces can show live
   * "working on it" status (Telegram edits its placeholder message). `name` is
   * the raw tool name (mcp__slack__slack_search_public, web_search, ...);
   * humanizeToolName() turns it into display copy. `callIndex` is 0-BASED (the
   * first tool call in a turn is 0); surfaces suppress the step label on index 0
   * and number the rest by their 1-based ordinal (see toolStepSuffix). Errors in
   * the callback are swallowed — status UX must never break a turn.
   */
  onToolEvent?: (event: { name: string; callIndex: number; toolUseId: string; input: string; inputTruncated: boolean }) => void;
  onToolResult?: (event: { name: string; callIndex: number; toolUseId: string; output: string; isError: boolean; truncated: boolean }) => void;
  surface?: 'telegram' | 'slack' | 'dashboard' | 'system';
  /**
   * Who authored `userText`. Absent means 'machine' — see `TurnOrigin` for why
   * that default is the safe one and why this is not inferred from `surface`.
   */
  origin?: TurnOrigin;
  /** Inline attachments (image, PDF) sent with the user message. */
  attachments?: AttachmentBlock[];
  /**
   * Extra, surface-specific guidance appended to the agent's system prompt for
   * this turn only (e.g. the War Room etiquette note). It rides in the SYSTEM
   * prompt — which the Bedrock guardrail does NOT inspect — so it can carry
   * behavioral instructions that would trip the PROMPT_ATTACK filter if placed
   * in the user-message framing. Applies to every agent generically, so new
   * agents inherit it with no per-agent config.
   */
  systemNote?: string;
  /**
   * Skip the Bedrock guardrail for this turn. The War Room sets this: it feeds
   * a multi-speaker transcript as the user message, and the guardrail's
   * PROMPT_ATTACK / prompt-injection filter trips on that SHAPE even when the
   * content is innocent ("Hey, I need your opinion, guys."), so every agent
   * reply came back blocked. Scoped per-turn, so Telegram / Slack / dashboard /
   * scheduler turns keep the guardrail. The bedrock_global and cost-cap kill
   * switches, DLP, and outbound exfil scan still apply regardless.
   */
  skipGuardrail?: boolean;
  /** Optional speaker id. For Slack this is the Slack user id; for
   * Telegram the numeric chat id; for dashboard a passed-in label. */
  userId?: string;
  /**
   * The users-table userId of the DASHBOARD principal driving this turn
   * (magic-link session), when there is one. Distinct from `userId`, which is
   * the surface speaker id. Used for per-seat spend attribution; chat-surface
   * turns carry none until a chat-identity→seat mapping exists.
   */
  dashboardUserId?: string;
  /**
   * Surface-native reply id (Telegram chat id; "slack:<channel>[:threadTs]").
   * Threaded into ToolContext so scheduling tools can stamp a deliverable
   * target even when chatId is a principal alias (owner:*).
   */
  replyChatId?: string;
  /**
   * WHOSE MISSION BOARD THE TOOLS ADDRESS, when that is not `agentId`.
   *
   * The exact counterpart of `CommandScope.boardAgentId` in
   * `src/agent/commands.ts`, and it exists for the same reason one conversation
   * must not have two boards: `/missions` acts on the board of the BOT that
   * received the message, so `list_missions` in that same chat has to answer
   * from the same board or the ref the board reply teaches the user to copy is
   * refused by the agent standing next to it.
   *
   * `agentId` is the SESSION scope (whose history and records this turn uses);
   * this is the BOARD scope (a remote object named by an agent id). They differ
   * only where a surface runs more than one bot AND the picker can answer as
   * someone else — Telegram, where the sticky default answers `main` inside
   * `/tg/research/webhook`. A surface with one identity per conversation omits
   * it and the two coincide, which is why Slack's per-agent apps (which pass
   * one id to both `runCommand` and `runAgentTurn`) and the dashboard pass
   * nothing and are correct by construction.
   */
  boardAgentId?: string;
  /** Agent-to-agent delegation depth (ask_agent). Default 0. */
  delegationDepth?: number;
  /**
   * Per-turn tool blocklist (raw tool names, built-in or mcp__*). The War
   * Room passes the meeting's resolved tool policy here: blocked specs are
   * stripped from what the model sees, and dispatch refuses them as a second
   * layer. Scoped to this one turn; other surfaces pass nothing.
   */
  blockedTools?: string[];
}

// KillSwitchActiveError now lives in lib/state/kill-switches-repo so the Bedrock
// guard and other low-level modules can throw it without importing the agent
// loop (which would be an import cycle). Re-exported for existing import sites.
export { KillSwitchActiveError };

export class CostCapExceededError extends Error {
  constructor(public spendUsd: number, public capUsd: number) {
    super(`daily cost cap exceeded: $${spendUsd.toFixed(4)} >= $${capUsd.toFixed(2)}`);
    this.name = 'CostCapExceededError';
  }
}

/**
 * System-wide conduct floor prepended to EVERY agent's system prompt, on every
 * surface (Telegram, Slack, Chat, scheduled, canary, War Room — every path that
 * runs through runAgentTurn). This is the default behavior the fleet inherits
 * with no per-agent config: any agent created later gets it automatically, and
 * it cannot be forgotten or turned off in an agent's own prompt. It rides in the
 * SYSTEM prompt, which the Bedrock guardrail does not inspect. Deliberately soft
 * — it says "unless your instructions below call for something different" — so an
 * agent's own CLAUDE.md still wins on specifics (a report agent can still be
 * thorough). (Jarvis, the voice concierge, is a separate path and unaffected.)
 */
const BASE_CONDUCT = [
  'Response defaults — apply these unless the agent instructions below call for something different:',
  '- Reply in the first person, in your own voice.',
  '- Match your length and depth to what was actually asked. A quick or casual message gets a short, natural reply; a real question gets a real answer. Do not inflate a simple message into an essay.',
  '- Be direct. Skip filler openers and do not echo the question back before answering.',
  '- Do not begin your reply with your own name, role, or a timestamp; the surface already shows who is speaking.',
  '- Format for a phone screen: short paragraphs, and for a list of records give each its own short line or a small card (a bold title, then the key facts) — never a Markdown table, which renders as raw pipes on mobile.',
].join('\n');

/**
 * When a session's history interleaves turns from more than one surface
 * (owner-aliased/claimed principals share one session row across Telegram,
 * Slack, and — when peeked — the dashboard), emit a small system-prompt note
 * that makes the merge legible: the model should treat it as one continuous
 * conversation and not re-introduce itself per surface. Pure; ≤~120 tokens.
 */
export function buildCrossSurfaceNote(
  history: Turn[],
  currentSurface: string | undefined,
  nowSec: number = Math.floor(Date.now() / 1000),
): string | undefined {
  if (!currentSurface) return undefined;
  const others = new Map<string, number>(); // surface -> most recent ts
  for (const t of history) {
    if (t.surface && t.surface !== currentSurface && t.surface !== 'system') {
      others.set(t.surface, Math.max(others.get(t.surface) ?? 0, t.ts));
    }
  }
  if (others.size === 0) return undefined;
  const ago = (ts: number): string => {
    const d = Math.max(0, nowSec - ts);
    if (d < 90) return 'moments ago';
    if (d < 3600) return `${Math.round(d / 60)}m ago`;
    if (d < 86400) return `${Math.round(d / 3600)}h ago`;
    return `${Math.round(d / 86400)}d ago`;
  };
  const recency = [...others.entries()]
    .map(([s, ts]) => `last ${s} message ${ago(ts)}`)
    .join(', ');
  return `<other_surfaces>\nThis is one continuous conversation with the same person across chat surfaces — the history above interleaves them (${recency}). Do not re-introduce yourself or repeat answers already given on another surface; continue naturally here on ${currentSurface}.\n</other_surfaces>`;
}

async function buildSystemPrompt(
  agentId: string,
  chatId: string,
  basePrompt: string,
  extraNote?: string,
  crossSurfaceNote?: string,
): Promise<string> {
  // Context assembly degrades gracefully — a memory/inbox/hive read failure must
  // not kill the turn — but it is NOT silent: each fallback logs a warning so a
  // persistently broken read (which would strip the agent of long-term memory or
  // cross-agent context) is visible in the logs instead of vanishing.
  const softly = <T>(read: Promise<T>, whatFailed: string, fallback: T): Promise<T> =>
    read.catch((err) => {
      logger.warn(
        { agentId, chatId, err: truncateForLog(String(err), 200) },
        `context: ${whatFailed}`,
      );
      return fallback;
    });
  const [memoryCtx, inbox, hive] = await Promise.all([
    softly(buildMemoryContext(agentId, chatId), 'memory assembly failed; continuing without long-term memory', {
      text: '',
      layerCounts: { memories: 0, consolidations: 0, semantic: 0 },
    }),
    softly(listInbox(agentId, 5, ['queued']), 'inbox read failed; continuing without inbox', []),
    // Cross-agent shared memory. Pass agentId so the repo can bias toward this
    // agent's own notes while still surfacing org-wide context per the hive
    // contract (recentHive returns HiveEntry rows with author/topic/content/ts).
    softly(recentHive({ agentId, limit: 12 }), 'hive read failed; continuing without shared memory', []),
  ]);
  // BASE_CONDUCT first (the fleet-wide floor), then the agent's own prompt, which
  // establishes its identity/expertise and can override the soft defaults above.
  const sections: string[] = [BASE_CONDUCT, basePrompt];
  // Surface-specific behavioral guidance (e.g. War Room etiquette). Placed right
  // after the agent's own prompt so it frames how to respond, ahead of the
  // injected memory/hive/inbox context.
  if (extraNote && extraNote.trim()) {
    sections.push(extraNote.trim());
  }
  if (memoryCtx.text) {
    sections.push(
      `<long_term_memory>\nFacts you've learned about this user in earlier conversations:\n${memoryCtx.text}\n</long_term_memory>`,
    );
  }
  if (hive.length > 0) {
    const block = hive
      .map((e) => {
        const day = (e.ts ?? '').slice(0, 10);
        const where = `${e.authorAgentId}${e.topic ? `/${e.topic}` : ''}`;
        // Neutralize angle brackets so a note can't close </hive_context> and
        // inject pseudo-structure into the system prompt (boundary defense for
        // every note source, manual or auto-promoted).
        //
        // THIS IS THE PRECEDENT PHASE 6 REUSED, and the reuse is the DISCIPLINE,
        // not the bytes: escape angle brackets at INTERPOLATION (here, inside the
        // .map() that builds the prompt), never at storage, on every
        // attacker-influenced field. The Paperclip boundary calls
        // `neutralizeForPrompt` (src/lib/paperclip/mission-projection.ts), which
        // is the same discipline with a different substitution — HTML entities
        // rather than the guillemets below. The two are NOT byte-identical and
        // deliberately were not forced to be: `neutralizeForPrompt`'s output is
        // frozen by an exact-equality test, and rewriting either one to match the
        // other would change shipped prompt bytes on a surface no probe covers.
        // What matters, and what is enforced, is that there is no THIRD scheme.
        const safe = e.content.slice(0, 280).replace(/</g, '‹').replace(/>/g, '›');
        return `- [${day}] (${where}) ${safe}`;
      })
      .join('\n');
    sections.push(
      `<hive_context>\nShared notes other agents have logged to the Hive Mind. These are cross-agent, cross-chat facts. Treat them as background context; call search_hive if you need more on a topic, and log_to_hive when you learn something other agents would need:\n${block}\n</hive_context>`,
    );
  }
  if (inbox.length > 0) {
    const block = inbox
      .map(
        (t) =>
          `- from ${t.fromAgent} (${t.intent}): ${t.messageText.slice(0, 240)}`,
      )
      .join('\n');
    sections.push(
      `<inbox>\nMessages from other agents queued for you. Consider whether any are relevant to the user's current request:\n${block}\n</inbox>`,
    );
    // Marking these delivered prevents re-injection on every turn. A failed
    // markStatus is not fatal (the item stays 'queued' and simply re-injects
    // next turn), but log it: a persistent failure means the same inter-agent
    // message is delivered repeatedly with no visible cause.
    void Promise.all(
      inbox.map((t) =>
        markStatus(t, 'delivered').catch((err) => {
          logger.warn(
            { agentId, chatId, taskId: t.id, err: truncateForLog(String(err), 200) },
            'inbox: markStatus(delivered) failed; item will re-inject next turn',
          );
        }),
      ),
    );
  }
  if (crossSurfaceNote) {
    sections.push(crossSurfaceNote);
  }
  return sections.join('\n\n');
}

/**
 * Why a turn was refused BEFORE any model call, and whether resubmitting the
 * same turn could go differently. See `AgentTurnResponse.refusal`, which is the
 * only place this is ever set.
 *
 * `kind` names the gate, one per pre-model short-circuit in `runAgentTurn`:
 *
 *   'kill_phrase'     — the emergency kill phrase was typed in a chat surface
 *                       (`origin: 'human_chat'`, the only origin that gate
 *                       honours); the fleet is now halted on purpose. A
 *                       machine-originated turn never produces this kind.
 *   'sessions_frozen' — the `sessions_frozen` maintenance kill switch is on.
 *   'rate_limited'    — the per-identity turn rate limit had no token left.
 *
 * `retryable` is what a caller branches on, and it is a property of the CAUSE,
 * not of the text: `true` means the cause is cured by time or by an operator
 * (a freeze is lifted, a rate-limit window rolls over), so an identical
 * resubmission of this very turn can succeed. `false` means the refusal is the
 * intended terminal outcome of this exact input — resubmitting the kill phrase
 * just halts the fleet again.
 */
export interface TurnRefusal {
  kind: 'kill_phrase' | 'sessions_frozen' | 'rate_limited';
  retryable: boolean;
}

export interface AgentTurnResponse {
  stopped?: true;
  text: string;
  modelId: string;
  costUsd: number;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  toolCallCount: number;
  /**
   * True when the Bedrock guardrail intervened (stopReason
   * 'guardrail_intervened'), so `text` is the guardrail's configured block
   * message, NOT the agent speaking. Callers should surface this as a system /
   * safety note rather than attributing the words to the agent.
   */
  blocked?: boolean;
  /**
   * Set — and set ONLY — when this turn was refused by one of `runAgentTurn`'s
   * three pre-model gates (the emergency kill phrase, the `sessions_frozen`
   * maintenance switch, the per-identity rate limit). On those paths `text` is
   * a canned enforcement notice, NOT the agent speaking, and every metric on
   * this response is zero because no model ever ran.
   *
   * DISTINCT FROM `blocked`, which stays guardrail-only and is never set here.
   * A guardrail block is a verdict on the message; a refusal is a verdict on
   * the moment. A caller that must not attribute `text` to the agent — anything
   * writing session history, which is replayed to the model as words the agent
   * said — has to check BOTH, because neither implies the other.
   *
   * Callers that hold a one-shot claim, lease or dedupe key over the turn MUST
   * branch on `refusal.retryable`: a retryable refusal means this attempt did
   * no work and a later identical attempt can, so the claim has to be RELEASED
   * rather than recorded as a completed turn. `retryable: false` is terminal
   * and keeps the claim. See `TurnRefusal`.
   *
   * Absent on every ordinary turn, on a guardrail block, and on an empty but
   * successful answer. Never set on any path that reached Bedrock — including
   * the ones that THROW (`CostCapExceededError`, `KillSwitchActiveError` for
   * `bedrock_global`), which are not refusals in this sense and are unchanged.
   */
  refusal?: TurnRefusal;
  /**
   * Binary artifacts tools produced this turn (generated images). Surfaces
   * deliver them natively after the text reply — Telegram sendPhoto, Slack
   * file upload, dashboard `image` SSE event. Capped at 4 per turn.
   */
  media?: ToolMedia[];
}

/** A guardrail intervention replaces the model output with a block message. */
function isGuardrailBlock(stopReason: string | undefined): boolean {
  return stopReason === 'guardrail_intervened';
}

/**
 * What the user sees when the guardrail intervenes. Bedrock's own block
 * message is a cold dead-end ("This request was blocked by content policy.")
 * that reads like the conversation is broken. This one tells the user the
 * truth that matters, which is that nothing was saved and they can simply
 * keep talking.
 */
export const GUARDRAIL_BLOCK_NOTICE =
  'That message tripped the safety filter, so I didn’t process it. ' +
  'Nothing was saved and the conversation is unaffected. ' +
  'Rephrase it or just keep going.';

/**
 * Block messages that may exist in already-persisted sessions (the Bedrock
 * messaging configured in infra, past and present, plus our own notice as a
 * belt-and-braces guard). Sessions written before handlers learned to skip
 * persisting blocked turns are permanently poisoned otherwise: the guardrail
 * re-scans the whole transcript every turn, so one blocked message used to
 * block every message after it until /newchat.
 */
const BLOCK_NOTICE_MARKERS = [
  'This request was blocked by content policy.',
  'This response was blocked by content policy.',
  'That message tripped the safety filter and was not processed.',
  'That reply tripped the safety filter and was withheld.',
  GUARDRAIL_BLOCK_NOTICE,
];

/**
 * Drop guardrail-blocked exchanges from history before they reach Bedrock.
 * Removes the canned assistant block notice AND the user message that tripped
 * it, so the transcript both stays role-alternating and stops carrying the
 * content that re-trips the guardrail on every later turn.
 */
export function stripBlockedTurns(turns: Turn[]): Turn[] {
  const out: Turn[] = [];
  for (const t of turns) {
    if (t.role === 'assistant' && BLOCK_NOTICE_MARKERS.some((m) => t.text.includes(m))) {
      if (out.length > 0 && out[out.length - 1]?.role === 'user') out.pop();
      continue;
    }
    out.push(t);
  }
  return out;
}

/**
 * What to say when the model returned no text at all. `max_tokens` means the
 * reply was cut off before it finished — generating a document is the common
 * trigger, because the whole spec has to be emitted inline as tool-call JSON.
 */
export function truncatedNotice(stopReason: string | undefined): string {
  return stopReason === 'max_tokens'
    ? 'That reply was cut off before it finished — the answer ran past the length limit. Ask for a smaller piece (fewer sections, or one part at a time) and it will come back.'
    : NO_RESPONSE_NOTICE;
}

function turnsToMessages(turns: Turn[]): Message[] {
  return turns.map((t) => ({
    role: t.role,
    content: [{ text: t.text }],
  }));
}

function buildUserContent(
  userText: string,
  attachments?: AttachmentBlock[],
): ContentBlock[] {
  if (!attachments || attachments.length === 0) {
    return userText ? [{ text: userText }] : [{ text: '(no text)' }];
  }
  const blocks: ContentBlock[] = [];
  const documentNames = new Set<string>();
  for (const att of attachments) {
    if (att.kind === 'image') {
      blocks.push({
        image: {
          format: att.format as BedrockImageFormat,
          source: { bytes: att.bytes },
        },
      });
    } else {
      const base = (att.name ?? 'document').replace(/[^A-Za-z0-9 ()\[\]-]/g, ' ').replace(/\s+/g, ' ').trim() || 'document';
      let name = base;
      for (let suffix = 2; documentNames.has(name); suffix++) name = `${base} (${suffix})`;
      documentNames.add(name);
      blocks.push({
        document: {
          format: att.format as BedrockDocumentFormat,
          name,
          source: { bytes: att.bytes },
        },
      });
    }
  }
  // Bedrock requires text last when mixed with media; describe-then-text works fine.
  blocks.push({ text: userText || 'What can you tell me about this?' });
  return blocks;
}

/**
 * DLP egress scan over the assistant's final reply before it leaves the
 * system. scanForExfil() internally respects the exfil_guard_disabled kill
 * switch (returns no matches when tripped) and audits block hits + oversized
 * payloads, so this just acts on the result. On a block-severity match the
 * offending spans are redacted out of the returned text rather than withheld
 * wholesale, so the user still gets a usable reply. Warn-severity matches are
 * logged only. Never throws. On a scan FAILURE it fails CLOSED — returning the
 * placeholder rather than passing unscanned content through.
 *
 * SCOPE: this governs the FINAL returned + persisted text and fully protects
 * non-streamed surfaces. STREAMED surfaces (req.onChunk set: dashboard SSE,
 * Slack/Telegram live edits) are protected separately by buildStreamingRedactor,
 * which redacts BLOCK-severity secrets out of every live chunk before it reaches
 * the client, so a streamed reply never shows a block-severity secret. Residual:
 * warn-severity matches are log-only on both paths (by design), and the
 * scan-error placeholder here only replaces the final persisted text — but block
 * secrets were already redacted live, so the streamed view is not left exposed.
 */
const EXFIL_SCAN_FAILED_PLACEHOLDER =
  'I could not safely deliver that reply because the outbound safety scan did not complete. Please try again in a moment.';

async function scanOutboundReply(
  text: string,
  ctx: { agentId: string; chatId: string },
): Promise<string> {
  if (!text) return text;
  try {
    const result = await scanForExfil(text);
    if (result.matches.length === 0) return text;

    if (result.blocked) {
      // scanForExfil already wrote the exfil_blocked audit event; redact the
      // matched secrets out of the outbound text using the active pattern set.
      const patterns = await getActivePatterns().catch(() => undefined);
      const redacted = redactMatches(text, patterns);
      logger.warn(
        {
          agentId: ctx.agentId,
          chatId: ctx.chatId,
          patterns: result.matches.map((m) => m.patternId),
        },
        'exfil: blocked-severity match in outbound reply, redacting',
      );
      return redacted;
    }

    // Warn-only: surface in logs but let the reply through unchanged.
    logger.warn(
      {
        agentId: ctx.agentId,
        chatId: ctx.chatId,
        patterns: result.matches.map((m) => m.patternId),
      },
      'exfil: warn-severity match in outbound reply',
    );
    return text;
  } catch (err) {
    // Fail CLOSED: we can't redact without scan results, so withhold the whole
    // reply rather than emit unscanned content on the chat surface.
    logger.error(
      { agentId: ctx.agentId, chatId: ctx.chatId, err: truncateForLog(String(err), 200) },
      'exfil: outbound scan failed, withholding reply (fail-closed)',
    );
    return EXFIL_SCAN_FAILED_PLACEHOLDER;
  }
}

/**
 * Public turn entrypoint: spend admission wraps the whole turn (C2-full).
 * admitTurnSpend() decides cap enforcement (legacy strict counter, or the
 * atomic reserve-before-spend ledger when cost/ledger_enabled is on) and
 * returns a one-shot finalize/abort pair. The turn body settles at its two
 * spend-completion points; every other exit (refusal short-circuits, throws)
 * lands on abort(), which releases an un-spent hold and is a no-op after a
 * settle. Admission runs BEFORE the frozen/rate-limit refusals, so a
 * cap-blocked turn throws CostCapExceededError even when a refusal would
 * also have applied.
 *
 * The three refusal short-circuits RETURN NORMALLY rather than throwing, so a
 * caller cannot tell one from a real answer by catching. Each carries
 * `refusal` on its response — a typed marker, not prose to match on — and that
 * is the supported way to detect them; see `AgentTurnResponse.refusal`.
 */
export async function runAgentTurn(req: AgentTurnRequest): Promise<AgentTurnResponse> {
  // A turn stopped before it began starts no paid work: no admission, no hold.
  if (req.abortSignal?.aborted) return stoppedBeforeStart(req);
  const spendAdmission = await admitTurnSpend({
    idempotencyKey: randomUUID(),
    attribution: {
      ...(req.dashboardUserId ? { dashboardUserId: req.dashboardUserId } : {}),
      sessionId: req.chatId,
    },
  });
  if (!spendAdmission.admitted) {
    const blocked = spendAdmission.blocked;
    void writeAudit({
      action: 'kill_switch_blocked',
      agentId: req.agentId,
      chatId: req.chatId,
      surface: req.surface ?? 'system',
      detail: {
        switch: 'cost_cap_per_day',
        reason: blocked?.reason,
        spendUsd: blocked?.spendUsd,
        capUsd: blocked?.capUsd,
      },
      result: 'blocked',
    });
    throw new CostCapExceededError(blocked?.spendUsd ?? Number.NaN, blocked?.capUsd ?? Number.NaN);
  }
  try {
    const result = await runAdmittedTurn(req, spendAdmission);
    // Refusal short-circuits (frozen / rate-limited) return without spending;
    // release the un-spent hold. No-op when the body already settled.
    void spendAdmission.abort();
    return result;
  } catch (err) {
    void spendAdmission.abort();
    throw err;
  }
}

/** The response of a turn stopped before it began: nothing ran, nothing was reserved. */
function stoppedBeforeStart(req: AgentTurnRequest): AgentTurnResponse {
  return {
    text: '', stopped: true, modelId: req.modelOverride ?? '', costUsd: 0, latencyMs: 0,
    inputTokens: 0, outputTokens: 0, toolCallCount: 0, blocked: false,
  };
}

/**
 * Minimum length before the env phrase is honored. Guards against a mis-set
 * or truncated EMERGENCY_KILL_PHRASE (e.g. a single character) turning every
 * message into an all-stop. Setup generates STOP-<adj>-<noun>-<hex> (~20
 * chars), so real phrases always clear this.
 */
export const MIN_KILL_PHRASE_LENGTH = 12;

/**
 * True when the inbound text contains the emergency kill phrase (setup Q9;
 * injected from the dashboard secret's kill_phrase field). Case-insensitive
 * substring: in a panic, "PLEASE STOP-firm-sentry-3a2f NOW" must still trip.
 * Dormant when the env var is absent or suspiciously short.
 */
export function matchesKillPhrase(
  userText: string,
  phrase: string | undefined = process.env.EMERGENCY_KILL_PHRASE,
): boolean {
  const p = (phrase ?? '').trim();
  if (p.length < MIN_KILL_PHRASE_LENGTH) return false;
  return userText.toLowerCase().includes(p.toLowerCase());
}

/**
 * Engage the panic freeze for a kill phrase a PERSON just typed, and return the
 * static, state-honest confirmation to show them. Snapshot + every kill switch
 * on, exactly like the dashboard panic button. Never throws: a halt that could
 * not be engaged is reported in the returned text, never swallowed.
 *
 * It lives next to the matcher so every path that honours the phrase says the
 * SAME words. Two paths do:
 *   - `runAdmittedTurn` below, for the five chat call sites (`origin:
 *     'human_chat'`);
 *   - the War Room entry points, via `src/lib/warroom/kill-phrase.ts`, which
 *     check the human's RAW message before it is published as a transcript
 *     line. They cannot go through the turn gate: a room turn's `userText` is
 *     an assembled multi-speaker transcript (see `buildContextPrompt`), so
 *     honouring the phrase there would let an AGENT's words halt the fleet and
 *     would re-halt from a stale line on every later round.
 */
export async function engageEmergencyHalt(ctx: {
  agentId: string;
  chatId: string;
  surface: 'telegram' | 'slack' | 'dashboard' | 'system';
}): Promise<string> {
  let engaged = false;
  let alreadyActive = false;
  try {
    const res = await tryAcquirePanic(
      'emergency kill phrase received',
      `${ctx.surface}:${ctx.chatId}`,
    );
    engaged = res.acquired;
    alreadyActive = !res.acquired && res.state.active;
    if (engaged && (res.state.partialFailures?.length ?? 0) > 0) {
      logger.error(
        { partialFailures: res.state.partialFailures },
        'kill phrase panic engaged with partial switch failures',
      );
    }
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      'kill phrase received but panic acquisition failed',
    );
  }
  void writeAudit({
    action: 'emergency_kill_phrase',
    agentId: ctx.agentId,
    chatId: ctx.chatId,
    surface: ctx.surface,
    detail: { engaged, alreadyActive },
    result: engaged || alreadyActive ? 'blocked' : 'error',
  });
  return engaged
    ? 'EMERGENCY HALT engaged. Every kill switch is on and new agent turns are frozen. Restore from the dashboard panic/kill-switch controls when you are ready.'
    : alreadyActive
      ? 'Emergency halt is already engaged; nothing is running. Restore from the dashboard panic/kill-switch controls.'
      : 'Kill phrase received but the halt could NOT be engaged (state store unreachable). Use the dashboard panic button now.';
}

async function runAdmittedTurn(
  req: AgentTurnRequest,
  spendAdmission: TurnSpendAdmission,
): Promise<AgentTurnResponse> {
  const surface = req.surface ?? 'system';
  // Absent = 'machine'. Opt-OUT by default: a caller gains the ability to halt
  // the fleet only by declaring `origin: 'human_chat'` (see `TurnOrigin`).
  const origin: TurnOrigin = req.origin ?? 'machine';

  // Emergency kill phrase: typed by a PERSON in ANY chat surface (Telegram,
  // Slack — both send paths — and dashboard chat all share this path), it trips
  // the same panic freeze as the dashboard panic button (snapshot, then every
  // kill switch on). Checked before ANY other work so a runaway fleet can be
  // stopped from the nearest chat window, and before the frozen check so
  // re-typing the phrase still gets a state-honest confirmation instead of the
  // generic maintenance copy. The reply is static: no model call, no spend.
  //
  // WHY THE ORIGIN GATE. The phrase is a panic control for a HUMAN at a chat
  // window, which is exactly what `TurnRefusal`'s `kill_phrase` doc has always
  // said it was. Machine-originated text is not that, and one such path now
  // carries text a remote party controls: the Paperclip dispatch worker feeds a
  // board issue's title and body straight into `userText`
  // (`dispatch-worker.ts` -> `dispatchUserText`). Honouring the phrase there
  // gives an issue the power to halt the WHOLE FLEET, and the halt confirmation
  // is then posted back to the board — an oracle telling whoever planted the
  // text that the phrase is valid. The same reasoning covers the other machine
  // callers (scheduled prompts, `ask_agent` delegations, the canary): none of
  // them is a person in a panic, and none has any business tripping an all-stop
  // from prompt text.
  //
  // WAR ROOM TRANSCRIPTS ARE MACHINE TEXT — BUT A PERSON STILL TYPED SOMETHING.
  // A room turn's `userText` is an assembled multi-speaker transcript
  // (`buildContextPrompt`), whose latest line IS what a person just typed. It
  // stays 'machine' here on purpose: the same blob also carries AGENTS' replies
  // and older turns, so honouring the phrase on it would let an agent halt the
  // fleet and would re-halt from a stale line on every later round. The human's
  // panic control is not lost — it is checked one step EARLIER, on the raw
  // message, at the two War Room entry points (Telegram and the dashboard) via
  // `src/lib/warroom/kill-phrase.ts`, which calls `engageEmergencyHalt` for the
  // identical freeze and the identical confirmation.
  //
  // The chat surfaces are NOT excluded, and must never be: they are the whole
  // reason the control exists. Their five call sites — Telegram, both Slack
  // send paths, and the dashboard chat console's streamed and non-streamed
  // routes — declare `origin: 'human_chat'` and behave exactly as before.
  //
  // This does not narrow the MATCH (`matchesKillPhrase`, `MIN_KILL_PHRASE_LENGTH`
  // are untouched); it narrows WHO IS ASKING.
  if (origin === 'human_chat' && matchesKillPhrase(req.userText)) {
    const text = await engageEmergencyHalt({
      agentId: req.agentId,
      chatId: req.chatId,
      surface,
    });
    if (req.onChunk) req.onChunk(text);
    return {
      text,
      modelId: '',
      costUsd: 0,
      latencyMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      toolCallCount: 0,
      // NOT retryable: the halt is the intended outcome of this exact input.
      // Replaying the phrase re-halts the fleet; it never gets an answer.
      refusal: { kind: 'kill_phrase', retryable: false },
    };
  }

  // Sessions frozen: short-circuit the turn before any Bedrock work. This is a
  // maintenance freeze that blocks new agent turns from being processed. The
  // switch check fails open internally (isKillSwitchActive returns inactive on
  // DDB error), so a transient DDB blip never bricks turn processing.
  const frozen = await isKillSwitchActive('sessions_frozen');
  if (frozen.active) {
    void writeAudit({
      action: 'kill_switch_blocked',
      agentId: req.agentId,
      chatId: req.chatId,
      surface,
      detail: { switch: 'sessions_frozen', reason: frozen.reason },
      result: 'blocked',
    });
    const refusal =
      'Sessions are temporarily frozen for maintenance. Your message was not processed. Please try again shortly.';
    if (req.onChunk) req.onChunk(refusal);
    return {
      text: refusal,
      modelId: '',
      costUsd: 0,
      latencyMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      toolCallCount: 0,
      // Retryable: a maintenance freeze is lifted by an operator, and the very
      // same turn resubmitted afterwards runs normally.
      refusal: { kind: 'sessions_frozen', retryable: true },
    };
  }

  // Per-identity rate limit. Consume one token from the caller's window before
  // any Bedrock work. Enforcement is opt-in: checkAndConsume uses the explicit
  // policy (unconfigured -> unlimited) and fails open on DDB error, so this
  // never blocks traffic unless an operator has set a policy. Prefer the user
  // identity; fall back to the agent so system turns share an agent bucket.
  const rlIdentity = req.userId ? `user#${req.userId}` : `agent#${req.agentId}`;
  const rl = await checkAndConsume(rlIdentity).catch(() => ({
    allowed: true,
    remaining: 0,
    resetAt: 0,
  }));
  if (!rl.allowed) {
    void writeAudit({
      action: 'rate_limited',
      agentId: req.agentId,
      chatId: req.chatId,
      surface,
      detail: { identity: rlIdentity, resetAt: rl.resetAt },
      result: 'blocked',
    });
    const refusal =
      'You have reached the request rate limit. Please wait a moment and try again.';
    if (req.onChunk) req.onChunk(refusal);
    return {
      text: refusal,
      modelId: '',
      costUsd: 0,
      latencyMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      toolCallCount: 0,
      // Retryable: the window rolls over on its own (`rl.resetAt`), so the same
      // turn resubmitted after it can succeed with nothing else changed.
      refusal: { kind: 'rate_limited', retryable: true },
    };
  }

  const agent = await loadAgent(req.agentId);
  let modelId = req.modelOverride || agent.model || pickDefaultModel(process.env);
  if (!modelId) {
    throw new Error('No Bedrock model configured');
  }
  // H2: a session that fell back stays on its fallback model (per-process
  // affinity, no oscillation). The initial stream below may move modelId
  // further down the chain when the affinity model itself is throttled
  // before emitting any chunk.
  modelId = getAffinityModel(req.agentId, req.chatId, modelId);
  const guardrailId = process.env.BEDROCK_GUARDRAIL_ID;
  const guardrailVersion = process.env.BEDROCK_GUARDRAIL_VERSION ?? 'DRAFT';
  const rawStreamMode = await getConfig('bedrock', 'guardrail_stream_mode').catch(() => undefined);
  const streamMode = typeof rawStreamMode === 'string' && rawStreamMode.trim().toLowerCase() === 'sync' ? 'sync' : 'async';

  // Global kill switch check — short-circuits before we burn any Bedrock spend.
  const killed = await isKillSwitchActive('bedrock_global');
  if (killed.active) {
    void writeAudit({
      action: 'kill_switch_blocked',
      agentId: req.agentId,
      chatId: req.chatId,
      surface,
      detail: { switch: 'bedrock_global', reason: killed.reason },
      result: 'blocked',
    });
    throw new KillSwitchActiveError(killed.reason ?? 'no reason given', 'bedrock_global');
  }

  // Daily cost cap: admission (legacy strict counter OR the atomic spend
  // ledger) already happened in runAgentTurn before this body ran; blocked
  // turns never reach here. This body's only cap duty is settling actuals at
  // the two spend-completion points below.

  // Tool-use kill switch: bedrock still runs but no tools attached.
  // tool_dispatch_disabled is the granular alias — either one disables tools.
  const [toolsKilled, dispatchKilled] = await Promise.all([
    isKillSwitchActive('tool_use'),
    isKillSwitchActive('tool_dispatch_disabled'),
  ]);
  // MCP tools (AgentCore gateways / remote MCP servers) ride the same kill
  // switches as built-ins. mcpToolsFor fails soft to [] so an unreachable
  // gateway can never block a turn.
  const rawToolList: BedrockTool[] =
    toolsKilled.active || dispatchKilled.active
      ? []
      : [...tools.listFor(req.agentId), ...(await mcpToolsFor(req.agentId))];
  // Per-turn blocklist (the War Room's tool policy). Stripping the spec keeps
  // the model from planning around a tool it can't call; the dispatch gate in
  // the tool loop backstops it.
  const blockedToolNames = new Set(req.blockedTools ?? []);
  const toolList =
    blockedToolNames.size > 0
      ? rawToolList.filter((t) => !blockedToolNames.has(t.toolSpec?.name ?? ''))
      : rawToolList;

  // Guardrail kill switch OR a per-turn skip (War Room): drop the configured
  // guardrail. req.skipGuardrail is scoped to this one turn, so it never
  // weakens the guardrail on any other surface.
  const guardrailKilled = await isKillSwitchActive('guardrail_disabled');
  const effectiveGuardrailId =
    guardrailKilled.active || req.skipGuardrail ? undefined : guardrailId;
  // Cross-surface legibility: only fires when the history actually mixes
  // surfaces (i.e. an owner-aliased/claimed principal), so the flag default-on
  // costs nothing for everyone else. sessions/cross_surface_note_enabled=0
  // kills it fleet-wide in ≤30s.
  const crossSurfaceNote =
    (await getConfig('sessions', 'cross_surface_note_enabled').catch(() => undefined)) !== '0'
      ? buildCrossSurfaceNote(req.history, req.surface)
      : undefined;
  const systemPromptWithMemories = await buildSystemPrompt(
    req.agentId,
    req.chatId,
    agent.systemPrompt,
    req.systemNote,
    crossSurfaceNote,
  );

  logger.info(
    {
      agentId: req.agentId,
      chatId: req.chatId,
      modelId,
      historyLen: req.history.length,
      tools: toolList.length,
      prompt: truncateForLog(req.userText, 80),
    },
    'agent turn started',
  );

  // Phase A: streamed first call (no tool dispatch yet — streaming +
  // tool-use simultaneously is awkward to handle). If the model wants
  // to use a tool, we resend non-streaming with the same context and
  // dispatch from there.
  const t0 = Date.now();
  const userContent = buildUserContent(req.userText, req.attachments);
  // Scrub guardrail-blocked exchanges (legacy sessions persisted them) so one
  // tripped message can never poison every turn after it.
  const cleanHistory = stripBlockedTurns(req.history);
  const messages: Message[] = [
    ...turnsToMessages(cleanHistory),
    { role: 'user', content: userContent },
  ];

  // Resolved ONCE per turn, then reused by the initial call and every tool
  // round, so a mid-turn config change cannot make rounds disagree.
  const turnMaxTokens = await resolveTurnMaxTokens();

  // Streaming egress guard: redact block-severity secrets out of every live
  // chunk before it reaches the client, so a streamed reply can't show a secret
  // before the post-hoc scan would have caught it. Built once per turn (one
  // config read) and reused for the initial stream, tool-loop re-emits, the
  // synthesis emit below, and the tool inputs and results the surface is shown.
  // Passthrough when nobody watches, the guard is off, or no block patterns.
  // The chunk callback itself is attached ONLY when req.onChunk is set (H2: a
  // turn nobody watches keeps its mid-stream fallback).
  let lastEmitted = '';
  let partialText = '';
  let toolInputChars = 0;
  let emitModelChunk: ((text: string) => void) | undefined;
  const streamCallbacks: ConverseStreamCallbacks = {
    onToolInput: (chars) => { toolInputChars = chars; },
  };
  const redact = req.onChunk || req.onToolEvent || req.onToolResult
    ? await buildStreamingRedactor()
    : (text: string): string => text;
  if (req.onChunk) {
    emitModelChunk = (text: string): void => {
      partialText = text;
      lastEmitted = redact(text);
      req.onChunk?.(lastEmitted);
    };
    streamCallbacks.onChunk = emitModelChunk;
  }
  let totalIn = 0;
  let totalOut = 0;
  let totalCacheRead = 0;
  let totalCacheWrite = 0;
  let toolCallCount = 0;
  // The call in flight, for the estimate a Stop settles with; nothing between calls.
  let inFlight: { inputTokens: number; streamed: boolean } | undefined;
  const checkStopped = (): void => {
    if (req.abortSignal?.aborted) throw Object.assign(new Error('Turn stopped'), { name: 'AbortError' });
  };
  const modelCall = async <T>(
    sent: { messages: Message[]; tools?: BedrockTool[]; streamed?: boolean },
    call: () => Promise<T>,
  ): Promise<T | undefined> => {
    if (req.abortSignal?.aborted) return undefined;
    inFlight = {
      inputTokens: callInputEstimate(modelId, systemPromptWithMemories, sent.messages, sent.tools ?? []),
      streamed: sent.streamed ?? false,
    };
    partialText = '';
    toolInputChars = 0;
    try {
      const result = await call();
      // A stream the SDK ended quietly after a Stop (HTTP/2) returns with no
      // usage: treated exactly like a thrown abort, estimate included.
      if (req.abortSignal?.aborted) return undefined;
      inFlight = undefined;
      return result;
    } catch (err) {
      if (req.abortSignal?.aborted || (err as { name?: string })?.name === 'AbortError') return undefined;
      throw err;
    }
  };
  const stoppedTurn = async (): Promise<AgentTurnResponse> => {
    // The cut call was billed too: its input in full, and its output at what it
    // streamed — or, for a call that shows nothing while it runs, at its ceiling.
    if (inFlight) {
      totalIn += inFlight.inputTokens;
      totalOut += inFlight.streamed ? Math.ceil((partialText.length + toolInputChars) / 4) : turnMaxTokens;
    }
    const costUsd = turnCost(modelId, totalIn, totalOut, totalCacheRead, totalCacheWrite);
    const latencyMs = Date.now() - t0;
    const usage = {
      agentId: req.agentId, chatId: req.chatId, surface, modelId,
      inputTokens: totalIn, outputTokens: totalOut,
      cacheReadInputTokens: totalCacheRead, cacheWriteInputTokens: totalCacheWrite,
      costUsd, latencyMs, toolCallCount, ...(req.userId ? { userId: req.userId } : {}),
    };
    await recordUsage(usage);
    await spendAdmission.finalize({ costUsd, modelId, inputTokens: totalIn, outputTokens: totalOut });
    await writeAudit({
      ...usage, action: 'agent_turn', result: 'ok',
      detail: { stopped: true, toolCallCount, cacheReadInputTokens: totalCacheRead,
        cacheWriteInputTokens: totalCacheWrite, ...(req.runId ? { runId: req.runId } : {}) },
    });
    const text = lastEmitted ? await scanOutboundReply(lastEmitted, { agentId: req.agentId, chatId: req.chatId }) : '';
    return { text, stopped: true, modelId, costUsd, latencyMs, inputTokens: totalIn, outputTokens: totalOut, toolCallCount, blocked: false };
  };

  // The guardrail's synchronous mode holds the whole answer until it has been
  // checked, so the first call then shows no output while it runs and a Stop
  // counts its output at the ceiling, as for a tool round. Checking alongside
  // (async, the default) or with no guardrail attached, the text really
  // streams and a Stop counts what streamed.
  const guardrailHoldsStream =
    Boolean(effectiveGuardrailId && effectiveGuardrailId !== 'REPLACE_ME') && streamMode === 'sync';
  const initial = await modelCall({ messages, tools: toolList, streamed: !guardrailHoldsStream }, () => converseStreamTurnWithFallback(
    {
      modelId,
      abortSignal: req.abortSignal,
      systemPrompt: systemPromptWithMemories,
      userText: req.userText,
      userContent,
      history: turnsToMessages(cleanHistory),
      maxTokens: turnMaxTokens,
      guardrail:
        effectiveGuardrailId && effectiveGuardrailId !== 'REPLACE_ME'
          ? { id: effectiveGuardrailId, version: guardrailVersion, streamMode }
          : undefined,
      tools: toolList.length > 0 ? toolList : undefined,
    },
    streamCallbacks,
    { agentId: req.agentId, chatId: req.chatId },
  ));
  if (!initial) return stoppedTurn();
  // The wrapper may have fallen back pre-chunk; keep the tool loop, cost
  // records and audits on the model that actually answered.
  modelId = initial.modelId;
  totalIn = initial.inputTokens;
  totalOut = initial.outputTokens;
  totalCacheRead = initial.cacheReadInputTokens;
  totalCacheWrite = initial.cacheWriteInputTokens;
  if (req.abortSignal?.aborted) return stoppedTurn();

  // If the stream stopped naturally without tool use, we're done.
  if (initial.stopReason !== 'tool_use') {
    const latencyMs = Date.now() - t0;
    logger.info(
      {
        agentId: req.agentId,
        chatId: req.chatId,
        modelId,
        inputTokens: initial.inputTokens,
        outputTokens: initial.outputTokens,
        costUsd: initial.costUsd,
        latencyMs,
        stopReason: initial.stopReason,
      },
      'agent turn complete',
    );
    void recordUsage({
      agentId: req.agentId,
      chatId: req.chatId,
      surface,
      modelId: initial.modelId,
      inputTokens: initial.inputTokens,
      outputTokens: initial.outputTokens,
      cacheReadInputTokens: initial.cacheReadInputTokens,
      cacheWriteInputTokens: initial.cacheWriteInputTokens,
      costUsd: initial.costUsd,
      latencyMs,
      toolCallCount: 0,
      ...(req.userId ? { userId: req.userId } : {}),
    });
    // Settle the spend admission with actuals (moves reserved→spent on the
    // ledger when armed; writes per-seat attribution either way).
    void spendAdmission.finalize({
      costUsd: initial.costUsd,
      modelId: initial.modelId,
      inputTokens: initial.inputTokens,
      outputTokens: initial.outputTokens,
    });
    void writeAudit({
      action: 'agent_turn',
      agentId: req.agentId,
      chatId: req.chatId,
      surface,
      modelId: initial.modelId,
      inputTokens: initial.inputTokens,
      outputTokens: initial.outputTokens,
      costUsd: initial.costUsd,
      latencyMs,
      detail: {
        cacheReadInputTokens: initial.cacheReadInputTokens,
        cacheWriteInputTokens: initial.cacheWriteInputTokens,
        ...(req.runId ? { runId: req.runId } : {}),
      },
      ...(req.userId ? { userId: req.userId } : {}),
      result: 'ok',
    });
    const wasBlocked = isGuardrailBlock(initial.stopReason);
    const safeText = wasBlocked
      ? GUARDRAIL_BLOCK_NOTICE
      : await scanOutboundReply(initial.text, {
          agentId: req.agentId,
          chatId: req.chatId,
        });
    return {
      // Never return empty: a stored empty turn makes Bedrock reject every
      // later request in this chat. `max_tokens` with no text is the reply
      // that got cut off mid-tool-call, so say that rather than "(no
      // response)" — it is the one case the person can actually act on.
      text: safeText || truncatedNotice(initial.stopReason),
      modelId: initial.modelId,
      costUsd: initial.costUsd,
      latencyMs,
      inputTokens: initial.inputTokens,
      outputTokens: initial.outputTokens,
      toolCallCount: 0,
      blocked: wasBlocked,
    };
  }

  // Tool-use path: re-issue non-streaming so we get back the full
  // content blocks and can dispatch tools. Each tool result extends
  // the messages array; loop until end_turn or limit.
  logger.info(
    { agentId: req.agentId, chatId: req.chatId },
    'tool-use detected, switching to non-streaming dispatch',
  );

  let lastText = '';
  let lastStopReason = 'unknown';
  // Binary artifacts (generated images) tools produce; delivered natively by
  // the surface after the text reply. Capped to keep delivery bounded.
  const turnMedia: ToolMedia[] = [];
  const MAX_TURN_MEDIA = 4;

  const cacheEnabled = process.env.CCE_PROMPT_CACHE !== '0';
  const cachedSystem = cacheEnabled
    ? [{ text: systemPromptWithMemories }, { cachePoint: { type: 'default' as const } }]
    : [{ text: systemPromptWithMemories }];
  const cachedTools =
    toolList.length > 0
      ? {
          toolConfig: {
            tools: cacheEnabled
              ? [...toolList, { cachePoint: { type: 'default' as const } }]
              : toolList,
          },
        }
      : {};

  // Resolve a synthetic "-1m" id to the base model + context-1m beta once for
  // the whole tool loop (the initial streaming turn resolved it the same way).
  const invocation = resolveModelInvocation(modelId);
  for (let turn = 0; turn < TOOL_TURN_LIMIT; turn++) {
    // Hard stop: re-check bedrock_global before every tool-loop model call so a
    // mid-loop pause halts paid calls, not just the start-of-turn check.
    if (req.abortSignal?.aborted) return stoppedTurn();
    await assertBedrockAllowed();
    // withRetry gives the tool-loop rounds the same throttle/timeout backoff
    // as the initial streamed call; without it, one transient error mid-loop
    // discarded every tool result the turn had already paid for.
    const resp = await modelCall({ messages, tools: toolList }, () => withRetry(invocation.modelId, 3, () => {
      checkStopped();
      return bedrockClient().send(
        new ConverseCommand({
          modelId: invocation.modelId,
          system: cachedSystem,
          messages,
          // Drop temperature for models that deprecated it (the initial
          // converseStreamTurn already learned this and recorded the model), so
          // the tool-dispatch turns don't re-trip the ValidationException.
          inferenceConfig: modelRejectsTemperature(modelId)
            ? { maxTokens: turnMaxTokens }
            : { maxTokens: turnMaxTokens, temperature: 0.7 },
          ...(invocation.anthropicBeta
            ? { additionalModelRequestFields: { anthropic_beta: invocation.anthropicBeta } }
            : {}),
          ...cachedTools,
          ...(effectiveGuardrailId && effectiveGuardrailId !== 'REPLACE_ME'
            ? {
                guardrailConfig: {
                  guardrailIdentifier: effectiveGuardrailId,
                  guardrailVersion,
                },
              }
            : {}),
        }),
        ...(req.abortSignal ? [{ abortSignal: req.abortSignal }] : []),
      );
    }));

    if (!resp) return stoppedTurn();
    totalIn += resp.usage?.inputTokens ?? 0;
    totalOut += resp.usage?.outputTokens ?? 0;
    totalCacheRead += resp.usage?.cacheReadInputTokens ?? 0;
    totalCacheWrite += resp.usage?.cacheWriteInputTokens ?? 0;

    if (req.abortSignal?.aborted) return stoppedTurn();
    lastStopReason = resp.stopReason ?? 'unknown';
    const assistantContent: ContentBlock[] = resp.output?.message?.content ?? [];
    messages.push({ role: 'assistant', content: assistantContent });

    const textBlocks = assistantContent
      .filter((b): b is { text: string } => 'text' in b)
      .map((b) => b.text);
    lastText = textBlocks.join('').trim();
    if (emitModelChunk && lastText) emitModelChunk(lastText);

    const toolUses = assistantContent.filter(
      (b): b is { toolUse: ToolUseBlock } => 'toolUse' in b,
    );
    if (toolUses.length === 0 || resp.stopReason !== 'tool_use') {
      break;
    }

    // Re-check the tool kill switches each round: the spec list was frozen at
    // turn start, so without this an operator tripping tool_use mid-incident
    // left every in-flight turn dispatching for up to the full loop budget
    // (on top of the 30s cache-poll propagation).
    const [toolsKilledNow, dispatchKilledNow] = await Promise.all([
      isKillSwitchActive('tool_use'),
      isKillSwitchActive('tool_dispatch_disabled'),
    ]);
    const dispatchKilledMidTurn = toolsKilledNow.active || dispatchKilledNow.active;

    const toolResults: ContentBlock[] = [];
    for (const block of toolUses) {
      if (req.abortSignal?.aborted) return stoppedTurn();
      toolCallCount++;
      const tu = block.toolUse;
      const args = (tu.input as Record<string, unknown> | undefined) ?? {};
      logger.info(
        { agentId: req.agentId, chatId: req.chatId, tool: tu.name, args },
        'invoking tool',
      );
      try {
        // callIndex is 0-based per the onToolEvent contract; toolCallCount was
        // just incremented to the 1-based ordinal, so subtract 1. Emitting the
        // 1-based value here was the off-by-one that made every surface render
        // the first tool as "(step 2)". The arguments pass the same redactor as
        // the reply before the cap, so a secret is never shown, capped or not.
        const input = redact(JSON.stringify(args));
        req.onToolEvent?.({ name: tu.name ?? '', callIndex: toolCallCount - 1, toolUseId: tu.toolUseId ?? '',
          input: input.slice(0, TOOL_INPUT_CAP), inputTruncated: input.length > TOOL_INPUT_CAP });
      } catch {
        // Status callbacks are best-effort; a surface bug must not kill the turn.
      }
      const toolCtx = {
        agentId: req.agentId,
        chatId: req.chatId,
        ...(req.userId ? { userId: req.userId } : {}),
        ...(req.surface ? { surface: req.surface } : {}),
        ...(req.runId ? { runId: req.runId } : {}),
        ...(req.replyChatId ? { replyChatId: req.replyChatId } : {}),
        ...(req.boardAgentId ? { boardAgentId: req.boardAgentId } : {}),
        ...(req.delegationDepth !== undefined ? { delegationDepth: req.delegationDepth } : {}),
      };
      if (req.abortSignal?.aborted) return stoppedTurn();
      const result: ToolResult = dispatchKilledMidTurn
        ? {
            text: 'Tool use was disabled by a kill switch mid-turn; the call was not executed.',
            isError: true,
          }
        : blockedToolNames.has(tu.name ?? '')
          ? {
              text: `Tool '${tu.name}' is blocked by this room's tool policy.`,
              isError: true,
            }
          : isMcpToolName(tu.name ?? '')
            ? await invokeMcpTool(tu.name ?? '', args, toolCtx)
            : await tools.invoke(tu.name ?? '', args, toolCtx);
      try {
        req.onToolResult?.({ name: tu.name ?? '', callIndex: toolCallCount - 1, toolUseId: tu.toolUseId ?? '',
          ...toolResultForDisplay(tu.name ?? '', result, redact), isError: !!result.isError });
      } catch {
        // Status callbacks are best-effort; a surface bug must not kill the turn.
      }
      if (result.media?.length) {
        turnMedia.push(...result.media.slice(0, MAX_TURN_MEDIA - turnMedia.length));
      }
      toolResults.push({
        toolResult: {
          toolUseId: tu.toolUseId ?? '',
          content: [{ text: result.text }],
          status: result.isError ? 'error' : 'success',
        },
      });
    }
    messages.push({ role: 'user', content: toolResults });
  }

  // If we exhausted the tool-turn budget while the model was still calling
  // tools (lastStopReason === 'tool_use') and never produced prose, the data is
  // sitting in the messages array but the user would get "(no response)". Do
  // ONE final synthesis call with NO tools so the model must answer in words
  // from what it already gathered. This is the difference between "(no
  // response)" and a real answer when an agent fumbles a few tool calls.
  if (req.abortSignal?.aborted) return stoppedTurn();
  if (!lastText && lastStopReason === 'tool_use') {
    try {
      await assertBedrockAllowed();
      // A budget-exhausted loop always ends on the user-role toolResult batch,
      // and Converse requires strict user/assistant alternation. The synthesis
      // instruction therefore rides inside that final user message; appending
      // it as a second consecutive user turn made this call throw
      // ValidationException, i.e. "(no response)" in exactly the case this
      // fallback exists to prevent.
      const instruction = {
        text: 'Answer my last request now, in words, using what you found above. Do not call any more tools.',
      };
      const tail = messages[messages.length - 1];
      const synthMessages =
        tail?.role === 'user'
          ? [
              ...messages.slice(0, -1),
              { role: 'user' as const, content: [...(tail.content ?? []), instruction] },
            ]
          : [...messages, { role: 'user' as const, content: [instruction] }];
      const synth = await modelCall({ messages: synthMessages }, () => withRetry(invocation.modelId, 3, () => {
        checkStopped();
        return bedrockClient().send(
          new ConverseCommand({
            modelId: invocation.modelId,
            system: cachedSystem,
            messages: synthMessages,
            inferenceConfig: modelRejectsTemperature(modelId)
              ? { maxTokens: turnMaxTokens }
              : { maxTokens: turnMaxTokens, temperature: 0.7 },
            ...(invocation.anthropicBeta
              ? { additionalModelRequestFields: { anthropic_beta: invocation.anthropicBeta } }
              : {}),
            ...(effectiveGuardrailId && effectiveGuardrailId !== 'REPLACE_ME'
              ? { guardrailConfig: { guardrailIdentifier: effectiveGuardrailId, guardrailVersion } }
              : {}),
          }),
          ...(req.abortSignal ? [{ abortSignal: req.abortSignal }] : []),
        );
      }));
      if (!synth) return stoppedTurn();
      totalIn += synth.usage?.inputTokens ?? 0;
      totalOut += synth.usage?.outputTokens ?? 0;
      totalCacheRead += synth.usage?.cacheReadInputTokens ?? 0;
      totalCacheWrite += synth.usage?.cacheWriteInputTokens ?? 0;
      if (req.abortSignal?.aborted) return stoppedTurn();
      const synthText = (synth.output?.message?.content ?? [])
        .filter((b): b is { text: string } => 'text' in b)
        .map((b) => b.text)
        .join('')
        .trim();
      if (synthText) {
        lastText = synthText;
        if (emitModelChunk) emitModelChunk(synthText);
        logger.info(
          { agentId: req.agentId, chatId: req.chatId, toolCallCount },
          'forced synthesis after tool-budget exhaustion',
        );
      }
    } catch (err) {
      if (req.abortSignal?.aborted || (err as { name?: string })?.name === 'AbortError') return stoppedTurn();
      logger.warn(
        { agentId: req.agentId, chatId: req.chatId, err: err instanceof Error ? err.message : String(err) },
        'forced-synthesis call failed; falling back to placeholder text',
      );
    }
  }

  if (req.abortSignal?.aborted) return stoppedTurn();

  // Same reasoning as the non-tool return: never empty, and on `max_tokens`
  // say the reply was cut off rather than "(no response)". This is the path a
  // document request actually takes, so it is the one that most needs to
  // explain itself.
  const finalText = lastText || truncatedNotice(lastStopReason);
  const costUsd = turnCost(modelId, totalIn, totalOut, totalCacheRead, totalCacheWrite);
  const latencyMs = Date.now() - t0;

  logger.info(
    {
      agentId: req.agentId,
      chatId: req.chatId,
      modelId,
      inputTokens: totalIn,
      outputTokens: totalOut,
      cacheReadInputTokens: totalCacheRead,
      cacheWriteInputTokens: totalCacheWrite,
      toolCallCount,
      costUsd,
      latencyMs,
    },
    'agent turn complete (with tools)',
  );
  void recordUsage({
    agentId: req.agentId,
    chatId: req.chatId,
    surface,
    modelId,
    inputTokens: totalIn,
    outputTokens: totalOut,
    cacheReadInputTokens: totalCacheRead,
    cacheWriteInputTokens: totalCacheWrite,
    costUsd,
    latencyMs,
    toolCallCount,
    ...(req.userId ? { userId: req.userId } : {}),
  });
  // Settle the spend admission with the tool-loop totals.
  void spendAdmission.finalize({
    costUsd,
    modelId,
    inputTokens: totalIn,
    outputTokens: totalOut,
  });
  void writeAudit({
    action: 'agent_turn',
    agentId: req.agentId,
    chatId: req.chatId,
    surface,
    modelId,
    inputTokens: totalIn,
    outputTokens: totalOut,
    costUsd,
    latencyMs,
    detail: {
      toolCallCount,
      cacheReadInputTokens: totalCacheRead,
      cacheWriteInputTokens: totalCacheWrite,
      ...(req.runId ? { runId: req.runId } : {}),
    },
    ...(req.userId ? { userId: req.userId } : {}),
    result: 'ok',
  });

  const wasBlocked = isGuardrailBlock(lastStopReason);
  const safeText = wasBlocked
    ? GUARDRAIL_BLOCK_NOTICE
    : await scanOutboundReply(finalText, {
        agentId: req.agentId,
        chatId: req.chatId,
      });

  return {
    text: safeText,
    modelId,
    costUsd,
    latencyMs,
    inputTokens: totalIn,
    outputTokens: totalOut,
    toolCallCount,
    blocked: wasBlocked,
    // Suppress media delivery on guardrail-blocked turns.
    ...(turnMedia.length > 0 && !wasBlocked ? { media: turnMedia } : {}),
  };
}
