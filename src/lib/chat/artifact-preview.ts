/** Bounded plain-text outline for generated PowerPoint decks. */
import JSZip from 'jszip';
import { checkZip, ZipCheckError } from './zip-check.js';

export const DECK_LIMITS = {
  maxBytes: 30 * 1024 * 1024,
  maxEntries: 1000,
  maxEntryBytes: 20 * 1024 * 1024,
  maxTotalBytes: 60 * 1024 * 1024,
  maxSlides: 200,
  maxSlideChars: 2000,
  timeoutMs: 5000,
};

export class DeckOutlineError extends Error {
  constructor(public readonly code: 'not_deck' | 'unsafe_archive' | 'timeout') {
    super(`Deck outline failed: ${code}`);
    this.name = 'DeckOutlineError';
  }
}

export interface DeckOutline {
  slides: Array<{ index: number; text: string }>;
  truncated: boolean;
}

function decodeEntities(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|apos|#(?:\d+|x[0-9a-fA-F]+));/g, (entity) => {
    const named: Record<string, string> = {
      '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'",
    };
    if (entity in named) return named[entity]!;
    const hex = entity.startsWith('&#x');
    const value = parseInt(entity.slice(hex ? 3 : 2, -1), hex ? 16 : 10);
    return value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff)
      ? String.fromCodePoint(value) : '\uFFFD';
  });
}

export async function deckOutline(bytes: Uint8Array): Promise<DeckOutline> {
  if (bytes.byteLength > DECK_LIMITS.maxBytes) throw new DeckOutlineError('unsafe_archive');
  try {
    checkZip(bytes, {
      maxEntries: DECK_LIMITS.maxEntries,
      maxEntryBytes: DECK_LIMITS.maxEntryBytes,
      maxTotalBytes: DECK_LIMITS.maxTotalBytes,
    });
  } catch (error) {
    if (error instanceof ZipCheckError) {
      throw new DeckOutlineError(error.code === 'not_zip' ? 'not_deck' : 'unsafe_archive');
    }
    throw error;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DeckOutlineError('timeout')), DECK_LIMITS.timeoutMs);
  });
  try {
    return await Promise.race([parseDeck(bytes), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function parseDeck(bytes: Uint8Array): Promise<DeckOutline> {
  const zip = await JSZip.loadAsync(bytes);
  const slides = Object.entries(zip.files)
    .map(([name, file]) => ({ file, number: /^ppt\/slides\/slide(\d+)\.xml$/.exec(name)?.[1] }))
    .filter((entry): entry is { file: JSZip.JSZipObject; number: string } => entry.number !== undefined)
    .sort((a, b) => Number(a.number) - Number(b.number));
  if (slides.length === 0) throw new DeckOutlineError('not_deck');

  let truncated = slides.length > DECK_LIMITS.maxSlides;
  const outline: DeckOutline['slides'] = [];
  for (const { file } of slides.slice(0, DECK_LIMITS.maxSlides)) {
    const xml = await file.async('string');
    const runs = [...xml.matchAll(/<a:t(?:\s[^>]*)?>([^<]*)<\/a:t>/g)]
      .map((match) => decodeEntities(match[1]!));
    const text = runs.join(' ').replace(/\s+/g, ' ').trim();
    if (text.length > DECK_LIMITS.maxSlideChars) truncated = true;
    outline.push({ index: outline.length + 1, text: text.slice(0, DECK_LIMITS.maxSlideChars) });
  }
  return { slides: outline, truncated };
}
