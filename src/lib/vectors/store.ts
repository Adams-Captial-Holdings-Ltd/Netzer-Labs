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

const region = process.env.AWS_REGION ?? 'us-east-1';
const BUCKET = process.env.VECTORS_BUCKET ?? '';

let _s3: S3Client | null = null;
function s3(): S3Client {
  if (!_s3) _s3 = captureAwsClient(new S3Client({ region }));
  return _s3;
}

// ── Direct-to-S3 upload staging (bypasses the CloudFront WAF 8KB body cap) ──
// The dashboard PUTs a file straight to S3 via this presigned URL, then asks
// the backend to ingest from the key — so PDFs/large files never hit the WAF.
const UPLOAD_PREFIX = 'uploads/';

export async function presignUploadUrl(key: string): Promise<string> {
  if (!BUCKET) throw new Error('VECTORS_BUCKET env var not set');
  // No ContentType in the signature so the browser's auto Content-Type header
  // can't cause a signature mismatch; we only read the bytes back.
  const cmd = new PutObjectCommand({ Bucket: BUCKET, Key: key });
  // getSignedUrl resolves credentials from the ECS task role; on a Fargate
  // task that endpoint can blip mid credential-refresh, which surfaced as an
  // opaque "presign_failed" with no retry. One short retry turns a transient
  // credential hiccup into a non-event.
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await getSignedUrl(s3(), cmd, { expiresIn: 300 });
    } catch (err) {
      lastErr = err;
      logger.warn(
        { attempt, errMessage: err instanceof Error ? err.message : String(err) },
        'presign upload url failed; retrying',
      );
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** s3:// URI for a staging object, used to hand audio files to Transcribe. */
export function objectS3Uri(key: string): string {
  if (!BUCKET) throw new Error('VECTORS_BUCKET env var not set');
  return `s3://${BUCKET}/${key}`;
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
  if (!BUCKET) throw new Error('VECTORS_BUCKET env var not set');
  const out = await s3().send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  const bytes = await (out.Body as { transformToByteArray(): Promise<Uint8Array> }).transformToByteArray();
  return Buffer.from(bytes);
}

export async function deleteObject(key: string): Promise<void> {
  if (!BUCKET) return;
  try { await s3().send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key })); } catch { /* best effort */ }
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

export async function putDocument(
  scope: string,
  docId: string,
  rows: VectorRow[],
): Promise<void> {
  if (!BUCKET) throw new Error('VECTORS_BUCKET env var not set');
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
  await s3().send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: keyFor(scope, docId),
      Body: body,
      ContentType: 'application/jsonl',
      Metadata: {
        scope,
        'doc-id': docId,
        chunks: String(rows.length),
        'uploaded-at': new Date().toISOString(),
      },
    }),
  );
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
  if (!BUCKET) return false;
  try {
    await s3().send(
      new HeadObjectCommand({ Bucket: BUCKET, Key: keyFor(scope, docId) }),
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
  if (!BUCKET) throw new Error('VECTORS_BUCKET env var not set');
  await s3().send(
    new DeleteObjectCommand({
      Bucket: BUCKET,
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
  if (!BUCKET) return [];
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

export async function* iterateRows(
  scope: string,
): AsyncIterableIterator<VectorRow> {
  if (!BUCKET) return;
  let continuationToken: string | undefined;
  do {
    const list = await s3().send(
      new ListObjectsV2Command({
        Bucket: BUCKET,
        Prefix: `index/${scope}/`,
        ContinuationToken: continuationToken,
      }),
    );
    for (const obj of list.Contents ?? []) {
      if (!obj.Key) continue;
      const resp = await s3().send(
        new GetObjectCommand({ Bucket: BUCKET, Key: obj.Key }),
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

function keyFor(scope: string, docId: string): string {
  const safeScope = scope.replace(/[^A-Za-z0-9_-]/g, '_');
  const safeDoc = docId.replace(/[^A-Za-z0-9._-]/g, '_');
  return `index/${safeScope}/${safeDoc}.jsonl`;
}
