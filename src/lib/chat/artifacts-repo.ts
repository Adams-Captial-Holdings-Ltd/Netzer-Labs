/** Durable, owner-scoped storage for generated conversation artifacts. */
import { randomUUID } from 'node:crypto';
import {
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  ListObjectVersionsCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { DeleteCommand, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../state/ddb.js';
import { acquireConversationChildLock, appendTurns, getSession } from '../state/sessions-repo.js';
import { scanForExfil } from '../safety/exfil-guard.js';
import { captureAwsClient } from '../observability/xray.js';

const TABLE = process.env.TABLE_SESSIONS ?? 'claudeclaw-sessions';
const BUCKET = process.env.CURATED_BUCKET ?? '';
const MAX_BODY_BYTES = 30 * 1024 * 1024;
const REGION = process.env.AWS_REGION ?? 'us-east-1';
const MIME_TYPES = new Set([
  'text/plain', 'text/markdown', 'text/csv', 'text/html', 'text/xml',
  'application/json', 'application/pdf', 'application/rtf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/vnd.mermaid',
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml',
]);

export interface ArtifactDescriptor {
  artifactId: string;
  version: number;
  fileName: string;
  contentType: string;
  createdAt: string;
}

export interface SaveArtifactArgs {
  agentId: string;
  chatId: string;
  ownerId: string;
  fileName: string;
  contentType: string;
  body: Uint8Array;
  source: unknown;
  artifactId?: string;
  expectedVersion?: number;
}

type ArtifactScope = { agentId: string; chatId: string; ownerId: string };
type ArtifactVersionScope = ArtifactScope & { artifactId: string; version: number };
type HeadRow = ArtifactDescriptor & { PK: string; SK: string; agentId: string; chatId: string; ownerId: string };
type VersionRow = ArtifactDescriptor & {
  PK: string; SK: string; agentId: string; chatId: string; ownerId: string;
  storageKey: string; physicalVersionId: string; source: unknown;
};

let _s3: S3Client | undefined;
function s3(): S3Client {
  if (!_s3) {
    const endpoint = process.env.AWS_ENDPOINT_URL;
    _s3 = captureAwsClient(new S3Client({
      region: REGION,
      ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
      requestChecksumCalculation: 'WHEN_REQUIRED',
    }));
  }
  return _s3;
}

function pk(agentId: string): string { return `AGENT#${agentId}`; }
// DynamoDB has already made `#` and `_` aliases the same physical chat id.
// Keep CURATED under that exact same identity so deletion by the listed id
// cannot leave an object behind under a different encoding.
function mappedChatId(chatId: string): string { return chatId.replace(/#/g, '_'); }
function chatPrefix(chatId: string): string { return `CHAT#${mappedChatId(chatId)}#ARTIFACT#`; }
// S3 path components use base64url, whose alphabet and padding rules make this
// encoding injective while keeping caller-controlled separators out of keys.
function pathPart(value: string): string { return Buffer.from(value, 'utf8').toString('base64url'); }
function objectKey(agentId: string, chatId: string, artifactId: string, version: number): string {
  return `artifacts/${pathPart(agentId)}/${pathPart(mappedChatId(chatId))}/${pathPart(artifactId)}/v${version}`;
}
/** Exact, terminal-slash scope for deleting one conversation's CURATED objects. */
export function artifactConversationPrefix(agentId: string, chatId: string): string {
  return `artifacts/${pathPart(agentId)}/${pathPart(mappedChatId(chatId))}/`;
}
function childBase(chatId: string, artifactId: string): string {
  return `${chatPrefix(chatId)}${artifactId}#`;
}
function pendingSk(chatId: string, operationId: string): string {
  return `${chatPrefix(chatId)}PENDING#${operationId}`;
}
function headSk(chatId: string, artifactId: string): string { return `${childBase(chatId, artifactId)}HEAD`; }
function versionSk(chatId: string, artifactId: string, version: number): string {
  return `${childBase(chatId, artifactId)}VERSION#${String(version).padStart(10, '0')}`;
}

async function assertOwner({ agentId, chatId, ownerId }: ArtifactScope): Promise<void> {
  if (!agentId || !chatId.startsWith('dashboard:') || !ownerId?.startsWith('dashboard:user:')) {
    throw new Error('Artifact access requires a stable dashboard conversation owner');
  }
  const session = await getSession(agentId, chatId);
  if (!session || session.surface !== 'dashboard' || session.userId !== ownerId || session.ttl !== undefined) {
    throw new Error('Artifact conversation is missing, ephemeral, or owned by another user');
  }
}

function assertFile(args: SaveArtifactArgs): Buffer {
  if (typeof args.fileName !== 'string' || args.fileName.length < 1 || args.fileName.length > 255 ||
      args.fileName === '.' || args.fileName === '..' || /[/\\\u0000-\u001f\u007f]/.test(args.fileName)) {
    throw new Error('Artifact file name is unsafe or too long');
  }
  if (!MIME_TYPES.has(args.contentType)) throw new Error('Artifact content type is not allowed');
  if (!(args.body instanceof Uint8Array)) throw new Error('Artifact body must be bytes');
  if (args.body.byteLength > MAX_BODY_BYTES) throw new Error('Artifact body exceeds the 30 MiB size limit');
  return Buffer.from(args.body);
}

async function checkSafety(fileName: string, body: Buffer, source: unknown): Promise<void> {
  let sourceJson: string;
  try {
    sourceJson = JSON.stringify(source);
    if (sourceJson === undefined) throw new Error('source is not JSON serializable');
  } catch {
    throw new Error('Artifact safety scan could not serialize its source');
  }
  const text = body.toString('utf8');
  for (const candidate of [text, fileName, sourceJson]) {
    let result;
    try {
      result = await scanForExfil(candidate);
    } catch {
      throw new Error('Artifact safety scan is unavailable');
    }
    if (!result || result.truncated || result.blocked || !(result.scannedBytes >= candidate.length) ||
        result.matches?.some((m) => m.severity === 'block')) {
      throw new Error('Artifact refused by the required safety scan');
    }
  }
}

async function queryAll(agentId: string, prefix: string): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  let cursor: Record<string, unknown> | undefined;
  do {
    const page = await ddb().send(new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: { ':pk': pk(agentId), ':prefix': prefix },
      ConsistentRead: true,
      ...(cursor ? { ExclusiveStartKey: cursor } : {}),
    }));
    items.push(...((page.Items ?? []) as Record<string, unknown>[]));
    cursor = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (cursor);
  return items;
}

function descriptor(row: Record<string, unknown>): ArtifactDescriptor {
  return {
    artifactId: String(row.artifactId),
    version: Number(row.version),
    fileName: String(row.fileName),
    contentType: String(row.contentType),
    createdAt: String(row.createdAt),
  };
}

async function readHead(args: ArtifactScope & { artifactId: string }): Promise<HeadRow | undefined> {
  const { Item } = await ddb().send(new GetCommand({
    TableName: TABLE,
    Key: { PK: pk(args.agentId), SK: headSk(args.chatId, args.artifactId) },
    ConsistentRead: true,
  }));
  return Item as HeadRow | undefined;
}

export async function saveArtifact(args: SaveArtifactArgs): Promise<ArtifactDescriptor> {
  const body = assertFile(args);
  if (args.artifactId && (!Number.isInteger(args.expectedVersion) || args.expectedVersion! < 1)) {
    throw new Error('A revision requires its expected current version');
  }
  if (!BUCKET) throw new Error('CURATED_BUCKET is not configured');
  await checkSafety(args.fileName, body, args.source);

  const artifactId = args.artifactId ?? randomUUID();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(artifactId)) {
    throw new Error('Artifact id is invalid');
  }
  const releaseLock = await acquireConversationChildLock(args.agentId, args.chatId);
  try {
  // The parent can be deleted while content is being scanned, so ownership is
  // checked only after acquiring the same lock used by deleteSession.
  const session = await getSession(args.agentId, args.chatId);
  const draftSource = args.source && typeof args.source === 'object' &&
    (args.source as { kind?: unknown }).kind === 'draft'
    ? args.source as { kind: 'draft'; draftId?: unknown; revision?: unknown }
    : undefined;
  if (!session) {
    if (draftSource) throw new Error('Draft conversation is missing; a finalizing draft cannot recreate it');
    // A first-turn artifact can be saved before the final transcript append.
    // Only a stable dashboard person may settle a missing parent; never turn a
    // bot, token-only principal, or a non-dashboard chat into durable history.
    if (!args.chatId.startsWith('dashboard:') || !args.ownerId?.startsWith('dashboard:user:')) {
      throw new Error('Artifact access requires a stable dashboard conversation owner');
    }
    try {
      await appendTurns(args.agentId, args.chatId, [], undefined, {
        surface: 'dashboard', userId: args.ownerId, ephemeral: false,
      });
    } catch {
      throw new Error('Artifact conversation owner could not be initialized');
    }
  }
  await assertOwner(args);
  if (draftSource) {
    if (typeof draftSource.draftId !== 'string' || !Number.isInteger(draftSource.revision) ||
        (draftSource.revision as number) < 0) {
      throw new Error('Draft metadata is invalid for artifact finalization');
    }
    const draftId = draftSource.draftId;
    const { Item } = await ddb().send(new GetCommand({
      TableName: TABLE,
      Key: { PK: pk(args.agentId), SK: `CHAT#${mappedChatId(args.chatId)}#DRAFT#${draftId}#META` },
      ConsistentRead: true,
    }));
    const meta = Item as Record<string, unknown> | undefined;
    if (!meta || meta.kind !== 'document-draft' || meta.status !== 'finalizing' ||
        meta.draftId !== draftId || meta.revision !== draftSource.revision ||
        meta.agentId !== args.agentId || meta.chatId !== args.chatId || meta.ownerId !== args.ownerId) {
      throw new Error('Draft is missing, no longer finalizing, or owned by another user');
    }
  }
  const head = await readHead({ ...args, artifactId });
  let version: number;
  if (args.artifactId) {
    if (!head || head.version !== args.expectedVersion) throw new Error('Stale artifact version conflict');
    version = head.version + 1;
  } else {
    if (head) throw new Error('Artifact already exists');
    version = 1;
  }

  const storageKey = objectKey(args.agentId, args.chatId, artifactId, version);
  const createdAt = new Date().toISOString();
  const publicDescriptor: ArtifactDescriptor = { artifactId, version, fileName: args.fileName, contentType: args.contentType, createdAt };
  const pkValue = pk(args.agentId);
  const base = { ...publicDescriptor, PK: pkValue, agentId: args.agentId, chatId: args.chatId, ownerId: args.ownerId };
  const operationId = randomUUID();
  const pendingKey = { PK: pkValue, SK: pendingSk(args.chatId, operationId) };
  // This row makes an interrupted upload discoverable by conversation and key.
  await ddb().send(new PutCommand({
    TableName: TABLE,
    Item: { ...pendingKey, ...base, status: 'pending', storageKey },
    ConditionExpression: 'attribute_not_exists(PK)',
  }));

  let physicalVersionId: string | undefined;
  let versionPublished = false;
  let headAttempted = false;
  const discardPending = async () => ddb().send(new DeleteCommand({ TableName: TABLE, Key: pendingKey }));
  try {
  const uploaded = await s3().send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: storageKey,
    Body: body,
    ContentType: args.contentType,
  }));
  if (typeof uploaded.VersionId === 'string' && uploaded.VersionId.length > 0) {
    physicalVersionId = uploaded.VersionId;
  }
  if (!physicalVersionId) {
    // Versioning is required, but without the returned id an object may exist
    // that cannot be safely removed by version. Keep its recovery row.
    await s3().send(new DeleteObjectCommand({ Bucket: BUCKET, Key: storageKey }));
    throw new Error('Artifact storage did not return a physical version id');
  }
  const pendingWithVersion = { ...pendingKey, ...base, status: 'uploaded', storageKey, physicalVersionId };
  await ddb().send(new PutCommand({ TableName: TABLE, Item: pendingWithVersion }));
  const versionRow: VersionRow = {
    ...base,
    SK: versionSk(args.chatId, artifactId, version),
    storageKey,
    physicalVersionId,
    source: args.source,
  };
  const headRow: HeadRow = { ...base, SK: headSk(args.chatId, artifactId) };
  // The version is written first with an absent-key fence; the head is then
  // conditionally advanced from the version we observed under the lock. Thus a
  // failed head write cannot report success or overwrite a concurrent winner.
  await ddb().send(new PutCommand({
    TableName: TABLE,
    Item: versionRow,
    ConditionExpression: 'attribute_not_exists(PK)',
  }));
  versionPublished = true;
  // The version row now carries the exact physical key and version, so it is a
  // discoverable parent even if the process stops before head publication.
  await discardPending();
  headAttempted = true;
  await ddb().send(new PutCommand({
    TableName: TABLE,
    Item: headRow,
    ConditionExpression: head ? '#version = :expected' : 'attribute_not_exists(PK)',
    ...(head ? { ExpressionAttributeNames: { '#version': 'version' }, ExpressionAttributeValues: { ':expected': head.version } } : {}),
  }));
  return publicDescriptor;
  } catch (error) {
    // An unfinished operation remains discoverable through its pending child
    // or its version row if compensation itself fails.
    if (physicalVersionId) {
      try {
        if (headAttempted && (error as { name?: string })?.name !== 'ConditionalCheckFailedException') {
          try {
            await ddb().send(new DeleteCommand({
              TableName: TABLE,
              Key: { PK: pkValue, SK: headSk(args.chatId, artifactId) },
              ConditionExpression: '#version = :version',
              ExpressionAttributeNames: { '#version': 'version' },
              ExpressionAttributeValues: { ':version': version },
            }));
          } catch (deleteHeadError) {
            if ((deleteHeadError as { name?: string })?.name !== 'ConditionalCheckFailedException') throw deleteHeadError;
          }
        }
        await s3().send(new DeleteObjectCommand({ Bucket: BUCKET, Key: storageKey, VersionId: physicalVersionId }));
        if (versionPublished) {
          await ddb().send(new DeleteCommand({
            TableName: TABLE,
            Key: { PK: pkValue, SK: versionSk(args.chatId, artifactId, version) },
          }));
        }
        await discardPending();
      } catch {
        // Leave the pending row as the operator-visible recovery handle.
      }
    } else {
      // The request may have committed before its response was lost. Without a
      // physical version id, keep the pending row for explicit recovery.
    }
    throw error;
  }
  } finally {
    await releaseLock();
  }
}

