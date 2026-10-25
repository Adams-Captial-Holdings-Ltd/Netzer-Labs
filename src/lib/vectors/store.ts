/**
 * S3-backed vector store.
 *
 * Layout: each ingested document becomes one JSONL object in the
 * vectors-staging bucket under `index/<scope>/<docId>.jsonl`. Each line
 * is `{ chunkId, text, embedding, metadata }`. Scopes provide cheap
 * per-tenant or per-corpus partitioning ("default", "agent:ops", etc).
 *
 * At query time we list objects in the scope, stream them, and compute
 * cosine similarity against the query embedding in memory. This is
 * O(N) but trivial up to ~100k chunks; swap to FAISS / OpenSearch when
 * corpora grow.
 */

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { logger } from '../../observability/logger.js';
import { cosineSimilarity } from './embedder.js';
import { captureAwsClient } from '../observability/xray.js';
import { normalizeScope } from './scope-access.js';

const region = process.env.AWS_REGION ?? 'us-east-1';
// Two DIFFERENT buckets, on purpose. `VECTORS_BUCKET` is the durable index and
// nothing may expire from it; `VECTORS_STAGING_BUCKET` is disposable scratch for
// browser uploads and carries a 7-day expiry. They pointed at the same bucket
// until 2026-08, and the staging expiry deleted the entire knowledge base.
const INDEX_BUCKET = process.env.VECTORS_BUCKET ?? '';
// Falls back to the index bucket only so a partial rollout degrades to "uploads
// land somewhere writable" rather than hard-failing; uploads are deleted once
// indexed either way.
const STAGING_BUCKET = process.env.VECTORS_STAGING_BUCKET ?? INDEX_BUCKET;

let _s3: S3Client | null = null;
function s3(): S3Client {
  if (!_s3) {
    // Avoid signing an empty-body checksum that does not match real uploads.
    _s3 = captureAwsClient(new S3Client({ region, requestChecksumCalculation: 'WHEN_REQUIRED' }));
  }
  return _s3;
}

// ── Direct-to-S3 upload staging (bypasses the CloudFront WAF 8KB body cap) ──
// The dashboard PUTs a file straight to S3 via this presigned URL, then asks
// the backend to ingest from the key — so PDFs/large files never hit the WAF.
/** Upload-staging prefix. `infra/lib/storage-stack.ts` scopes its expiry
 * rule to this exact value; the storage-stack test asserts they match. */
export const UPLOAD_PREFIX = 'uploads/';

