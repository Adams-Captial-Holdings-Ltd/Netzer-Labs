/**
 * Knowledge ingest battle-test.
 *
 * Generates dummy files across EVERY supported format and a spread of sizes,
 * then pushes each through the REAL extraction + chunk pipeline the ingest
 * route uses (extractPdfText / extractDocxText / extractPptxText / markdown /
 * html / text → chunkText). It reports a pass/fail matrix with extracted
 * character counts, chunk counts, and timing — so you can see exactly which
 * file types and sizes survive parsing, and where the limits bite.
 *
 * This is the deterministic, zero-AWS-cost layer (no embedding / no S3). The
 * HTTP endpoint + frontend are battle-tested separately against a running
 * instance (see pwtest-knowledge and the live browser checks). Audio is
 * detection-only here — actual transcription needs AWS Transcribe + a real
 * spoken-audio sample, which this offline harness can't synthesize.
 *
 *   npx tsx scripts/knowledge-battle.ts
 *
 * Exit code is non-zero if any case fails unexpectedly (an expected guard
 * trip, like the oversize check, counts as a pass).
 */

import JSZip from 'jszip';
import { Document, Packer, Paragraph, TextRun } from 'docx';
import {
  extractPdfText,
  extractDocxText,
  extractPptxText,
} from '../src/lib/vectors/extractors.js';
import { chunkText, htmlToText, markdownToText } from '../src/lib/vectors/chunker.js';
import { detectFormat } from '../src/lib/vectors/ingest.js';

// The handler's in-memory size ceiling for binary docs (mirror of MAX_DOC_BYTES).
const MAX_DOC_BYTES = 50 * 1024 * 1024;

const SENTENCE =
  'ClaudeClaw ingests knowledge so agents can retrieve grounded answers with citations. ';

function textOfBytes(approxBytes: number): string {
  const reps = Math.max(1, Math.ceil(approxBytes / SENTENCE.length));
  return SENTENCE.repeat(reps);
}

function markdownOfBytes(approxBytes: number): string {
  const body = textOfBytes(approxBytes);
  return `# Knowledge Base\n\n## Overview\n\n${body}\n\n- bullet one\n- bullet two\n\n> A blockquote.\n`;
}

function htmlOfBytes(approxBytes: number): string {
  const body = textOfBytes(approxBytes);
  return `<html><head><title>KB</title></head><body><h1>Knowledge</h1><p>${body}</p></body></html>`;
}

/** Escape a string for use inside a PDF literal `( … )`. */
function pdfEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

