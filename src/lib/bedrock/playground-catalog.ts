/**
 * Model Playground catalog.
 *
 * The Chat tab lets an agent answer on any Anthropic model. The Playground is
 * a separate, raw "send one prompt to many models side by side" surface so you
 * can compare how different Bedrock models respond — Anthropic AND the
 * non-Anthropic families AWS now serves on-demand in us-east-1 (OpenAI gpt-oss,
 * DeepSeek, Qwen, Kimi, Llama, Mistral, Nova).
 *
 * Why a curated static list (vs the live catalog used elsewhere):
 *   - Scope, not permissions. The ECS task role holds
 *     bedrock:ListFoundationModels and bedrock:ListInferenceProfiles
 *     (infra/lib/iam-stack.ts:207-208), but the raw catalog is ~120 entries
 *     including image/embedding/audio models; curating keeps the picker to the
 *     chat-capable models worth comparing.
 *   - Every id below was verified present + ON_DEMAND + streaming in us-east-1.
 * A model the account lacks access to still LISTS here; the run endpoint just
 * surfaces that model's AccessDenied in its own result column (one prompt,
 * many models, each succeeds or fails independently).
 *
 * Pricing: Anthropic prices come from the verified KNOWN_PRICING table
 * (resolveModel). For the non-Anthropic families we do NOT ship a USD figure
 * rather than risk a wrong one — the Playground shows accurate input/output
 * token counts and latency for every model, and USD only where we can stand
 * behind the number. Add a price below to light up USD for that model.
 */

import { FALLBACK_PRICE } from './capabilities.js';
import { listAvailableModels, resolveModel } from './models.js';

export interface PlaygroundModel {
  /** Bedrock modelId or inference-profile id to invoke. */
  id: string;
  /** Provider family, used to group the picker. */
  provider: string;
  /** Display name. */
  name: string;
  /** USD per 1M input tokens, when we have a verified price. */
  inputPricePer1M?: number;
  /** USD per 1M output tokens, when we have a verified price. */
  outputPricePer1M?: number;
}

// Friendly names for the env-driven Anthropic labels listAvailableModels emits.
const ANTHROPIC_NAMES: Record<string, string> = {
  opus: 'Claude Opus',
  'opus-1m': 'Claude Opus (1M)',
  sonnet: 'Claude Sonnet',
  'sonnet-1m': 'Claude Sonnet (1M)',
  haiku: 'Claude Haiku',
  default: 'Claude (default)',
};

// Non-Anthropic chat models verified ON_DEMAND + streaming in us-east-1.
// No price fields → the UI shows token counts only (honest over guessing).
const NON_ANTHROPIC: readonly PlaygroundModel[] = [
  { id: 'openai.gpt-oss-120b-1:0', provider: 'OpenAI', name: 'GPT-OSS 120B' },
  { id: 'openai.gpt-oss-20b-1:0', provider: 'OpenAI', name: 'GPT-OSS 20B' },
  { id: 'deepseek.v3.2', provider: 'DeepSeek', name: 'DeepSeek V3.2' },
  { id: 'qwen.qwen3-coder-next', provider: 'Qwen', name: 'Qwen3 Coder Next' },
  { id: 'qwen.qwen3-next-80b-a3b', provider: 'Qwen', name: 'Qwen3 Next 80B' },
  { id: 'qwen.qwen3-32b-v1:0', provider: 'Qwen', name: 'Qwen3 32B' },
  { id: 'moonshotai.kimi-k2.5', provider: 'Moonshot', name: 'Kimi K2.5' },
  { id: 'moonshot.kimi-k2-thinking', provider: 'Moonshot', name: 'Kimi K2 Thinking' },
  { id: 'meta.llama3-70b-instruct-v1:0', provider: 'Meta', name: 'Llama 3 70B' },
  { id: 'meta.llama3-8b-instruct-v1:0', provider: 'Meta', name: 'Llama 3 8B' },
  { id: 'mistral.mistral-large-3-675b-instruct', provider: 'Mistral', name: 'Mistral Large 3' },
  { id: 'mistral.magistral-small-2509', provider: 'Mistral', name: 'Magistral Small' },
  { id: 'mistral.mixtral-8x7b-instruct-v0:1', provider: 'Mistral', name: 'Mixtral 8x7B' },
  { id: 'amazon.nova-pro-v1:0', provider: 'Amazon', name: 'Nova Pro' },
  { id: 'amazon.nova-lite-v1:0', provider: 'Amazon', name: 'Nova Lite' },
  { id: 'amazon.nova-micro-v1:0', provider: 'Amazon', name: 'Nova Micro' },
];

/**
 * The full Playground model list: the deploy's configured Anthropic models
 * (priced) first, then the curated non-Anthropic families. Anthropic entries
 * use the env inference-profile ids (the only ids invocable for Claude 4 in
 * this account), so the list is env-aware — a family missing its BEDROCK_*
 * env var simply doesn't appear.
 */
export function listPlaygroundModels(env: NodeJS.ProcessEnv): PlaygroundModel[] {
  const anthropic = listAvailableModels(env).map((m): PlaygroundModel => {
    const spec = resolveModel(m.id);
    return {
      id: m.id,
      provider: 'Anthropic',
      name: ANTHROPIC_NAMES[m.label] ?? `Claude (${m.label})`,
      inputPricePer1M: spec.inputPricePer1M,
      outputPricePer1M: spec.outputPricePer1M,
    };
  });
  return [...anthropic, ...NON_ANTHROPIC];
}

/**
 * USD for one Playground turn, or null when we have no verified price for the
 * model (the UI then shows token counts only). Plain input/output pricing —
 * the Playground never uses prompt caching, so there are no cache tiers.
 */
export function playgroundCost(
  model: PlaygroundModel,
  inputTokens: number,
  outputTokens: number,
): number | null {
  if (model.inputPricePer1M === undefined || model.outputPricePer1M === undefined) {
    return null;
  }
  return (
    (inputTokens / 1_000_000) * model.inputPricePer1M +
    (outputTokens / 1_000_000) * model.outputPricePer1M
  );
}

/**
 * USD for one Playground turn for CAP METERING. Returns the verified price when
 * known, otherwise a conservative fallback so an unpriced model still counts
 * toward the daily cost cap (it must never record as zero and stay invisible).
 * Use playgroundCost() for the UI, which honestly shows null when unpriced; use
 * this only when recording spend that gates the cap.
 */
export function playgroundMeteredCost(
  model: PlaygroundModel,
  inputTokens: number,
  outputTokens: number,
): number {
  const verified = playgroundCost(model, inputTokens, outputTokens);
  if (verified !== null) return verified;
  // Conservative per-1M fallback used only for cap metering. It is above the
  // priciest known tier, so an unpriced call is over-counted rather than invisible.
  return (
    (inputTokens / 1_000_000) * FALLBACK_PRICE.inputPer1M +
    (outputTokens / 1_000_000) * FALLBACK_PRICE.outputPer1M
  );
}
