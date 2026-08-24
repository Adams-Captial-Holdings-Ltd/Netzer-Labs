/**
 * End-to-end durability reproduction for the 2026-08 knowledge-base wipe.
 *
 * The guards in `infra/lib/storage-stack.test.ts` assert the SHAPE of the
 * synthesized template. This file asserts the thing an operator actually
 * cares about: save a file, import a document through the real ingest
 * pipeline, and then prove that the keys those code paths really produced
 * cannot be matched by any lifecycle rule that deletes a current object.
 *
 * It is a reproduction, not just a check — `describe('the incident itself')`
 * feeds the pre-fix configuration to the same matcher and requires it to
 * report the loss. If that block ever goes green-by-passing, the matcher has
 * stopped being able to see the bug and every other assertion here is
 * worthless.
 *
 * Real: key construction, scope folding, chunking, JSONL encoding, the S3
 * command objects, listing/pagination, the read-back path, and the actual
 * CloudFormation synthesized by StorageStack.
 * Stubbed: the Bedrock embedding call (a network call whose vector values are
 * irrelevant to durability) and the S3 wire protocol, which is AWS's code.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { S3Client } from '@aws-sdk/client-s3';
import { StorageStack } from '../../../infra/lib/storage-stack.js';

const INDEX_BUCKET = 'claudeclaw-vectors-239887088812-us-east-1';
const STAGING_BUCKET = 'claudeclaw-vectors-staging-239887088812-us-east-1';

vi.hoisted(() => {
  // store.ts captures both bucket names at module load.
  process.env.VECTORS_BUCKET = 'claudeclaw-vectors-239887088812-us-east-1';
  process.env.VECTORS_STAGING_BUCKET = 'claudeclaw-vectors-staging-239887088812-us-east-1';
});

vi.mock('./embedder.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./embedder.js')>()),
  embedMany: async (texts: string[]) => texts.map(() => new Array(1024).fill(0.01)),
}));

// ── the smallest S3 that the real code cannot tell from the real thing ──
const objects = new Map<string, string>();

function installS3(): void {
  vi.spyOn(S3Client.prototype, 'send').mockImplementation((async (cmd: {
    constructor: { name: string };
    input: Record<string, string | undefined>;
  }) => {
    const { Bucket, Key, Body, Prefix } = cmd.input as Record<string, string>;
    switch (cmd.constructor.name) {
      case 'PutObjectCommand':
        objects.set(`${Bucket}/${Key}`, String(Body));
        return {};
      case 'GetObjectCommand': {
        const body = objects.get(`${Bucket}/${Key}`);
        if (body === undefined) {
          const err = new Error('NoSuchKey');
          err.name = 'NoSuchKey';
          throw err;
        }
        return {
          Body: {
            transformToString: async () => body,
            transformToByteArray: async () => new TextEncoder().encode(body),
          },
        };
      }
      case 'HeadObjectCommand': {
        if (!objects.has(`${Bucket}/${Key}`)) {
          const err = new Error('NotFound');
          err.name = 'NotFound';
          throw err;
        }
        return {};
      }
      case 'ListObjectsV2Command':
        return {
          Contents: [...objects.keys()]
            .filter((k) => k.startsWith(`${Bucket}/${Prefix ?? ''}`))
            .map((k) => ({ Key: k.slice(Bucket.length + 1) })),
          IsTruncated: false,
        };
      case 'DeleteObjectCommand':
        objects.delete(`${Bucket}/${Key}`);
        return {};
      default:
        throw new Error(`repro harness: unhandled ${cmd.constructor.name}`);
    }
  }) as never);
}

// ── the synthesized template, and what its rules can reach ──
type Rule = { ExpirationInDays?: number; ExpirationDate?: string; Prefix?: string; Filter?: { Prefix?: string } };

function bucketNamed(fragment: string): Record<string, unknown> {
  const app = new App();
  const stack = new StorageStack(app, 'CCE-Storage', {
    tier: 1,
    env: { account: '239887088812', region: 'us-east-1' },
  });
  const found = Object.entries(
    Template.fromStack(stack).findResources('AWS::S3::Bucket'),
  ).find(([id]) => id.startsWith(fragment));
  expect(found, `no synthesized bucket "${fragment}"`).toBeDefined();
  return (found as [string, Record<string, unknown>])[1];
}

function lifecycleRules(bucket: Record<string, unknown>): Rule[] {
  const props = (bucket.Properties ?? {}) as {
    LifecycleConfiguration?: { Rules?: Rule[] };
  };
  return props.LifecycleConfiguration?.Rules ?? [];
}

/**
 * Rules that would DELETE this key. Noncurrent-version housekeeping is
 * excluded on purpose: it cannot remove a current object.
 */
function rulesThatWouldExpire(rules: Rule[], key: string): Rule[] {
  return rules.filter((r) => {
    const deletesCurrent = r.ExpirationInDays !== undefined || r.ExpirationDate !== undefined;
    if (!deletesCurrent) return false;
    const prefix = r.Prefix ?? r.Filter?.Prefix ?? '';
    return key.startsWith(prefix);
  });
}

