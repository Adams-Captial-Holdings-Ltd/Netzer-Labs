/**
 * `/api/missions*` served from Paperclip, with the wire contract byte-identical.
 *
 * MOUNT POSITION IS THE WHOLE DESIGN, AND IT IS THE OPPOSITE OF
 * `paperclip-dispatch.ts`. That route is mounted BEFORE `/api` precisely to
 * escape the dashboard router's `router.use('*')` middleware. These four are
 * registered ON that same router object, in front of the legacy handlers,
 * precisely to keep it — because the middleware IS part of the contract:
 *
 *   `authz-matrix.test.ts:504-518` asserts, with `toEqual` (exact equality, no
 *   extra keys), that a viewer hitting `POST /missions` gets
 *   `403 {error:'forbidden', requiredRole:'operator', yourRole:'viewer'}`. That
 *   body is produced by the legacy role ladder in `handler.ts`'s router-wide
 *   middleware, which fires BEFORE `await next()` — so no route body, legacy or
 *   ACL, ever runs for that request. It only fires because `requiredRole()` has
 *   no `/missions` case and `POST` falls through to `'operator'`.
 *
 *   Two tempting designs break it. Mounting a sub-router (`app.route('/api/
 *   missions', …)`) never runs that middleware at all. Adding a
 *   `/missions → viewer` relaxation to `requiredRole()` — the pattern used for
 *   `/members` and `/profiles` — lets viewer through to the capability gate and
 *   changes the body to `{error:'forbidden', requiredCapability:'agents:write'}`:
 *   still 403, still a failed `toEqual`. NEITHER IS ALLOWED HERE.
 *
 * THE KILL SWITCH GATES EVERY HANDLER BEFORE ANY PAPERCLIP CALL, in the body
 * shape `paperclip-dispatch.ts` established rather than a second one invented
 * here, and injected the same way so a test drives it without DynamoDB.
 * Returning `503 {error:'paperclip_disabled', reason}` is a REFUSAL, not a
 * fallback: no handler below ever calls the legacy repo, and no `catch` reaches
 * for it either. C-8 — the flag picks one whole stack at registration; a
 * per-request fallback is forbidden.
 *
 * It is the SECOND gate, not the first: the capability check runs ahead of it,
 * because the switch's `reason` is operator free text and a caller who fails
 * authorization must not be told why an integration is down. See `gates()`.
 *
 * `GET /missions` has TWO 503 sources and the existing one wins:
 * `dashboard_read_disabled` is checked for every GET by the router-wide
 * middleware, before any handler here. That ordering is pre-existing behaviour
 * and is left alone.
 *
 * WHAT IS *NOT* HERE. No new capability (`permissions.ts` is untouched, C-17's
 * precedent), no `route-manifest.ts` entry, and no interpolation site — all four
 * handlers return JSON, so `neutralizeForPrompt` has no boundary to guard on
 * this path. Its Jarvis boundary is in `jarvis.ts`.
 */
import type { Hono } from 'hono';
import type { Context } from 'hono';
import { logger } from '../../observability/logger.js';
import type { Capability } from '../../lib/auth/permissions.js';
import type { TokenPrincipal } from '../../lib/auth/dashboard-auth.js';
import { isKillSwitchActive } from '../../lib/state/kill-switches-repo.js';
import { listKnownAgents } from '../../lib/config/agent-loader.js';
import { autoAssign } from '../../lib/tools/mission-tools.js';
import { MISSION_STATUSES, type Mission, type MissionStatus } from '../../lib/state/mission-tasks-repo.js';
import {
  createBoardMission,
  listBoardMissions,
  reassignBoardMission,
  setBoardMissionStatus,
} from '../../lib/missions/mission-acl.js';
import {
  PaperclipDisabledError,
  PaperclipLockClosedError,
  PaperclipError,
  PaperclipPaginationTruncatedError,
  PaperclipProjectPausedError,
  PaperclipRatelimitedError,
  PaperclipUnavailableError,
} from '../../lib/paperclip/error.js';
import { UnknownAgentError } from '../../lib/paperclip/mission-projection.js';

type DashboardEnv = { Variables: { principal: TokenPrincipal } };
type MissionCtx = Context<DashboardEnv>;

