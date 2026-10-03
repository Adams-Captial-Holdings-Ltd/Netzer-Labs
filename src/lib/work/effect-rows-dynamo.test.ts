import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DraftRow, EffectKey, EffectRow } from './effect-ledger.js';

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('../state/ddb.js', () => ({ ddb: () => ({ send }) }));
import { dynamoEffectRows } from './effect-rows-dynamo.js';

const key: EffectKey = { caseKey: 'case-1', stage: 'intake', step: 'write', stageEntryNo: 1 };
const row: EffectRow = { kind: 'effect', key, state: 'pending', payloadHash: 'abc', version: 1, createdAt: 0, updatedAt: 0 };
const draft: DraftRow = { kind: 'draft', key, text: 'draft', createdAt: 0 };
const conditional = () => Object.assign(new Error('condition'), { name: 'ConditionalCheckFailedException' });
beforeEach(() => send.mockReset());

describe('dynamoEffectRows', () => {
  it('returns false for a conditional create failure', async () => {
    send.mockRejectedValueOnce(conditional());
    expect(await dynamoEffectRows().create(row)).toBe(false);
    expect(send.mock.calls[0][0].input.ConditionExpression).toBe('attribute_not_exists(PK)');
  });
  it('propagates other create errors', async () => {
    const error = new Error('store down');
    send.mockRejectedValueOnce(error);
    await expect(dynamoEffectRows().create(row)).rejects.toBe(error);
  });
  it('replaces only the expected version', async () => {
    send.mockResolvedValue({});
    expect(await dynamoEffectRows().replace(key, 1, { ...row, version: 2 })).toBe(true);
    expect(send.mock.calls[0][0].input).toMatchObject({ ConditionExpression: '#v = :expected',
      ExpressionAttributeNames: { '#v': 'version' }, ExpressionAttributeValues: { ':expected': 1 } });
    send.mockRejectedValueOnce(conditional());
    expect(await dynamoEffectRows().replace(key, 1, row)).toBe(false);
  });
  it('reads effects and drafts consistently', async () => {
    send.mockResolvedValueOnce({ Item: { PK: 'CASE#case-1', SK: 'EFFECT#intake#write#1', ...row } })
      .mockResolvedValueOnce({ Item: { PK: 'CASE#case-1', SK: 'DRAFT#intake#write#1', ...draft } });
    const rows = dynamoEffectRows();
    expect(await rows.get(key)).toEqual(row);
    expect(await rows.getDraft(key)).toEqual(draft);
    expect(send.mock.calls.map(([command]) => command.input.ConsistentRead)).toEqual([true, true]);
  });
  it('puts index attributes only on unknown rows', async () => {
    send.mockResolvedValue({});
    const rows = dynamoEffectRows();
    await rows.create({ ...row, state: 'unknown', updatedAt: 1000 });
    await rows.replace(key, 1, { ...row, state: 'applied', version: 2 });
    expect(send.mock.calls[0][0].input.Item).toMatchObject({ GSI1PK: 'UNKNOWN',
      GSI1SK: '1970-01-01T00:00:01.000Z#CASE#case-1#EFFECT#intake#write#1' });
    expect(send.mock.calls[1][0].input.Item.GSI1PK).toBeUndefined();
    expect(send.mock.calls[1][0].input.Item.GSI1SK).toBeUndefined();
  });
  it('lists every page of the sparse unknown index', async () => {
    const item = { PK: 'CASE#case-1', SK: 'EFFECT#intake#write#1', GSI1PK: 'UNKNOWN', GSI1SK: 'time', ...row, state: 'unknown' };
    const cursor = { PK: 'CASE#case-1', SK: 'EFFECT#intake#write#1' };
    send.mockResolvedValueOnce({ Items: [item], LastEvaluatedKey: cursor }).mockResolvedValueOnce({ Items: [item] });
    expect(await dynamoEffectRows().listUnknown()).toHaveLength(2);
    expect(send.mock.calls[0][0].input.IndexName).toBe('gsi1-unknown');
    expect(send.mock.calls[1][0].input.ExclusiveStartKey).toEqual(cursor);
  });
  it('stores drafts under their own sort key', async () => {
    send.mockResolvedValue({});
    expect(await dynamoEffectRows().createDraft(draft)).toBe(true);
    expect(send.mock.calls[0][0].input.Item.SK).toBe('DRAFT#intake#write#1');
  });
});
