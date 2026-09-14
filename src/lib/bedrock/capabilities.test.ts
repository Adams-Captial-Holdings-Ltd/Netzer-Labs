/**
 * Executable specification for the capability registry and its seed data (WI-1).
 *
 * Covers AM-05 (documented defaults and seeds) and the registry half of AM-13
 * (every non-Claude row carries a source; Claude prices are the KNOWN_PRICING
 * ones). The MODEL_SEEDS checks are structural so they keep running against the
 * real rows the coordinator generates from the AWS model cards and the AWS public price list.
 */
import { describe, it, expect } from 'vitest';
import {
  FALLBACK_PRICE,
  UNKNOWN_MODEL_DEFAULTS,
  canonicalModelId,
  resolveCapabilities,
  type ModelCapabilities,
  type ModelSeed,
} from './capabilities.js';
import { MODEL_SEEDS } from './model-seeds.js';
import { KNOWN_PRICING, resolveModel } from './models.js';

const AWS_DOCS = 'https://docs.aws.amazon.com/';
/** AWS's public Price List offer files: the source for models whose card lists no price. */
const AWS_PRICE_LIST = 'https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/';
const providerOf = (prefix: string): string => prefix.slice(0, prefix.indexOf('.'));

/** A seed row built on the documented defaults, for injected-seed tests. */
function seed(prefix: string, over: Partial<ModelSeed> = {}): ModelSeed {
  return {
    ...UNKNOWN_MODEL_DEFAULTS,
    provider: providerOf(prefix),
    prefix,
    name: prefix,
    cardUrl: `${AWS_DOCS}bedrock/latest/userguide/model-cards.html`,
    ...over,
  };
}

describe('FALLBACK_PRICE and UNKNOWN_MODEL_DEFAULTS (AM-05, AM-13)', () => {
  it('the fallback price is $25 / $80 per 1M with source "fallback"', () => {
    expect(FALLBACK_PRICE).toEqual({ inputPer1M: 25, outputPer1M: 80, source: 'fallback' });
  });

  it('unknown-model defaults are exactly as documented', () => {
    expect(UNKNOWN_MODEL_DEFAULTS).toEqual({
      provider: 'unknown',
      tools: 'unknown',
      streamingTools: false,
      system: true,
      images: false,
      documents: false,
      promptCache: { system: false, messages: false, tools: false },
      guardrails: 'unknown',
      reasoning: 'strip',
      maxOutputTokens: 4096,
      contextWindow: 128_000,
      price: FALLBACK_PRICE,
    });
  });
});

describe('canonicalModelId', () => {
  it('strips one leading geo prefix', () => {
    expect(canonicalModelId('us.anthropic.claude-sonnet-4-6')).toBe('anthropic.claude-sonnet-4-6');
    expect(canonicalModelId('eu.anthropic.claude-haiku-4-5')).toBe('anthropic.claude-haiku-4-5');
    expect(canonicalModelId('apac.amazon.nova-pro-v1:0')).toBe('amazon.nova-pro-v1:0');
    expect(canonicalModelId('global.openai.gpt-oss-120b-1:0')).toBe('openai.gpt-oss-120b-1:0');
  });

  it('strips the synthetic -1m suffix, with or without a geo prefix', () => {
    expect(canonicalModelId('us.anthropic.claude-sonnet-4-6-1m')).toBe('anthropic.claude-sonnet-4-6');
    expect(canonicalModelId('anthropic.claude-opus-4-7-1m')).toBe('anthropic.claude-opus-4-7');
  });

  it('leaves every other id alone', () => {
    for (const id of [
      'anthropic.claude-sonnet-4-6',
      'openai.gpt-oss-120b-1:0',
      'moonshotai.kimi-k2.5',
      'usa.vendor.model-v1:0', // not a geo prefix
      'meta.llama3-70b-instruct-v1:0',
    ]) {
      expect(canonicalModelId(id), id).toBe(id);
    }
  });
});

