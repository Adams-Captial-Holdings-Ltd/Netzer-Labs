import { describe, it, expect } from 'vitest';
import { NOVA_SONIC_PRICING, novaSonicTurnCost } from './models.js';

describe('novaSonicTurnCost (per-token, §1c verified)', () => {
  it('uses the verified per-1K rates', () => {
    expect(NOVA_SONIC_PRICING).toEqual({
      speechInputPer1K: 0.0034,
      speechOutputPer1K: 0.0136,
      textInputPer1K: 0.00006,
      textOutputPer1K: 0.00024,
    });
  });

  it('sums speech + text in/out correctly', () => {
    // 1K speech in + 1K speech out + 1K text in + 1K text out
    const cost = novaSonicTurnCost(1000, 1000, 1000, 1000);
    expect(cost).toBeCloseTo(0.0034 + 0.0136 + 0.00006 + 0.00024, 8);
  });

  it('is zero for an empty turn and scales linearly', () => {
    expect(novaSonicTurnCost(0, 0, 0, 0)).toBe(0);
    expect(novaSonicTurnCost(2000, 0, 0, 0)).toBeCloseTo(0.0068, 8);
  });
});
