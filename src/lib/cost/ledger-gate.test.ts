import { describe, it, expect, vi, beforeEach } from 'vitest';

const capState = { enforced: false, capUsd: 20 };
vi.mock('../state/cost-cap-repo.js', () => ({
  isCostCapEnforced: () => Promise.resolve(capState.enforced),
  getEffectiveCostCap: () => Promise.resolve(capState.capUsd),
}));

const config = new Map<string, string>();
vi.mock('../state/runtime-config-repo.js', () => ({
  getConfig: (category: string, key: string) => Promise.resolve(config.get(`${category}/${key}`)),
}));

const dailySpend = vi.fn<() => Promise<number>>();
vi.mock('../usage/token-tracker.js', async (importActual) => {
  const actual = await importActual<typeof import('../usage/token-tracker.js')>();
  return { ...actual, getDailyCostUsd: () => dailySpend() };
});

const ledger = {
  reserve: vi.fn(),
  settle: vi.fn(),
  release: vi.fn(),
};
vi.mock('./spend-ledger.js', async (importActual) => {
  const actual = await importActual<typeof import('./spend-ledger.js')>();
  return {
    ...actual,
    reserve: (...a: unknown[]) => ledger.reserve(...a),
    settle: (...a: unknown[]) => ledger.settle(...a),
    release: (...a: unknown[]) => ledger.release(...a),
  };
});

const seats = { getSeatForUser: vi.fn(), putSeatUsage: vi.fn() };
vi.mock('../admin/seat-repo.js', () => ({
  getSeatForUser: (...a: unknown[]) => seats.getSeatForUser(...a),
  putSeatUsage: (...a: unknown[]) => seats.putSeatUsage(...a),
}));

vi.mock('../state/ddb.js', () => ({ ddb: () => ({ send: vi.fn() }) }));
vi.mock('../../observability/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { admitTurnSpend } from './ledger-gate.js';
import { SpendIndeterminateError } from '../usage/token-tracker.js';

beforeEach(() => {
  capState.enforced = false;
  capState.capUsd = 20;
  config.clear();
  dailySpend.mockReset();
  ledger.reserve.mockReset();
  ledger.settle.mockReset();
  ledger.release.mockReset();
  seats.getSeatForUser.mockReset();
  seats.getSeatForUser.mockResolvedValue(null);
  seats.putSeatUsage.mockReset();
  seats.putSeatUsage.mockResolvedValue(undefined);
});

describe('cap not enforced', () => {
  it('admits without touching counter or ledger', async () => {
    const admission = await admitTurnSpend({ idempotencyKey: 'k1' });
    expect(admission.admitted).toBe(true);
    expect(dailySpend).not.toHaveBeenCalled();
    expect(ledger.reserve).not.toHaveBeenCalled();
  });

  it('finalize still writes seat attribution (attribution is not capping)', async () => {
    seats.getSeatForUser.mockResolvedValue({ seatId: 'seat-1', policyId: 'pol-1' });
    const admission = await admitTurnSpend({
      idempotencyKey: 'k2',
      attribution: { dashboardUserId: 'user-1', sessionId: 'chat-9' },
    });
    await admission.finalize({ costUsd: 0.02, modelId: 'm', inputTokens: 10, outputTokens: 5 });
    expect(seats.putSeatUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        seatId: 'seat-1',
        userId: 'user-1',
        policyId: 'pol-1',
        policyOutcome: 'allowed',
        estimatedCostUsd: 0.02,
        sessionId: 'chat-9',
      }),
    );
  });

  it('no attribution row without a dashboardUserId or without a seat', async () => {
    const a1 = await admitTurnSpend({ idempotencyKey: 'k3' });
    await a1.finalize({ costUsd: 0.01 });
    const a2 = await admitTurnSpend({
      idempotencyKey: 'k4',
      attribution: { dashboardUserId: 'user-without-seat' },
    });
    await a2.finalize({ costUsd: 0.01 });
    expect(seats.putSeatUsage).not.toHaveBeenCalled();
  });
});

