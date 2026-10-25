import { describe, it, expect, vi, beforeEach } from 'vitest';
import { S3Client } from '@aws-sdk/client-s3';

/** NZR-6: putDocument's compare-and-swap mode, used by quarantine reassign. */

vi.hoisted(() => {
  process.env.VECTORS_BUCKET = 'test-vectors-index';
});

import { putDocument, readDocument } from './store.js';

const ROW = { chunkId: 'd#0', text: 't', embedding: [0.1], metadata: { docId: 'd', scope: 's', chunkIndex: 0, start: 0, end: 1, uploadedAt: '2026-10-25T00:00:00Z' } };
const sent: Array<Record<string, unknown>> = [];
let failWith: number | null = null;

beforeEach(() => {
  sent.length = 0;
  failWith = null;
  vi.spyOn(S3Client.prototype, 'send').mockImplementation((async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
    sent.push(cmd.input);
    if (cmd.constructor.name === 'GetObjectCommand') return { ETag: '"v1"', Body: { transformToString: async () => JSON.stringify(ROW) } };
    if (failWith) throw Object.assign(new Error('conflict'), { $metadata: { httpStatusCode: failWith } });
    return {};
  }) as never);
});

describe('putDocument conditional write', () => {
  it('passes the ETag through and maps 412/409 to false', async () => {
    const { rows, etag } = await readDocument('s', 'd');
    expect(rows).toHaveLength(1);
    expect(etag).toBe('"v1"');

    expect(await putDocument('s', 'd', rows, etag)).toBe(true);
    expect(sent.at(-1)).toMatchObject({ IfMatch: '"v1"' });
    expect(await putDocument('s', 'd', rows, null)).toBe(true);
    expect(sent.at(-1)).toMatchObject({ IfNoneMatch: '*' });

    for (const code of [412, 409]) {
      failWith = code;
      expect(await putDocument('s', 'd', rows, etag)).toBe(false);
    }
  });

  it('a plain overwrite stays unconditional and still throws on errors', async () => {
    expect(await putDocument('s', 'd', [ROW])).toBe(true);
    expect(sent.at(-1)).not.toHaveProperty('IfMatch');
    expect(sent.at(-1)).not.toHaveProperty('IfNoneMatch');
    failWith = 412;
    await expect(putDocument('s', 'd', [ROW])).rejects.toThrow('conflict');
  });
});
