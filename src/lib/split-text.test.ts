import { describe, it, expect } from 'vitest';
import { splitLongText } from './split-text.js';

describe('splitLongText', () => {
  it('returns short text as a single piece', () => {
    expect(splitLongText('hello', 100)).toEqual(['hello']);
  });

  it('returns [] for empty text', () => {
    expect(splitLongText('', 100)).toEqual([]);
  });

  it('splits on paragraph boundaries when possible', () => {
    const a = 'a'.repeat(60);
    const b = 'b'.repeat(60);
    const pieces = splitLongText(`${a}\n\n${b}`, 100);
    expect(pieces).toEqual([a, b]);
  });

  it('falls back to line boundaries', () => {
    const a = 'a'.repeat(60);
    const b = 'b'.repeat(60);
    const pieces = splitLongText(`${a}\n${b}`, 100);
    expect(pieces).toEqual([a, b]);
  });

  it('hard-cuts a single unbroken run', () => {
    const pieces = splitLongText('x'.repeat(250), 100);
    expect(pieces).toHaveLength(3);
    expect(pieces.join('')).toBe('x'.repeat(250));
    for (const p of pieces) expect(p.length).toBeLessThanOrEqual(100);
  });

  it('never emits a piece over max and loses no non-whitespace content', () => {
    const text = Array.from({ length: 40 }, (_, i) => `para ${i} ${'y'.repeat(i * 7)}`).join('\n\n');
    const pieces = splitLongText(text, 300);
    for (const p of pieces) expect(p.length).toBeLessThanOrEqual(300);
    expect(pieces.join('').replace(/\s+/g, '')).toBe(text.replace(/\s+/g, ''));
  });
});
