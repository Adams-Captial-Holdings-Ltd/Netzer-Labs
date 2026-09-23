/**
 * Bedrock Runtime client wrapper.
 *
 * Exposes:
 *   - converseTurn: single-shot, returns final text + usage
 *   - converseStreamTurn: streams text deltas via callback, returns final stats
 *
 * Cross-region inference profiles work transparently. Retry on
 * ThrottlingException + ServiceUnavailableException + ModelNotReady.
 * Tool use: each request carries the tool catalog (BedrockTool[]), but the
 * multi-round toolUse dispatch loop lives in the agent loop
 * (src/agent/agent-loop.ts), not here — this wrapper only issues one Converse /
 * ConverseStream call and returns the model's blocks + usage.
 */

import {
  BedrockRuntimeClient,
  ConverseCommand,
  ConverseStreamCommand,
  type ContentBlock,
  type ConverseCommandInput,
  type ConverseCommandOutput,
  type Message,
  type SystemContentBlock,
  type Tool as BedrockTool,
} from '@aws-sdk/client-bedrock-runtime';
import { logger } from '../../observability/logger.js';
import { turnCost, resolveModelInvocation } from './models.js';
import { captureAwsClient } from '../observability/xray.js';
import { maybeThrowSyntheticBedrock } from '../safety/fault-injector.js';
import { assertBedrockAllowed } from './guard.js';

const region = process.env.AWS_REGION ?? 'us-east-1';

let _client: BedrockRuntimeClient | null = null;
export function bedrockClient(): BedrockRuntimeClient {
  if (!_client) _client = captureAwsClient(new BedrockRuntimeClient({ region }));
  return _client;
}

export interface ConverseTurnInput {
  modelId: string;
  abortSignal?: AbortSignal;
  systemPrompt: string;
  userText: string;
  /**
   * Optional pre-built user content blocks. When set, takes precedence
   * over `userText` — used for multimodal turns (image + text + PDF).
   */
  userContent?: ContentBlock[];
  /** Previous turns in the conversation (most-recent-last). */
  history?: Message[];
  maxTokens?: number;
  temperature?: number;
  /** Optional Bedrock Guardrail. Off when guardrail.id is empty or 'REPLACE_ME'. */
  guardrail?: { id: string; version: string; streamMode?: 'sync' | 'async' };
  /** Retry budget. Default 3. */
  maxRetries?: number;
  /** Optional tool config. When set, Bedrock may emit toolUse blocks. */
  tools?: BedrockTool[];
  /**
   * Skip the Anthropic-only `cachePoint` blocks. Non-Anthropic models
   * (gpt-oss, deepseek, qwen, …) reject cachePoint with a ValidationException,
   * so the Model Playground sets this to keep the Converse call cross-provider.
   * Caching is pointless for one-shot Playground turns anyway.
   */
  disableCache?: boolean;
  /**
   * Skip the `temperature` inference param. Some newer models (e.g. Claude
   * Opus 4.7) deprecated it and reject the request when it's present. The
   * Playground sets this so every model answers on its own default. The agent
   * path doesn't set it — instead it self-heals (see modelRejectsTemperature).
   */
  omitTemperature?: boolean;
}

export interface ConverseTurnOutput {
  text: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  /** Tokens read from the prompt cache (billed at the cache-read rate). */
  cacheReadInputTokens: number;
  /** Tokens written to the prompt cache (billed at the cache-write rate). */
  cacheWriteInputTokens: number;
  costUsd: number;
  stopReason: string;
  latencyMs: number;
}

export interface ConverseStreamCallbacks {
  /** Called with cumulative text after each chunk. */
  onChunk?: (cumulativeText: string) => void;
}

