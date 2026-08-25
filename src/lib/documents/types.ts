/**
 * Shared types for the generate_document tool (C1).
 *
 * Two spec shapes:
 *   - DocumentSpec   — narrative (title + sections) for PDF + DOCX
 *   - SpreadsheetSpec — workbook (sheets + 2D rows) for XLSX
 *
 * The format is part of the tool input; the tool dispatches to the
 * right builder.
 */

export interface DocumentSection {
  /** Optional section heading. Rendered as H2/equivalent in the output. */
  heading?: string;
  /** Body paragraph. Plain text; newlines preserved. */
  body?: string;
  /**
   * Tabular content. Rendered as a basic table.
   * First row is treated as a header.
   */
  table?: {
    rows: string[][];
  };
}

export interface DocumentSpec {
  title: string;
  sections: DocumentSection[];
}

export interface SpreadsheetSheet {
  name: string;
  rows: Array<Array<string | number | boolean | null>>;
}

export interface SpreadsheetSpec {
  title: string;
  sheets: SpreadsheetSheet[];
}

export type GenerateFormat = 'pdf' | 'docx' | 'xlsx';

export const MAX_SECTIONS = 50;
export const MAX_TABLE_ROWS = 1000;
export const MAX_SHEETS = 20;
export const MAX_SHEET_ROWS = 10_000;
export const MAX_TITLE_LEN = 200;
/**
 * Total cell budget across the WHOLE spec, tables and sheets alike.
 *
 * The per-dimension bounds above do not bound the product, and there is no
 * column bound at all, so `MAX_SHEETS x MAX_SHEET_ROWS x 20 columns` passes
 * every check above and then kills the process: measured at 4,000,000 cells it
 * OOMs, and 2,000,000 cells peaks at 1,870 MB RSS against a 4 GB task shared
 * with two sidecars. An OOM is a SIGKILL, not a catchable error — it takes the
 * whole chat process down, which is exactly what the tool's own try/catch
 * exists to prevent.
 *
 * Nothing a model can currently emit comes close: `TURN_MAX_TOKENS` (8192)
 * caps a tool-call spec near 24 KB, which measures at ~160 MB. This bound
 * exists so that raising the token ceiling later cannot quietly turn a
 * document request into a process kill.
 */
export const MAX_TOTAL_CELLS = 200_000;
/**
 * Hard per-cell character cap. Excel's own limit is 32,767: at 32,768 exceljs
 * still writes a file, the tool still reports success, and Excel then refuses
 * to open it ("Unable to get the Open property of the Workbooks class").
 * Verified at the exact boundary. A file the user cannot open is worse than a
 * clean error, so this rejects instead.
 */
export const MAX_CELL_LEN = 32_767;

/**
 * Coerce a model-supplied cell to text, and refuse the values that produce a
 * corrupt-but-successful document.
 *
 * Two failures this closes, both confirmed by measurement:
 *  - C0 control characters were written RAW into `word/document.xml`, so DOCX
 *    returned a file with correct PK magic and all 18 OPC parts whose primary
 *    part is not well-formed XML. exceljs already strips them for XLSX, so the
 *    two builders disagreed on the same input; they now agree.
 *  - A non-string cell was coerced with `String(cell ?? '')`, turning an object
 *    into the literal "[object Object]" and an array into "1,2" — written into
 *    the document as if the model meant it.
 *
 * Tab, newline and carriage return are kept: they are legal in both formats
 * and a model uses them deliberately.
 */
export function cellText(cell: unknown): string {
  if (cell === null || cell === undefined) return '';
  if (typeof cell === 'object') {
    throw new Error(
      'table cells must be text or numbers, not objects or arrays. ' +
        'Send the value itself, not a wrapper around it.',
    );
  }
  // eslint-disable-next-line no-control-regex
  const text = String(cell).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
  if (text.length > MAX_CELL_LEN) {
    throw new Error(
      `a cell exceeds ${MAX_CELL_LEN.toLocaleString()} characters, which Excel cannot open. ` +
        'Split the value across rows.',
    );
  }
  return text;
}

