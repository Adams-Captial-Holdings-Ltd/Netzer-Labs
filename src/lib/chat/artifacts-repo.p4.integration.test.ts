/** P4: real local DynamoDB and versioned S3 behavior (Floci, no AWS account). */
import { beforeAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { S3Client, CreateBucketCommand, PutBucketVersioningCommand, PutObjectCommand,
  DeleteObjectCommand, ListObjectVersionsCommand } from '@aws-sdk/client-s3';
import { PutCommand, QueryCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { ensureLocalStack, configureLocalAwsEnv, createDdbTable } from '../../__test-utils__/localstack.js';

const suffix = randomUUID().slice(0, 8);
const TABLE = `p4-artifacts-${suffix}`;
const BUCKET = `p4-curated-${suffix}`;
const repoPath = './artifacts-repo.js';
const PERSON = { surface: 'dashboard' as const, userId: 'dashboard:user:p4-integration', ephemeral: false };
let s3: S3Client;
const chat = (label: string) => `dashboard:p4-${label}-${suffix}`;
const scope = (chatId: string, artifactId: string, version: number) =>
  ({ agentId: 'main', chatId, ownerId: PERSON.userId, artifactId, version });
const input = (chatId: string, body: string, more: Record<string, unknown> = {}) => ({
  agentId: 'main', chatId, ownerId: PERSON.userId,
  fileName: 'launch-notes.md', contentType: 'text/markdown', body: Buffer.from(body),
  source: { kind: 'grammar', identifier: 'launch-notes' }, ...more,
});

beforeAll(async () => {
  configureLocalAwsEnv();
  process.env.TABLE_SESSIONS = TABLE;
  process.env.CURATED_BUCKET = BUCKET;
  process.env.BEDROCK_HAIKU_MODEL = 'integ-noop';
  await ensureLocalStack();
  await createDdbTable({ name: TABLE, partitionKey: { name: 'PK', type: 'S' }, sortKey: { name: 'SK', type: 'S' } });
  s3 = new S3Client({ region: process.env.AWS_REGION ?? 'us-east-1', endpoint: process.env.AWS_ENDPOINT_URL,
    forcePathStyle: true, credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    requestChecksumCalculation: 'WHEN_REQUIRED' });
  await s3.send(new CreateBucketCommand({ Bucket: BUCKET }));
  await s3.send(new PutBucketVersioningCommand({ Bucket: BUCKET, VersioningConfiguration: { Status: 'Enabled' } }));
});

async function ownedChat(chatId: string) {
  const { appendTurns } = await import('../state/sessions-repo.js');
  await appendTurns('main', chatId, [{ role: 'user', text: 'Write a file', ts: 1 }], undefined, PERSON);
}

it('P4 local storage preserves two independently downloadable versions', async () => {
  const repo = await import(repoPath);
  expect(repo.presignArtifactDownload, 'owner download remint must exist').toBeTypeOf('function');
  const chatId = chat('versions');
  await ownedChat(chatId);
  const first = await repo.saveArtifact(input(chatId, 'first stored edition'));
  const second = await repo.saveArtifact(input(chatId, 'second stored edition', {
    artifactId: first.artifactId, expectedVersion: 1,
    source: { kind: 'revision', fromVersion: 1, instruction: 'replace body' },
  }));
  expect(second.version).toBe(2);
  const url1 = await repo.presignArtifactDownload(scope(chatId, first.artifactId, 1));
  const url2 = await repo.presignArtifactDownload(scope(chatId, first.artifactId, 2));
  expect(new URL(url1).searchParams.get('response-content-disposition')).toContain('launch-notes.md');
  expect(new URL(url2).searchParams.get('response-content-disposition')).toContain('launch-notes.md');
  // Fetch the WHOLE signed URLs. Trimming their query strings made real production downloads fail (P120).
  const response1 = await fetch(url1);
  const response2 = await fetch(url2);
  expect(response1.status).toBe(200);
  expect(response2.status).toBe(200);
  expect(await response1.text()).toBe('first stored edition');
  expect(await response2.text()).toBe('second stored edition');
});

it('P4 local erasure removes all S3 versions markers and artifact rows', async () => {
  const repo = await import(repoPath);
  const { deleteSession, getSession } = await import('../state/sessions-repo.js');
  const chatId = chat('erase');
  await ownedChat(chatId);
  const first = await repo.saveArtifact(input(chatId, 'first'));
  await repo.saveArtifact(input(chatId, 'second', { artifactId: first.artifactId, expectedVersion: 1 }));
  const before = await s3.send(new ListObjectVersionsCommand({ Bucket: BUCKET, Prefix: 'artifacts/' }));
  const ownedKeys = [...(before.Versions ?? []), ...(before.DeleteMarkers ?? [])]
    .map((v) => v.Key ?? '').filter((key) => key.includes(Buffer.from(chatId).toString('base64url')));
  expect(ownedKeys.length).toBeGreaterThanOrEqual(2);
  const root = ownedKeys[0].split('/').slice(0, 3).join('/') + '/';
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: `${root}preview/thumb.png`, Body: Buffer.from('preview') }));
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: `${root}kb/copy.pdf`, Body: Buffer.from('kb') }));
  await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: ownedKeys[0] })); // creates a delete marker
  const planted = await s3.send(new ListObjectVersionsCommand({ Bucket: BUCKET, Prefix: root }));
  expect((planted.DeleteMarkers ?? []).length).toBeGreaterThanOrEqual(1);

  await deleteSession('main', chatId);

  const after = await s3.send(new ListObjectVersionsCommand({ Bucket: BUCKET, Prefix: root }));
  expect(after.Versions ?? []).toEqual([]);
  expect(after.DeleteMarkers ?? []).toEqual([]);
  expect(await getSession('main', chatId)).toBeNull();
  const { ddb } = await import('../state/ddb.js');
  const rows = await ddb().send(new QueryCommand({ TableName: TABLE,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
    ExpressionAttributeValues: { ':pk': 'AGENT#main', ':prefix': `CHAT#${chatId}#` }, ConsistentRead: true }));
  expect(rows.Items ?? []).toEqual([]);
});

