import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dynamoPayloadRows, type PayloadRow } from './approval-payloads.js';
import { EffectRowCorruptError } from './effect-rows-dynamo.js';

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('../state/ddb.js', () => ({ ddb: () => ({ send }) }));

const key = { caseKey: 'case-1', stage: 'intake', step: 'write', stageEntryNo: 2 };
const row: PayloadRow = { kind: 'payload', key, json: '{"a":1}', payloadSha256: 'hash', createdAt: 100, version: 1 };
beforeEach(() => send.mockReset());

describe('dynamoPayloadRows', () => {
  it('puts the payload under the case and payload sort key', async () => {
    send.mockResolvedValueOnce({});
    expect(await dynamoPayloadRows().create(row)).toBe(true);
    expect(send.mock.calls[0][0].input).toMatchObject({
      TableName: process.env.TABLE_EFFECT_LEDGER ?? 'claudeclaw-effect-ledger',
      ConditionExpression: 'attribute_not_exists(PK)',
      Item: { PK: 'CASE#case-1', SK: 'PAYLOAD#intake#write#2', ...row },
    });
  });

  it('returns false for a conditional create failure', async () => {
    send.mockRejectedValueOnce(Object.assign(new Error('condition'), { name: 'ConditionalCheckFailedException' }));
    expect(await dynamoPayloadRows().create(row)).toBe(false);
  });

  it('rethrows another create error', async () => {
    const error = new Error('store down');
    send.mockRejectedValueOnce(error);
    await expect(dynamoPayloadRows().create(row)).rejects.toBe(error);
  });

  it('reads with a consistent GetCommand', async () => {
    send.mockResolvedValueOnce({ Item: { PK: 'CASE#case-1', SK: 'PAYLOAD#intake#write#2', ...row } });
    expect(await dynamoPayloadRows().get(key)).toEqual(row);
    expect(send.mock.calls[0][0].input).toMatchObject({
      Key: { PK: 'CASE#case-1', SK: 'PAYLOAD#intake#write#2' }, ConsistentRead: true,
    });
  });

  it('returns undefined when the row is absent', async () => {
    send.mockResolvedValueOnce({});
    expect(await dynamoPayloadRows().get(key)).toBeUndefined();
  });

  it('a corrupt row throws', async () => {
    const rows = dynamoPayloadRows();
    for (const corrupt of [{ ...row, kind: 'effect' }, { ...row, json: 1 }, { ...row, payloadSha256: null }]) {
      send.mockResolvedValueOnce({ Item: { PK: 'CASE#case-1', SK: 'PAYLOAD#intake#write#2', ...corrupt } });
      await expect(rows.get(key)).rejects.toBeInstanceOf(EffectRowCorruptError);
    }
  });
});
