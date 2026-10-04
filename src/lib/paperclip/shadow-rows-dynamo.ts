import { logger } from '../../observability/logger.js';
import { ddb } from '../state/ddb.js';
import { validShadowUser, type ShadowRows, type ShadowSlot, type ShadowUser } from './shadow-users.js';

const slotKey = (slot: string) => ({ PK: `SHADOWSLOT#${slot}`, SK: 'SLOT' });
const userKey = (id: string) => ({ PK: `USER#${id}`, SK: 'SHADOW' });
const reverseKey = (id: string) => ({ PK: `PCUSER#${id}`, SK: 'SHADOW' });
const validSlot = (slot: string) => {
  if (!/^(0[1-9]|[1-9][0-9])$/.test(slot)) throw new Error('Invalid shadow slot');
};
const conditionalFailure = (error: unknown) => {
  const failure = error as { name?: string; CancellationReasons?: Array<{ Code?: string }> } | null;
  return failure?.name === 'ConditionalCheckFailedException' ||
    (failure?.name === 'TransactionCanceledException' &&
      failure.CancellationReasons?.some((reason) => reason.Code === 'ConditionalCheckFailed') === true);
};
function slotOf(item: Record<string, unknown> | undefined, expected?: string): ShadowSlot | undefined {
  if (!item) return undefined;
  const valid = typeof item.slot === 'string' && /^(0[1-9]|[1-9][0-9])$/.test(item.slot)
    && (expected === undefined || item.slot === expected)
    && typeof item.paperclipUserId === 'string' && item.paperclipUserId.trim().length > 0
    && (item.state === 'free' || item.state === 'assigned' || item.state === 'retired')
    && (item.netzerUserId === undefined || (typeof item.netzerUserId === 'string' && !!item.netzerUserId.trim()))
    && (item.assignedAt === undefined || (typeof item.assignedAt === 'number' && Number.isFinite(item.assignedAt)))
    && (item.retiredAt === undefined || (typeof item.retiredAt === 'number' && Number.isFinite(item.retiredAt)));
  if (!valid || typeof item.slot !== 'string' || typeof item.paperclipUserId !== 'string'
    || (item.state !== 'free' && item.state !== 'assigned' && item.state !== 'retired')) {
    logger.warn({ kind: 'slot', slot: expected ?? 'unknown' }, 'malformed shadow row');
    return undefined;
  }
  return { slot: item.slot, paperclipUserId: item.paperclipUserId, state: item.state,
    ...(typeof item.netzerUserId === 'string' ? { netzerUserId: item.netzerUserId } : {}),
    ...(typeof item.assignedAt === 'number' ? { assignedAt: item.assignedAt } : {}),
    ...(typeof item.retiredAt === 'number' ? { retiredAt: item.retiredAt } : {}) };
}
function shadowOf(item: Record<string, unknown> | undefined,
  expectedPaperclipId?: string, expectedNetzerId?: string): ShadowUser | undefined {
  if (!item) return undefined;
  if (!validShadowUser(item) || (expectedPaperclipId && item.paperclipUserId !== expectedPaperclipId)
    || (expectedNetzerId && item.netzerUserId !== expectedNetzerId)
    || (item.status === 'retired' && (typeof item.retiredAt !== 'number' || !Number.isFinite(item.retiredAt)))) {
    logger.warn({ kind: 'user' }, 'malformed shadow row');
    return undefined;
  }
  return { netzerUserId: item.netzerUserId, slot: item.slot, paperclipUserId: item.paperclipUserId,
    decisionClasses: [...item.decisionClasses], status: item.status, assignedAt: item.assignedAt,
    ...(item.retiredAt !== undefined ? { retiredAt: item.retiredAt } : {}) };
}
async function get(table: string, key: { PK: string; SK: string }) {
  const { GetCommand } = await import('@aws-sdk/lib-dynamodb');
  return (await ddb().send(new GetCommand({ TableName: table, Key: key, ConsistentRead: true }))).Item;
}

