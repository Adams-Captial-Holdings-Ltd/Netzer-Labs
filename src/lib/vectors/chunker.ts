/**
 * Text chunker for vector ingestion.
 *
 * Strategy: split on blank lines first (paragraph-aware), then
 * concatenate paragraphs until we approach the target size. We use
 * character count as a stable proxy for tokens (1 token ≈ 4 chars for
 * English); a 500-token target lands at ~2000 chars.
 *
 * Overlap: 200 chars carried forward keeps citation continuity at chunk
 * boundaries — a fact split across two chunks still matches either.
 */

const TARGET_CHARS = 2000;
const OVERLAP_CHARS = 200;
const MIN_CHARS = 80;

export interface Chunk {
  text: string;
  /** Zero-based ordinal within the source document. */
  index: number;
  /** Original character span [start, end). */
  start: number;
  end: number;
}

export function chunkText(input: string): Chunk[] {
  const cleaned = normalize(input);
  if (cleaned.length === 0) return [];
  if (cleaned.length <= TARGET_CHARS) {
    return [{ text: cleaned, index: 0, start: 0, end: cleaned.length }];
  }
  const paragraphs = splitParagraphs(cleaned);
  const chunks: Chunk[] = [];
  let buf = '';
  let bufStart = 0;
  let cursor = 0;
  let order = 0;

  function emit(end: number): void {
    // Skip sub-MIN_CHARS buffers ONLY once something was already emitted:
    // those are overlap tails the previous chunk already covers. The FIRST
    // buffer is real content; a short opening line (a bare title) directly
    // before a >TARGET_CHARS paragraph used to vanish here, never embedded.
    const content = buf.trim();
    if (content.length === 0) return;
    if (content.length < MIN_CHARS && chunks.length > 0) return;
    chunks.push({
      text: buf.trim(),
      index: order++,
      start: bufStart,
      end,
    });
    // Carry the tail forward as overlap for the next chunk.
    if (OVERLAP_CHARS > 0 && buf.length > OVERLAP_CHARS) {
      const tail = buf.slice(-OVERLAP_CHARS);
      buf = tail;
      bufStart = end - tail.length;
    } else {
      buf = '';
      bufStart = end;
    }
  }

  for (const para of paragraphs) {
    if (buf.length + para.length + 2 > TARGET_CHARS && buf.length > 0) {
      emit(cursor);
    }
    if (para.length > TARGET_CHARS) {
      // Single huge paragraph: hard-wrap it.
      let i = 0;
      while (i < para.length) {
        const slice = para.slice(i, i + TARGET_CHARS);
        if (buf.length > 0) {
          emit(cursor + i);
        }
        buf = slice;
        bufStart = cursor + i;
        i += TARGET_CHARS - OVERLAP_CHARS;
      }
      cursor += para.length + 2;
      continue;
    }
    buf += (buf.length > 0 ? '\n\n' : '') + para;
    cursor += para.length + 2;
  }
  if (buf.trim().length > 0) emit(cursor);
  return chunks;
}

function normalize(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function splitParagraphs(text: string): string[] {
  return text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
}

/** Quick best-effort HTML → text. Strips tags, decodes the most common
 * entities, collapses whitespace. Good enough for vector ingest. */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** Markdown → text. Strips headings, lists, links, code fences. */
export function markdownToText(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```/g, ''))
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '');
}
