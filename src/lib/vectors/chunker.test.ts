import { describe, it, expect } from 'vitest';
import { chunkText, htmlToText, markdownToText } from './chunker.js';

describe('chunkText', () => {
  it('returns empty array for empty input', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('   \n  ')).toEqual([]);
  });

  it('returns a single chunk for short text', () => {
    const out = chunkText('hello world');
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe('hello world');
  });

  it('splits long paragraphs into multiple chunks with overlap', () => {
    const para1 = 'a '.repeat(1100); // ~2200 chars
    const para2 = 'b '.repeat(1100);
    const out = chunkText(`${para1}\n\n${para2}`);
    expect(out.length).toBeGreaterThan(1);
    out.forEach((c) => {
      expect(c.text.length).toBeLessThanOrEqual(2200);
      expect(c.text.length).toBeGreaterThan(0);
    });
  });

  it('preserves paragraph boundaries when possible', () => {
    const text = 'first paragraph.\n\nsecond paragraph.';
    const out = chunkText(text);
    expect(out).toHaveLength(1);
    expect(out[0].text).toContain('first paragraph');
    expect(out[0].text).toContain('second paragraph');
  });

  it('does not drop a short opening line before a huge paragraph', () => {
    // Regression: a sub-MIN_CHARS buffer used to be silently discarded when
    // the next paragraph entered the hard-wrap branch, so a bare title line
    // was never embedded or indexed.
    const title = 'Q3 Budget Summary';
    const out = chunkText(`${title}\n\n${'x'.repeat(5000)}`);
    expect(out.map((c) => c.text).join('\n')).toContain(title);
  });
});

describe('htmlToText', () => {
  it('strips tags and decodes entities', () => {
    expect(htmlToText('<p>Hello &amp; <b>world</b></p>')).toBe('Hello & world');
  });

  it('removes scripts and styles entirely', () => {
    const html = '<style>body{color:red}</style><p>visible</p><script>alert(1)</script>';
    expect(htmlToText(html)).toBe('visible');
  });
});

describe('markdownToText', () => {
  it('strips headings and lists', () => {
    const md = '# Title\n\n- item one\n- item two';
    const out = markdownToText(md);
    expect(out).not.toContain('#');
    expect(out).not.toContain('- ');
  });

  it('keeps inline link text', () => {
    expect(markdownToText('see [docs](https://x.com)')).toBe('see docs');
  });
});
