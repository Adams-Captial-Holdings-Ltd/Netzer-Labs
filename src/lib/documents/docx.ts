/**
 * DOCX builder. Layered on the `docx` npm package.
 */

import {
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  TextRun,
  Table,
  TableCell,
  TableRow,
  WidthType,
} from 'docx';
import type { DocumentSpec } from './types.js';

export async function buildDocx(spec: DocumentSpec): Promise<Buffer> {
  const children: Array<Paragraph | Table> = [];

  children.push(
    new Paragraph({
      heading: HeadingLevel.TITLE,
      children: [new TextRun({ text: spec.title })],
    }),
  );

  for (const section of spec.sections) {
    if (section.heading) {
      children.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_2,
          children: [new TextRun({ text: section.heading })],
        }),
      );
    }
    if (section.body) {
      // Preserve paragraph breaks as separate Paragraph elements so
      // Word treats them as actual paragraphs (not soft breaks).
      for (const para of section.body.split(/\n\s*\n/)) {
        const trimmed = para.trim();
        if (!trimmed) continue;
        children.push(new Paragraph({ children: [new TextRun({ text: trimmed })] }));
      }
    }
    if (section.table && section.table.rows.length > 0) {
      children.push(renderTable(section.table.rows));
    }
  }

  const doc = new Document({
    creator: 'ClaudeClaw',
    title: spec.title,
    sections: [{ children }],
  });

  // Packer.toBuffer returns Node's Buffer in Node.js runtime.
  const out = (await Packer.toBuffer(doc)) as unknown as Buffer;
  return out;
}

function renderTable(rows: string[][]): Table {
  const docxRows = rows.map((row, rowIdx) => {
    const isHeader = rowIdx === 0;
    return new TableRow({
      children: row.map(
        (cell) =>
          new TableCell({
            width: { size: 100 / Math.max(row.length, 1), type: WidthType.PERCENTAGE },
            children: [
              new Paragraph({
                children: [new TextRun({ text: cell, bold: isHeader })],
              }),
            ],
          }),
      ),
    });
  });
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: docxRows,
  });
}
