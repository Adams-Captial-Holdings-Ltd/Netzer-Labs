import { createHash } from 'node:crypto';
import type { AuditEvent } from '../audit/audit-writer.js';
import { validShadowUser, type ShadowRows } from '../paperclip/shadow-users.js';
import { payloadHash } from './executor.js';
import type { createExecutor } from './executor.js';
import { validateEffectKey, type EffectKey } from './effect-ledger.js';

export const APPROVAL_TYPE = 'request_board_approval';

type ApprovalPayload = {
  netzerApproval: 1; payloadSha256: string; caseKey: string; stage: string;
  step: string; stageEntryNo: number; decisionClass: string;
};
export interface ApprovalRecord {
  id: string; type: string; status: string; payload: unknown;
  decidedByUserId?: string | null | undefined;
  decidedAt?: string | null | undefined;
}
export interface ApprovalsPort {
  create(body: { type: string; payload: Record<string, unknown> }): Promise<ApprovalRecord>;
  get(approvalId: string): Promise<ApprovalRecord | undefined>;
  decide(approvalId: string, verb: 'approve' | 'reject' | 'request-revision',
    decisionNote: string | null, boardKey: string): Promise<ApprovalRecord>;
}
export type ApprovalRefusedCode = 'comment_required' | 'comment_too_long' | 'not_an_approver' | 'paperclip_unavailable'
  | 'not_found' | 'not_a_netzer_approval' | 'not_pending' | 'class_not_entitled' | 'key_unavailable';
export type ApprovalInvalidCode = 'paperclip_unavailable' | 'not_found' | 'not_a_netzer_approval' | 'not_approved'
  | 'hash_mismatch' | 'key_mismatch' | 'class_mismatch' | 'not_a_shadow_user' | 'approver_retired' | 'class_not_entitled';
export class ApprovalRefusedError extends Error {
  constructor(public readonly code: ApprovalRefusedCode) { super('Approval refused'); this.name = 'ApprovalRefusedError'; }
}
export class ApprovalInvalidError extends Error {
  constructor(public readonly code: ApprovalInvalidCode) { super('Approval invalid'); this.name = 'ApprovalInvalidError'; }
}
export class ApprovalAttributionError extends Error {
  constructor() { super('Approval attribution does not match'); this.name = 'ApprovalAttributionError'; }
}

export function approvalPayload(key: EffectKey, payload: unknown, decisionClass: string): ApprovalPayload {
  return { netzerApproval: 1, payloadSha256: payloadHash(payload), caseKey: key.caseKey,
    stage: key.stage, step: key.step, stageEntryNo: key.stageEntryNo, decisionClass };
}

const FIELDS = ['netzerApproval', 'payloadSha256', 'caseKey', 'stage', 'step', 'stageEntryNo', 'decisionClass'];
const CLASS_ID = /^[a-z][a-z0-9_]*$/;
function isApprovalPayload(value: unknown): value is ApprovalPayload {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (Reflect.ownKeys(row).length !== FIELDS.length || !FIELDS.every((field) => Object.hasOwn(row, field))) return false;
  if (row.netzerApproval !== 1 || typeof row.payloadSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(row.payloadSha256)
    || typeof row.caseKey !== 'string' || typeof row.stage !== 'string' || typeof row.step !== 'string'
    || typeof row.stageEntryNo !== 'number' || !Number.isSafeInteger(row.stageEntryNo) || row.stageEntryNo < 1
    || typeof row.decisionClass !== 'string' || !CLASS_ID.test(row.decisionClass)) return false;
  try { validateEffectKey({ caseKey: row.caseKey, stage: row.stage, step: row.step, stageEntryNo: row.stageEntryNo }); }
  catch { return false; }
  return true;
}
function payloadOf(record: ApprovalRecord | undefined): ApprovalPayload | undefined {
  return record?.type === APPROVAL_TYPE && isApprovalPayload(record.payload) ? record.payload : undefined;
}

