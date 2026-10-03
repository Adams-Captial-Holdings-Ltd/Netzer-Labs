import { createHash } from 'node:crypto';
import { logger } from '../../observability/logger.js';
import { writeAuditOrThrow, type AuditEvent } from '../audit/audit-writer.js';
import { isDispatchDraining } from '../paperclip/dispatch-drain.js';
import { dynamoEffectRows } from './effect-rows-dynamo.js';
import { InvalidEffectKeyError, validateEffectKey, type EffectKey, type EffectRow, type EffectRows } from './effect-ledger.js';

export { InvalidEffectKeyError };

export class InvalidEffectPayloadError extends Error {
  constructor() { super('Invalid effect payload'); this.name = 'InvalidEffectPayloadError'; }
}
function canonical(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number' && !Number.isFinite(value)) throw new InvalidEffectPayloadError();
  if (typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol') throw new InvalidEffectPayloadError();
  if (typeof value !== 'object') return value;
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new InvalidEffectPayloadError();
    return value.toISOString();
  }
  if (seen.has(value)) throw new InvalidEffectPayloadError();
  const proto: unknown = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) throw new InvalidEffectPayloadError();
  seen.add(value);
  const output = Array.isArray(value) ? value.map((part) => canonical(part, seen))
    : Object.fromEntries(Object.entries(value)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([k, part]) => [k, canonical(part, seen)]));
  seen.delete(value);
  return output;
}
export function payloadHash(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(payload))).digest('hex');
}
export class EffectUnknownError extends Error {
  constructor() { super('Effect outcome needs verification'); this.name = 'EffectUnknownError'; }
}
export class EffectConflictError extends Error {
  constructor() { super('Effect key has a different input'); this.name = 'EffectConflictError'; }
}
export class EffectRetryableError extends Error {
  constructor() { super('Effect can be retried'); this.name = 'EffectRetryableError'; }
}
export class EffectResolveError extends Error {
  constructor(public readonly code: 'resolver_required' | 'not_unknown' | 'changed') {
    super('Effect resolve failed'); this.name = 'EffectResolveError';
  }
}
export const PENDING_SETTLE_MS = 270_000;
const KNOWN_EFFECT_STATES = new Set<EffectRow['state']>(['pending', 'applied', 'retryable', 'unknown']);
const DRAFT_MAX_BYTES = 300_000;

interface Correlation { issueId?: string; runId?: string; attemptNo?: number; turnId?: string; agentId?: string }
interface Request<T> {
  key: EffectKey; payload: unknown; fence: () => Promise<void>; apply: () => Promise<T>;
  readBack?: () => Promise<{ applied: true; result: T } | { applied: false } | 'unknown'>;
  correlation?: Correlation;
}
interface Options {
  rows: EffectRows; isDraining: () => boolean; audit: (event: AuditEvent) => Promise<void>; now: () => number;
  settleMs?: number;
}

