/** A bounded, deterministic builder for editable PowerPoint text slides. */

import pptxgen from 'pptxgenjs';
import JSZip from 'jszip';
import type { PresentationSpec, PresentationSlide } from './types.js';

interface PptxPresentation {
  layout: string;
  title: string;
  addSlide(): {
    addText(text: string, options: Record<string, string | number | boolean>): unknown;
  };
  write(options: { outputType: 'nodebuffer' }): Promise<unknown>;
}
type PptxConstructor = new () => PptxPresentation;

const MAX_SPEC_BYTES = 1 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 30 * 1024 * 1024;
const MAX_SLIDES = 100;
const MAX_SLIDE_TITLE = 200;
const MAX_BODY_TEXT = 12_000;
const MAX_BULLETS = 50;
const MAX_BULLET_TEXT = 2_000;
const MAX_TOTAL_TEXT = 200_000;

function cleanText(value: string): string {
  // Keep the whitespace users expect while removing XML-illegal C0 controls.
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

function assertText(value: unknown, label: string, limit: number, allowEmpty = true): string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    throw new Error(`${label} must be ${allowEmpty ? 'text' : 'non-empty text'}`);
  }
  if (value.length > limit) throw new Error(`${label} exceeds ${limit} characters`);
  return cleanText(value);
}

export function validatePresentationSpec(input: unknown): PresentationSpec {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('spec must be an object');
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(input);
  } catch {
    throw new Error('spec must be JSON serializable');
  }
  if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > MAX_SPEC_BYTES) {
    throw new Error(`serialized spec exceeds ${MAX_SPEC_BYTES} bytes`);
  }

  const source = input as Record<string, unknown>;
  const title = assertText(source.title, 'spec.title', MAX_SLIDE_TITLE, false);
  if (!Array.isArray(source.slides) || source.slides.length === 0) {
    throw new Error('spec.slides must contain at least one slide');
  }
  if (source.slides.length > MAX_SLIDES) throw new Error(`spec.slides exceeds ${MAX_SLIDES} entries`);

  let totalText = title.length;
  const slides: PresentationSlide[] = source.slides.map((raw, index) => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new Error(`slide ${index + 1} must be an object`);
    }
    const slide = raw as Record<string, unknown>;
    const slideTitle = assertText(slide.title, `slide ${index + 1}.title`, MAX_SLIDE_TITLE, false);
    const body = slide.body === undefined
      ? undefined
      : assertText(slide.body, `slide ${index + 1}.body`, MAX_BODY_TEXT);
    let bullets: string[] | undefined;
    if (slide.bullets !== undefined) {
      if (!Array.isArray(slide.bullets)) throw new Error(`slide ${index + 1}.bullets must be an array`);
      if (slide.bullets.length > MAX_BULLETS) throw new Error(`slide ${index + 1}.bullets exceeds ${MAX_BULLETS} entries`);
      bullets = slide.bullets.map((bullet, bulletIndex) =>
        assertText(bullet, `slide ${index + 1}.bullets[${bulletIndex}]`, MAX_BULLET_TEXT, false));
    }
    totalText += slideTitle.length + (body?.length ?? 0) + (bullets?.reduce((sum, item) => sum + item.length, 0) ?? 0);
    if (totalText > MAX_TOTAL_TEXT) throw new Error(`slide text exceeds ${MAX_TOTAL_TEXT} characters`);
    return { title: slideTitle, ...(body !== undefined ? { body } : {}), ...(bullets !== undefined ? { bullets } : {}) };
  });
  return { title, slides };
}

function slideContent(slide: PresentationSlide): string {
  const lines = [slide.body, ...(slide.bullets ?? []).map((item) => `• ${item}`)]
    .filter((line): line is string => line !== undefined && line.length > 0);
  return lines.join('\n\n');
}

async function assertReparsablePptx(bytes: Buffer, slideCount: number): Promise<void> {
  const zip = await JSZip.loadAsync(bytes);
  const required = ['[Content_Types].xml', 'ppt/presentation.xml'];
  if (required.some((name) => !zip.file(name))) throw new Error('generated presentation package is incomplete');
  const slideNames = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => Number(a.match(/slide(\d+)/)?.[1]) - Number(b.match(/slide(\d+)/)?.[1]));
  if (slideNames.length !== slideCount || slideNames.some((name) => !zip.file(name))) {
    throw new Error('generated presentation slides could not be verified');
  }
  await Promise.all(slideNames.map(async (name) => {
    const xml = await zip.file(name)!.async('string');
    if (!xml.startsWith('<?xml') || !xml.includes('<p:sld')) {
      throw new Error('generated presentation slide could not be reparsed');
    }
  }));
}

export async function buildPptx(input: unknown): Promise<Buffer> {
  const spec = validatePresentationSpec(input);
  const Pptx = pptxgen as unknown as PptxConstructor;
  const pptx = new Pptx();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.title = spec.title;

  for (const content of spec.slides) {
    const slide = pptx.addSlide();
    slide.addText(content.title, {
      x: 0.7, y: 0.55, w: 12, h: 0.75,
      fontSize: 28, bold: true, margin: 0,
      breakLine: false, fit: 'shrink',
    });
    const body = slideContent(content);
    if (body) {
      slide.addText(body, {
        x: 0.85, y: 1.65, w: 11.6, h: 5.15,
        fontSize: 18, margin: 0.05, valign: 'top',
        breakLine: false, fit: 'shrink',
      });
    }
  }

  const generated = await pptx.write({ outputType: 'nodebuffer' });
  if (!(generated instanceof Uint8Array)) throw new Error('presentation builder returned invalid bytes');
  const bytes = Buffer.from(generated);
  if (bytes.length < 1 || bytes.length > MAX_OUTPUT_BYTES) {
    throw new Error(`generated presentation exceeds ${MAX_OUTPUT_BYTES} bytes`);
  }
  await assertReparsablePptx(bytes, spec.slides.length);
  return bytes;
}
