/** P4 WI-4.2: public artifact storage seam, frozen rows S-1 through S-6. */
import { beforeEach, expect, it, vi } from 'vitest';
import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, ListObjectVersionsCommand } from '@aws-sdk/client-s3';
import { createFakeDynamo } from '../../__test-utils__/fake-dynamo.js';
import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';

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
  // P7 (M3): the lock's Put is conditioned 'attribute_not_exists(PK) OR createdAt < :cutoff' (a 15-minute lease),
  // which the fake table does not evaluate (A170). Answer that one Put as DynamoDB does: a lock that is held and
  // not past its lease refuses the next holder.
  ddbSend.mockImplementation(async (cmd: { constructor: { name: string }; input: Record<string, any> }) => {
    const { Item, ConditionExpression, ExpressionAttributeValues } = cmd.input;
    if (cmd.constructor.name === 'PutCommand' && String(Item?.SK).endsWith('#CHILD_LOCK')) {
      const held = table.rows.get(`${String(Item.PK)}|${String(Item.SK)}`);
      const cutoff = ExpressionAttributeValues?.[':cutoff'];
      const expired = /createdAt\s*<\s*:cutoff/.test(String(ConditionExpression)) &&
        typeof held?.createdAt === 'string' && typeof cutoff === 'string' && held.createdAt < cutoff;
      if (held && !expired) {
        throw Object.assign(new Error('The conditional request failed'), { name: 'ConditionalCheckFailedException' });
      }
    }
    return table.send(cmd as never);
  });
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

it('P4 erasure lists every page and removes versions markers and derivatives', async () => {
  const storage = await import(repoPath).catch(() => null);
  expect(storage?.saveArtifact, 'version-aware erasure needs stored artifact versions').toBeTypeOf('function');
  const chatId = chat();
  await ownedChat(chatId);
  const first = await storage!.saveArtifact(input(chatId));
  await storage!.saveArtifact(input(chatId, { artifactId: first.artifactId, expectedVersion: 1,
    body: Buffer.from('second'), source: { kind: 'revision', fromVersion: 1 } }));
  const puts = s3Send.mock.calls.map(([cmd]) => cmd).filter((cmd) => cmd instanceof PutObjectCommand) as PutObjectCommand[];
  const root = String(puts[0].input.Key).split('/').slice(0, 3).join('/') + '/';
  const expected = [
    { Key: puts[0].input.Key, VersionId: 'physical-1' },
    { Key: puts[1].input.Key, VersionId: 'physical-2' },
    { Key: `${root}preview/thumb.png`, VersionId: 'preview-v1' },
    { Key: `${root}kb/copy.pdf`, VersionId: 'kb-v1' },
    { Key: `${root}preview/thumb.png`, VersionId: 'preview-delete-marker' },
  ];
  const listInputs: Array<{ Prefix?: string; KeyMarker?: string; VersionIdMarker?: string }> = [];
  const deleted: Array<{ Key?: string; VersionId?: string }> = [];
  s3Send.mockImplementation(async (cmd: unknown) => {
    if (cmd instanceof ListObjectVersionsCommand) {
      listInputs.push(cmd.input);
      if (listInputs.length === 1) return { IsTruncated: true, NextKeyMarker: 'page-2', NextVersionIdMarker: 'v2',
        Versions: expected.slice(0, 2) } as never;
      if (listInputs.length === 2) return { IsTruncated: false, Versions: expected.slice(2, 4),
        DeleteMarkers: [expected[4]] } as never;
      return { IsTruncated: false, Versions: [], DeleteMarkers: [] } as never;
    }
    if (cmd instanceof DeleteObjectCommand) {
      deleted.push({ Key: cmd.input.Key, VersionId: cmd.input.VersionId });
      return {} as never;
    }
    throw new Error('unexpected S3 command');
  });
  const { deleteSession, getSession } = await import('../state/sessions-repo.js');
  await deleteSession('main', chatId);
  expect(listInputs, 'erasure must paginate and verify that CURATED is empty').toHaveLength(3);
  expect(listInputs[0].Prefix).toBe(root);
  expect(listInputs[1]).toMatchObject({ Prefix: root, KeyMarker: 'page-2', VersionIdMarker: 'v2' });
  expect(deleted.sort((a, b) => String(a.Key).localeCompare(String(b.Key))))
    .toEqual(expected.sort((a, b) => String(a.Key).localeCompare(String(b.Key))));
  expect(await getSession('main', chatId)).toBeNull();
  expect([...table.rows.values()].filter((row) => String(row.SK).startsWith(`CHAT#${chatId}#`))).toEqual([]);
});

