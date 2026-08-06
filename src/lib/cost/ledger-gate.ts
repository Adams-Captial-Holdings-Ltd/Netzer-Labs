/**
 * The ONE admission seam between "a paid Bedrock turn is about to run" and
 * "money is spent" (Afroz review C2-full, invariant I3; closes #15).
 *
 * Every agent turn calls admitTurnSpend() BEFORE any Bedrock call and gets an
 * admission handle carrying finalize()/abort(). Three regimes, decided here so
 * callers hold no policy:
 *
 *  1. Cap not enforced (cost/cap_enabled off AND cost_cap_per_day switch off):
 *     admitted immediately. finalize() still writes per-seat attribution —
 *     attribution is accounting, not capping, and must not depend on the cap.
 *
 *  2. Cap enforced, ledger NOT armed (cost/ledger_enabled != 'true'): the
 *     legacy soft cap — a strict read of the day's recorded spend vs the cap.
 *     Fail-closed on an indeterminate total, exactly the behavior this block
 *     replaced in agent-loop.ts. This is the prod path until the spend-ledger
 *     table is deployed and the flag is flipped.
 *
 *  3. Cap enforced AND ledger armed: the atomic reserve-before-spend gate
 *     (spend-ledger.ts). reserve() holds worst-case headroom in ONE conditional
 *     transaction, so N tasks admitting concurrently can never collectively
 *     overshoot the cap the way the cached counter could. Fail-CLOSED: a store
 *     error blocks the turn (the cap being unenforceable must not mean
 *     "spend freely"). finalize() settles actual cost; abort() releases the
 *     hold when the turn dies before spending.
 *
 * Known bounded gaps, on purpose:
 *  - A turn that fails AFTER partial Bedrock spend releases its whole hold, so
 *    the ledger under-counts that rare turn. The token-tracker daily counter
 *    (which records per-round usage) remains the reporting truth; the ledger
 *    is the admission gate. Erring toward release keeps failed turns from
 *    permanently burning headroom.
 *  - The day item pins its cap at first admission of the day; a cap change
 *    applies from the next UTC day (or after a manual day-item delete).
 *
 * Per-seat attribution (absorbed from PR #42): when the turn carries a
 * dashboard user id that holds a seat, finalize() writes a SeatUsage row
 * (model, tokens, cost, policy, outcome 'allowed'). Fire-and-forget with a
 * loud log on failure — attribution must never break a reply.
 */

import { randomUUID } from 'node:crypto';
import { ddb } from '../state/ddb.js';
import { logger } from '../../observability/logger.js';
import { getConfig } from '../state/runtime-config-repo.js';
import { getEffectiveCostCap, isCostCapEnforced } from '../state/cost-cap-repo.js';
import { getDailyCostUsd, SpendIndeterminateError } from '../usage/token-tracker.js';
import { reserve, settle, release, utcDay } from './spend-ledger.js';
import { getSeatForUser } from '../admin/seat-repo.js';
import { putSeatUsage } from '../admin/seat-repo.js';

/** Conservative per-turn worst case when no tunable is set. A heavy tool turn
 * on Sonnet runs a few cents; $0.50 leaves generous slack without letting one
 * admission hold a meaningful slice of a small daily cap. */
const DEFAULT_WORST_CASE_USD = 0.5;

export interface TurnSpendActuals {
  costUsd: number;
  modelId?: string;
  inputTokens?: number;
  outputTokens?: number;
}

export interface TurnSpendAttribution {
  /** users-table userId (dashboard principal) — NOT the surface speaker id. */
  dashboardUserId?: string;
  /** Session identity recorded on the attribution row (chatId). */
  sessionId?: string;
}

export interface TurnSpendBlock {
  reason: 'cap_exceeded' | 'store_unavailable' | 'spend_indeterminate';
  capUsd: number;
  /** The recorded day spend, when the legacy counter produced one. */
  spendUsd?: number;
}

export interface TurnSpendAdmission {
  admitted: boolean;
  blocked?: TurnSpendBlock;
  /** Settle actual cost + write attribution. Idempotent; never throws. */
  finalize(actuals: TurnSpendActuals): Promise<void>;
  /** Release an un-spent hold (turn died before/without spend). Never throws. */
  abort(): Promise<void>;
}

function ledgerStore() {
  return {
    send: (command: unknown) => (ddb() as { send: (c: unknown) => Promise<unknown> }).send(command),
    ...(process.env.TABLE_SPEND_LEDGER ? { tableName: process.env.TABLE_SPEND_LEDGER } : {}),
  };
}

async function ledgerArmed(): Promise<boolean> {
  try {
    return (await getConfig('cost', 'ledger_enabled')) === 'true';
  } catch {
    // The ARM decision fails soft to the legacy path (which itself fails
    // closed on an unreadable counter) so a config blip cannot brick turns.
    return false;
  }
}

