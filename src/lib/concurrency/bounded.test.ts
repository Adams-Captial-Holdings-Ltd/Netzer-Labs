import { describe, it, expect } from 'vitest';
import { runBounded, InFlightGate } from './bounded.js';

describe('runBounded', () => {
  it('preserves result order regardless of completion order', async () => {
    const tasks = [
      () => new Promise<number>((r) => setTimeout(() => r(1), 30)),
      () => new Promise<number>((r) => setTimeout(() => r(2), 5)),
      () => new Promise<number>((r) => setTimeout(() => r(3), 15)),
    ];
    expect(await runBounded(tasks, 2)).toEqual([1, 2, 3]);
  });

  it('never runs more than `limit` tasks concurrently', async () => {
    let inFlight = 0;
    let maxObserved = 0;
    const make = () => async () => {
      inFlight += 1;
      maxObserved = Math.max(maxObserved, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight -= 1;
      return inFlight;
    };
    const tasks = Array.from({ length: 9 }, make);
    await runBounded(tasks, 3);
    expect(maxObserved).toBeLessThanOrEqual(3);
    expect(maxObserved).toBe(3); // it actually saturated the pool
  });

  it('runs all tasks even when there are more tasks than the limit', async () => {
    let ran = 0;
    const tasks = Array.from({ length: 7 }, () => async () => {
      ran += 1;
      return ran;
    });
    const out = await runBounded(tasks, 2);
    expect(ran).toBe(7);
    expect(out).toHaveLength(7);
  });

  it('clamps a non-positive limit to at least 1', async () => {
    const out = await runBounded([async () => 'a', async () => 'b'], 0);
    expect(out).toEqual(['a', 'b']);
  });

  it('rejects on the first task error, like Promise.all', async () => {
    const tasks = [async () => 1, async () => { throw new Error('boom'); }, async () => 3];
    await expect(runBounded(tasks, 2)).rejects.toThrow('boom');
  });

  it('returns [] for an empty task list', async () => {
    expect(await runBounded([], 3)).toEqual([]);
  });
});

describe('InFlightGate', () => {
  it('admits up to max holders and rejects the rest', () => {
    const gate = new InFlightGate(2);
    expect(gate.tryAcquire()).toBe(true);
    expect(gate.tryAcquire()).toBe(true);
    expect(gate.tryAcquire()).toBe(false); // full
    expect(gate.held).toBe(2);
  });

  it('frees a slot on release so a later caller can acquire again', () => {
    const gate = new InFlightGate(1);
    expect(gate.tryAcquire()).toBe(true);
    expect(gate.tryAcquire()).toBe(false);
    gate.release();
    expect(gate.tryAcquire()).toBe(true);
    expect(gate.held).toBe(1);
  });

  it('reserves NOTHING on a rejected acquire (a failed tryAcquire does not consume a slot)', () => {
    const gate = new InFlightGate(1);
    gate.tryAcquire();
    gate.tryAcquire(); // rejected
    gate.tryAcquire(); // rejected
    expect(gate.held).toBe(1);
  });

  it('never drops held below zero on extra releases', () => {
    const gate = new InFlightGate(2);
    gate.release();
    gate.release();
    expect(gate.held).toBe(0);
    expect(gate.tryAcquire()).toBe(true);
  });
});
