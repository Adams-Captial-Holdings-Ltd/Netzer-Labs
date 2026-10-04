import { createHash } from 'node:crypto';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../state/ddb.js';
import { canonicalJson, EffectConflictError } from './executor.js';
import { EffectRowCorruptError } from './effect-rows-dynamo.js';
import { effectPartitionKey, validateEffectKey, type EffectKey } from './effect-ledger.js';

const TABLE = process.env.TABLE_EFFECT_LEDGER ?? 'claudeclaw-effect-ledger';
export const payloadSortKey = (key: EffectKey): string => `PAYLOAD#${key.stage}#${key.step}#${key.stageEntryNo}`;
export const payloadJson = (payload: unknown): string => canonicalJson(payload);

export interface PayloadRow {
  kind: 'payload'; key: EffectKey; json: string; payloadSha256: string; createdAt: number; version: 1;
}
export interface PayloadRows {
  get(key: EffectKey): Promise<PayloadRow | undefined>;
  create(row: PayloadRow): Promise<boolean>;
}

const sha256 = (json: string) => createHash('sha256').update(json).digest('hex');

export async function savePayloadOnce(rows: PayloadRows, key: EffectKey, payload: unknown, now: number): Promise<PayloadRow> {
  validateEffectKey(key);
  const json = payloadJson(payload);
  if (Buffer.byteLength(json, 'utf8') > 300_000) throw new Error('Approval payload too long');
  const row: PayloadRow = { kind: 'payload', key, json, payloadSha256: sha256(json), createdAt: now, version: 1 };
  if (await rows.create(row)) return row;
  const stored = await rows.get(key);
  if (!stored) throw new Error('Approval payload row disappeared');
  if (stored.payloadSha256 !== row.payloadSha256) throw new EffectConflictError();
  return stored;
}

export async function readApprovalPayload(rows: PayloadRows, body: {
  caseKey: string; stage: string; step: string; stageEntryNo: number; payloadSha256: string;
}): Promise<{ state: 'verified'; value: unknown; payloadSha256: string } | { state: 'unavailable' } | { state: 'mismatch' }> {
  const row = await rows.get({ caseKey: body.caseKey, stage: body.stage, step: body.step, stageEntryNo: body.stageEntryNo });
  if (!row) return { state: 'unavailable' };
  if (sha256(row.json) !== row.payloadSha256 || row.payloadSha256 !== body.payloadSha256) return { state: 'mismatch' };
  try { return { state: 'verified', value: JSON.parse(row.json) as unknown, payloadSha256: row.payloadSha256 }; }
  catch { return { state: 'mismatch' }; }
}

export function dynamoPayloadRows(): PayloadRows {
  return {
    async get(key) {
      const result = await ddb().send(new GetCommand({ TableName: TABLE,
        Key: { PK: effectPartitionKey(key), SK: payloadSortKey(key) }, ConsistentRead: true }));
      if (!result.Item) return undefined;
      const { PK: _pk, SK: _sk, ...row } = result.Item;
      if (row.kind !== 'payload' || typeof row.json !== 'string' || typeof row.payloadSha256 !== 'string'
        || row.version !== 1 || typeof row.createdAt !== 'number' || !Number.isFinite(row.createdAt)
        || !row.key || typeof row.key !== 'object' || Array.isArray(row.key)) throw new EffectRowCorruptError();
      try { validateEffectKey(row.key as EffectKey); }
      catch { throw new EffectRowCorruptError(); }
      return row as unknown as PayloadRow;
    },
    async create(row) {
      try {
        await ddb().send(new PutCommand({ TableName: TABLE,
          Item: { PK: effectPartitionKey(row.key), SK: payloadSortKey(row.key), ...row },
          ConditionExpression: 'attribute_not_exists(PK)' }));
        return true;
      } catch (error) {
        if ((error as { name?: string } | null)?.name === 'ConditionalCheckFailedException') return false;
        throw error;
      }
    },
  };
}
