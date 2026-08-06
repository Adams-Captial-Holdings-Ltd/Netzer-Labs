/**
 * Voice spend-ledger state machine (Codex review).
 *
 * A live Nova session reserves an upper-bound estimate at admission, then
 * converts reserved → spent as it runs. Three independent callers mutate that
 * accounting — the per-token usage callback, the periodic heartbeat, and
 * teardown — so ALL mutations run through ONE serialized queue here: only one
 * op touches estimate/settled/dayCache at a time, and each recomputes its target
 * with fresh state inside the critical section. This removes the double-settle,
 * lost-settle, midnight-rollover-race, and refund-on-failure bugs that a set of
 * ad-hoc chained closures in the relay had.
 *
 * Charging model: each tick settles up to the LARGER of the elapsed wall-clock
 * floor and the metered per-token cost. When real cost overflows the reservation
 * it is grown via `topUp` (so output-heavy turns are still charged); genuinely no
 * headroom → `onSpendCap`. Already-settled spend stays on the day it occurred; at
 * UTC midnight the remaining reservation rolls onto the new day (seeded first).
 */

import { settleTurn, topUp, rolloverReservation, ensureDay, utcDate } from './spend-ledger.js';
import { releaseSession } from '../voice/session-leases.js';
import { recordUsage, JARVIS_USAGE_AGENT } from '../usage/token-tracker.js';
import { logger } from '../../observability/logger.js';

export interface VoiceLedgerParams {
  ownerId: string;
  tokenHash: string;
  chatId: string;
  modelId: string;
  slotIndex: number;
  /** Effective daily cap, used to seed the new day's row on rollover. */
  cap: number;
  /** Initial reservation (USD), the wall-clock upper bound from admission. */
  estimate: number;
  /**
   * The UTC date the reservation was ADMITTED on (not recomputed), so the ledger
   * settles/releases against the same day's aggregate even if construction
   * straddles midnight (Codex review).
   */
  initialDay: string;
  /** Wall-clock start of the session (ms epoch). */
  startedAt: number;
  usdPerSecond: number;
  leaseTtlSeconds: number;
  /** Called when the day has no headroom for the spend — the relay closes 4013. */
  onSpendCap: () => void;
  /** Test seams. */
  now?: () => number;
  today?: () => string;
}

export class VoiceLedger {
  private estimate: number;
  private settled = 0;
  private dayCache: string;
  private resetAt: number;
  private usageBase = 0;
  private usageCostCum = 0;
  private released = false;
  private chain: Promise<void> = Promise.resolve();
  private readonly now: () => number;
  private readonly today: () => string;

  constructor(private readonly p: VoiceLedgerParams) {
    this.estimate = p.estimate;
    this.now = p.now ?? (() => Date.now());
    this.today = p.today ?? utcDate;
    // Bind to the ADMITTED day, not the construction-time day.
    this.dayCache = p.initialDay;
    this.resetAt = p.startedAt;
  }

  // ── inspection (tests / metrics) ──────────────────────────────────────────
  get settledUsd(): number {
    return this.settled;
  }
  get estimateUsd(): number {
    return this.estimate;
  }
  get currentDay(): string {
    return this.dayCache;
  }
  get isReleased(): boolean {
    return this.released;
  }

  /** Cumulative real Nova cost (monotonic) — safe to call outside the queue. */
  addUsageCost(costUsd: number): void {
    if (Number.isFinite(costUsd) && costUsd > this.usageCostCum) this.usageCostCum = costUsd;
  }

  /** Roll over if needed, then settle this interval. Serialized. */
  tick(): Promise<void> {
    return this.enqueue(async () => {
      if (this.released) return;
      if (!(await this.rolloverIfNeeded())) {
        this.p.onSpendCap();
        return;
      }
      if ((await this.settleToward()).capped) this.p.onSpendCap();
    });
  }

