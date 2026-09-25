/** P4 tool write-through contract. Each behavior was frozen before product edits. */
import { beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { S3Client } from '@aws-sdk/client-s3';
import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import JSZip from 'jszip';
import { readFileSync } from 'node:fs';
import { createFakeDynamo } from '../../__test-utils__/fake-dynamo.js';
import type { ToolHandler, ToolContext } from './registry.js';

const { registered, saveArtifact, readArtifactBody, getArtifactVersion, killed, signed, buildPdf, costEnforced, spend, ddbSend, scanForExfil, draftSession, draftLock } = vi.hoisted(() => {
  process.env.RAW_BUCKET = 'p4-tool-raw';
  process.env.CURATED_BUCKET = 'p4-tool-curated';
  return {
    registered: new Map<string, unknown>(),
    saveArtifact: vi.fn(), readArtifactBody: vi.fn(), getArtifactVersion: vi.fn(), killed: vi.fn(), signed: vi.fn(), buildPdf: vi.fn(), costEnforced: vi.fn(), spend: vi.fn(), ddbSend: vi.fn(), scanForExfil: vi.fn(), draftSession: vi.fn(), draftLock: vi.fn(),
  };
});
vi.mock('./registry.js', () => ({ tools: { register: (name: string, handler: unknown) => registered.set(name, handler) } }));
vi.mock('../addons/registry.js', () => ({ registerIfConfigured: (_record: unknown, register: () => void) => register() }));
vi.mock('../chat/artifacts-repo.js', () => ({ saveArtifact, readArtifactBody, getArtifactVersion }));
vi.mock('../state/ddb.js', () => ({ ddb: () => ({ send: ddbSend }) }));
vi.mock('../safety/exfil-guard.js', async (importActual) => {
  const actual = await importActual<typeof import('../safety/exfil-guard.js')>();
  return { ...actual, scanForExfil };
});
vi.mock('../state/sessions-repo.js', async (importActual) => {
  const actual = await importActual<typeof import('../state/sessions-repo.js')>();
  return { ...actual, getSession: draftSession, acquireConversationChildLock: draftLock };
});
vi.mock('../documents/pdf.js', () => ({ buildPdf }));
vi.mock('../documents/docx.js', () => ({ buildDocx: async () => Buffer.from('DOCX') }));
vi.mock('../documents/xlsx.js', () => ({ buildXlsx: async () => Buffer.from('XLSX') }));
vi.mock('../state/kill-switches-repo.js', () => ({ isKillSwitchActive: killed }));
vi.mock('../state/cost-cap-repo.js', () => ({ isCostCapEnforced: costEnforced, getEffectiveCostCap: async () => 100 }));
vi.mock('../usage/token-tracker.js', async (importActual) => {
  const actual = await importActual<typeof import('../usage/token-tracker.js')>();
  return { ...actual, getDailyCostUsd: spend };
});
vi.mock('../audit/audit-writer.js', () => ({ writeAudit: vi.fn() }));
vi.mock('../state/runtime-config-repo.js', () => ({ getConfig: async () => undefined }));
vi.mock('../state/rate-limits-repo.js', () => ({ checkAndConsumeStrict: async () => ({ allowed: true }) }));
vi.mock('../bedrock/guard.js', () => ({ guardedBedrockSend: (send: () => Promise<unknown>) => send() }));
vi.mock('../observability/xray.js', () => ({ captureAwsClient: <T,>(client: T): T => client }));
vi.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: signed }));