async function presignWithRetry(
  command: PutObjectCommand,
  options: NonNullable<Parameters<typeof getSignedUrl>[2]>,
  logMessage: string,
): Promise<string> {
  // getSignedUrl resolves credentials from the ECS task role; on a Fargate
  // task that endpoint can blip mid credential-refresh, which surfaced as an
  // opaque "presign_failed" with no retry. One short retry turns a transient
  // credential hiccup into a non-event.
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await getSignedUrl(s3(), command, options);
    } catch (err) {
      lastErr = err;
      logger.warn(
        { attempt, errMessage: err instanceof Error ? err.message : String(err) },
        logMessage,
      );
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export async function presignUploadUrl(key: string): Promise<string> {
  if (!STAGING_BUCKET) throw new Error('VECTORS_STAGING_BUCKET env var not set');
  // No ContentType in the signature so the browser's auto Content-Type header
  // can't cause a signature mismatch; we only read the bytes back.
  const cmd = new PutObjectCommand({ Bucket: STAGING_BUCKET, Key: key });
  return presignWithRetry(cmd, { expiresIn: 300 }, 'presign upload url failed; retrying');
}

/** Chat uploads bind the declared type and size to the direct S3 PUT. */
export async function presignChatUploadUrl(key: string, mime: string, size: number): Promise<string> {
  if (!STAGING_BUCKET) throw new Error('VECTORS_STAGING_BUCKET env var not set');
  const cmd = new PutObjectCommand({ Bucket: STAGING_BUCKET, Key: key, ContentType: mime, ContentLength: size });
  return presignWithRetry(cmd, {
    expiresIn: 300,
    signableHeaders: new Set(['content-type', 'content-length']),
  }, 'presign chat upload url failed; retrying');
}

/** Read only the staged object's metadata before a chat turn begins. */
export async function headChatUpload(key: string): Promise<{ size: number; type: string } | null> {
  if (!STAGING_BUCKET) throw new Error('VECTORS_STAGING_BUCKET env var not set');
  try {
    const out = await s3().send(new HeadObjectCommand({ Bucket: STAGING_BUCKET, Key: key }));
    return { size: out.ContentLength ?? 0, type: out.ContentType ?? '' };
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
    if (name === 'NotFound' || name === 'NoSuchKey' || name === '404' || status === 404) return null;
    throw err;
  }
}

/** s3:// URI for a staging object, used to hand audio files to Transcribe. */
export function objectS3Uri(key: string): string {
  if (!STAGING_BUCKET) throw new Error('VECTORS_STAGING_BUCKET env var not set');
  return `s3://${STAGING_BUCKET}/${key}`;
}

/** Make a sanitized, namespaced staging key for a browser upload. */
export function uploadKeyFor(filename: string, id: string): string {
  const safe = (filename || 'upload').replace(/[^A-Za-z0-9._-]/g, '_').slice(-120);
  return `${UPLOAD_PREFIX}${id}/${safe}`;
}

/** Guard: only allow ingest-from-S3 of keys under the upload-staging prefix. */
export function isUploadKey(key: string): boolean {
  return typeof key === 'string' && key.startsWith(UPLOAD_PREFIX) && !key.includes('..');
}

export async function getObjectBuffer(key: string): Promise<Buffer> {
  if (!STAGING_BUCKET) throw new Error('VECTORS_STAGING_BUCKET env var not set');
  const out = await s3().send(new GetObjectCommand({ Bucket: STAGING_BUCKET, Key: key }));
  const bytes = await (out.Body as { transformToByteArray(): Promise<Uint8Array> }).transformToByteArray();
  return Buffer.from(bytes);
}

export async function deleteObject(key: string): Promise<void> {
  if (!STAGING_BUCKET) return;
  try { await s3().send(new DeleteObjectCommand({ Bucket: STAGING_BUCKET, Key: key })); } catch { /* best effort */ }
}

export interface VectorRow {
  chunkId: string;
  text: string;
  embedding: number[];
  metadata: VectorMetadata;
}

export interface VectorMetadata {
  docId: string;
  docTitle?: string;
  source?: string;
  scope: string;
  chunkIndex: number;
  start: number;
  end: number;
  /** 1-based source page number, when the format carries pages (PDF). */
  page?: number;
  uploadedAt: string;
  /** Free-form tags for filtering at retrieval time. */
  tags?: string[];
}

export interface QueryHit {
  score: number;
  row: VectorRow;
}

/**
 * Per-document rollup for the dashboard vectors list. Aggregated from the
 * chunk-level rows: one entry per docId with its title/source (taken from
 * the first chunk seen), chunk count, and earliest uploadedAt timestamp.
 */
export interface Doc {
  docId: string;
  title?: string;
  source?: string;
  chunkCount: number;
  createdAt: string;
}

/**
 * `ifMatch` makes the write a compare-and-swap: an ETag from `readDocument`
 * must still match, `null` means the doc must not exist yet. Returns false
 * when another writer got there first; omit it for a plain overwrite.
 */
export async function putDocument(
  scope: string,
  docId: string,
  rows: VectorRow[],
  ifMatch?: string | null,
): Promise<boolean> {
  if (!INDEX_BUCKET) throw new Error('VECTORS_BUCKET env var not set');
  // Tag every chunk with the document's scope so retrieval-time scope
  // filtering and the per-doc rollup stay consistent even if a caller built
  // the rows without stamping metadata.scope. The scope argument is the
  // source of truth here (it also drives the S3 key partition below).
  const tagged = rows.map((r) =>
    r.metadata.scope === scope
      ? r
      : { ...r, metadata: { ...r.metadata, scope } },
  );
  const body = tagged.map((r) => JSON.stringify(r)).join('\n');
  try {
    await s3().send(
      new PutObjectCommand({
        Bucket: INDEX_BUCKET,
        Key: keyFor(scope, docId),
        Body: body,
        ContentType: 'application/jsonl',
        Metadata: {
          scope,
          'doc-id': docId,
          chunks: String(rows.length),
          'uploaded-at': new Date().toISOString(),
        },
        ...(ifMatch === null ? { IfNoneMatch: '*' } : ifMatch ? { IfMatch: ifMatch } : {}),
      }),
    );
  } catch (err) {
    // 412: the ETag moved; 409: a concurrent conditional write to the same key.
    const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
    if (ifMatch !== undefined && (status === 412 || status === 409)) return false;
    throw err;
  }
  return true;
}

/**
 * Cheap existence probe used by chat-upload dedup: same file re-sent (on any
 * surface) maps to the same content-hash docId, so a HeadObject hit means we
 * can skip extraction + embedding entirely. Fails open (false) on non-404
 * errors so a transient S3 blip re-ingests rather than silently skipping.
 */
export async function documentExists(
  scope: string,
  docId: string,
): Promise<boolean> {
  if (!INDEX_BUCKET) return false;
  try {
    await s3().send(
      new HeadObjectCommand({ Bucket: INDEX_BUCKET, Key: keyFor(scope, docId) }),
    );
    return true;
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    if (name !== 'NotFound' && name !== 'NoSuchKey' && name !== '404') {
      logger.warn(
        { scope, docId, errMessage: err instanceof Error ? err.message : String(err) },
        'documentExists probe failed; treating as missing',
      );
    }
    return false;
  }
}

export async function deleteDocument(
  scope: string,
  docId: string,
): Promise<void> {
  if (!INDEX_BUCKET) throw new Error('VECTORS_BUCKET env var not set');
  await s3().send(
    new DeleteObjectCommand({
      Bucket: INDEX_BUCKET,
      Key: keyFor(scope, docId),
    }),
  );
}

/**
 * Aggregate the chunk-level rows in a scope into one Doc per docId. We
 * stream every row (via iterateRows) and group by metadata.docId: count
 * chunks, take title/source from the first chunk seen, and keep the
 * earliest uploadedAt as createdAt. Returns the docs sorted newest-first
 * so the dashboard list shows recent uploads on top.
 */
export async function listDocuments(scope: string): Promise<Doc[]> {
  if (!INDEX_BUCKET) return [];
  const byDoc = new Map<string, Doc>();
  for await (const row of iterateRows(scope)) {
    const meta = row.metadata;
    const docId = meta?.docId;
    if (!docId) continue;
    const existing = byDoc.get(docId);
    if (!existing) {
      byDoc.set(docId, {
        docId,
        ...(meta.docTitle ? { title: meta.docTitle } : {}),
        ...(meta.source ? { source: meta.source } : {}),
        chunkCount: 1,
        createdAt: meta.uploadedAt ?? '',
      });
      continue;
    }
    existing.chunkCount += 1;
    // Keep the earliest uploadedAt as the document's createdAt.
    if (meta.uploadedAt && (!existing.createdAt || meta.uploadedAt < existing.createdAt)) {
      existing.createdAt = meta.uploadedAt;
    }
    // Backfill title/source if the first chunk happened to lack them.
    if (!existing.title && meta.docTitle) existing.title = meta.docTitle;
    if (!existing.source && meta.source) existing.source = meta.source;
  }
  return Array.from(byDoc.values()).sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );
}

