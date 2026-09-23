/**
 * P2 (step 4) — the Bedrock client's half of the turn lifecycle.
 *
 * Written BEFORE the change, as the bar (netzar-chat-plan/p2-proof.sh rows A-4, C-3).
 *
 *   - Stop has to reach the network, not only the agent loop: a streamed call hands
 *     the turn's AbortSignal to the SDK, which is what cancels the in-flight request.
 *   - Decision 50: `streamProcessingMode` belongs to the guardrail configuration of
 *     ConverseStream only (the SDK's GuardrailStreamConfiguration). A plain Converse
 *     takes a GuardrailConfiguration, which has no such field, so it must never be
 *     sent there.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { send } = vi.hoisted(() => ({ send: vi.fn() }));

// bedrockClient() wraps the SDK client with the X-Ray helper; replacing the helper
// hands the module a client whose `send` this file controls, so no request leaves.
vi.mock('../observability/xray.js', () => ({ captureAwsClient: () => ({ send }) }));
vi.mock('./guard.js', () => ({ assertBedrockAllowed: vi.fn(async () => {}) }));
vi.mock('../safety/fault-injector.js', () => ({ maybeThrowSyntheticBedrock: vi.fn(async () => {}) }));
vi.mock('../../observability/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  truncateForLog: (s: string) => s,
}));

import { converseStreamTurn, converseTurn } from './client.js';

const MODEL = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';

function streamOf(...texts: string[]) {
  return {
    stream: (async function* () {
      for (const t of texts) yield { contentBlockDelta: { delta: { text: t } } };
      yield { messageStop: { stopReason: 'end_turn' } };
      yield { metadata: { usage: { inputTokens: 3, outputTokens: 2 } } };
    })(),
  };
}

describe('turn lifecycle (P2) — bedrock client', () => {
  beforeEach(() => {
    send.mockReset();
  });

  it('passes the abort signal to the streamed model request', async () => {
    send.mockResolvedValueOnce(streamOf('hi'));
    const ac = new AbortController();

    await converseStreamTurn({ modelId: MODEL, systemPrompt: 's', userText: 'u', abortSignal: ac.signal });

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![1]).toEqual(expect.objectContaining({ abortSignal: ac.signal }));
  });

  it('sets the guardrail stream mode only on streamed calls', async () => {
    const guardrail = { id: 'gr-1', version: '3', streamMode: 'async' as const };
    send.mockResolvedValueOnce(streamOf('hi'));
    await converseStreamTurn({ modelId: MODEL, systemPrompt: 's', userText: 'u', guardrail });

    const streamedInput = (send.mock.calls[0]![0] as { input: { guardrailConfig?: unknown } }).input;
    expect(streamedInput.guardrailConfig).toEqual({
      guardrailIdentifier: 'gr-1',
      guardrailVersion: '3',
      streamProcessingMode: 'async',
    });

    send.mockResolvedValueOnce({
      output: { message: { role: 'assistant', content: [{ text: 'ok' }] } },
      stopReason: 'end_turn',
      usage: { inputTokens: 3, outputTokens: 2 },
    });
    await converseTurn({ modelId: MODEL, systemPrompt: 's', userText: 'u', guardrail });

    const plainInput = (send.mock.calls[1]![0] as { input: { guardrailConfig?: unknown } }).input;
    expect(plainInput.guardrailConfig).toEqual({ guardrailIdentifier: 'gr-1', guardrailVersion: '3' });
  });
});
