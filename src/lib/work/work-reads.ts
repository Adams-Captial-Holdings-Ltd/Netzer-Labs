import { logger } from '../../observability/logger.js';
import { paperclipClientFromEnvironment, type PaperclipClient } from '../paperclip/client.js';
import { loadPaperclipConfig } from '../paperclip/config.js';
import { PaperclipDisabledError, PaperclipError, PaperclipLockClosedError, PaperclipPaginationTruncatedError, PaperclipProjectPausedError, PaperclipRatelimitedError, PaperclipUnavailableError } from '../paperclip/error.js';
import { APPROVAL_TYPE } from './approvals.js';
import { validateEffectKey } from './effect-ledger.js';
import type { WorkReads, WorkCase, WorkCaseDetail, WorkApproval, PipelineSummary } from '../../adapters/dashboard/work.js';

export class WorkReadError extends Error {
  constructor(public readonly code: 'paperclip_unavailable' | 'paperclip_locked' | 'paperclip_ratelimited') { super(code); }
}
type Client = Pick<PaperclipClient, 'request'>;
type Options = { client?: () => Promise<Client>; companyId?: () => Promise<string>; log?: (code: string, count: number) => void };
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const string = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const nullableString = (v: unknown): v is string | null => v === null || typeof v === 'string';
const array = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
const short = (v: string, limit = 4_000): string => v.slice(0, limit);
const date = (v: unknown): string | undefined => v instanceof Date ? v.toISOString() : string(v) && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : undefined;
async function mapEight<T, R>(items: T[], map: (item: T) => Promise<R>): Promise<R[]> {
  const result = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(8, items.length) }, async () => {
    while (next < items.length) { const at = next++; result[at] = await map(items[at]!); }
  }));
  return result;
}
export type WorkApprovalPayload = { netzerApproval: 1; payloadSha256: string; caseKey: string; stage: string; step: string; stageEntryNo: number; decisionClass: string };
export function validNetzerApprovalPayload(v: unknown): v is WorkApprovalPayload {
  if (!isObject(v)) return false;
  const fields = ['netzerApproval', 'payloadSha256', 'caseKey', 'stage', 'step', 'stageEntryNo', 'decisionClass'];
  if (Reflect.ownKeys(v).length !== fields.length || !fields.every((field) => Object.hasOwn(v, field))) return false;
  if (v.netzerApproval !== 1 || !string(v.payloadSha256) || !/^[0-9a-f]{64}$/.test(v.payloadSha256)
    || !string(v.caseKey) || !string(v.stage) || !string(v.step)
    || typeof v.stageEntryNo !== 'number' || !Number.isSafeInteger(v.stageEntryNo) || v.stageEntryNo < 1
    || !string(v.decisionClass) || !/^[a-z][a-z0-9_]*$/.test(v.decisionClass)) return false;
  try { validateEffectKey({ caseKey: v.caseKey, stage: v.stage, step: v.step, stageEntryNo: v.stageEntryNo }); }
  catch { return false; }
  return true;
}
function mappedError(error: unknown): WorkReadError | undefined {
  if (error instanceof WorkReadError) return error;
  if (error instanceof PaperclipRatelimitedError || (error instanceof PaperclipError && error.status === 429)) return new WorkReadError('paperclip_ratelimited');
  if (error instanceof PaperclipLockClosedError || error instanceof PaperclipDisabledError) return new WorkReadError('paperclip_locked');
  if (error instanceof PaperclipUnavailableError || error instanceof PaperclipProjectPausedError || error instanceof PaperclipPaginationTruncatedError
    || (error instanceof PaperclipError && typeof error.status === 'number' && error.status >= 500)
    || error instanceof TypeError || (error instanceof Error && /abort|timeout/i.test(error.message))) return new WorkReadError('paperclip_unavailable');
  return undefined;
}
const pipeline = (v: unknown): PipelineSummary | undefined => {
  if (!isObject(v) || !string(v.id) || !string(v.name) || !Array.isArray(v.stages)) return undefined;
  const stages = v.stages.map((s) => isObject(s) && string(s.id) && string(s.key) && string(s.name) && string(s.kind)
    ? { id: s.id, key: s.key, name: s.name, kind: s.kind } : undefined);
  if (stages.some((s) => !s)) return undefined;
  return { id: v.id, name: v.name, stages: stages as PipelineSummary['stages'] };
};
function workCase(v: unknown, p: PipelineSummary, blockers: unknown = []): WorkCase | undefined {
  // Pipeline case lists are {case, stage, activeWork} (pinned upstream pipelines.ts:1432).
  if (!isObject(v) || !isObject(v.case) || !isObject(v.stage)) return undefined;
  const c = v.case; const s = v.stage;
  if (!string(c.id) || !string(c.caseKey) || !string(c.title) || !string(s.id) || !string(s.key)
    || !string(s.name) || !string(s.kind) || !date(c.updatedAt)
    || ![undefined, null, 'done', 'cancelled'].includes(c.terminalKind as string | null | undefined)
    || ![undefined, null, 'user', 'agent'].includes(c.leaseOwnerType as string | null | undefined)
    || (c.leaseUserId !== undefined && !nullableString(c.leaseUserId))) return undefined;
  const blocked = array(blockers).length > 0;
  const status = c.terminalKind === 'done' ? 'done' : c.terminalKind === 'cancelled' ? 'cancelled' : blocked ? 'blocked' : 'active';
  const active = isObject(v.activeWork) ? v.activeWork : undefined;
  const ownerKind = c.leaseOwnerType === 'user' ? 'person' : c.leaseOwnerType === 'agent' ? 'agent' : 'none';
  const ownerName = string(active?.name) ? active.name : string(active?.agentName) ? active.agentName : null;
  return { id: short(c.id), caseKey: short(c.caseKey), title: short(c.title), pipeline: { id: short(p.id), name: short(p.name) },
    stage: { id: short(s.id), key: short(s.key), name: short(s.name), kind: short(s.kind) }, status,
    owner: { kind: ownerKind, name: ownerName ? short(ownerName) : null }, updatedAt: date(c.updatedAt)!, leaseUserId: c.leaseUserId ? short(c.leaseUserId) : null };
}
function approval(v: unknown): WorkApproval | undefined {
  if (!isObject(v) || !string(v.id) || !string(v.type) || !string(v.status) || !date(v.createdAt)
    || !validNetzerApprovalPayload(v.payload) || v.type !== APPROVAL_TYPE
    || !['pending', 'revision_requested', 'approved', 'rejected', 'cancelled'].includes(v.status)
    || (v.decidedByUserId !== undefined && !nullableString(v.decidedByUserId))
    || (v.decidedAt !== undefined && !nullableString(v.decidedAt))
    || (typeof v.decidedAt === 'string' && !date(v.decidedAt))) return undefined;
  return { id: short(v.id), type: v.type, status: v.status, payload: v.payload,
    decidedByUserId: typeof v.decidedByUserId === 'string' ? short(v.decidedByUserId) : null,
    decidedAt: v.decidedAt == null ? null : date(v.decidedAt) ?? null,
    createdAt: date(v.createdAt)!, decisionNote: typeof v.decisionNote === 'string' ? short(v.decisionNote) : null };
}