describe('resolveCapabilities', () => {
  it('returns the documented defaults for an unknown id', () => {
    expect(resolveCapabilities('vendor.model-that-does-not-exist-v9:0')).toEqual(UNKNOWN_MODEL_DEFAULTS);
    expect(resolveCapabilities('us.vendor.model-that-does-not-exist-1m')).toEqual(UNKNOWN_MODEL_DEFAULTS);
  });

  it('matches the longest canonical prefix (injected seeds)', () => {
    const seeds: ModelSeed[] = [
      seed('openai.gpt-oss', { maxOutputTokens: 1000 }),
      seed('openai.gpt-oss-120b-1:0', { maxOutputTokens: 2000 }),
    ];
    expect(resolveCapabilities('us.openai.gpt-oss-120b-1:0', seeds).maxOutputTokens).toBe(2000);
    expect(resolveCapabilities('openai.gpt-oss-120b-1:0', seeds).maxOutputTokens).toBe(2000);
    expect(resolveCapabilities('openai.gpt-oss-20b-1:0', seeds).maxOutputTokens).toBe(1000);
    expect(resolveCapabilities('openai.gpt-5.6-sol', seeds)).toEqual(UNKNOWN_MODEL_DEFAULTS);
  });

  it('returns capabilities only, never the seed row fields', () => {
    const seeds: ModelSeed[] = [seed('vendor.model', { name: 'Vendor Model', eulaUrl: 'https://vendor.example/eula' })];
    const caps = resolveCapabilities('vendor.model-v1:0', seeds);
    expect(Object.keys(caps).sort()).toEqual(Object.keys(UNKNOWN_MODEL_DEFAULTS).sort());
    expect(caps.provider).toBe('vendor');
  });

  it('seeds Claude with its real Converse capabilities and the KNOWN_PRICING prices', () => {
    const claude: Partial<ModelCapabilities> = {
      provider: 'anthropic',
      tools: 'yes',
      streamingTools: true,
      system: true,
      images: true,
      documents: true,
      promptCache: { system: true, messages: true, tools: true },
      guardrails: 'yes',
      reasoning: 'preserve',
      contextWindow: 200_000,
    };
    for (const id of ['us.anthropic.claude-sonnet-4-6', 'us.anthropic.claude-sonnet-4-6-1m', 'eu.anthropic.claude-sonnet-4-6']) {
      const caps = resolveCapabilities(id);
      expect(caps, id).toMatchObject(claude);
      expect(caps.price, id).toMatchObject({ inputPer1M: 3, outputPer1M: 15, cacheReadPer1M: 0.3, cacheWritePer1M: 3.75 });
      expect(caps.price.source, id).not.toBe('fallback');
    }
    const opus = resolveCapabilities('us.anthropic.claude-opus-4-7');
    expect(opus).toMatchObject(claude);
    expect(opus.price).toMatchObject({ inputPer1M: 15, outputPer1M: 75, cacheReadPer1M: 1.5, cacheWritePer1M: 18.75 });
    const haiku = resolveCapabilities('us.anthropic.claude-haiku-4-5');
    expect(haiku).toMatchObject(claude);
    expect(haiku.price).toMatchObject({ inputPer1M: 0.8, outputPer1M: 4, cacheReadPer1M: 0.08, cacheWritePer1M: 1.0 });
  });
});

