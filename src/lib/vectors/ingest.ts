/**
 * Ingest pipeline: raw text → chunks → embeddings → S3 vector index.
 *
 * Supported input formats (auto-detected by extension or explicit hint):
 *   .txt              plain text
 *   .md               markdown (stripped to text first)
 *   .html             HTML (tags removed)
 *   .pdf              binary, extracted with pdf-parse (per-page → page-tagged chunks)
 *   .docx             binary, extracted with mammoth
 *   .pptx             binary, slide text extracted with jszip
 *   .mp3/.m4a/.wav/…  audio, transcribed with Amazon Transcribe upstream and
 *                     handed to this pipeline as the transcript text (format
 *                     'audio'); the HTTP layer owns the transcription step.
 *
 * Binary formats (pdf/docx/pptx) arrive as base64 in `contentBase64`. Audio is
 * transcribed to text BEFORE ingest (see the /ingest/stream handler), so by the
 * time it reaches here it's just text tagged with format 'audio'.
 */

import { randomUUID } from 'node:crypto';
import { embedMany } from './embedder.js';
import { chunkText, htmlToText, markdownToText, type Chunk } from './chunker.js';
import {
  deleteDocument,
  putDocument,
  type VectorMetadata,
  type VectorRow,
} from './store.js';
import { extractDocxText, extractPdfText, extractPptxText } from './extractors.js';
import { logger } from '../../observability/logger.js';

export type IngestFormat =
  | 'text'
  | 'markdown'
  | 'html'
  | 'pdf'
  | 'docx'
  | 'pptx'
  | 'audio';

export interface IngestRequest {
  /** Logical corpus partition, e.g. "default", "agent:ops". */
  scope?: string;
  /** Optional explicit id; defaults to a fresh UUID. Pass to update an existing doc. */
  docId?: string;
  /** Display title surfaced in citations. */
  docTitle?: string;
  /** Where the doc came from (URL, filename, s3 key). */
  source?: string;
  /** Raw input text for text/markdown/html formats. */
  content?: string;
  /** Base64-encoded bytes for pdf/docx formats. */
  contentBase64?: string;
  /** Override the auto-detected format. */
  format?: IngestFormat;
  /** Tags for retrieval-time filtering. */
  tags?: string[];
}

export interface IngestResult {
  docId: string;
  scope: string;
  /** Chunks actually embedded AND stored — the true searchable count. */
  chunks: number;
  /**
   * Chunks whose embedding call failed and were therefore NOT indexed. > 0
   * means the ingest is partial: those passages are not retrievable. Re-run
   * the ingest once Bedrock recovers to capture them.
   */
  failed: number;
  uploadedAt: string;
}

/**
 * Pipeline progress event, surfaced over SSE so the UI can show the ingest
 * stages transparently: extract -> chunk -> embed (with done/total) -> index.
 * The terminal `done`/`error` events are emitted by the HTTP layer from the
 * result, not here.
 */
export interface IngestProgress {
  stage: 'extract' | 'chunk' | 'embed' | 'index';
  chunks?: number;
  done?: number;
  total?: number;
}

