/**
 * Work Platform step 4 (ADR 0013): the attempt's work and the completion writer.
 * FROZEN acceptance tests.
 *
 * `runDispatchAttempt` runs the turn and RETURNS the outcome; it writes nothing
 * to Paperclip. `deliverOutcome` is the completion writer: one call, with the
 * run id it was given. Failures are typed (`DispatchFailure`), never prose.
 */
import { describe, expect, it, vi } from 'vitest';
import type { AgentTurnResponse } from '../../agent/agent-loop.js';
import { PaperclipError, type PaperclipErrorType } from './error.js';
import type { MissionEngine } from './mission-engine.js';
import type { ProjectedMission } from './mission-projection.js';
import type { PaperclipDispatchContext } from './types.js';
import { DispatchFailure, deliverOutcome, parseDispatchBody, runDispatchAttempt } from './dispatch-worker.js';

const ISSUE = '11111111-1111-4111-8111-111111111111';
const ctx: PaperclipDispatchContext = {
  netzarAgentId: 'main', issueId: ISSUE, runId: 'run-live', dedupeKey: `run-live#${ISSUE}`, context: {},
};
const mission = { id: ISSUE, title: 'T', body: 'B', status: 'in_progress', priority: 'medium' } as unknown as ProjectedMission;

function engine(over: Partial<Record<keyof MissionEngine | 'completeMission', unknown>> = {}) {
  return {
    getMission: vi.fn(async () => mission),
    comment: vi.fn(async () => undefined),
    setStatus: vi.fn(async () => mission),
    completeMission: vi.fn(async () => mission),
    ...over,
  } as unknown as MissionEngine & { completeMission: ReturnType<typeof vi.fn>; comment: ReturnType<typeof vi.fn>; setStatus: ReturnType<typeof vi.fn> };
}

const turn = (over: Partial<AgentTurnResponse> = {}): AgentTurnResponse =>
  ({ text: 'the answer', costUsd: 0, toolCallCount: 0, ...over }) as AgentTurnResponse;
const named = (name: string) => Object.assign(new Error(`${name}: vendor detail secret-xyz`), { name });
const pcError = (type: PaperclipErrorType, status?: number) => new PaperclipError({ type, ...(status === undefined ? {} : { status }) });

function deps(over: Record<string, unknown> = {}) {
  const e = engine();
  return {
    engine: e,
    runTurn: vi.fn(async () => turn()),
    getSessionFn: vi.fn(async () => undefined),
    appendTurnsFn: vi.fn(async () => undefined),
    now: () => 1_700_000_000_000,
    ...over,
  };
}

async function failureOf(promise: Promise<unknown>): Promise<DispatchFailure> {
  try { await promise; } catch (error) {
    expect(error).toBeInstanceOf(DispatchFailure);
    return error as DispatchFailure;
  }
  throw new Error('expected a DispatchFailure');
}

describe('runDispatchAttempt', () => {
  it('a normal reply is a done outcome; the session is appended; nothing is written to Paperclip', async () => {
    const d = deps();
    const outcome = await runDispatchAttempt(ctx, d as never);
    expect(outcome).toEqual({ disposition: 'done', comment: 'the answer' });
    expect(d.appendTurnsFn).toHaveBeenCalledTimes(1);
    expect(d.engine.comment).not.toHaveBeenCalled();
    expect(d.engine.setStatus).not.toHaveBeenCalled();
    expect(d.engine.completeMission).not.toHaveBeenCalled();
    const request = (d.runTurn.mock.calls[0] as unknown[])[0] as { runId: string; origin?: string; chatId: string };
    expect(request.runId).toBe('run-live');
    expect(request.origin).toBeUndefined();
    expect(request.chatId).toBe(`paperclip:${ISSUE}`);
  });

  it('a guardrail-blocked turn is a blocked outcome and is never appended to the session', async () => {
    const d = deps({ runTurn: vi.fn(async () => turn({ text: 'blocked notice', blocked: true })) });
    expect(await runDispatchAttempt(ctx, d as never)).toEqual({ disposition: 'blocked', comment: 'blocked notice' });
    expect(d.appendTurnsFn).not.toHaveBeenCalled();
  });

  it.each([[true], [false]])('a refused turn (retryable=%s) is agent_failed, not an outcome, and is not appended', async (retryable) => {
    const refusal = { kind: retryable ? 'rate_limited' : 'kill_phrase', retryable } as AgentTurnResponse['refusal'];
    const d = deps({ runTurn: vi.fn(async () => turn({ text: 'try later', refusal })) });
    const failure = await failureOf(runDispatchAttempt(ctx, d as never));
    expect(failure).toMatchObject({ code: 'agent_failed', status: 500, retryable });
    expect(d.appendTurnsFn).not.toHaveBeenCalled();
  });

  it.each([
    ['CostCapExceededError', 'cost_cap', 402, true],
    ['KillSwitchActiveError', 'model_access', 503, true],
    ['AccessDeniedException', 'model_access', 503, true],
    ['SomethingElse', 'agent_failed', 500, true],
  ] as const)('a thrown %s is %s (%i)', async (name, code, status, retryable) => {
    const d = deps({ runTurn: vi.fn(async () => { throw named(name); }) });
    const failure = await failureOf(runDispatchAttempt(ctx, d as never));
    expect(failure).toMatchObject({ code, status, retryable });
    expect(failure.message).not.toContain('secret-xyz');
  });

  it.each([
    ['auth', 'connector_auth', 502, false],
    ['run_id_required', 'connector_auth', 502, false],
    ['checkout_not_self', 'connector_auth', 502, false],
    ['company_mismatch', 'connector_auth', 502, false],
    ['invalid_input', 'agent_failed', 500, false],
    ['conflict', 'agent_failed', 500, false],
    ['unavailable', 'agent_failed', 500, true],
    ['ratelimited', 'agent_failed', 500, true],
    ['disabled', 'agent_failed', 500, true],
  ] as const)('a Paperclip %s error while reading the issue is %s (retryable=%s)', async (type, code, status, retryable) => {
    const d = deps({ engine: engine({ getMission: vi.fn(async () => { throw pcError(type, 500); }) }) });
    expect(await failureOf(runDispatchAttempt(ctx, d as never))).toMatchObject({ code, status, retryable });
    expect(d.runTurn).not.toHaveBeenCalled();
  });
});

