import { describe, it, expect } from 'vitest';
import { buildPdf } from './pdf.js';
import { buildDocx } from './docx.js';
import { buildXlsx } from './xlsx.js';
import {
  validateDocumentSpec,
  validateSpreadsheetSpec,
  MAX_TOTAL_CELLS,
  MAX_CELL_LEN,
} from './types.js';
import { assertPdfRenderable } from './pdf.js';

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

/**
 * A document build must never be able to kill the process.
 *
 * The per-dimension bounds do not bound their product, and there is no column
 * bound at all, so MAX_SHEETS x MAX_SHEET_ROWS x 20 columns passed every check
 * and then OOMed — measured: 4,000,000 cells dies, 2,000,000 peaks at 1,870 MB
 * RSS against a 4 GB task shared with two sidecars. An OOM is a SIGKILL, not a
 * catchable error, so the tool's try/catch cannot turn it into a tool error and
 * the whole chat process goes with it.
 *
 * Nothing a model can emit today reaches this: TURN_MAX_TOKENS (8192) caps a
 * tool-call spec near 24 KB, ~160 MB. The bound exists so that raising the
 * token ceiling later cannot quietly turn a document request into a process
 * kill.
 */
describe('total cell budget', () => {
  const wide = (sheets: number, rows: number, cols: number) => ({
    title: 'Budget',
    sheets: Array.from({ length: sheets }, (_, i) => ({
      name: `S${i}`,
      rows: Array.from({ length: rows }, () => Array.from({ length: cols }, () => 'x')),
    })),
  });

  it('rejects a spreadsheet past the budget with a clean error, not an OOM', () => {
    // 3 x 10,000 x 8 = 240,000 cells, over the budget but cheap to build.
    expect(() => validateSpreadsheetSpec(wide(3, 10_000, 8))).toThrow(/total cells/i);
  });

  it('tells the person what to do about it', () => {
    expect(() => validateSpreadsheetSpec(wide(3, 10_000, 8))).toThrow(/smaller/i);
  });

  it('still accepts a genuinely large but survivable spreadsheet', () => {
    // 2 x 5,000 x 10 = 100,000 cells, under the budget.
    const out = validateSpreadsheetSpec(wide(2, 5_000, 10));
    expect(out.sheets).toHaveLength(2);
  });

  it('bounds document tables on the same budget', () => {
    const spec = {
      title: 'Budget',
      sections: Array.from({ length: 50 }, () => ({
        heading: 'h',
        table: { rows: Array.from({ length: 1_000 }, () => Array.from({ length: 10 }, () => 'x')) },
      })),
    };
    expect(() => validateDocumentSpec(spec)).toThrow(/total cells/i);
  });

  it('leaves an ordinary document well clear of the budget', () => {
    const out = validateDocumentSpec({
      title: 'SWOT',
      sections: [{ heading: 'Strengths', body: 'text', table: { rows: [['a', 'b'], ['c', 'd']] } }],
    });
    expect(out.sections).toHaveLength(1);
    expect(MAX_TOTAL_CELLS).toBeGreaterThan(1000);
  });
});

/**
 * "Corrupt but successful" is the worst outcome this tool can produce: the
 * build returns bytes, isError is never set, S3 accepts them, and the person
 * gets a presigned URL to a broken file. Every case below was CONFIRMED by
 * measurement before it was fixed, and each must now be a clean throw that the
 * tool converts into a tool error.
 */
describe('corrupt-but-successful cases', () => {
  it('refuses PDF text the built-in font would render as garbage', () => {
    // Confirmed: pdfkit Helvetica is /WinAnsiEncoding, so these produced a
    // structurally perfect PDF displaying mangled symbols, with no error.
    for (const bad of ['Beijing 财务报告', 'Δelta', 'Привет', '🚀 launch', 'done ✅']) {
      expect(() =>
        assertPdfRenderable({ title: bad, sections: [{ body: 'x' }] }),
      ).toThrow(/cannot render/i);
    }
  });

  it('points at docx, which does handle those characters', () => {
    expect(() =>
      assertPdfRenderable({ title: '财务', sections: [{ body: 'x' }] }),
    ).toThrow(/docx/i);
  });

  it('still accepts the punctuation a model actually types', () => {
    expect(() =>
      assertPdfRenderable({
        title: 'Q4 — “Growth”… €1,200 café • naïve 50°',
        sections: [{ heading: 'It’s fine', body: 'em—dash, en–dash, ™ and ½' }],
      }),
    ).not.toThrow();
  });

  it('strips C0 control characters instead of writing malformed XML', () => {
    // Confirmed: raw C0 bytes reached word/document.xml, so DOCX returned a
    // file whose primary part is not well-formed XML - while XLSX stripped
    // them. The two builders now agree.
    const dirty = 'a' + String.fromCharCode(0) + 'b' + String.fromCharCode(1) + 'c';
    const out = validateDocumentSpec({
      title: 'Ctrl',
      sections: [{ table: { rows: [[dirty]] } }],
    });
    expect(out.sections[0]?.table?.rows[0]?.[0]).toBe('abc');
  });

  it('keeps tab and newline, which are legal and deliberate', () => {
    const keep = 'a' + String.fromCharCode(9) + 'b' + String.fromCharCode(10) + 'c';
    const out = validateDocumentSpec({
      title: 'Ws',
      sections: [{ table: { rows: [[keep]] } }],
    });
    expect(out.sections[0]?.table?.rows[0]?.[0]).toBe(keep);
  });

  it('rejects an object cell rather than writing "[object Object]"', () => {
    expect(() =>
      validateDocumentSpec({ title: 'T', sections: [{ table: { rows: [[{ value: 3 }]] } }] }),
    ).toThrow(/not objects or arrays/i);
  });

  it('rejects a cell Excel could not open, at the exact boundary', () => {
    const sheet = (len: number) => ({
      title: 'T',
      sheets: [{ name: 'S', rows: [['x'.repeat(len)]] }],
    });
    expect(() => validateSpreadsheetSpec(sheet(MAX_CELL_LEN))).not.toThrow();
    expect(() => validateSpreadsheetSpec(sheet(MAX_CELL_LEN + 1))).toThrow(/Excel cannot open/i);
  });

  it('rejects rows-as-objects rather than returning an empty workbook', () => {
    // Confirmed: `if (!Array.isArray(row)) continue` discarded every row and
    // reported success, handing back a valid but completely empty workbook.
    expect(() =>
      validateSpreadsheetSpec({ title: 'T', sheets: [{ name: 'S', rows: [{ a: 1 }, 'nope', 42] }] }),
    ).toThrow(/must each be an array/i);
  });

  it('rejects malformed document table rows the same way', () => {
    expect(() =>
      validateDocumentSpec({ title: 'T', sections: [{ table: { rows: ['not-an-array'] } }] }),
    ).toThrow(/must be an array/i);
  });

  it('leaves the total-cell budget intact', () => {
    expect(MAX_TOTAL_CELLS).toBe(200_000);
  });
});
