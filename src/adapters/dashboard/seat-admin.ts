/**
 * Seat administration + seat self-service router. Mounted at /api/seats
 * (see src/server.ts).
 *
 * Absorbed from PR #42's seat-admin design, trimmed to the seat/policy/usage
 * plane (no workspace surface, no EC2 runtime). Capability gates per route
 * group, resolved through principalHasRouteCapability (custom profiles work,
 * env break-glass always passes):
 *
 *   GET  /                      seats:read           list seats (paginated)
 *   POST /                      seats:write          create a seat
 *   PATCH /:seatId              seats:write          change status / policy
 *   GET  /policies              seat-policies:read   list policies
 *   POST /policies              seat-policies:write  create a policy
 *   PATCH /policies/:policyId   seat-policies:write  update a policy
 *   GET  /usage?date=           usage:org:read       org-wide usage for a day
 *   GET  /me                    usage:self:read      caller's own seat+policy
 *   GET  /me/usage?date=        usage:self:read      caller's own usage rows
 *
 * The /me routes are strictly caller-scoped: identity comes from the
 * principal's userId (magic-link session), never from a query param, so a
 * seat user can never read another seat's rows. Principals without a userId
 * (env break-glass, legacy operator tokens) get 404 — they hold no seat.
 *
 * Usage rows are READ here only; they are written by the spend-ledger
 * metering hook (issue #15), not by any dashboard route.
 */

import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import {
  authenticateDashboardToken,
  extractBearerToken,
  type TokenPrincipal,
} from '../../lib/auth/dashboard-auth.js';
import { principalHasRouteCapability } from '../../lib/auth/route-capability.js';
import type { Capability } from '../../lib/auth/permissions.js';
import { writeAudit } from '../../lib/audit/audit-writer.js';
import {
  getSeat,
  getSeatForUser,
  getSeatPolicy,
  listSeatPolicies,
  listSeats,
  listSeatUsage,
  listSeatUsageForSeat,
  newSeat,
  patchSeat,
  putSeat,
  putSeatPolicy,
} from '../../lib/admin/seat-repo.js';
import { isSeatStatus, type SeatPolicy } from '../../lib/admin/seat-model.js';

type SeatAdminEnv = { Variables: { principal: TokenPrincipal } };

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function limitFromQuery(raw: string | undefined): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 50;
  return Math.min(Math.max(Math.trunc(n), 1), 100);
}

function dateFromQuery(raw: string | undefined): string | null {
  if (raw === undefined) return new Date().toISOString().slice(0, 10);
  return DATE_RE.test(raw) ? raw : null;
}

async function readJson(c: { req: { json: () => Promise<unknown> } }): Promise<
  Record<string, unknown>
