/**
 * FROZEN acceptance tests for Work Platform step 5 (ADR 0013, "Deterministic
 * writes only"). The roadmap's named proof: retry and Request-Changes rounds
 * produce no duplicate and no skipped write. Do not edit without the owner's yes.
 *
 * The rows fake below is the whole store contract (`EffectRows`): get, a
 * conditional create, a compare-and-set replace on `version`, the unknown
 * list, and write-once drafts. The executor is the real one.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  createExecutor,
  payloadHash,
  EffectConflictError,
  EffectRetryableError,
  EffectUnknownError,
  InvalidEffectKeyError,
} from './executor.js';
import { effectSortKey, draftSortKey, effectPartitionKey } from './effect-ledger.js';
import type { DraftRow, EffectKey, EffectRow, EffectRows } from './effect-ledger.js';
import { FencedOutError } from '../paperclip/attempt-store.js';

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
  const executor = createExecutor({ rows: store.rows, isDraining: () => false, audit, now: () => 1_000, ...over });
  return { ...store, audit, executor };
}

const key: EffectKey = { caseKey: 'ref-2026-0001', stage: 'intake', step: 'create_record', stageEntryNo: 1 };
const fence = async () => {};
const payload = { patient: 'PATIENT-JANE-DOE', slot: '2026-10-05T09:00' };

describe('one business write per (caseKey, stage, step, stageEntryNo)', () => {
  it('applies once and returns the write`s own result', async () => {
    const { executor, effects } = harness();
    const apply = vi.fn(async () => ({ recordId: 'rec-1' }));
    expect(await executor.runEffect({ key, payload, fence, apply })).toEqual({ recordId: 'rec-1' });
    expect(apply).toHaveBeenCalledTimes(1);
    expect(effects.get(id(key))?.state).toBe('applied');
  });

  it('a retry returns the recorded result and never writes again', async () => {
    const { executor } = harness();
    const apply = vi.fn(async () => ({ recordId: 'rec-1' }));
    await executor.runEffect({ key, payload, fence, apply });
    const again = await executor.runEffect({ key, payload, fence, apply });
    expect(again).toEqual({ recordId: 'rec-1' });
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('a Request-Changes round (the next stageEntryNo) writes exactly once more: none duplicated, none skipped', async () => {
    const { executor } = harness();
    const apply = vi.fn(async () => ({ ok: true }));
    for (const stageEntryNo of [1, 1, 2, 2, 2, 3]) {
      await executor.runEffect({ key: { ...key, stageEntryNo }, payload, fence, apply });
    }
    expect(apply).toHaveBeenCalledTimes(3);
  });

  it('two steps of one stage are separate writes', async () => {
    const { executor } = harness();
    const apply = vi.fn(async () => 'ok');
    await executor.runEffect({ key, payload, fence, apply });
    await executor.runEffect({ key: { ...key, step: 'notify' }, payload, fence, apply });
    expect(apply).toHaveBeenCalledTimes(2);
  });

  it('two runs racing on one key write once; the loser never applies', async () => {
    const { executor } = harness();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const apply = vi.fn(async () => { await gate; return 'ok'; });
    const first = executor.runEffect({ key, payload, fence, apply }).catch((err: unknown) => err);
    const second = executor.runEffect({ key, payload, fence, apply }).catch((err: unknown) => err);
    await new Promise((resolve) => setTimeout(resolve, 5));
    release();
    await first;
    // The second holder cannot tell whether the first one's write went out, so it stops for a person.
    expect(await second).toBeInstanceOf(EffectUnknownError);
    // Whatever the first holder's own call returned, no later run may write again.
    await executor.runEffect({ key, payload, fence, apply }).catch(() => {});
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('the same key with a different payload is refused and nothing is written', async () => {
    const { executor } = harness();
    const apply = vi.fn(async () => 'ok');
    await executor.runEffect({ key, payload, fence, apply });
    await expect(executor.runEffect({ key, payload: { ...payload, slot: 'other' }, fence, apply }))
      .rejects.toBeInstanceOf(EffectConflictError);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('the payload hash ignores key order and differs on any value change', () => {
    expect(payloadHash({ a: 1, b: { c: 2, d: 3 } })).toBe(payloadHash({ b: { d: 3, c: 2 }, a: 1 }));
    expect(payloadHash({ a: 1 })).not.toBe(payloadHash({ a: 2 }));
    expect(payloadHash({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('a write whose outcome is not known is never retried blind', () => {
  it('an error that may have gone out leaves `unknown`; later runs stop without writing', async () => {
    const { executor, effects } = harness();
    const apply = vi.fn(async () => { throw new Error('socket hang up'); });
    await expect(executor.runEffect({ key, payload, fence, apply })).rejects.toBeInstanceOf(EffectUnknownError);
    expect(effects.get(id(key))?.state).toBe('unknown');
    await expect(executor.runEffect({ key, payload, fence, apply })).rejects.toBeInstanceOf(EffectUnknownError);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('an error the client provably never sent (`notSent`) is retryable, and the retry writes once', async () => {
    const { executor } = harness();
    const notSent = Object.assign(new Error('breaker open'), { notSent: true });
    const apply = vi.fn<() => Promise<string>>().mockRejectedValueOnce(notSent).mockResolvedValue('ok');
    await expect(executor.runEffect({ key, payload, fence, apply })).rejects.toBeInstanceOf(EffectRetryableError);
    expect(await executor.runEffect({ key, payload, fence, apply })).toBe('ok');
    expect(apply).toHaveBeenCalledTimes(2);
  });

  it('a row left `pending` by a dead holder becomes `unknown` when the step cannot read back', async () => {
    const { executor, effects } = harness();
    effects.set(id(key), { kind: 'effect', key, state: 'pending', payloadHash: payloadHash(payload), version: 1, createdAt: 1, updatedAt: 1 });
    const apply = vi.fn(async () => 'ok');
    await expect(executor.runEffect({ key, payload, fence, apply })).rejects.toBeInstanceOf(EffectUnknownError);
    expect(apply).not.toHaveBeenCalled();
    expect(effects.get(id(key))?.state).toBe('unknown');
  });

  it('read-before-retry: a pending write the target already has is recorded, not repeated', async () => {
    const { executor, effects } = harness();
    effects.set(id(key), { kind: 'effect', key, state: 'pending', payloadHash: payloadHash(payload), version: 1, createdAt: 1, updatedAt: 1 });
    const apply = vi.fn(async () => 'fresh');
    const readBack = vi.fn(async () => ({ applied: true as const, result: 'already-there' }));
    expect(await executor.runEffect({ key, payload, fence, apply, readBack })).toBe('already-there');
    expect(apply).not.toHaveBeenCalled();
    expect(effects.get(id(key))?.state).toBe('applied');
  });

  it('read-before-retry: a pending write the target does not have is applied once', async () => {
    const { executor, effects } = harness();
    effects.set(id(key), { kind: 'effect', key, state: 'pending', payloadHash: payloadHash(payload), version: 1, createdAt: 1, updatedAt: 1 });
    const apply = vi.fn(async () => 'fresh');
    expect(await executor.runEffect({ key, payload, fence, apply, readBack: async () => ({ applied: false as const }) })).toBe('fresh');
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('read-before-retry that cannot tell, or throws, ends `unknown` without writing', async () => {
    for (const readBack of [async () => 'unknown' as const, async () => { throw new Error('read failed'); }]) {
      const { executor, effects } = harness();
      effects.set(id(key), { kind: 'effect', key, state: 'pending', payloadHash: payloadHash(payload), version: 1, createdAt: 1, updatedAt: 1 });
      const apply = vi.fn(async () => 'fresh');
      await expect(executor.runEffect({ key, payload, fence, apply, readBack })).rejects.toBeInstanceOf(EffectUnknownError);
      expect(apply).not.toHaveBeenCalled();
      expect(effects.get(id(key))?.state).toBe('unknown');
    }
  });

  it('the write succeeded but recording it failed: the row is not `applied`, and the next run does not write blind', async () => {
    const store = memoryRows();
    const replace = store.rows.replace;
    let failNext = true;
    store.rows.replace = async (...args) => { if (failNext) { failNext = false; throw new Error('store down'); } return replace(...args); };
    const { executor } = harness({ rows: store.rows });
    const apply = vi.fn(async () => 'ok');
    await expect(executor.runEffect({ key, payload, fence, apply })).rejects.toThrow();
    await expect(executor.runEffect({ key, payload, fence, apply })).rejects.toBeInstanceOf(EffectUnknownError);
    expect(apply).toHaveBeenCalledTimes(1);
  });
});

describe('fencing, drain and the store fail closed', () => {
  it('a fenced-out holder writes nothing: no ledger row, no business write', async () => {
    const { executor, effects } = harness();
    const apply = vi.fn(async () => 'ok');
    const fencedOut = async () => { throw new FencedOutError(); };
    await expect(executor.runEffect({ key, payload, fence: fencedOut, apply })).rejects.toBeInstanceOf(FencedOutError);
    expect(apply).not.toHaveBeenCalled();
    expect(effects.size).toBe(0);
  });

  it('a holder fenced out DURING the write does not record it as applied', async () => {
    const { executor, effects } = harness();
    let calls = 0;
    const fenceOnce = async () => { if (++calls > 1) throw new FencedOutError(); };
    await expect(executor.runEffect({ key, payload, fence: fenceOnce, apply: async () => 'ok' })).rejects.toBeInstanceOf(FencedOutError);
    expect(effects.get(id(key))?.state).not.toBe('applied');
  });

  it('no new write starts while the task is draining, and it is retryable', async () => {
    const { executor, effects } = harness({ isDraining: () => true });
    const apply = vi.fn(async () => 'ok');
    await expect(executor.runEffect({ key, payload, fence, apply })).rejects.toBeInstanceOf(EffectRetryableError);
    expect(apply).not.toHaveBeenCalled();
    expect(effects.size).toBe(0);
  });

  it('a recorded result is still returned while draining (a replay is not a new write)', async () => {
    let draining = false;
    const { executor } = harness({ isDraining: () => draining });
    await executor.runEffect({ key, payload, fence, apply: async () => 'ok' });
    draining = true;
    expect(await executor.runEffect({ key, payload, fence, apply: async () => 'never' })).toBe('ok');
  });

  it('a store error before the write propagates and nothing is written', async () => {
    const store = memoryRows();
    store.rows.get = async () => { throw new Error('store down'); };
    const { executor } = harness({ rows: store.rows });
    const apply = vi.fn(async () => 'ok');
    await expect(executor.runEffect({ key, payload, fence, apply })).rejects.toThrow('store down');
    expect(apply).not.toHaveBeenCalled();
  });

  it.each([
    ['a `#` in the stage', { ...key, stage: 'in#take' }],
    ['a `#` in the step', { ...key, step: 'a#b' }],
    ['an empty caseKey', { ...key, caseKey: '' }],
    ['a caseKey over 256 characters', { ...key, caseKey: 'x'.repeat(257) }],
    ['a caseKey with a control character', { ...key, caseKey: 'a\nb' }],
    ['an uppercase stage', { ...key, stage: 'Intake' }],
    ['stageEntryNo zero', { ...key, stageEntryNo: 0 }],
    ['a fractional stageEntryNo', { ...key, stageEntryNo: 1.5 }],
    ['a reserved prototype name as the step', { ...key, step: '__proto__' }],
  ])('refuses %s before any store call', async (_name, bad) => {
    const { executor, effects } = harness();
    const apply = vi.fn(async () => 'ok');
    await expect(executor.runEffect({ key: bad as EffectKey, payload, fence, apply })).rejects.toBeInstanceOf(InvalidEffectKeyError);
    expect(apply).not.toHaveBeenCalled();
    expect(effects.size).toBe(0);
  });

  it('the frozen key shape: PK CASE#<caseKey>, SK EFFECT#<stage>#<step>#<stageEntryNo>, drafts under DRAFT#', () => {
    expect(effectPartitionKey(key)).toBe('CASE#ref-2026-0001');
    expect(effectSortKey(key)).toBe('EFFECT#intake#create_record#1');
    expect(draftSortKey({ ...key, step: 'draft', stageEntryNo: 12 })).toBe('DRAFT#intake#draft#12');
  });
});

describe('audit: IDs and hashes only, and never silent', () => {
  it('an applied write leaves one audit row with the correlation IDs and hashes, and no payload or result', async () => {
    const { executor, audit } = harness();
    await executor.runEffect({
      key, payload, fence, apply: async () => ({ note: 'RESULT-SECRET-TEXT' }),
      correlation: { issueId: 'iss-1', runId: 'run-1', attemptNo: 2, turnId: 'turn-1', agentId: 'intake-agent' },
    });
    expect(audit).toHaveBeenCalledTimes(1);
    const event = audit.mock.calls[0][0];
    expect(event.action).toBe('effect_applied');
    expect(event.detail).toMatchObject({
      caseKey: key.caseKey, stage: 'intake', step: 'create_record', stageEntryNo: 1,
      payloadHash: payloadHash(payload), issueId: 'iss-1', runId: 'run-1', attemptNo: 2, turnId: 'turn-1',
    });
    const text = JSON.stringify(event);
    expect(text).not.toContain('PATIENT-JANE-DOE');
    expect(text).not.toContain('RESULT-SECRET-TEXT');
  });

  it('a replay writes no second audit row', async () => {
    const { executor, audit } = harness();
    await executor.runEffect({ key, payload, fence, apply: async () => 'ok' });
    await executor.runEffect({ key, payload, fence, apply: async () => 'ok' });
    expect(audit).toHaveBeenCalledTimes(1);
  });

  it('a failed audit write is loud, the write stays recorded, and a retry does not write again', async () => {
    const audit = vi.fn().mockRejectedValueOnce(new Error('audit down')).mockResolvedValue(undefined);
    const { executor, effects } = harness({ audit });
    const apply = vi.fn(async () => 'ok');
    await expect(executor.runEffect({ key, payload, fence, apply })).rejects.toThrow('audit down');
    expect(effects.get(id(key))?.state).toBe('applied');
    expect(await executor.runEffect({ key, payload, fence, apply })).toBe('ok');
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('an unknown outcome is audited without the payload', async () => {
    const { executor, audit } = harness();
    await executor.runEffect({ key, payload, fence, apply: async () => { throw new Error('boom PATIENT-JANE-DOE'); } }).catch(() => {});
    const events = audit.mock.calls.map(([event]) => event);
    expect(events.map((event) => event.action)).toEqual(['effect_unknown']);
    expect(JSON.stringify(events)).not.toContain('PATIENT-JANE-DOE');
  });
});

describe('effect resolve: a person clears an unknown outcome', () => {
  async function unknownRow() {
    const h = harness();
    await h.executor.runEffect({ key, payload, fence, apply: async () => { throw new Error('lost'); } }).catch(() => {});
    h.audit.mockClear();
    return h;
  }

  it('lists the unknown rows', async () => {
    const { executor } = await unknownRow();
    const list = await executor.listUnknown();
    expect(list.map((row) => row.key)).toEqual([key]);
  });

  it('resolved as applied: later runs return without writing, and the decision is audited with who made it', async () => {
    const { executor, audit } = await unknownRow();
    await executor.resolve(key, 'applied', 'user-ana');
    const apply = vi.fn(async () => 'never');
    await executor.runEffect({ key, payload, fence, apply });
    expect(apply).not.toHaveBeenCalled();
    expect(audit.mock.calls[0][0]).toMatchObject({ action: 'effect_resolved', userId: 'user-ana', detail: { outcome: 'applied' } });
    expect(await executor.listUnknown()).toEqual([]);
  });

  it('resolved as not applied: the next run writes exactly once', async () => {
    const { executor } = await unknownRow();
    await executor.resolve(key, 'not_applied', 'user-ana');
    const apply = vi.fn(async () => 'ok');
    expect(await executor.runEffect({ key, payload, fence, apply })).toBe('ok');
    await executor.runEffect({ key, payload, fence, apply });
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('refuses to resolve a row that is not unknown, a missing row, or an empty resolver', async () => {
    const { executor } = harness();
    await expect(executor.resolve(key, 'applied', 'user-ana')).rejects.toThrow();
    await executor.runEffect({ key, payload, fence, apply: async () => 'ok' });
    await expect(executor.resolve(key, 'not_applied', 'user-ana')).rejects.toThrow();
    const again = await unknownRow();
    await expect(again.executor.resolve(key, 'applied', '')).rejects.toThrow();
  });

  it('a failed audit write fails the resolve call (a human decision is never silent)', async () => {
    const h = await unknownRow();
    h.audit.mockRejectedValueOnce(new Error('audit down'));
    await expect(h.executor.resolve(key, 'applied', 'user-ana')).rejects.toThrow('audit down');
  });
});

describe('frozen drafts: saved once per (case, stage, step, round), never regenerated', () => {
  const draftKey: EffectKey = { ...key, step: 'draft' };

  it('saves the first draft and returns it on every later call without producing again', async () => {
    const { executor } = harness();
    const produce = vi.fn<() => Promise<string>>().mockResolvedValueOnce('first draft').mockResolvedValue('second draft');
    expect(await executor.saveDraftOnce({ key: draftKey, fence, produce })).toBe('first draft');
    expect(await executor.saveDraftOnce({ key: draftKey, fence, produce })).toBe('first draft');
    expect(produce).toHaveBeenCalledTimes(1);
  });

  it('a new round gets its own draft', async () => {
    const { executor } = harness();
    const produce = vi.fn<() => Promise<string>>().mockResolvedValueOnce('round one').mockResolvedValueOnce('round two');
    await executor.saveDraftOnce({ key: draftKey, fence, produce });
    expect(await executor.saveDraftOnce({ key: { ...draftKey, stageEntryNo: 2 }, fence, produce })).toBe('round two');
  });

  it('two producers racing: both callers get the one saved draft', async () => {
    const { executor } = harness();
    const a = executor.saveDraftOnce({ key: draftKey, fence, produce: async () => 'draft A' });
    const b = executor.saveDraftOnce({ key: draftKey, fence, produce: async () => 'draft B' });
    const [first, second] = await Promise.all([a, b]);
    expect(first).toBe(second);
  });

  it('a fenced-out holder saves no draft', async () => {
    const { executor, drafts } = harness();
    const produce = vi.fn(async () => 'draft');
    await expect(executor.saveDraftOnce({ key: draftKey, fence: async () => { throw new FencedOutError(); }, produce }))
      .rejects.toBeInstanceOf(FencedOutError);
    expect(drafts.size).toBe(0);
  });

  it('a draft is not an effect: it is never listed as unknown and writes no audit row (its text is not for the audit store)', async () => {
    const { executor, audit, effects } = harness();
    await executor.saveDraftOnce({ key: draftKey, fence, produce: async () => 'PATIENT-JANE-DOE draft' });
    expect(await executor.listUnknown()).toEqual([]);
    expect(effects.size).toBe(0);
    expect(JSON.stringify(audit.mock.calls)).not.toContain('PATIENT-JANE-DOE');
  });

  it('refuses a draft over 300 000 characters instead of truncating it', async () => {
    const { executor, drafts } = harness();
    await expect(executor.saveDraftOnce({ key: draftKey, fence, produce: async () => 'x'.repeat(300_001) })).rejects.toThrow();
    expect(drafts.size).toBe(0);
  });
});
