import { describe, it, expect } from 'vitest';
import { markdownToMrkdwn } from './mrkdwn.js';

describe('markdownToMrkdwn', () => {
  it('converts **bold** to *bold*', () => {
    expect(markdownToMrkdwn('hello **world** there')).toBe('hello *world* there');
  });

  it('converts __bold__ to *bold*', () => {
    expect(markdownToMrkdwn('__strong__')).toBe('*strong*');
  });

  it('strips header marks and bolds the line', () => {
    expect(markdownToMrkdwn('### Memory & Knowledge')).toBe('*Memory & Knowledge*');
    expect(markdownToMrkdwn('# Big Title')).toBe('*Big Title*');
  });

  it('converts markdown links to mrkdwn links', () => {
    expect(markdownToMrkdwn('see [docs](https://example.com/x)')).toBe(
      'see <https://example.com/x|docs>',
    );
  });

  it('removes horizontal rules', () => {
    expect(markdownToMrkdwn('first\n\n---\n\nsecond')).toBe('first\n\nsecond');
  });

  it('converts ~~strike~~ to ~strike~', () => {
    expect(markdownToMrkdwn('~~gone~~')).toBe('~gone~');
  });

  it('preserves inline code unchanged', () => {
    expect(markdownToMrkdwn('use `**asterisks**` for emphasis')).toBe(
      'use `**asterisks**` for emphasis',
    );
  });

  it('preserves fenced code blocks unchanged', () => {
    const md = '```\nconst x = **important**;\n```';
    expect(markdownToMrkdwn(md)).toBe(md);
  });

  it('handles multi-line bold + header + links together', () => {
    const md = '### Bot Features\n\n- **Memory** lets the bot remember things\n- See [docs](https://example.com)';
    const out = markdownToMrkdwn(md);
    expect(out).toContain('*Bot Features*');
    expect(out).toContain('*Memory*');
    expect(out).toContain('<https://example.com|docs>');
    expect(out).not.toContain('**');
    expect(out).not.toContain('### ');
  });

  it('handles bare-image markdown by extracting the URL', () => {
    expect(markdownToMrkdwn('![alt text](https://example.com/img.png)')).toBe(
      'https://example.com/img.png',
    );
  });

  it('returns empty/undefined input unchanged', () => {
    expect(markdownToMrkdwn('')).toBe('');
  });
});
