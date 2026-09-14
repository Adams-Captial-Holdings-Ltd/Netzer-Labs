/**
 * Executable specification for pricing through the registry (WI-1).
 *
 * Covers AM-13 (unknown ids are $25/$80, new Claude names never become Haiku,
 * existing Claude costs unchanged) and AM-16 (listAvailableModels unchanged),
 * plus the playground-catalog fallback-constant change. This file deliberately
 * imports only modules that already exist, so every failure here is an
 * assertion against current behaviour rather than a missing module.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { listAvailableModels, resolveModel, turnCost, type ModelSpec } from './models.js';
import { listPlaygroundModels, playgroundMeteredCost } from './playground-catalog.js';

const OPUS = 'us.anthropic.claude-opus-4-7';
const SONNET = 'us.anthropic.claude-sonnet-4-6';
const HAIKU = 'us.anthropic.claude-haiku-4-5';
const M = 1_000_000;

describe('listAvailableModels is unchanged (AM-16)', () => {
  it('returns the env Claude entries in the fixed label order with the fixed shape', () => {
    const env: NodeJS.ProcessEnv = {
      BEDROCK_OPUS_MODEL: OPUS,
      BEDROCK_OPUS_1M_MODEL: `${OPUS}-1m`,
      BEDROCK_SONNET_MODEL: SONNET,
      BEDROCK_SONNET_1M_MODEL: `${SONNET}-1m`,
      BEDROCK_HAIKU_MODEL: HAIKU,
      BEDROCK_DEFAULT_MODEL: SONNET, // already listed → no extra "default" entry
    };
    expect(listAvailableModels(env)).toEqual([
      { label: 'opus', id: OPUS, contextWindow: 200_000 },
      { label: 'opus-1m', id: `${OPUS}-1m`, contextWindow: 1_000_000 },
      { label: 'sonnet', id: SONNET, contextWindow: 200_000 },
      { label: 'sonnet-1m', id: `${SONNET}-1m`, contextWindow: 1_000_000 },
      { label: 'haiku', id: HAIKU, contextWindow: 200_000 },
    ]);
  });

  it('unshifts a distinct default with its resolved window and hides an unsupported -1m', () => {
    const env: NodeJS.ProcessEnv = {
      BEDROCK_DEFAULT_MODEL: `${OPUS}-1m`,
      BEDROCK_SONNET_MODEL: SONNET,
      BEDROCK_HAIKU_MODEL: `${HAIKU}-1m`, // misconfigured: haiku cannot do 1M
    };
    expect(listAvailableModels(env)).toEqual([
      { label: 'default', id: `${OPUS}-1m`, contextWindow: 1_000_000 },
      { label: 'sonnet', id: SONNET, contextWindow: 200_000 },
    ]);
  });
});

describe('Claude pricing is unchanged (AM-13)', () => {
  it('turnCost for the three families and the 1M variant', () => {
    expect(turnCost(OPUS, M, M, M, M)).toBeCloseTo(15 + 75 + 1.5 + 18.75, 6);
    expect(turnCost(SONNET, M, M, M, M)).toBeCloseTo(3 + 15 + 0.3 + 3.75, 6);
    expect(turnCost(HAIKU, M, M, M, M)).toBeCloseTo(0.8 + 4 + 0.08 + 1.0, 6);
    expect(turnCost(`${SONNET}-1m`, M, M, M, M)).toBeCloseTo(3 + 15 + 0.3 + 3.75, 6);
    expect(turnCost(SONNET, 1000, 500)).toBeCloseTo(0.003 + 0.0075, 9);
  });

  it('resolveModel keeps every existing Claude field', () => {
    expect(resolveModel(SONNET)).toMatchObject({
      id: SONNET,
      family: 'sonnet',
      inputPricePer1M: 3,
      outputPricePer1M: 15,
      cacheWritePricePer1M: 3.75,
      cacheReadPricePer1M: 0.3,
      contextWindow: 200_000,
    });
    expect(resolveModel(`${SONNET}-1m`)).toMatchObject({ family: 'sonnet', inputPricePer1M: 3, contextWindow: 1_000_000 });
    expect(resolveModel(OPUS)).toMatchObject({
      family: 'opus',
      inputPricePer1M: 15,
      outputPricePer1M: 75,
      cacheWritePricePer1M: 18.75,
      cacheReadPricePer1M: 1.5,
      contextWindow: 200_000,
    });
    expect(resolveModel(`${OPUS}-1m`)).toMatchObject({ family: 'opus', contextWindow: 1_000_000 });
    expect(resolveModel(HAIKU)).toMatchObject({
      family: 'haiku',
      inputPricePer1M: 0.8,
      outputPricePer1M: 4,
      cacheWritePricePer1M: 1.0,
      cacheReadPricePer1M: 0.08,
      contextWindow: 200_000,
    });
  });

  it('resolveModel adds provider and a non-fallback priceSource for Claude', () => {
    for (const id of [OPUS, SONNET, HAIKU, `${SONNET}-1m`]) {
      const spec = resolveModel(id);
      expect(spec.provider, id).toBe('anthropic');
      expect(typeof spec.priceSource, id).toBe('string');
      expect(spec.priceSource.length, id).toBeGreaterThan(0);
      expect(spec.priceSource, id).not.toBe('fallback');
    }
  });
});

describe('non-Anthropic pricing goes through the registry (AM-13)', () => {
  it('an unknown id is priced at the $25/$80 fallback, not as Haiku', () => {
    const id = 'vendor.model-that-does-not-exist-v9:0';
    const spec = resolveModel(id);
    expect(spec).toMatchObject({
      id,
      provider: 'vendor',
      inputPricePer1M: 25,
      outputPricePer1M: 80,
      // Absent cache tiers bill as plain input (the conservative direction).
      cacheReadPricePer1M: 25,
      cacheWritePricePer1M: 25,
      contextWindow: 128_000,
      priceSource: 'fallback',
    });
    expect(['opus', 'sonnet', 'haiku']).not.toContain(spec.family);
    expect(turnCost(id, M, M)).toBeCloseTo(105, 6);
    expect(turnCost(id, M, 0, M, M)).toBeCloseTo(75, 6);
    expect(turnCost(`us.${id}`, M, M)).toBeCloseTo(105, 6);
  });

  it('a Claude name that matches no known family is the fallback, not Haiku', () => {
    const unknownClaude = resolveModel('us.anthropic.claude-nonexistent-9-9');
    expect(unknownClaude.family).not.toBe('haiku');
    expect(unknownClaude).toMatchObject({ provider: 'anthropic', inputPricePer1M: 25, outputPricePer1M: 80, priceSource: 'fallback' });
    expect(turnCost('us.anthropic.claude-nonexistent-9-9', M, M)).toBeCloseTo(105, 6);

    // The plan's own example: a real new name that is not opus/sonnet/haiku.
    const fable = resolveModel('us.anthropic.claude-fable-5-1');
    expect(fable.family).not.toBe('haiku');
    expect(fable.inputPricePer1M).not.toBe(0.8);
    expect(fable.provider).toBe('anthropic');
  });

  it('a seeded model uses its card price (GPT-5.6 Sol is $4.40 / $22.00 per the plan)', () => {
    for (const id of ['openai.gpt-5.6-sol', 'us.openai.gpt-5.6-sol']) {
      const spec = resolveModel(id);
      expect(spec.inputPricePer1M, id).toBe(4.4);
      expect(spec.outputPricePer1M, id).toBe(22);
      expect(spec.provider, id).toBe('openai');
      expect(spec.priceSource, id).toMatch(/^https:\/\/docs\.aws\.amazon\.com\/.*gpt-56-sol/);
    }
    expect(turnCost('us.openai.gpt-5.6-sol', M, M)).toBeCloseTo(26.4, 6);
  });

  it('ModelSpec.family accepts non-Claude families and carries provider/priceSource (compile-time)', () => {
    const spec: ModelSpec = {
      id: 'meta.llama-fixture-v1:0',
      family: 'llama',
      provider: 'meta',
      priceSource: 'fallback',
      inputPricePer1M: 25,
      outputPricePer1M: 80,
      cacheReadPricePer1M: 25,
      cacheWritePricePer1M: 25,
      contextWindow: 128_000,
    };
    expect(spec.family).toBe('llama');
  });
});

describe('playground-catalog uses the single fallback price constant', () => {
  const src = readFileSync(new URL('./playground-catalog.ts', import.meta.url), 'utf8');

  it('meters an unpriced model at $25/$80', () => {
    expect(playgroundMeteredCost({ id: 'x', provider: 'X', name: 'x' }, M, M)).toBeCloseTo(105, 6);
  });

  it('imports FALLBACK_PRICE instead of defining its own constants', () => {
    expect(src).toMatch(/\bFALLBACK_PRICE\b/);
    expect(src).not.toMatch(/FALLBACK_(INPUT|OUTPUT)_PRICE_PER_1M/);
  });

  it('no longer claims the task role lacks bedrock:ListFoundationModels', () => {
    // iam-stack.ts grants ListFoundationModels and ListInferenceProfiles to the task role.
    expect(src).not.toMatch(/not\s*\n?\s*\*?\s*bedrock:ListFoundationModels/);
    expect(src).not.toMatch(/could 403/);
  });

  it('still prices the env Claude entries from KNOWN_PRICING', () => {
    const [sonnet] = listPlaygroundModels({ BEDROCK_SONNET_MODEL: SONNET } as NodeJS.ProcessEnv);
    expect(sonnet).toMatchObject({ id: SONNET, provider: 'Anthropic', inputPricePer1M: 3, outputPricePer1M: 15 });
  });
});
