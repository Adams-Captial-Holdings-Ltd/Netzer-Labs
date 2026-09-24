/**
 * P3 (step 5) — WI-3.2's bounded ZIP check.
 *
 * Written BEFORE the change, as the bar (netzar-chat-plan/p3-proof.sh rows F-3..F-8).
 *
 * A .docx or .pptx is a ZIP container, and the libraries that read one inflate it
 * whole. A 1 MB upload can inflate to gigabytes (a "zip bomb"), and the sizes a ZIP
 * declares for its entries are written by whoever made it, so they cannot be
 * trusted: LibreChat's zipSafety.ts (the donor's pattern B, at the pinned commit)
 * counts the bytes that actually come out instead. This check does the same with
 * node's own zlib — no new package (owner constraint 1): it walks the central
 * directory, refuses too many entries, and inflates each entry under a hard output
 * cap, per entry and in total. Nothing is written to disk and no entry is kept.
 *
 * Caps are options so the tests can use small ones; the last test pins the
 * defaults the step specifies.
 */

import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { checkZip, ZipCheckError, ZIP_LIMITS } from './zip-check.js';

const MB = 1024 * 1024;

async function zipOf(files: Record<string, string | Uint8Array>): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) zip.file(name, content);
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

/** The error code a check raised, or undefined when it passed. Works for a sync or an async check. */
async function codeOf(check: () => unknown): Promise<string | undefined> {
  try {
    await check();
    return undefined;
  } catch (err) {
    expect(err).toBeInstanceOf(ZipCheckError);
    return (err as ZipCheckError).code;
  }
}

describe('chat attachments (P3) — the bounded ZIP check', () => {
  it('passes a real office document', async () => {
    const docx = await zipOf({
      '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
      '_rels/.rels': '<?xml version="1.0"?><Relationships/>',
      'word/document.xml': `<w:document><w:body><w:p><w:r><w:t>${'Quarterly numbers. '.repeat(500)}</w:t></w:r></w:p></w:body></w:document>`,
    });
    const pptx = await zipOf({
      '[Content_Types].xml': '<?xml version="1.0"?><Types/>',
      'ppt/slides/slide1.xml': '<p:sld><a:t>Roadmap</a:t></p:sld>',
    });

    expect(await codeOf(() => checkZip(docx))).toBeUndefined();
    expect(await codeOf(() => checkZip(pptx))).toBeUndefined();
  });

  it('refuses a zip that inflates past its cap', async () => {
    // Two entries, each inside the per-entry cap; together over the total. So what
    // fails is the running total, not one oversized entry.
    const bomb = await zipOf({ 'a.xml': new Uint8Array(600 * 1024), 'b.xml': new Uint8Array(600 * 1024) });
    expect(bomb.length).toBeLessThan(20 * 1024); // zeros compress to almost nothing

    expect(await codeOf(() => checkZip(bomb, { maxTotalBytes: MB, maxEntryBytes: MB }))).toBe('too_large');
  });

  it('refuses a zip whose sizes lie', async () => {
    // One 2 MB entry that DECLARES 16 bytes, in both its local header and the
    // central directory. A check that trusted the declared size would pass it.
    const honest = Buffer.from(await zipOf({ 'word/document.xml': new Uint8Array(2 * MB) }));
    const lying = Buffer.from(honest);
    expect(lying.readUInt32LE(0)).toBe(0x04034b50); // the first local file header
    lying.writeUInt32LE(16, 22); // its uncompressed size
    const central = lying.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    expect(central).toBeGreaterThan(0);
    lying.writeUInt32LE(16, central + 24); // the central directory's copy

    expect(await codeOf(() => checkZip(lying, { maxEntryBytes: MB }))).toBe('entry_too_large');
  });

  it('refuses a zip with too many entries', async () => {
    const files = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`f${i}.txt`, 'x']));
    const many = await zipOf(files);

    expect(await codeOf(() => checkZip(many, { maxEntries: 5 }))).toBe('too_many_entries');
    expect(await codeOf(() => checkZip(many, { maxEntries: 6 }))).toBeUndefined();
  });

  it('refuses bytes that are not a zip', async () => {
    const real = await zipOf({ 'a.txt': 'hello' });

    expect(await codeOf(() => checkZip(Buffer.from('this is not a zip archive at all')))).toBe('not_zip');
    expect(await codeOf(() => checkZip(new Uint8Array(0)))).toBe('not_zip');
    // Cut in half: the directory at the end is gone.
    expect(await codeOf(() => checkZip(real.subarray(0, Math.floor(real.length / 2))))).toBe('not_zip');
  });

  it('sets the default limits the step specifies', () => {
    // 1,000 entries, 50 MB inflated per entry (a 30 MB document with one large
    // embedded picture still fits), 100 MB inflated in total (the donor's default).
    expect(ZIP_LIMITS).toEqual({ maxEntries: 1000, maxEntryBytes: 50 * MB, maxTotalBytes: 100 * MB });
  });
});