export function createExecutor({ rows, isDraining, audit, now, settleMs = 0 }: Options) {
  const ids = (row: EffectRow) => ({ ...row.key, payloadHash: row.payloadHash,
    issueId: row.issueId, runId: row.runId, attemptNo: row.attemptNo, turnId: row.turnId });
  const currentCorrelation = (correlation?: Correlation) => ({
    issueId: correlation?.issueId, runId: correlation?.runId, attemptNo: correlation?.attemptNo,
    turnId: correlation?.turnId, agentId: correlation?.agentId,
  });

  async function change(req: Request<unknown>, current: EffectRow, state: EffectRow['state'],
    extra: Partial<EffectRow> = {}): Promise<EffectRow | undefined> {
    await req.fence();
    const next: EffectRow = { ...current, ...extra, state, version: current.version + 1, updatedAt: now() };
    return await rows.replace(req.key, current.version, next) ? next : undefined;
  }

  async function auditApplied(req: Request<unknown>, row: EffectRow): Promise<void> {
    await audit({ action: 'effect_applied', agentId: row.agentId,
      detail: { ...ids(row), resultHash: payloadHash(row.result) } });
    try { await change(req, row, 'applied', { auditPending: false }); } catch { /* replay can repair */ }
  }

  function unknownStop(key: EffectKey, hash: string): never {
    logger.warn({ ...key, payloadHash: hash, state: 'unknown' }, 'Effect outcome unknown');
    throw new EffectUnknownError();
  }

  async function markUnknown(req: Request<unknown>, row: EffectRow, hash: string): Promise<never> {
    const next = await change(req, row, 'unknown');
    if (next) {
      try { await audit({ action: 'effect_unknown', agentId: next.agentId, detail: ids(next) }); }
      catch { /* best effort */ }
    }
    return unknownStop(req.key, hash);
  }

  async function handleStoredRow<T>(req: Request<T>, row: EffectRow, hash: string): Promise<{ handled: true; value: T } | { handled: false }> {
    if (!KNOWN_EFFECT_STATES.has(row.state)) return unknownStop(req.key, hash);
    if (row.state === 'applied') {
      if (row.auditPending) await auditApplied(req, row);
      return { handled: true, value: row.result as T };
    }
    if (row.state === 'unknown') return unknownStop(req.key, hash);
    return { handled: false };
  }

  async function runEffect<T>(req: Request<T>): Promise<T> {
    validateEffectKey(req.key);
    const hash = payloadHash(req.payload);
    let row = await rows.get(req.key);
    if (row && row.payloadHash !== hash) throw new EffectConflictError();
    if (row) {
      const stored = await handleStoredRow(req, row, hash);
      if (stored.handled) return stored.value;
    }
    if (isDraining()) throw new EffectRetryableError();
    let created = false;
    if (!row) {
      const time = now();
      const pending: EffectRow = { kind: 'effect', key: req.key, state: 'pending', payloadHash: hash,
        ...currentCorrelation(req.correlation), version: 1, createdAt: time, updatedAt: time };
      await req.fence();
      if (!await rows.create(pending)) {
        row = await rows.get(req.key);
        if (!row) throw new Error('Effect row changed during create');
        if (row.payloadHash !== hash) throw new EffectConflictError();
        const stored = await handleStoredRow(req, row, hash);
        if (stored.handled) return stored.value;
      } else { row = pending; created = true; }
    }
    // Only this call's successful conditional create, or a claimed retry, can apply.
    return applyFromRow(req, row, created, hash);
  }

  async function applyFromRow<T>(req: Request<T>, current: EffectRow, created: boolean, hash: string): Promise<T> {
    let owned = current;
    if (current.state === 'pending' && !created) {
      if (now() - current.updatedAt < settleMs) throw new EffectRetryableError();
      let observed: Awaited<ReturnType<NonNullable<Request<T>['readBack']>>> = 'unknown';
      try { if (req.readBack) observed = await req.readBack(); } catch { /* ambiguous */ }
      if (observed === 'unknown') return markUnknown(req, current, hash);
      if (observed.applied) {
        const applied = await change(req, current, 'applied', { result: observed.result, auditPending: true,
          ...currentCorrelation(req.correlation) });
        if (!applied) return unknownStop(req.key, hash);
        await auditApplied(req, applied);
        return observed.result;
      }
    }
    if (current.state !== 'pending' || !created) {
      const claimed = await change(req, current, 'pending', currentCorrelation(req.correlation));
      if (!claimed) throw new EffectRetryableError();
      owned = claimed;
    }
    await req.fence();
    let value: T;
    try { value = await req.apply(); } catch (error) {
      if ((error as { notSent?: boolean } | null)?.notSent === true) {
        if (!await change(req, owned, 'retryable')) return unknownStop(req.key, hash);
        throw new EffectRetryableError();
      }
      return markUnknown(req, owned, hash);
    }
    let applied: EffectRow | undefined;
    try { applied = await change(req, owned, 'applied', { result: value, auditPending: true }); }
    catch (error) {
      logger.error({ ...req.key, payloadHash: hash }, 'Effect applied but ledger record failed');
      throw error;
    }
    if (!applied) {
      logger.error({ ...req.key, payloadHash: hash }, 'Effect applied but ledger record lost');
      return unknownStop(req.key, hash);
    }
    await auditApplied(req, applied);
    return value;
  }

  async function resolve(key: EffectKey, outcome: 'applied' | 'not_applied', by: string, result?: unknown): Promise<void> {
    validateEffectKey(key);
    if (!by.trim()) throw new EffectResolveError('resolver_required');
    const row = await rows.get(key);
    if (row?.state !== 'unknown') throw new EffectResolveError('not_unknown');
    const next: EffectRow = { ...row, state: outcome === 'applied' ? 'applied' : 'retryable',
      ...(outcome === 'applied' ? { result } : {}), resolvedBy: by, version: row.version + 1, updatedAt: now() };
    await audit({ action: 'effect_resolved', userId: by, agentId: next.agentId,
      detail: { ...ids(next), outcome } });
    if (!await rows.replace(key, row.version, next)) throw new EffectResolveError('changed');
  }

  async function saveDraftOnce(req: { key: EffectKey; fence: () => Promise<void>; produce: () => Promise<string> }): Promise<string> {
    validateEffectKey(req.key);
    const found = await rows.getDraft(req.key);
    if (found) return found.text;
    const text = await req.produce();
    if (Buffer.byteLength(text, 'utf8') > DRAFT_MAX_BYTES) throw new Error('Draft too long');
    await req.fence();
    if (await rows.createDraft({ kind: 'draft', key: req.key, text, createdAt: now() })) return text;
    const winner = await rows.getDraft(req.key);
    if (!winner) throw new Error('Draft disappeared');
    return winner.text;
  }
  return { runEffect, resolve, saveDraftOnce, listUnknown: () => rows.listUnknown() };
}

export function defaultExecutor() {
  return createExecutor({ rows: dynamoEffectRows(), isDraining: isDispatchDraining, audit: writeAuditOrThrow,
    now: Date.now, settleMs: PENDING_SETTLE_MS });
}
