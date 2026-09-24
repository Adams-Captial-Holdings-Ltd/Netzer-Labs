/**
 * P3 (step 5) — attachments at the storage layer, against the in-memory table.
 *
 * Written BEFORE the change, as the bar (netzar-chat-plan/p3-proof.sh rows M-1, M-2,
 * M-8, M-9 and the guard G-5).
 *
 * Today a message with files is stored as its text alone: nothing says a file was
 * sent, so a reload shows no trace of it (UPL-04/05), and deleting the conversation
 * leaves every stored file behind for the raw bucket's 365-day expiry. After P3 a
 * message record carries its attachments — `{ id, name, type, size, key }`, where
 * `key` is the stored copy in the raw bucket and never leaves the server — and
 * deleting the conversation deletes those files FIRST, then its records, so a failed
 * file delete leaves the conversation whole for a retry rather than stranding files
 * nothing points at any more (the same order P1 chose for records vs row).
 *
 * `deleteSession` is the one delete every caller uses — the dashboard route, the
 * privacy tool and the legacy migration — so the cascade lives in it. The in-memory
 * table answers queries written `PK = :pk AND begins_with(SK, :prefix)`, as every
 * query in sessions-repo.ts is; it applies no projection, which is why the same
 * delete is also proved on Floci (sessions-repo.p3.integration.test.ts, P95).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { S3Client, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { createFakeDynamo } from '../../__test-utils__/fake-dynamo.js';

const { send } = vi.hoisted(() => {
  process.env.RAW_BUCKET = 'raw-test-bucket';
  return { send: vi.fn() };
});

vi.mock('./ddb.js', async (importActual) => {
  const actual = await importActual<typeof import('./ddb.js')>();
  return { ...actual, ddb: () => ({ send }) };
});
vi.mock('./runtime-config-repo.js', () => ({ getConfig: async () => undefined }));
vi.mock('../../agent/memory-ingest.js', () => ({ ingestEvictedTurns: () => undefined }));
vi.mock('../observability/xray.js', () => ({ captureAwsClient: <T,>(c: T): T => c }));

import { appendTurns, deleteSession, getFullHistory, getSession } from './sessions-repo.js';

const PERSON = { surface: 'dashboard' as const, userId: 'dashboard:user:user-a', ephemeral: false };
const CHAT = 'dashboard:1750000000001';

function file(n: number) {
  return {
    id: `upload-${n}`,
    name: `report-${n}.pdf`,
    type: 'application/pdf',
    size: 1000 + n,
    key: `dashboard/${CHAT}/2026/09/24/${n}-report-${n}.pdf`,
  };
}

const spyS3 = () => vi.spyOn(S3Client.prototype, 'send');
let table: ReturnType<typeof createFakeDynamo>;
let s3Send: ReturnType<typeof spyS3> | undefined;
let order: string[];

beforeEach(() => {
  table = createFakeDynamo();
  order = [];
  send.mockReset();
  send.mockImplementation(async (cmd: { constructor: { name: string } }) => {
    if (cmd.constructor.name === 'BatchWriteCommand' || cmd.constructor.name === 'DeleteCommand') order.push('dynamodb-delete');
    return table.send(cmd as never);
  });
  s3Send?.mockRestore();
  s3Send = spyS3().mockImplementation(async (cmd: unknown) => {
    if (cmd instanceof DeleteObjectsCommand) {
      order.push(`s3-delete:${(cmd.input.Delete?.Objects ?? []).map((o) => o.Key).join(',')}`);
      return {} as never;
    }
    throw new Error(`unexpected S3 command ${(cmd as { constructor: { name: string } }).constructor.name}`);
  });
});

describe('chat attachments (P3) — sessions repo', () => {
  it('keeps a message\'s attachments on its record', async () => {
    await appendTurns('main', CHAT, [
      { role: 'user', text: 'see the file', ts: 1, attachments: [file(1)] },
      { role: 'assistant', text: 'got it', ts: 1 },
    ], undefined, PERSON);

    const records = [...table.rows.values()].filter((r) => String(r.SK).includes('#MSG#'));
    expect(records).toHaveLength(2);
    const user = records.find((r) => r.role === 'user')!;
    const assistant = records.find((r) => r.role === 'assistant')!;
    expect(user.attachments).toEqual([file(1)]);
    expect(assistant.attachments).toBeUndefined();
  });

  it('returns a message\'s attachments in the full history', async () => {
    await appendTurns('main', CHAT, [
      { role: 'user', text: 'two files', ts: 1, attachments: [file(1), file(2)] },
      { role: 'assistant', text: 'read both', ts: 1 },
    ], undefined, PERSON);
    const session = (await getSession('main', CHAT))!;

    const { turns } = await getFullHistory('main', CHAT, session);

    expect(turns[0]!.attachments).toEqual([file(1), file(2)]);
  });

  it('deletes a conversation\'s stored files before its records', async () => {
    await appendTurns('main', CHAT, [
      { role: 'user', text: 'first', ts: 1, attachments: [file(1)] },
      { role: 'assistant', text: 'ok', ts: 1 },
    ], undefined, PERSON);
    await appendTurns('main', CHAT, [
      { role: 'user', text: 'second', ts: 2, attachments: [file(2), file(3)] },
      { role: 'assistant', text: 'ok', ts: 2 },
    ], undefined, PERSON);

    await deleteSession('main', CHAT);

    // Every stored file, from the raw bucket, before a single DynamoDB delete.
    const s3Deletes = order.filter((o) => o.startsWith('s3-delete:'));
    const deletedKeys = s3Deletes.flatMap((o) => o.slice('s3-delete:'.length).split(','));
    expect(deletedKeys.sort()).toEqual([file(1).key, file(2).key, file(3).key].sort());
    const firstDynamoDelete = order.indexOf('dynamodb-delete');
    expect(firstDynamoDelete).toBeGreaterThan(-1);
    for (const o of s3Deletes) expect(order.indexOf(o)).toBeLessThan(firstDynamoDelete);
    const buckets = s3Send!.mock.calls.map(([cmd]) => (cmd as DeleteObjectsCommand).input.Bucket);
    expect(new Set(buckets)).toEqual(new Set(['raw-test-bucket']));
    // And the conversation is gone.
    expect([...table.rows.keys()].filter((k) => k.includes(CHAT))).toEqual([]);
  });

  it('keeps a conversation whose files could not be deleted', async () => {
    await appendTurns('main', CHAT, [
      { role: 'user', text: 'first', ts: 1, attachments: [file(1)] },
      { role: 'assistant', text: 'ok', ts: 1 },
    ], undefined, PERSON);
    const before = [...table.rows.keys()].sort();
    // S3 reports a per-key failure the way DeleteObjects does: in `Errors`, not by throwing.
    s3Send!.mockImplementation(async () => ({ Errors: [{ Key: file(1).key, Code: 'AccessDenied' }] }) as never);

    await expect(deleteSession('main', CHAT)).rejects.toThrow();

    // Nothing was deleted from DynamoDB, so a retry finds the same conversation.
    expect(order).not.toContain('dynamodb-delete');
    expect([...table.rows.keys()].sort()).toEqual(before);
  });

  it('makes no S3 call for a conversation with no stored files', async () => {
    await appendTurns('main', CHAT, [
      { role: 'user', text: 'just text', ts: 1 },
      { role: 'assistant', text: 'ok', ts: 1 },
    ], undefined, PERSON);

    await deleteSession('main', CHAT);

    expect(s3Send!).not.toHaveBeenCalled();
    expect([...table.rows.keys()].filter((k) => k.includes(CHAT))).toEqual([]);
  });
});