type Decision = 'approve' | 'reject' | 'request_changes';
type EffectRequest<T> = {
  key: EffectKey; payload: unknown; fence: () => Promise<void>; apply: () => Promise<T>;
  readBack?: () => Promise<{ applied: true; result: T } | { applied: false } | 'unknown'>;
  correlation?: { issueId?: string; runId?: string; attemptNo?: number; turnId?: string; agentId?: string };
};
type Options = {
  port: ApprovalsPort; shadows: Pick<ShadowRows, 'getByNetzerUser' | 'getByPaperclipUser'>;
  keys: { boardKeyFor(slot: string): Promise<string> };
  audit: (event: AuditEvent) => Promise<void>; now: () => number;
};
type VerifyRequest = { approvalId: string; key: EffectKey; payload: unknown; decisionClass: string };

async function readVerifiedApproval(port: ApprovalsPort, shadows: Options['shadows'], req: VerifyRequest) {
  let record: ApprovalRecord | undefined;
  try { record = await port.get(req.approvalId); }
  catch {
    throw new ApprovalInvalidError('paperclip_unavailable');
  }
  if (!record || record.id !== req.approvalId) throw new ApprovalInvalidError('not_found');
  const body = payloadOf(record);
  if (!body) throw new ApprovalInvalidError('not_a_netzer_approval');
  if (record.status !== 'approved') throw new ApprovalInvalidError('not_approved');
  if (payloadHash(req.payload) !== body.payloadSha256) throw new ApprovalInvalidError('hash_mismatch');
  if (req.key.caseKey !== body.caseKey || req.key.stage !== body.stage || req.key.step !== body.step
    || req.key.stageEntryNo !== body.stageEntryNo) throw new ApprovalInvalidError('key_mismatch');
  if (req.decisionClass !== body.decisionClass) throw new ApprovalInvalidError('class_mismatch');
  if (typeof record.decidedByUserId !== 'string' || !record.decidedByUserId.trim()) throw new ApprovalInvalidError('not_a_shadow_user');
  const shadow = await shadows.getByPaperclipUser(record.decidedByUserId);
  if (!shadow || !validShadowUser(shadow) || shadow.paperclipUserId !== record.decidedByUserId)
    throw new ApprovalInvalidError('not_a_shadow_user');
  const decidedAt = Date.parse(record.decidedAt ?? '');
  if (shadow.status === 'retired' && (!Number.isFinite(decidedAt)
    || typeof shadow.retiredAt !== 'number' || !Number.isFinite(shadow.retiredAt)
    || decidedAt > shadow.retiredAt)) throw new ApprovalInvalidError('approver_retired');
  if (!shadow.decisionClasses.includes(body.decisionClass)) throw new ApprovalInvalidError('class_not_entitled');
  return { approvalId: req.approvalId, netzerUserId: shadow.netzerUserId,
    shadowUserId: shadow.paperclipUserId, decidedAt: record.decidedAt };
}

async function executeApprovedEffect<T>(verify: (req: VerifyRequest) => Promise<unknown>,
  executor: Pick<ReturnType<typeof createExecutor>, 'runEffect'>,
  req: EffectRequest<T> & { approvalId: string; decisionClass: string }): Promise<T> {
  const { approvalId, decisionClass, ...effect } = req;
  await verify({ approvalId, decisionClass, key: effect.key, payload: effect.payload });
  return executor.runEffect(effect);
}

