/**
 * `POST /api/paperclip/dispatch` — Paperclip's `http` adapter calling INTO
 * Netzar (ADR 0010). The fast-ACK inbound surface, shaped like the Telegram
 * webhook because that is the house template that authenticates on a shared
 * secret.
 *
 * C-17: THIS ROUTE AUTHENTICATES ON A SHARED SECRET, NOT THE HUMAN CAPABILITY
 * MODEL. `src/lib/auth/permissions.ts` is untouched; there is no capability and
 * no role for a dispatch. `implementation-plan.md` §13.4 specifies a
 * `claudeclaw-dashboard-tokens` row with `role >= operator` — that is
 * SUPERSEDED, and contradicted by running code: `agentSpecs()` in
 * `scripts/lib/paperclip/bootstrap-core.ts` embeds `PAPERCLIP_DISPATCH_SECRET`
 * verbatim in each agent's `adapter_config.headers.authorization`, and
 * `src/config/env.ts` calls it "the shared secret C-17 settled on for the
 * dispatch route". Precedence puts running code and Part C above the plan.
 *
 * Served only by `buildPrivateDispatchApp` in `src/server.ts` on the private
 * port. The public app denies this path; `paperclip-dispatch.private.test.ts`
 * proves both listeners' behavior.
 *
 * WHY NOT `POST /api/test-turn`. It `await`s `runAgentTurn` inline and responds
 * only after it resolves, which would blow the adapter's `timeoutMs: 10_000`
 * on any turn with a tool loop; `/test-turn/stream` holds an SSE connection
 * open for the whole turn. Both also sit behind the dashboard capability model
 * (`chat:read`) that C-17 removed from scope. Neither is reusable here, and
 * neither is imported by this file.
 *
 * NOTHING BELOW AWAITS A TURN. The work is fired with `void` and the 202 is
 * returned immediately; `runDispatchWork` lives in
 * `src/lib/paperclip/dispatch-worker.ts` (§27.1: a separate file from the
 * route) and never rejects.
 *
 * REJECT vs IGNORE. Only auth, shape and an unknown actor produce a 4xx.
 * Anything this route simply cannot act on — an agent an operator has not
 * enabled, a duplicate delivery — is a 2xx with a reason field, because a
 * non-2xx makes Paperclip retry or fail the run. That is Slack's
 * `{ok:true, duplicate:true}` precedent, restated as `202 {deduplicated:true}`.
 */
import { timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { logger } from '../../observability/logger.js';
import { loadEnv } from '../../config/env.js';
import { listKnownAgents } from '../../lib/config/agent-loader.js';
import { isKillSwitchActive } from '../../lib/state/kill-switches-repo.js';
import { getConfigCategory } from '../../lib/state/runtime-config-repo.js';
import { tryClaimOnce } from '../../lib/state/runner-lease.js';
import { PAPERCLIP_CONFIG_CATEGORY } from '../../lib/paperclip/config.js';
import { getPaperclipLockState } from '../../lib/paperclip/runtime-lock.js';
import { parseEnabledAgents } from '../../lib/paperclip/reconciler.js';
import { dispatchClaimKey, parseDispatchBody, runDispatchWork } from '../../lib/paperclip/dispatch-worker.js';
import type { PaperclipDispatchContext } from '../../lib/paperclip/types.js';

/**
 * The OUTER bound on how long a `(runId, issueId)` pair is remembered. Long
 * enough to swallow any adapter retry storm; short enough that the claim table
 * self-cleans by TTL.
 *
 * It is an outer bound rather than a fixed lifetime because the claim is taken
 * HERE, before the work runs, and `runDispatchWork` releases it again when the
 * work fails transiently — so the pair is remembered for this long only when
 * the dispatch actually reached a terminal outcome. Without that release, this
 * constant would be the length of time a single 5xx suppresses every retry.
 */
export const DISPATCH_CLAIM_TTL_SECONDS = 86_400;

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
  /**
   * `optionalNonPlaceholder()` in `src/config/env.ts` already collapses both
   * `''` and Secrets Manager's `REPLACE_ME` to `undefined`, so "unset" and
   * "placeholder" are the same value here and both mean UNCONFIGURED.
   */
  secret?: () => string | undefined;
  killSwitch?: typeof isKillSwitchActive;
  knownAgents?: () => string[];
  enabledAgents?: () => Promise<readonly string[]>;
  claim?: (ctx: PaperclipDispatchContext) => Promise<boolean>;
  work?: (ctx: PaperclipDispatchContext) => Promise<void>;
}

async function defaultEnabledAgents(): Promise<readonly string[]> {
  const config = await getConfigCategory(PAPERCLIP_CONFIG_CATEGORY);
  return parseEnabledAgents(config.enabled_agents);
}

