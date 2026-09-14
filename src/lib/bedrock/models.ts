/**
 * Model registry. Resolves the configured model id and pricing.
 *
 * Model ids come from env vars set at deploy time. At session-3 the env
 * is populated by `scripts/setup.ts` calling `ListInferenceProfiles` and
 * picking the latest version of each family (Opus, Sonnet, Haiku).
 *
 * If you ever need to swap models without redeploying, edit Secrets
 * Manager or env directly and roll the Fargate service.
 */

import { canonicalModelId, resolveCapabilities } from './capabilities.js';

export interface ModelSpec {
  id: string;
  family: string;
  provider: string;
  priceSource: string;
  inputPricePer1M: number; // USD — uncached input
  outputPricePer1M: number; // USD
  /** Cache write (5-min TTL): 1.25x input on Anthropic / Bedrock. */
  cacheWritePricePer1M: number;
  /** Cache read: 0.10x input (a 90% discount). */
  cacheReadPricePer1M: number;
  contextWindow: number; // tokens
}

export const KNOWN_PRICING: Record<string, Omit<ModelSpec, 'id' | 'provider' | 'priceSource'>> = {
  opus: {
    family: 'opus',
    inputPricePer1M: 15,
    outputPricePer1M: 75,
    cacheWritePricePer1M: 18.75,
    cacheReadPricePer1M: 1.5,
    contextWindow: 200_000,
  },
  'opus-1m': {
    family: 'opus',
    inputPricePer1M: 15,
    outputPricePer1M: 75,
    cacheWritePricePer1M: 18.75,
    cacheReadPricePer1M: 1.5,
    contextWindow: 1_000_000,
  },
  sonnet: {
    family: 'sonnet',
    inputPricePer1M: 3,
    outputPricePer1M: 15,
    cacheWritePricePer1M: 3.75,
    cacheReadPricePer1M: 0.3,
    contextWindow: 200_000,
  },
  'sonnet-1m': {
    family: 'sonnet',
    inputPricePer1M: 3,
    outputPricePer1M: 15,
    cacheWritePricePer1M: 3.75,
    cacheReadPricePer1M: 0.3,
    contextWindow: 1_000_000,
  },
  haiku: {
    family: 'haiku',
    inputPricePer1M: 0.8,
    outputPricePer1M: 4,
    cacheWritePricePer1M: 1.0,
    cacheReadPricePer1M: 0.08,
    contextWindow: 200_000,
  },
};

function pricingKeyFromId(modelId: string): string | undefined {
  const is1m = /1m/i.test(modelId) || /1000k/i.test(modelId);
  if (/opus/i.test(modelId)) return is1m ? 'opus-1m' : 'opus';
  if (/sonnet/i.test(modelId)) return is1m ? 'sonnet-1m' : 'sonnet';
  if (/haiku/i.test(modelId)) return 'haiku';
  return undefined;
}

export function resolveModel(modelId: string): ModelSpec {
  const key = pricingKeyFromId(modelId);
  if (key) {
    const pricing = KNOWN_PRICING[key];
    return {
      id: modelId,
      ...pricing,
      provider: 'anthropic',
      priceSource: 'https://aws.amazon.com/bedrock/pricing/',
    };
  }

  const canonicalId = canonicalModelId(modelId);
  const capabilities = resolveCapabilities(canonicalId);
  const { price } = capabilities;
  const provider = canonicalId.split('.', 1)[0] ?? canonicalId;
  return {
    id: modelId,
    family: provider,
    provider,
    priceSource: price.source,
    inputPricePer1M: price.inputPer1M,
    outputPricePer1M: price.outputPer1M,
    cacheReadPricePer1M: price.cacheReadPer1M ?? price.inputPer1M,
    cacheWritePricePer1M: price.cacheWritePer1M ?? price.inputPer1M,
    contextWindow: capabilities.contextWindow,
  };
}

// ── 1M context ─────────────────────────────────────────────────────
// Bedrock has NO separate "1M" model id. The 1M context window is the base
// model invoked with the `context-1m` beta flag (verified: Bedrock rejects an
// unknown beta, accepts this one). Our env exposes 1M as a synthetic selection
// id = base id + "-1m" suffix (e.g. us.anthropic.claude-sonnet-4-6-1m) with no
// real model behind it — that's why selecting it used to ValidationException.
// We keep the synthetic id as the catalog/override key (so 1M is distinguishable
// from the base) and resolve it to (base id + beta) only at the Bedrock call.
export const CONTEXT_1M_BETA = 'context-1m-2025-08-07';

// Families verified to accept the context-1m beta on Bedrock. A misconfigured
// "-1m" env for any other family (e.g. haiku) is unusable and gets hidden.
const CONTEXT_1M_FAMILIES = new Set<ModelSpec['family']>(['opus', 'sonnet']);

/** A synthetic "-1m" selection id (base model + context-1m beta). */
export function is1mModelId(modelId: string): boolean {
  return modelId.endsWith('-1m');
}