it('P4 erasure leaves rows retryable on partial object deletion failure', async () => {
  const storage = await import(repoPath).catch(() => null);
  expect(storage?.saveArtifact, 'an artifact is needed to prove retryable erasure').toBeTypeOf('function');
  const chatId = chat();
  await ownedChat(chatId);
  const saved = await storage!.saveArtifact(input(chatId));
  const put = s3Send.mock.calls.find(([cmd]) => cmd instanceof PutObjectCommand)?.[0] as PutObjectCommand;
  s3Send.mockImplementation(async (cmd: unknown) => {
    if (cmd instanceof ListObjectVersionsCommand) return { IsTruncated: false,
      Versions: [{ Key: put.input.Key, VersionId: 'physical-1' }] } as never;
    if (cmd instanceof DeleteObjectCommand) throw new Error('AccessDenied deleting physical version');
    throw new Error('unexpected S3 command');
  });
  const { deleteSession, getSession } = await import('../state/sessions-repo.js');
  await expect(deleteSession('main', chatId)).rejects.toThrow(/delete|artifact|version|AccessDenied/i);
  expect(s3Send.mock.calls.filter(([cmd]) => cmd instanceof DeleteObjectCommand)
    .map(([cmd]) => (cmd as DeleteObjectCommand).input),
  'the failed operation must address the exact physical version').toMatchObject([
    { Key: put.input.Key, VersionId: 'physical-1' },
  ]);
  expect(await getSession('main', chatId)).not.toBeNull();
  expect(await storage!.listArtifactHeads({ agentId: 'main', chatId, ownerId: PERSON.userId })).toMatchObject([{ artifactId: saved.artifactId }]);
});

it('P4 erasure never reaches another conversation prefix', async () => {
  const storage = await import(repoPath).catch(() => null);
  expect(storage?.saveArtifact, 'scoped erasure needs artifact storage').toBeTypeOf('function');
  const chatA = 'dashboard:scope-a';
  const chatB = 'dashboard:scope-a-plus';
  await ownedChat(chatA);
  await ownedChat(chatB);
  await storage!.saveArtifact(input(chatA));
  const savedB = await storage!.saveArtifact(input(chatB, { body: Buffer.from('keep B') }));
  const puts = s3Send.mock.calls.map(([cmd]) => cmd).filter((cmd) => cmd instanceof PutObjectCommand) as PutObjectCommand[];
  const aKey = String(puts[0].input.Key);
  const bKey = String(puts[1].input.Key);
  const defaultSend = s3Send.getMockImplementation()!;
  const deleted: Array<{ Key?: string; VersionId?: string }> = [];
  s3Send.mockImplementation(async (cmd: unknown) => {
    if (cmd instanceof ListObjectVersionsCommand) {
      const all = [{ Key: aKey, VersionId: 'physical-1' }, { Key: bKey, VersionId: 'physical-2' }];
      return { IsTruncated: false, Versions: all.filter((v) => v.Key.startsWith(cmd.input.Prefix ?? '') &&
        !deleted.some((item) => item.Key === v.Key && item.VersionId === v.VersionId)) } as never;
    }
    if (cmd instanceof DeleteObjectCommand) {
      deleted.push({ Key: cmd.input.Key, VersionId: cmd.input.VersionId });
      bodies.delete(`${cmd.input.Key}|${cmd.input.VersionId}`);
      return {} as never;
    }
    return (defaultSend as (command: unknown) => Promise<unknown>)(cmd) as never;
  });
  const { deleteSession } = await import('../state/sessions-repo.js');
  await deleteSession('main', chatA);
  expect(deleted.map((item) => item.Key)).toEqual([aKey]);
  expect(Buffer.from(await storage!.readArtifactBody({ agentId: 'main', chatId: chatB,
    ownerId: PERSON.userId, artifactId: savedB.artifactId, version: 1 })).toString()).toBe('keep B');
});

