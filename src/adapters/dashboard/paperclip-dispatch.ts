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
import { isDispatchDraining, trackDispatch } from '../../lib/paperclip/dispatch-drain.js';
import { taskProtection } from '../../lib/paperclip/task-protection.js';
import type { PaperclipDispatchContext } from '../../lib/paperclip/types.js';

export const ATTEMPT_HOLD_MS = 240_000;
export const ATTEMPT_RENEW_MS = 10_000;
const BODY_LIMIT_BYTES = 64 * 1024;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const RENEW_GRACE_MS = 25_000;
const STORE_RETRY_PAUSE_MS = 200;
const STORE_RETRY_TRIES = 3;

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

async function boundedJson(request: Request): Promise<{ tooLarge: boolean; value: unknown }> {
  const limit = BODY_LIMIT_BYTES;
  if (Number(request.headers.get('content-length')) > limit) return { tooLarge: true, value: null };
  const reader = request.body?.getReader();
  if (!reader) return { tooLarge: false, value: null };
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { void reader.cancel(); return { tooLarge: true, value: null }; }
    chunks.push(value);
  }
  try { return { tooLarge: false, value: JSON.parse(new TextDecoder().decode(Buffer.concat(chunks))) }; }
  catch { return { tooLarge: false, value: null }; }
}

export interface PaperclipDispatchDeps {
  secret?: () => string | undefined;
  knownAgents?: () => string[];
  enabledAgents?: () => Promise<readonly string[]>;
  attempts?: ReturnType<typeof createAttemptStore>;
  work?: (ctx: PaperclipDispatchContext, signal: AbortSignal) => Promise<AttemptOutcome>;
  deliver?: (ctx: PaperclipDispatchContext, outcome: AttemptOutcome) => Promise<void>;
  holdMs?: number;
  pollMs?: number;
  renewMs?: number;
  renewGraceMs?: number;
  storeRetryMs?: number;
  protection?: Pick<typeof taskProtection, 'hold' | 'release' | 'refresh'>;
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
  const work = deps.work ?? ((ctx, signal) => runDispatchAttempt(ctx, { abortSignal: signal }));
  const deliver = deps.deliver ?? deliverOutcome;
  let cachedAttempts = deps.attempts;
  const attempts = () => cachedAttempts ??= createAttemptStore({ rows: dynamoAttemptRows(), holderId: RUNNER_HOLDER_ID, now: Date.now });
  const holdMs = deps.holdMs ?? ATTEMPT_HOLD_MS;
  const pollMs = deps.pollMs ?? DEFAULT_POLL_INTERVAL_MS;
  const renewMs = deps.renewMs ?? ATTEMPT_RENEW_MS;
  const renewGraceMs = deps.renewGraceMs ?? RENEW_GRACE_MS;
  const storeRetryMs = deps.storeRetryMs ?? STORE_RETRY_PAUSE_MS;
  const protection = deps.protection ?? taskProtection;
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  const errName = (err: unknown) => err instanceof Error ? err.name : 'unknown';
  const storedStatus = (status: number): 500 => Number.isInteger(status) && status >= 400 && status <= 599 ? status as 500 : 500;
  const log = (ctx: PaperclipDispatchContext, attemptNo: number, state: string, code?: string, retryable = false) => {
    const level = code === 'delivery_unknown' || code === 'connector_auth' ? 'error'
      : state === 'failed' && retryable ? 'warn' : 'info';
    logger[level]({ issueId: ctx.issueId, agentId: ctx.netzarAgentId, attemptNo, state, ...(code ? { code } : {}) }, `paperclip attempt ${state}`);
  };

