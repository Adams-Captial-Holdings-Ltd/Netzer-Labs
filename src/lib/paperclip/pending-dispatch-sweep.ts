import { logger } from '../../observability/logger.js';
import { RUNNER_HOLDER_ID, tryAcquireRunnerLease } from '../state/runner-lease.js';
import { createAttemptStore, FencedOutError, type AttemptRow } from './attempt-store.js';
import { dynamoAttemptRows, scanPendingAttempts } from './attempt-rows-dynamo.js';
import { DispatchFailure, deliverOutcome } from './dispatch-worker.js';
import { getPaperclipLockState } from './runtime-lock.js';

const MINIMUM_DISPATCH_AGE_MS = 60_000;
const DISPATCH_ALARM_AGE_MS = 15 * 60_000;
const RUNNER_LEASE_TTL_MS = 10 * 60_000;
const SWEEP_INTERVAL_MS = 5 * 60_000;
const STORE_RETRY_PAUSE_MS = 200;
const STORE_RETRY_TRIES = 3;

type Attempts = ReturnType<typeof createAttemptStore>;
type Deliver = typeof deliverOutcome;
export interface PendingDispatchSweepDeps {
  scan?: () => Promise<AttemptRow[]>;
  attempts?: Attempts;
  deliver?: Deliver;
  now?: () => number;
  lockState?: typeof getPaperclipLockState;
  lease?: () => Promise<boolean>;
  storeRetryMs?: number;
}

/** Retry only recorded outcomes. An expired in-flight write is ambiguous and fails closed. */
export async function runPendingDispatchSweep(deps: PendingDispatchSweepDeps = {}): Promise<void> {
  const now = deps.now ?? Date.now;
  const attempts = deps.attempts ?? createAttemptStore({ rows: dynamoAttemptRows(), holderId: RUNNER_HOLDER_ID, now });
  const deliver = deps.deliver ?? deliverOutcome;
  const storeRetryMs = deps.storeRetryMs ?? STORE_RETRY_PAUSE_MS;
  let delivered = 0;
  let blocked = 0;
  let skipped = 0;
  let expired = 0;
  let stale = 0;
  let oldestAgeMs = 0;
  async function processRow(row: AttemptRow): Promise<void> {
    let age = 0;
    let alarmAge = 0;
    let undelivered = row.state === 'recorded';
    try {
      if (row.state === 'recorded') {
        age = now() - row.updatedAt;
        alarmAge = now() - (row.recordedAt ?? row.updatedAt);
      }
      if (row.state === 'delivering') {
        if (row.leaseExpiresAt <= now() && await attempts.failExpiredDelivery(row.issueId)) {
          expired++;
          logger.error({ issueId: row.issueId, attemptNo: row.attemptNo, code: 'delivery_unknown' }, 'paperclip pending_dispatch delivery ended unknown');
        }
        return;
      }
      if (row.state !== 'recorded') return;
      if (!row.agentId || row.runIds.length === 0) { skipped++; return; }
      if (age < MINIMUM_DISPATCH_AGE_MS) return;
      const claim = await attempts.claimDelivery(row.issueId);
      if (!claim) return;
      try {
        await deliver({ netzarAgentId: row.agentId, issueId: row.issueId, runId: claim.runId,
          dedupeKey: `${claim.runId}#${row.issueId}`, context: {} }, claim.outcome);
      } catch (error) {
        if (error instanceof FencedOutError) return;
        if (error instanceof DispatchFailure && error.retryable) {
          for (let attempt = 1; ; attempt++) {
            try { await attempts.releaseDelivery(claim.handle); break; }
            catch (err) {
              if (err instanceof FencedOutError || attempt >= STORE_RETRY_TRIES) throw err;
              await new Promise<void>((resolve) => setTimeout(resolve, storeRetryMs));
            }
          }
        }
        else {
          const failure = error instanceof DispatchFailure ? error : new DispatchFailure('delivery_unknown', 500, false);
          await attempts.fail(claim.handle, { code: failure.code, status: failure.status, retryable: false });
          undelivered = false;
        }
        return;
      }
      if (claim.outcome.disposition === 'blocked') {
        await attempts.fail(claim.handle, { code: 'agent_blocked', status: 409, retryable: false });
        undelivered = false;
        blocked++;
      } else {
        await attempts.markDelivered(claim.handle);
        undelivered = false;
        delivered++;
      }
    } catch (error) {
      if (!(error instanceof FencedOutError)) logger.warn({ issueId: row.issueId,
        errName: error instanceof Error ? error.name : 'unknown', reason: 'pending_dispatch_row_failed' }, 'paperclip pending_dispatch row failed');
    } finally {
      if (undelivered && alarmAge >= DISPATCH_ALARM_AGE_MS) { stale++; oldestAgeMs = Math.max(oldestAgeMs, alarmAge); }
    }
  }
  try {
    if ((deps.lockState ?? getPaperclipLockState)().closed) return;
    if (!await (deps.lease ?? (() => tryAcquireRunnerLease({ name: 'paperclip-pending-dispatch', ttlMs: RUNNER_LEASE_TTL_MS })))()) return;
    const rows = await (deps.scan ?? scanPendingAttempts)();
    for (const row of rows) await processRow(row);
    if (stale) logger.error({ count: stale, oldestAgeMs }, 'paperclip pending_dispatch outcomes are not delivered');
    if (delivered || blocked || skipped || expired) logger.info({ delivered, blocked, skipped, expired }, 'paperclip pending_dispatch sweep completed');
  } catch (error) {
    if (!(error instanceof FencedOutError)) logger.warn({ reason: 'pending_dispatch_sweep_failed' }, 'paperclip pending_dispatch sweep failed');
  }
}

let timer: ReturnType<typeof setInterval> | undefined;
let running = false;

export function startPendingDispatchSweep(): void {
  if (timer) return;
  timer = setInterval(() => {
    if (running) return;
    running = true;
    void runPendingDispatchSweep().finally(() => { running = false; });
  }, SWEEP_INTERVAL_MS);
  timer.unref();
}

export function stopPendingDispatchSweep(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}