describe('cap enforced, ledger NOT armed (legacy strict counter)', () => {
  beforeEach(() => {
    capState.enforced = true;
  });

  it('admits under the cap', async () => {
    dailySpend.mockResolvedValue(3);
    const admission = await admitTurnSpend({ idempotencyKey: 'k5' });
    expect(admission.admitted).toBe(true);
    expect(ledger.reserve).not.toHaveBeenCalled();
  });

  it('blocks at/over the cap with the recorded spend', async () => {
    dailySpend.mockResolvedValue(20);
    const admission = await admitTurnSpend({ idempotencyKey: 'k6' });
    expect(admission.admitted).toBe(false);
    expect(admission.blocked).toEqual({ reason: 'cap_exceeded', capUsd: 20, spendUsd: 20 });
  });

  it('fails CLOSED on an indeterminate day total', async () => {
    dailySpend.mockRejectedValue(new SpendIndeterminateError('partial'));
    const admission = await admitTurnSpend({ idempotencyKey: 'k7' });
    expect(admission.admitted).toBe(false);
    expect(admission.blocked?.reason).toBe('spend_indeterminate');
  });

  it('a non-finite cap admits (matches the pre-gate behavior)', async () => {
    capState.capUsd = Number.NaN;
    const admission = await admitTurnSpend({ idempotencyKey: 'k8' });
    expect(admission.admitted).toBe(true);
    expect(dailySpend).not.toHaveBeenCalled();
  });
});

describe('cap enforced, ledger armed', () => {
  beforeEach(() => {
    capState.enforced = true;
    config.set('cost/ledger_enabled', 'true');
  });

  it('reserves the tunable worst case and settles actuals', async () => {
    config.set('cost/ledger_reserve_usd', '0.25');
    ledger.reserve.mockResolvedValue({ ok: true, reservationId: 'k9' });
    const admission = await admitTurnSpend({ idempotencyKey: 'k9' });
    expect(admission.admitted).toBe(true);
    expect(ledger.reserve).toHaveBeenCalledWith(
      expect.objectContaining({ capUsd: 20, worstCaseUsd: 0.25, idempotencyKey: 'k9' }),
    );
    expect(dailySpend).not.toHaveBeenCalled();

    await admission.finalize({ costUsd: 0.03 });
    expect(ledger.settle).toHaveBeenCalledWith(
      expect.objectContaining({ reservationId: 'k9', actualUsd: 0.03 }),
    );
  });

  it('blocks on cap_exceeded and on store_unavailable (fail closed)', async () => {
    ledger.reserve.mockResolvedValueOnce({ ok: false, reason: 'cap_exceeded' });
    const capped = await admitTurnSpend({ idempotencyKey: 'k10' });
    expect(capped.admitted).toBe(false);
    expect(capped.blocked?.reason).toBe('cap_exceeded');

    ledger.reserve.mockResolvedValueOnce({ ok: false, reason: 'store_unavailable' });
    const outage = await admitTurnSpend({ idempotencyKey: 'k11' });
    expect(outage.admitted).toBe(false);
    expect(outage.blocked?.reason).toBe('store_unavailable');
  });

  it('abort releases the hold; finalize-then-abort never releases', async () => {
    ledger.reserve.mockResolvedValue({ ok: true, reservationId: 'k12' });
    const a1 = await admitTurnSpend({ idempotencyKey: 'k12' });
    await a1.abort();
    expect(ledger.release).toHaveBeenCalledTimes(1);

    ledger.release.mockClear();
    const a2 = await admitTurnSpend({ idempotencyKey: 'k13' });
    await a2.finalize({ costUsd: 0.01 });
    await a2.abort();
    expect(ledger.release).not.toHaveBeenCalled();
    expect(ledger.settle).toHaveBeenCalledTimes(1);
  });

  it('finalize is one-shot (a second call neither settles nor attributes twice)', async () => {
    seats.getSeatForUser.mockResolvedValue({ seatId: 's', policyId: 'p' });
    ledger.reserve.mockResolvedValue({ ok: true, reservationId: 'k14' });
    const admission = await admitTurnSpend({
      idempotencyKey: 'k14',
      attribution: { dashboardUserId: 'u' },
    });
    await admission.finalize({ costUsd: 0.01 });
    await admission.finalize({ costUsd: 0.01 });
    expect(ledger.settle).toHaveBeenCalledTimes(1);
    expect(seats.putSeatUsage).toHaveBeenCalledTimes(1);
  });

  it('a failed settle is contained (reply path never throws)', async () => {
    ledger.reserve.mockResolvedValue({ ok: true, reservationId: 'k15' });
    ledger.settle.mockRejectedValue(new Error('ddb down'));
    const admission = await admitTurnSpend({ idempotencyKey: 'k15' });
    await expect(admission.finalize({ costUsd: 0.01 })).resolves.toBeUndefined();
  });

  it('a garbage reserve tunable falls back to the 0.5 default', async () => {
    config.set('cost/ledger_reserve_usd', 'banana');
    ledger.reserve.mockResolvedValue({ ok: true, reservationId: 'k16' });
    await admitTurnSpend({ idempotencyKey: 'k16' });
    expect(ledger.reserve).toHaveBeenCalledWith(
      expect.objectContaining({ worstCaseUsd: 0.5 }),
    );
  });
});
