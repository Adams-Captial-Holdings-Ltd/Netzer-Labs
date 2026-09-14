/**
 * Deliverables parity: the five E1 prompts and their fixtures.
 *
 * The same texts go to Netzar (via replay.ts) and to the Claude app (System A),
 * so `exportPrompts` writes them out verbatim for the user to paste. Fixtures
 * are inline text on both sides: E1 measures the output budget, not ingestion.
 * `replay.diag.ts` is the contract.
 *
 * - p1: a SWOT report as a PDF. A STAND-IN: the 2026-08-24 incident
 *   (chat dashboard:1787596504860) is recorded only as "a request for a SWOT
 *   analysis PDF". Replace it if the real wording turns up.
 * - p2: a 10-slide deck. There is no PPTX tool; the run shows what happens.
 * - p3: a workbook from 200 seeded CSV rows.
 * - p4: a ~2,000-word summary of ~6,000 words, with no file.
 * - p5: a DOCX memo containing a table.
 *
 * Every file prompt tells the model to assume rather than ask: the replay is a
 * single turn, so a clarifying question would end the run with no deliverable.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const SOURCE_MIN_WORDS = 6000;
const ASSUME = 'Make reasonable assumptions instead of asking me questions.';
const REGIONS = ['North', 'South', 'East', 'West'];
const PRODUCTS = ['Widget', 'Gadget', 'Sprocket', 'Gizmo', 'Bracket'];
const CHANNELS = ['Online', 'Retail', 'Partner'];

/** Throws when `path` is `repoRoot` or inside it. Exports and replay records hold prompt text. */
export function refuseInsideRepo(path: string, repoRoot: string): void {
  const rel = relative(resolve(repoRoot), resolve(path));
  if (rel === '' || (!isAbsolute(rel) && rel.split(/[\\/]/)[0] !== '..')) {
    throw new Error(`${resolve(path)} is inside the repository; write it elsewhere.`);
  }
}

/** Seeded, deterministic: header plus `rows` lines, revenue = units x unit_price. */
export function csvFixture(seed = 1, rows = 200): string {
  let state = seed >>> 0;
  // mulberry32
  const rand = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = (values: string[]): string => values[Math.floor(rand() * values.length)] ?? '';
  const lines = [CSV_HEADER];
  for (let i = 0; i < rows; i++) {
    const date = new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10);
    const region = pick(REGIONS);
    const product = pick(PRODUCTS);
    const channel = pick(CHANNELS);
    const units = 1 + Math.floor(rand() * 500);
    const unitPrice = Math.round((5 + rand() * 95) * 100) / 100;
    const revenue = Math.round(units * unitPrice * 100) / 100;
    lines.push([date, region, product, channel, units, unitPrice.toFixed(2), revenue.toFixed(2)].join(','));
  }
  return lines.join('\n');
}

let source: { text: string; words: number; sha256: string } | undefined;
const wordCount = (text: string): number => text.trim().split(/\s+/).length;

/** The first paragraphs of development.md@SOURCE_TEXT_COMMIT reaching 6,000 words. */
export function sourceText(): { text: string; words: number; sha256: string } {
  if (source) return source;
  const doc = execFileSync('git', ['show', `${SOURCE_TEXT_COMMIT}:development.md`], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  const paragraphs = doc.split(/\n\s*\n/);
  let text = '';
  for (let n = 1; n <= paragraphs.length; n++) {
    text = paragraphs.slice(0, n).join('\n\n');
    if (wordCount(text) >= SOURCE_MIN_WORDS) break;
  }
  source = { text, words: wordCount(text), sha256: createHash('sha256').update(text).digest('hex') };
  return source;
}

export function buildPrompts(): PromptDef[] {
  const [p1, p2, p3, p4, p5] = PROMPT_IDS;
  return [
    {
      id: p1,
      title: 'SWOT report as a PDF (stand-in)',
      expects: 'pdf',
      standIn: true,
      text:
        'Create a SWOT analysis report as a PDF for Harbor & Hearth Coffee, a regional coffee roaster ' +
        'with 40 employees that is deciding whether to open its first cafe. Give strengths, weaknesses, ' +
        'opportunities and threats at least four specific points each, with a sentence of explanation ' +
        `per point, and end with three prioritised recommendations. ${ASSUME}`,
    },
    {
      id: p2,
      title: '10-slide deck',
      expects: 'pptx',
      text:
        'Build a 10-slide presentation as a PowerPoint (.pptx) file pitching a new employee wellness ' +
        'programme to the leadership team of a 300-person software company. Cover the problem, the ' +
        'proposal, costs, expected benefits, risks, a timeline and next steps, with a title and three ' +
        `to five bullet points on every slide. ${ASSUME}`,
    },
    {
      id: p3,
      title: 'Workbook from CSV',
      expects: 'xlsx',
      text:
        "Below is last year's sales data as CSV. Turn it into an Excel workbook (.xlsx) with a Data " +
        'sheet holding every row and a Summary sheet showing total units and revenue by region and by ' +
        `product. ${ASSUME}\n\n${csvFixture()}`,
    },
    {
      id: p4,
      title: '2,000-word summary, no file',
      expects: 'text',
      text:
        'Summarise the document below in about 2,000 words. Keep its structure, cover every major ' +
        `section, and reply in this chat as plain text; do not create a file.\n\n${sourceText().text}`,
    },
    {
      id: p5,
      title: 'DOCX memo with a table',
      expects: 'docx',
      text:
        'Write a one-page internal memo as a Word document (.docx) announcing that the quarterly budget ' +
        'review moves from a single meeting to a two-step written process. Include a table comparing ' +
        `the old and new process across at least four aspects. ${ASSUME}`,
    },
  ];
}

/** Writes `<id>.txt` per prompt, byte-identical to `text`. Refused inside the repo. */
export function exportPrompts(dir: string, repoRoot: string): string[] {
  refuseInsideRepo(dir, repoRoot);
  mkdirSync(dir, { recursive: true });
  return buildPrompts().map((prompt) => {
    const file = join(dir, `${prompt.id}.txt`);
    writeFileSync(file, prompt.text);
    return file;
  });
}
