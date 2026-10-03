import { GetCommand, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../state/ddb.js';
import { ATTEMPT_ROW_TTL_SECONDS, type AttemptRow, type AttemptRows } from './attempt-store.js';

const TABLE = process.env.TABLE_QUEUE_LEASE ?? 'claudeclaw-queue-lease';
const key = (issueId: string) => `ATTEMPT#${issueId}`;
const item = (row: AttemptRow, issueId = row.issueId) => ({
  PK: key(issueId), ...row,
  ttl: Math.floor(Date.now() / 1000) + ATTEMPT_ROW_TTL_SECONDS,
});
const conditionalFailure = (error: unknown) =>
  (error as { name?: string } | null)?.name === 'ConditionalCheckFailedException';

export function dynamoAttemptRows(): AttemptRows {
  return {
    async get(issueId) {
      const result = await ddb().send(new GetCommand({
        TableName: TABLE, Key: { PK: key(issueId) }, ConsistentRead: true,
      }));
      if (!result.Item) return undefined;
      const { PK: _pk, ttl: _ttl, ...row } = result.Item;
      return row as AttemptRow;
    },
    async create(row) {
      try {
        await ddb().send(new PutCommand({
          TableName: TABLE, Item: item(row), ConditionExpression: 'attribute_not_exists(PK)',
        }));
        return true;
      } catch (error) {
        if (conditionalFailure(error)) return false;
        throw error;
      }
    },
    async replace(issueId, expectedVersion, next) {
      try {
        await ddb().send(new PutCommand({
          TableName: TABLE, Item: item(next, issueId), ConditionExpression: '#v = :expected',
          ExpressionAttributeNames: { '#v': 'version' },
          ExpressionAttributeValues: { ':expected': expectedVersion },
        }));
        return true;
      } catch (error) {
        if (conditionalFailure(error)) return false;
        throw error;
      }
    },
  };
}

// ponytail: This is a table scan; fine while the lease table is small, move to a GSI if it grows.
export async function scanRecordedAttempts(): Promise<AttemptRow[]> {
  const rows: AttemptRow[] = [];
  let cursor: Record<string, unknown> | undefined;
  do {
    const result = await ddb().send(new ScanCommand({
      TableName: TABLE,
      FilterExpression: 'begins_with(PK, :p) AND #s = :recorded',
      ExpressionAttributeNames: { '#s': 'state' },
      ExpressionAttributeValues: { ':p': 'ATTEMPT#', ':recorded': 'recorded' },
      ...(cursor ? { ExclusiveStartKey: cursor } : {}),
    }));
    for (const found of result.Items ?? []) {
      const { PK: _pk, ttl: _ttl, ...row } = found;
      rows.push(row as AttemptRow);
    }
    cursor = result.LastEvaluatedKey;
  } while (cursor);
  return rows;
}
