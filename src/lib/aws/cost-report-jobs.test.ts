import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * The async job store must: single-flight (a fresh pending job is reused, not
 * re-run), write the finished report back, surface a stale/dead pending job as
 * an error rather than spinning forever, and never touch the model when a job is
 * already running. The ddb client and the generator are faked with an in-memory
 * store so we can assert the exact reads/writes.
 */

const { store, generateCostReport } = vi.hoisted(() => ({
  store: new Map<string, Record<string, unknown>>(),
  generateCostReport: vi.fn(async () => ({ available: true, headline: 'rich', drivers: [], optimizations: [], hiddenCosts: [] })),
}));

const fakeDdb = {
  send: async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
    const n = cmd.constructor.name;
    if (n === 'GetCommand') {
      const key = cmd.input.Key as { PK: string; SK: string };
      return { Item: store.get(`${key.PK}|${key.SK}`) };
    }
    if (n === 'PutCommand') {
      const it = cmd.input.Item as { PK: string; SK: string };
      store.set(`${it.PK}|${it.SK}`, it);
      return {};
    }
    throw new Error(`unexpected command ${n}`);
  },
};

vi.mock('../state/ddb.js', () => ({ ddb: () => fakeDdb }));
vi.mock('./cost-analyst.js', () => ({ generateCostReport }));
vi.mock('../../observability/logger.js', () => ({ logger: { info: () => {}, warn: () => {}, error: () => {} } }));

import { startReportJob, getReportJob } from './cost-report-jobs.js';

const flush = () => new Promise((r) => setTimeout(r, 15));
const KEY = 'COSTREPORTJOB|current';
const inputs = { summary: { available: true } as never, risks: {} as never, dailyCapUsd: 20 };

beforeEach(() => {
  store.clear();
  generateCostReport.mockClear();
  generateCostReport.mockResolvedValue({ available: true, headline: 'rich', drivers: [], optimizations: [], hiddenCosts: [] });
});

describe('startReportJob', () => {
  it('starts a pending job, generates RICH in the background, and writes the result', async () => {
    const start = await startReportJob(inputs);
    expect(start.status).toBe('pending');
    expect(store.get(KEY)?.status).toBe('pending');

    await flush();
    // Generated with rich:true and the done report was written back.
    expect(generateCostReport).toHaveBeenCalledWith(expect.objectContaining({ rich: true }));
    const row = store.get(KEY);
    expect(row?.status).toBe('done');
    expect(typeof row?.report).toBe('string');
  });

  it('single-flights: a fresh pending job is reused and does NOT start a second generation', async () => {
    store.set(KEY, { PK: 'COSTREPORTJOB', SK: 'current', jobId: 'existing', status: 'pending', startedAt: Date.now() });
    const start = await startReportJob(inputs);
    expect(start.jobId).toBe('existing');
    await flush();
    expect(generateCostReport).not.toHaveBeenCalled();
  });

  it('supersedes a STALE pending job (starts fresh)', async () => {
    store.set(KEY, { PK: 'COSTREPORTJOB', SK: 'current', jobId: 'old', status: 'pending', startedAt: Date.now() - 10 * 60 * 1000 });
    const start = await startReportJob(inputs);
    expect(start.jobId).not.toBe('old');
    await flush();
    expect(generateCostReport).toHaveBeenCalledTimes(1);
  });
});

describe('getReportJob', () => {
  it('returns idle when there is no job', async () => {
    expect((await getReportJob()).status).toBe('idle');
  });

  it('returns the parsed report when done', async () => {
    store.set(KEY, {
      PK: 'COSTREPORTJOB', SK: 'current', jobId: 'j', status: 'done', startedAt: Date.now(),
      report: JSON.stringify({ available: true, headline: 'hi' }),
    });
    const r = await getReportJob();
    expect(r.status).toBe('done');
    expect(r.report?.headline).toBe('hi');
  });

  it('reports a stale pending job as a timeout error, not pending forever', async () => {
    store.set(KEY, { PK: 'COSTREPORTJOB', SK: 'current', jobId: 'j', status: 'pending', startedAt: Date.now() - 10 * 60 * 1000 });
    const r = await getReportJob();
    expect(r.status).toBe('error');
    expect(r.error).toMatch(/timed out|restart/i);
  });

  it('passes through an error status', async () => {
    store.set(KEY, { PK: 'COSTREPORTJOB', SK: 'current', jobId: 'j', status: 'error', startedAt: Date.now(), error: 'boom' });
    const r = await getReportJob();
    expect(r.status).toBe('error');
    expect(r.error).toBe('boom');
  });
});
