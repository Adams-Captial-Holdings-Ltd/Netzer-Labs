/**
 * P7 (step 9) — work order C, coordinator addition (Jev m1_tool_saves ->
 * thread_to_tools, 1.00): a file a tool saves during a dashboard turn names
 * the turn's request id.
 *
 * Written BEFORE the change, as the bar. Not a frozen gate row (extra
 * verification alongside M1's marker check in appendTurns/saveArtifact,
 * red-C-brief.md).
 *
 * The decided design: the three tools that call saveArtifact during a
 * dashboard turn (document-generation-tools.ts's generate_document,
 * nova-canvas-tools.ts's generate_image, document-draft-tools.ts's
 * document_draft finalize) must pass the turn's request id to saveArtifact as
 * `clientMessageId`, so saveArtifact's missing-row path can check the turn
 * marker (M1). The id travels: the dashboard route's clientMessageId ->
 * AgentTurnRequest.requestId (new optional field) -> agent-loop's per-call
 * toolCtx (new optional ToolContext.requestId, registry.ts) -> each tool
 * passes `clientMessageId: ctx.requestId`. Today ToolContext carries no
 * requestId at all, so saveArtifact never receives clientMessageId; this
 * fails at the assertion below rather than passing by construction (M41/P54).
 *
 * Harness: src/lib/tools/artifact-tools.p4.test.ts (mocks, the `dashboard`
 * ToolContext, spec(), the document/image/draft handlers).
 */
import { beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { S3Client } from '@aws-sdk/client-s3';
import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { createFakeDynamo } from '../../__test-utils__/fake-dynamo.js';
import type { ToolHandler, ToolContext } from './registry.js';

const { registered, saveArtifact, killed, signed, buildPdf, costEnforced, spend, ddbSend, scanForExfil, draftSession, draftLock } = vi.hoisted(() => {
  process.env.RAW_BUCKET = 'p7-tool-raw';
  process.env.CURATED_BUCKET = 'p7-tool-curated';
  return {
    registered: new Map<string, unknown>(),
    saveArtifact: vi.fn(), killed: vi.fn(), signed: vi.fn(), buildPdf: vi.fn(), costEnforced: vi.fn(),
    spend: vi.fn(), ddbSend: vi.fn(), scanForExfil: vi.fn(), draftSession: vi.fn(), draftLock: vi.fn(),
  };
});
vi.mock('./registry.js', () => ({ tools: { register: (name: string, handler: unknown) => registered.set(name, handler) } }));
vi.mock('../addons/registry.js', () => ({ registerIfConfigured: (_record: unknown, register: () => void) => register() }));
vi.mock('../chat/artifacts-repo.js', () => ({ saveArtifact }));
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
const OWNER = 'dashboard:user:p7-owner';
const CHAT = 'dashboard:p7-tool-chat';
const PDF = Buffer.from('%PDF-1.7\nP7 fixture');
const AID = 'f78d0000-0000-4000-8000-000000000002';
const URL = 'http://localhost:4566/p7-tool-raw/file.pdf?X-Amz-Signature=fixture';
const spec = (body: string) => ({ title: 'Launch notes', sections: [{ heading: 'Summary', body }] });
// The turn's own request id (M1's marker key) on an otherwise ordinary
// dashboard ToolContext. ToolContext carries no `requestId` field today.
const dashboard: ToolContext = { agentId: 'main', chatId: CHAT, surface: 'dashboard', userId: OWNER, requestId: 'req-p7' } as ToolContext;
const documentHandler = () => registered.get('generate_document') as ToolHandler | undefined;
const draftModulePath = './document-draft-tools.js';
const draftHandler = () => registered.get('document_draft') as ToolHandler | undefined;

beforeAll(async () => {
  await import('./document-generation-tools.js');
  await import('./nova-canvas-tools.js');
  await import(draftModulePath).catch(() => null);
});
beforeEach(() => {
  vi.restoreAllMocks();
  draftTable = createFakeDynamo();
  ddbSend.mockReset().mockImplementation((cmd: Parameters<typeof draftTable.send>[0]) => draftTable.send(cmd));
  scanForExfil.mockReset().mockImplementation(async (text: string) => ({ blocked: false, truncated: false, matches: [], scannedBytes: text.length }));
  draftSession.mockReset().mockResolvedValue({ agentId: 'main', chatId: CHAT, userId: OWNER, surface: 'dashboard', turns: [] });
  draftLock.mockReset().mockResolvedValue(async () => {});
  saveArtifact.mockReset().mockImplementation(async (args: { artifactId?: string; expectedVersion?: number; fileName: string; contentType: string }) => ({
    artifactId: args.artifactId ?? AID, version: args.expectedVersion ? args.expectedVersion + 1 : 1,
    fileName: args.fileName, contentType: args.contentType, createdAt: '2026-09-28T00:00:00.000Z',
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

it('P7 a file a tool saves during a dashboard turn names the turn\'s request id', async () => {
  // generate_document
  expect(documentHandler(), 'generate_document must be registered').toBeDefined();
  await documentHandler()!.invoke({ format: 'pdf', spec: spec('First edition') }, dashboard);
  expect(saveArtifact, 'generate_document must have saved once').toHaveBeenCalledOnce();
  expect(saveArtifact.mock.calls[0]![0], 'generate_document must name the turn\'s request id')
    .toMatchObject({ clientMessageId: 'req-p7' });

  // generate_image
  saveArtifact.mockClear();
  const imageHandler = registered.get('generate_image') as ToolHandler | undefined;
  expect(imageHandler, 'generate_image must be registered').toBeDefined();
  await imageHandler!.invoke({ prompt: 'blue horizon' }, dashboard);
  expect(saveArtifact, 'generate_image must have saved once').toHaveBeenCalledOnce();
  expect(saveArtifact.mock.calls[0]![0], 'generate_image must name the turn\'s request id')
    .toMatchObject({ clientMessageId: 'req-p7' });

  // document_draft (finalize is the call that reaches saveArtifact)
  saveArtifact.mockClear();
  expect(draftHandler(), 'document_draft must be registered').toBeDefined();
  const start = await draftHandler()!.invoke(
    { action: 'start', format: 'pdf', title: 'Report', operationId: 'p7-start' }, dashboard);
  const { draftId } = JSON.parse(start.text) as { draftId: string };
  await draftHandler()!.invoke(
    { action: 'append', draftId, expectedRevision: 0, operationId: 'p7-section', section: { heading: 'Opening', body: 'first chapter' } },
    dashboard);
  await draftHandler()!.invoke(
    { action: 'finalize', draftId, expectedRevision: 1, operationId: 'p7-final' }, dashboard);
  expect(saveArtifact, 'document_draft must have saved once, at finalize').toHaveBeenCalledOnce();
  expect(saveArtifact.mock.calls[0]![0], 'document_draft must name the turn\'s request id')
    .toMatchObject({ clientMessageId: 'req-p7' });
});
