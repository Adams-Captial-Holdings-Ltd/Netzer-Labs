import { GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { createHash } from 'node:crypto';
import { ddb } from '../state/ddb.js';
import { draftSortKey, effectPartitionKey, effectSortKey, type DraftRow, type EffectRow, type EffectRows } from './effect-ledger.js';

const TABLE = process.env.TABLE_EFFECT_LEDGER ?? 'claudeclaw-effect-ledger';
const conditionalFailure = (error: unknown) =>
  (error as { name?: string } | null)?.name === 'ConditionalCheckFailedException';
const key = (row: EffectRow | DraftRow) => ({ PK: effectPartitionKey(row.key),
  SK: row.kind === 'effect' ? effectSortKey(row.key) : draftSortKey(row.key) });
const item = (row: EffectRow | DraftRow) => ({ ...key(row), ...row,
  ...(row.kind === 'draft' ? { version: row.version ?? 1 } : {}),
  ...(row.kind === 'effect' && row.state === 'unknown' ? {
    GSI1PK: 'UNKNOWN', GSI1SK: `${new Date(row.updatedAt).toISOString()}#${createHash('sha256')
      .update(`${effectPartitionKey(row.key)}|${effectSortKey(row.key)}`).digest('hex')}`,
  } : {}),
});
export class EffectRowCorruptError extends Error {
  constructor() { super('Effect row is corrupt'); this.name = 'EffectRowCorruptError'; }
}
function unpack<T>(found: Record<string, unknown> | undefined, kind: 'effect' | 'draft'): T | undefined {
  if (!found) return undefined;
  const { PK: _pk, SK: _sk, GSI1PK: _gpk, GSI1SK: _gsk, ...row } = found;
  if (row.kind !== kind || !row.key || typeof row.key !== 'object' || Array.isArray(row.key)
    || typeof row.version !== 'number') throw new EffectRowCorruptError();
  return row as T;
}

export function dynamoEffectRows(): EffectRows {
  return {
    async get(effectKey) {
      const result = await ddb().send(new GetCommand({ TableName: TABLE,
        Key: { PK: effectPartitionKey(effectKey), SK: effectSortKey(effectKey) }, ConsistentRead: true }));
      return unpack<EffectRow>(result.Item, 'effect');
    },
    async create(row) {
      try {
        await ddb().send(new PutCommand({ TableName: TABLE, Item: item(row),
          ConditionExpression: 'attribute_not_exists(PK)' }));
        return true;
      } catch (error) {
        if (conditionalFailure(error)) return false;
        throw error;
      }
    },
    async replace(effectKey, expectedVersion, next) {
      try {
        await ddb().send(new PutCommand({ TableName: TABLE, Item: { ...item(next),
          PK: effectPartitionKey(effectKey), SK: effectSortKey(effectKey) },
          ConditionExpression: '#v = :expected', ExpressionAttributeNames: { '#v': 'version' },
          ExpressionAttributeValues: { ':expected': expectedVersion } }));
        return true;
      } catch (error) {
        if (conditionalFailure(error)) return false;
        throw error;
      }
    },
    async listUnknown() {
      const rows: EffectRow[] = [];
      let cursor: Record<string, unknown> | undefined;
      do {
        const result = await ddb().send(new QueryCommand({ TableName: TABLE, IndexName: 'gsi1-unknown',
          KeyConditionExpression: 'GSI1PK = :unknown', ExpressionAttributeValues: { ':unknown': 'UNKNOWN' },
          ...(cursor ? { ExclusiveStartKey: cursor } : {}) }));
        for (const found of result.Items ?? []) rows.push(unpack<EffectRow>(found, 'effect')!);
        cursor = result.LastEvaluatedKey;
      } while (cursor);
      return rows;
    },
    async getDraft(effectKey) {
      const result = await ddb().send(new GetCommand({ TableName: TABLE,
        Key: { PK: effectPartitionKey(effectKey), SK: draftSortKey(effectKey) }, ConsistentRead: true }));
      return unpack<DraftRow>(result.Item, 'draft');
    },
    async createDraft(row) {
      try {
        await ddb().send(new PutCommand({ TableName: TABLE, Item: item(row),
          ConditionExpression: 'attribute_not_exists(PK)' }));
        return true;
      } catch (error) {
        if (conditionalFailure(error)) return false;
        throw error;
      }
    },
  };
}