describe('MODEL_SEEDS: structural checks on the generated rows (AM-05, AM-13)', () => {
  it('has Anthropic and non-Anthropic rows', () => {
    expect(MODEL_SEEDS.some((r) => r.provider === 'anthropic')).toBe(true);
    expect(MODEL_SEEDS.some((r) => r.provider !== 'anthropic')).toBe(true);
  });

  it('prefixes are unique, canonical and provider-consistent; every row names its card', () => {
    const prefixes = MODEL_SEEDS.map((r) => r.prefix);
    expect(new Set(prefixes).size).toBe(prefixes.length);
    for (const row of MODEL_SEEDS) {
      expect(row.prefix, row.prefix).toMatch(/^[a-z0-9-]+\.\S+$/);
      expect(canonicalModelId(row.prefix), row.prefix).toBe(row.prefix);
      expect(row.provider, row.prefix).toBe(providerOf(row.prefix));
      expect(row.name.trim().length, row.prefix).toBeGreaterThan(0);
      expect(row.cardUrl.startsWith(AWS_DOCS), `${row.prefix} cardUrl=${row.cardUrl}`).toBe(true);
      if (row.eulaUrl !== undefined) expect(row.eulaUrl, row.prefix).toMatch(/^https:\/\//);
    }
  });

  it('prices are finite, non-negative and sourced; non-Anthropic sources are AWS docs or AWS Price List URLs', () => {
    for (const row of MODEL_SEEDS) {
      const p = row.price;
      for (const v of [p.inputPer1M, p.outputPer1M, p.cacheReadPer1M, p.cacheWritePer1M]) {
        if (v === undefined) continue;
        expect(Number.isFinite(v), row.prefix).toBe(true);
        expect(v, row.prefix).toBeGreaterThanOrEqual(0);
      }
      expect(p.source.length, row.prefix).toBeGreaterThan(0);
      if (p.source === 'fallback') {
        // An estimated price is the fallback and nothing else.
        expect({ inputPer1M: p.inputPer1M, outputPer1M: p.outputPer1M }, row.prefix).toEqual({
          inputPer1M: FALLBACK_PRICE.inputPer1M,
          outputPer1M: FALLBACK_PRICE.outputPer1M,
        });
      } else {
        expect(p.source, row.prefix).toMatch(/^https:\/\//);
        if (row.provider !== 'anthropic') {
          const awsSource = p.source.startsWith(AWS_DOCS) || p.source.startsWith(AWS_PRICE_LIST);
          expect(awsSource, `${row.prefix} source=${p.source}`).toBe(true);
        }
      }
    }
  });

  it('limits are positive integers with maxOutputTokens <= contextWindow', () => {
    for (const row of MODEL_SEEDS) {
      expect(Number.isInteger(row.maxOutputTokens), row.prefix).toBe(true);
      expect(Number.isInteger(row.contextWindow), row.prefix).toBe(true);
      expect(row.maxOutputTokens, row.prefix).toBeGreaterThan(0);
      expect(row.contextWindow, row.prefix).toBeGreaterThan(0);
      expect(row.maxOutputTokens, row.prefix).toBeLessThanOrEqual(row.contextWindow);
    }
  });

  it('enumerations hold and reasoning follows the provider (Anthropic preserved, others stripped)', () => {
    for (const row of MODEL_SEEDS) {
      expect(['yes', 'no', 'unknown'], row.prefix).toContain(row.tools);
      expect(['yes', 'no', 'unknown'], row.prefix).toContain(row.guardrails);
      expect(['preserve', 'strip'], row.prefix).toContain(row.reasoning);
      for (const flag of [row.streamingTools, row.system, row.images, row.documents, row.promptCache.system, row.promptCache.messages, row.promptCache.tools]) {
        expect(typeof flag, row.prefix).toBe('boolean');
      }
      expect(row.reasoning, row.prefix).toBe(row.provider === 'anthropic' ? 'preserve' : 'strip');
    }
  });
});

describe('registry and models.ts agree (AM-13)', () => {
  it('every non-Anthropic seed prices resolveModel, bare and geo-prefixed', () => {
    const rows = MODEL_SEEDS.filter((r) => r.provider !== 'anthropic');
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      for (const id of [row.prefix, `us.${row.prefix}`]) {
        const spec = resolveModel(id);
        expect(spec.inputPricePer1M, id).toBe(row.price.inputPer1M);
        expect(spec.outputPricePer1M, id).toBe(row.price.outputPer1M);
        // Absent cache tiers bill as plain input (the conservative direction).
        expect(spec.cacheReadPricePer1M, id).toBe(row.price.cacheReadPer1M ?? row.price.inputPer1M);
        expect(spec.cacheWritePricePer1M, id).toBe(row.price.cacheWritePer1M ?? row.price.inputPer1M);
        expect(spec.priceSource, id).toBe(row.price.source);
        expect(spec.contextWindow, id).toBe(row.contextWindow);
        expect(spec.provider, id).toBe(row.provider);
      }
    }
  });

  it('Anthropic classic-family seeds carry the KNOWN_PRICING numbers and the 200K base window', () => {
    const rows = MODEL_SEEDS.filter((r) => r.provider === 'anthropic' && /opus|sonnet|haiku/.test(r.prefix));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const family = /opus/.test(row.prefix) ? 'opus' : /sonnet/.test(row.prefix) ? 'sonnet' : 'haiku';
      const known = KNOWN_PRICING[family];
      expect(row.price.inputPer1M, row.prefix).toBe(known.inputPricePer1M);
      expect(row.price.outputPer1M, row.prefix).toBe(known.outputPricePer1M);
      expect(row.price.cacheReadPer1M, row.prefix).toBe(known.cacheReadPricePer1M);
      expect(row.price.cacheWritePer1M, row.prefix).toBe(known.cacheWritePricePer1M);
      expect(row.contextWindow, row.prefix).toBe(200_000);
    }
  });
});
