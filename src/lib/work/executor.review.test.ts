/**
 * Review-round tests for the executor (step 5 fan-out findings). Same fake
 * store contract as executor.test.ts; the executor is the real one.
 */
import { createHash } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import {
  createExecutor,
  payloadHash,
  PENDING_SETTLE_MS,
  EffectRetryableError,
  EffectUnknownError,
  InvalidEffectKeyError,
} from './executor.js';
import type { DraftRow, EffectKey, EffectRow, EffectRows } from './effect-ledger.js';

const id = (k: EffectKey) => `${k.caseKey}|${k.stage}|${k.step}|${k.stageEntryNo}`;
function memoryRows() {
  const effects = new Map<string, EffectRow>();
  const drafts = new Map<string, DraftRow>();
  const rows: EffectRows = {
    get: async (key) => { const row = effects.get(id(key)); return row && structuredClone(row); },
    create: async (row) => { if (effects.has(id(row.key))) return false; effects.set(id(row.key), structuredClone(row)); return true; },
    replace: async (key, expectedVersion, next) => {
      if (effects.get(id(key))?.version !== expectedVersion) return false;
      effects.set(id(key), structuredClone(next)); return true;
    },
    listUnknown: async () => [...effects.values()].filter((row) => row.state === 'unknown').map((row) => structuredClone(row)),
    getDraft: async (key) => { const row = drafts.get(id(key)); return row && structuredClone(row); },
    createDraft: async (row) => { if (drafts.has(id(row.key))) return false; drafts.set(id(row.key), structuredClone(row)); return true; },
  };
  return { rows, effects, drafts };
}
function harness(over: Partial<Parameters<typeof createExecutor>[0]> = {}) {
  const store = memoryRows();
  const audit = vi.fn(async (_event: { action: string; detail?: Record<string, unknown> }) => {});
  let time = 1_000_000;
  const executor = createExecutor({ rows: store.rows, isDraining: () => false, audit, now: () => time, ...over });
  return { ...store, audit, executor, advance: (ms: number) => { time += ms; } };
}
const key: EffectKey = { caseKey: 'ref-2026-0001', stage: 'intake', step: 'create_record', stageEntryNo: 1 };
const fence = async () => {};
const payload = { slot: '2026-10-05T09:00' };
const pendingRow = (updatedAt: number): EffectRow =>
  ({ kind: 'effect', key, state: 'pending', payloadHash: payloadHash(payload), version: 1, createdAt: updatedAt, updatedAt });

describe('a write that returns nothing', () => {
  it('is recorded and audited like any other (no crash after the write)', async () => {
    const { executor, effects, audit } = harness();
    await expect(executor.runEffect({ key, payload, fence, apply: async () => undefined })).resolves.toBeUndefined();
    expect(effects.get(id(key))?.state).toBe('applied');
    expect(audit).toHaveBeenCalledTimes(1);
  });
});

