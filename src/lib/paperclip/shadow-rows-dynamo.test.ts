import { beforeEach, describe, expect, it, vi } from 'vitest';
const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('../state/ddb.js', () => ({ ddb: () => ({ send }) }));
import { dynamoShadowRows } from './shadow-rows-dynamo.js';
const free = { PK: 'SHADOWSLOT#01', SK: 'SLOT', slot: '01', paperclipUserId: 'pc-1', state: 'free' };
const active = { PK: 'USER#net-1', SK: 'SHADOW', netzerUserId: 'net-1', slot: '01', paperclipUserId: 'pc-1',
  decisionClasses: ['money'], status: 'active', assignedAt: 10 };
const condition = () => Object.assign(new Error('condition'), { name: 'TransactionCanceledException',
  CancellationReasons: [{ Code: 'None' }, { Code: 'ConditionalCheckFailed' }] });
beforeEach(() => send.mockReset());
describe('Dynamo shadow registry', () => {
  it('reads all three key shapes consistently', async () => {
    send.mockResolvedValueOnce({ Item: free }).mockResolvedValueOnce({ Item: active }).mockResolvedValueOnce({ Item: active });
    const rows = dynamoShadowRows();
    expect(await rows.getSlot('01')).toMatchObject({ slot: '01', state: 'free' });
    expect(await rows.getByNetzerUser('net-1')).toMatchObject({ paperclipUserId: 'pc-1' });
    expect(await rows.getByPaperclipUser('pc-1')).toMatchObject({ netzerUserId: 'net-1' });
    expect(send.mock.calls.map(([command]) => command.input.Key)).toEqual([
      { PK: 'SHADOWSLOT#01', SK: 'SLOT' }, { PK: 'USER#net-1', SK: 'SHADOW' }, { PK: 'PCUSER#pc-1', SK: 'SHADOW' },
    ]);
    expect(send.mock.calls.every(([command]) => command.input.ConsistentRead === true)).toBe(true);
  });
  it('creates a free slot once with a conditional put', async () => {
    send.mockResolvedValueOnce({}).mockRejectedValueOnce(Object.assign(new Error('taken'), { name: 'ConditionalCheckFailedException' }));
    const rows = dynamoShadowRows();
    expect(await rows.createSlot({ slot: '01', paperclipUserId: 'pc-1' })).toBe(true);
    expect(send.mock.calls[0][0].input).toMatchObject({ Item: free, ConditionExpression: 'attribute_not_exists(PK)' });
    expect(await rows.createSlot({ slot: '01', paperclipUserId: 'pc-1' })).toBe(false);
  });
  it('lists every free, assigned and retired slot consistently', async () => {
    send.mockResolvedValueOnce({ Items: [free], LastEvaluatedKey: { PK: free.PK, SK: free.SK } })
      .mockResolvedValueOnce({ Items: [{ ...free, slot: '02', PK: 'SHADOWSLOT#02', state: 'retired' }] });
    expect((await dynamoShadowRows().listSlots()).map((slot) => slot.slot)).toEqual(['01', '02']);
    expect(send.mock.calls[0][0].input.ConsistentRead).toBe(true);
    expect(send.mock.calls[1][0].input.ExclusiveStartKey).toEqual({ PK: free.PK, SK: free.SK });
  });
  it('assigns the three rows in one conditional transaction', async () => {
    send.mockResolvedValueOnce({ Item: free }).mockResolvedValueOnce({});
    expect(await dynamoShadowRows().assign({ slot: '01', netzerUserId: 'net-1', decisionClasses: ['money'], now: 10 })).toBe(true);
    const writes = send.mock.calls[1][0].input.TransactItems;
    expect(writes).toHaveLength(3);
    expect(writes[0].Update.Key).toEqual({ PK: 'SHADOWSLOT#01', SK: 'SLOT' });
    expect(writes[0].Update.ConditionExpression).toContain(':free');
    expect(writes[1].Put).toMatchObject({ Item: { PK: 'USER#net-1', SK: 'SHADOW', status: 'active' } });
    expect(writes[1].Put.ConditionExpression).toContain(':retired');
    expect(writes[2].Put).toMatchObject({ Item: { PK: 'PCUSER#pc-1', SK: 'SHADOW' }, ConditionExpression: 'attribute_not_exists(PK)' });
  });
  it('refuses a taken slot before writing', async () => {
    send.mockResolvedValueOnce({ Item: { ...free, state: 'assigned' } });
    expect(await dynamoShadowRows().assign({ slot: '01', netzerUserId: 'net-1', decisionClasses: [], now: 10 })).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('refuses a user who already has an active shadow when the transaction condition fails', async () => {
    send.mockResolvedValueOnce({ Item: free }).mockRejectedValueOnce(condition());
    expect(await dynamoShadowRows().assign({ slot: '01', netzerUserId: 'net-1', decisionClasses: [], now: 10 })).toBe(false);
    expect(send.mock.calls[1][0].input.TransactItems[1].Put.ConditionExpression).toContain('attribute_not_exists(PK)');
  });
  it('does not turn a transaction conflict into a taken slot', async () => {
    const conflict = Object.assign(new Error('conflict'), { name: 'TransactionCanceledException',
      CancellationReasons: [{ Code: 'TransactionConflict' }] });
    send.mockResolvedValueOnce({ Item: free }).mockRejectedValueOnce(conflict);
    await expect(dynamoShadowRows().assign({ slot: '01', netzerUserId: 'net-1', decisionClasses: [], now: 10 }))
      .rejects.toBe(conflict);
  });
  it('retires slot and both shadow rows in one transaction, keeping the reverse row', async () => {
    send.mockResolvedValueOnce({ Item: active }).mockResolvedValueOnce({});
    expect(await dynamoShadowRows().retire({ netzerUserId: 'net-1', now: 20 })).toBe(true);
    const writes = send.mock.calls[1][0].input.TransactItems;
    expect(writes).toHaveLength(3);
    expect(writes.map((write: { Update?: { Key: object } }) => write.Update?.Key)).toEqual([
      { PK: 'SHADOWSLOT#01', SK: 'SLOT' }, { PK: 'USER#net-1', SK: 'SHADOW' }, { PK: 'PCUSER#pc-1', SK: 'SHADOW' },
    ]);
    expect(writes.every((write: { Delete?: unknown }) => write.Delete === undefined)).toBe(true);
    expect(writes[0].Update.UpdateExpression).toContain(':retired');
  });
  it('refuses slot 00 and malformed slots before any Dynamo call', async () => {
    const rows = dynamoShadowRows();
    for (const slot of ['00', '1', '100', 'ab']) {
      await expect(rows.getSlot(slot)).rejects.toThrow('Invalid shadow slot');
      await expect(rows.createSlot({ slot, paperclipUserId: 'pc' })).rejects.toThrow('Invalid shadow slot');
      await expect(rows.assign({ slot, netzerUserId: 'net', decisionClasses: [], now: 1 })).rejects.toThrow('Invalid shadow slot');
    }
    expect(send).not.toHaveBeenCalled();
  });
});