/**
 * Erase every physical version and delete marker for one conversation. The
 * caller must hold acquireConversationChildLock until this function returns
 * and the conversation rows are removed.
 */
export async function eraseConversationArtifacts(agentId: string, chatId: string): Promise<void> {
  if (!BUCKET) throw new Error('CURATED_BUCKET is not configured');
  const prefix = artifactConversationPrefix(agentId, chatId);
  const objects = new Map<string, { Key: string; VersionId: string }>();
  let keyMarker: string | undefined;
  let versionIdMarker: string | undefined;

  // Collect every page before deleting anything: deleting a page can change
  // the version listing and invalidate the continuation markers.
  for (;;) {
    let page;
    try {
      page = await s3().send(new ListObjectVersionsCommand({
        Bucket: BUCKET,
        Prefix: prefix,
        ...(keyMarker ? { KeyMarker: keyMarker } : {}),
        ...(versionIdMarker ? { VersionIdMarker: versionIdMarker } : {}),
      }));
    } catch {
      throw new Error('Failed to list artifact versions for conversation erasure');
    }

    for (const entry of [ ...(page.Versions ?? []), ...(page.DeleteMarkers ?? []) ]) {
      if (!entry.Key || !entry.Key.startsWith(prefix) || !entry.VersionId) {
        throw new Error('Artifact version listing returned an invalid object for erasure');
      }
      objects.set(JSON.stringify([entry.Key, entry.VersionId]), { Key: entry.Key, VersionId: entry.VersionId });
    }

    if (!page.IsTruncated) break;
    if (!page.NextKeyMarker || !page.NextVersionIdMarker ||
        (page.NextKeyMarker === keyMarker && page.NextVersionIdMarker === versionIdMarker)) {
      throw new Error('Artifact version listing could not continue during conversation erasure');
    }
    keyMarker = page.NextKeyMarker;
    versionIdMarker = page.NextVersionIdMarker;
  }

  // Delete each physical version or delete marker by its exact identity.
  // DeleteObjects has inconsistent versioned-bucket behavior in supported
  // local S3 implementations, so do not use it for erasure.
  for (const object of objects.values()) {
    try {
      await s3().send(new DeleteObjectCommand({
        Bucket: BUCKET,
        Key: object.Key,
        VersionId: object.VersionId,
      }));
    } catch {
      throw new Error('Failed to delete artifact version during conversation erasure');
    }
  }

  // Start from the beginning and prove that no physical version or marker
  // remains. A successful delete response or an in-memory set is not proof.
  keyMarker = undefined;
  versionIdMarker = undefined;
  for (;;) {
    let verification;
    try {
      verification = await s3().send(new ListObjectVersionsCommand({
        Bucket: BUCKET,
        Prefix: prefix,
        ...(keyMarker ? { KeyMarker: keyMarker } : {}),
        ...(versionIdMarker ? { VersionIdMarker: versionIdMarker } : {}),
      }));
    } catch {
      throw new Error('Failed to verify artifact erasure for conversation');
    }
    if ((verification.Versions?.length ?? 0) > 0 || (verification.DeleteMarkers?.length ?? 0) > 0) {
      throw new Error('Artifact erasure is incomplete; conversation can be retried');
    }
    if (!verification.IsTruncated) break;
    if (!verification.NextKeyMarker || !verification.NextVersionIdMarker ||
        (verification.NextKeyMarker === keyMarker && verification.NextVersionIdMarker === versionIdMarker)) {
      throw new Error('Artifact erasure could not be verified; conversation can be retried');
    }
    keyMarker = verification.NextKeyMarker;
    versionIdMarker = verification.NextVersionIdMarker;
  }
}