let draftTable: ReturnType<typeof createFakeDynamo>;
const OWNER = 'dashboard:user:p4-owner';
const CHAT = 'dashboard:p4-tool-chat';
const PDF = Buffer.from('%PDF-1.7\nP4 fixture');
const AID = 'f78d0000-0000-4000-8000-000000000001';
const URL = 'http://localhost:4566/p4-tool-raw/file.pdf?X-Amz-Signature=fixture';
const spec = (body: string) => ({ title: 'Launch notes', sections: [{ heading: 'Summary', body }] });
const dashboard: ToolContext = { agentId: 'main', chatId: CHAT, surface: 'dashboard', userId: OWNER };
const legacy = (surface: 'telegram' | 'slack'): ToolContext => ({ agentId: 'main', chatId: `${surface}:p4`, surface, userId: 'person' });
const documentHandler = () => registered.get('generate_document') as ToolHandler | undefined;
const artifactView = (result: unknown): Array<Record<string, unknown>> | undefined =>
  (result as { artifacts?: Array<Record<string, unknown>> }).artifacts;

beforeAll(async () => {
  await import('./document-generation-tools.js');
  await import('./nova-canvas-tools.js');
});
beforeEach(() => {
  vi.restoreAllMocks();
  draftTable = createFakeDynamo();
  ddbSend.mockReset().mockImplementation((cmd: Parameters<typeof draftTable.send>[0]) => draftTable.send(cmd));
  scanForExfil.mockReset().mockImplementation(async (text: string) => ({ blocked: false, truncated: false, matches: [], scannedBytes: text.length }));
  draftSession.mockReset().mockResolvedValue({ agentId: 'main', chatId: CHAT, userId: OWNER, surface: 'dashboard', turns: [] });
  draftLock.mockReset().mockResolvedValue(async () => {});
  readArtifactBody.mockReset();
  getArtifactVersion.mockReset().mockResolvedValue({ artifactId: AID, version: 1, fileName: 'notes.txt', contentType: 'text/plain', createdAt: '2026-09-25T00:00:00.000Z', source: {} });
  saveArtifact.mockReset().mockImplementation(async (args: { artifactId?: string; expectedVersion?: number; fileName: string; contentType: string }) => ({
    artifactId: args.artifactId ?? AID, version: args.expectedVersion ? args.expectedVersion + 1 : 1,
    fileName: args.fileName, contentType: args.contentType, createdAt: '2026-09-25T00:00:00.000Z',
  }));
  killed.mockReset().mockResolvedValue({ active: false });
  costEnforced.mockReset().mockResolvedValue(false);
  spend.mockReset().mockResolvedValue(0);
  signed.mockReset().mockResolvedValue(URL);
  buildPdf.mockReset().mockResolvedValue(PDF);
  vi.spyOn(S3Client.prototype, 'send').mockResolvedValue({} as never);
  vi.spyOn(BedrockRuntimeClient.prototype, 'send').mockResolvedValue({
    body: Buffer.from(JSON.stringify({ images: [Buffer.from('PNGDATA').toString('base64')] })),
  } as never);
});

it('P4 document tool stores dashboard output without model facing URLs', async () => {
  expect(documentHandler(), 'generate_document must remain registered').toBeDefined();
  const result = await documentHandler()!.invoke({ format: 'pdf', spec: spec('First edition') }, dashboard);
  expect(saveArtifact, 'stable dashboard output must be durably written before success').toHaveBeenCalledOnce();
  expect(saveArtifact.mock.calls[0][0]).toMatchObject({ agentId: 'main', chatId: CHAT, ownerId: OWNER,
    contentType: 'application/pdf', body: PDF });
  expect(artifactView(result)).toMatchObject([{ artifactId: AID, version: 1, fileName: 'Launch_notes.pdf' }]);
  expect(JSON.stringify(result), 'model/surface result carries only URL-free artifact references')
    .not.toMatch(/X-Amz-|presignedUrl|s3Bucket|s3Key|p4-tool-raw/i);
  expect(result.text).not.toMatch(/https?:\/\/|X-Amz-/i);
});

