/**
 * PDF builder. Layered on pdfkit.
 */

import PDFDocument from 'pdfkit';
import type { DocumentSpec } from './types.js';

export async function buildPdf(spec: DocumentSpec): Promise<Buffer> {
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