export function buildPaperclipDispatchRouter(deps: PaperclipDispatchDeps = {}): Hono {
  const router = new Hono();
  const readSecret = deps.secret ?? (() => loadEnv().PAPERCLIP_DISPATCH_SECRET);
  const killSwitch = deps.killSwitch ?? isKillSwitchActive;
  const knownAgents = deps.knownAgents ?? listKnownAgents;
  const enabledAgents = deps.enabledAgents ?? defaultEnabledAgents;
  // `dispatchClaimKey` rather than an inline template: the worker releases this
  // exact key on a transient failure, and two spellings that drift would make
  // the release a no-op — reopening the loss channel silently.
  const claim = deps.claim ?? ((ctx) => tryClaimOnce(dispatchClaimKey(ctx), DISPATCH_CLAIM_TTL_SECONDS));
  const work = deps.work ?? ((ctx) => runDispatchWork(ctx));

  router.post('/dispatch', async (c) => {
    // Wave A (A-kill prohibition): secret verification is UNCONDITIONAL. It sits
    // behind no kill switch and no feature flag, because a route that accepts an
    // unauthenticated body chooses its own actor — and the actor is what makes an
    // agent turn legitimate. Break-glass for a broken or rotated secret is
    // DISABLE INGRESS (this 401), never "accept unsigned traffic".
    const expected = readSecret();
    if (!expected) {
      logger.warn(
        {},
        'paperclip dispatch secret not configured; rejecting (set the /claudeclaw[-suffix]/paperclip secret field dispatch_secret, which reaches this task as PAPERCLIP_DISPATCH_SECRET; ingress stays closed until it is)',
      );
      return c.json({ error: 'unauthorized', reason: 'no_secret' }, 401);
    }
    const provided = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (!verifyDispatchSecret(provided, expected)) {
      // No secret, no bearer and no body in this line — a `reason` enum and
      // nothing else, per the house logging rule.
      logger.warn({ reason: 'bad_secret' }, 'paperclip dispatch secret mismatch');
      return c.json({ error: 'unauthorized' }, 401);
    }

    // Authenticate before revealing lock state, then refuse a closed lock
    // before the kill switch or any work can be claimed.
    const lock = getPaperclipLockState();
    if (lock.closed) return c.json({ error: 'paperclip_locked', code: lock.code }, 503);

    // AFTER authentication, so an unauthenticated caller cannot probe switch
    // state, and BEFORE any work is enqueued — mirroring `client.ts`'s own
    // "switch before breaker" ordering, so a switched-off integration answers a
    // deterministic refusal rather than accepting work it will drop later.
    const switched = await killSwitch('paperclip_disabled');
    if (switched.active) {
      return c.json({ error: 'paperclip_disabled', reason: switched.reason }, 503);
    }

    // A static bearer does not cover the raw bytes, so unlike Slack there is no
    // need to read `c.req.text()` first.
    const raw = await c.req.json<unknown>().catch(() => null);
    if (raw === null) return c.json({ error: 'invalid_json' }, 400);

    const ctx = parseDispatchBody(raw);
    if (!ctx) {
      logger.warn({ reason: 'invalid_body' }, 'paperclip dispatch body rejected');
      return c.json(
        // `required` DESCRIBES THE ACCEPTED SHAPES rather than listing three
        // top-level keys, because the issue id is accepted at either level
        // and the real Paperclip push sends it inside `context` (see the
        // measured-shape header in `dispatch-worker.ts`). A list that named
        // only the top-level spelling told the caller to send a field the
        // sender does not have, which is worse than saying nothing.
        {
          error: 'invalid_body',
          required: ['netzarAgentId', 'runId', 'issueId (top-level or context.issueId)'],
        },
        400,
      );
    }

    // House rule 20: in-band identity from the caller is a claim, never a fact.
    // The slug is cross-checked against the server-side agent list.
    if (!knownAgents().includes(ctx.netzarAgentId)) {
      logger.warn({ agentId: ctx.netzarAgentId }, 'paperclip dispatch for an unknown agent');
      return c.json({ error: 'unknown_agent', netzarAgentId: ctx.netzarAgentId }, 404);
    }

    // `paperclip/enabled_agents` is the operator's per-slug arming switch, and
    // Phase 6 is its first non-reporting reader. A known agent an operator has
    // not armed is IGNORED, not rejected: a 4xx would make Paperclip fail the
    // run over a deliberate configuration choice.
    if (!(await enabledAgents()).includes(ctx.netzarAgentId)) {
      return c.json({ ok: true, ignored: 'agent_not_enabled' }, 202);
    }

    // A duplicate `(runId, issueId)` is a NO-OP and a 202 — NEVER a 4xx.
    //
    // The claim is taken BEFORE the work, so holding it means "this pair is
    // being worked on, or already reached a terminal outcome" — and the second
    // half of that sentence is only true because `runDispatchWork` drops the
    // claim again on BOTH of the ways an attempt can end having done no work
    // that a later one could not redo: a transient THROW (a 5xx, the cost cap,
    // `bedrock_global`), and a turn REFUSED before any model work by a cause
    // time or an operator cures (`sessions_frozen`, the turn-level rate limit),
    // which returns rather than throwing and is caught by its typed `refusal`
    // marker. This branch therefore refuses a genuinely concurrent duplicate
    // (the claim is still held by a run in flight) and a completed one; it does
    // NOT refuse a redelivery of a dispatch that failed and could still
    // succeed.
    if (!(await claim(ctx))) {
      logger.info(
        { agentId: ctx.netzarAgentId, issueId: ctx.issueId },
        'paperclip dispatch already claimed',
      );
      return c.json({ ok: true, deduplicated: true }, 202);
    }

    // Ack first, process async. Paperclip's adapter budget is
    // `timeoutMs: 10_000` (`agentSpecs()`), which a tool-looping turn blows.
    void work(ctx);
    return c.json({ ok: true, accepted: true, issueId: ctx.issueId }, 202);
  });

  return router;
}