export interface MissionRoutesDeps {
  /**
   * The dashboard's ONE capability helper. Passed in rather than imported so
   * this file does not import `handler.ts`, which imports this file — a cycle
   * that would work by hoisting and rot the first time someone reorders it.
   */
  hasCapability: (c: MissionCtx, need: Capability) => Promise<boolean>;
  /** `dashboardIdentity` — `dashboard:${tokenHash}`. The value the GDPR export filters on. */
  identity: (c: MissionCtx) => string;
  killSwitch?: typeof isKillSwitchActive;
  knownAgents?: () => string[];
  assign?: typeof autoAssign;
  list?: typeof listBoardMissions;
  create?: typeof createBoardMission;
  setStatus?: typeof setBoardMissionStatus;
  reassign?: typeof reassignBoardMission;
}

/**
 * Paperclip failures that have an HONEST HTTP answer. Everything else returns
 * `undefined` and is rethrown into `app.onError`'s `500 {error:'internal_error'}`
 * — the same rung a DynamoDB throw took on the legacy stack.
 *
 * The 503 and 429 rungs are NEW; legacy had no transport to be unavailable.
 * They are the price of the cutover and are named so the SPA's toast
 * (`web/src/lib/api.ts` renders `body.error` verbatim) says something true.
 *
 * THE DEFAULT IS 500, NOT 503, and that is the correction of a real bug: an
 * earlier revision returned `503 paperclip_unavailable` for ANY `PaperclipError`
 * that fell past the rungs above, which quietly turned a Paperclip 404 on a
 * route with no `owner`/`id` in scope — and every auth, conflict and
 * invalid-input failure — into a claim that the integration was DOWN. It is a
 * worse lie than the 500 it replaced, because 503 tells a caller to retry
 * something that will never work. Only the classes that genuinely mean "not
 * answerable right now" get 503; the rest fall through to the legacy rung.
 */
function paperclipFailure(
  err: unknown,
  ctx: { owner?: string; id?: string },
): { body: Record<string, unknown>; status: 400 | 404 | 429 | 503; retryAfter?: string } | undefined {
  // NOTE: `PaperclipDisabledError` is NOT mapped here. `fail()` intercepts it
  // ahead of this function and answers through `refuse()`, so the switch's
  // refusal has exactly one body no matter which rung produced it. Mapping it
  // here too would reintroduce the second, `reason`-less shape.
  if (err instanceof PaperclipRatelimitedError) {
    const wait = err.advertisedWaitMs();
    return {
      body: { error: 'paperclip_ratelimited' },
      status: 429,
      ...(wait === undefined ? {} : { retryAfter: String(Math.ceil(wait / 1_000)) }),
    };
  }
  // An ASSIGNMENT TARGET outside `metadata.netzarAgentId` — never a scoping
  // owner, which the ACL answers as an empty board (see `listBoardMissions`).
  // Reuses the legacy 400 shape, key `agentId`, so the SPA's copy is unchanged.
  //
  // `slug ?? uuid` is not defaulted to `''`. The class sets exactly one of them,
  // so neither being present means an assumption here is already wrong, and
  // putting an empty string on the wire would report a nameless agent as the
  // caller's input error. Fall through to the 500 rung instead.
  if (err instanceof UnknownAgentError) {
    const agentId = err.slug ?? err.uuid;
    if (agentId !== undefined) {
      return { body: { error: 'unknown_agent', agentId, valid: err.knownSlugs }, status: 400 };
    }
    return undefined;
  }
  if (err instanceof PaperclipError) {
    // A Paperclip 404 lands on the `invalid_input` rung (`typeForResponse`:
    // 400 and 404 share it), so the STATUS is what distinguishes them. Only
    // routes that carry `owner`/`id` can render the legacy body, and only they
    // have a 404 rung in the contract at all.
    if (err.status === 404 && ctx.owner !== undefined && ctx.id !== undefined) {
      return { body: { error: 'not_found', owner: ctx.owner, id: ctx.id }, status: 404 };
    }
    // Transport down, breaker open, project paused, or a sweep that hit the page
    // bound with rows remaining. Never a short board.
    if (
      err instanceof PaperclipUnavailableError ||
      err instanceof PaperclipProjectPausedError ||
      err instanceof PaperclipPaginationTruncatedError
    ) {
      return { body: { error: 'paperclip_unavailable' }, status: 503 };
    }
  }
  return undefined;
}