it('P4 first-turn artifact initializes its stable owner only after safety checks', async () => {
  const storage = await import(repoPath);
  const { getSession } = await import('../state/sessions-repo.js');
  const chatId = chat();
  expect(await getSession('main', chatId)).toBeNull();
  scanForExfil.mockImplementationOnce(async () => ({ blocked: true, truncated: false,
    matches: [{ severity: 'block', pattern: 'fixture' }], scannedBytes: 1 }));
  await expect(storage.saveArtifact(input(chatId))).rejects.toThrow();
  expect(await getSession('main', chatId), 'unsafe bytes must not create an empty chat').toBeNull();
  const saved = await storage.saveArtifact(input(chatId));
  expect(saved.version).toBe(1);
  expect(await getSession('main', chatId)).toMatchObject({ userId: PERSON.userId,
    surface: 'dashboard', turns: [] });
});

it('P4 CURATED accepts generated spreadsheets and Mermaid text', async () => {
  const storage = await import(repoPath);
  const chatId = chat();
  await ownedChat(chatId);
  const xlsx = await storage.saveArtifact(input(chatId, { fileName: 'table.xlsx',
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', body: Buffer.from('PKfixture') }));
  const mermaid = await storage.saveArtifact(input(chatId, { fileName: 'diagram.mmd',
    contentType: 'text/vnd.mermaid', body: Buffer.from('graph TD; A-->B') }));
  expect(xlsx.contentType).toContain('spreadsheetml.sheet');
  expect(mermaid.contentType).toBe('text/vnd.mermaid');
});


it('P4 owner artifact lists read every DynamoDB page before returning heads and versions', async () => {
  const storage = await import(repoPath);
  const chatId = chat();
  await ownedChat(chatId);
  const first = await storage.saveArtifact(input(chatId));
  await storage.saveArtifact(input(chatId, { artifactId: first.artifactId, expectedVersion: 1,
    body: Buffer.from('second version'), source: { kind: 'revision', fromVersion: 1 } }));
  await storage.saveArtifact(input(chatId, { fileName: 'other.md' }));
  ddbSend.mockImplementation(async (cmd: Parameters<typeof table.send>[0]) => {
    if (cmd instanceof QueryCommand) {
      const prefix = String(cmd.input.ExpressionAttributeValues?.[':prefix'] ?? '');
      if (prefix.includes('#ARTIFACT#')) {
        const matching = [...table.rows.values()].filter((row) => row.PK === 'AGENT#main' &&
          String(row.SK).startsWith(prefix)).sort((a, b) => String(a.SK).localeCompare(String(b.SK)));
        if (!cmd.input.ExclusiveStartKey && matching.length > 1) {
          return { Items: [matching[0]], LastEvaluatedKey: { PK: matching[0].PK, SK: matching[0].SK } };
        }
        const index = matching.findIndex((row) => row.SK === cmd.input.ExclusiveStartKey?.SK);
        return { Items: matching.slice(index + 1) };
      }
    }
    return table.send(cmd);
  });
  const scope = { agentId: 'main', chatId, ownerId: PERSON.userId };
  expect(await storage.listArtifactHeads(scope), 'all heads must remain visible after pagination').toHaveLength(2);
  expect((await storage.listArtifactVersions({ ...scope, artifactId: first.artifactId })).map((v: { version: number }) => v.version),
    'a download must still find the older physical version on a later page').toEqual([1, 2]);
});

it('P4 normalized chat aliases use the same physical artifact erasure prefix', async () => {
  const storage = await import(repoPath);
  const chatId = `dashboard:p4#alias-${Date.now()}`;
  await ownedChat(chatId);
  await storage.saveArtifact(input(chatId));
  const put = s3Send.mock.calls.find(([cmd]) => cmd instanceof PutObjectCommand)?.[0] as PutObjectCommand;
  const listedId = chatId.replace(/#/g, '_');
  expect(put.input.Key?.startsWith(storage.artifactConversationPrefix('main', listedId)),
    'a delete using the listed normalized chat id must enumerate the saved bytes').toBe(true);
});

it('P4 artifact writes refuse a safety scan that covered zero bytes', async () => {
  const storage = await import(repoPath);
  const chatId = chat();
  await ownedChat(chatId);
  scanForExfil.mockResolvedValue({ blocked: false, matches: [], scannedBytes: 0, truncated: false });
  await expect(storage.saveArtifact(input(chatId)),
    'an operator-disabled or incomplete scan cannot admit private CURATED bytes').rejects.toThrow(/scan|safety|refus/i);
  expect(s3Send, 'unscanned bytes must never be uploaded').not.toHaveBeenCalled();
});

it('P4 a deleted finalizing draft cannot recreate its parent or save an artifact', async () => {
  const storage = await import(repoPath);
  const chatId = chat();
  await expect(storage.saveArtifact(input(chatId, { source: { kind: 'draft',
    draftId: 'f78d0000-0000-4000-8000-000000000001', revision: 1, format: 'pdf' } })),
  'a deleted draft is not a first-turn artifact').rejects.toThrow(/draft|missing|conversation|owner/i);
  const { getSession } = await import('../state/sessions-repo.js');
  expect(await getSession('main', chatId), 'finalization must not resurrect the deleted chat').toBeNull();
  expect(s3Send, 'finalization must not write a new physical version').not.toHaveBeenCalled();
});

it('P4 live finalizing draft saves through the document tool metadata key', async () => {
  const storage = await import(repoPath);
  const chatId = chat();
  const draftId = 'f78d0000-0000-4000-8000-000000000002';
  await ownedChat(chatId);
  const row = { PK: 'AGENT#main', SK: `CHAT#${chatId.replace(/#/g, '_')}#DRAFT#${draftId}#META`,
    kind: 'document-draft', draftId, agentId: 'main', chatId, ownerId: PERSON.userId,
    revision: 1, status: 'finalizing', format: 'pdf' };
  table.rows.set(`${row.PK}|${row.SK}`, row);
  await expect(storage.saveArtifact(input(chatId, { source: { kind: 'draft', draftId, revision: 1, format: 'pdf' } })),
    'the real document-draft metadata key must authorize a live finalization').resolves.toMatchObject({ version: 1 });
  expect(s3Send.mock.calls.some(([cmd]) => cmd instanceof PutObjectCommand), 'valid draft bytes must reach CURATED').toBe(true);
});

it('P4 a save after a finished delete never trusts a stale conversation read', async () => {
  const storage = await import(repoPath);
  const chatId = chat();
  await ownedChat(chatId);
  const parentKey = [...table.rows.keys()].find((k) => k === `AGENT#main|CHAT#${chatId.replace(/#/g, '_')}`);
  expect(parentKey, 'fixture must hold the conversation row').toBeDefined();
  const stale = table.rows.get(parentKey!);
  table.rows.delete(parentKey!);
  // DynamoDB may still answer an eventually consistent GetItem with the row a
  // finished delete removed; only a ConsistentRead is guaranteed to miss it.
  ddbSend.mockImplementation((cmd) => {
    const { Key, ConsistentRead } = (cmd as { input?: { Key?: { PK?: string; SK?: string }; ConsistentRead?: boolean } }).input ?? {};
    if (cmd instanceof GetCommand && !ConsistentRead && `${Key?.PK}|${Key?.SK}` === parentKey) {
      return Promise.resolve({ Item: stale });
    }
    return table.send(cmd);
  });
  await storage.saveArtifact(input(chatId)).catch(() => undefined);
  const stored = s3Send.mock.calls.some(([cmd]) => cmd instanceof PutObjectCommand);
  expect(!stored || table.rows.has(parentKey!),
    'an artifact must never be stored under a conversation that no longer exists').toBe(true);
});
