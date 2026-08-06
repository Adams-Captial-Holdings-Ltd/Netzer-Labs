import { describe, it, expect, vi, beforeEach } from 'vitest';

// Serialized voice spend-ledger (Codex review round 3): overflow top-up, midnight
// rollover, no-double-settle serialization, and refund-only-the-unconsumed.

const { settleTurn, topUp, rolloverReservation, ensureDay, releaseSession, recordUsage } = vi.hoisted(() => ({
  settleTurn: vi.fn(async (_o: string, _d: string, _delta: number) => {}),
  topUp: vi.fn(async (_o: string, _d: string, _x: number) => true),
  rolloverReservation: vi.fn(async (_ctx: unknown) => true),
  ensureDay: vi.fn(async (_d: string, _cap: number) => {}),
  releaseSession: vi.fn(async (_opts: { rem: number }) => {}),
  recordUsage: vi.fn(async (_row: unknown) => true),
}));
vi.mock('./spend-ledger.js', () => ({ settleTurn, topUp, rolloverReservation, ensureDay, utcDate: () => 'd1' }));
vi.mock('../voice/session-leases.js', () => ({ releaseSession }));
vi.mock('../usage/token-tracker.js', () => ({ recordUsage, JARVIS_USAGE_AGENT: 'jarvis' }));

import { VoiceLedger } from './voice-ledger.js';

function build(
  opts: {
    estimate?: number;
    now?: () => number;
    today?: () => string;
    initialDay?: string;
    onSpendCap?: () => void;
  } = {},
) {
  const onSpendCap = opts.onSpendCap ?? vi.fn();
  const ledger = new VoiceLedger({
    ownerId: 'o1',
    tokenHash: 'h',
    chatId: 'c',
    modelId: 'm',
    slotIndex: 0,
    cap: 100,
    estimate: opts.estimate ?? 1,
    initialDay: opts.initialDay ?? 'd1',
    startedAt: 1000,
    usdPerSecond: 0.0001, // tiny floor so the metered cost dominates the math
    leaseTtlSeconds: 60,
    onSpendCap,
    now: opts.now ?? (() => 1000),
    today: opts.today ?? (() => 'd1'),
  });
  return { ledger, onSpendCap };
}

// Sum of the deltas the ledger asked settleTurn to debit.
const settledDelta = (): number => settleTurn.mock.calls.reduce((s, c) => s + (c[2] as number), 0);

