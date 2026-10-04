import { ddb } from '../state/ddb.js';
import type { ShadowRows, ShadowSlot, ShadowUser } from './shadow-users.js';

const TABLE = process.env.TABLE_USERS ?? 'claudeclaw-users';
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
function slotOf(item: Record<string, unknown> | undefined): ShadowSlot | undefined {
  if (!item) return undefined;
  return { slot: String(item.slot), paperclipUserId: String(item.paperclipUserId),
    state: item.state as ShadowSlot['state'],
    ...(typeof item.netzerUserId === 'string' ? { netzerUserId: item.netzerUserId } : {}),
    ...(typeof item.assignedAt === 'number' ? { assignedAt: item.assignedAt } : {}),
    ...(typeof item.retiredAt === 'number' ? { retiredAt: item.retiredAt } : {}),
  };
}
function shadowOf(item: Record<string, unknown> | undefined): ShadowUser | undefined {
  if (!item) return undefined;
  return { netzerUserId: String(item.netzerUserId), slot: String(item.slot),
    paperclipUserId: String(item.paperclipUserId),
    decisionClasses: Array.isArray(item.decisionClasses) ? item.decisionClasses as string[] : [],
    status: item.status as ShadowUser['status'], assignedAt: Number(item.assignedAt),
    ...(typeof item.retiredAt === 'number' ? { retiredAt: item.retiredAt } : {}),
  };
}
async function get(key: { PK: string; SK: string }) {
      const { GetCommand } = await import('@aws-sdk/lib-dynamodb');
  return (await ddb().send(new GetCommand({ TableName: TABLE, Key: key, ConsistentRead: true }))).Item;
}

export function dynamoShadowRows(): ShadowRows {
  return {
    async getByNetzerUser(id) { return shadowOf(await get(userKey(id))); },
    async getByPaperclipUser(id) { return shadowOf(await get(reverseKey(id))); },
    async getSlot(slot) { validSlot(slot); return slotOf(await get(slotKey(slot))); },
    async listSlots() {
      const { ScanCommand } = await import('@aws-sdk/lib-dynamodb');
      const slots: ShadowSlot[] = [];
      let cursor: Record<string, unknown> | undefined;
      do {
        const result = await ddb().send(new ScanCommand({ TableName: TABLE,
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
      const { PutCommand } = await import('@aws-sdk/lib-dynamodb');
      validSlot(slot);
      try {
        await ddb().send(new PutCommand({ TableName: TABLE,
          Item: { ...slotKey(slot), slot, paperclipUserId, state: 'free' },
          ConditionExpression: 'attribute_not_exists(PK)' }));
        return true;
      } catch (error) { if (conditionalFailure(error)) return false; throw error; }
    },
    async assign({ slot, netzerUserId, decisionClasses, now }) {
      const { TransactWriteCommand } = await import('@aws-sdk/lib-dynamodb');
      validSlot(slot);
      const slotRow = await this.getSlot(slot);
      if (!slotRow || slotRow.state !== 'free') return false;
      const shadow: ShadowUser = { slot, netzerUserId, paperclipUserId: slotRow.paperclipUserId,
        decisionClasses: [...decisionClasses], status: 'active', assignedAt: now };
      try {
        await ddb().send(new TransactWriteCommand({ TransactItems: [
          { Update: { TableName: TABLE, Key: slotKey(slot),
            UpdateExpression: 'SET #state = :assigned, netzerUserId = :user, assignedAt = :now',
            ConditionExpression: '#state = :free AND paperclipUserId = :paperclip',
            ExpressionAttributeNames: { '#state': 'state' },
            ExpressionAttributeValues: { ':assigned': 'assigned', ':free': 'free', ':paperclip': slotRow.paperclipUserId, ':user': netzerUserId, ':now': now } } },
          { Put: { TableName: TABLE, Item: { ...userKey(netzerUserId), ...shadow },
            ConditionExpression: 'attribute_not_exists(PK) OR #status = :retired',
            ExpressionAttributeNames: { '#status': 'status' }, ExpressionAttributeValues: { ':retired': 'retired' } } },
          { Put: { TableName: TABLE, Item: { ...reverseKey(slotRow.paperclipUserId), ...shadow },
            ConditionExpression: 'attribute_not_exists(PK)' } },
        ] }));
        return true;
      } catch (error) { if (conditionalFailure(error)) return false; throw error; }
    },
    async retire({ netzerUserId, now }) {
      const { TransactWriteCommand } = await import('@aws-sdk/lib-dynamodb');
      const shadow = await this.getByNetzerUser(netzerUserId);
      if (!shadow || shadow.status !== 'active') return false;
      validSlot(shadow.slot);
      const identity = { ':user': netzerUserId, ':paperclip': shadow.paperclipUserId };
      try {
        await ddb().send(new TransactWriteCommand({ TransactItems: [
          { Update: { TableName: TABLE, Key: slotKey(shadow.slot),
            UpdateExpression: 'SET #state = :retired, retiredAt = :now',
            ConditionExpression: '#state = :assigned AND netzerUserId = :user AND paperclipUserId = :paperclip',
            ExpressionAttributeNames: { '#state': 'state' },
            ExpressionAttributeValues: { ...identity, ':retired': 'retired', ':assigned': 'assigned', ':now': now } } },
          ...[userKey(netzerUserId), reverseKey(shadow.paperclipUserId)].map((Key) => ({ Update: {
            TableName: TABLE, Key, UpdateExpression: 'SET #status = :retired, retiredAt = :now',
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