export function createApprovals({ port, shadows, keys, audit }: Options) {
  async function refuse(code: ApprovalRefusedCode, netzerUserId: string, approvalId: string): Promise<ApprovalRefusedError> {
    try { await audit({ action: 'approval_refused', userId: netzerUserId, result: 'blocked', detail: { approvalId, code } }); }
    catch { /* A refusal must survive an audit outage. */ }
    return new ApprovalRefusedError(code);
  }

  async function requestApproval(req: { key: EffectKey; payload: unknown; decisionClass: string }) {
    validateEffectKey(req.key);
    if (!CLASS_ID.test(req.decisionClass)) throw new Error('Invalid decision class');
    const body = approvalPayload(req.key, req.payload, req.decisionClass);
    const record = await port.create({ type: APPROVAL_TYPE, payload: body });
    if (typeof record?.id !== 'string' || !record.id.trim()) throw new Error('Invalid approval id');
    await audit({ action: 'approval_requested', result: 'ok', detail: {
      approvalId: record.id, payloadSha256: body.payloadSha256, caseKey: body.caseKey,
      stage: body.stage, step: body.step, stageEntryNo: body.stageEntryNo, decisionClass: body.decisionClass,
    } });
    return { approvalId: record.id, payloadSha256: body.payloadSha256 };
  }

  async function decide(req: { netzerUserId: string; approvalId: string; decision: Decision; comment?: string | undefined }) {
    const comment = req.comment?.trim() ?? '';
    if (req.decision !== 'approve' && !comment) throw await refuse('comment_required', req.netzerUserId, req.approvalId);
    if (comment.length > 4_000) throw await refuse('comment_too_long', req.netzerUserId, req.approvalId);
    const shadow = await shadows.getByNetzerUser(req.netzerUserId);
    if (!shadow || !validShadowUser(shadow) || shadow.status !== 'active')
      throw await refuse('not_an_approver', req.netzerUserId, req.approvalId);
    let record: ApprovalRecord | undefined;
    try { record = await port.get(req.approvalId); }
    catch { throw await refuse('paperclip_unavailable', req.netzerUserId, req.approvalId); }
    if (!record || record.id !== req.approvalId) throw await refuse('not_found', req.netzerUserId, req.approvalId);
    const body = payloadOf(record);
    if (!body) throw await refuse('not_a_netzer_approval', req.netzerUserId, req.approvalId);
    if (record.status !== 'pending') throw await refuse('not_pending', req.netzerUserId, req.approvalId);
    if (!shadow.decisionClasses.includes(body.decisionClass)) throw await refuse('class_not_entitled', req.netzerUserId, req.approvalId);
    const verb = req.decision === 'request_changes' ? 'request-revision' : req.decision;
    let boardKey: string;
    try { boardKey = await keys.boardKeyFor(shadow.slot); }
    catch { throw await refuse('key_unavailable', req.netzerUserId, req.approvalId); }
    let decided: ApprovalRecord;
    try { decided = await port.decide(req.approvalId, verb, comment || null, boardKey); }
    catch (error) {
      try { await audit({ action: 'approval_refused', userId: req.netzerUserId, result: 'blocked',
        detail: { approvalId: req.approvalId, code: 'paperclip_rejected' } }); } catch { /* Keep Paperclip error. */ }
      throw error;
    }
    const detail = {
      approvalId: req.approvalId, shadowUserId: shadow.paperclipUserId, slot: shadow.slot,
      decisionClass: body.decisionClass, decision: req.decision, payloadSha256: body.payloadSha256,
      caseKey: body.caseKey, stage: body.stage, step: body.step, stageEntryNo: body.stageEntryNo,
    };
    if (decided.decidedByUserId !== shadow.paperclipUserId) {
      try { await audit({ action: 'approval_refused', userId: req.netzerUserId, result: 'error',
        detail: { ...detail, code: 'attribution_mismatch' } }); } catch { /* Keep attribution failure. */ }
      throw new ApprovalAttributionError();
    }
    await audit({ action: 'approval_decided', userId: req.netzerUserId, result: 'ok', detail: {
      ...detail,
      ...(comment ? { commentSha256: createHash('sha256').update(`${req.approvalId}\n${comment}`).digest('hex') } : {}),
    } });
    return { approvalId: req.approvalId, decision: req.decision, shadowUserId: shadow.paperclipUserId };
  }

  const verifyApproval = (req: VerifyRequest) => readVerifiedApproval(port, shadows, req);
  return { requestApproval, decide, verifyApproval,
    runApprovedEffect: <T>(executor: Pick<ReturnType<typeof createExecutor>, 'runEffect'>,
      req: EffectRequest<T> & { approvalId: string; decisionClass: string }) =>
      executeApprovedEffect(verifyApproval, executor, req) };
}

export function requiresHumanApproval(
  decisionClasses: readonly { id: string; default: string }[], classId: string, automatedClasses: readonly string[] = [],
): boolean {
  const declared = decisionClasses.find((item) => item.id === classId);
  return !declared || (declared.default !== 'automated_allowed' && !automatedClasses.includes(classId));
}

export function gateFor(
  policies: { approvalGates: readonly { pipeline: string; stage: string; decisionClass: string }[] },
  pipeline: string, stage: string,
): string | undefined {
  return policies.approvalGates.find((gate) => gate.pipeline === pipeline && gate.stage === stage)?.decisionClass;
}
