export interface EffectKey { caseKey: string; stage: string; step: string; stageEntryNo: number }
export type EffectState = 'pending' | 'applied' | 'retryable' | 'unknown';
export interface EffectRow {
  kind: 'effect'; key: EffectKey; state: EffectState; payloadHash: string; result?: unknown;
  issueId?: string; runId?: string; attemptNo?: number; turnId?: string; agentId?: string;
  resolvedBy?: string; version: number; createdAt: number; updatedAt: number;
}
export interface DraftRow { kind: 'draft'; key: EffectKey; text: string; createdAt: number }
export interface EffectRows {
  get(key: EffectKey): Promise<EffectRow | undefined>;
  create(row: EffectRow): Promise<boolean>;
  replace(key: EffectKey, expectedVersion: number, next: EffectRow): Promise<boolean>;
  listUnknown(): Promise<EffectRow[]>;
  getDraft(key: EffectKey): Promise<DraftRow | undefined>;
  createDraft(row: DraftRow): Promise<boolean>;
}
export class InvalidEffectKeyError extends Error {
  constructor() { super('Invalid effect key'); this.name = 'InvalidEffectKeyError'; }
}
export function validateEffectKey(key: EffectKey): void {
  const name = /^[a-z0-9][a-z0-9_-]{0,127}$/;
  if (!key || typeof key.caseKey !== 'string' || key.caseKey.length < 1 || key.caseKey.length > 256
    || /[\x00-\x1f\x7f]/.test(key.caseKey) || !name.test(key.stage) || !name.test(key.step)
    || !Number.isSafeInteger(key.stageEntryNo) || key.stageEntryNo < 1) throw new InvalidEffectKeyError();
}
export const effectPartitionKey = (key: EffectKey) => `CASE#${key.caseKey}`;
export const effectSortKey = (key: EffectKey) => `EFFECT#${key.stage}#${key.step}#${key.stageEntryNo}`;
export const draftSortKey = (key: EffectKey) => `DRAFT#${key.stage}#${key.step}#${key.stageEntryNo}`;
