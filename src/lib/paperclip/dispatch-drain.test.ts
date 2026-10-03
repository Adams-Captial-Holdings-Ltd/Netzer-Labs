import { beforeEach, describe, expect, it } from 'vitest';
import { __resetDispatchDrainForTest, beginDispatchDrain, isDispatchDraining } from './dispatch-drain.js';

describe('dispatch drain', () => {
  beforeEach(__resetDispatchDrainForTest);
  it('starts open', () => expect(isDispatchDraining()).toBe(false));
  it('closes on begin', () => { beginDispatchDrain(); expect(isDispatchDraining()).toBe(true); });
  it('can reset for the next test', () => { beginDispatchDrain(); __resetDispatchDrainForTest(); expect(isDispatchDraining()).toBe(false); });
});
