/**
 * XLSX builder. Layered on exceljs.
 */

import ExcelJS from 'exceljs';
import type { SpreadsheetSpec } from './types.js';

export async function buildXlsx(spec: SpreadsheetSpec): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'ClaudeClaw';
  wb.created = new Date();
  wb.title = spec.title;

  for (const sheetSpec of spec.sheets) {
    // Sheet names: <=31 chars, can't contain : \ / ? * [ ]
    const safeName = sheetSpec.name.replace(/[:\\/?*[\]]/g, '_').slice(0, 31);
    const ws = wb.addWorksheet(safeName);
    for (const row of sheetSpec.rows) {
      ws.addRow(row);
    }
    // Bold the first row if it looks like a header (all strings).
    if (sheetSpec.rows.length > 0) {
      const firstRow = sheetSpec.rows[0]!;
      const allStrings = firstRow.every((c) => typeof c === 'string');
      if (allStrings) {
        ws.getRow(1).font = { bold: true };
      }
    }
  }

  const buf = (await wb.xlsx.writeBuffer()) as unknown as ArrayBufferLike;
  return Buffer.from(buf as ArrayBuffer);
}
