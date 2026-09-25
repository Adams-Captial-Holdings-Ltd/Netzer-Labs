/** P4 tool write-through contract. Each behavior was frozen before product edits. */
import { beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { S3Client } from '@aws-sdk/client-s3';
import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import type { ToolHandler, ToolContext } from './registry.js';

const { registered, saveArtifact, killed, signed, buildPdf, costEnforced, spend } = vi.hoisted(() => {
  process.env.RAW_BUCKET = 'p4-tool-raw';
  process.env.CURATED_BUCKET = 'p4-tool-curated';
  return {
    registered: new Map<string, unknown>(),
    saveArtifact: vi.fn(), killed: vi.fn(), signed: vi.fn(), buildPdf: vi.fn(), costEnforced: vi.fn(), spend: vi.fn(),
  };
});
vi.mock('./registry.js', () => ({ tools: { register: (name: string, handler: unknown) => registered.set(name, handler) } }));
vi.mock('../addons/registry.js', () => ({ registerIfConfigured: (_record: unknown, register: () => void) => register() }));
vi.mock('../chat/artifacts-repo.js', () => ({ saveArtifact }));
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
