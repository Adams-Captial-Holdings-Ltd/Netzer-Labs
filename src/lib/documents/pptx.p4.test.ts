/** P4 ART-11: a slide spec must produce an editable, reparsable PPTX package. */
import { expect, it } from 'vitest';
import JSZip from 'jszip';

it('P4 builds a PowerPoint whose OOXML slides reparse with their titles and text', async () => {
  const modulePath = './pptx.js';
  const module = await import(modulePath).catch(() => null) as null | { buildPptx?: (spec: unknown) => Promise<Buffer> };
  expect(module?.buildPptx, 'ART-11 needs the PowerPoint slide-spec builder').toBeTypeOf('function');
  const bytes = await module!.buildPptx!({ title: 'Launch deck', slides: [
    { title: 'Launch', body: 'A planned launch' },
    { title: 'Metrics', bullets: ['Reliable storage', 'Owner-safe links'] },
  ] });
  expect(bytes.subarray(0, 2).toString('ascii')).toBe('PK');
  const zip = await JSZip.loadAsync(bytes);
  expect(zip.file('[Content_Types].xml')).not.toBeNull();
  expect(zip.file('ppt/presentation.xml')).not.toBeNull();
  const slides = Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).sort();
  expect(slides, 'two slide bodies must survive package reparse').toHaveLength(2);
  const xml = await Promise.all(slides.map((name) => zip.file(name)!.async('string')));
  expect(xml[0]).toContain('Launch');
  expect(xml[0]).toContain('A planned launch');
  expect(xml[1]).toContain('Metrics');
  expect(xml[1]).toContain('Reliable storage');
  expect(xml[1]).toContain('Owner-safe links');
});