it('P4 legacy surfaces retain their existing file delivery', async () => {
  for (const surface of ['telegram', 'slack'] as const) {
    const result = await documentHandler()!.invoke({ format: 'pdf', spec: spec(surface) }, legacy(surface));
    expect(result.text).toContain(URL);
    expect(result.media).toMatchObject([{ kind: 'artifact', presignedUrl: URL,
      s3Bucket: 'p4-tool-raw', contentType: 'application/pdf' }]);
  }
  expect(saveArtifact, 'legacy surfaces do not create durable dashboard artifacts').not.toHaveBeenCalled();
});

it('P4 document revision preserves prior bytes and requires its source version', async () => {
  const first = await documentHandler()!.invoke({ format: 'pdf', spec: spec('First') }, dashboard);
  expect(artifactView(first)).toMatchObject([{ artifactId: AID, version: 1 }]);
  const withoutFence = await documentHandler()!.invoke({ format: 'pdf', spec: spec('Second'), artifactId: AID }, dashboard);
  expect(withoutFence.isError, 'a revision without expectedVersion must be refused').toBe(true);
  expect(saveArtifact).toHaveBeenCalledTimes(1);
  const revised = await documentHandler()!.invoke({ format: 'pdf', spec: spec('Second'),
    artifactId: AID, expectedVersion: 1 }, dashboard);
  expect(artifactView(revised)).toMatchObject([{ artifactId: AID, version: 2 }]);
  expect(saveArtifact.mock.calls[1][0]).toMatchObject({ artifactId: AID, expectedVersion: 1,
    source: { kind: 'revision', fromVersion: 1 } });
});

it('P4 generation preserves cost kill switch and abort controls', async () => {
  killed.mockResolvedValueOnce({ active: true, reason: 'operator' });
  const denied = await documentHandler()!.invoke({ format: 'pdf', spec: spec('Blocked') }, dashboard);
  expect(denied.isError).toBe(true);
  expect(saveArtifact).not.toHaveBeenCalled();
  costEnforced.mockResolvedValueOnce(true);
  spend.mockResolvedValueOnce(100);
  const capped = await documentHandler()!.invoke({ format: 'pdf', spec: spec('Capped') }, dashboard);
  expect(capped.isError, 'the tool must re-check the daily cap').toBe(true);
  expect(saveArtifact).not.toHaveBeenCalled();
  const abort = new AbortController();
  abort.abort();
  const stopped = await documentHandler()!.invoke({ format: 'pdf', spec: spec('Stopped') },
    { ...dashboard, abortSignal: abort.signal } as ToolContext);
  expect(stopped.isError, 'an aborted turn cannot start a storage write').toBe(true);
  expect(saveArtifact).not.toHaveBeenCalled();
  expect(S3Client.prototype.send).not.toHaveBeenCalled();
});


it('P4 image tool stores dashboard output without model facing URLs', async () => {
  const imageHandler = registered.get('generate_image') as ToolHandler | undefined;
  expect(imageHandler, 'generate_image must stay registered').toBeDefined();
  const result = await imageHandler!.invoke({ prompt: 'blue horizon' }, dashboard);
  expect(saveArtifact, 'image bytes must be durable before success').toHaveBeenCalledOnce();
  expect(saveArtifact.mock.calls[0][0]).toMatchObject({ agentId: 'main', chatId: CHAT, ownerId: OWNER,
    contentType: 'image/png', body: Buffer.from('PNGDATA') });
  expect(artifactView(result)).toMatchObject([{ artifactId: AID, version: 1, contentType: 'image/png' }]);
  expect(JSON.stringify(result), 'dashboard result must not carry a RAW URL or storage key')
    .not.toMatch(/X-Amz-|presignedUrl|s3Bucket|s3Key|p4-tool-raw/i);
  expect(S3Client.prototype.send, 'no duplicate RAW image copy').not.toHaveBeenCalled();
  expect(result.isError).not.toBe(true);
});

