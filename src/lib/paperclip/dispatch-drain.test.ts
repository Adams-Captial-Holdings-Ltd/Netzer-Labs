import { beforeEach, describe, expect, it } from 'vitest';
import { __resetDispatchDrainForTest, beginDispatchDrain, isDispatchDraining, trackDispatch, dispatchesIdle, dispatchesInFlight } from './dispatch-drain.js';

describe('dispatch drain', () => {
  beforeEach(__resetDispatchDrainForTest);
  it('starts open', () => expect(isDispatchDraining()).toBe(false));
  it('closes on begin', () => { beginDispatchDrain(); expect(isDispatchDraining()).toBe(true); });
  it('can reset for the next test', () => { beginDispatchDrain(); __resetDispatchDrainForTest(); expect(isDispatchDraining()).toBe(false); });
  it('waits for two holds, counts an idempotent release once, and wakes at zero', async () => {
    const first = trackDispatch(); const second = trackDispatch();
    expect(dispatchesInFlight()).toBe(2);
    let idle = false;
    void dispatchesIdle().then(() => { idle = true; });
    first(); first();
    await Promise.resolve();
    expect(dispatchesInFlight()).toBe(1);
    expect(idle).toBe(false);
    second();
    await dispatchesIdle();
    expect(dispatchesInFlight()).toBe(0);
    expect(idle).toBe(true);
  });
  it('is idle immediately at zero, and reset wakes a waiter', async () => {
    await dispatchesIdle();
    trackDispatch();
    const idle = dispatchesIdle();
    __resetDispatchDrainForTest();
    await idle;
    expect(dispatchesInFlight()).toBe(0);
  });
});