> {
  try {
    return (await c.req.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Build a policy from a create body. Unknown fields are dropped, not stored. */
function policyFromBody(body: Record<string, unknown>, actor: string): SeatPolicy {
  const now = new Date().toISOString();
  return {
    policyId: randomUUID(),
    label: typeof body.label === 'string' && body.label.trim() !== '' ? body.label.trim() : 'Seat policy',
    allowedModels: Array.isArray(body.allowedModels) ? body.allowedModels.map(String) : [],
    ...(typeof body.monthlySpendLimitUsd === 'number' &&
    Number.isFinite(body.monthlySpendLimitUsd) &&
    body.monthlySpendLimitUsd >= 0
      ? { monthlySpendLimitUsd: body.monthlySpendLimitUsd }
      : {}),
    allowedTools: Array.isArray(body.allowedTools) ? body.allowedTools.map(String) : [],
    createdAt: now,
    createdBy: actor,
    updatedAt: now,
    updatedBy: actor,
  };
}

export function buildSeatAdminRouter(): Hono<SeatAdminEnv> {
  const router = new Hono<SeatAdminEnv>();

  // Authenticate every request; capability gates are per route group below.
  router.use('*', async (c, next) => {
    const raw = extractBearerToken(c.req.header('authorization'));
    const principal = await authenticateDashboardToken(raw);
    if (!principal) return c.json({ error: 'unauthorized' }, 401);
    c.set('principal', principal);
    await next();
  });

  const requireCap = async (
    c: { get: (k: 'principal') => TokenPrincipal },
    cap: Capability,
  ): Promise<boolean> => principalHasRouteCapability(c.get('principal'), cap);

  const forbidden = (c: { json: (b: unknown, s: 403) => Response }, cap: Capability) =>
    c.json({ error: 'forbidden', requiredCapability: cap }, 403);

  // ── Self-service (usage:self:read) — literal paths BEFORE /:seatId ──

  // GET /me — the caller's own seat + resolved policy.
  router.get('/me', async (c) => {
    if (!(await requireCap(c, 'usage:self:read'))) return forbidden(c, 'usage:self:read');
    const userId = c.get('principal').userId;
    if (!userId) return c.json({ error: 'no seat' }, 404);
    const seat = await getSeatForUser(userId);
    if (!seat) return c.json({ error: 'no seat' }, 404);
    const policy = await getSeatPolicy(seat.policyId);
    return c.json({ seat, policy });
  });

  // GET /me/usage?date=YYYY-MM-DD — the caller's own usage rows for one day.
  router.get('/me/usage', async (c) => {
    if (!(await requireCap(c, 'usage:self:read'))) return forbidden(c, 'usage:self:read');
    const userId = c.get('principal').userId;
    if (!userId) return c.json({ error: 'no seat' }, 404);
    const date = dateFromQuery(c.req.query('date'));
    if (!date) return c.json({ error: 'date must be YYYY-MM-DD' }, 400);
    const seat = await getSeatForUser(userId);
    if (!seat) return c.json({ error: 'no seat' }, 404);
    const page = await listSeatUsageForSeat({
      date,
      seatId: seat.seatId,
      limit: limitFromQuery(c.req.query('limit')),
      cursor: c.req.query('cursor'),
    });
    return c.json({ date, ...page });
  });

  // ── Seat policies (seat-policies:read / seat-policies:write) ──

  router.get('/policies', async (c) => {
    if (!(await requireCap(c, 'seat-policies:read'))) return forbidden(c, 'seat-policies:read');
    const page = await listSeatPolicies({
      limit: limitFromQuery(c.req.query('limit')),
      cursor: c.req.query('cursor'),
    });
    return c.json(page);
  });

  router.post('/policies', async (c) => {
    if (!(await requireCap(c, 'seat-policies:write'))) return forbidden(c, 'seat-policies:write');
    const principal = c.get('principal');
    const body = await readJson(c);
    const policy = policyFromBody(body, principal.label);
    await putSeatPolicy(policy);
    void writeAudit({
      action: 'seat_policy_created',
      operatorLabel: principal.label,
      detail: { policyId: policy.policyId, label: policy.label, models: policy.allowedModels.length },
      result: 'ok',
    });
    return c.json(policy, 201);
  });

  router.patch('/policies/:policyId', async (c) => {
    if (!(await requireCap(c, 'seat-policies:write'))) return forbidden(c, 'seat-policies:write');
    const principal = c.get('principal');
    const policyId = c.req.param('policyId');
    if (!ID_RE.test(policyId)) return c.json({ error: 'invalid policyId' }, 400);
    const existing = await getSeatPolicy(policyId);
    if (!existing) return c.json({ error: 'not found' }, 404);
    const body = await readJson(c);
    const updated: SeatPolicy = {
      ...existing,
      label:
        typeof body.label === 'string' && body.label.trim() !== ''
          ? body.label.trim()
          : existing.label,
      allowedModels: Array.isArray(body.allowedModels)
        ? body.allowedModels.map(String)
        : existing.allowedModels,
      allowedTools: Array.isArray(body.allowedTools)
        ? body.allowedTools.map(String)
        : existing.allowedTools,
      ...(typeof body.monthlySpendLimitUsd === 'number' &&
      Number.isFinite(body.monthlySpendLimitUsd) &&
      body.monthlySpendLimitUsd >= 0
        ? { monthlySpendLimitUsd: body.monthlySpendLimitUsd }
        : body.monthlySpendLimitUsd === null
          ? {}
          : existing.monthlySpendLimitUsd !== undefined
            ? { monthlySpendLimitUsd: existing.monthlySpendLimitUsd }
            : {}),
      updatedAt: new Date().toISOString(),
      updatedBy: principal.label,
    };
    await putSeatPolicy(updated);
    void writeAudit({
      action: 'seat_policy_updated',
      operatorLabel: principal.label,
      detail: { policyId },
      result: 'ok',
    });
    return c.json(updated);
  });

  // ── Org-wide usage (usage:org:read) ──

  router.get('/usage', async (c) => {
    if (!(await requireCap(c, 'usage:org:read'))) return forbidden(c, 'usage:org:read');
    const date = dateFromQuery(c.req.query('date'));
    if (!date) return c.json({ error: 'date must be YYYY-MM-DD' }, 400);
    const page = await listSeatUsage({
      date,
      limit: limitFromQuery(c.req.query('limit')),
      cursor: c.req.query('cursor'),
    });
    return c.json({ date, ...page });
  });

  // ── Seats (seats:read / seats:write) ──

  router.get('/', async (c) => {
    if (!(await requireCap(c, 'seats:read'))) return forbidden(c, 'seats:read');
    const page = await listSeats({
      limit: limitFromQuery(c.req.query('limit')),
      cursor: c.req.query('cursor'),
    });
    return c.json(page);
  });

  router.post('/', async (c) => {
    if (!(await requireCap(c, 'seats:write'))) return forbidden(c, 'seats:write');
    const principal = c.get('principal');
    const body = await readJson(c);
    const userId = typeof body.userId === 'string' ? body.userId.trim() : '';
    const policyId = typeof body.policyId === 'string' ? body.policyId.trim() : '';
    if (!userId || !ID_RE.test(userId)) return c.json({ error: 'userId required' }, 400);
    if (!policyId || !ID_RE.test(policyId)) return c.json({ error: 'policyId required' }, 400);
    if (body.status !== undefined && !isSeatStatus(body.status)) {
      return c.json({ error: 'invalid status' }, 400);
    }
    const policy = await getSeatPolicy(policyId);
    if (!policy) return c.json({ error: 'policy not found' }, 400);
    // One seat per user: creating a second would silently repoint the
    // user→seat link, so refuse loudly instead.
    const existing = await getSeatForUser(userId);
    if (existing) {
      return c.json({ error: 'user already has a seat', seatId: existing.seatId }, 409);
    }
    const seat = newSeat({
      seatId: randomUUID(),
      userId,
      policyId,
      ...(body.status !== undefined && isSeatStatus(body.status) ? { status: body.status } : {}),
      createdBy: principal.label,
    });
    await putSeat(seat);
    void writeAudit({
      action: 'seat_created',
      operatorLabel: principal.label,
      detail: { seatId: seat.seatId, userId, policyId, status: seat.status },
      result: 'ok',
    });
    return c.json(seat, 201);
  });

  router.patch('/:seatId', async (c) => {
    if (!(await requireCap(c, 'seats:write'))) return forbidden(c, 'seats:write');
    const principal = c.get('principal');
    const seatId = c.req.param('seatId');
    if (!ID_RE.test(seatId)) return c.json({ error: 'invalid seatId' }, 400);
    const existing = await getSeat(seatId);
    if (!existing) return c.json({ error: 'not found' }, 404);
    const body = await readJson(c);
    if (body.status !== undefined && !isSeatStatus(body.status)) {
      return c.json({ error: 'invalid status' }, 400);
    }
    if (body.policyId !== undefined) {
      if (typeof body.policyId !== 'string' || !ID_RE.test(body.policyId)) {
        return c.json({ error: 'invalid policyId' }, 400);
      }
      const policy = await getSeatPolicy(body.policyId);
      if (!policy) return c.json({ error: 'policy not found' }, 400);
    }
    const updated = patchSeat(
      existing,
      {
        ...(body.status !== undefined && isSeatStatus(body.status) ? { status: body.status } : {}),
        ...(typeof body.policyId === 'string' ? { policyId: body.policyId } : {}),
      },
      principal.label,
    );
    await putSeat(updated);
    void writeAudit({
      action: 'seat_updated',
      operatorLabel: principal.label,
      detail: { seatId, status: updated.status, policyId: updated.policyId },
      result: 'ok',
    });
    return c.json(updated);
  });

  return router;
}
