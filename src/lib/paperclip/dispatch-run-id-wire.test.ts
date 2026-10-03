import { describe, expect, it } from 'vitest';
import { paperclipIssue, paperclipTestClient, TEST_ISSUE_ID } from './test-helpers.js';
import { createPaperclipMissionEngine } from './paperclip-mission-engine.js';
import { deliverOutcome, runDispatchAttempt } from './dispatch-worker.js';
import type { PaperclipDispatchContext } from './types.js';
import { buildAgentIdMap } from './agent-map.js';

const runId = 'run-from-paperclip';
const ctx: PaperclipDispatchContext = { netzarAgentId: 'main', issueId: TEST_ISSUE_ID,
  runId, dedupeKey: `${runId}#${TEST_ISSUE_ID}`, context: {} };

describe('Paperclip run id on the wire', () => {
  it('carries the original run id on direct reads and writes and through work and delivery', async () => {
    const calls: Array<{ method: string; runId: string | null }> = [];
    const fetchFn = (async (_input: unknown, init: RequestInit = {}) => {
      calls.push({ method: init.method ?? 'GET', runId: new Headers(init.headers).get('x-paperclip-run-id') });
      return new Response(JSON.stringify(paperclipIssue({ title: 'Task', description: 'Body',
        assigneeAgentId: 'agent-main' })),
        { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const agents = buildAgentIdMap([{ id: 'agent-main', metadata: { netzarAgentId: 'main' } } as never]);
    const engine = createPaperclipMissionEngine({ client: paperclipTestClient({ fetchFn }), agents: async () => agents });
    await engine.getMission(TEST_ISSUE_ID, { actor: 'main', runId });
    await engine.completeMission(TEST_ISSUE_ID, 'done', { actor: 'main', runId });
    await runDispatchAttempt(ctx, { engine, getSessionFn: async () => null, appendTurnsFn: async () => undefined,
      runTurn: (async () => ({ text: 'done', costUsd: 0, toolCallCount: 0 })) as never });
    await deliverOutcome(ctx, { disposition: 'done', comment: 'done' }, { engine });
    expect(calls.map((call) => call.method)).toEqual(['GET', 'PATCH', 'GET', 'PATCH']);
    expect(calls.every((call) => call.runId === runId)).toBe(true);
  });
});