describe('the audit trail is repaired, never lost', () => {
  it('an applied write whose audit failed is audited on the next replay, then never again', async () => {
    const audit = vi.fn().mockRejectedValueOnce(new Error('audit down')).mockResolvedValue(undefined);
    const { executor } = harness({ audit });
    const apply = vi.fn(async () => 'ok');
    await executor.runEffect({ key, payload, fence, apply }).catch(() => {});
    expect(await executor.runEffect({ key, payload, fence, apply })).toBe('ok');
    expect(audit).toHaveBeenCalledTimes(2);
    expect(audit.mock.calls[1][0]).toMatchObject({ action: 'effect_applied' });
    await executor.runEffect({ key, payload, fence, apply });
    expect(audit).toHaveBeenCalledTimes(2);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('resolve audits BEFORE it changes the row: a failed audit leaves the row unknown and resolvable', async () => {
    const h = harness();
    await h.executor.runEffect({ key, payload, fence, apply: async () => { throw new Error('lost'); } }).catch(() => {});
    h.audit.mockRejectedValueOnce(new Error('audit down'));
    await expect(h.executor.resolve(key, 'applied', 'user-ana')).rejects.toThrow('audit down');
    expect(h.effects.get(id(key))?.state).toBe('unknown');
    await h.executor.resolve(key, 'applied', 'user-ana');
    expect(h.effects.get(id(key))?.state).toBe('applied');
  });

  it('the audit row of a retried write names the attempt that wrote, not the first one', async () => {
    const { executor, audit } = harness();
    const notSent = Object.assign(new Error('breaker open'), { notSent: true });
    const apply = vi.fn<() => Promise<string>>().mockRejectedValueOnce(notSent).mockResolvedValue('ok');
    await executor.runEffect({ key, payload, fence, apply, correlation: { attemptNo: 1, runId: 'run-1', turnId: 't-1' } }).catch(() => {});
    await executor.runEffect({ key, payload, fence, apply, correlation: { attemptNo: 2, runId: 'run-2', turnId: 't-2' } });
    expect(audit.mock.calls.at(-1)![0]).toMatchObject({ action: 'effect_applied', detail: { attemptNo: 2, runId: 'run-2', turnId: 't-2' } });
  });
});

describe('never a blind write', () => {
  it('a row whose state the code does not recognise stops for a person', async () => {
    const { executor, effects } = harness();
    effects.set(id(key), { ...pendingRow(1), state: 'archived' as never });
    const apply = vi.fn(async () => 'ok');
    await expect(executor.runEffect({ key, payload, fence, apply })).rejects.toBeInstanceOf(EffectUnknownError);
    expect(apply).not.toHaveBeenCalled();
  });

  it('losing the claim on a retryable row is retryable, and this holder does not write', async () => {
    const store = memoryRows();
    store.effects.set(id(key), { ...pendingRow(1), state: 'retryable' });
    store.rows.replace = async () => false;
    const { executor } = harness({ rows: store.rows });
    const apply = vi.fn(async () => 'ok');
    await expect(executor.runEffect({ key, payload, fence, apply })).rejects.toBeInstanceOf(EffectRetryableError);
    expect(apply).not.toHaveBeenCalled();
  });

  it('a pending row younger than the settle window is left alone: the earlier holder`s write may still be in flight', async () => {
    const h = harness({ settleMs: PENDING_SETTLE_MS });
    h.effects.set(id(key), pendingRow(1_000_000));
    h.advance(PENDING_SETTLE_MS - 1);
    const apply = vi.fn(async () => 'ok');
    const readBack = vi.fn(async () => ({ applied: false as const }));
    await expect(h.executor.runEffect({ key, payload, fence, apply, readBack })).rejects.toBeInstanceOf(EffectRetryableError);
    expect(readBack).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
    expect(h.effects.get(id(key))?.state).toBe('pending');
  });

  it('after the settle window the read-back is trusted', async () => {
    const h = harness({ settleMs: PENDING_SETTLE_MS });
    h.effects.set(id(key), pendingRow(1_000_000));
    h.advance(PENDING_SETTLE_MS);
    const apply = vi.fn(async () => 'ok');
    expect(await h.executor.runEffect({ key, payload, fence, apply, readBack: async () => ({ applied: false as const }) })).toBe('ok');
  });

  it('the settle window covers the attempt hold cap plus the lease', () => {
    expect(PENDING_SETTLE_MS).toBe(270_000);
  });

  it.each([
    ['an undefined stage', { ...key, stage: undefined }],
    ['a numeric step', { ...key, step: 7 }],
    ['a string stageEntryNo', { ...key, stageEntryNo: '1' }],
    ['a caseKey with DEL', { ...key, caseKey: 'a\x7fb' }],
    ['a stage of 129 characters', { ...key, stage: 'a'.repeat(129) }],
  ])('refuses %s', async (_name, bad) => {
    const { executor } = harness();
    await expect(executor.runEffect({ key: bad as unknown as EffectKey, payload, fence, apply: async () => 'ok' }))
      .rejects.toBeInstanceOf(InvalidEffectKeyError);
  });
});

describe('the payload hash is a persisted value', () => {
  const sha = (text: string) => createHash('sha256').update(text).digest('hex');

  it('sorts keys by code unit, not by locale (golden value)', () => {
    expect(payloadHash({ a: 2, B: 1, _c: 3, é: 4 })).toBe(sha('{"B":1,"_c":3,"a":2,"é":4}'));
  });

  it('two different dates hash differently', () => {
    expect(payloadHash({ at: new Date('2026-10-05T09:00:00Z') })).not.toBe(payloadHash({ at: new Date('2026-10-06T09:00:00Z') }));
  });

  it('an absent payload hashes like null', () => {
    expect(payloadHash(undefined)).toBe(payloadHash(null));
  });

  it.each([
    ['NaN', { n: Number.NaN }],
    ['Infinity', { n: Number.POSITIVE_INFINITY }],
    ['a Map', { m: new Map([['a', 1]]) }],
    ['a Set', { s: new Set([1]) }],
    ['a bigint', { b: 1n }],
    ['a function', { f: () => 1 }],
  ])('refuses %s instead of hashing it like something else', (_name, bad) => {
    expect(() => payloadHash(bad)).toThrow();
  });

  it('a payload the hash refuses never reaches the store or the write', async () => {
    const { executor, effects } = harness();
    const apply = vi.fn(async () => 'ok');
    await expect(executor.runEffect({ key, payload: { n: Number.NaN }, fence, apply })).rejects.toThrow();
    expect(apply).not.toHaveBeenCalled();
    expect(effects.size).toBe(0);
  });
});

describe('a draft must fit one item', () => {
  it('counts bytes, not characters', async () => {
    const { executor, drafts } = harness();
    const draftKey = { ...key, step: 'draft' };
    await expect(executor.saveDraftOnce({ key: draftKey, fence, produce: async () => '漢'.repeat(100_001) })).rejects.toThrow();
    expect(drafts.size).toBe(0);
  });
});
