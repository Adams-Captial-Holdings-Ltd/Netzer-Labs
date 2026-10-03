/** Held Paperclip dispatch: authenticate, join one fenced attempt, and answer only after delivery. */
import { timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { logger } from '../../observability/logger.js';
import { loadEnv } from '../../config/env.js';
import { listKnownAgents } from '../../lib/config/agent-loader.js';
import { getConfigCategory } from '../../lib/state/runtime-config-repo.js';
import { RUNNER_HOLDER_ID } from '../../lib/state/runner-lease.js';
import { PAPERCLIP_CONFIG_CATEGORY } from '../../lib/paperclip/config.js';
import { getPaperclipLockState } from '../../lib/paperclip/runtime-lock.js';
import { parseEnabledAgents } from '../../lib/paperclip/reconciler.js';
import { DispatchFailure, deliverOutcome, parseDispatchBody, runDispatchAttempt } from '../../lib/paperclip/dispatch-worker.js';
import { createAttemptStore, FencedOutError, type AttemptHandle, type AttemptOutcome } from '../../lib/paperclip/attempt-store.js';
import { dynamoAttemptRows } from '../../lib/paperclip/attempt-rows-dynamo.js';
import { isDispatchDraining } from '../../lib/paperclip/dispatch-drain.js';
import type { PaperclipDispatchContext } from '../../lib/paperclip/types.js';

export const ATTEMPT_HOLD_MS = 240_000;

/**
 * Timing-safe, length-guarded, and a named function rather than an inline
 * `===` in the handler — `verifyTelegramSecret` in
 * `src/adapters/telegram/verify.ts` is the shape this copies, including the
 * reason for the length guard: `timingSafeEqual` THROWS when the two buffers
 * differ in length, and a length mismatch is itself a non-match.
 *
 * There is no shared helper in this repo; each surface owns its own compare
 * (telegram/verify.ts, slack/verify.ts, dashboard-auth.ts, magic-link.ts).
 * This one is exported from the route module rather than a fifth `verify.ts`
 * because it has exactly one caller and one test.
 */
export function verifyDispatchSecret(
  provided: string | undefined | null,
  expected: string | undefined | null,
): boolean {
  if (!provided || !expected) return false;
  const providedBuf = Buffer.from(provided, 'utf8');
  const expectedBuf = Buffer.from(expected, 'utf8');
  if (providedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(providedBuf, expectedBuf);
}

export interface PaperclipDispatchDeps {
  secret?: () => string | undefined;
  knownAgents?: () => string[];
  enabledAgents?: () => Promise<readonly string[]>;
  attempts?: ReturnType<typeof createAttemptStore>;
  work?: (ctx: PaperclipDispatchContext) => Promise<AttemptOutcome>;
  deliver?: (ctx: PaperclipDispatchContext, outcome: AttemptOutcome) => Promise<void>;
  holdMs?: number;
  pollMs?: number;
  renewMs?: number;
}

async function defaultEnabledAgents(): Promise<readonly string[]> {
  const config = await getConfigCategory(PAPERCLIP_CONFIG_CATEGORY);
  return parseEnabledAgents(config.enabled_agents);
}

export function buildPaperclipDispatchRouter(deps: PaperclipDispatchDeps = {}): { request: (...args: Parameters<Hono['request']>) => Promise<Response> } & Hono {
  const router = new Hono();
  const readSecret = deps.secret ?? (() => loadEnv().PAPERCLIP_DISPATCH_SECRET);
  const knownAgents = deps.knownAgents ?? listKnownAgents;
  const enabledAgents = deps.enabledAgents ?? defaultEnabledAgents;
  const work = deps.work ?? runDispatchAttempt;
  const deliver = deps.deliver ?? deliverOutcome;
  let cachedAttempts = deps.attempts;
  const attempts = () => cachedAttempts ??= createAttemptStore({ rows: dynamoAttemptRows(), holderId: RUNNER_HOLDER_ID, now: Date.now });
  const holdMs = deps.holdMs ?? ATTEMPT_HOLD_MS;
  const pollMs = deps.pollMs ?? 2_000;
  const renewMs = deps.renewMs ?? 10_000;
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  const log = (ctx: PaperclipDispatchContext, attemptNo: number, state: string, code?: string) =>
    logger.info({ issueId: ctx.issueId, agentId: ctx.netzarAgentId, attemptNo, state, ...(code ? { code } : {}) }, `paperclip attempt ${state}`);

  async function withRenewal<T>(handle: AttemptHandle, fn: () => Promise<T>): Promise<T> {
    let renewalError: unknown;
    let busy = false;
    const timer = setInterval(() => {
      if (busy) return;
      busy = true;
      void attempts().renew(handle).catch((err: unknown) => {
        if (err instanceof FencedOutError) renewalError = err;
        else logger.warn({ issueId: handle.issueId, attemptNo: handle.attemptNo, reason: 'renew_failed' }, 'paperclip dispatch lease renewal failed');
      }).finally(() => { busy = false; });
    }, renewMs);
    try {
      const result = await fn();
      if (renewalError) throw renewalError;
      return result;
    } finally { clearInterval(timer); }
  }

  async function deliverClaim(ctx: PaperclipDispatchContext, handle: AttemptHandle, outcome: AttemptOutcome, runId: string): Promise<void> {
    try {
      await withRenewal(handle, () => deliver({ ...ctx, runId }, outcome));
      if (outcome.disposition === 'blocked') {
        await attempts().fail(handle, { code: 'agent_blocked', status: 409, retryable: false });
        log(ctx, handle.attemptNo, 'failed', 'agent_blocked');
      } else {
        await attempts().markDelivered(handle);
        log(ctx, handle.attemptNo, 'delivered');
      }
    } catch (err) {
      if (err instanceof FencedOutError) throw err;
      const failure = err instanceof DispatchFailure ? err : new DispatchFailure('delivery_unknown', 500, false);
      if (failure.retryable) await attempts().releaseDelivery(handle);
      else await attempts().fail(handle, { code: failure.code, status: failure.status, retryable: false });
      log(ctx, handle.attemptNo, 'failed', failure.code);
    }
  }

  async function deliverRecorded(ctx: PaperclipDispatchContext): Promise<void> {
    const claim = await attempts().claimDelivery(ctx.issueId);
    if (claim) await deliverClaim(ctx, claim.handle, claim.outcome, claim.runId);
  }

  function launch(ctx: PaperclipDispatchContext, handle: AttemptHandle, onError: (err: unknown) => void, onDone: () => void): void {
    void (async () => {
      try {
        let outcome: AttemptOutcome;
        try { outcome = await withRenewal(handle, () => work(ctx)); }
        catch (err) {
          if (err instanceof FencedOutError) throw err;
          const failure = err instanceof DispatchFailure ? err : new DispatchFailure('agent_failed', 500, true);
          await attempts().fail(handle, { code: failure.code, status: failure.status, retryable: failure.retryable });
          log(ctx, handle.attemptNo, 'failed', failure.code);
          return;
        }
        await attempts().record(handle, outcome);
        log(ctx, handle.attemptNo, 'recorded');
        await deliverRecorded(ctx);
      } catch (err) { onError(err); }
      finally { onDone(); }
    })().catch((err) => { onError(err); onDone(); });
  }

  router.post('/dispatch', async (c) => {
    // Authentication always runs before lock and drain checks, so callers cannot learn their state.
    const expected = readSecret();
    if (!expected) { logger.warn({ reason: 'no_secret' }, 'paperclip dispatch secret is not configured'); return c.json({ error: 'unauthorized', reason: 'no_secret' }, 401); }
    const provided = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (!verifyDispatchSecret(provided, expected)) { logger.warn({ reason: 'bad_secret' }, 'paperclip dispatch secret mismatch'); return c.json({ error: 'unauthorized' }, 401); }
    const lock = getPaperclipLockState();
    if (lock.closed) return c.json({ error: 'paperclip_locked', code: lock.code }, 503);
    if (isDispatchDraining()) return c.json({ error: 'draining' }, 503);
    const raw = await c.req.json<unknown>().catch(() => null);
    if (raw === null) return c.json({ error: 'invalid_json' }, 400);
    const ctx = parseDispatchBody(raw);
    if (!ctx) { logger.warn({ reason: 'invalid_body' }, 'paperclip dispatch body rejected'); return c.json({ error: 'invalid_body', required: ['netzarAgentId', 'runId', 'issueId (top-level or context.issueId)'] }, 400); }
    if (!knownAgents().includes(ctx.netzarAgentId)) { logger.warn({ agentId: ctx.netzarAgentId }, 'paperclip dispatch for an unknown agent'); return c.json({ error: 'unknown_agent', netzarAgentId: ctx.netzarAgentId }, 404); }
    if (!(await enabledAgents()).includes(ctx.netzarAgentId)) return c.json({ error: 'agent_not_enabled' }, 409);

    try {
      // This route uses Paperclip's run id and never mints one.
      const begun = await attempts().begin({ issueId: ctx.issueId, runId: ctx.runId, retryOfRunId: ctx.retryOfRunId });
      const attemptNo = begun.row.attemptNo;
      if (begun.action === 'busy') return c.json({ error: 'attempt_in_progress' }, 409);
      if (begun.action === 'replay') { log(ctx, attemptNo, 'replayed'); return c.json({ ok: true, issueId: ctx.issueId, attemptNo, replayed: true }, 200); }
      if (begun.action === 'replay_failure') return c.json({ error: begun.failure.code, attemptNo }, begun.failure.status as 500);
      if (begun.action === 'unknown') return c.json({ error: 'delivery_unknown', attemptNo }, 500);
      let taskError: unknown;
      let settled = begun.action === 'attach';
      let wake: () => void;
      const taskDone = new Promise<void>((resolve) => { wake = resolve; });
      if (begun.action === 'start') {
        log(ctx, attemptNo, 'started');
        launch(ctx, begun.handle, (err) => { taskError = err; }, () => { settled = true; wake(); });
      } else if (begun.action === 'deliver') {
        void deliverClaim(ctx, begun.handle, begun.outcome, ctx.runId)
          .catch((err) => { taskError = err; }).finally(() => { settled = true; wake(); });
      } else log(ctx, attemptNo, 'attached');
      const attached = begun.action === 'attach';
      const end = Date.now() + holdMs;
      let recordedSeen = false;
      while (true) {
        if (taskError instanceof FencedOutError) return c.json({ error: 'lease_lost' }, 409);
        if (taskError) return c.json({ error: 'attempt_store_unavailable' }, 503);
        if (attached && isDispatchDraining()) return c.json({ error: 'draining' }, 503);
        const row = await attempts().get(ctx.issueId);
        if (row && row.attemptNo > attemptNo) return c.json({ error: 'lease_lost' }, 409);
        if (row?.state === 'delivered') return c.json({ ok: true, issueId: ctx.issueId, attemptNo }, 200);
        if (row?.state === 'failed') return c.json({ error: row.failure!.code, attemptNo }, row.failure!.status as 500);
        if (row?.state === 'recorded') {
          if (settled && (!attached || recordedSeen)) return c.json({ error: 'delivery_failed', attemptNo }, 502);
          recordedSeen = true;
        } else recordedSeen = false;
        if (Date.now() >= end) return c.json({ error: 'attempt_timeout', attemptNo }, 504);
        const pause = sleep(Math.min(pollMs, Math.max(1, end - Date.now())));
        await (attached ? pause : Promise.race([pause, taskDone]));
      }
    } catch (err) {
      if (err instanceof FencedOutError) return c.json({ error: 'lease_lost' }, 409);
      return c.json({ error: 'attempt_store_unavailable' }, 503);
    }
  });
  return router as { request: (...args: Parameters<Hono['request']>) => Promise<Response> } & Hono;
}
