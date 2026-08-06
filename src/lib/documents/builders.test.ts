import { describe, it, expect } from 'vitest';
import { buildPdf } from './pdf.js';
import { buildDocx } from './docx.js';
import { buildXlsx } from './xlsx.js';
import {
  validateDocumentSpec,
  validateSpreadsheetSpec,
} from './types.js';

const PDF_MAGIC = Buffer.from('%PDF-');
// DOCX + XLSX are both zip-archived OOXML; the zip magic is 'PK\x03\x04'.
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

describe('validateDocumentSpec', () => {
  it('accepts a minimal valid spec', () => {
    const out = validateDocumentSpec({
      title: 'Hello',
      sections: [{ body: 'world' }],
    });
    expect(out.title).toBe('Hello');
    expect(out.sections).toHaveLength(1);
  });

  it('rejects missing title', () => {
    expect(() => validateDocumentSpec({ sections: [] })).toThrow(/title/);
  });

  it('rejects an over-long title', () => {
    expect(() =>
      validateDocumentSpec({ title: 'x'.repeat(500), sections: [] }),
    ).toThrow(/title exceeds/);
  });

  it('rejects too many sections', () => {
    expect(() =>
      validateDocumentSpec({
        title: 'too big',
        sections: new Array(200).fill({ body: 'x' }),
      }),
    ).toThrow(/sections exceeds/);
  });

  it('rejects oversized table.rows', () => {
    expect(() =>
      validateDocumentSpec({
        title: 'big table',
        sections: [{ table: { rows: new Array(2000).fill(['a']) } }],
      }),
    ).toThrow(/table.rows exceeds/);
  });
});

describe('validateSpreadsheetSpec', () => {
  it('requires at least one sheet', () => {
    expect(() => validateSpreadsheetSpec({ title: 't', sheets: [] })).toThrow(
      /at least one sheet/,
    );
  });

  it('coerces non-finite numbers to strings', () => {
    const out = validateSpreadsheetSpec({
      title: 't',
      sheets: [{ name: 'a', rows: [[Number.POSITIVE_INFINITY, 1, 'x']] }],
    });
    const row = out.sheets[0]!.rows[0]!;
    expect(row[0]).toBe('Infinity');
    expect(row[1]).toBe(1);
    expect(row[2]).toBe('x');
  });

  it('rejects oversized sheet.rows', () => {
    expect(() =>
      validateSpreadsheetSpec({
        title: 't',
        sheets: [{ name: 'huge', rows: new Array(50_000).fill([1]) }],
      }),
    ).toThrow(/exceeds/);
  });
});

describe('buildPdf', () => {
  it('produces a non-empty PDF starting with %PDF-', async () => {
    const bytes = await buildPdf({
      title: 'Quarterly Update',
      sections: [
        { heading: 'Summary', body: 'hello world' },
        {
          heading: 'Numbers',
          table: { rows: [['col a', 'col b'], ['1', '2'], ['3', '4']] },
        },
      ],
    });
    expect(bytes.length).toBeGreaterThan(500);
    expect(bytes.slice(0, PDF_MAGIC.length).equals(PDF_MAGIC)).toBe(true);
  });

  it('handles a spec with no sections', async () => {
    const bytes = await buildPdf({ title: 'Empty', sections: [] });
    expect(bytes.length).toBeGreaterThan(200);
  });
});

describe('buildDocx', () => {
  it('produces a non-empty docx archive', async () => {
    const bytes = await buildDocx({
      title: 'Brief',
      sections: [
        { heading: 'Intro', body: 'one paragraph\n\nanother paragraph' },
        {
          heading: 'Table',
          table: { rows: [['h1', 'h2'], ['v1', 'v2']] },
        },
      ],
    });
    expect(bytes.length).toBeGreaterThan(1000);
    expect(bytes.slice(0, ZIP_MAGIC.length).equals(ZIP_MAGIC)).toBe(true);
  });
});

describe('buildXlsx', () => {
  it('produces a non-empty xlsx archive with two sheets', async () => {
    const bytes = await buildXlsx({
      title: 'Sales',
      sheets: [
        {
          name: 'Q1',
          rows: [['Region', 'Revenue'], ['NA', 1000], ['EU', 800]],
        },
        {
          name: 'Q2',
          rows: [['Region', 'Revenue'], ['NA', 1300], ['EU', 950]],
        },
      ],
    });
    expect(bytes.length).toBeGreaterThan(2000);
    expect(bytes.slice(0, ZIP_MAGIC.length).equals(ZIP_MAGIC)).toBe(true);
  });

  it('sanitizes invalid characters in sheet names', async () => {
    const bytes = await buildXlsx({
      title: 't',
      sheets: [{ name: 'bad/name:here', rows: [['x']] }],
    });
    expect(bytes.length).toBeGreaterThan(2000);
    // ExcelJS would throw if we passed `bad/name:here` directly; the
    // build succeeding proves we sanitized.
  });
});