describe('VoiceLedger', () => {
  beforeEach(() => {
    settleTurn.mockReset().mockResolvedValue(undefined);
    topUp.mockReset().mockResolvedValue(true);
    rolloverReservation.mockReset().mockResolvedValue(true);
    ensureDay.mockReset().mockResolvedValue(undefined);
    releaseSession.mockReset().mockResolvedValue(undefined);
    recordUsage.mockReset().mockResolvedValue(true);
  });

  it('charges metered cost ABOVE the reservation by topping up (not silently dropping it)', async () => {
    const { ledger } = build({ estimate: 1 });
    ledger.addUsageCost(2.5); // real cost overflows the 1.0 reservation
    await ledger.tick();
    expect(topUp).toHaveBeenCalledWith('o1', 'd1', expect.closeTo(1.5, 6)); // grew by the overflow
    expect(ledger.estimateUsd).toBeCloseTo(2.5, 6);
    expect(ledger.settledUsd).toBeCloseTo(2.5, 6); // the full metered cost is charged
  });

  it('closes spend_cap when the overflow has no headroom, settling up to the cap', async () => {
    topUp.mockResolvedValue(false); // no headroom → cap reject
    const { ledger, onSpendCap } = build({ estimate: 1 });
    ledger.addUsageCost(2.5);
    await ledger.tick();
    expect(onSpendCap).toHaveBeenCalledTimes(1);
    expect(ledger.settledUsd).toBeCloseTo(1, 6); // settled up to the reservation, not beyond
  });

  it('keeps the session alive on a transient topUp error (settles to estimate, retries later)', async () => {
    topUp.mockImplementation(() => Promise.reject(new Error('ddb')));
    const { ledger, onSpendCap } = build({ estimate: 1 });
    ledger.addUsageCost(2.5);
    await ledger.tick();
    expect(onSpendCap).not.toHaveBeenCalled(); // operational error is NOT a cap close
    expect(ledger.settledUsd).toBeCloseTo(1, 6);
  });

  it('seeds the new day before rolling the reservation over at UTC midnight', async () => {
    let day = 'd1';
    const { ledger } = build({ today: () => day });
    ledger.addUsageCost(0.4);
    await ledger.tick(); // settle a bit on d1
    day = 'd2'; // clock crosses midnight
    await ledger.tick();
    expect(ensureDay).toHaveBeenCalledWith('d2', 100);
    expect(rolloverReservation).toHaveBeenCalledTimes(1);
    expect(ledger.currentDay).toBe('d2');
    // ensureDay must run BEFORE the rollover (the missing-row bug).
    expect(ensureDay.mock.invocationCallOrder[0]).toBeLessThan(rolloverReservation.mock.invocationCallOrder[0]);
  });

  it('closes spend_cap when the new day has no headroom for the carry-over', async () => {
    let day = 'd1';
    rolloverReservation.mockResolvedValue(false);
    const { ledger, onSpendCap } = build({ today: () => day });
    day = 'd2';
    await ledger.tick();
    expect(onSpendCap).toHaveBeenCalledTimes(1);
  });

  it('serializes concurrent ticks — never double-settles', async () => {
    settleTurn.mockImplementation(() => new Promise((r) => setTimeout(r, 5))); // slow write widens the race window
    const { ledger } = build({ estimate: 5 });
    ledger.addUsageCost(0.5);
    await Promise.all([ledger.tick(), ledger.tick(), ledger.tick(), ledger.tick(), ledger.tick()]);
    expect(settledDelta()).toBeCloseTo(0.5, 6); // total debited == the target, not 5×
    expect(ledger.settledUsd).toBeCloseTo(0.5, 6);
  });

  it('on a failed final settle, leaves the RES row for the reaper (does NOT release/orphan it)', async () => {
    const { ledger } = build({ estimate: 1 });
    ledger.addUsageCost(0.6); // consumed 0.6 of the 1.0 reservation
    settleTurn.mockImplementation(() => Promise.reject(new Error('ddb'))); // final settle fails
    await ledger.finalize();
    expect(ledger.settledUsd).toBe(0); // nothing confirmed-settled
    // Deleting RES while spend is unsettled would orphan it from the reaper, so
    // releaseSession must NOT be called — the row is left for GSI reaping.
    expect(releaseSession).not.toHaveBeenCalled();
  });

  it('finalize charges final overflow via topUp (final usage above the reservation)', async () => {
    const { ledger } = build({ estimate: 1 });
    ledger.addUsageCost(2); // final metered cost overflows the reservation
    await ledger.finalize();
    expect(topUp).toHaveBeenCalledWith('o1', 'd1', expect.closeTo(1, 6));
    expect(ledger.settledUsd).toBeCloseTo(2, 6); // the overflow is charged, not dropped
    expect(releaseSession).toHaveBeenCalledTimes(1);
  });

  it('settles the OLD day before rolling over (no pre-midnight tail lost)', async () => {
    let day = 'd1';
    const { ledger } = build({ estimate: 1, today: () => day });
    ledger.addUsageCost(0.4); // accrued on d1, never ticked before midnight
    day = 'd2';
    await ledger.tick();
    // d1 was settled (0.4) BEFORE the carry-over, so rollover moves only 0.6.
    expect(settleTurn).toHaveBeenCalledWith('o1', 'd1', expect.closeTo(0.4, 6));
    const roll = rolloverReservation.mock.calls[0][0] as { rem: number; yesterday: string };
    expect(roll.rem).toBeCloseTo(0.6, 6);
    expect(settleTurn.mock.invocationCallOrder[0]).toBeLessThan(rolloverReservation.mock.invocationCallOrder[0]);
  });

  it('binds to the ADMITTED day, not the construction-time day', async () => {
    // Admitted on d1, but the clock already reads d2 when the ledger is built.
    const { ledger } = build({ initialDay: 'd1', today: () => 'd2' });
    await ledger.tick();
    // Because it bound to d1, the first tick rolls d1 → d2 (it would no-op if it
    // had wrongly bound to d2).
    const roll = rolloverReservation.mock.calls[0][0] as { yesterday: string; utcDate: string };
    expect(roll.yesterday).toBe('d1');
    expect(roll.utcDate).toBe('d2');
    expect(ledger.currentDay).toBe('d2');
  });

  it('finalize is idempotent — releases once', async () => {
    const { ledger } = build();
    await ledger.finalize();
    await ledger.finalize();
    expect(releaseSession).toHaveBeenCalledTimes(1);
    expect(ledger.isReleased).toBe(true);
  });
});