export function registerMissionRoutes(router: Hono<DashboardEnv>, deps: MissionRoutesDeps): void {
  const killSwitch = deps.killSwitch ?? isKillSwitchActive;
  const knownAgents = deps.knownAgents ?? listKnownAgents;
  const assign = deps.assign ?? autoAssign;
  const list = deps.list ?? listBoardMissions;
  const create = deps.create ?? createBoardMission;
  const setStatus = deps.setStatus ?? setBoardMissionStatus;
  const reassign = deps.reassign ?? reassignBoardMission;
  const { hasCapability, identity } = deps;

  /**
   * THE ONE `paperclip_disabled` BODY, built in ONE place by both sites that can
   * refuse for that reason: the pre-flight gate, and a `PaperclipDisabledError`
   * the transport throws mid-sequence. A caller cannot tell which rung answered.
   *
   * `reason` is CONDITIONALLY SPREAD — present when the operator wrote one,
   * ABSENT when they did not — which is the same absent-key-never-null rule the
   * mission rows follow. Spelling it `{reason: switched.reason}` instead relies
   * on `JSON.stringify` silently dropping `undefined`, which makes the shape an
   * accident of the serialiser rather than a decision, and hides that the key is
   * optional from anyone reading the handler.
   */
  function disabled(c: MissionCtx, reason?: string): Response {
    return c.json({ error: 'paperclip_disabled', ...(reason ? { reason } : {}) }, 503);
  }

  /**
   * The mid-sequence refusal. It RE-READS the switch only to recover the
   * operator's `reason` for a condition the transport has already decided — the
   * read is free, since `isKillSwitchActive` is 30s-cached, and its `active` is
   * deliberately NOT consulted: `PaperclipDisabledError` is itself the proof
   * that the transport refused. Gating on a re-read here would let a switch
   * flipped off between two round trips turn a refusal that already happened
   * into a success the caller never got, or a bare 500.
   */
  async function refuse(c: MissionCtx): Promise<Response> {
    const switched = await killSwitch('paperclip_disabled');
    return disabled(c, switched.reason);
  }

  /**
   * The two pre-flight gates every route runs, IN THIS ORDER, and the order is
   * a security decision rather than a style one.
   *
   * CAPABILITY FIRST, KILL SWITCH SECOND. The tempting order is the reverse —
   * refuse as early and as cheaply as possible — and it leaks. The switch's
   * `reason` is operator free text ("INCIDENT-42: customer PII leak in board
   * titles"), so answering the switch first hands that sentence to a principal
   * the legacy stack answered `403 forbidden`. An integration being switched
   * off is not a reason to widen who may learn WHY it is off. Authorization is
   * decided on the caller, never on the state of the backend.
   *
   * Nothing rests on the reverse order: `hasCapability` only resolves the
   * principal's capability set, so running it first has no side effect a
   * switched-off integration should have skipped, and neither gate touches the
   * engine. The refusal still precedes every Paperclip call, which is what
   * acceptance 7b actually asks for.
   */
  async function gates(c: MissionCtx, need: Capability): Promise<Response | undefined> {
    if (!(await hasCapability(c, need))) {
      return c.json({ error: 'forbidden', requiredCapability: need }, 403);
    }
    const switched = await killSwitch('paperclip_disabled');
    if (!switched.active) return undefined;
    return disabled(c, switched.reason);
  }

  async function fail(
    c: MissionCtx,
    err: unknown,
    ctx: { owner?: string; id?: string },
  ): Promise<Response> {
    // The switch flipped between two round trips. Same condition as the gate,
    // so the same body — including the operator's `reason`, which the gate
    // supplies and this path used to drop.
    if (err instanceof PaperclipLockClosedError) return c.json({ error: 'paperclip_locked', code: err.lockCode }, 503);
    if (err instanceof PaperclipDisabledError) return refuse(c);
    const mapped = paperclipFailure(err, ctx);
    if (!mapped) throw err;
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), error: mapped.body.error },
      'paperclip mission route refused',
    );
    const res = c.json(mapped.body, mapped.status);
    if (mapped.retryAfter) res.headers.set('Retry-After', mapped.retryAfter);
    return res;
  }

  // ── R1 ────────────────────────────────────────────────────────────────────
  // `{owner, count, missions}` — `count` was ALWAYS `missions.length`, never a
  // total, so the artifact's missing totals endpoint costs this route nothing.
  //
  // `owner` IS NOT VALIDATED HERE, and the reason is a division of labour rather
  // than an oversight. Legacy scoped a DynamoDB partition and never validated
  // either: an owner with no partition returned `200 {count:0}`. The equivalent
  // answer on the Paperclip stack is made in `listBoardMissions`, which absorbs
  // the `UnknownAgentError` that `engine.listMissions` raises for a slug outside
  // the agent map and returns an empty board — see the comment there for why the
  // catch is narrowed to the scoping argument. Validating `owner` in this
  // handler would only produce a 400 on a route whose contract has no 400 rung
  // at all. UNVERIFIED by probe either way: no probe asserts what the surface
  // does with an unmapped assignee filter, which is exactly why the ACL never
  // sends one.
  router.get('/missions', async (c) => {
    const denied = await gates(c, 'missions:read');
    if (denied) return denied;
    const owner = c.req.query('owner') ?? 'main';
    try {
      const rows = await list(owner, 100);
      return c.json({ owner, count: rows.length, missions: rows });
    } catch (err) {
      return fail(c, err, {});
    }
  });

  // ── R2 ────────────────────────────────────────────────────────────────────
  // 201, not 200. `assignmentReason` is ALWAYS present on this route's row —
  // one of 'explicit assignment', the Haiku reason, or the degraded default —
  // Auto-assign failure is NOT an error path:
  // it is caught, logged and degrades to `main` with a 201.
  router.post('/missions', async (c) => {
    const denied = await gates(c, 'agents:write');
    if (denied) return denied;
    const body = await c.req
      .json<{ prompt?: string; agentId?: string; title?: string }>()
      .catch(() => null);
    const prompt = body?.prompt?.trim();
    if (!prompt) return c.json({ error: 'missing_prompt' }, 400);
    const title =
      body?.title?.trim() || prompt.split('\n')[0].trim().slice(0, 80) || 'Untitled mission';

    let owner: string;
    let assignmentReason: string;
    const explicit = body?.agentId?.trim();
    if (explicit) {
      const known = knownAgents();
      if (!known.includes(explicit)) {
        return c.json({ error: 'unknown_agent', agentId: explicit, valid: known }, 400);
      }
      owner = explicit;
      assignmentReason = 'explicit assignment';
    } else {
      try {
        const picked = await assign(title, prompt);
        owner = picked.owner;
        assignmentReason = picked.reason;
      } catch (err) {
        logger.warn(
          { errMessage: err instanceof Error ? err.message : String(err) },
          'mission auto-assign failed; defaulting to main',
        );
        owner = 'main';
        assignmentReason = 'auto-assign failed; defaulted to main';
      }
    }

    try {
      const mission = await create({
        ownerAgent: owner,
        createdByAgent: 'dashboard',
        // The C-11 value. It reaches the wire through the provenance row, not
        // through Paperclip, which has nowhere to put it.
        createdByChat: identity(c),
        title,
        body: prompt,
        assignmentReason,
      });
      return c.json({ mission }, 201);
    } catch (err) {
      return fail(c, err, {});
    }
  });

  // ── R3 ────────────────────────────────────────────────────────────────────
  // Echoes the REQUEST `owner`/`id` verbatim, not the resolved row: an 8-char
  // prefix in, the same 8-char prefix out. No mission body is returned.
  router.post('/missions/:owner/:id/status', async (c) => {
    const denied = await gates(c, 'agents:write');
    if (denied) return denied;
    const owner = c.req.param('owner');
    const id = c.req.param('id');
    const body = await c.req.json<{ status: MissionStatus }>().catch(() => null);
    if (!body || !body.status) return c.json({ error: 'missing_status' }, 400);
    if (!MISSION_STATUSES.includes(body.status)) {
      // `valid` serialises in MISSION_STATUSES order, which is contract.
      return c.json(
        { error: 'invalid_status', status: body.status, valid: MISSION_STATUSES },
        400,
      );
    }
    try {
      const ok = await setStatus(owner, id, body.status);
      if (!ok) return c.json({ error: 'not_found', owner, id }, 404);
      return c.json({ ok: true, owner, id, status: body.status });
    } catch (err) {
      return fail(c, err, { owner, id });
    }
  });

  // ── R4 ────────────────────────────────────────────────────────────────────
  // `unknown_agent`'s key is `agentId` here too, despite the request field
  // being `ownerAgent`. That asymmetry is legacy and is preserved.
  router.post('/missions/:owner/:id/reassign', async (c) => {
    const denied = await gates(c, 'agents:write');
    if (denied) return denied;
    const owner = c.req.param('owner');
    const id = c.req.param('id');
    const body = await c.req.json<{ ownerAgent?: string }>().catch(() => null);
    const newOwner = body?.ownerAgent?.trim();
    if (!newOwner) return c.json({ error: 'missing_ownerAgent' }, 400);
    const known = knownAgents();
    if (!known.includes(newOwner)) {
      return c.json({ error: 'unknown_agent', agentId: newOwner, valid: known }, 400);
    }
    try {
      const mission: Mission | null = await reassign(owner, id, newOwner);
      if (!mission) return c.json({ error: 'not_found', owner, id }, 404);
      return c.json({ ok: true, mission });
    } catch (err) {
      return fail(c, err, { owner, id });
    }
  });
}
