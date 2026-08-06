import { describe, it, expect } from 'vitest';
import { costCapResponse } from './handler.js';
import { CostCapExceededError } from '../../agent/agent-loop.js';

/**
 * The agent-turn routes (POST /test-turn, /test-turn/stream) must translate a
 * cost-cap enforcement refusal into a clean 503, NOT a generic 500 turn_failed.
 * runAgentTurn throws CostCapExceededError both when spend is over the cap (real
 * spendUsd) and when the strict spend read is indeterminate (spendUsd = NaN, the
 * fail-closed path). The route delegates the mapping to the pure costCapResponse
 * helper, which is exercised directly here (no router/agent-loop mocking, so this
 * is deterministic across local and CI runners).
 */
describe('costCapResponse mapping', () => {
  it('maps an over-cap error to 503 cost_cap_exceeded with figures', () => {
    const mapped = costCapResponse(new CostCapExceededError(61.5, 50));
    expect(mapped.status).toBe(503);
    expect(mapped.body).toEqual({ error: 'cost_cap_exceeded', spendUsd: 61.5, capUsd: 50 });
  });

  it('maps an INDETERMINATE (NaN spend) error to 503 cost_cap_unverifiable, never a NaN figure', () => {
    const mapped = costCapResponse(new CostCapExceededError(Number.NaN, 50));
    expect(mapped.status).toBe(503);
    expect(mapped.body).toEqual({ error: 'cost_cap_unverifiable', capUsd: 50 });
    expect(mapped.body).not.toHaveProperty('spendUsd');
    expect(mapped.body.error).not.toBe('turn_failed');
  });
});