it('P4 PowerPoint round trip keeps slide text in valid OOXML', async () => {
  const result = await documentHandler()!.invoke({ format: 'pptx', spec: {
    title: 'Launch deck', slides: [{ title: 'Launch', body: 'A planned launch' }],
  } }, dashboard);
  expect(result.isError, 'ART-11 slide specs must be accepted by the document tool').not.toBe(true);
  expect(saveArtifact, 'a PPTX must be durably stored before success').toHaveBeenCalledOnce();
  const stored = saveArtifact.mock.calls[0]![0] as { contentType: string; fileName: string; body: Uint8Array };
  expect(stored.contentType).toBe('application/vnd.openxmlformats-officedocument.presentationml.presentation');
  expect(stored.fileName).toMatch(/\.pptx$/);
  expect(Buffer.from(stored.body).subarray(0, 2).toString('ascii')).toBe('PK');
  const zip = await JSZip.loadAsync(Buffer.from(stored.body));
  expect(zip.file('[Content_Types].xml')).not.toBeNull();
  const slide = await zip.file('ppt/slides/slide1.xml')?.async('string');
  expect(slide).toContain('Launch');
  expect(slide).toContain('A planned launch');
  expect(artifactView(result)).toMatchObject([{ artifactId: AID, version: 1 }]);
  expect(JSON.stringify(result)).not.toMatch(/X-Amz-|s3Bucket|s3Key|presignedUrl/);
});

const draftModulePath = './document-draft-tools.js';
const draftHandler = () => registered.get('document_draft') as ToolHandler | undefined;

it('P4 incremental document calls retain earlier sections across turns', async () => {
  await import(draftModulePath).catch(() => null);
  expect(draftHandler(), 'cross-turn document_draft must be registered').toBeDefined();
  expect(readFileSync('src/server.ts', 'utf8')).toContain("import './lib/tools/document-draft-tools.js';");
  buildPdf.mockImplementation(async (assembled: unknown) => Buffer.from(JSON.stringify(assembled)));
  const start = await draftHandler()!.invoke({ action: 'start', format: 'pdf', title: 'Long report', operationId: 'start-1' },
    { ...dashboard });
  expect(start.isError).not.toBe(true);
  const created = JSON.parse(start.text) as { draftId: string; revision: number };
  expect(created).toMatchObject({ draftId: expect.any(String), revision: 0 });
  expect(saveArtifact, 'a draft is not yet a downloadable artifact').not.toHaveBeenCalled();

  const first = await draftHandler()!.invoke({ action: 'append', draftId: created.draftId,
    expectedRevision: 0, operationId: 'section-1', section: { heading: 'Opening', body: 'first chapter' } },
    { ...dashboard });
  expect(JSON.parse(first.text)).toMatchObject({ revision: 1 });
  const second = await draftHandler()!.invoke({ action: 'append', draftId: created.draftId,
    expectedRevision: 1, operationId: 'section-2', section: { heading: 'Ending', body: 'second chapter' } },
    { ...dashboard });
  expect(JSON.parse(second.text)).toMatchObject({ revision: 2 });
  expect(saveArtifact).not.toHaveBeenCalled();

  const final = await draftHandler()!.invoke({ action: 'finalize', draftId: created.draftId,
    expectedRevision: 2, operationId: 'final-1' }, { ...dashboard });
  expect(artifactView(final)).toMatchObject([{ artifactId: AID, version: 1 }]);
  expect(saveArtifact).toHaveBeenCalledOnce();
  const stored = saveArtifact.mock.calls[0][0] as { body: Uint8Array; source: Record<string, unknown> };
  const bytes = Buffer.from(stored.body).toString('utf8');
  expect(bytes).toContain('first chapter');
  expect(bytes).toContain('second chapter');
  expect(stored.source).toMatchObject({ kind: 'draft', draftId: created.draftId, revision: 2 });
  expect(JSON.stringify(stored.source), 'lineage must not pack the full source into one DDB item')
    .not.toMatch(/first chapter|second chapter/);
});

