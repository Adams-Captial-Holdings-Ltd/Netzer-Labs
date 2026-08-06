/**
 * Tests for the hermetic docs link checker (IaC readiness item 38a).
 * Fixture-driven: link extraction, slugging, anchor collection, and a
 * temp-dir end-to-end run proving missing files / broken anchors FAIL while
 * external links are skipped (counted, never fetched).
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error — plain .mjs CI helper, no type declarations on purpose
import { extractLinks, slugify, collectAnchors, stripCodeBlocks, isExternal, checkRepo } from './docs-links.mjs';

describe('extractLinks', () => {
  it('finds inline links and images with line numbers', () => {
    const md = 'see [guide](docs/how-it-works.md)\n\n![diagram](assets/x.png)';
    const links = extractLinks(md) as Array<{ target: string; line: number }>;
    expect(links).toEqual([
      { target: 'docs/how-it-works.md', line: 1 },
      { target: 'assets/x.png', line: 3 },
    ]);
  });

  it('strips titles and angle-bracket targets', () => {
    const links = extractLinks('[a](<file with space.md> "Title") [b](x.md "t")') as Array<{
      target: string;
    }>;
    expect(links.map((l) => l.target)).toEqual(['file with space.md', 'x.md']);
  });

  it('finds HTML href/src links', () => {
    const links = extractLinks('<a href="docs/a.md">x</a> <img src="assets/b.png">') as Array<{
      target: string;
    }>;
    expect(links.map((l) => l.target)).toEqual(['docs/a.md', 'assets/b.png']);
  });

  it('ignores links inside fenced code blocks and inline code', () => {
    const md = '```bash\ncurl [x](http://nope)\n```\n`[y](inline.md)`\n[real](ok.md)';
    const links = extractLinks(md) as Array<{ target: string }>;
    expect(links.map((l) => l.target)).toEqual(['ok.md']);
  });

  it('mermaid fences with bracket-paren shapes are not links', () => {
    const md = '```mermaid\nflowchart LR\n  A["x"] --> B(round)\n```';
    expect(extractLinks(md)).toEqual([]);
  });
});

describe('slugify / collectAnchors', () => {
  it('matches the GitHub slug shape for our heading styles', () => {
    expect(slugify('Quick start')).toBe('quick-start');
    expect(slugify('`stacks-live` (A)')).toBe('stacks-live-a');
    expect(slugify('Deploy & verify — what runs')).toBe('deploy--verify--what-runs');
  });

  it('dedupes duplicate headings with -1 suffixes and keeps <a name> anchors', () => {
    const md = '# Same\n## Same\n<a name="explicit-anchor"></a>\n```\n# not a heading\n```';
    const anchors = collectAnchors(md) as Set<string>;
    expect(anchors.has('same')).toBe(true);
    expect(anchors.has('same-1')).toBe(true);
    expect(anchors.has('explicit-anchor')).toBe(true);
    expect(anchors.has('not-a-heading')).toBe(false);
  });

  it('stripCodeBlocks preserves line count', () => {
    const md = 'a\n```\nb\n```\nc';
    expect((stripCodeBlocks(md) as string).split('\n')).toHaveLength(5);
  });
});

describe('isExternal', () => {
  it('classifies external schemes and protocol-relative URLs', () => {
    expect(isExternal('https://github.com/x')).toBe(true);
    expect(isExternal('mailto:x@y.z')).toBe(true);
    expect(isExternal('//cdn.example.com/x')).toBe(true);
    expect(isExternal('docs/a.md')).toBe(false);
    expect(isExternal('#anchor')).toBe(false);
  });
});

describe('checkRepo (end to end on a fixture tree)', () => {
  function fixtureRepo(): string {
    const root = mkdtempSync(join(tmpdir(), 'docs-links-'));
    mkdirSync(join(root, 'docs'));
    writeFileSync(
      join(root, 'README.md'),
      '# Top\n[good](docs/a.md)\n[bad](docs/missing.md)\n[ext](https://example.com/never-fetched)\n',
    );
    writeFileSync(
      join(root, 'docs', 'a.md'),
      '# Title\n\n## Known Section\n\n[self](#known-section)\n[broken anchor](a.md#nope)\n[up](../README.md#top)\n',
    );
    return root;
  }

  it('fails missing files and broken anchors, skips external links', () => {
    const root = fixtureRepo();
    const result = checkRepo(root) as {
      failures: string[];
      externalCount: number;
      checkedCount: number;
    };
    expect(result.externalCount).toBe(1);
    expect(result.failures).toHaveLength(2);
    expect(result.failures.join('\n')).toMatch(/missing file: docs\/missing\.md/);
    expect(result.failures.join('\n')).toMatch(/broken anchor: a\.md#nope/);
  });
});