describe('deliverOutcome (the completion writer)', () => {
  it('done: ONE call that sets the status and carries the comment, with the given run id', async () => {
    const e = engine();
    await deliverOutcome({ ...ctx, runId: 'run-newest' }, { disposition: 'done', comment: 'the answer' }, { engine: e });
    expect(e.completeMission).toHaveBeenCalledTimes(1);
    expect(e.completeMission).toHaveBeenCalledWith(ISSUE, 'the answer', { actor: 'main', runId: 'run-newest' });
    expect(e.comment).not.toHaveBeenCalled();
    expect(e.setStatus).not.toHaveBeenCalled();
  });

  it('blocked: the notice is ONE comment; the status is not touched', async () => {
    const e = engine();
    await deliverOutcome(ctx, { disposition: 'blocked', comment: 'blocked notice' }, { engine: e });
    expect(e.comment).toHaveBeenCalledTimes(1);
    expect(e.comment).toHaveBeenCalledWith(ISSUE, 'blocked notice', { actor: 'main', runId: 'run-live' });
    expect(e.completeMission).not.toHaveBeenCalled();
    expect(e.setStatus).not.toHaveBeenCalled();
  });

  it.each([
    ['auth', 401, 'connector_auth', 502, false],
    ['run_id_required', 401, 'connector_auth', 502, false],
    ['checkout_not_self', 403, 'connector_auth', 502, false],
    ['company_mismatch', 403, 'connector_auth', 502, false],
    ['invalid_input', 400, 'agent_failed', 500, false],
    ['conflict', 409, 'delivery_failed', 502, true],
    ['ratelimited', 429, 'delivery_failed', 502, true],
    ['project_paused', 409, 'delivery_failed', 502, true],
    ['disabled', undefined, 'delivery_failed', 502, true],
    ['unavailable', 503, 'delivery_failed', 502, true],
    ['unavailable', undefined, 'delivery_unknown', 500, false],
    ['unknown', undefined, 'delivery_unknown', 500, false],
  ] as const)('a %s (%s) refusal of the write is %s', async (type, httpStatus, code, status, retryable) => {
    const e = engine({ completeMission: vi.fn(async () => { throw pcError(type, httpStatus); }) });
    const failure = await failureOf(deliverOutcome(ctx, { disposition: 'done', comment: 'x' }, { engine: e }));
    expect(failure).toMatchObject({ code, status, retryable });
  });

  it('an error that is not a Paperclip answer is delivery_unknown (never a blind retry), and its text does not leak', async () => {
    const e = engine({ completeMission: vi.fn(async () => { throw new Error('socket hang up secret-xyz'); }) });
    const failure = await failureOf(deliverOutcome(ctx, { disposition: 'done', comment: 'x' }, { engine: e }));
    expect(failure).toMatchObject({ code: 'delivery_unknown', status: 500, retryable: false });
    expect(failure.message).not.toContain('secret-xyz');
  });
});

describe('parseDispatchBody: retryOfRunId', () => {
  const body = (context: Record<string, unknown>) => ({ netzarAgentId: 'main', runId: 'run-2', context: { issueId: ISSUE, ...context } });
  it('carries a short string retryOfRunId', () => {
    expect(parseDispatchBody(body({ retryOfRunId: 'run-1' }))?.retryOfRunId).toBe('run-1');
  });
  it.each([[42], [''], ['   '], [null], [{ a: 1 }], ['x'.repeat(201)]])('ignores retryOfRunId %j', (value) => {
    const parsed = parseDispatchBody(body({ retryOfRunId: value }));
    expect(parsed).not.toBeNull();
    expect(parsed?.retryOfRunId).toBeUndefined();
  });
});