describe('knowledge durability, end to end', () => {
  beforeEach(() => {
    objects.clear();
    installS3();
  });
  afterEach(() => vi.restoreAllMocks());

  it('saves a file to the staging bucket under the upload prefix', async () => {
    const { uploadKeyFor, isUploadKey, getObjectBuffer } = await import('./store.js');
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');

    const key = uploadKeyFor('q3-board-pack.pdf', 'upload-1');
    expect(isUploadKey(key)).toBe(true);

    // The browser's PUT, as the presigned URL would perform it.
    await new S3Client({ region: 'us-east-1' }).send(
      new PutObjectCommand({ Bucket: STAGING_BUCKET, Key: key, Body: 'board pack bytes' }) as never,
    );

    expect(await getObjectBuffer(key)).toEqual(Buffer.from('board pack bytes'));
  });

  it('imports a document into the durable bucket and reads it back', async () => {
    const { ingestDocument } = await import('./ingest.js');
    const { listDocuments, keyFor } = await import('./store.js');

    const result = await ingestDocument({
      scope: 'default',
      docId: 'runbook-1',
      docTitle: 'Incident runbook',
      source: 'runbook.md',
      content: 'When the knowledge base looks empty, check the bucket lifecycle rules first.',
      format: 'markdown',
    });

    expect(result.chunks).toBeGreaterThan(0);

    // It landed in the DURABLE bucket, at the documented key.
    const key = keyFor('default', 'runbook-1');
    expect(key).toBe('index/default/runbook-1.jsonl');
    expect(objects.has(`${INDEX_BUCKET}/${key}`)).toBe(true);
    expect(objects.has(`${STAGING_BUCKET}/${key}`)).toBe(false);

    // And the real read path finds it.
    const docs = await listDocuments('default');
    expect(docs.map((d) => d.docId)).toContain('runbook-1');
  });

  it('proves the imported document cannot be expired', async () => {
    const { ingestDocument } = await import('./ingest.js');
    const { keyFor } = await import('./store.js');

    await ingestDocument({
      scope: 'default',
      docId: 'runbook-2',
      content: 'Durable knowledge must not share a bucket with a delete rule.',
      format: 'text',
    });

    const key = keyFor('default', 'runbook-2');
    const durable = bucketNamed('VectorsBucket');

    // The whole point of the fix, asserted against the key the real ingest
    // pipeline actually produced rather than one written by hand.
    expect(rulesThatWouldExpire(lifecycleRules(durable), key)).toEqual([]);

    // And a delete would still be recoverable.
    expect((durable.Properties as Record<string, unknown>).VersioningConfiguration).toEqual({
      Status: 'Enabled',
    });
  });

  it('proves the saved file expires, and takes nothing durable with it', async () => {
    const { uploadKeyFor, keyFor } = await import('./store.js');
    const staging = lifecycleRules(bucketNamed('VectorsStagingBucket'));

    // Uploads are scratch. They SHOULD expire — that rule has a real job.
    const uploadKey = uploadKeyFor('q3-board-pack.pdf', 'upload-2');
    expect(rulesThatWouldExpire(staging, uploadKey).length).toBeGreaterThan(0);

    // But the same rule must not reach an index key, even by accident.
    expect(rulesThatWouldExpire(staging, keyFor('default', 'runbook-3'))).toEqual([]);
  });

  it('keeps a scope with punctuation readable end to end', async () => {
    // The silent-loss path: written folded, listed raw, no error either way.
    const { ingestDocument } = await import('./ingest.js');
    const { listDocuments } = await import('./store.js');

    await ingestDocument({
      scope: 'tenant:acme corp',
      docId: 'contract-1',
      content: 'Acme master services agreement, renewal terms.',
      format: 'text',
    });

    const docs = await listDocuments('tenant:acme corp');
    expect(docs.map((d) => d.docId)).toContain('contract-1');
  });
});

describe('the incident itself, reproduced', () => {
  /**
   * If this block stops failing the pre-fix configuration, the matcher above
   * has gone blind and every assertion in this file is worthless.
   */
  it('shows the pre-fix configuration WOULD have deleted the knowledge index', () => {
    // Exactly what production carried, and still carries today: one rule,
    // 7-day expiry, empty prefix — verified live via
    // `aws s3api get-bucket-lifecycle-configuration`.
    const asDeployed: Rule[] = [{ ExpirationInDays: 7, Filter: { Prefix: '' } }];
    const indexKey = 'index/default/runbook-1.jsonl';

    expect(rulesThatWouldExpire(asDeployed, indexKey)).toHaveLength(1);
  });

  it('shows the fixed configuration would not have', () => {
    const scoped: Rule[] = [{ ExpirationInDays: 7, Filter: { Prefix: 'uploads/' } }];
    expect(rulesThatWouldExpire(scoped, 'index/default/runbook-1.jsonl')).toEqual([]);
  });
});