export async function ingestDocument(
  req: IngestRequest,
  onProgress?: (ev: IngestProgress) => void,
): Promise<IngestResult> {
  const docId = (req.docId ?? randomUUID()).replace(/[^A-Za-z0-9._-]/g, '_');
  const scope = (req.scope ?? 'default').replace(/[^A-Za-z0-9_-]/g, '_');
  const format = req.format ?? detectFormat(req.source);
  onProgress?.({ stage: 'extract' });
  let text: string;
  // For PDFs we keep the per-page text so chunks can be tagged with a page
  // number for citations. Other formats have no pages.
  let pdfPages: { num: number; text: string }[] | undefined;
  if (format === 'pdf') {
    if (!req.contentBase64) {
      throw new Error('contentBase64 required for pdf ingest');
    }
    const out = await extractPdfText(Buffer.from(req.contentBase64, 'base64'));
    text = out.text;
    pdfPages = out.pageTexts;
  } else if (format === 'docx') {
    if (!req.contentBase64) {
      throw new Error('contentBase64 required for docx ingest');
    }
    const out = await extractDocxText(Buffer.from(req.contentBase64, 'base64'));
    text = out.text;
  } else if (format === 'pptx') {
    if (!req.contentBase64) {
      throw new Error('contentBase64 required for pptx ingest');
    }
    const out = await extractPptxText(Buffer.from(req.contentBase64, 'base64'));
    text = out.text;
  } else if (format === 'audio') {
    // Audio is transcribed to text by the HTTP layer before it reaches here;
    // `content` is the transcript. We never receive raw audio bytes in ingest.
    text = req.content ?? '';
  } else if (format === 'markdown') {
    text = markdownToText(req.content ?? '');
  } else if (format === 'html') {
    text = htmlToText(req.content ?? '');
  } else {
    text = req.content ?? '';
  }
  // PDFs: chunk each page on its own and tag the page number, so a retrieved
  // passage cites the exact source page. Everything else is one text body.
  type PagedChunk = Chunk & { page?: number };
  let chunks: PagedChunk[];
  if (pdfPages && pdfPages.length > 0) {
    chunks = [];
    let order = 0;
    let offset = 0;
    for (const pg of pdfPages) {
      for (const c of chunkText(pg.text)) {
        chunks.push({ text: c.text, index: order++, start: offset + c.start, end: offset + c.end, page: pg.num });
      }
      offset += pg.text.length;
    }
  } else {
    chunks = chunkText(text);
  }
  onProgress?.({ stage: 'chunk', chunks: chunks.length });
  if (chunks.length === 0) {
    return {
      docId,
      scope,
      chunks: 0,
      failed: 0,
      uploadedAt: new Date().toISOString(),
    };
  }
  const embeddings = await embedMany(
    chunks.map((c) => c.text),
    (done, total) => onProgress?.({ stage: 'embed', done, total }),
  );
  // Drop any chunk whose embedding failed (null). A zero/garbage vector is
  // never written: it would be permanently unretrievable (cosine similarity
  // against it is 0) yet counted as indexed. We index only the chunks that
  // truly embedded and report how many were dropped.
  const uploadedAt = new Date().toISOString();
  const rows: VectorRow[] = [];
  chunks.forEach((c, i) => {
    const embedding = embeddings[i];
    if (!embedding) return; // failed embed — skip, do not index
    const metadata: VectorMetadata = {
      docId,
      scope,
      chunkIndex: c.index,
      start: c.start,
      end: c.end,
      uploadedAt,
      ...(c.page ? { page: c.page } : {}),
      ...(req.docTitle ? { docTitle: req.docTitle } : {}),
      ...(req.source ? { source: req.source } : {}),
      ...(req.tags && req.tags.length > 0 ? { tags: req.tags } : {}),
    };
    rows.push({
      chunkId: `${docId}:${c.index}`,
      text: c.text,
      embedding,
      metadata,
    });
  });
  const failed = chunks.length - rows.length;
  // Every chunk failed to embed — nothing is searchable, so do not pretend the
  // ingest succeeded. Surface a hard error the caller can show and retry.
  if (rows.length === 0) {
    throw new Error(
      `embedding failed for all ${chunks.length} chunks; nothing indexed (Bedrock embed unavailable?)`,
    );
  }
  onProgress?.({ stage: 'index', chunks: rows.length });
  await putDocument(scope, docId, rows);
  logger.info(
    {
      docId,
      scope,
      chunks: rows.length,
      failed,
      title: req.docTitle ?? null,
    },
    failed > 0 ? 'vector ingest stored (partial: some chunks failed)' : 'vector ingest stored',
  );
  return { docId, scope, chunks: rows.length, failed, uploadedAt };
}

export async function removeDocument(
  scope: string,
  docId: string,
): Promise<void> {
  await deleteDocument(scope, docId);
}

// Audio extensions Amazon Transcribe can handle (mapped to a MediaFormat in
// the transcriber). Kept in sync with FORMAT_MAP in transcribe/transcriber.ts.
const AUDIO_EXTS = ['.mp3', '.m4a', '.wav', '.ogg', '.oga', '.flac', '.webm', '.mp4'];

export function detectFormat(source?: string): IngestFormat {
  if (!source) return 'text';
  const lower = source.toLowerCase();
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'markdown';
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'html';
  if (lower.endsWith('.pdf')) return 'pdf';
  if (lower.endsWith('.docx')) return 'docx';
  if (lower.endsWith('.pptx')) return 'pptx';
  if (AUDIO_EXTS.some((ext) => lower.endsWith(ext))) return 'audio';
  return 'text';
}
