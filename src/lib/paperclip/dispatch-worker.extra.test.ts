import { describe, expect, it, vi } from 'vitest';
import { deliverOutcome, DispatchFailure, runDispatchAttempt } from './dispatch-worker.js';
import { PaperclipError, type PaperclipErrorType } from './error.js';
import type { MissionEngine } from './mission-engine.js';
import type { PaperclipDispatchContext } from './types.js';

const ctx: PaperclipDispatchContext = { netzarAgentId: 'main', issueId: 'issue-1', runId: 'run-1', dedupeKey: 'run-1#issue-1', context: {} };
type Expected = { code: string; status: number; retryable: boolean };
const workCases: Record<PaperclipErrorType, Expected> = {
  auth: { code: 'connector_auth', status: 502, retryable: false },
  run_id_required: { code: 'connector_auth', status: 502, retryable: false },
  checkout_not_self: { code: 'connector_auth', status: 502, retryable: false },
  company_mismatch: { code: 'connector_auth', status: 502, retryable: false },
  invalid_input: { code: 'agent_failed', status: 500, retryable: false },
  conflict: { code: 'agent_failed', status: 500, retryable: false },
  pagination_truncated: { code: 'agent_failed', status: 500, retryable: false },
  disabled: { code: 'agent_failed', status: 500, retryable: true },
  ratelimited: { code: 'agent_failed', status: 500, retryable: true },
  project_paused: { code: 'agent_failed', status: 500, retryable: true },
  unavailable: { code: 'agent_failed', status: 500, retryable: true },
  unknown: { code: 'agent_failed', status: 500, retryable: true },
};
const deliveryCases: Record<PaperclipErrorType, Expected> = {
  auth: { code: 'connector_auth', status: 502, retryable: false },
  run_id_required: { code: 'connector_auth', status: 502, retryable: false },
  checkout_not_self: { code: 'connector_auth', status: 502, retryable: false },
  company_mismatch: { code: 'connector_auth', status: 502, retryable: false },
  invalid_input: { code: 'agent_failed', status: 500, retryable: false },
  pagination_truncated: { code: 'agent_failed', status: 500, retryable: false },
  conflict: { code: 'delivery_failed', status: 502, retryable: true },
  ratelimited: { code: 'delivery_failed', status: 502, retryable: true },
  project_paused: { code: 'delivery_failed', status: 502, retryable: true },
  disabled: { code: 'delivery_failed', status: 502, retryable: true },
  unavailable: { code: 'delivery_unknown', status: 500, retryable: false },
  unknown: { code: 'delivery_unknown', status: 500, retryable: false },
};
async function failure(promise: Promise<unknown>): Promise<DispatchFailure> {
  try { await promise; } catch (err) { expect(err).toBeInstanceOf(DispatchFailure); return err as DispatchFailure; }
  throw new Error('expected failure');
}
describe('dispatch worker error mapping', () => {
  it.each(Object.entries(workCases) as [PaperclipErrorType, Expected][])('maps issue read %s', async (type, expected) => {
    const engine = { getMission: async () => { throw new PaperclipError({ type }); } } as unknown as MissionEngine;
    expect(await failure(runDispatchAttempt(ctx, { engine }))).toMatchObject(expected);
  });
  it.each(Object.entries(deliveryCases) as [PaperclipErrorType, Expected][])('maps delivery %s', async (type, expected) => {
    const engine = { completeMission: async () => { throw new PaperclipError({ type }); } } as unknown as MissionEngine;
    expect(await failure(deliverOutcome(ctx, { disposition: 'done', comment: 'answer' }, { engine }))).toMatchObject(expected);
  });
  it('treats refusal-looking text without a refusal marker as an ordinary answer', async () => {
    const append = vi.fn(async () => undefined);
    const engine = { getMission: async () => ({ id: 'issue-1', title: 'T', body: 'B', status: 'open', priority: 'medium' }) } as unknown as MissionEngine;
    const result = await runDispatchAttempt(ctx, { engine, getSessionFn: async () => null,
      appendTurnsFn: append, runTurn: (async () => ({ text: 'I cannot do that request.', costUsd: 0, toolCallCount: 0 })) as never });
    expect(result).toEqual({ disposition: 'done', comment: 'I cannot do that request.' });
    expect(append).toHaveBeenCalledTimes(1);
  });
  it('does not append a turn that resolves after its signal was aborted', async () => {
    const controller = new AbortController();
    const append = vi.fn(async () => undefined);
    const engine = { getMission: async () => ({ id: 'issue-1', title: 'T', body: 'B', status: 'open', priority: 'medium' }) } as unknown as MissionEngine;
    const failed = failure(runDispatchAttempt(ctx, { engine, abortSignal: controller.signal,
      getSessionFn: async () => null, appendTurnsFn: append,
      runTurn: (async () => { controller.abort(); return { text: 'late', costUsd: 0, toolCallCount: 0 }; }) as never }));
    expect(await failed).toMatchObject({ code: 'agent_failed', retryable: false });
    expect(append).not.toHaveBeenCalled();
  });
});