  /**
   * Final op: settle the last interval THROUGH the shared top-up path (so final
   * metered cost above the reservation is still charged when the day has
   * headroom), then release ONLY when that settle is CONFIRMED. On an unconfirmed
   * final settle the RES row is left intact so the GSI reaper reclaims the whole
   * reservation later — deleting it here would orphan the consumed-but-unsettled
   * headroom and permanently leak cap (Codex review). Idempotent.
   */
  finalize(): Promise<void> {
    return this.enqueue(async () => {
      if (this.released) return;
      this.released = true;
      await this.rolloverIfNeeded().catch(() => false);
      const { confirmed } = await this.settleToward();
      if (!confirmed) {
        logger.warn(
          { ownerId: this.p.ownerId },
          'jarvis finalize: final settle unconfirmed — leaving reservation for the reaper',
        );
        return;
      }
      const rem = Math.max(0, this.estimate - this.settled);
      await releaseSession({
        ownerId: this.p.ownerId,
        slotIndex: this.p.slotIndex,
        tokenHash: this.p.tokenHash,
        utcDate: this.dayCache,
        rem,
      }).catch((err) => logger.warn({ err: msg(err), ownerId: this.p.ownerId }, 'jarvis release failed'));
    });
  }

  // ── internals ─────────────────────────────────────────────────────────────
  private enqueue(op: () => Promise<void>): Promise<void> {
    this.chain = this.chain
      .then(op)
      .catch((err) => logger.warn({ err: msg(err), ownerId: this.p.ownerId }, 'jarvis ledger op threw'));
    return this.chain;
  }

  /** The cost that SHOULD be settled now — NOT clamped to the reservation. */
  private desiredTarget(): number {
    return Math.max(
      0,
      ((this.now() - this.resetAt) / 1000) * this.p.usdPerSecond,
      this.usageCostCum - this.usageBase,
    );
  }

  /** Settle reserved→spent. Returns whether the ledger write was CONFIRMED. */
  private async applySettle(inc: number): Promise<boolean> {
    const ok = await settleTurn(this.p.ownerId, this.dayCache, inc)
      .then(() => true)
      .catch(() => false);
    if (!ok) return false;
    this.settled += inc;
    void recordUsage({
      agentId: JARVIS_USAGE_AGENT,
      chatId: this.p.chatId,
      surface: 'jarvis',
      modelId: this.p.modelId,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: inc,
      latencyMs: 0,
    });
    return true;
  }

  private async rolloverIfNeeded(): Promise<boolean> {
    const today = this.today();
    if (today === this.dayCache) return true;
    // Settle the OLD day's accrued tail (floor + tokens since the last tick)
    // BEFORE moving the carry-over, else it is erased on reset (Codex review).
    await this.settleToward();
    const rem = Math.max(0, this.estimate - this.settled);
    await ensureDay(today, this.p.cap).catch(() => {});
    const rolled = await rolloverReservation({
      ownerId: this.p.ownerId,
      estimate: rem,
      yesterday: this.dayCache,
      utcDate: today,
      rem,
      expiresAt: Math.floor(this.now() / 1000) + this.p.leaseTtlSeconds,
      slotIndex: this.p.slotIndex,
      tokenHash: this.p.tokenHash,
    }).catch(() => false);
    if (!rolled) return false;
    this.estimate = rem;
    this.settled = 0;
    this.dayCache = today;
    this.resetAt = this.now();
    this.usageBase = this.usageCostCum;
    return true;
  }

  /**
   * Settle up to the desired target, growing the reservation via topUp on
   * overflow. `capped` = genuinely no headroom (caller closes spend_cap);
   * `confirmed` = the settle write (if one was needed) succeeded.
   */
  private async settleToward(): Promise<{ capped: boolean; confirmed: boolean }> {
    let target = this.desiredTarget();
    let capped = false;
    if (target > this.estimate + 1e-9) {
      let grew: boolean;
      try {
        grew = await topUp(this.p.ownerId, this.dayCache, target - this.estimate);
      } catch {
        // Operational error (not a cap reject) — settle to the current estimate
        // and retry the overflow next tick rather than killing the session.
        target = this.estimate;
        grew = true;
      }
      if (grew) this.estimate = Math.max(this.estimate, target);
      else {
        capped = true;
        target = this.estimate;
      }
    }
    const inc = Math.min(this.estimate, target) - this.settled;
    if (inc <= 1e-9) return { capped, confirmed: true };
    return { capped, confirmed: await this.applySettle(inc) };
  }
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
