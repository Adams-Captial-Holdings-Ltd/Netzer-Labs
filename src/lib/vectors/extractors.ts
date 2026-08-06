/**
 * Binary document extractors: PDF + DOCX → plain text.
 *
 * Both libraries are pure JS so they run fine on the Fargate Alpine
 * image. We do NOT inline-import them at the top of the module — they
 * pull in heavyweight deps (pdfjs, jszip) that we don't want to load
 * for plain-text ingest paths. The dynamic import keeps cold-start
 * latency on the agent loop unaffected.
 */

import { logger } from '../../observability/logger.js';

export class PdfExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PdfExtractionError';
  }
}

export class DocxExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocxExtractionError';
  }
}

export class PptxExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PptxExtractionError';
  }
}

interface PdfTextResult {
  text: string;
  pages: number;
  /** Per-page cleaned text (1-based `num`); lets ingest tag chunks with a page. */
  pageTexts: { num: number; text: string }[];
}

/**
 * Whitespace cleanup applied to both the combined text and each page. pdf.js
 * emits stray NUL bytes (\0) which we strip, then collapse trailing spaces and
 * runs of blank lines.
 */
function cleanPdfText(s: string): string {
  return (s ?? '')
    .replace(/\0/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function extractPdfText(buffer: Buffer): Promise<PdfTextResult> {
  if (buffer.length === 0) {
    throw new PdfExtractionError('empty buffer');
  }
  const head = buffer.slice(0, 5).toString('ascii');
  if (!head.startsWith('%PDF-')) {
    throw new PdfExtractionError(`not a PDF (magic: ${JSON.stringify(head)})`);
  }
  // Dynamic import: pdf-parse pulls in pdfjs-dist (multi-MB). We only
  // want that paid when someone actually ingests a PDF.
  const { PDFParse } = (await import('pdf-parse')) as typeof import('pdf-parse');
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    const result = await parser.getText();
    const combined = cleanPdfText(result.text ?? '');
    // pdf-parse v2 exposes per-page text. Clean each page the same way and drop
    // empty pages so a chunk's page number maps to the real source page.
    const pageTexts = (result.pages ?? [])
      .map((p) => ({ num: p.num, text: cleanPdfText(p.text) }))
      .filter((p) => p.text.length > 0);
    logger.info(
      { pages: result.total, chars: combined.length },
      'pdf extracted',
    );
    return { text: combined, pages: result.total, pageTexts };
  } finally {
    await parser.destroy().catch(() => {});
  }
}

interface DocxTextResult {
  text: string;
}

export async function extractDocxText(buffer: Buffer): Promise<DocxTextResult> {
  if (buffer.length < 4) {
    throw new DocxExtractionError('empty buffer');
  }
  // DOCX is a zip; the first four bytes are PK\x03\x04.
  if (
    buffer[0] !== 0x50 ||
    buffer[1] !== 0x4b ||
    buffer[2] !== 0x03 ||
    buffer[3] !== 0x04
  ) {
    throw new DocxExtractionError('not a DOCX (missing PK zip magic)');
  }
  const mammoth = (await import('mammoth')) as typeof import('mammoth');
  const out = await mammoth.extractRawText({ buffer });
  const text = (out.value ?? '').trim();
  logger.info({ chars: text.length }, 'docx extracted');
  return { text };
}

interface PptxTextResult {
  text: string;
  /** Number of slides that contributed text. */
  slides: number;
}

/** Decode the small set of XML entities that appear in DrawingML <a:t> runs. */
function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    // Ampersand last so we don't double-decode the entities above.
    .replace(/&amp;/g, '&');
}

/**
 * Extract slide text from a .pptx. PPTX is an OOXML zip; each slide is
 * `ppt/slides/slideN.xml` and the visible text lives in DrawingML `<a:t>`
 * runs. We unzip with jszip (already a dependency via mammoth's peer set),
 * pull every `<a:t>` per slide in slide order, and join. Speaker notes
 * (`ppt/notesSlides/*`) are intentionally skipped — they're rarely the
 * knowledge payload and add noise. No new dependency required.
 */
export async function extractPptxText(buffer: Buffer): Promise<PptxTextResult> {
  if (buffer.length < 4) {
    throw new PptxExtractionError('empty buffer');
  }
  // PPTX (like DOCX) is a zip; first four bytes are PK\x03\x04.
  if (
    buffer[0] !== 0x50 ||
    buffer[1] !== 0x4b ||
    buffer[2] !== 0x03 ||
    buffer[3] !== 0x04
  ) {
    throw new PptxExtractionError('not a PPTX (missing PK zip magic)');
  }
  // jszip is a CommonJS `export =` module; under esModuleInterop the
  // constructor is the synthesized default. Cast through unknown so tsc
  // accepts the interop shape (matches how xray.ts handles CJS defaults).
  const { default: JSZip } = (await import('jszip')) as unknown as {
    default: typeof import('jszip');
  };
  let zip: Awaited<ReturnType<typeof JSZip.loadAsync>>;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch (err) {
    throw new PptxExtractionError(
      `could not open PPTX archive: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  // Collect slide files and sort by their numeric index so slide order is
  // preserved (slide2 before slide10).
  const slideFiles = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => {
      const na = Number(a.match(/slide(\d+)\.xml$/)?.[1] ?? 0);
      const nb = Number(b.match(/slide(\d+)\.xml$/)?.[1] ?? 0);
      return na - nb;
    });
  if (slideFiles.length === 0) {
    throw new PptxExtractionError('no slides found in PPTX (ppt/slides/slideN.xml absent)');
  }
  const slideTexts: string[] = [];
  for (const name of slideFiles) {
    const xml = await zip.files[name].async('string');
    // Pull the text of every <a:t>…</a:t> run. The regex is namespace-tolerant
    // (matches a:t or any prefix) and dot-all over the run body.
    const runs = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => decodeXmlEntities(m[1]));
    const slideText = runs.join(' ').replace(/[ \t]+/g, ' ').trim();
    if (slideText.length > 0) slideTexts.push(slideText);
  }
  const text = slideTexts.join('\n\n').trim();
  logger.info({ slides: slideTexts.length, chars: text.length }, 'pptx extracted');
  return { text, slides: slideTexts.length };
}