export async function listArtifactHeads(args: ArtifactScope): Promise<ArtifactDescriptor[]> {
  await assertOwner(args);
  return (await queryAll(args.agentId, chatPrefix(args.chatId)))
    .filter((row) => typeof row.SK === 'string' && row.SK.endsWith('#HEAD') && row.ownerId === args.ownerId)
    .map(descriptor);
}

export async function listArtifactVersions(args: ArtifactScope & { artifactId: string }): Promise<ArtifactDescriptor[]> {
  await assertOwner(args);
  return (await queryAll(args.agentId, childBase(args.chatId, args.artifactId) + 'VERSION#'))
    .filter((row) => row.ownerId === args.ownerId && String(row.SK).includes('#VERSION#'))
    .map(descriptor);
}

export async function getArtifactVersion(args: ArtifactVersionScope): Promise<ArtifactDescriptor & { source: unknown }> {
  await assertOwner(args);
  const { Item } = await ddb().send(new GetCommand({
    TableName: TABLE,
    Key: { PK: pk(args.agentId), SK: versionSk(args.chatId, args.artifactId, args.version) },
    ConsistentRead: true,
  }));
  if (!Item || Item.ownerId !== args.ownerId) throw new Error('Artifact version not found');
  return { ...descriptor(Item), source: Item.source };
}