it('P4 incremental draft append is owner scoped and idempotent', async () => {
  await import(draftModulePath).catch(() => null);
  expect(draftHandler()).toBeDefined();
  const start = await draftHandler()!.invoke({ action: 'start', format: 'pdf', title: 'Draft', operationId: 'start-2' }, dashboard);
  const { draftId } = JSON.parse(start.text) as { draftId: string };
  const unit = { action: 'append', draftId, expectedRevision: 0, operationId: 'one',
    section: { body: 'a single section' } };
  const foreign = await draftHandler()!.invoke(unit, { ...dashboard, userId: 'dashboard:user:other' });
  expect(foreign.isError, 'another dashboard owner cannot append').toBe(true);
  const first = await draftHandler()!.invoke(unit, dashboard);
  const retry = await draftHandler()!.invoke(unit, dashboard);
  expect(JSON.parse(first.text)).toMatchObject({ revision: 1 });
  expect(JSON.parse(retry.text), 'replaying an operation cannot duplicate a section').toMatchObject({ revision: 1 });
  const stale = await draftHandler()!.invoke({ ...unit, operationId: 'two' }, dashboard);
  expect(stale.isError, 'a new operation with stale expectedRevision must fail').toBe(true);
});

it('P4 incremental draft rejects unsafe or oversized sections before persistence', async () => {
  await import(draftModulePath).catch(() => null);
  expect(draftHandler()).toBeDefined();
  const start = await draftHandler()!.invoke({ action: 'start', format: 'pdf', title: 'Draft', operationId: 'start-3' }, dashboard);
  const { draftId } = JSON.parse(start.text) as { draftId: string };
  const before = draftTable.rows.size;
  scanForExfil.mockImplementation(async (text: string) => ({ blocked: text.includes('BLOCKED_SECRET'),
    truncated: false, scannedBytes: text.length, matches: [] }));
  const secret = await draftHandler()!.invoke({ action: 'append', draftId, expectedRevision: 0,
    operationId: 'unsafe', section: { body: 'BLOCKED_SECRET' } }, dashboard);
  expect(secret.isError).toBe(true);
  const oversized = await draftHandler()!.invoke({ action: 'append', draftId, expectedRevision: 0,
    operationId: 'oversized', section: { body: 'x'.repeat(500 * 1024) } }, dashboard);
  expect(oversized.isError).toBe(true);
  expect(draftTable.rows.size, 'unsafe or oversized sections must not become child rows').toBe(before);
  expect(saveArtifact).not.toHaveBeenCalled();
});

it('P4 artifact read tool refuses another owner and returns bounded content', async () => {
  const modulePath = './artifact-read-tools.js';
  await import(modulePath).catch(() => null);
  const handler = registered.get('read_artifact') as ToolHandler | undefined;
  expect(handler, 'read_artifact must be registered for revision and inspection').toBeDefined();
  expect(readFileSync('src/server.ts', 'utf8')).toContain("import './lib/tools/artifact-read-tools.js';");
  readArtifactBody.mockResolvedValue(Buffer.from('A'.repeat(16_000)));
  const result = await handler!.invoke({ artifactId: AID, version: 1 }, dashboard);
  expect(result.isError).not.toBe(true);
  expect(result.text.length, 'model-visible content must have a fixed safe bound').toBeLessThanOrEqual(9_000);
  expect(result.text).toContain('AAAA');
  expect(readArtifactBody).toHaveBeenCalledWith({ agentId: 'main', chatId: CHAT, ownerId: OWNER,
    artifactId: AID, version: 1 });
  readArtifactBody.mockRejectedValueOnce(new Error('private storage key for foreign owner'));
  const foreign = await handler!.invoke({ artifactId: AID, version: 1 }, dashboard);
  expect(foreign.isError).toBe(true);
  expect(foreign.text).not.toMatch(/private storage key|s3|https?:\/\//i);
});
