import { Hono } from 'hono';
import type { TokenPrincipal } from '../../lib/auth/dashboard-auth.js';
import { authenticateDashboardToken, extractBearerToken } from '../../lib/auth/dashboard-auth.js';
import { principalHasRouteCapability } from '../../lib/auth/route-capability.js';
import { paperclipRoutingEnabled } from '../../lib/missions/mission-acl.js';
import { isKillSwitchActive } from '../../lib/state/kill-switches-repo.js';
import { dynamoShadowRows } from '../../lib/paperclip/shadow-rows-dynamo.js';
import type { ShadowUser } from '../../lib/paperclip/shadow-users.js';
import { getUser } from '../../lib/state/users-repo.js';
import { writeAudit } from '../../lib/audit/audit-writer.js';
import { logger } from '../../observability/logger.js';
import type { ShadowRows } from '../../lib/paperclip/shadow-users.js';
import { dynamoPayloadRows, readApprovalPayload, type PayloadRows } from '../../lib/work/approval-payloads.js';
import { APPROVAL_TYPE, ApprovalAttributionError, ApprovalRefusedError, type ApprovalRecord } from '../../lib/work/approvals.js';
import { defaultApprovals } from '../../lib/work/approvals-paperclip.js';
import { paperclipWorkReads, WorkReadError, validNetzerApprovalPayload, type WorkApprovalPayload } from '../../lib/work/work-reads.js';
export { WorkReadError } from '../../lib/work/work-reads.js';

export type PipelineSummary = { id: string; name: string; stages: { id: string; key: string; name: string; kind: string }[] };
export type CaseSummary = { id: string; caseKey: string; title: string; pipeline: { id: string; name: string }; stage: { id: string; key: string; name: string; kind: string }; status: 'active' | 'blocked' | 'done' | 'cancelled'; owner: { kind: 'agent' | 'person' | 'none'; name: string | null }; updatedAt: string };
export type WorkCase = CaseSummary & { leaseUserId: string | null };
export type WorkCaseDetail = WorkCase & { summary: string | null; fields: { name: string; value: string }[]; blockers: { id: string; title: string }[]; timeline: { at: string; kind: 'event' | 'comment'; actor: string | null; text: string }[] };
export type WorkApproval = ApprovalRecord & { createdAt: string; decisionNote?: string | null };
export type ApprovalSummary = { id: string; status: string; decisionClass: string; decisionLabel: string; caseId: string | null; caseKey: string; caseTitle: string | null; stage: string; stageName: string | null; step: string; stageEntryNo: number; requestedAt: string; decidedAt: string | null; canDecide: boolean };
export type ApprovalDetail = ApprovalSummary & { payloadSha256: string; payload: { state: 'verified'; value: unknown } | { state: 'unavailable' } | { state: 'mismatch' }; cannotDecideReason: string | null; decidedBy: string | null; decisionComment: string | null };
export type WorkReads = { listPipelines(): Promise<PipelineSummary[]>; listCases(q: { pipeline?: string; stage?: string; status: 'active' | 'blocked' | 'done' | 'all' }): Promise<{ cases: WorkCase[]; truncated: boolean }>; getCase(caseId: string): Promise<WorkCaseDetail | undefined>; listApprovals(status: 'pending' | 'all'): Promise<{ approvals: WorkApproval[]; truncated: boolean }>; getApproval(approvalId: string): Promise<WorkApproval | undefined> };
// The injectable seam accepts Vitest spies as well as plain functions. The
// runtime calls below still use the WorkReads signatures and the decide shape.
type DecisionRequest = { netzerUserId: string; approvalId: string; decision: 'approve' | 'reject' | 'request_changes'; comment?: string | undefined };
type Spy<F extends (...args: never[]) => unknown> = F & {
  mock: { calls: unknown[][] };
  mockResolvedValueOnce(value: Awaited<ReturnType<F>>): unknown;
  mockImplementation(fn: F): unknown;
};
export type WorkRouterDeps = {
  authenticate(authorization: string | undefined): Promise<TokenPrincipal | null>;
  hasCapability(principal: TokenPrincipal, capability: 'work:read' | 'work:approve'): Promise<boolean>;
  enabled(): boolean;
  killSwitch(name: 'paperclip_disabled'): Promise<{ active: boolean }>;
  reads: WorkReads;
  shadows: Pick<ShadowRows, 'getByNetzerUser' | 'getByPaperclipUser'>;
  displayName(id: string): Promise<string | null>;
  payloads: PayloadRows;
  decide(req: DecisionRequest): Promise<unknown>;
};
export type WorkDeps = Omit<WorkRouterDeps, 'reads' | 'decide'> & {
  reads: Omit<WorkReads, 'listCases' | 'listApprovals' | 'getApproval'> & {
    listCases: Spy<WorkReads['listCases']>;
    listApprovals: Spy<WorkReads['listApprovals']>;
    getApproval: Spy<WorkReads['getApproval']>;
  };
  decide: Spy<WorkRouterDeps['decide']>;
};

