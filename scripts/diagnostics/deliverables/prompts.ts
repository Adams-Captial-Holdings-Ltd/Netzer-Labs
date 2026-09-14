/**
 * Deliverables parity: the five E1 prompts and their fixtures.
 *
 * The same texts go to Netzar (via replay.ts) and to the Claude app (System A),
 * so `exportPrompts` writes them out verbatim for the user to paste. Fixtures
 * are inline text on both sides: E1 measures the output budget, not ingestion.
 *
 * Status: SPECIFICATION stubs. `replay.diag.ts` is the contract.
 *
 * - p1: a SWOT report as a PDF. A STAND-IN: the 2026-08-24 incident
 *   (chat dashboard:1787596504860) is recorded only as "a request for a SWOT
 *   analysis PDF". Replace it if the real wording turns up.
 * - p2: a 10-slide deck. There is no PPTX tool; the run shows what happens.
 * - p3: a workbook from 200 seeded CSV rows.
 * - p4: a ~2,000-word summary of ~6,000 words, with no file.
 * - p5: a DOCX memo containing a table.
 */

export type ExpectedOutput = 'pdf' | 'pptx' | 'xlsx' | 'docx' | 'text';

export interface PromptDef {
  id: string;
  title: string;
  text: string;
  expects: ExpectedOutput;
  standIn?: boolean;
}

export const PROMPT_IDS = [
  'p1-swot-pdf',
  'p2-deck-10-slides',
  'p3-workbook-from-csv',
  'p4-summary-2000-words',
  'p5-docx-memo-table',
] as const;

/** p4's source: development.md at this commit, cut at a paragraph boundary. */
export const SOURCE_TEXT_COMMIT = '271339bc8b2feea85e6c31b115fdd34e757a72e2';
export const CSV_HEADER = 'date,region,product,channel,units,unit_price,revenue';

const notImplemented = (name: string): never => {
  throw new Error(`not implemented: ${name}`);
};

/** Seeded, deterministic: header plus `rows` lines, revenue = units x unit_price. */
export function csvFixture(_seed?: number, _rows?: number): string {
  return notImplemented('csvFixture');
}

/** The first paragraphs of development.md@SOURCE_TEXT_COMMIT reaching 6,000 words. */
export function sourceText(): { text: string; words: number; sha256: string } {
  return notImplemented('sourceText');
}

export function buildPrompts(): PromptDef[] {
  return notImplemented('buildPrompts');
}

/** Writes `<id>.txt` per prompt, byte-identical to `text`. Refused inside the repo. */
export function exportPrompts(_dir: string, _repoRoot: string): string[] {
  return notImplemented('exportPrompts');
}