export function dynamoShadowRows(table?: string): ShadowRows {
  const tableName = table ?? process.env.TABLE_USERS ?? 'claudeclaw-users';
  const getSlot = async (slot: string) => { validSlot(slot); return slotOf(await get(tableName, slotKey(slot)), slot); };
  const getByNetzerUser = async (id: string) => shadowOf(await get(tableName, userKey(id)), undefined, id);
  return {
    getByNetzerUser,
    async getByPaperclipUser(id) { return shadowOf(await get(tableName, reverseKey(id)), id); },
    getSlot,
    async listSlots() {
      const { ScanCommand } = await import('@aws-sdk/lib-dynamodb');
      const slots: ShadowSlot[] = [];
      let cursor: Record<string, unknown> | undefined;
      do {
        const result = await ddb().send(new ScanCommand({ TableName: tableName,
          FilterExpression: 'begins_with(PK, :prefix) AND SK = :sort',
          ExpressionAttributeValues: { ':prefix': 'SHADOWSLOT#', ':sort': 'SLOT' },
          ConsistentRead: true, ...(cursor ? { ExclusiveStartKey: cursor } : {}) }));
        for (const item of result.Items ?? []) {
          const slot = slotOf(item);
          if (slot) slots.push(slot);
        }
        cursor = result.LastEvaluatedKey;
      } while (cursor);
      return slots.sort((a, b) => a.slot.localeCompare(b.slot));
    },
    async createSlot({ slot, paperclipUserId }) {
      validSlot(slot);
      const { PutCommand } = await import('@aws-sdk/lib-dynamodb');
      try {
        await ddb().send(new PutCommand({ TableName: tableName,
          Item: { ...slotKey(slot), slot, paperclipUserId, state: 'free' },
          ConditionExpression: 'attribute_not_exists(PK)' }));
        return true;
      } catch (error) { if (conditionalFailure(error)) return false; throw error; }
    },
    async assign({ slot, netzerUserId, decisionClasses, now }) {
      validSlot(slot);
      const slotRow = await getSlot(slot);
      if (!slotRow || slotRow.state !== 'free') return false;
      const shadow: ShadowUser = { slot, netzerUserId, paperclipUserId: slotRow.paperclipUserId,
        decisionClasses: [...decisionClasses], status: 'active', assignedAt: now };
      const { TransactWriteCommand } = await import('@aws-sdk/lib-dynamodb');
      try {
        await ddb().send(new TransactWriteCommand({ TransactItems: [
          { Update: { TableName: tableName, Key: slotKey(slot),
            UpdateExpression: 'SET #state = :assigned, netzerUserId = :user, assignedAt = :now',
            ConditionExpression: '#state = :free AND paperclipUserId = :paperclip',
            ExpressionAttributeNames: { '#state': 'state' },
            ExpressionAttributeValues: { ':assigned': 'assigned', ':free': 'free',
              ':paperclip': slotRow.paperclipUserId, ':user': netzerUserId, ':now': now } } },
          { Put: { TableName: tableName, Item: { ...userKey(netzerUserId), ...shadow },
            ConditionExpression: 'attribute_not_exists(PK) OR #status = :retired',
            ExpressionAttributeNames: { '#status': 'status' }, ExpressionAttributeValues: { ':retired': 'retired' } } },
          { Put: { TableName: tableName, Item: { ...reverseKey(slotRow.paperclipUserId), ...shadow },
            ConditionExpression: 'attribute_not_exists(PK)' } },
        ] }));
        return true;
      } catch (error) { if (conditionalFailure(error)) return false; throw error; }
    },
    async retire({ netzerUserId, now }) {
      const shadow = await getByNetzerUser(netzerUserId);
      if (!shadow || shadow.status !== 'active') return false;
      validSlot(shadow.slot);
      const identity = { ':user': netzerUserId, ':paperclip': shadow.paperclipUserId };
      const { TransactWriteCommand } = await import('@aws-sdk/lib-dynamodb');
      try {
        await ddb().send(new TransactWriteCommand({ TransactItems: [
          { Update: { TableName: tableName, Key: slotKey(shadow.slot),
            UpdateExpression: 'SET #state = :retired, retiredAt = :now',
            ConditionExpression: '#state = :assigned AND netzerUserId = :user AND paperclipUserId = :paperclip',
            ExpressionAttributeNames: { '#state': 'state' },
            ExpressionAttributeValues: { ...identity, ':retired': 'retired', ':assigned': 'assigned', ':now': now } } },
          ...[userKey(netzerUserId), reverseKey(shadow.paperclipUserId)].map((Key) => ({ Update: {
            TableName: tableName, Key, UpdateExpression: 'SET #status = :retired, retiredAt = :now',
            ConditionExpression: '#status = :active AND netzerUserId = :user AND paperclipUserId = :paperclip',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: { ...identity, ':retired': 'retired', ':active': 'active', ':now': now },
          } })),
        ] }));
        return true;
      } catch (error) { if (conditionalFailure(error)) return false; throw error; }
    },
  };
}