type Env = { Variables: { principal: TokenPrincipal } };
type Body = { decision: 'approve' | 'reject' | 'request_changes'; payloadSha256: string; comment?: string };
type ApprovalBody = WorkApprovalPayload;
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
function approvalBody(a: WorkApproval | undefined): ApprovalBody | undefined {
  if (!a || a.type !== APPROVAL_TYPE || !validNetzerApprovalPayload(a.payload)) return undefined;
  return a.payload;
}
function parseBody(v: unknown): Body | undefined {
  if (!record(v) || typeof v.decision !== 'string' || !['approve', 'reject', 'request_changes'].includes(v.decision)
    || typeof v.payloadSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(v.payloadSha256)
    || (v.comment !== undefined && typeof v.comment !== 'string')) return undefined;
  return { decision: v.decision as Body['decision'], payloadSha256: v.payloadSha256,
    ...(typeof v.comment === 'string' ? { comment: v.comment } : {}) };
}
const validId = (id: string): boolean => /^[A-Za-z0-9_-]{1,128}$/.test(id);
async function limitedBody(request: Request): Promise<{ text?: string; tooLarge: boolean }> {
  const length = Number(request.headers.get('content-length'));
  if (Number.isFinite(length) && length > 16_384) return { tooLarge: true };
  const reader = request.body?.getReader();
  if (!reader) return { text: '', tooLarge: false };
  const decoder = new TextDecoder(); let bytes = 0; let text = '';
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    bytes += part.value.byteLength;
    if (bytes > 16_384) { await reader.cancel(); return { tooLarge: true }; }
    text += decoder.decode(part.value, { stream: true });
  }
  return { text: text + decoder.decode(), tooLarge: false };
}
const withoutLease = <T extends WorkCase>(value: T): Omit<T, 'leaseUserId'> => {
  const { leaseUserId: _lease, ...safe } = value;
  return safe;
};
const titleCase = (s: string): string => s.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

let sharedReads: WorkReads | undefined;
const defaultDeps = new WeakSet<WorkRouterDeps>();
const workKillSwitch = (name: 'paperclip_disabled' | 'dashboard_read_disabled') => isKillSwitchActive(name);
export function defaultWorkDeps(): WorkRouterDeps {
  const shadows = dynamoShadowRows();
  const deps: WorkRouterDeps = { authenticate: async (header) => {
    const principal = await authenticateDashboardToken(extractBearerToken(header));
    if (!principal) {
      logger.warn({}, 'dashboard auth failure');
      void writeAudit({ action: 'auth_failure', surface: 'dashboard', result: 'blocked' });
    }
    return principal;
  },
    hasCapability: principalHasRouteCapability, enabled: paperclipRoutingEnabled, killSwitch: workKillSwitch,
    reads: sharedReads ??= paperclipWorkReads(), shadows,
    displayName: async (id) => (await getUser(id))?.email ?? null,
    payloads: dynamoPayloadRows(), decide: (req) => defaultApprovals().decide(req) };
  defaultDeps.add(deps);
  return deps;
}