export function paperclipWorkReads(options: Options = {}): WorkReads {
  const client = options.client ?? paperclipClientFromEnvironment;
  const companyId = options.companyId ?? (async () => {
    const id = (await loadPaperclipConfig()).companyId;
    if (!id) throw new WorkReadError('paperclip_unavailable');
    return id;
  });
  const log = options.log ?? ((code: string, count: number) => logger.warn({ code, count }, 'work_read_failed'));
  async function read(path: string, query?: Record<string, string | number | boolean | undefined>, missingIsExpected = false): Promise<unknown> {
    try { return await (await client()).request<unknown>('GET', path, query ? { query } : {}); }
    catch (error) {
      const mapped = mappedError(error);
      if (!(missingIsExpected && error instanceof PaperclipError && error.status === 404)) log(mapped?.code ?? 'upstream_error', 1);
      throw mapped ?? error;
    }
  }
  function checked<T>(rows: unknown, mapper: (v: unknown) => T | undefined): T[] {
    if (!Array.isArray(rows)) { log('malformed_response', 1); throw new WorkReadError('paperclip_unavailable'); }
    const mapped = rows.map(mapper);
    const bad = mapped.filter((v) => v === undefined).length;
    if (bad) log('malformed_record', bad);
    return mapped.filter((v): v is T => v !== undefined);
  }
  const companyPath = async () => {
    try { return `/api/companies/${encodeURIComponent(await companyId())}`; }
    catch (error) {
      const mapped = mappedError(error);
      log(mapped?.code ?? 'upstream_error', 1);
      throw mapped ?? error;
    }
  };
  let pipelineCache: { value: PipelineSummary[]; until: number } | undefined;
  let pipelineFlight: Promise<PipelineSummary[]> | undefined;
  async function listPipelines() {
    if (pipelineCache && Date.now() < pipelineCache.until) return pipelineCache.value;
    if (!pipelineFlight) pipelineFlight = (async () => {
      const value = checked(await read(`${await companyPath()}/pipelines`), pipeline);
      pipelineCache = { value, until: Date.now() + 15_000 }; return value;
    })().finally(() => { pipelineFlight = undefined; });
    return pipelineFlight;
  }
  async function getCase(caseId: string): Promise<WorkCaseDetail | undefined> {
    let raw: unknown;
    try { raw = await read(`/api/cases/${encodeURIComponent(caseId)}`, undefined, true); }
    catch (error) { if (error instanceof PaperclipError && error.status === 404) return undefined; throw error; }
    if (!isObject(raw) || !isObject(raw.pipeline) || !isObject(raw.case)
      || !isObject(raw.case.fields) || !Array.isArray(raw.blockers)) { log('malformed_record', 1); throw new WorkReadError('paperclip_unavailable'); }
    const p = pipeline({ ...raw.pipeline, stages: [] });
    const base = p && workCase(raw, p, raw.blockers);
    if (!base) { log('malformed_record', 1); throw new WorkReadError('paperclip_unavailable'); }
    const [events, links] = await Promise.all([
      read(`/api/cases/${encodeURIComponent(caseId)}/events`, { order: 'desc', limit: 100 }),
      read(`/api/cases/${encodeURIComponent(caseId)}/issue-links`),
    ]);
    const c = raw.case as Record<string, unknown>;
    const fields = isObject(c.fields) ? Object.keys(c.fields).sort().slice(0, 24).flatMap((name) => {
      const value = c.fields && (c.fields as Record<string, unknown>)[name];
      return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? [{ name: short(name), value: short(String(value), 500) }] : [];
    }) : [];
    const blockers: WorkCaseDetail['blockers'] = [];
    let badBlockers = 0;
    for (const b of array(raw.blockers).slice(0, 25)) {
      if (isObject(b) && string(b.id) && string(b.title)) { blockers.push({ id: short(b.id), title: short(b.title) }); continue; }
      if (isObject(b) && string(b.blockedByCaseId)) {
        let blocking: unknown;
        try { blocking = await read(`/api/cases/${encodeURIComponent(b.blockedByCaseId)}`, undefined, true); }
        catch (error) { if (!(error instanceof PaperclipError && error.status === 404)) throw error; }
        if (isObject(blocking) && isObject(blocking.case) && string(blocking.case.title)) {
          blockers.push({ id: short(b.blockedByCaseId), title: short(blocking.case.title) }); continue;
        }
      }
      badBlockers += 1;
    }
    if (badBlockers) log('malformed_record', badBlockers);
    const items = isObject(events) ? events.items : events;
    const timeline = checked(items, (v) => {
      if (!isObject(v) || !date(v.createdAt) || !string(v.type)) return undefined;
      return { at: date(v.createdAt)!, kind: 'event' as const,
        actor: isObject(v.actorAgent) && string(v.actorAgent.name) ? short(v.actorAgent.name) : null,
        text: short(string(v.summary) ? v.summary : v.type.replace(/_/g, ' ')) } as WorkCaseDetail['timeline'][number];
    });
    for (const link of checked(links, (v) => isObject(v) && isObject(v.issue) && string(v.issue.id) ? v.issue.id : undefined).slice(0, 10)) {
      let comments: unknown;
      try { comments = await read(`/api/issues/${encodeURIComponent(link)}/comments`, { limit: 100 }, true); }
      catch (error) { if (error instanceof PaperclipError && error.status === 404) { log('malformed_record', 1); continue; } throw error; }
      timeline.push(...checked(comments, (v) => isObject(v) && date(v.createdAt) && string(v.body)
        ? { at: date(v.createdAt)!, kind: 'comment' as const, actor: null, text: short(v.body) } as WorkCaseDetail['timeline'][number] : undefined));
    }
    return { ...base, summary: typeof c.summary === 'string' ? short(c.summary) : null, fields, blockers,
      timeline: timeline.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 100) };
  }
  type CaseIndex = { cases: WorkCase[]; pipelines: PipelineSummary[]; truncated: boolean };
  let indexCache: { value: CaseIndex; until: number } | undefined;
  let indexFlight: Promise<CaseIndex> | undefined;
  async function caseIndex() {
    if (indexCache && Date.now() < indexCache.until) return indexCache.value;
    if (!indexFlight) indexFlight = (async () => {
      const pipelines = await listPipelines();
      const candidates: { row: unknown; pipeline: PipelineSummary; base: WorkCase }[] = [];
      for (const p of pipelines) {
        const rows = checked(await read(`/api/pipelines/${encodeURIComponent(p.id)}/cases`), (v) => workCase(v, p) ? v : undefined);
        for (const row of rows) {
          if (candidates.length >= 201) break;
          candidates.push({ row, pipeline: p, base: workCase(row, p)! });
        }
        if (candidates.length >= 201) break;
      }
      // ponytail: one detail read per case at most every 15 s, eight at a time; upgrade to an upstream bulk blockers endpoint.
      const mapped = await mapEight(candidates, async ({ row, pipeline: p, base }) => {
        let detail: unknown;
        try { detail = isObject(row) && Array.isArray(row.blockers) ? row : await read(`/api/cases/${encodeURIComponent(base.id)}`, undefined, true); }
        catch (error) { if (!(error instanceof PaperclipError && error.status === 404)) throw error; }
        if (!isObject(detail) || !Array.isArray(detail.blockers)) { log('malformed_record', 1); return undefined; }
        return workCase(row, p, detail.blockers);
      });
      const cases = mapped.filter((item): item is WorkCase => item !== undefined);
      const value = { cases, pipelines, truncated: candidates.length > 200 };
      indexCache = { value, until: Date.now() + 15_000 }; return value;
    })().finally(() => { indexFlight = undefined; });
    return indexFlight;
  }
  async function listCases(q: Parameters<WorkReads['listCases']>[0]) {
    const index = await caseIndex();
    const cases = index.cases.filter((item) => (!q.pipeline || item.pipeline.id === q.pipeline)
      && (!q.stage || item.stage.id === q.stage || item.stage.key === q.stage)
      && (q.status === 'all' || q.status === 'active' && item.status !== 'done' && item.status !== 'cancelled'
        || q.status === 'blocked' && item.status === 'blocked'
        || q.status === 'done' && (item.status === 'done' || item.status === 'cancelled')));
    return { cases: cases.slice(0, 200), truncated: index.truncated || cases.length > 200 };
  }
  async function listApprovals(status: 'pending' | 'all') {
    const raw = await read(`${await companyPath()}/approvals`, status === 'pending' ? { status: 'pending' } : undefined);
    // Foreign approvals are intentionally excluded, and counted with malformed rows.
    const approvals = checked(raw, (row) => approval(row));
    return { approvals: approvals.slice(0, 200), truncated: approvals.length > 200 };
  }
  async function getApproval(id: string) {
    let raw: unknown;
    try { raw = await read(`/api/approvals/${encodeURIComponent(id)}`, undefined, true); }
    catch (error) { if (error instanceof PaperclipError && error.status === 404) return undefined; throw error; }
    const mapped = approval(raw);
    if (!mapped && isObject(raw) && string(raw.id) && string(raw.type) && raw.type !== APPROVAL_TYPE
      && string(raw.status) && date(raw.createdAt) && isObject(raw.payload)) return undefined;
    if (!mapped) { log('malformed_record', 1); throw new WorkReadError('paperclip_unavailable'); }
    return mapped;
  }
  return { listPipelines, listCases, getCase, listApprovals, getApproval };
}
