/**
 * P3 (step 5) — the shared media pipeline's half of attachments.
 *
 * Written BEFORE the change, as the bar (netzar-chat-plan/p3-proof.sh rows K-1..K-6,
 * F-9). What each block pins:
 *
 *   - Owner decision 3: "Explicit per-file opt-in, default off; attachments otherwise
 *     stay conversation-private." Today every chat document, on every surface, is
 *     imported into the agent's shared knowledge base automatically. After P3 only a
 *     dashboard file whose sender opted in is; Telegram and Slack have no opt-in
 *     control, so theirs never are.
 *   - With the automatic import gone, a document still has to reach the model (the
 *     step's goal: files are "model-usable"). The council's unanimous answer: send it
 *     directly as a Bedrock document block, within Bedrock's documented limits — per
 *     message up to five documents of 4.5 MB and twenty images of 3.75 MB (AWS
 *     Converse API reference). A .pptx is not a Bedrock document format, so its
 *     extracted text goes instead. A file over a limit is stored, not shown to the
 *     model, and the ack says so plainly — the old 20 MB "Bedrock cap" would have made
 *     Bedrock reject the whole turn.
 *   - WI-3.2: an Office file passes the bounded ZIP check before anything opens it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import JSZip from 'jszip';

const { killSwitchMock, ingestChatMediaMock, s3SendMock } = vi.hoisted(() => ({
  killSwitchMock: vi.fn(),
  ingestChatMediaMock: vi.fn(),
  s3SendMock: vi.fn(),
}));

vi.mock('../state/kill-switches-repo.js', () => ({ isKillSwitchActive: killSwitchMock }));
vi.mock('../transcribe/transcriber.js', () => ({ transcribeAudio: vi.fn() }));
vi.mock('./chat-kb-ingest.js', () => ({
  ingestChatMedia: ingestChatMediaMock,
  ingestFormatFor: (name: string) => (/\.(pdf|docx|pptx|txt|md|csv|html)$/i.test(name) ? 'text' : null),
  buildKbConfirmation: vi.fn(),
}));
vi.mock('../audit/audit-writer.js', () => ({ writeAudit: vi.fn() }));
vi.mock('../state/runtime-config-repo.js', () => ({ getConfig: vi.fn(async () => undefined) }));
vi.mock('../video/frames.js', () => ({
  probeVideo: vi.fn(),
  extractKeyframes: vi.fn(),
  extractAudioTrack: vi.fn(),
  writeTempFile: vi.fn(),
}));
vi.mock('../observability/xray.js', () => ({ captureAwsClient: <T,>(c: T): T => c }));
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class {
    send = s3SendMock;
  },
  PutObjectCommand: class {
    constructor(public input: unknown) {}
  },
  GetObjectCommand: class {
    constructor(public input: unknown) {}
  },
}));

process.env.RAW_BUCKET = 'raw-test-bucket';
const { processMedia } = await import('./process.js');

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
// Bedrock's documented per-block limits, read in the smaller (decimal) sense so a
// file we inline can never be one Bedrock refuses.
const DOC_LIMIT = 4_500_000;
const IMAGE_LIMIT = 3_750_000;

function input(over: Record<string, unknown>) {
  return {
    surface: 'dashboard' as const,
    agentId: 'main',
    targetAgentId: 'main',
    chatId: 'dashboard:1750000000001',
    kind: 'document' as const,
    fileName: 'notes.txt',
    mimeType: 'text/plain',
    bytes: Buffer.from('meeting notes: ship on Friday'),
    ...over,
  };
}

async function docx(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types/>');
  zip.file('word/document.xml', '<w:document><w:body><w:p><w:r><w:t>Budget draft</w:t></w:r></w:p></w:body></w:document>');
  return Buffer.from(await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }));
}

async function pptx(text: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types/>');
  zip.file('ppt/slides/slide1.xml', `<p:sld><p:cSld><p:spTree><a:t>${text}</a:t></p:spTree></p:cSld></p:sld>`);
  return Buffer.from(await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }));
}

beforeEach(() => {
  vi.clearAllMocks();
  killSwitchMock.mockResolvedValue({ active: false });
  s3SendMock.mockResolvedValue({});
  ingestChatMediaMock.mockResolvedValue({ docId: 'chat-1', scope: 'main', chunks: 2, deduped: false });
});

describe('chat attachments (P3) — the media pipeline', () => {
  it('keeps a chat document out of the knowledge base unless the sender opts in', async () => {
    for (const surface of ['dashboard', 'slack', 'telegram'] as const) {
      const out = await processMedia(input({ surface }));
      expect(out.kb ?? null, surface).toBeNull();
    }
    expect(ingestChatMediaMock).not.toHaveBeenCalled();
  });

  it('imports a chat document the sender opted in, and only that one', async () => {
    const opted = await processMedia(input({ fileName: 'opted.txt', addToKnowledge: true }));
    await processMedia(input({ fileName: 'private.txt' }));

    expect(ingestChatMediaMock).toHaveBeenCalledTimes(1);
    expect(ingestChatMediaMock).toHaveBeenCalledWith(expect.objectContaining({ fileName: 'opted.txt' }));
    expect(opted.kb).toEqual(expect.objectContaining({ docId: 'chat-1' }));
  });

  it('sends a small document to the model as a document block', async () => {
    const cases: Array<[string, string, Buffer, string]> = [
      ['notes.txt', 'text/plain', Buffer.from('plain notes'), 'txt'],
      ['table.csv', 'text/csv', Buffer.from('a,b\n1,2'), 'csv'],
      ['readme.md', 'text/markdown', Buffer.from('# Title'), 'md'],
      ['report.pdf', 'application/pdf', Buffer.from('%PDF-1.4 tiny'), 'pdf'],
      ['budget.docx', DOCX, await docx(), 'docx'],
    ];
    for (const [fileName, mimeType, bytes, format] of cases) {
      const out = await processMedia(input({ fileName, mimeType, bytes }));
      expect(out.blocks, fileName).toEqual([expect.objectContaining({ kind: 'document', format })]);
      expect(out.ackText, fileName).toBe('');
    }
  });

  it('reads a slide deck to the model as its text', async () => {
    const out = await processMedia(input({ fileName: 'plan.pptx', mimeType: PPTX, bytes: await pptx('Roadmap for Q3') }));

    // Bedrock has no pptx document format, so the deck's own words go instead.
    expect(out.blocks).toHaveLength(1);
    const block = out.blocks[0]!;
    expect(block).toMatchObject({ kind: 'document', format: 'txt' });
    expect(Buffer.from(block.bytes).toString('utf8')).toContain('Roadmap for Q3');
  });

  it('says plainly when a document is too large for the model', async () => {
    const big = Buffer.concat([Buffer.from('%PDF-1.4 '), Buffer.alloc(DOC_LIMIT, 0x20)]);
    expect(big.length).toBeGreaterThan(DOC_LIMIT);

    const out = await processMedia(input({ fileName: 'annual-report.pdf', mimeType: 'application/pdf', bytes: big }));

    expect(out.blocks).toHaveLength(0);
    expect(out.ackText).toContain('annual-report.pdf');
    expect(out.ackText).toMatch(/4\.5 MB/);
    // The file itself is still stored: it can be downloaded again, just not read inline.
    expect(out.s3Key).not.toBe('');
  });

  it('does not inline an image over the model limit', async () => {
    const jpeg = (size: number) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(size - 4, 1)]);

    const over = await processMedia(input({ kind: 'photo', fileName: 'scan.jpg', mimeType: 'image/jpeg', bytes: jpeg(IMAGE_LIMIT + 1) }));
    expect(over.blocks).toHaveLength(0);
    expect(over.ackText).toContain('scan.jpg');
    expect(over.ackText).toMatch(/3\.75 MB/);

    const at = await processMedia(input({ kind: 'photo', fileName: 'ok.jpg', mimeType: 'image/jpeg', bytes: jpeg(IMAGE_LIMIT) }));
    expect(at.blocks).toEqual([expect.objectContaining({ kind: 'image', format: 'jpeg' })]);
  });

  it('checks an office file before reading it', async () => {
    // A real ZIP with 1,001 entries: over the bounded check's 1,000-entry default.
    const zip = new JSZip();
    for (let i = 0; i <= 1000; i++) zip.file(`word/part${i}.xml`, '<x/>');
    const crowded = Buffer.from(await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }));

    // Even opted in: a file that fails the check is neither read nor imported.
    const out = await processMedia(input({ fileName: 'crowded.docx', mimeType: DOCX, bytes: crowded, addToKnowledge: true }));

    expect(out.blocks).toHaveLength(0);
    expect(ingestChatMediaMock).not.toHaveBeenCalled();
    expect(out.ackText).toContain('crowded.docx');
  });
});
