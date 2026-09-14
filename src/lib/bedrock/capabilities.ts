import { MODEL_SEEDS } from './model-seeds.js';

export type YesNoUnknown = 'yes' | 'no' | 'unknown';

export interface ModelPrice {
  inputPer1M: number;
  outputPer1M: number;
  cacheReadPer1M?: number;
  cacheWritePer1M?: number;
  /** 'fallback' when estimated, otherwise an https:// URL the numbers were read from. */
  source: string;
}

export interface ModelCapabilities {
  provider: string;
  tools: YesNoUnknown;
  streamingTools: boolean;
  system: boolean;
  images: boolean;
  documents: boolean;
  promptCache: { system: boolean; messages: boolean; tools: boolean };
  guardrails: YesNoUnknown;
  reasoning: 'preserve' | 'strip';
  maxOutputTokens: number;
  contextWindow: number;
  price: ModelPrice;
}

/** One generated seed row from model-seeds.ts. */
export interface ModelSeed extends ModelCapabilities {
  prefix: string;
  name: string;
  cardUrl: string;
  eulaUrl?: string;
}

export const FALLBACK_PRICE: ModelPrice = Object.freeze({
  inputPer1M: 25,
  outputPer1M: 80,
  source: 'fallback',
});

export const UNKNOWN_MODEL_DEFAULTS: ModelCapabilities = Object.freeze({
  provider: 'unknown',
  tools: 'unknown',
  streamingTools: false,
  system: true,
  images: false,
  documents: false,
  promptCache: Object.freeze({ system: false, messages: false, tools: false }),
  guardrails: 'unknown',
  reasoning: 'strip',
  maxOutputTokens: 4096,
  contextWindow: 128_000,
  price: FALLBACK_PRICE,
});

export function canonicalModelId(id: string): string {
  return id.replace(/^(?:us|eu|apac|global)\./, '').replace(/-1m$/, '');
}

export function resolveCapabilities(
  id: string,
  seeds: readonly ModelSeed[] = MODEL_SEEDS,
): ModelCapabilities {
  const canonical = canonicalModelId(id);
  let match: ModelSeed | undefined;
  for (const seed of seeds) {
    if (canonical.startsWith(seed.prefix) && (!match || seed.prefix.length > match.prefix.length)) {
      match = seed;
    }
  }
  if (!match) return UNKNOWN_MODEL_DEFAULTS;

  return {
    provider: match.provider,
    tools: match.tools,
    streamingTools: match.streamingTools,
    system: match.system,
    images: match.images,
    documents: match.documents,
    promptCache: { ...match.promptCache },
    guardrails: match.guardrails,
    reasoning: match.reasoning,
    maxOutputTokens: match.maxOutputTokens,
    contextWindow: match.contextWindow,
    price: { ...match.price },
  };
}