/** NZR-6: every scope that has an `index/<scope>/` prefix (normalized names). */
export async function listScopePrefixes(): Promise<string[]> {
  // Throw, not []: an empty list would let the quarantine --verify pass unread.
  if (!INDEX_BUCKET) throw new Error('VECTORS_BUCKET env var not set');
  const scopes: string[] = [];
  let continuationToken: string | undefined;
  do {
    const list = await s3().send(
      new ListObjectsV2Command({ Bucket: INDEX_BUCKET, Prefix: 'index/', Delimiter: '/', ContinuationToken: continuationToken }),
    );
    for (const p of list.CommonPrefixes ?? []) {
      const name = p.Prefix?.slice('index/'.length, -1);
      if (name) scopes.push(name);
    }
    continuationToken = list.IsTruncated ? list.NextContinuationToken : undefined;
  } while (continuationToken);
  return scopes;
}

/** NZR-6: one document's rows, or [] when it does not exist. */
export async function readDocumentRows(scope: string, docId: string): Promise<VectorRow[]> {
  return (await readDocument(scope, docId)).rows;
}

/**
 * NZR-6: exclusive claim on a doc (create-only empty object under `claims/`,
 * outside `index/` so listings never see it). False when someone else holds it.
 */
export async function claimDocument(scope: string, docId: string): Promise<boolean> {
  if (!INDEX_BUCKET) throw new Error('VECTORS_BUCKET env var not set');
  try {
    await s3().send(new PutObjectCommand({ Bucket: INDEX_BUCKET, Key: claimKeyFor(scope, docId), Body: '', IfNoneMatch: '*' }));
  } catch (err) {
    const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
    if (status === 412 || status === 409) return false;
    throw err;
  }
  return true;
}