// ── Temperature self-heal ──────────────────────────────────────────
// Some models (e.g. us.anthropic.claude-opus-4-7) deprecated the `temperature`
// inference param and reject any request that sets it
// (ValidationException: "`temperature` is deprecated for this model"). We can't
// know which models do this up front, so the converse calls below learn it at
// runtime: on that specific error they record the model here, drop temperature,
// and retry. buildParams and the agent loop's own dispatch both consult this so
// the model never gets temperature again this process. Models that DO accept
// temperature keep the deliberate 0.7 (agent determinism).
const temperatureRejectingModels = new Set<string>();
export function modelRejectsTemperature(modelId: string): boolean {
  return temperatureRejectingModels.has(modelId);
}
function isTemperatureRejection(err: unknown): boolean {
  const name = (err as { name?: string }).name ?? '';
  const msg = err instanceof Error ? err.message : String(err);
  return name === 'ValidationException' && /temperature/i.test(msg);
}

// Prompt caching is enabled by default. Set CCE_PROMPT_CACHE=0 to disable.
// Bedrock requires the cached prefix to be at least 1024 tokens for
// Sonnet/Opus and 2048 for Haiku, otherwise the cache point is silently
// ignored (and you just pay regular input pricing — no harm done).
const CACHE_ENABLED = process.env.CCE_PROMPT_CACHE !== '0';

// ── Fallback chain ─────────────────────────────────────────────────
// When a model is throttled or unavailable, try the next model in the
// chain: Opus -> Sonnet -> Haiku. Per-agent session affinity means
// that once a session falls back, it stays on the fallback model for
// the rest of that session (avoids oscillation).

export function isFallbackTrigger(err: unknown): boolean {
  const name = (err as { name?: string }).name ?? '';
  return name === 'ThrottlingException' || name === 'ServiceUnavailableException';
}

export function buildFallbackChain(primaryModelId: string): string[] {
  const env = process.env;
  const opus = env.BEDROCK_OPUS_MODEL ?? '';
  const sonnet = env.BEDROCK_SONNET_MODEL ?? env.BEDROCK_DEFAULT_MODEL ?? '';
  const haiku = env.BEDROCK_HAIKU_MODEL ?? '';
  const all = [opus, sonnet, haiku].filter(Boolean);
  const idx = all.indexOf(primaryModelId);
  if (idx < 0) return [primaryModelId, ...all.filter((m) => m !== primaryModelId)];
  return all.slice(idx);
}

const sessionAffinity = new Map<string, string>();

export function getAffinityModel(agentId: string, chatId: string, primaryModelId: string): string {
  const key = `${agentId}:${chatId}`;
  return sessionAffinity.get(key) ?? primaryModelId;
}

export function setAffinityModel(agentId: string, chatId: string, modelId: string): void {
  sessionAffinity.set(`${agentId}:${chatId}`, modelId);
}

export function clearAffinityModel(agentId: string, chatId: string): void {
  sessionAffinity.delete(`${agentId}:${chatId}`);
}

/** Session identity for the fallback chain's affinity map. */
export interface FallbackSession {
  agentId: string;
  chatId: string;
}

/**
 * H2: the fallback chain, WIRED (it was dead code since the review).
 * Streaming-safe by construction: a fallback is attempted ONLY when the
 * failed attempt emitted ZERO chunks — once any delta reached the caller,
 * a mid-stream failure propagates unchanged, because chunks already shown
 * to the user cannot be un-emitted and a silent model switch mid-reply
 * would splice two different answers together.
 *
 * Starts from the session's affinity model (a session that fell back stays
 * on the fallback model so it does not oscillate; affinity is per-process
 * and clears on task restart). Only throttle/unavailability errors
 * (isFallbackTrigger) trigger the walk — validation/guardrail/auth errors
 * propagate immediately.
 *
 * `streamFn` is injectable so tests drive the chain without SDK stream
 * mocks; production callers omit it.
 */