export function validateDocumentSpec(spec: unknown): DocumentSpec {
  if (typeof spec !== 'object' || spec === null) {
    throw new Error('spec must be an object');
  }
  const s = spec as Record<string, unknown>;
  if (typeof s.title !== 'string' || s.title.length === 0) {
    throw new Error('spec.title is required');
  }
  if (s.title.length > MAX_TITLE_LEN) {
    throw new Error(`spec.title exceeds ${MAX_TITLE_LEN} chars`);
  }
  if (!Array.isArray(s.sections)) {
    throw new Error('spec.sections must be an array');
  }
  if (s.sections.length > MAX_SECTIONS) {
    throw new Error(`spec.sections exceeds ${MAX_SECTIONS} entries`);
  }
  const sections: DocumentSection[] = [];
  let cells = 0;
  for (const raw of s.sections) {
    if (typeof raw !== 'object' || raw === null) continue;
    const sec = raw as Record<string, unknown>;
    const section: DocumentSection = {};
    if (typeof sec.heading === 'string') section.heading = sec.heading;
    if (typeof sec.body === 'string') section.body = sec.body;
    if (typeof sec.table === 'object' && sec.table !== null) {
      const t = sec.table as Record<string, unknown>;
      if (Array.isArray(t.rows)) {
        if (t.rows.length > MAX_TABLE_ROWS) {
          throw new Error(`table.rows exceeds ${MAX_TABLE_ROWS}`);
        }
        const rows: string[][] = [];
        for (const row of t.rows) {
          // Throw rather than `continue`: silently dropping a malformed row
          // hands back a document that is valid, empty and indistinguishable
          // from a legitimately empty one.
          if (!Array.isArray(row)) {
            throw new Error('each table row must be an array of cells');
          }
          rows.push(row.map(cellText));
        }
        section.table = { rows };
        cells += rows.reduce((n, r) => n + r.length, 0);
        assertCellBudget(cells);
      }
    }
    sections.push(section);
  }
  return { title: s.title, sections };
}

/**
 * Guard the whole-spec cell budget. Throws so the caller turns it into a clean
 * tool error — the one outcome an OOM cannot give you.
 */
function assertCellBudget(cells: number): void {
  if (cells > MAX_TOTAL_CELLS) {
    throw new Error(
      `spec exceeds ${MAX_TOTAL_CELLS.toLocaleString()} total cells (got ${cells.toLocaleString()}). ` +
        'Split it into several smaller documents.',
    );
  }
}

export function validateSpreadsheetSpec(spec: unknown): SpreadsheetSpec {
  if (typeof spec !== 'object' || spec === null) {
    throw new Error('spec must be an object');
  }
  const s = spec as Record<string, unknown>;
  if (typeof s.title !== 'string' || s.title.length === 0) {
    throw new Error('spec.title is required');
  }
  if (s.title.length > MAX_TITLE_LEN) {
    throw new Error(`spec.title exceeds ${MAX_TITLE_LEN} chars`);
  }
  if (!Array.isArray(s.sheets)) {
    throw new Error('spec.sheets must be an array');
  }
  if (s.sheets.length === 0) {
    throw new Error('spec.sheets must have at least one sheet');
  }
  if (s.sheets.length > MAX_SHEETS) {
    throw new Error(`spec.sheets exceeds ${MAX_SHEETS}`);
  }
  const sheets: SpreadsheetSheet[] = [];
  let cells = 0;
  for (const raw of s.sheets) {
    if (typeof raw !== 'object' || raw === null) continue;
    const sh = raw as Record<string, unknown>;
    const name = typeof sh.name === 'string' && sh.name.length > 0 ? sh.name : `Sheet${sheets.length + 1}`;
    const rowsIn = Array.isArray(sh.rows) ? sh.rows : [];
    if (rowsIn.length > MAX_SHEET_ROWS) {
      throw new Error(`sheet "${name}".rows exceeds ${MAX_SHEET_ROWS}`);
    }
    const rows: Array<Array<string | number | boolean | null>> = [];
    for (const row of rowsIn) {
      // Throw rather than `continue`. A model that emits rows as objects
      // instead of arrays had every row discarded without error, and the tool
      // handed back a valid, completely empty workbook reported as a success.
      if (!Array.isArray(row)) {
        throw new Error(`sheet "${name}" rows must each be an array of cells`);
      }
      rows.push(
        row.map((c) => {
          if (typeof c === 'number' && Number.isFinite(c)) return c;
          if (typeof c === 'boolean') return c;
          if (c === null) return null;
          return cellText(c);
        }),
      );
    }
    sheets.push({ name, rows });
    cells += rows.reduce((n, r) => n + r.length, 0);
    assertCellBudget(cells);
  }
  return { title: s.title, sheets };
}
