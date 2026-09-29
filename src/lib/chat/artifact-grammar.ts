import { findAllArtifacts } from './vendor/librechat-update.js';

export type DashboardArtifact = {
  identifier: string;
  title: string;
  mimeType: string;
  body: string;
};

export type ArtifactExtraction = {
  text: string;
  artifacts: DashboardArtifact[];
};

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_ARTIFACTS = 8;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const HEADER_PATTERN = /^:::artifact\{identifier="([^"\r\n]*)" type="([^"\r\n]*)" title="([^"\r\n]*)"\}$/;
export const UNSAFE_ARTIFACT_TITLE_PATTERN = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;

const MIME_TYPES: Readonly<Record<string, string>> = Object.freeze({
  'text/plain': 'text/plain',
  'text/markdown': 'text/markdown',
  'text/html': 'text/html',
  'image/svg+xml': 'image/svg+xml',
  Mermaid: 'text/vnd.mermaid',
  code: 'text/plain',
  JSON: 'application/json',
  'application/json': 'application/json',
  CSV: 'text/csv',
  'text/csv': 'text/csv',
});

type ParsedBoundary = {
  start: number;
  end: number;
  identifier: string;
  title: string;
  mimeType: string;
  body: string;
};

const safeTitle = (title: string): boolean =>
  title.length > 0 &&
  title.length <= 120 &&
  title.trim() === title &&
  !title.includes('\\') &&
  !UNSAFE_ARTIFACT_TITLE_PATTERN.test(title);

// Stop as soon as the limit is crossed; this avoids allocating an encoded copy
// of an arbitrarily large model response.
const utf8LengthWithinLimit = (value: string, limit: number): number | null => {
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index++;
      } else {
        bytes += 3;
      }
    } else {
      // Lone UTF-16 surrogates are encoded as U+FFFD by TextEncoder.
      bytes += 3;
    }
    if (bytes > limit) return null;
  }
  return bytes;
};

const parseBoundary = (
  text: string,
  boundary: { start: number; end: number },
): ParsedBoundary | null => {
  const openingLineEnd = text.indexOf('\n', boundary.start);
  if (openingLineEnd === -1 || openingLineEnd >= boundary.end) return null;

  const openingLine = text.slice(boundary.start, openingLineEnd).replace(/\r$/, '');
  const header = HEADER_PATTERN.exec(openingLine);
  if (!header) return null;

  const [, identifier, type, title] = header;
  if (!IDENTIFIER_PATTERN.test(identifier) || identifier === '.' || identifier === '..') return null;
  if (!safeTitle(title)) return null;
  const mimeType = MIME_TYPES[type];
  if (!mimeType) return null;

  const closeStart = boundary.end - 3;
  if (closeStart < openingLineEnd + 1 || text.slice(closeStart, boundary.end) !== ':::') return null;
  const closeLineStart = text.lastIndexOf('\n', closeStart - 1) + 1;
  const closeLineEnd = text.indexOf('\n', boundary.end);
  const closeLine = text.slice(closeLineStart, closeLineEnd === -1 ? text.length : closeLineEnd);
  if (!/^[\t ]*:::[\t ]*\r?$/.test(closeLine)) return null;

  let bodyEnd = closeLineStart;
  if (bodyEnd > openingLineEnd + 1 && text[bodyEnd - 1] === '\n') {
    bodyEnd--;
    if (bodyEnd > openingLineEnd + 1 && text[bodyEnd - 1] === '\r') bodyEnd--;
  }
  const bodyStart = openingLineEnd + 1;
  const body = text.slice(bodyStart, bodyEnd);
  if (body.trim().length === 0) return null;

  return { start: boundary.start, end: boundary.end, identifier, title, mimeType, body };
};

/** Extract complete, safe textual LibreChat artifact blocks from a response. */
export const extractArtifactBlocks = (text: string): ArtifactExtraction => {
  const boundaries = findAllArtifacts({ text });
  const accepted: ParsedBoundary[] = [];

  for (const boundary of boundaries) {
    const parsed = parseBoundary(text, boundary);
    if (!parsed) continue;

    if (utf8LengthWithinLimit(parsed.body, MAX_BODY_BYTES) === null) {
      throw new Error(`Artifact body exceeds the ${MAX_BODY_BYTES} byte limit`);
    }
    if (accepted.length >= MAX_ARTIFACTS) {
      throw new Error(`Artifact count exceeds the limit of ${MAX_ARTIFACTS} per turn`);
    }
    accepted.push(parsed);
  }

  if (accepted.length === 0) {
    return Object.freeze({ text, artifacts: Object.freeze([]) as unknown as DashboardArtifact[] });
  }

  const artifacts: DashboardArtifact[] = [];
  const visible: string[] = [];
  let cursor = 0;
  for (const artifact of accepted) {
    visible.push(text.slice(cursor, artifact.start));
    cursor = artifact.end;
    artifacts.push(Object.freeze({
      identifier: artifact.identifier,
      title: artifact.title,
      mimeType: artifact.mimeType,
      body: artifact.body,
    }));
  }
  visible.push(text.slice(cursor));

  return Object.freeze({
    text: visible.join(''),
    artifacts: Object.freeze(artifacts) as unknown as DashboardArtifact[],
  });
};
