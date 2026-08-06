/**
 * Per-phase deploy journal + manifest promotion (IaC readiness plan, item 14).
 *
 * Deploy keeps a per-phase state journal in the state bucket as IMMUTABLE
 * per-deploy event objects, never appended-in-place: one object is written
 * after every mutating step (ECR digest pushed, each secret version written,
 * seed revision, per-stack phase status). An interrupt mid-deploy therefore
 * leaves a precise resume/rollback record rather than orphaned half-state.
 * Immutability is enforced with S3 conditional writes (IfNoneMatch '*'), so
 * a duplicate sequence number fails loudly instead of rewriting history.
 *
 * On success the manifest is promoted: written to its per-deploy key, then
 * copied to manifests/latest.json, in that order, both under the held lock
 * and stamped with the fencing token so a stale holder cannot interleave a
 * mixed manifest.
 */

import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { DEPLOY_ID_RE } from './ids.js';
import {
  type DeployManifest,
  parseManifest,
  serializeManifest,
} from './manifest.js';
import type { AwsClientLike } from './lock.js';

/** Key of the manifest pointer that always names the live deploy. */
export const LATEST_MANIFEST_KEY = 'manifests/latest.json';

export interface JournalEntry {
  deployId: string;
  /** Monotonic per deploy; the padded seq keeps S3 listings in order. */
  seq: number;
  event: string;
  /** ISO timestamp of the step. */
  at: string;
  /** Fencing token of the held lock; stamps every journal/manifest write. */
  fencingToken: number;
  data?: Record<string, unknown>;
}

const EVENT_RE = /^[a-z0-9][a-z0-9-]*$/i;

/** Per-deploy key of the promoted manifest. */
export function manifestKey(deployId: string): string {
  return `deploys/${deployId}/manifest.json`;
}

/** deploys/<deployId>/journal/<seq padded 4>-<event>.json */
export function journalEventKey(deployId: string, seq: number, event: string): string {
  if (!DEPLOY_ID_RE.test(deployId)) {
    throw new Error(`journalEventKey: "${deployId}" is not a valid deploy id`);
  }
  if (!Number.isInteger(seq) || seq < 0) {
    throw new Error(`journalEventKey: seq must be a non-negative integer, got ${seq}`);
  }
  if (!EVENT_RE.test(event)) {
    throw new Error(
      `journalEventKey: event "${event}" must be alphanumeric/hyphen (it becomes an S3 key segment)`,
    );
  }
  return `deploys/${deployId}/journal/${String(seq).padStart(4, '0')}-${event}.json`;
}

function isPreconditionFailed(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } } | null;
  return e?.name === 'PreconditionFailed' || e?.$metadata?.httpStatusCode === 412;
}

/** Read an SDK v3 GetObject body into a string, tolerating fake clients. */
export async function s3BodyToString(body: unknown): Promise<string> {
  if (typeof body === 'string') return body;
  const b = body as { transformToString?: () => Promise<string> } | null;
  if (b && typeof b.transformToString === 'function') return b.transformToString();
  throw new Error('unsupported S3 body shape: expected a string or transformToString()');
}

/**
 * Append one immutable journal event. PutObject with IfNoneMatch '*' so an
 * existing object is never overwritten; a duplicate (deployId, seq, event)
 * is a bug in the caller and fails loudly.
 */
export async function appendJournal(
  s3: AwsClientLike,
  bucket: string,
  entry: JournalEntry,
): Promise<string> {
  const key = journalEventKey(entry.deployId, entry.seq, entry.event);
  try {
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: JSON.stringify(entry, null, 2) + '\n',
        ContentType: 'application/json',
        // Immutability: never overwrite an existing journal object.
        IfNoneMatch: '*',
      }),
    );
  } catch (err) {
    if (isPreconditionFailed(err)) {
      throw new Error(
        `journal entry already exists at s3://${bucket}/${key}; journal objects are immutable ` +
          '(never appended-in-place). A duplicate seq means two writers or a non-resumed retry.',
      );
    }
    throw err;
  }
  return key;
}

/**
 * Promote a completed deploy's manifest: write the per-deploy manifest, then
 * the latest pointer, in that order. Both writes carry the fencing token in
 * object metadata; promotion happens only under the held lock.
 */
export async function promoteManifest(
  s3: AwsClientLike,
  bucket: string,
  manifest: DeployManifest,
  fencingToken: number,
): Promise<void> {
  const body = serializeManifest(manifest);
  const metadata = { 'fencing-token': String(fencingToken) };
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: manifestKey(manifest.deployId),
      Body: body,
      ContentType: 'application/json',
      Metadata: metadata,
    }),
  );
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: LATEST_MANIFEST_KEY,
      Body: body,
      ContentType: 'application/json',
      Metadata: metadata,
    }),
  );
}

/**
 * Read the live deploy's manifest, or null when no deploy has ever been
 * promoted (fresh state bucket). Any other failure propagates: deploy and
 * rollback refuse to run when the state store is unavailable.
 */
export async function readLatestManifest(
  s3: AwsClientLike,
  bucket: string,
): Promise<DeployManifest | null> {
  let res: { Body?: unknown };
  try {
    res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: LATEST_MANIFEST_KEY }));
  } catch (err) {
    const e = err as { name?: string; $metadata?: { httpStatusCode?: number } } | null;
    if (e?.name === 'NoSuchKey' || e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404) {
      return null;
    }
    throw err;
  }
  const json = await s3BodyToString(res.Body);
  return parseManifest(json);
}
