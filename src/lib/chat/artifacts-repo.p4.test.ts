/** P4 WI-4.2: public artifact storage seam, frozen rows S-1 through S-6. */
import { beforeEach, expect, it, vi } from 'vitest';
import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { createFakeDynamo } from '../../__test-utils__/fake-dynamo.js';

const { ddbSend, scanForExfil } = vi.hoisted(() => {
  process.env.TABLE_SESSIONS = 'p4-unit-sessions';
  process.env.CURATED_BUCKET = 'p4-unit-curated';
  return { ddbSend: vi.fn(), scanForExfil: vi.fn() };
});
vi.mock('../state/ddb.js', async (importActual) => {
  const actual = await importActual<typeof import('../state/ddb.js')>();
  return { ...actual, ddb: () => ({ send: ddbSend }) };
});
vi.mock('../safety/exfil-guard.js', async (importActual) => {
  const actual = await importActual<typeof import('../safety/exfil-guard.js')>();
  return { ...actual, scanForExfil };
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
  scanForExfil.mockReset();
  scanForExfil.mockImplementation(async (text: string) => ({ blocked: false, matches: [], scannedBytes: text.length, truncated: false }));
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
  const put = s3Send.mock.calls.find(([cmd]) => cmd instanceof PutObjectCommand)?.[0] as PutObjectCommand | undefined;
  expect(put?.input.Key, 'the CURATED key must sit under the artifacts/* IAM and erasure prefix').toMatch(/^artifacts\//);
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

it('P4 storage rejects block severity secrets in content names and source', async () => {
  const storage = await import(repoPath).catch(() => null);
  expect(storage?.saveArtifact, 'the S3 write must pass a blocking safety check').toBeTypeOf('function');
  const chatId = chat();
  await ownedChat(chatId);
  scanForExfil.mockImplementation(async (text: string) => ({
    blocked: text.includes('BLOCKED_SECRET'),
    matches: text.includes('BLOCKED_SECRET') ? [{ patternId: 'test', patternName: 'test', severity: 'block', snippet: 'redacted' }] : [],
    scannedBytes: text.length, truncated: false,
  }));
  for (const changes of [
    { body: Buffer.from('BLOCKED_SECRET') },
    { fileName: 'BLOCKED_SECRET.md' },
    { source: { kind: 'grammar', identifier: 'BLOCKED_SECRET' } },
  ]) {
    await expect(storage!.saveArtifact(input(chatId, changes)),
      'the secret must not be copied to CURATED or published').rejects.toThrow(/secret|block|safety|refus/i);
  }
  expect(s3Send).not.toHaveBeenCalled();
});

it('P4 storage fails closed when its safety scan cannot complete', async () => {
  const storage = await import(repoPath).catch(() => null);
  expect(storage?.saveArtifact, 'artifact write safety must fail closed').toBeTypeOf('function');
  const chatId = chat();
  await ownedChat(chatId);
  scanForExfil.mockRejectedValue(new Error('scanner unavailable'));
  await expect(storage!.saveArtifact(input(chatId))).rejects.toThrow(/scan|safety|unavailable/i);
  expect(s3Send, 'scanner failure cannot upload bytes').not.toHaveBeenCalled();
  expect(await storage!.listArtifactHeads({ agentId: 'main', chatId, ownerId: PERSON.userId })).toEqual([]);
});

it('P4 storage publishes no descriptor after an S3 write failure', async () => {
  const storage = await import(repoPath).catch(() => null);
  expect(storage?.saveArtifact, 'artifact writes must report an S3 failure').toBeTypeOf('function');
  const chatId = chat();
  await ownedChat(chatId);
  s3Send.mockRejectedValueOnce(new Error('CURATED upload unavailable'));
  await expect(storage!.saveArtifact(input(chatId))).rejects.toThrow(/upload|unavailable|S3/i);
  expect(await storage!.listArtifactHeads({ agentId: 'main', chatId, ownerId: PERSON.userId })).toEqual([]);
});

it('P4 storage cleans an uploaded version when its record write fails', async () => {
  const storage = await import(repoPath).catch(() => null);
  expect(storage?.saveArtifact, 'artifact persistence must clean up a failed record').toBeTypeOf('function');
  const chatId = chat();
  await ownedChat(chatId);
  let uploadedKey = '';
  const deleted: Array<{ Key?: string; VersionId?: string }> = [];
  s3Send.mockImplementation(async (cmd: unknown) => {
    if (cmd instanceof PutObjectCommand) {
      uploadedKey = String(cmd.input.Key);
      return { VersionId: 'physical-failed' } as never;
    }
    if (cmd instanceof DeleteObjectCommand) {
      deleted.push({ Key: cmd.input.Key, VersionId: cmd.input.VersionId });
      return {} as never;
    }
    throw new Error('unexpected S3 command');
  });
  ddbSend.mockImplementation(async (cmd) => {
    if (cmd.constructor.name === 'PutCommand' && String(cmd.input.Item?.SK).includes('#VERSION#')) {
      throw new Error('DynamoDB record unavailable');
    }
    return table.send(cmd);
  });
  await expect(storage!.saveArtifact(input(chatId))).rejects.toThrow(/record|DynamoDB|unavailable/i);
  expect(deleted).toEqual([{ Key: uploadedKey, VersionId: 'physical-failed' }]);
  expect(await storage!.listArtifactHeads({ agentId: 'main', chatId, ownerId: PERSON.userId })).toEqual([]);
});

it('P4 storage excludes writes while conversation erasure holds the lock', async () => {
  const storage = await import(repoPath).catch(() => null);
  expect(storage?.saveArtifact, 'artifact writes must serialize with conversation erasure').toBeTypeOf('function');
  const chatId = chat();
  await ownedChat(chatId);
  let finishPut: ((value: { VersionId: string }) => void) | undefined;
  s3Send.mockImplementationOnce(() => new Promise((resolve) => { finishPut = resolve as typeof finishPut; }) as never);
  const pending = storage!.saveArtifact(input(chatId));
  await vi.waitFor(() => expect(finishPut, 'the artifact writer must reach S3').toBeTypeOf('function'));
  const { deleteSession, getSession } = await import('../state/sessions-repo.js');
  await expect(deleteSession('main', chatId), 'delete must refuse an active artifact writer').rejects.toThrow(/busy|lock|retry/i);
  expect(await getSession('main', chatId)).not.toBeNull();
  finishPut!({ VersionId: 'physical-1' });
  await pending;
});
