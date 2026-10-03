import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { DraftRow, EffectKey, EffectRow } from './effect-ledger.js';

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('../state/ddb.js', () => ({ ddb: () => ({ send }) }));
import { dynamoEffectRows, EffectRowCorruptError } from './effect-rows-dynamo.js';

const key: EffectKey = { caseKey: 'case-1', stage: 'intake', step: 'write', stageEntryNo: 1 };
const row: EffectRow = { kind: 'effect', key, state: 'pending', payloadHash: 'abc', version: 1, createdAt: 0, updatedAt: 0 };
const draft: DraftRow = { kind: 'draft', key, text: 'draft', createdAt: 0, version: 1 };
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
      GSI1SK: `1970-01-01T00:00:01.000Z#${createHash('sha256').update('CASE#case-1|EFFECT#intake#write#1').digest('hex')}` });
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

describe('review: stored row boundaries', () => {
  it('uses a bounded digest in the unknown index and removes index fields after a round trip', async () => {
    const longKey = { ...key, caseKey: '漢'.repeat(256) };
    const unknown = { ...row, key: longKey, state: 'unknown' as const, updatedAt: 1000 };
    const pk = `CASE#${longKey.caseKey}`;
    const sk = 'EFFECT#intake#write#1';
    const gsi = `1970-01-01T00:00:01.000Z#${createHash('sha256').update(`${pk}|${sk}`).digest('hex')}`;
    send.mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Item: { PK: pk, SK: sk, GSI1PK: 'UNKNOWN', GSI1SK: gsi, ...unknown } })
      .mockResolvedValueOnce({});
    const rows = dynamoEffectRows();
    expect(await rows.replace(longKey, 1, unknown)).toBe(true);
    expect(send.mock.calls[0][0].input.Item).toMatchObject({ GSI1PK: 'UNKNOWN', GSI1SK: gsi });
    expect(Buffer.byteLength(gsi, 'utf8')).toBeLessThan(1024);
    const fetched = await rows.get(longKey);
    expect(fetched).toEqual(unknown);
    await rows.replace(longKey, 1, { ...fetched!, state: 'applied', version: 2 });
    expect(send.mock.calls[2][0].input.Item).not.toHaveProperty('GSI1PK');
    expect(send.mock.calls[2][0].input.Item).not.toHaveProperty('GSI1SK');
  });

  it('strips index attributes from an unknown query result', async () => {
    send.mockResolvedValueOnce({ Items: [{ ...row, state: 'unknown', PK: 'CASE#case-1',
      SK: 'EFFECT#intake#write#1', GSI1PK: 'UNKNOWN', GSI1SK: 'index' }] });
    expect(await dynamoEffectRows().listUnknown()).toEqual([{ ...row, state: 'unknown' }]);
  });

  it('creates drafts conditionally, reads their draft key, and uses the configured table', async () => {
    send.mockRejectedValueOnce(conditional()).mockResolvedValueOnce({ Item: { ...draft,
      PK: 'CASE#case-1', SK: 'DRAFT#intake#write#1' } });
    const rows = dynamoEffectRows();
    expect(await rows.createDraft(draft)).toBe(false);
    expect(send.mock.calls[0][0].input.ConditionExpression).toBe('attribute_not_exists(PK)');
    expect(await rows.getDraft(key)).toEqual(draft);
    expect(send.mock.calls[1][0].input.Key.SK).toBe('DRAFT#intake#write#1');
    expect(send.mock.calls.every(([command]) => command.input.TableName === (process.env.TABLE_EFFECT_LEDGER ?? 'claudeclaw-effect-ledger'))).toBe(true);
  });

  it('writes no expiry attribute and rejects malformed effect and draft items', async () => {
    send.mockResolvedValue({});
    const rows = dynamoEffectRows();
    await rows.create(row);
    await rows.createDraft(draft);
    for (const [command] of send.mock.calls) {
      expect(command.input.Item).not.toHaveProperty('ttl');
      expect(command.input.Item).not.toHaveProperty('expiresAt');
    }
    send.mockResolvedValueOnce({ Item: { kind: 'effect', key, version: '1' } });
    await expect(rows.get(key)).rejects.toBeInstanceOf(EffectRowCorruptError);
    send.mockResolvedValueOnce({ Items: [{ kind: 'effect', key, version: null }] });
    await expect(rows.listUnknown()).rejects.toBeInstanceOf(EffectRowCorruptError);
    send.mockResolvedValueOnce({ Item: { kind: 'draft', key, text: 'x' } });
    await expect(rows.getDraft(key)).rejects.toBeInstanceOf(EffectRowCorruptError);
  });
});