/** Whether a "-1m" id is actually usable: its base family must support 1M. */
export function is1mSupported(modelId: string): boolean {
  if (!is1mModelId(modelId)) return false;
  return CONTEXT_1M_FAMILIES.has(resolveModel(modelId.slice(0, -3)).family);
}

/**
 * Resolve a catalog model id to its real Bedrock invocation. A synthetic "-1m"
 * id becomes the base id plus the context-1m beta; everything else is
 * unchanged. Call this at the Bedrock boundary (buildParams + the agent loop's
 * own ConverseCommand) so 1M selections actually engage the larger window.
 */
export function resolveModelInvocation(modelId: string): { modelId: string; anthropicBeta?: string[] } {
  if (is1mModelId(modelId)) {
    return { modelId: modelId.slice(0, -3), anthropicBeta: [CONTEXT_1M_BETA] };
  }
  return { modelId };
}

/** All model IDs available from env, keyed by a human-friendly label. */
export function listAvailableModels(env: NodeJS.ProcessEnv): Array<{ label: string; id: string; contextWindow: number }> {
  const models: Array<{ label: string; id: string; contextWindow: number }> = [];
  if (env.BEDROCK_OPUS_MODEL) models.push({ label: 'opus', id: env.BEDROCK_OPUS_MODEL, contextWindow: 200_000 });
  if (env.BEDROCK_OPUS_1M_MODEL) models.push({ label: 'opus-1m', id: env.BEDROCK_OPUS_1M_MODEL, contextWindow: 1_000_000 });
  if (env.BEDROCK_SONNET_MODEL) models.push({ label: 'sonnet', id: env.BEDROCK_SONNET_MODEL, contextWindow: 200_000 });
  if (env.BEDROCK_SONNET_1M_MODEL) models.push({ label: 'sonnet-1m', id: env.BEDROCK_SONNET_1M_MODEL, contextWindow: 1_000_000 });
  if (env.BEDROCK_HAIKU_MODEL) models.push({ label: 'haiku', id: env.BEDROCK_HAIKU_MODEL, contextWindow: 200_000 });
  if (env.BEDROCK_DEFAULT_MODEL && !models.find(m => m.id === env.BEDROCK_DEFAULT_MODEL)) {
    const spec = resolveModel(env.BEDROCK_DEFAULT_MODEL);
    models.unshift({ label: 'default', id: env.BEDROCK_DEFAULT_MODEL, contextWindow: spec.contextWindow });
  }
  // Never surface a "-1m" model whose family can't actually do 1M — it would be
  // a guaranteed ValidationException. Supported 1M ids (opus/sonnet) stay and
  // are resolved to base+beta at invoke time.
  return models.filter((m) => !is1mModelId(m.id) || is1mSupported(m.id));
}

export function pickDefaultModel(env: NodeJS.ProcessEnv): string {
  return (
    env.BEDROCK_DEFAULT_MODEL ??
    env.BEDROCK_SONNET_MODEL ??
    env.BEDROCK_OPUS_MODEL ??
    env.BEDROCK_HAIKU_MODEL ??
    ''
  );
}

/**
 * Compute USD cost for a single turn.
 *
 * Bedrock reports cache-read and cache-write tokens separately from
 * `inputTokens`. When both are zero, we fall back to plain input
 * pricing (older callsites and any non-cached path keep working).
 */
export function turnCost(
  modelId: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadInputTokens = 0,
  cacheWriteInputTokens = 0,
): number {
  const m = resolveModel(modelId);
  return (
    (inputTokens / 1_000_000) * m.inputPricePer1M +
    (outputTokens / 1_000_000) * m.outputPricePer1M +
    (cacheReadInputTokens / 1_000_000) * m.cacheReadPricePer1M +
    (cacheWriteInputTokens / 1_000_000) * m.cacheWritePricePer1M
  );
}

/**
 * Nova 2 Sonic pricing — per TOKEN, split by speech vs text (verified
 * JARVIS-PLAN.md §1c, NOT the audio-seconds model). USD per 1K tokens.
 */
export const NOVA_SONIC_PRICING = {
  speechInputPer1K: 0.0034,
  speechOutputPer1K: 0.0136,
  textInputPer1K: 0.00006,
  textOutputPer1K: 0.00024,
} as const;

/** USD cost for one Nova Sonic turn, reusing the per-token cost path. */
export function novaSonicTurnCost(
  speechInTokens: number,
  speechOutTokens: number,
  textInTokens: number,
  textOutTokens: number,
): number {
  return (
    (speechInTokens / 1000) * NOVA_SONIC_PRICING.speechInputPer1K +
    (speechOutTokens / 1000) * NOVA_SONIC_PRICING.speechOutputPer1K +
    (textInTokens / 1000) * NOVA_SONIC_PRICING.textInputPer1K +
    (textOutTokens / 1000) * NOVA_SONIC_PRICING.textOutputPer1K
  );
}
