/** P4 WI-4.2: public artifact storage seam, frozen rows S-1 through S-6. */
import { beforeEach, expect, it, vi } from 'vitest';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { createFakeDynamo } from '../../__test-utils__/fake-dynamo.js';

const { ddbSend } = vi.hoisted(() => {
  process.env.TABLE_SESSIONS = 'p4-unit-sessions';
  process.env.CURATED_BUCKET = 'p4-unit-curated';
  return { ddbSend: vi.fn() };
});
vi.mock('../state/ddb.js', async (importActual) => {
  const actual = await importActual<typeof import('../state/ddb.js')>();
  return { ...actual, ddb: () => ({ send: ddbSend }) };
});
vi.mock('../state/runtime-config-repo.js', () => ({ getConfig: async () => undefined }));
vi.mock('../../agent/memory-ingest.js', () => ({ ingestEvictedTurns: () => undefined }));
vi.mock('../observability/xray.js', () => ({ captureAwsClient: <T,>(client: T): T => client }));

const PERSON = { surface: 'dashboard' as const, userId: 'dashboard:user:p4-owner', ephemeral: false };
const foreignOwner = 'dashboard:user:not-the-owner';
const repoPath = './artifacts-repo.js';
let table: ReturnType<typeof createFakeDynamo>;
const spyS3 = () => vi.spyOn(S3Client.prototype, 'send');
let s3Send: ReturnType<typeof spyS3>;
let physicalVersion: number;
let bodies: Map<string, Buffer>;
const chat = () => `dashboard:p4-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const input = (chatId: string, other: Record<string, unknown> = {}) => ({
  agentId: 'main', chatId, ownerId: PERSON.userId,
  fileName: 'launch-notes.md', contentType: 'text/markdown',
  body: Buffer.from('# Launch\nFirst draft.'),
  source: { kind: 'grammar', identifier: 'launch-notes' },
  ...other,
});

beforeEach(() => {
  table = createFakeDynamo();
  ddbSend.mockReset();
  ddbSend.mockImplementation((cmd) => table.send(cmd));
  physicalVersion = 0;
  bodies = new Map();
  s3Send?.mockRestore();
  s3Send = spyS3().mockImplementation(async (cmd: unknown) => {
    if (cmd instanceof PutObjectCommand) {
      const versionId = `physical-${++physicalVersion}`;
      bodies.set(`${cmd.input.Key}|${versionId}`, Buffer.from(cmd.input.Body as Uint8Array));
      return { VersionId: versionId } as never;
    }
    if (cmd instanceof GetObjectCommand) {
      const bytes = bodies.get(`${cmd.input.Key}|${cmd.input.VersionId}`);
      if (!bytes) throw new Error('physical version missing');
      return { Body: { transformToByteArray: async () => bytes } } as never;
    }
    throw new Error(`unexpected S3 ${String((cmd as { constructor?: { name?: string } }).constructor?.name)}`);
  });
});

async function ownedChat(chatId: string) {
  const { appendTurns } = await import('../state/sessions-repo.js');
  await appendTurns('main', chatId, [{ role: 'user', text: 'Make a file', ts: 1 }], undefined, PERSON);
}

it('P4 storage writes curated bytes before publishing a descriptor', async () => {
  const storage = await import(repoPath).catch(() => null);
  expect(storage?.saveArtifact, 'a durable artifact write must be available').toBeTypeOf('function');
  const chatId = chat();
  await ownedChat(chatId);
  let finishPut: ((value: { VersionId: string }) => void) | undefined;
  s3Send.mockImplementationOnce(() => new Promise((resolve) => { finishPut = resolve as typeof finishPut; }) as never);
  const pending = storage!.saveArtifact(input(chatId));
  await vi.waitFor(() => expect(finishPut, 'S3 PUT must begin').toBeTypeOf('function'));
  expect(await storage!.listArtifactHeads({ agentId: 'main', chatId, ownerId: PERSON.userId }),
    'no descriptor may claim that an unfinished S3 write succeeded').toEqual([]);
  finishPut!({ VersionId: 'physical-1' });
  const saved = await pending;
  expect(saved).toMatchObject({ version: 1, fileName: 'launch-notes.md', contentType: 'text/markdown' });
  expect(saved.artifactId).toBeTypeOf('string');
  expect(JSON.stringify(saved), 'descriptor must contain no bucket, key, or URL').not.toMatch(/"(?:bucket|key|url|presignedUrl)"|X-Amz-/i);
  expect(await storage!.listArtifactHeads({ agentId: 'main', chatId, ownerId: PERSON.userId })).toHaveLength(1);
});

it('P4 storage keeps immutable versions and source specifications', async () => {
  const storage = await import(repoPath).catch(() => null);
  expect(storage?.saveArtifact, 'durable artifact versions must be available').toBeTypeOf('function');
  const chatId = chat();
  await ownedChat(chatId);
  const first = await storage!.saveArtifact(input(chatId));
  const second = await storage!.saveArtifact(input(chatId, {
    artifactId: first.artifactId, expectedVersion: 1,
    body: Buffer.from('# Launch\nSecond draft.'),
    source: { kind: 'revision', fromVersion: 1, instruction: 'Update the draft' },
  }));
  expect(second).toMatchObject({ artifactId: first.artifactId, version: 2 });
  const scope = { agentId: 'main', chatId, ownerId: PERSON.userId, artifactId: first.artifactId };
  const versions = await storage!.listArtifactVersions(scope);
  expect(versions.map((v: { version: number }) => v.version)).toEqual([1, 2]);
  expect((await storage!.getArtifactVersion({ ...scope, version: 1 })).source).toEqual({ kind: 'grammar', identifier: 'launch-notes' });
  expect((await storage!.getArtifactVersion({ ...scope, version: 2 })).source).toEqual({ kind: 'revision', fromVersion: 1, instruction: 'Update the draft' });
  expect(Buffer.from(await storage!.readArtifactBody({ ...scope, version: 1 })).toString()).toBe('# Launch\nFirst draft.');
  expect(Buffer.from(await storage!.readArtifactBody({ ...scope, version: 2 })).toString()).toBe('# Launch\nSecond draft.');
  expect(s3Send.mock.calls.filter(([cmd]) => cmd instanceof GetObjectCommand).map(([cmd]) => (cmd as GetObjectCommand).input.VersionId))
    .toEqual(['physical-1', 'physical-2']);
});

it('P4 storage refuses stale revisions without changing the earlier version', async () => {
  const storage = await import(repoPath).catch(() => null);
  expect(storage?.saveArtifact, 'version checks must be available').toBeTypeOf('function');
  const chatId = chat();
  await ownedChat(chatId);
  const first = await storage!.saveArtifact(input(chatId));
  const second = await storage!.saveArtifact(input(chatId, { artifactId: first.artifactId, expectedVersion: 1,
    body: Buffer.from('new'), source: { kind: 'revision', fromVersion: 1 } }));
  const putsBefore = s3Send.mock.calls.filter(([cmd]) => cmd instanceof PutObjectCommand).length;
  await expect(storage!.saveArtifact(input(chatId, { artifactId: first.artifactId, expectedVersion: 1,
    body: Buffer.from('stale'), source: { kind: 'revision', fromVersion: 1 } }))).rejects.toThrow(/stale|version|conflict/i);
  expect(s3Send.mock.calls.filter(([cmd]) => cmd instanceof PutObjectCommand)).toHaveLength(putsBefore);
  expect((await storage!.listArtifactVersions({ agentId: 'main', chatId, ownerId: PERSON.userId, artifactId: first.artifactId }))
    .map((v: { version: number }) => v.version)).toEqual([1, second.version]);
});

it('P4 storage scopes reads to the conversation owner and agent', async () => {
  const storage = await import(repoPath).catch(() => null);
  expect(storage?.getArtifactVersion, 'owner-scoped version reads must be available').toBeTypeOf('function');
  const chatId = chat();
  await ownedChat(chatId);
  const saved = await storage!.saveArtifact(input(chatId));
  const scope = { agentId: 'main', chatId, artifactId: saved.artifactId, version: 1 };
  await expect(storage!.getArtifactVersion({ ...scope, ownerId: foreignOwner })).rejects.toThrow();
  await expect(storage!.readArtifactBody({ ...scope, ownerId: foreignOwner })).rejects.toThrow();
  await expect(storage!.listArtifactHeads({ agentId: 'other-agent', chatId, ownerId: PERSON.userId })).rejects.toThrow();
  expect(s3Send.mock.calls.filter(([cmd]) => cmd instanceof GetObjectCommand)).toHaveLength(0);
});

it('P4 storage refuses ephemeral and foreign conversation writes', async () => {
  const storage = await import(repoPath).catch(() => null);
  expect(storage?.saveArtifact, 'durable writes must check the parent owner').toBeTypeOf('function');
  const chatId = chat();
  await ownedChat(chatId);
  await expect(storage!.saveArtifact(input(chatId, { ownerId: foreignOwner }))).rejects.toThrow();
  await expect(storage!.saveArtifact(input(chat()))).rejects.toThrow();
  const ephemeralChat = chat();
  const { appendTurns } = await import('../state/sessions-repo.js');
  await appendTurns('main', ephemeralChat, [{ role: 'user', text: 'ephemeral', ts: 1 }], undefined,
    { surface: 'dashboard', userId: 'dashboard:token:unbound', ephemeral: true });
  await expect(storage!.saveArtifact(input(ephemeralChat, { ownerId: 'dashboard:token:unbound' }))).rejects.toThrow();
  expect(s3Send).not.toHaveBeenCalled();
});

it('P4 storage rejects unsafe names types and excessive bytes before upload', async () => {
  const storage = await import(repoPath).catch(() => null);
  expect(storage?.saveArtifact, 'artifact input admission must be available').toBeTypeOf('function');
  const chatId = chat();
  await ownedChat(chatId);
  await expect(storage!.saveArtifact(input(chatId, { fileName: '../outside.md' }))).rejects.toThrow();
  await expect(storage!.saveArtifact(input(chatId, { fileName: 'bad\r\nname.md' }))).rejects.toThrow();
  await expect(storage!.saveArtifact(input(chatId, { contentType: 'application/x-msdownload' }))).rejects.toThrow();
  await expect(storage!.saveArtifact(input(chatId, { body: Buffer.alloc(30 * 1024 * 1024 + 1) }))).rejects.toThrow(/size|large|limit|bytes/i);
  expect(s3Send).not.toHaveBeenCalled();
});