export function buildWorkRouter(deps: WorkRouterDeps = defaultWorkDeps()): Hono<Env> {
  const router = new Hono<Env>();
  router.onError((error, c) => {
    if (error instanceof WorkReadError) {
      if (error.code === 'paperclip_ratelimited') return c.json({ error: 'paperclip_ratelimited' }, 429);
      if (error.code === 'paperclip_locked') return c.json({ error: 'paperclip_locked' }, 503);
      return c.json({ error: 'paperclip_unavailable' }, 503);
    }
    logger.error({ error: error instanceof Error ? error.name : 'Unknown', route: c.req.routePath }, 'work_route_failed');
    return c.json({ error: 'internal_error' }, 500);
  });
  router.use('*', async (c, next) => {
    const principal = await deps.authenticate(c.req.header('authorization'));
    if (!principal) return c.json({ error: 'unauthorized' }, 401);
    c.set('principal', principal);
    if (defaultDeps.has(deps) && c.req.method === 'GET') {
      const blocked = await (deps.killSwitch as typeof workKillSwitch)('dashboard_read_disabled');
      if (blocked.active) return c.json({ error: 'dashboard_read_disabled', reason: blocked.reason }, 503);
    }
    await next();
  });
  router.get('/status', async (c) => c.json({ enabled: deps.enabled() && !(await deps.killSwitch('paperclip_disabled')).active }));
  router.use('*', async (c, next) => {
    const principal = c.get('principal');
    const need = c.req.method === 'POST' ? 'work:approve' : 'work:read';
    if (!(await deps.hasCapability(principal, need))) return c.json({ error: 'forbidden', requiredCapability: need }, 403);
    if (!deps.enabled()) return c.json({ error: 'work_disabled' }, 503);
    if ((await deps.killSwitch('paperclip_disabled')).active) return c.json({ error: 'paperclip_disabled' }, 503);
    await next();
  });
  async function shadow(principal: TokenPrincipal): Promise<ShadowUser | undefined> {
    if (!principal.userId) return undefined;
    const row = await deps.shadows.getByNetzerUser(principal.userId);
    return row?.status === 'active' ? row : undefined;
  }
  function decisionReason(a: WorkApproval, p: ApprovalBody, canApprove: boolean, principal: TokenPrincipal, sh?: ShadowUser,
    payloadState?: 'verified' | 'unavailable' | 'mismatch'): string | null {
    if (a.status !== 'pending') return 'not_pending';
    if (!canApprove) return 'missing_capability';
    if (!principal.userId) return 'no_user_session';
    if (!sh) return 'not_an_approver';
    if (!sh.decisionClasses.includes(p.decisionClass)) return 'class_not_entitled';
    if (payloadState === 'unavailable') return 'payload_unavailable';
    if (payloadState === 'mismatch') return 'payload_mismatch';
    return null;
  }
  function summary(a: WorkApproval, principal: TokenPrincipal, canApprove: boolean, sh?: ShadowUser, cases?: WorkCase[], pipelines?: PipelineSummary[]): ApprovalSummary | undefined {
    const p = approvalBody(a);
    if (!p) return undefined;
    const found = cases?.find((c) => c.caseKey === p.caseKey);
    const stages = found ? pipelines?.find((flow) => flow.id === found.pipeline.id)?.stages : pipelines?.flatMap((flow) => flow.stages);
    const stageName = stages?.find((stage) => stage.key === p.stage)?.name ?? null;
    return { id: a.id, status: a.status, decisionClass: p.decisionClass, decisionLabel: titleCase(p.decisionClass),
      caseId: found?.id ?? null, caseKey: p.caseKey, caseTitle: found?.title ?? null, stage: p.stage,
      stageName, step: p.step, stageEntryNo: p.stageEntryNo, requestedAt: a.createdAt,
      decidedAt: a.decidedAt ?? null, canDecide: decisionReason(a, p, canApprove, principal, sh) === null };
  }
  async function allCases(): Promise<WorkCase[]> { return (await deps.reads.listCases({ status: 'all' })).cases; }
  async function listedApprovals(status: 'pending' | 'all', principal: TokenPrincipal, canApprove: boolean, sh?: ShadowUser, cases?: WorkCase[]) {
    const result = await deps.reads.listApprovals(status);
    const pipelines = await deps.reads.listPipelines();
    const approvals = result.approvals.map((a) => summary(a, principal, canApprove, sh, cases, pipelines)).filter((a): a is ApprovalSummary => !!a);
    return { approvals, truncated: result.truncated };
  }

  router.get('/inbox', async (c) => {
    const principal = c.get('principal');
    const canApprove = await deps.hasCapability(principal, 'work:approve');
    const sh = await shadow(principal);
    const cases = await allCases();
    const { approvals } = await listedApprovals('pending', principal, canApprove, sh, cases);
    return c.json({ approverSetUp: !!sh && canApprove,
      approvals: approvals.filter((a) => a.canDecide).sort((a, b) => a.requestedAt.localeCompare(b.requestedAt)),
      blocked: cases.filter((item) => item.status === 'blocked').map(withoutLease),
      mine: sh ? cases.filter((item) => item.leaseUserId === sh.paperclipUserId && item.status !== 'done' && item.status !== 'cancelled').map(withoutLease) : [] });
  });
  router.get('/cases', async (c) => {
    const status = c.req.query('status') ?? 'active';
    if (!['active', 'blocked', 'done', 'all'].includes(status)) return c.json({ error: 'invalid_query' }, 400);
    const pipeline = c.req.query('pipeline'); const stage = c.req.query('stage');
    const result = await deps.reads.listCases({ ...(pipeline ? { pipeline } : {}), ...(stage ? { stage } : {}), status: status as 'active' | 'blocked' | 'done' | 'all' });
    return c.json({ cases: result.cases.map(withoutLease), pipelines: await deps.reads.listPipelines(), truncated: result.truncated });
  });
  router.get('/cases/:caseId', async (c) => {
    const caseId = c.req.param('caseId');
    if (!validId(caseId)) return c.json({ error: 'not_found' }, 404);
    const item = await deps.reads.getCase(caseId);
    if (!item) return c.json({ error: 'not_found' }, 404);
    const principal = c.get('principal');
    const sh = await shadow(principal);
    const { approvals } = await listedApprovals('all', principal, await deps.hasCapability(principal, 'work:approve'), sh, [item]);
    return c.json({ case: { ...withoutLease(item), approvals: approvals.filter((a) => a.caseKey === item.caseKey) } });
  });
  router.get('/approvals', async (c) => {
    const status = c.req.query('status') ?? 'pending';
    if (status !== 'pending' && status !== 'all') return c.json({ error: 'invalid_query' }, 400);
    const principal = c.get('principal');
    const canApprove = await deps.hasCapability(principal, 'work:approve');
    return c.json(await listedApprovals(status, principal, canApprove, await shadow(principal), await allCases()));
  });
  router.get('/approvals/:approvalId', async (c) => {
    const approvalId = c.req.param('approvalId');
    if (!validId(approvalId)) return c.json({ error: 'not_found' }, 404);
    const a = await deps.reads.getApproval(approvalId);
    const p = approvalBody(a);
    if (!a || !p) return c.json({ error: 'not_found' }, 404);
    const principal = c.get('principal'); const sh = await shadow(principal);
    const canApprove = await deps.hasCapability(principal, 'work:approve');
    const cases = await allCases().catch(() => [] as WorkCase[]);
    const pipelines = await deps.reads.listPipelines().catch(() => [] as PipelineSummary[]);
    const base = summary(a, principal, canApprove, sh, cases, pipelines);
    const checked = await readApprovalPayload(deps.payloads, p);
    const reason = decisionReason(a, p, canApprove, principal, sh, checked.state);
    const payload = checked.state === 'verified' ? { state: 'verified' as const, value: checked.value } : { state: checked.state };
    const decidedShadow = a.decidedByUserId ? await deps.shadows.getByPaperclipUser(a.decidedByUserId) : undefined;
    const decidedBy = decidedShadow ? await deps.displayName(decidedShadow.netzerUserId) : null;
    return c.json({ approval: { ...base, canDecide: reason === null, payloadSha256: p.payloadSha256, payload,
      cannotDecideReason: reason, decidedBy, decisionComment: a.decisionNote ?? null } });
  });
  router.post('/approvals/:approvalId/decision', async (c) => {
    const approvalId = c.req.param('approvalId');
    if (!validId(approvalId)) return c.json({ error: 'not_found' }, 404);
    const principal = c.get('principal');
    if (!principal.userId) return c.json({ error: 'no_user_session' }, 403);
    const input = await limitedBody(c.req.raw);
    if (input.tooLarge) return c.json({ error: 'body_too_large' }, 413);
    let parsed: unknown;
    try { parsed = input.text ? JSON.parse(input.text) as unknown : undefined; } catch { parsed = undefined; }
    const body = parseBody(parsed);
    if (!body) return c.json({ error: 'invalid_body' }, 400);
    if (body.comment && body.comment.length > 4_000) return c.json({ error: 'comment_too_long' }, 400);
    const first = await deps.reads.getApproval(approvalId);
    const p = approvalBody(first);
    if (!p) return c.json({ error: 'not_found' }, 404);
    if (first?.status !== 'pending') return c.json({ error: 'not_pending' }, 409);
    if (body.payloadSha256 !== p.payloadSha256) return c.json({ error: 'stale_payload' }, 409);
    const checked = await readApprovalPayload(deps.payloads, p);
    if (checked.state === 'unavailable') return c.json({ error: 'payload_unavailable' }, 409);
    if (checked.state === 'mismatch') return c.json({ error: 'payload_mismatch' }, 409);
    try {
      await deps.decide({
        netzerUserId: principal.userId,
        approvalId, decision: body.decision, comment: body.comment,
      });
      return c.json({ ok: true, approvalId, decision: body.decision });
    } catch (error) {
      if (error instanceof ApprovalRefusedError) {
        if (error.code === 'comment_required') return c.json({ error: 'comment_required' }, 400);
        if (error.code === 'comment_too_long') return c.json({ error: 'comment_too_long' }, 400);
        if (error.code === 'not_an_approver') return c.json({ error: 'not_an_approver' }, 403);
        if (error.code === 'class_not_entitled') return c.json({ error: 'class_not_entitled' }, 403);
        if (error.code === 'approver_inactive') return c.json({ error: 'approver_inactive' }, 403);
        if (error.code === 'not_found') return c.json({ error: 'not_found' }, 404);
        if (error.code === 'not_a_netzer_approval') return c.json({ error: 'not_a_netzer_approval' }, 404);
        if (error.code === 'not_pending') return c.json({ error: 'not_pending' }, 409);
        if (error.code === 'payload_unavailable') return c.json({ error: 'payload_unavailable' }, 409);
        if (error.code === 'payload_mismatch') return c.json({ error: 'payload_mismatch' }, 409);
        if (error.code === 'paperclip_unavailable') return c.json({ error: 'paperclip_unavailable' }, 503);
        if (error.code === 'key_unavailable') return c.json({ error: 'key_unavailable' }, 503);
      }
      if (error instanceof ApprovalAttributionError) { logger.error({ code: 'attribution_mismatch' }, 'work_decide_failed'); return c.json({ error: 'attribution_mismatch' }, 500); }
      const status = record(error) ? error.status : undefined;
      if (typeof status === 'number' && status >= 400 && status < 500) { logger.error({ code: 'paperclip_rejected', status }, 'work_decide_failed'); return c.json({ error: 'paperclip_rejected' }, 409); }
      logger.error({ code: 'decision_outcome_unknown' }, 'work_decide_failed');
      return c.json({ error: 'decision_outcome_unknown' }, 503);
    }
  });
  return router;
}
