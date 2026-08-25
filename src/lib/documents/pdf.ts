/**
 * PDF builder. Layered on pdfkit.
 */

import PDFDocument from 'pdfkit';
import type { DocumentSpec } from './types.js';

/**
 * pdfkit's built-in Helvetica is a Type1 font declared /Encoding
 * /WinAnsiEncoding, so it can only render Latin-1 plus the WinAnsi punctuation
 * block. Anything outside that — Greek, Cyrillic, CJK, emoji, even a check
 * mark — is written as mangled hex and produces a STRUCTURALLY PERFECT PDF
 * that opens in any viewer and displays garbage. No throw, no warning,
 * `isError` never set: the tool reports success and hands over a broken file.
 *
 * That silent corruption is worse than a refusal, so this refuses. DOCX and
 * XLSX are XML and handle the full range, which is why the message points
 * there rather than just saying no.
 *
 * The real fix is embedding a Unicode TTF, which means shipping a font binary
 * — a deliberate decision, not something to smuggle into a bug fix.
 */
const WINANSI_EXTRA = new Set([
  0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160,
  0x2039, 0x0152, 0x017d, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
  0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x017e, 0x0178,
]);

function unrenderable(text: string): string[] {
  const bad = new Set<string>();
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp === 0x09 || cp === 0x0a || cp === 0x0d) continue;
    if (cp >= 0x20 && cp <= 0xff) continue;
    if (WINANSI_EXTRA.has(cp)) continue;
    bad.add(ch);
  }
  return [...bad];
}

/** Throws a clean, actionable error rather than emitting a garbled PDF. */
export function assertPdfRenderable(spec: DocumentSpec): void {
  const bad = new Set<string>();
  const check = (t: string | undefined) => {
    if (t) for (const c of unrenderable(t)) bad.add(c);
  };
  check(spec.title);
  for (const section of spec.sections) {
    check(section.heading);
    check(section.body);
    for (const row of section.table?.rows ?? []) for (const cell of row) check(cell);
  }
  if (bad.size > 0) {
    const shown = [...bad].slice(0, 8).join(' ');
    throw new Error(
      `this text contains characters the PDF font cannot render (${shown}) and would ` +
        'produce a document full of garbled symbols. Generate it as docx instead, ' +
        'which supports the full character range, or remove those characters.',
    );
  }
}

export async function buildPdf(spec: DocumentSpec): Promise<Buffer> {
  assertPdfRenderable(spec);
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ margin: 56, info: { Title: spec.title } });
      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      doc.fontSize(20).text(spec.title, { align: 'left' });
      doc.moveDown();

      for (const section of spec.sections) {
        if (section.heading) {
          doc.moveDown(0.5);
          doc.fontSize(14).text(section.heading);
          doc.moveDown(0.3);
        }
        if (section.body) {
          doc.fontSize(11).text(section.body, { align: 'left', lineGap: 2 });
          doc.moveDown(0.5);
        }
        if (section.table && section.table.rows.length > 0) {
          renderTable(doc, section.table.rows);
          doc.moveDown(0.5);
        }
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

function renderTable(doc: PDFKit.PDFDocument, rows: string[][]): void {
  // pdfkit doesn't have a table primitive. We draw a simple grid:
  // first row bold, columns sized evenly across page width.
  if (rows.length === 0) return;
  const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const cols = Math.max(...rows.map((r) => r.length));
  if (cols === 0) return;
  const colWidth = pageWidth / cols;
  const startX = doc.page.margins.left;
  let y = doc.y;

  for (let r = 0; r < rows.length; r++) {
    const isHeader = r === 0;
    doc.fontSize(10);
    if (isHeader) {
      doc.font('Helvetica-Bold');
    } else {
      doc.font('Helvetica');
    }
    let rowHeight = 16;
    const cells = rows[r];
    if (!cells) continue;
    for (let c = 0; c < cols; c++) {
      const text = cells[c] ?? '';
      const cellHeight = doc.heightOfString(text, { width: colWidth - 8 });
      if (cellHeight + 6 > rowHeight) rowHeight = cellHeight + 6;
    }
    // page-break check
    if (y + rowHeight > doc.page.height - doc.page.margins.bottom) {
      doc.addPage();
      y = doc.page.margins.top;
    }
    for (let c = 0; c < cols; c++) {
      const x = startX + c * colWidth;
      doc.rect(x, y, colWidth, rowHeight).stroke();
      doc.text(cells[c] ?? '', x + 4, y + 3, { width: colWidth - 8 });
    }
    y += rowHeight;
  }
  doc.font('Helvetica');
  doc.y = y + 4;
}