export async function releaseDocumentClaim(scope: string, docId: string): Promise<void> {
  if (!INDEX_BUCKET) throw new Error('VECTORS_BUCKET env var not set');
  await s3().send(new DeleteObjectCommand({ Bucket: INDEX_BUCKET, Key: claimKeyFor(scope, docId) }));
}

/** NZR-6: rows plus the ETag to pass to `putDocument` (null when absent). */
export async function readDocument(scope: string, docId: string): Promise<{ rows: VectorRow[]; etag: string | null }> {
  if (!INDEX_BUCKET) return { rows: [], etag: null };
  let body: string | undefined;
  let etag: string | null = null;
  try {
    const resp = await s3().send(new GetObjectCommand({ Bucket: INDEX_BUCKET, Key: keyFor(scope, docId) }));
    body = await resp.Body?.transformToString();
    etag = resp.ETag ?? null;
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    if (name === 'NoSuchKey' || name === 'NotFound') return { rows: [], etag: null };
    throw err;
  }
  return { rows: (body ?? '').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as VectorRow), etag };
}

export async function* iterateRows(
  scope: string,
): AsyncIterableIterator<VectorRow> {
  if (!INDEX_BUCKET) return;
  let continuationToken: string | undefined;
  do {
    const list = await s3().send(
      new ListObjectsV2Command({
        Bucket: INDEX_BUCKET,
        // indexPrefixFor, never a hand-built template: the write path derives
        // its key from the same function, so the two cannot drift apart.
        Prefix: indexPrefixFor(scope),
        ContinuationToken: continuationToken,
      }),
    );
    for (const obj of list.Contents ?? []) {
      if (!obj.Key) continue;
      const resp = await s3().send(
        new GetObjectCommand({ Bucket: INDEX_BUCKET, Key: obj.Key }),
      );
      const body = await resp.Body?.transformToString();
      if (!body) continue;
      for (const line of body.split('\n')) {
        if (!line.trim()) continue;
        try {
          yield JSON.parse(line) as VectorRow;
        } catch (err) {
          logger.warn(
            {
              key: obj.Key,
              errMessage: err instanceof Error ? err.message : String(err),
            },
            'vector row parse failed; skipping',
          );
        }
      }
    }
    continuationToken = list.IsTruncated ? list.NextContinuationToken : undefined;
  } while (continuationToken);
}

export async function search(args: {
  scope: string;
  queryEmbedding: number[];
  topK?: number;
  tagFilter?: string[];
  scoreFloor?: number;
}): Promise<QueryHit[]> {
  const topK = Math.max(1, Math.min(50, args.topK ?? 5));
  const heap: QueryHit[] = [];
  const floor = args.scoreFloor ?? 0;
  for await (const row of iterateRows(args.scope)) {
    if (args.tagFilter && args.tagFilter.length > 0) {
      const tags = row.metadata.tags ?? [];
      if (!args.tagFilter.some((t) => tags.includes(t))) continue;
    }
    const score = cosineSimilarity(args.queryEmbedding, row.embedding);
    if (score < floor) continue;
    if (heap.length < topK) {
      heap.push({ score, row });
      heap.sort((a, b) => a.score - b.score);
    } else if (heap[0].score < score) {
      heap[0] = { score, row };
      heap.sort((a, b) => a.score - b.score);
    }
  }
  return heap.sort((a, b) => b.score - a.score);
}

// Canonical on-disk scope form; defined beside the scope access rule (NZR-5).
export { normalizeScope };

/**
 * The single place an `index/` prefix is constructed.
 *
 * Both the read path (`iterateRows`) and the write path (`keyFor`) derive from
 * this. That is the point: the 2026-08 silent-loss bug was two hand-built
 * templates drifting apart, and a guard that only checked `normalizeScope` in
 * isolation stayed green while they did. One construction site makes the
 * divergence unrepresentable rather than merely detectable.
 */
export function indexPrefixFor(scope: string): string {
  return `index/${normalizeScope(scope)}/`;
}

export function keyFor(scope: string, docId: string): string {
  const safeDoc = docId.replace(/[^A-Za-z0-9._-]/g, '_');
  return `${indexPrefixFor(scope)}${safeDoc}.jsonl`;
}

/** NZR-6: reassign claims, kept out of `index/` so no doc id can collide with one. */
function claimKeyFor(scope: string, docId: string): string {
  return `claims/${keyFor(scope, docId).slice('index/'.length)}`;
}
