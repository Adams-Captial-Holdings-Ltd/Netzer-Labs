import { logger } from '../../observability/logger.js';
import { RUNNER_HOLDER_ID, tryAcquireRunnerLease } from '../state/runner-lease.js';
import { createAttemptStore, FencedOutError, type AttemptRow } from './attempt-store.js';
import { dynamoAttemptRows, scanPendingAttempts } from './attempt-rows-dynamo.js';
import { DispatchFailure, deliverOutcome } from './dispatch-worker.js';
import { getPaperclipLockState } from './runtime-lock.js';

type Attempts = ReturnType<typeof createAttemptStore>;
type Deliver = typeof deliverOutcome;
export interface PendingDispatchSweepDeps {
  scan?: () => Promise<AttemptRow[]>;
  attempts?: Attempts;
  deliver?: Deliver;
  now?: () => number;
  lockState?: typeof getPaperclipLockState;
  lease?: () => Promise<boolean>;
}

/** Retry only recorded outcomes. An expired in-flight write is ambiguous and fails closed. */
export async function runPendingDispatchSweep(deps: PendingDispatchSweepDeps = {}): Promise<void> {
  const now = deps.now ?? Date.now;
  const attempts = deps.attempts ?? createAttemptStore({ rows: dynamoAttemptRows(), holderId: RUNNER_HOLDER_ID, now });
  const deliver = deps.deliver ?? deliverOutcome;
  let delivered = 0;
  let blocked = 0;
  let skipped = 0;
  let expired = 0;
  let stale = 0;
  let oldestAgeMs = 0;
  try {
    if ((deps.lockState ?? getPaperclipLockState)().closed) return;
    if (!await (deps.lease ?? (() => tryAcquireRunnerLease({ name: 'paperclip-pending-dispatch', ttlMs: 10 * 60_000 })))()) return;
    const rows = await (deps.scan ?? scanPendingAttempts)();
    for (const row of rows) {
      if (row.state === 'delivering') {
        if (row.leaseExpiresAt <= now() && await attempts.failExpiredDelivery(row.issueId)) expired++;
        continue;
      }
      if (row.state !== 'recorded') continue;
      const age = now() - row.updatedAt;
      if (age >= 15 * 60_000) { stale++; oldestAgeMs = Math.max(oldestAgeMs, age); }
      if (!row.agentId || row.runIds.length === 0) { skipped++; continue; }
      if (age < 60_000) continue;
      const claim = await attempts.claimDelivery(row.issueId);
      if (!claim) continue;
      try {
        await deliver({ netzarAgentId: row.agentId, issueId: row.issueId, runId: claim.runId,
          dedupeKey: `${claim.runId}#${row.issueId}`, context: {} }, claim.outcome);
      } catch (error) {
        if (error instanceof FencedOutError) continue;
        if (error instanceof DispatchFailure && error.retryable) await attempts.releaseDelivery(claim.handle);
        else {
          const failure = error instanceof DispatchFailure ? error : new DispatchFailure('delivery_unknown', 500, false);
          await attempts.fail(claim.handle, { code: failure.code, status: failure.status, retryable: false });
        }
        continue;
      }
      if (claim.outcome.disposition === 'blocked') {
        await attempts.fail(claim.handle, { code: 'agent_blocked', status: 409, retryable: false });
        blocked++;
      } else {
        await attempts.markDelivered(claim.handle);
        delivered++;
      }
    }
    if (stale) logger.error({ count: stale, oldestAgeMs }, 'paperclip pending_dispatch outcomes are not delivered');
    else if (delivered || blocked) logger.info({ delivered, blocked, skipped, expired }, 'paperclip pending_dispatch sweep completed');
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
  }, 5 * 60_000);
  timer.unref();
}

export function stopPendingDispatchSweep(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}
