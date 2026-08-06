import { describe, it, expect } from 'vitest';
import { toTelegramHtml } from './format.js';

describe('toTelegramHtml', () => {
  it('renders a Markdown pipe table as compact mobile cards', () => {
    const md = [
      '| Opportunity | Amount | Stage | Close Date |',
      '|---|---|---|---|',
      '| Meridian - Renewal | $500,000 | Proposal/Price Quote | Oct 24, 2026 |',
      '| Apex - Platform License | $75,000 | Closed Won | Oct 22, 2026 |',
    ].join('\n');
    const out = toTelegramHtml(md);
    expect(out).toContain('<b>Meridian - Renewal</b>\n$500,000 · Proposal/Price Quote · Oct 24, 2026');
    expect(out).toContain('<b>Apex - Platform License</b>\n$75,000 · Closed Won · Oct 22, 2026');
    // no raw table pipes survive
    expect(out).not.toMatch(/\|---/);
    expect(out).not.toContain('| Opportunity |');
  });

  it('converts bold, inline code, and links', () => {
    expect(toTelegramHtml('**hi** there')).toBe('<b>hi</b> there');
    expect(toTelegramHtml('use `npm test` now')).toBe('use <code>npm test</code> now');
    expect(toTelegramHtml('[docs](https://x.com/a)')).toBe('<a href="https://x.com/a">docs</a>');
  });

  it('escapes HTML special characters in content', () => {
    expect(toTelegramHtml('a < b & c > d')).toBe('a &lt; b &amp; c &gt; d');
  });

  it('does not italicize identifiers with underscores or stray asterisks', () => {
    expect(toTelegramHtml('field Close_Date and salesforce___soql_query')).toBe(
      'field Close_Date and salesforce___soql_query',
    );
    expect(toTelegramHtml('2 * 3 * 4')).toBe('2 * 3 * 4');
  });

  it('turns headings and bullets into bold lines and dots', () => {
    expect(toTelegramHtml('# Pipeline')).toBe('<b>Pipeline</b>');
    expect(toTelegramHtml('- one\n- two')).toBe('• one\n• two');
  });

  it('drops horizontal rules', () => {
    expect(toTelegramHtml('a\n---\nb')).toBe('a\nb');
  });

  it('leaves a half-typed bold marker literal (streaming safety)', () => {
    expect(toTelegramHtml('loading **Mer')).toBe('loading **Mer');
  });

  it('renders fenced code blocks as <pre>', () => {
    expect(toTelegramHtml('```\nSELECT 1\n```')).toBe('<pre>SELECT 1</pre>');
  });

  it('passes plain text through unchanged', () => {
    expect(toTelegramHtml('just a normal reply')).toBe('just a normal reply');
  });
});
