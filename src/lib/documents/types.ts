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
          if (!Array.isArray(row)) continue;
          rows.push(row.map((cell) => String(cell ?? '')));
        }
        section.table = { rows };
      }
    }
    sections.push(section);
  }
  return { title: s.title, sections };
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
      if (!Array.isArray(row)) continue;
      rows.push(
        row.map((c) => {
          if (typeof c === 'number' && Number.isFinite(c)) return c;
          if (typeof c === 'boolean') return c;
          if (c === null) return null;
          return String(c ?? '');
        }),
      );
    }
    sheets.push({ name, rows });
  }
  return { title: s.title, sheets };
}
