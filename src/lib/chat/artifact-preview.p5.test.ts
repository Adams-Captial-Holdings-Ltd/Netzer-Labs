/** P5 deck outline (the PowerPoint preview): real decks, bounded archives, capped text. */
import { expect, it } from 'vitest';
import JSZip from 'jszip';
import { buildPptx } from '../documents/pptx.js';

const load = async () => import('./artifact-preview.js').catch(() => null);

function slideXml(...runs: string[]): string {
  const shapes = runs
    .map((run) => `<p:sp><p:txBody><a:p><a:r><a:t>${run}</a:t></a:r></a:p></p:txBody></p:sp>`)
    .join('');
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
    'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">' +
    `<p:cSld><p:spTree>${shapes}</p:spTree></p:cSld></p:sld>`;
}

async function deck(slides: Record<string, string>): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types/>');
  for (const [name, xml] of Object.entries(slides)) zip.file(`ppt/slides/${name}`, xml);
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

it('P5 deck outline keeps slide order and text only', async () => {
  const preview = await load();
  expect(preview?.deckOutline, 'a bounded deck outline must exist').toBeTypeOf('function');

  // A real deck from the P4 builder: its words come back in order, as plain text.
  const real = await buildPptx({ title: 'Launch', slides: [
    { title: 'Why now', bullets: ['Costs & risks'] },
    { title: 'Plan', body: 'Ship <b>it</b>' },
  ] });
  const outline = await preview!.deckOutline(new Uint8Array(real));
  expect(outline.truncated).toBe(false);
  expect(outline.slides.map((s: { index: number }) => s.index), 'slides are numbered 1..n')
    .toEqual(outline.slides.map((_: unknown, i: number) => i + 1));
  const words = outline.slides.map((s: { text: string }) => s.text).join('\n');
  expect(words).toMatch(/Why now[\s\S]*Costs & risks[\s\S]*Plan[\s\S]*Ship <b>it<\/b>/);
  expect(words, 'no slide markup leaks into the outline').not.toMatch(/<a:t>|<p:|xmlns/);

  // Numeric slide order (slide2 before slide10), entities decoded, runs joined by one space.
  const ordered = await preview!.deckOutline(await deck({
    'slide10.xml': slideXml('Ten'),
    'slide2.xml': slideXml('Two'),
    'slide1.xml': slideXml('One &amp; only', '&lt;script&gt;'),
  }));
  expect(ordered).toEqual({
    slides: [{ index: 1, text: 'One & only <script>' }, { index: 2, text: 'Two' }, { index: 3, text: 'Ten' }],
    truncated: false,
  });
});

it('P5 deck outline refuses archive bombs before inflating them', async () => {
  const preview = await load();
  expect(preview?.deckOutline, 'a bounded deck outline must exist').toBeTypeOf('function');

  // One slide that inflates past the per-entry ceiling: refused by the bounded ZIP
  // check before any slide XML is parsed.
  const bomb = new JSZip();
  bomb.file('ppt/slides/slide1.xml', 'A'.repeat(20 * 1024 * 1024 + 1));
  const bombBytes = await bomb.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
  expect(bombBytes.byteLength, 'the fixture is small on the wire').toBeLessThan(200_000);
  await expect(preview!.deckOutline(bombBytes)).rejects.toMatchObject({ code: 'unsafe_archive' });

  // More bytes than a stored artifact can hold: refused without being read as a zip.
  await expect(preview!.deckOutline(new Uint8Array(30 * 1024 * 1024 + 1)))
    .rejects.toMatchObject({ code: 'unsafe_archive' });

  // Not a zip at all, and a zip with no slides, are not decks.
  await expect(preview!.deckOutline(new TextEncoder().encode('<html>not a deck</html>')))
    .rejects.toMatchObject({ code: 'not_deck' });
  await expect(preview!.deckOutline(await deck({}))).rejects.toMatchObject({ code: 'not_deck' });
});

it('P5 deck outline caps slides and characters and says it truncated', async () => {
  const preview = await load();
  expect(preview?.DECK_LIMITS, 'the preview limits are explicit (plan WI-5.2: size, CPU and time)').toEqual({
    maxBytes: 30 * 1024 * 1024,
    maxEntries: 1000,
    maxEntryBytes: 20 * 1024 * 1024,
    maxTotalBytes: 60 * 1024 * 1024,
    maxSlides: 200,
    maxSlideChars: 2000,
    timeoutMs: 5000,
  });

  const many: Record<string, string> = {};
  for (let i = 1; i <= 205; i++) many[`slide${i}.xml`] = slideXml(`Slide ${i}`);
  const capped = await preview!.deckOutline(await deck(many));
  expect(capped.slides).toHaveLength(200);
  expect(capped.slides.at(-1)).toEqual({ index: 200, text: 'Slide 200' });
  expect(capped.truncated).toBe(true);

  const long = await preview!.deckOutline(await deck({ 'slide1.xml': slideXml('x'.repeat(2500)) }));
  expect(long.slides[0]!.text.length).toBeLessThanOrEqual(2000);
  expect(long.truncated).toBe(true);

  const fits = await preview!.deckOutline(await deck({ 'slide1.xml': slideXml('short') }));
  expect(fits).toEqual({ slides: [{ index: 1, text: 'short' }], truncated: false });
});