  async function retryStore<T>(write: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try { return await write(); }
      catch (err) {
        if (err instanceof FencedOutError || attempt >= STORE_RETRY_TRIES) throw err;
        await sleep(storeRetryMs);
      }
    }
  }

  async function withRenewal<T>(handle: AttemptHandle, fn: (signal: AbortSignal) => Promise<T>, workPhase = false): Promise<T> {
    let renewalError: unknown;
    let busy = false;
    let active = true;
    let lastSuccess = Date.now();
    let graceExpired = false;
    const controller = new AbortController();
    const timer = setInterval(() => {
      if (workPhase && Date.now() - lastSuccess >= renewGraceMs) { graceExpired = true; controller.abort(); }
      if (busy) return;
      busy = true;
      void attempts().renew(handle).then(() => {
        lastSuccess = Date.now();
        if (active) protection.refresh();
      }).catch((err: unknown) => {
        if (err instanceof FencedOutError) { renewalError = err; if (workPhase) controller.abort(); }
        else logger.warn({ issueId: handle.issueId, attemptNo: handle.attemptNo, reason: 'renew_failed' }, 'paperclip dispatch lease renewal failed');
      }).finally(() => { busy = false; });
    }, renewMs);
    try {
      const result = await fn(controller.signal);
      if (renewalError) throw renewalError;
      if (graceExpired) throw new DispatchFailure('agent_failed', 500, true);
      return result;
    } catch (err) {
      if (renewalError) throw renewalError;
      if (graceExpired) throw new DispatchFailure('agent_failed', 500, true);
      throw err;
    } finally { active = false; clearInterval(timer); }
  }

  async function deliverClaim(ctx: PaperclipDispatchContext, handle: AttemptHandle, outcome: AttemptOutcome, runId: string): Promise<void> {
    try {
      await withRenewal(handle, () => deliver({ ...ctx, runId }, outcome));
    } catch (err) {
      if (err instanceof FencedOutError) throw err;
      const failure = err instanceof DispatchFailure ? err : new DispatchFailure('delivery_unknown', 500, false);
      if (failure.retryable) await retryStore(() => attempts().releaseDelivery(handle));
      else await attempts().fail(handle, { code: failure.code, status: failure.status, retryable: false });
      log(ctx, handle.attemptNo, 'failed', failure.code, failure.retryable);
      return;
    }
    try {
      if (outcome.disposition === 'blocked') {
        await attempts().fail(handle, { code: 'agent_blocked', status: 409, retryable: false });
        log(ctx, handle.attemptNo, 'failed', 'agent_blocked');
      } else {
        await retryStore(() => attempts().markDelivered(handle));
        log(ctx, handle.attemptNo, 'delivered');
      }
    } catch (err) {
      logger.error({ issueId: ctx.issueId, attemptNo: handle.attemptNo, delivered: true, errName: errName(err) }, 'paperclip delivery bookkeeping failed');
    }
  }

  async function deliverRecorded(ctx: PaperclipDispatchContext): Promise<void> {
    const claim = await attempts().claimDelivery(ctx.issueId);
    if (claim) await deliverClaim(ctx, claim.handle, claim.outcome, claim.runId);
  }

  function launch(ctx: PaperclipDispatchContext, handle: AttemptHandle, onError: (err: unknown) => void, onDone: () => void): void {
    protection.hold();
    const release = trackDispatch();
    void (async () => {
      try {
        let outcome: AttemptOutcome;
        try { outcome = await withRenewal(handle, (signal) => work(ctx, signal), true); }
        catch (err) {
          if (err instanceof FencedOutError) throw err;
          const failure = err instanceof DispatchFailure ? err : new DispatchFailure('agent_failed', 500, true);
          await attempts().fail(handle, { code: failure.code, status: failure.status, retryable: failure.retryable });
          log(ctx, handle.attemptNo, 'failed', failure.code, failure.retryable);
          return;
        }
        await retryStore(() => attempts().record(handle, outcome));
        log(ctx, handle.attemptNo, 'recorded');
        await deliverRecorded(ctx);
      } catch (err) { onError(err); }
      finally { protection.release(); release(); onDone(); }
    })();
  }

  router.post('/dispatch', async (c) => {
    // Authentication always runs before lock and drain checks, so callers cannot learn their state.
    const expected = readSecret();
    if (!expected) {
      logger.warn({ reason: 'no_secret' }, 'paperclip dispatch secret is not configured');
      return c.json({ error: 'unauthorized', reason: 'no_secret' }, 401);
    }
    const provided = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (!verifyDispatchSecret(provided, expected)) {
      logger.warn({ reason: 'bad_secret' }, 'paperclip dispatch secret mismatch');
      return c.json({ error: 'unauthorized' }, 401);
    }
    const lock = getPaperclipLockState();
    if (lock.closed) return c.json({ error: 'paperclip_locked', code: lock.code }, 503);
    if (isDispatchDraining()) return c.json({ error: 'draining' }, 503);
    const body = await boundedJson(c.req.raw);
    if (body.tooLarge) return c.json({ error: 'body_too_large' }, 413);
    const raw = body.value;
    if (raw === null) return c.json({ error: 'invalid_json' }, 400);
    const parsedCtx = parseDispatchBody(raw);
    if (!parsedCtx) {
      logger.warn({ reason: 'invalid_body' }, 'paperclip dispatch body rejected');
      return c.json({ error: 'invalid_body', required: ['netzarAgentId', 'runId', 'issueId (top-level or context.issueId)'] }, 400);
    }
    const ctx: PaperclipDispatchContext = parsedCtx;
    let attemptNo = 0;
    let attached = false;
    let settled = false;
    let taskError: unknown;
    let wake = () => {};
    let taskDone = Promise.resolve();
    let recordedSeen = false;
    const dispatch = { issueId: ctx.issueId, runId: ctx.runId, retryOfRunId: ctx.retryOfRunId, agentId: ctx.netzarAgentId };
    const onError = (err: unknown) => {
      logger.error({ issueId: ctx.issueId, attemptNo, errName: errName(err) }, 'paperclip dispatch background failed');
      taskError = err;
    };
    function actOnBegin(begun: Awaited<ReturnType<ReturnType<typeof createAttemptStore>['begin']>>): Response | undefined {
      attemptNo = begun.row.attemptNo;
      if (begun.action === 'busy') return c.json({ error: 'attempt_in_progress' }, 409);
      if (begun.action === 'replay') { log(ctx, attemptNo, 'replayed'); return c.json({ ok: true, issueId: ctx.issueId, attemptNo, replayed: true }, 200); }
      if (begun.action === 'replay_failure') return c.json({ error: begun.failure.code, attemptNo }, storedStatus(begun.failure.status));
      if (begun.action === 'unknown') return c.json({ error: 'delivery_unknown', attemptNo }, 500);
      attached = begun.action === 'attach';
      settled = attached;
      taskError = undefined;
      recordedSeen = false;
      taskDone = new Promise<void>((resolve) => { wake = resolve; });
      if (begun.action === 'start') {
        if (begun.superseded) logger.warn({ issueId: ctx.issueId, attemptNo: begun.superseded.attemptNo,
          reason: begun.superseded.state === 'recorded' ? 'outcome_superseded' : 'attempt_takeover' }, 'paperclip attempt superseded');
        log(ctx, attemptNo, 'started');
        launch(ctx, begun.handle, onError, () => { settled = true; wake(); });
      } else if (begun.action === 'deliver') {
        protection.hold();
        const release = trackDispatch();
        void deliverClaim(ctx, begun.handle, begun.outcome, ctx.runId)
          .catch(onError).finally(() => { protection.release(); release(); settled = true; wake(); });
      } else log(ctx, attemptNo, 'attached');
      return undefined;
    }
    async function pollLoop(): Promise<Response> {
      const end = Date.now() + holdMs;
      let takeoverTried = false;
      while (true) {
        if (taskError instanceof FencedOutError) return c.json({ error: 'lease_lost' }, 409);
        if (taskError) return c.json({ error: 'attempt_store_unavailable' }, 503);
        if (attached && isDispatchDraining()) return c.json({ error: 'draining' }, 503);
        const row = await attempts().get(ctx.issueId);
        if (row && row.attemptNo > attemptNo) return c.json({ error: 'lease_lost' }, 409);
        if (row?.state === 'delivered') return c.json({ ok: true, issueId: ctx.issueId, attemptNo }, 200);
        if (row?.state === 'failed') return c.json({ error: row.failure!.code, attemptNo }, storedStatus(row.failure!.status));
        if (row && (row.state === 'running' || row.state === 'delivering') && row.leaseExpiresAt <= Date.now()
          && (attached || settled) && !takeoverTried) {
          takeoverTried = true;
          const answer = actOnBegin(await attempts().begin(dispatch));
          if (answer) return answer;
          continue;
        }
        if (row?.state === 'recorded') {
          if (settled && (!attached || recordedSeen)) return c.json({ error: 'delivery_failed', attemptNo }, 502);
          recordedSeen = true;
        } else recordedSeen = false;
        if (Date.now() >= end) return c.json({ error: 'attempt_timeout', attemptNo }, 504);
        const pause = sleep(Math.min(pollMs, Math.max(1, end - Date.now())));
        await (attached || settled ? pause : Promise.race([pause, taskDone]));
      }
    }
    try {
      if (!knownAgents().includes(ctx.netzarAgentId)) {
        logger.warn({ agentId: ctx.netzarAgentId }, 'paperclip dispatch for an unknown agent');
        return c.json({ error: 'unknown_agent', netzarAgentId: ctx.netzarAgentId }, 404);
      }
      if (!(await enabledAgents()).includes(ctx.netzarAgentId)) return c.json({ error: 'agent_not_enabled' }, 409);
      const answer = actOnBegin(await attempts().begin(dispatch));
      return answer ?? await pollLoop();
    } catch (err) {
      logger.error({ issueId: ctx.issueId, ...(attemptNo ? { attemptNo } : {}), errName: errName(err) }, 'paperclip dispatch failed');
      if (err instanceof FencedOutError) return c.json({ error: 'lease_lost' }, 409);
      return c.json({ error: 'attempt_store_unavailable' }, 503);
    }
  });
  return router as { request: (...args: Parameters<Hono['request']>) => Promise<Response> } & Hono;
}
