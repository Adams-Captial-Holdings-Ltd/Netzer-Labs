import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../observability/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  buildFallbackChain,
  converseStreamTurnWithFallback,
  clearAffinityModel,
  getAffinityModel,
  type ConverseTurnOutput,
} from './client.js';

const OPUS = 'us.anthropic.claude-opus-4-7';
const SONNET = 'us.anthropic.claude-sonnet-4-6';
const HAIKU = 'us.anthropic.claude-haiku-4-5';

const throttle = () =>
  Object.assign(new Error('rate exceeded'), { name: 'ThrottlingException' });
const validation = () =>
  Object.assign(new Error('bad input'), { name: 'ValidationException' });

function okOutput(modelId: string): ConverseTurnOutput {
  return {
    text: 'alive',
    modelId,
    inputTokens: 1,
    outputTokens: 1,
    cacheReadInputTokens: 0,
    cacheWriteInputTokens: 0,
    costUsd: 0,
    stopReason: 'end_turn',
    latencyMs: 1,
  };
}

const SESSION = { agentId: 'main', chatId: 'chat-1' };
const INPUT = { modelId: OPUS, userText: 'hi', systemPrompt: 'You are a test agent.' };

beforeEach(() => {
  vi.stubEnv('BEDROCK_OPUS_MODEL', OPUS);
  vi.stubEnv('BEDROCK_SONNET_MODEL', SONNET);
  vi.stubEnv('BEDROCK_HAIKU_MODEL', HAIKU);
  clearAffinityModel(SESSION.agentId, SESSION.chatId);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('buildFallbackChain', () => {
  it('walks down from the primary: opus -> sonnet -> haiku', () => {
    expect(buildFallbackChain(OPUS)).toEqual([OPUS, SONNET, HAIKU]);
    expect(buildFallbackChain(SONNET)).toEqual([SONNET, HAIKU]);
    expect(buildFallbackChain(HAIKU)).toEqual([HAIKU]);
  });
});

describe('converseStreamTurnWithFallback', () => {
  it('happy path: primary answers, no affinity recorded', async () => {
    const streamFn = vi.fn(async (input: { modelId: string }) => okOutput(input.modelId));
    const out = await converseStreamTurnWithFallback(INPUT, {}, SESSION, streamFn as never);
    expect(out.modelId).toBe(OPUS);
    expect(streamFn).toHaveBeenCalledTimes(1);
    expect(getAffinityModel(SESSION.agentId, SESSION.chatId, OPUS)).toBe(OPUS);
  });

  it('falls back pre-chunk on throttle and pins session affinity', async () => {
    const streamFn = vi.fn(async (input: { modelId: string }) => {
      if (input.modelId === OPUS) throw throttle();
      return okOutput(input.modelId);
    });
    const out = await converseStreamTurnWithFallback(INPUT, {}, SESSION, streamFn as never);
    expect(out.modelId).toBe(SONNET);
    expect(streamFn).toHaveBeenCalledTimes(2);
    // The session stays on the fallback model for subsequent turns.
    expect(getAffinityModel(SESSION.agentId, SESSION.chatId, OPUS)).toBe(SONNET);
  });

  it('NEVER falls back once a chunk was emitted (mid-stream failure propagates)', async () => {
    const streamFn = vi.fn(
      async (_input: { modelId: string }, callbacks: { onChunk?: (t: string) => void }) => {
        callbacks.onChunk?.('partial answer');
        throw throttle();
      },
    );
    const onChunk = vi.fn();
    await expect(
      converseStreamTurnWithFallback(INPUT, { onChunk }, SESSION, streamFn as never),
    ).rejects.toThrow('rate exceeded');
    expect(streamFn).toHaveBeenCalledTimes(1);
    expect(onChunk).toHaveBeenCalledWith('partial answer');
  });

  it('non-throttle errors propagate immediately without walking the chain', async () => {
    const streamFn = vi.fn(async () => {
      throw validation();
    });
    await expect(
      converseStreamTurnWithFallback(INPUT, {}, SESSION, streamFn as never),
    ).rejects.toThrow('bad input');
    expect(streamFn).toHaveBeenCalledTimes(1);
  });

  it('exhausted chain rethrows the last throttle (haiku has nowhere to go)', async () => {
    const streamFn = vi.fn(async () => {
      throw throttle();
    });
    await expect(
      converseStreamTurnWithFallback(INPUT, {}, SESSION, streamFn as never),
    ).rejects.toThrow('rate exceeded');
    expect(streamFn).toHaveBeenCalledTimes(3);
  });

  it('a fallen-back session starts from its affinity model on the next turn', async () => {
    const first = vi.fn(async (input: { modelId: string }) => {
      if (input.modelId !== HAIKU) throw throttle();
      return okOutput(input.modelId);
    });
    await converseStreamTurnWithFallback(INPUT, {}, SESSION, first as never);
    expect(first).toHaveBeenCalledTimes(3);

    const second = vi.fn(async (input: { modelId: string }) => okOutput(input.modelId));
    const out = await converseStreamTurnWithFallback(INPUT, {}, SESSION, second as never);
    expect(second).toHaveBeenCalledTimes(1);
    expect(out.modelId).toBe(HAIKU);
  });
});