it('P4 local conditional lock prevents a writer from crossing deletion', async () => {
  const repo = await import(repoPath);
  const { ddb } = await import('../state/ddb.js');
  const chatId = chat('lock');
  await ownedChat(chatId);
  const key = { PK: 'AGENT#main', SK: `CHAT#${chatId}#CHILD_LOCK` };
  await ddb().send(new PutCommand({ TableName: TABLE, Item: { ...key, lockToken: 'planted-test-lock' },
    ConditionExpression: 'attribute_not_exists(SK)' }));
  try {
    await expect(repo.saveArtifact(input(chatId, 'must not cross'))).rejects.toThrow(/busy|lock|retry/i);
  } finally {
    await ddb().send(new DeleteCommand({ TableName: TABLE, Key: key }));
  }
  const stored = await repo.saveArtifact(input(chatId, 'safe after release'));
  expect(stored.version).toBe(1);
});

it('P4 local containment keeps artifact records out of conversation lists', async () => {
  const repo = await import(repoPath);
  const chatId = chat('contain');
  await ownedChat(chatId);
  await repo.saveArtifact(input(chatId, 'file body'));
  const { ddb } = await import('../state/ddb.js');
  const result = await ddb().send(new QueryCommand({ TableName: TABLE,
    KeyConditionExpression: 'PK = :pk', ExpressionAttributeValues: { ':pk': 'AGENT#main' }, ConsistentRead: true }));
  const { isConversationRow } = await import('../../adapters/dashboard/handler.js');
  const rows = (result.Items ?? []).filter((row) => isConversationRow(row));
  expect(rows.filter((row) => row.SK === `CHAT#${chatId}`)).toHaveLength(1);
  expect(rows.some((row) => String(row.SK).includes('#ARTIFACT#'))).toBe(false);
});

it('P4 local first-turn artifact initializes and erases its stable parent', async () => {
  const repo = await import(repoPath);
  const { getSession, deleteSession } = await import('../state/sessions-repo.js');
  const chatId = chat('first-turn');
  expect(await getSession('main', chatId)).toBeNull();
  const saved = await repo.saveArtifact(input(chatId, 'first turn body'));
  expect(saved.version).toBe(1);
  expect(await getSession('main', chatId)).toMatchObject({ surface: 'dashboard',
    userId: PERSON.userId, turns: [] });
  await deleteSession('main', chatId);
  expect(await getSession('main', chatId)).toBeNull();
  const { ddb } = await import('../state/ddb.js');
  const child = await ddb().send(new QueryCommand({ TableName: TABLE,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
    ExpressionAttributeValues: { ':pk': 'AGENT#main', ':prefix': `CHAT#${chatId}#` }, ConsistentRead: true }));
  expect(child.Items ?? []).toEqual([]);
});
