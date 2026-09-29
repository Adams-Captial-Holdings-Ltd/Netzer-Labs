/**
 * P7 (step 9) — work order C at the artifact store: a file saved after its
 * chat was deleted mid-turn is refused and the chat is not re-created (M1,
 * council 3-0 dashboard_marker).
 *
 * Written BEFORE the change, as the bar (netzar-chat-plan/p7-proof.sh row
 * E-2). Follows src/lib/chat/artifacts-repo.p4.test.ts's harness (fake-dynamo,
 * the real presigner, S3 intercepted at the SDK).
 *
 * The decided design: saveArtifact receives the turn's clientMessageId
 * (threaded through its args); on its missing-row path — where it calls
 * appendTurns(..., []) to re-create the conversation for a first-turn
 * artifact — it first confirms the dashboard turn marker exists (a
 * consistent Get) and otherwise refuses without re-creating anything. Today
 * there is no such check: a missing session always re-creates the chat
 * before checking anything about the turn that is saving into it, so this
 * fails at the assertion below rather than passing by construction (M41/P54).
 */
import { beforeEach, expect, it, vi } from 'vitest';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { createFakeDynamo } from '../../__test-utils__/fake-dynamo.js';

const { ddbSend, scanForExfil } = vi.hoisted(() => {
  process.env.TABLE_SESSIONS = 'p7-unit-sessions';
  process.env.CURATED_BUCKET = 'p7-unit-curated';
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

const PERSON = { surface: 'dashboard' as const, userId: 'dashboard:user:p7-owner', ephemeral: false };
const repoPath = './artifacts-repo.js';
let table: ReturnType<typeof createFakeDynamo>;
const spyS3 = () => vi.spyOn(S3Client.prototype, 'send');
let s3Send: ReturnType<typeof spyS3>;
let physicalVersion: number;
let bodies: Map<string, Buffer>;
const chat = () => `dashboard:p7-e2-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const input = (chatId: string, other: Record<string, unknown> = {}) => ({
  agentId: 'main', chatId, ownerId: PERSON.userId,
  fileName: 'incident-note.md', contentType: 'text/markdown',
  body: Buffer.from('# Incident\nFirst draft.'),
  source: { kind: 'grammar', identifier: 'incident-note' },
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

it('P7 a file saved after its chat was deleted mid-turn is refused and the chat is not re-created', async () => {
  const storage = await import(repoPath);
  const { getSession } = await import('../state/sessions-repo.js');
  const chatId = chat();
  expect(await getSession('main', chatId), 'the chat must start out missing, as a deleted-mid-turn chat is').toBeNull();

  await expect(
    storage.saveArtifact(input(chatId, { clientMessageId: 'e2-gone-marker-1' })),
    'a save whose turn marker is missing must refuse before recreating the chat',
  ).rejects.toThrow();

  expect(await getSession('main', chatId), 'a refused save must not leave a re-created chat behind').toBeNull();
  expect(s3Send, 'nothing is uploaded when the save is refused before it starts').not.toHaveBeenCalled();
});
