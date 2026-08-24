import { describe, it, expect, vi, beforeEach } from 'vitest';
import JSZip from 'jszip';
import {
  PdfExtractionError,
  DocxExtractionError,
  PptxExtractionError,
  extractPdfText,
  extractDocxText,
  extractPptxText,
} from './extractors.js';
import { detectFormat, ingestDocument } from './ingest.js';

// Stub embeddings + the S3 store so ingestDocument runs with no AWS in the
// loop. embedMany returns one entry per chunk; a `null` entry models a Bedrock
// embed failure for that chunk (the real embedder returns null, never a zero
// vector, on failure). putDocument captures the rows that would be written so
// we can assert that failed chunks are NOT indexed.
const { embedManyMock, putDocumentMock } = vi.hoisted(() => ({
  embedManyMock: vi.fn(),
  putDocumentMock: vi.fn(),
}));

vi.mock('./embedder.js', () => ({
  embedMany: embedManyMock,
}));

// Partial mock: only the S3-touching writes are stubbed. `normalizeScope` is a
// pure helper and MUST stay real here — re-implementing its regex in the mock
// would let the test pass while write and read folded scopes differently, which
// is the exact defect it guards (see src/lib/vectors/store.scope.test.ts).
vi.mock('./store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./store.js')>()),
  putDocument: putDocumentMock,
  deleteDocument: vi.fn(),
}));

describe('extractPdfText', () => {
  it('rejects empty buffers', async () => {
    await expect(extractPdfText(Buffer.alloc(0))).rejects.toBeInstanceOf(
      PdfExtractionError,
    );
  });

  it('rejects non-PDF magic bytes', async () => {
    await expect(extractPdfText(Buffer.from('hello world'))).rejects.toBeInstanceOf(
      PdfExtractionError,
    );
  });
});

describe('extractDocxText', () => {
  it('rejects empty buffers', async () => {
    await expect(extractDocxText(Buffer.alloc(0))).rejects.toBeInstanceOf(
      DocxExtractionError,
    );
  });

  it('rejects non-zip magic bytes', async () => {
    await expect(extractDocxText(Buffer.from('not a zip'))).rejects.toBeInstanceOf(
      DocxExtractionError,
    );
  });
});

describe('extractPptxText', () => {
  it('rejects empty buffers', async () => {
    await expect(extractPptxText(Buffer.alloc(0))).rejects.toBeInstanceOf(
      PptxExtractionError,
    );
  });

  it('rejects non-zip magic bytes', async () => {
    await expect(extractPptxText(Buffer.from('not a zip'))).rejects.toBeInstanceOf(
      PptxExtractionError,
    );
  });

  it('rejects a zip with no slides', async () => {
    const zip = new JSZip();
    zip.file('docProps/app.xml', '<Properties/>');
    const buf = Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }));
    await expect(extractPptxText(buf)).rejects.toBeInstanceOf(PptxExtractionError);
  });

  it('extracts <a:t> runs from slides in order, decoding entities', async () => {
    const zip = new JSZip();
    zip.file('ppt/slides/slide2.xml', '<p:sld><a:t>Second</a:t> <a:t>slide</a:t></p:sld>');
    zip.file('ppt/slides/slide1.xml', '<p:sld><a:t>Roadmap &amp; Goals</a:t></p:sld>');
    zip.file('ppt/slides/slide10.xml', '<p:sld><a:t>Tenth</a:t></p:sld>');
    const buf = Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }));
    const out = await extractPptxText(buf);
    expect(out.slides).toBe(3);
    // slide1 before slide2 before slide10 (numeric, not lexical, order).
    expect(out.text).toBe('Roadmap & Goals\n\nSecond slide\n\nTenth');
  });
});

describe('detectFormat', () => {
  it('maps new + existing extensions', () => {
    expect(detectFormat('deck.pptx')).toBe('pptx');
    expect(detectFormat('talk.mp3')).toBe('audio');
    expect(detectFormat('voice.m4a')).toBe('audio');
    expect(detectFormat('paper.pdf')).toBe('pdf');
    expect(detectFormat('notes.md')).toBe('markdown');
    expect(detectFormat('page.html')).toBe('html');
    expect(detectFormat('contract.docx')).toBe('docx');
    expect(detectFormat('readme.txt')).toBe('text');
    expect(detectFormat(undefined)).toBe('text');
  });
});

describe('ingestDocument embed-failure handling', () => {
  // Three ~1900-char paragraphs reliably chunk into three separate chunks
  // (each is under the 2000-char target, and adding the next would overflow).
  const para = (n: number) => `${'a'.repeat(1900)} para${n}`;
  const threeChunkText = `${para(1)}\n\n${para(2)}\n\n${para(3)}`;
  const DIM = 1024;
  const realVec = () => new Array(DIM).fill(0.1);

  beforeEach(() => {
    embedManyMock.mockReset();
    putDocumentMock.mockReset();
    putDocumentMock.mockResolvedValue(undefined);
  });

  it('indexes all chunks and reports failed:0 when every embed succeeds', async () => {
    embedManyMock.mockImplementation(async (texts: string[]) =>
      texts.map(() => realVec()),
    );
    const result = await ingestDocument({ content: threeChunkText, scope: 'test' });
    expect(result.chunks).toBe(3);
    expect(result.failed).toBe(0);
    // All three rows reached the store.
    expect(putDocumentMock).toHaveBeenCalledTimes(1);
    const rows = putDocumentMock.mock.calls[0][2] as { embedding: number[] }[];
    expect(rows).toHaveLength(3);
  });

  it('skips chunks whose embed failed (null) and never writes a zero vector', async () => {
    // Middle chunk fails to embed -> null. It must be dropped, not zero-filled.
    embedManyMock.mockImplementation(async (texts: string[]) =>
      texts.map((_, i) => (i === 1 ? null : realVec())),
    );
    const result = await ingestDocument({ content: threeChunkText, scope: 'test' });
    // Only the 2 successful chunks are searchable; the 1 failure is reported.
    expect(result.chunks).toBe(2);
    expect(result.failed).toBe(1);
    const rows = putDocumentMock.mock.calls[0][2] as { embedding: number[] }[];
    expect(rows).toHaveLength(2);
    // No stored row is a zero vector.
    for (const r of rows) {
      expect(r.embedding.some((v) => v !== 0)).toBe(true);
    }
  });

  it('throws and indexes nothing when every chunk fails to embed', async () => {
    embedManyMock.mockImplementation(async (texts: string[]) =>
      texts.map(() => null),
    );
    await expect(
      ingestDocument({ content: threeChunkText, scope: 'test' }),
    ).rejects.toThrow(/nothing indexed/i);
    expect(putDocumentMock).not.toHaveBeenCalled();
  });
});