export async function converseStreamTurnWithFallback(
  input: ConverseTurnInput,
  callbacks: ConverseStreamCallbacks,
  session: FallbackSession,
  streamFn: typeof converseStreamTurn = converseStreamTurn,
): Promise<ConverseTurnOutput> {
  const primary = input.modelId;
  const start = getAffinityModel(session.agentId, session.chatId, primary);
  const chain = buildFallbackChain(start);
  let lastErr: unknown = undefined;
  for (let i = 0; i < chain.length; i++) {
    const modelId = chain[i];
    let emitted = 0;
    const guarded: ConverseStreamCallbacks = {
      ...(callbacks.onChunk
        ? {
            onChunk: (cumulativeText: string) => {
              emitted += 1;
              callbacks.onChunk!(cumulativeText);
            },
          }
        : {}),
    };
    try {
      const out = await streamFn({ ...input, modelId }, guarded);
      if (modelId !== primary) {
        setAffinityModel(session.agentId, session.chatId, modelId);
      }
      return out;
    } catch (err) {
      if (input.abortSignal?.aborted || (err as { name?: string })?.name === 'AbortError') throw err;
      const next = chain[i + 1];
      if (!isFallbackTrigger(err) || emitted > 0 || !next) throw err;
      lastErr = err;
      logger.warn(
        { from: modelId, to: next, agentId: session.agentId },
        'model throttled/unavailable before any chunk; falling back',
      );
    }
  }
  // Unreachable: the loop either returned or threw on the last element.
  throw lastErr instanceof Error ? lastErr : new Error('fallback chain exhausted');
}

function buildParams(input: ConverseTurnInput): ConverseCommandInput {
  const userContent =
    input.userContent && input.userContent.length > 0
      ? input.userContent
      : [{ text: input.userText }];
  const messages: Message[] = [
    ...(input.history ?? []),
    { role: 'user', content: userContent },
  ];

  // Caching is on by default, but a caller can force it off per-turn
  // (input.disableCache) — non-Anthropic Converse models reject cachePoint
  // blocks outright, so the cross-provider Playground path opts out.
  const cacheOn = CACHE_ENABLED && !input.disableCache;

  // System content: text first, cachePoint last so Bedrock caches the
  // whole system prompt. The cache point is a no-op block — it just
  // marks the boundary. The runtime SDK accepts it via the same
  // SystemContentBlock union.
  const system: SystemContentBlock[] = input.systemPrompt
    ? cacheOn
      ? [{ text: input.systemPrompt }, { cachePoint: { type: 'default' } }]
      : [{ text: input.systemPrompt }]
    : [];

  // Tool defs: cache point after the last tool. Tool schemas often
  // dominate the input bill, so this is the highest-leverage cache.
  const toolConfigParam =
    input.tools && input.tools.length > 0
      ? {
          toolConfig: {
            tools: cacheOn
              ? [...input.tools, { cachePoint: { type: 'default' as const } }]
              : input.tools,
          },
        }
      : {};

  // Include temperature unless the caller opted out or this model has rejected
  // it before. Omitting it lets the model use its own default (the only safe
  // choice for models that deprecated the param).
  const includeTemperature = !input.omitTemperature && !temperatureRejectingModels.has(input.modelId);
  // Resolve a synthetic "-1m" id to the real base model + the context-1m beta.
  // Non-1M ids pass through unchanged.
  const invocation = resolveModelInvocation(input.modelId);
  const params: ConverseCommandInput = {
    modelId: invocation.modelId,
    system,
    messages,
    inferenceConfig: {
      maxTokens: input.maxTokens ?? 1024,
      ...(includeTemperature ? { temperature: input.temperature ?? 0.7 } : {}),
    },
    ...toolConfigParam,
    ...(invocation.anthropicBeta
      ? { additionalModelRequestFields: { anthropic_beta: invocation.anthropicBeta } }
      : {}),
  };
  if (input.guardrail && input.guardrail.id && input.guardrail.id !== 'REPLACE_ME') {
    params.guardrailConfig = {
      guardrailIdentifier: input.guardrail.id,
      guardrailVersion: input.guardrail.version,
    };
  }
  return params;
}

function isRetryable(name: string): boolean {
  return (
    name === 'ThrottlingException' ||
    name === 'ServiceUnavailableException' ||
    name === 'ModelNotReadyException' ||
    name === 'ModelTimeoutException'
  );
}