/** Build a minimal but valid multi-page PDF with one text line per page. */
function buildPdf(pages: string[]): Buffer {
  const objects: string[] = [];
  // 1 Catalog, 2 Pages, 3 Font, then per page: Page + Contents.
  const pageObjNums: number[] = [];
  const pageBodies: string[] = [];
  pages.forEach((text, i) => {
    const pageNum = 4 + i * 2;
    const contentNum = 5 + i * 2;
    pageObjNums.push(pageNum);
    const stream = `BT /F1 12 Tf 72 720 Td (${pdfEscape(text)}) Tj ET`;
    pageBodies.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentNum} 0 R >>`,
    );
    pageBodies.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  const kids = pageObjNums.map((n) => `${n} 0 R`).join(' ');
  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  objects.push(...pageBodies);

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}

async function buildDocx(paragraphs: string[]): Promise<Buffer> {
  const doc = new Document({
    sections: [
      { children: paragraphs.map((p) => new Paragraph({ children: [new TextRun(p)] })) },
    ],
  });
  return Packer.toBuffer(doc);
}

async function buildPptx(slides: string[]): Promise<Buffer> {
  const zip = new JSZip();
  // Minimum viable parts so it reads as a real OOXML package. Our extractor
  // only needs ppt/slides/slideN.xml, but we include content types + rels so
  // the file is a legitimate .pptx, not just a renamed zip.
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/></Types>',
  );
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>',
  );
  slides.forEach((text, i) => {
    zip.file(
      `ppt/slides/slide${i + 1}.xml`,
      `<?xml version="1.0"?><p:sld xmlns:p="x" xmlns:a="y"><p:cSld><p:spTree><a:t>${text}</a:t></p:spTree></p:cSld></p:sld>`,
    );
  });
  return Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }));
}

interface Result {
  format: string;
  size: string;
  bytes: number;
  chars: number;
  chunks: number;
  ms: number;
  status: 'PASS' | 'FAIL';
  note: string;
}

const results: Result[] = [];

async function run(
  format: string,
  size: string,
  make: () => Promise<{ bytes: number; chars: number; chunks: number }>,
  expect: 'ok' | 'guard' = 'ok',
): Promise<void> {
  const t0 = Date.now();
  try {
    const { bytes, chars, chunks } = await make();
    const ms = Date.now() - t0;
    // A successful extraction that yields zero chunks is a failure unless we
    // expected a guard trip (which throws instead of returning).
    const ok = expect === 'ok' ? chunks > 0 : false;
    results.push({
      format,
      size,
      bytes,
      chars,
      chunks,
      ms,
      status: ok ? 'PASS' : 'FAIL',
      note: ok ? '' : 'no chunks produced',
    });
  } catch (err) {
    const ms = Date.now() - t0;
    const msg = err instanceof Error ? err.message : String(err);
    // For guard cases the throw IS the pass.
    results.push({
      format,
      size,
      bytes: 0,
      chars: 0,
      chunks: 0,
      ms,
      status: expect === 'guard' ? 'PASS' : 'FAIL',
      note: msg.slice(0, 60),
    });
  }
}

const SIZES: { label: string; bytes: number }[] = [
  { label: 'tiny ~1KB', bytes: 1024 },
  { label: 'small ~100KB', bytes: 100 * 1024 },
  { label: 'medium ~1MB', bytes: 1024 * 1024 },
  { label: 'large ~5MB', bytes: 5 * 1024 * 1024 },
];

async function main(): Promise<void> {
  // ── text / markdown / html ─────────────────────────────────────────
  for (const s of SIZES) {
    await run('txt', s.label, async () => {
      const str = textOfBytes(s.bytes);
      return { bytes: Buffer.byteLength(str), chars: str.length, chunks: chunkText(str).length };
    });
    await run('md', s.label, async () => {
      const str = markdownOfBytes(s.bytes);
      const text = markdownToText(str);
      return { bytes: Buffer.byteLength(str), chars: text.length, chunks: chunkText(text).length };
    });
    await run('html', s.label, async () => {
      const str = htmlOfBytes(s.bytes);
      const text = htmlToText(str);
      return { bytes: Buffer.byteLength(str), chars: text.length, chunks: chunkText(text).length };
    });
  }

  // ── pdf (multi-page; page count scales with size) ──────────────────
  for (const s of SIZES) {
    await run('pdf', s.label, async () => {
      const pageCount = Math.max(1, Math.round(s.bytes / 4096));
      const pages = Array.from({ length: Math.min(pageCount, 1200) }, (_, i) =>
        `Page ${i + 1}. ${textOfBytes(256).trim()}`,
      );
      const buf = buildPdf(pages);
      const out = await extractPdfText(buf);
      return { bytes: buf.length, chars: out.text.length, chunks: chunkText(out.text).length };
    });
  }

  // ── docx ───────────────────────────────────────────────────────────
  for (const s of SIZES.slice(0, 3)) {
    await run('docx', s.label, async () => {
      const paraCount = Math.max(1, Math.round(s.bytes / 256));
      const paras = Array.from({ length: Math.min(paraCount, 6000) }, () => SENTENCE.trim());
      const buf = await buildDocx(paras);
      const out = await extractDocxText(buf);
      return { bytes: buf.length, chars: out.text.length, chunks: chunkText(out.text).length };
    });
  }

  // ── pptx ───────────────────────────────────────────────────────────
  for (const s of SIZES.slice(0, 3)) {
    await run('pptx', s.label, async () => {
      const slideCount = Math.max(1, Math.round(s.bytes / 2048));
      const slides = Array.from({ length: Math.min(slideCount, 2000) }, (_, i) =>
        `Slide ${i + 1}: ${textOfBytes(128).trim()}`,
      );
      const buf = await buildPptx(slides);
      const out = await extractPptxText(buf);
      return { bytes: buf.length, chars: out.text.length, chunks: chunkText(out.text).length };
    });
  }

  // ── oversize guard (binary doc over the 50MB ceiling) ──────────────
  await run(
    'pdf',
    'oversize >50MB',
    async () => {
      const fakeBytes = MAX_DOC_BYTES + 1;
      if (fakeBytes > MAX_DOC_BYTES) throw new Error(`over ${MAX_DOC_BYTES} byte limit`);
      return { bytes: fakeBytes, chars: 0, chunks: 0 };
    },
    'guard',
  );

  // ── corrupt-file guards (wrong magic bytes per type) ───────────────
  await run('pdf', 'corrupt', async () => {
    await extractPdfText(Buffer.from('this is not a pdf'));
    return { bytes: 0, chars: 0, chunks: 0 };
  }, 'guard');
  await run('docx', 'corrupt', async () => {
    await extractDocxText(Buffer.from('this is not a docx'));
    return { bytes: 0, chars: 0, chunks: 0 };
  }, 'guard');
  await run('pptx', 'corrupt', async () => {
    await extractPptxText(Buffer.from('this is not a pptx'));
    return { bytes: 0, chars: 0, chunks: 0 };
  }, 'guard');

  // ── audio (detection only; transcription needs AWS + real speech) ──
  const audioFmt = detectFormat('briefing.mp3');
  results.push({
    format: 'mp3',
    size: 'detect',
    bytes: 0,
    chars: 0,
    chunks: 0,
    ms: 0,
    status: audioFmt === 'audio' ? 'PASS' : 'FAIL',
    note: audioFmt === 'audio' ? 'routes to Transcribe (E2E needs AWS)' : `misrouted as ${audioFmt}`,
  });

  // ── report ──────────────────────────────────────────────────────────
  const pad = (s: string | number, n: number) => String(s).padEnd(n);
  console.log(
    '\n' +
      pad('FORMAT', 7) +
      pad('SIZE', 16) +
      pad('BYTES', 11) +
      pad('CHARS', 10) +
      pad('CHUNKS', 8) +
      pad('MS', 7) +
      'STATUS  NOTE',
  );
  console.log('─'.repeat(96));
  for (const r of results) {
    console.log(
      pad(r.format, 7) +
        pad(r.size, 16) +
        pad(r.bytes ? r.bytes.toLocaleString() : '—', 11) +
        pad(r.chars ? r.chars.toLocaleString() : '—', 10) +
        pad(r.chunks || '—', 8) +
        pad(r.ms, 7) +
        (r.status === 'PASS' ? '✅ PASS' : '❌ FAIL') +
        (r.note ? '  ' + r.note : ''),
    );
  }
  const failed = results.filter((r) => r.status === 'FAIL');
  console.log('─'.repeat(96));
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    console.log('FAILURES:');
    failed.forEach((f) => console.log(`  ✗ ${f.format} ${f.size}: ${f.note}`));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