export async function readArtifactBody(args: ArtifactVersionScope): Promise<Uint8Array> {
  await assertOwner(args);
  const { Item } = await ddb().send(new GetCommand({
    TableName: TABLE,
    Key: { PK: pk(args.agentId), SK: versionSk(args.chatId, args.artifactId, args.version) },
    ConsistentRead: true,
  }));
  const row = Item as VersionRow | undefined;
  if (!row || row.ownerId !== args.ownerId) throw new Error('Artifact version not found');
  const out = await s3().send(new GetObjectCommand({
    Bucket: BUCKET,
    Key: row.storageKey,
    VersionId: row.physicalVersionId,
  }));
  if (!out.Body) throw new Error('Artifact body is unavailable');
  if ('transformToByteArray' in out.Body && typeof out.Body.transformToByteArray === 'function') {
    return out.Body.transformToByteArray();
  }
  const chunks: Buffer[] = [];
  for await (const chunk of out.Body as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function attachmentDisposition(fileName: string): string {
  // Keep a conservative ASCII fallback for older clients, and preserve the
  // original UTF-8 name using the RFC 5987 filename* parameter.
  const fallback = fileName.replace(/[^A-Za-z0-9._-]+/g, '_') || 'artifact';
  const encoded = encodeURIComponent(fileName).replace(/[!'()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/** Mint a short-lived owner download URL for one immutable physical version. */
export async function presignArtifactDownload(args: ArtifactVersionScope): Promise<string> {
  if (!BUCKET) throw new Error('CURATED_BUCKET is not configured');
  await assertOwner(args);
  const { Item } = await ddb().send(new GetCommand({
    TableName: TABLE,
    Key: { PK: pk(args.agentId), SK: versionSk(args.chatId, args.artifactId, args.version) },
    ConsistentRead: true,
  }));
  const row = Item as VersionRow | undefined;
  if (!row || row.agentId !== args.agentId || row.chatId !== args.chatId ||
      row.ownerId !== args.ownerId || row.artifactId !== args.artifactId || row.version !== args.version ||
      row.storageKey !== objectKey(args.agentId, args.chatId, args.artifactId, args.version) ||
      typeof row.physicalVersionId !== 'string' || !row.physicalVersionId ||
      typeof row.fileName !== 'string' || !row.fileName) {
    throw new Error('Artifact version not found');
  }
  return getSignedUrl(s3(), new GetObjectCommand({
    Bucket: BUCKET,
    Key: row.storageKey,
    VersionId: row.physicalVersionId,
    ResponseContentDisposition: attachmentDisposition(row.fileName),
  }), { expiresIn: 300 });
}