export async function withRetry<T>(
  modelId: string,
  maxRetries: number,
  op: () => Promise<T>,
): Promise<T> {
  await maybeThrowSyntheticBedrock(modelId);
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    // Hard stop re-checked before EVERY attempt (initial + retries) so a
    // bedrock_global flip during a throttle/timeout backoff or the
    // temperature-rejection retry stops the next paid send. Thrown here, outside
    // the try, so a deliberate kill does not surface as a "bedrock call failed".
    await assertBedrockAllowed();
    try {
      return await op();
    } catch (err) {
      lastErr = err;
      const name = (err as { name?: string }).name ?? '';
      if (!isRetryable(name) || attempt === maxRetries - 1) {
        logger.error(
          {
            modelId,
            errName: name,
            attempt,
            errMessage: err instanceof Error ? err.message : String(err),
          },
          'bedrock call failed',
        );
        throw err;
      }
      const wait = 500 * Math.pow(2, attempt);
      logger.warn({ modelId, errName: name, attempt, wait }, 'bedrock retry');
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

export async function converseTurn(input: ConverseTurnInput): Promise<ConverseTurnOutput> {
  // Hard stop: no paid Bedrock call when bedrock_global is active. Checked once
  // per turn here (not inside withRetry) so a deliberate kill does not surface as
  // a retried "bedrock call failed" error in the logs/alarms.
  await assertBedrockAllowed();
  const maxRetries = input.maxRetries ?? 3;
  const t0 = Date.now();

  const sendConverse = (command: ConverseCommand) => {
    input.abortSignal?.throwIfAborted();
    return input.abortSignal
      ? bedrockClient().send(command, { abortSignal: input.abortSignal })
      : bedrockClient().send(command);
  };
  let out: ConverseCommandOutput;
  try {
    out = await withRetry<ConverseCommandOutput>(
      input.modelId,
      maxRetries,
      () => sendConverse(new ConverseCommand(buildParams(input))),
    );
  } catch (err) {
    if (input.abortSignal?.aborted || (err as { name?: string })?.name === 'AbortError') throw err;
    // First time a model rejects `temperature`, remember it and retry without —
    // buildParams now omits it for this model for the rest of the process.
    if (isTemperatureRejection(err) && !temperatureRejectingModels.has(input.modelId)) {
      temperatureRejectingModels.add(input.modelId);
      logger.warn({ modelId: input.modelId }, 'model rejected temperature; retrying without it');
      out = await withRetry<ConverseCommandOutput>(
        input.modelId,
        maxRetries,
        () => sendConverse(new ConverseCommand(buildParams(input))),
      );
    } else {
      throw err;
    }
  }
  const blocks = out.output?.message?.content ?? [];
  const text = blocks
    .map((b) => ('text' in b ? b.text ?? '' : ''))
    .join('')
    .trim();
  const inputTokens = out.usage?.inputTokens ?? 0;
  const outputTokens = out.usage?.outputTokens ?? 0;
  const cacheReadInputTokens = out.usage?.cacheReadInputTokens ?? 0;
  const cacheWriteInputTokens = out.usage?.cacheWriteInputTokens ?? 0;
  return {
    text,
    modelId: input.modelId,
    inputTokens,
    outputTokens,
    cacheReadInputTokens,
    cacheWriteInputTokens,
    costUsd: turnCost(
      input.modelId,
      inputTokens,
      outputTokens,
      cacheReadInputTokens,
      cacheWriteInputTokens,
    ),
    stopReason: out.stopReason ?? 'unknown',
    latencyMs: Date.now() - t0,
  };
}

/**
 * Local-emulator escape hatch for ConverseStream.
 *
 * Gated on AWS_ENDPOINT_URL, which is set ONLY by local development and the
 * integration suite. Nothing in infra/, buildspec.yml, the Dockerfile or the
 * deploy scripts ever sets it, so this branch cannot execute against real AWS
 * and the deployed streaming path is byte-for-byte unchanged.
 *
 * Why it is needed: the local emulator answers ConverseStream with HTTP 501
 * UnsupportedOperationException. That name matches neither isRetryable() nor
 * isFallbackTrigger(), so without this every agent turn dies on its very first
 * model call and no chat surface can be exercised locally at all.
 */
function isLocalUnsupportedStream(err: unknown): boolean {
  if (!process.env.AWS_ENDPOINT_URL) return false;
  const name = (err as { name?: string })?.name ?? '';
  const msg = err instanceof Error ? err.message : String(err);
  return /UnsupportedOperation|UnknownOperation|NotImplemented|501/i.test(`${name} ${msg}`);
}

export async function converseStreamTurn(
  input: ConverseTurnInput,
  callbacks: ConverseStreamCallbacks = {},
): Promise<ConverseTurnOutput> {
  // Hard stop: no paid Bedrock call when bedrock_global is active.
  await assertBedrockAllowed();
  const maxRetries = input.maxRetries ?? 3;
  const t0 = Date.now();

  const sendStream = () => {
    input.abortSignal?.throwIfAborted();
    const params = buildParams(input);
    const command = new ConverseStreamCommand({
      ...params,
      ...(params.guardrailConfig && input.guardrail?.streamMode
        ? { guardrailConfig: { ...params.guardrailConfig, streamProcessingMode: input.guardrail.streamMode } }
        : {}),
    });
    return input.abortSignal
      ? bedrockClient().send(command, { abortSignal: input.abortSignal })
      : bedrockClient().send(command);
  };
  let stream;
  try {
    stream = await withRetry(input.modelId, maxRetries, sendStream);
  } catch (err) {
    if (input.abortSignal?.aborted || (err as { name?: string })?.name === 'AbortError') throw err;
    if (isTemperatureRejection(err) && !temperatureRejectingModels.has(input.modelId)) {
      temperatureRejectingModels.add(input.modelId);
      logger.warn({ modelId: input.modelId }, 'model rejected temperature; retrying without it');
      stream = await withRetry(input.modelId, maxRetries, sendStream);
    } else if (isLocalUnsupportedStream(err)) {
      // Replay the identical request as a single non-streaming Converse and
      // hand the whole body back through onChunk, so callers that render
      // deltas still receive one final delta and complete normally.
      logger.warn(
        { modelId: input.modelId },
        'local emulator does not implement ConverseStream; replaying as non-streaming Converse',
      );
      const out = await converseTurn(input);
      if (out.text) callbacks.onChunk?.(out.text);
      return out;
    } else {
      throw err;
    }
  }

  let text = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadInputTokens = 0;
  let cacheWriteInputTokens = 0;
  let stopReason = 'unknown';

  if (stream.stream) {
    for await (const event of stream.stream) {
      if (event.contentBlockDelta?.delta?.text) {
        text += event.contentBlockDelta.delta.text;
        callbacks.onChunk?.(text);
      }
      if (event.messageStop?.stopReason) {
        stopReason = event.messageStop.stopReason;
      }
      if (event.metadata?.usage) {
        inputTokens = event.metadata.usage.inputTokens ?? 0;
        outputTokens = event.metadata.usage.outputTokens ?? 0;
        // Bedrock omits cacheRead/Write fields entirely when caching is
        // not engaged. Default to 0 in that case. We keep emitting the
        // cachePoint blocks in buildParams so this becomes a free win the
        // moment AWS enables prompt caching for us.anthropic.claude-sonnet-4-6.
        cacheReadInputTokens = event.metadata.usage.cacheReadInputTokens ?? 0;
        cacheWriteInputTokens = event.metadata.usage.cacheWriteInputTokens ?? 0;
      }
    }
  }

  return {
    text: text.trim(),
    modelId: input.modelId,
    inputTokens,
    outputTokens,
    cacheReadInputTokens,
    cacheWriteInputTokens,
    costUsd: turnCost(
      input.modelId,
      inputTokens,
      outputTokens,
      cacheReadInputTokens,
      cacheWriteInputTokens,
    ),
    stopReason,
    latencyMs: Date.now() - t0,
  };
}
