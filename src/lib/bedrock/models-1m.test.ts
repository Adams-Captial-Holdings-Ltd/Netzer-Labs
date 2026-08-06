import { describe, it, expect } from 'vitest';
import {
  resolveModelInvocation,
  is1mModelId,
  is1mSupported,
  listAvailableModels,
  CONTEXT_1M_BETA,
} from './models.js';

describe('1M context resolution', () => {
  it('resolves a synthetic -1m id to the base model + context-1m beta', () => {
    expect(resolveModelInvocation('us.anthropic.claude-sonnet-4-6-1m')).toEqual({
      modelId: 'us.anthropic.claude-sonnet-4-6',
      anthropicBeta: [CONTEXT_1M_BETA],
    });
    expect(resolveModelInvocation('us.anthropic.claude-opus-4-7-1m')).toEqual({
      modelId: 'us.anthropic.claude-opus-4-7',
      anthropicBeta: [CONTEXT_1M_BETA],
    });
  });

  it('passes a normal model id through unchanged (no beta)', () => {
    expect(resolveModelInvocation('us.anthropic.claude-sonnet-4-6')).toEqual({
      modelId: 'us.anthropic.claude-sonnet-4-6',
    });
  });

  it('only treats opus/sonnet -1m ids as supported', () => {
    expect(is1mModelId('us.anthropic.claude-opus-4-7-1m')).toBe(true);
    expect(is1mSupported('us.anthropic.claude-opus-4-7-1m')).toBe(true);
    expect(is1mSupported('us.anthropic.claude-sonnet-4-6-1m')).toBe(true);
    // A haiku -1m would be a guaranteed ValidationException on Bedrock.
    expect(is1mModelId('us.anthropic.claude-haiku-4-5-1m')).toBe(true);
    expect(is1mSupported('us.anthropic.claude-haiku-4-5-1m')).toBe(false);
    expect(is1mSupported('us.anthropic.claude-sonnet-4-6')).toBe(false);
  });

  it('hides an unsupported -1m model from the catalog but keeps supported ones', () => {
    const models = listAvailableModels({
      BEDROCK_SONNET_MODEL: 'us.anthropic.claude-sonnet-4-6',
      BEDROCK_SONNET_1M_MODEL: 'us.anthropic.claude-sonnet-4-6-1m',
      BEDROCK_HAIKU_MODEL: 'us.anthropic.claude-haiku-4-5-1m', // misconfigured: -1m on haiku
    } as NodeJS.ProcessEnv);
    const ids = models.map((m) => m.id);
    expect(ids).toContain('us.anthropic.claude-sonnet-4-6');
    expect(ids).toContain('us.anthropic.claude-sonnet-4-6-1m'); // supported, kept
    expect(ids).not.toContain('us.anthropic.claude-haiku-4-5-1m'); // unsupported, filtered
  });
});
