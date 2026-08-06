/**
 * White-label branding asset store (company logos + favicons).
 *
 * Why this exists: a theme's logo/icon used to be a URL the admin pasted. This
 * module backs an upload path so the admin can pick a file instead. The trick is
 * persistence + the two infra constraints around it:
 *
 *   1. The dashboard saves themes through POST /config/themes/library, which goes
 *      through the CloudFront WAF that blocks request bodies over 8KB — so a logo
 *      can NOT be inlined as a data: URI in the theme JSON. It must be stored by
 *      reference (a short URL).
 *   2. A browser PUT straight to S3 needs a bucket CORS rule. Only the
 *      vectors-staging bucket carries one (reused from the Knowledge upload path);
 *      the curated bucket does not. But the staging bucket EXPIRES objects after 7
 *      days, which would silently delete a logo.
 *
 * So the flow is: the browser PUTs the file to the CORS-enabled staging bucket
 * (presignUploadUrl, same as Knowledge), then the backend COPIES it server-side
 * into the curated bucket under `branding/<assetId>`. The curated bucket RETAINS
 * objects (no expiry, only intelligent-tiering) and the task role already holds
 * full read/write + KMS on it, so the logo persists indefinitely with no infra
 * change. It is then served back by the PUBLIC GET /api/branding/asset/:id route,
 * and that URL is what the theme stores.
 */
import { CopyObjectCommand, GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { logger } from '../../observability/logger.js';
import { captureAwsClient } from '../observability/xray.js';

const region = process.env.AWS_REGION ?? 'us-east-1';
// Persistent home for branding assets. Empty fallback so a misconfig surfaces as
// a clear "bucket not set" error instead of a cryptic SDK failure.
const CURATED_BUCKET = process.env.CURATED_BUCKET ?? '';
// CORS-enabled bucket the browser PUTs to (the one Knowledge uploads already use).
const STAGING_BUCKET = process.env.VECTORS_BUCKET ?? '';
const PREFIX = 'branding/';

let _s3: S3Client | null = null;
function s3(): S3Client {
  if (!_s3) _s3 = captureAwsClient(new S3Client({ region }));
  return _s3;
}

// Allowed image extensions -> MIME. Restricting to a known set means the public
// serving endpoint can never be coerced into serving an arbitrary content type,
// and the upload endpoint rejects non-images up front.
const EXT_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
};

/** The MIME for an image extension, or undefined if it is not an allowed type. */
export function brandingMimeForExt(ext: string): string | undefined {
  return EXT_MIME[ext.toLowerCase()];
}

/** Map an upload filename to a safe lowercased image extension, or null. */
export function brandingExtFromFilename(filename: string): string | null {
  const m = /\.([A-Za-z0-9]+)$/.exec((filename ?? '').trim());
  if (!m) return null;
  const ext = m[1].toLowerCase();
  return EXT_MIME[ext] ? ext : null;
}

// An asset id is the object's leaf name under branding/: "<uuid>.<ext>". Strictly
// validated (no slashes, no dot-dot) so a serving request can never traverse out
// of the branding/ prefix into another object.
const ASSET_ID_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9]+$/;
export function isBrandingAssetId(id: string): boolean {
  return typeof id === 'string' && id.length <= 80 && ASSET_ID_RE.test(id) && !id.includes('..');
}

function extOf(id: string): string {
  const dot = id.lastIndexOf('.');
  return dot >= 0 ? id.slice(dot + 1).toLowerCase() : '';
}

function curatedKey(id: string): string {
  return `${PREFIX}${id}`;
}

/**
 * Promote a freshly-staged upload into the curated bucket under branding/<id>,
 * where it persists. `stagingKey` must be an upload-staging key (the caller
 * validates it with isUploadKey) so this can only ever promote a real browser
 * upload, never an arbitrary object. CopyObject is server-side, so it needs no
 * bucket CORS and re-encrypts with the curated bucket's own CMK.
 */
export async function commitBrandingAsset(stagingKey: string, assetId: string): Promise<void> {
  if (!CURATED_BUCKET) throw new Error('CURATED_BUCKET env var not set');
  if (!STAGING_BUCKET) throw new Error('VECTORS_BUCKET env var not set');
  // CopySource is "<bucket>/<key>"; encode each path segment but keep the slashes.
  const copySource = `${STAGING_BUCKET}/${stagingKey.split('/').map(encodeURIComponent).join('/')}`;
  await s3().send(
    new CopyObjectCommand({
      Bucket: CURATED_BUCKET,
      Key: curatedKey(assetId),
      CopySource: copySource,
    }),
  );
}

/**
 * Read a branding object from the curated bucket. Returns null (not throws) when
 * the key does not exist so the route can answer 404. The content type is derived
 * from the asset id's extension, never from what the browser happened to PUT.
 */
export async function getBrandingObject(
  id: string,
): Promise<{ body: Uint8Array; contentType: string } | null> {
  if (!CURATED_BUCKET) throw new Error('CURATED_BUCKET env var not set');
  try {
    const out = await s3().send(new GetObjectCommand({ Bucket: CURATED_BUCKET, Key: curatedKey(id) }));
    const bytes = await (out.Body as { transformToByteArray(): Promise<Uint8Array> }).transformToByteArray();
    const contentType = brandingMimeForExt(extOf(id)) ?? out.ContentType ?? 'application/octet-stream';
    return { body: bytes, contentType };
  } catch (err) {
    const name =
      err && typeof err === 'object' && 'name' in err ? (err as { name?: string }).name : undefined;
    if (name === 'NoSuchKey' || name === 'NotFound') return null;
    logger.warn(
      { errMessage: err instanceof Error ? err.message : String(err), id },
      'branding object read failed',
    );
    throw err;
  }
}
