import { createHash } from 'node:crypto';
import { logger } from '../../observability/logger.js';
import { writeAuditOrThrow, type AuditEvent } from '../audit/audit-writer.js';
import { isDispatchDraining } from '../paperclip/dispatch-drain.js';
import { dynamoEffectRows } from './effect-rows-dynamo.js';
import { InvalidEffectKeyError, validateEffectKey, type EffectKey, type EffectRow, type EffectRows } from './effect-ledger.js';

export { InvalidEffectKeyError };

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]));
  return value;
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

interface Correlation { issueId?: string; runId?: string; attemptNo?: number; turnId?: string; agentId?: string }
interface Request<T> {
  key: EffectKey; payload: unknown; fence: () => Promise<void>; apply: () => Promise<T>;
  readBack?: () => Promise<{ applied: true; result: T } | { applied: false } | 'unknown'>;
  correlation?: Correlation;
}
interface Options {
  rows: EffectRows; isDraining: () => boolean; audit: (event: AuditEvent) => Promise<void>; now: () => number;
}

export function createExecutor({ rows, isDraining, audit, now }: Options) {
  const ids = (row: EffectRow) => ({ ...row.key, payloadHash: row.payloadHash,
    issueId: row.issueId, runId: row.runId, attemptNo: row.attemptNo, turnId: row.turnId });

  async function runEffect<T>(req: Request<T>): Promise<T> {
    validateEffectKey(req.key);
    const hash = payloadHash(req.payload);
    let row = await rows.get(req.key);
    if (row && row.payloadHash !== hash) throw new EffectConflictError();
    if (row?.state === 'applied') return row.result as T;
    const unknownStop = (): never => {
      logger.warn({ ...req.key, payloadHash: hash, state: 'unknown' }, 'Effect outcome unknown');
      throw new EffectUnknownError();
    };
    const change = async (current: EffectRow, state: EffectRow['state'], extra: Partial<EffectRow> = {}) => {
      await req.fence();
      const next: EffectRow = { ...current, ...extra, state, version: current.version + 1, updatedAt: now() };
      if (!await rows.replace(req.key, current.version, next)) return undefined;
      return next;
    };
    const markUnknown = async (current: EffectRow): Promise<never> => {
      const next = await change(current, 'unknown');
      if (next) {
        try { await audit({ action: 'effect_unknown', agentId: next.agentId, detail: ids(next) }); } catch { /* best effort */ }
      }
      return unknownStop();
    };
    if (row?.state === 'unknown') return unknownStop();
    if (isDraining()) throw new EffectRetryableError();
    let created = false;
    if (!row) {
      const time = now();
      const pending: EffectRow = { kind: 'effect', key: req.key, state: 'pending', payloadHash: hash,
        ...req.correlation, version: 1, createdAt: time, updatedAt: time };
      await req.fence();
      if (!await rows.create(pending)) {
        row = await rows.get(req.key);
        if (!row) throw new Error('Effect row changed during create');
        if (row.payloadHash !== hash) throw new EffectConflictError();
        if (row.state === 'applied') return row.result as T;
        if (row.state === 'unknown') return unknownStop();
      } else { row = pending; created = true; }
    }
    // Only this call's successful conditional create, or a claimed retry, can apply.
    return applyFromRow(row);

    async function applyFromRow(current: EffectRow): Promise<T> {
      let owned = current;
      if (current.state === 'pending' && !created) {
        let observed: Awaited<ReturnType<NonNullable<Request<T>['readBack']>>> = 'unknown';
        try { if (req.readBack) observed = await req.readBack(); } catch { /* ambiguous */ }
        if (observed === 'unknown') return markUnknown(current);
        if (observed.applied) {
          const applied = await change(current, 'applied', { result: observed.result });
          if (!applied) return unknownStop();
          await audit({ action: 'effect_applied', agentId: applied.agentId,
            detail: { ...ids(applied), resultHash: payloadHash(observed.result) } });
          return observed.result;
        }
      }
      if (current.state !== 'pending' || !created) {
        const claimed = await change(current, 'pending');
        if (!claimed) return unknownStop();
        owned = claimed;
      }
      await req.fence();
      let value: T;
      try { value = await req.apply(); } catch (error) {
        if ((error as { notSent?: boolean } | null)?.notSent === true) {
          if (!await change(owned, 'retryable')) return unknownStop();
          throw new EffectRetryableError();
        }
        return markUnknown(owned);
      }
      const applied = await change(owned, 'applied', { result: value });
      if (!applied) return unknownStop();
      await audit({ action: 'effect_applied', agentId: applied.agentId,
        detail: { ...ids(applied), resultHash: payloadHash(value) } });
      return value;
    }
  }

  async function resolve(key: EffectKey, outcome: 'applied' | 'not_applied', by: string, result?: unknown): Promise<void> {
    validateEffectKey(key);
    if (!by.trim()) throw new Error('Resolver required');
    const row = await rows.get(key);
    if (row?.state !== 'unknown') throw new Error('Effect is not unknown');
    const next: EffectRow = { ...row, state: outcome === 'applied' ? 'applied' : 'retryable',
      ...(outcome === 'applied' ? { result } : {}), resolvedBy: by, version: row.version + 1, updatedAt: now() };
    if (!await rows.replace(key, row.version, next)) throw new Error('Effect changed during resolve');
    await audit({ action: 'effect_resolved', userId: by, agentId: next.agentId,
      detail: { ...ids(next), outcome } });
  }

  async function saveDraftOnce(req: { key: EffectKey; fence: () => Promise<void>; produce: () => Promise<string> }): Promise<string> {
    validateEffectKey(req.key);
    const found = await rows.getDraft(req.key);
    if (found) return found.text;
    const text = await req.produce();
    if (text.length > 300_000) throw new Error('Draft too long');
    await req.fence();
    if (await rows.createDraft({ kind: 'draft', key: req.key, text, createdAt: now() })) return text;
    const winner = await rows.getDraft(req.key);
    if (!winner) throw new Error('Draft disappeared');
    return winner.text;
  }
  return { runEffect, resolve, saveDraftOnce, listUnknown: () => rows.listUnknown() };
}

export function defaultExecutor() {
  return createExecutor({ rows: dynamoEffectRows(), isDraining: isDispatchDraining, audit: writeAuditOrThrow, now: Date.now });
}