async function worstCaseUsd(): Promise<number> {
  try {
    const raw = await getConfig('cost', 'ledger_reserve_usd');
    const n = Number(raw);
    if (raw !== undefined && raw.trim() !== '' && Number.isFinite(n) && n > 0) return n;
  } catch {
    // fall through to default
  }
  return DEFAULT_WORST_CASE_USD;
}

/** Write the per-seat attribution row when the turn maps to a seat. */
async function writeAttribution(
  attribution: TurnSpendAttribution | undefined,
  actuals: TurnSpendActuals,
): Promise<void> {
  const userId = attribution?.dashboardUserId;
  if (!userId) return;
  try {
    const seat = await getSeatForUser(userId);
    if (!seat) return;
    const createdAt = new Date().toISOString();
    await putSeatUsage({
      usageId: randomUUID(),
      seatId: seat.seatId,
      userId,
      model: actuals.modelId ?? 'unknown',
      inputTokens: actuals.inputTokens ?? 0,
      outputTokens: actuals.outputTokens ?? 0,
      estimatedCostUsd: actuals.costUsd,
      policyId: seat.policyId,
      policyOutcome: 'allowed',
      ...(attribution?.sessionId ? { sessionId: attribution.sessionId } : {}),
      createdAt,
    });
  } catch (err) {
    logger.warn(
      { errMessage: err instanceof Error ? err.message : String(err), userId },
      'seat usage attribution write failed (reply unaffected)',
    );
  }
}

const NOOP_ABORT = async (): Promise<void> => {};

function admittedWithoutLedger(attribution?: TurnSpendAttribution): TurnSpendAdmission {
  return {
    admitted: true,
    finalize: (actuals) => writeAttribution(attribution, actuals),
    abort: NOOP_ABORT,
  };
}

/**
 * Admit (or block) one paid turn. `idempotencyKey` must be stable for the
 * turn (a fresh UUID per user turn; a RETRY of the same logical turn may
 * reuse it to avoid double-charging headroom).
 */
export async function admitTurnSpend(args: {
  idempotencyKey: string;
  attribution?: TurnSpendAttribution;
}): Promise<TurnSpendAdmission> {
  if (!(await isCostCapEnforced())) {
    return admittedWithoutLedger(args.attribution);
  }

  const capUsd = await getEffectiveCostCap();
  if (!Number.isFinite(capUsd)) {
    return admittedWithoutLedger(args.attribution);
  }

  if (!(await ledgerArmed())) {
    // Legacy soft cap: strict counter read, fail closed on indeterminate.
    try {
      const spendUsd = await getDailyCostUsd({ strict: true });
      if (spendUsd >= capUsd) {
        return {
          admitted: false,
          blocked: { reason: 'cap_exceeded', capUsd, spendUsd },
          finalize: async () => {},
          abort: NOOP_ABORT,
        };
      }
    } catch (err) {
      if (err instanceof SpendIndeterminateError) {
        return {
          admitted: false,
          blocked: { reason: 'spend_indeterminate', capUsd },
          finalize: async () => {},
          abort: NOOP_ABORT,
        };
      }
      throw err;
    }
    return admittedWithoutLedger(args.attribution);
  }

  // Armed: atomic reserve-before-spend.
  const store = ledgerStore();
  const day = utcDay();
  const result = await reserve({
    store,
    day,
    capUsd,
    worstCaseUsd: await worstCaseUsd(),
    idempotencyKey: args.idempotencyKey,
  });

  if (!result.ok) {
    return {
      admitted: false,
      blocked: { reason: result.reason, capUsd },
      finalize: async () => {},
      abort: NOOP_ABORT,
    };
  }

  let done = false;
  return {
    admitted: true,
    finalize: async (actuals) => {
      if (done) return;
      done = true;
      try {
        await settle({
          store,
          day,
          reservationId: result.reservationId,
          actualUsd: actuals.costUsd,
        });
      } catch (err) {
        // The spend already happened; a failed settle must not drop the
        // reply. Log loudly — the hold stays until released/expired and the
        // day over-counts by (worstCase - actual), the safe direction.
        logger.error(
          { errMessage: err instanceof Error ? err.message : String(err), day },
          'spend-ledger settle failed after paid call',
        );
      }
      await writeAttribution(args.attribution, actuals);
    },
    abort: async () => {
      if (done) return;
      done = true;
      try {
        await release({ store, day, reservationId: result.reservationId });
      } catch (err) {
        logger.error(
          { errMessage: err instanceof Error ? err.message : String(err), day },
          'spend-ledger release failed; hold persists until the day rolls',
        );
      }
    },
  };
}
