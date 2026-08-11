#!/usr/bin/env node
/**
 * Internal link + anchor checker for docs (IaC readiness item 38a).
 * Dependency-free so CI can run it with bare Node, no `npm ci`.
 *
 *   node scripts/ci/docs-links.mjs [rootDir]
 *
 * Scope: docs/**\/*.md plus the root README.md. HERMETIC by design:
 *
 *   - RELATIVE links are resolved to files and FAIL when the target is
 *     missing (renames and deletions surface in the PR that made them).
 *   - INTERNAL #fragment links are checked against the target file's
 *     heading slugs (GitHub slugger approximation) and explicit
 *     `<a name="...">` / `id="..."` anchors.
 *   - EXTERNAL http(s)/mailto links are SKIPPED — counted, never fetched.
 *     External checking is a scheduled / release-time job with retries and
 *     an allowlist (plan item 38): external checks flake, and a flaky red X
 *     on unrelated PRs teaches people to ignore CI.
 *
 * Exit codes: 0 clean, 1 broken links found, 2 usage error.
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';

// ─────────────────────────────────────────────────────────────────────
// Markdown parsing helpers (exported for tests)
// ─────────────────────────────────────────────────────────────────────

/** Remove fenced code blocks (``` / ~~~) so code samples never register links or headings. */
export function stripCodeBlocks(markdown) {
  const lines = markdown.split(/\r?\n/);
  const out = [];
  let fence = null;
  for (const line of lines) {
    const open = line.match(/^\s*(`{3,}|~{3,})/);
    if (fence) {
      if (open && open[1][0] === fence[0] && open[1].length >= fence.length) fence = null;
      out.push('');
      continue;
    }
    if (open) {
      fence = open[1];
      out.push('');
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

/**
 * Extract link targets from markdown: inline links/images `[t](target)`,
 * reference-style links, and HTML `href="..."` / `src="..."`.
 * Returns [{ target, line }].
 */
export function extractLinks(markdown) {
  const stripped = stripCodeBlocks(markdown);
  const links = [];
  const lines = stripped.split('\n');
  const inlineRe = /!?\[[^\]]*\]\(\s*(<[^>]*>|[^)\s]+)(?:\s+"[^"]*")?\s*\)/g;
  const htmlRe = /(?:href|src)\s*=\s*"([^"]+)"/g;
  const definitionRe = /^\s{0,3}\[([^\]]+)\]:\s*(<[^>]+>|\S+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*$/;
  const normalizeLabel = (label) => label.trim().replace(/\s+/g, ' ').toLowerCase();
  const definitions = new Map();

  for (const line of lines) {
    const definition = line.match(definitionRe);
    if (!definition) continue;
    let target = definition[2];
    if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1);
    const label = normalizeLabel(definition[1]);
    if (!definitions.has(label)) definitions.set(label, target);
  }

  lines.forEach((line, i) => {
    // Spans inside inline code on the same line are still rare false-positive
    // sources; strip single-backtick spans per line.
    const noInlineCode = line.replace(/`[^`]*`/g, '');
    if (definitionRe.test(noInlineCode)) return;
    for (const m of noInlineCode.matchAll(inlineRe)) {
      let target = m[1];
      if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1);
      links.push({ target, line: i + 1 });
    }
    const referenceSpans = [];
    for (const m of noInlineCode.matchAll(/!?\[([^\]]*)\]\[([^\]]*)\]/g)) {
      const label = normalizeLabel(m[2] || m[1]);
      const target = definitions.get(label);
      if (target !== undefined) links.push({ target, line: i + 1 });
      referenceSpans.push([m.index, m.index + m[0].length]);
    }
    for (const m of noInlineCode.matchAll(/!?\[([^\]]+)\](?!\s*[\[(])/g)) {
      const start = m.index;
      if (referenceSpans.some(([from, to]) => start >= from && start < to)) continue;
      const target = definitions.get(normalizeLabel(m[1]));
      if (target !== undefined) links.push({ target, line: i + 1 });
    }
    for (const m of noInlineCode.matchAll(htmlRe)) {
      links.push({ target: m[1], line: i + 1 });
    }
  });
  return links;
}

/**
 * GitHub heading-slug approximation: lowercase, strip markdown formatting,
 * drop everything but word chars / spaces / hyphens, spaces → hyphens,
 * duplicate slugs get -1, -2... suffixes. (The README TOC uses a maintained
 * slugger library per item 31; this checker only needs the common subset our
 * docs actually use — ASCII headings with inline code and parens.)
 */
export function slugify(heading) {
  return heading
    .toLowerCase()
    .replace(/`([^`]*)`/g, '$1') // inline code → text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // links → text
    .replace(/[*_~]/g, '')
    .trim()
    .replace(/[^\p{L}\p{N}\- ]/gu, '')
    .replace(/ /g, '-');
}

/** All anchors a #fragment can point at in one markdown file. */
export function collectAnchors(markdown) {
  const stripped = stripCodeBlocks(markdown);
  const anchors = new Set();
  const counts = new Map();
  for (const line of stripped.split('\n')) {
    const h = line.match(/^\s{0,3}(#{1,6})\s+(.*)$/);
    if (h) {
      const base = slugify(h[2]);
      const n = counts.get(base) ?? 0;
      counts.set(base, n + 1);
      anchors.add(n === 0 ? base : `${base}-${n}`);
    }
  }
  // Explicit HTML anchors: the release-stable contract is <a name="...">
  // (item 31); id="..." is accepted too since GitHub honors it today.
  for (const m of markdown.matchAll(/<a\s+[^>]*name\s*=\s*"([^"]+)"/g)) anchors.add(m[1]);
  for (const m of markdown.matchAll(/\bid\s*=\s*"([^"]+)"/g)) anchors.add(m[1]);
  return anchors;
}

export function isExternal(target) {
  return /^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(target) || /^(?:mailto|tel|data|javascript):/i.test(target);
}

// ─────────────────────────────────────────────────────────────────────
// Repo walk + check
// ─────────────────────────────────────────────────────────────────────

function listMarkdown(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...listMarkdown(p));
    else if (entry.endsWith('.md')) out.push(p);
  }
  return out;
}

export function checkRepo(rootDir) {
  const files = [];
  const docsDir = join(rootDir, 'docs');
  if (existsSync(docsDir)) files.push(...listMarkdown(docsDir));
  for (const rootFile of ['README.md', 'AGENTS.md', 'development.md', 'handoff.md']) {
    const file = join(rootDir, rootFile);
    if (existsSync(file)) files.push(file);
  }

  const anchorCache = new Map();
  const anchorsOf = (file) => {
    let a = anchorCache.get(file);
    if (!a) {
      a = collectAnchors(readFileSync(file, 'utf-8'));
      anchorCache.set(file, a);
    }
    return a;
  };

  const failures = [];
  let externalCount = 0;
  let checkedCount = 0;

  for (const file of files) {
    const rel = relative(rootDir, file);
    const links = extractLinks(readFileSync(file, 'utf-8'));
    for (const { target, line } of links) {
      if (isExternal(target)) {
        externalCount++;
        continue;
      }
      checkedCount++;
      const [pathPart, fragment] = target.split('#', 2);
      let targetFile = file;
      if (pathPart) {
        let decoded;
        try {
          decoded = decodeURIComponent(pathPart);
        } catch {
          failures.push(`${rel}:${line} malformed percent encoding: ${target}`);
          continue;
        }
        const resolved = resolve(dirname(file), decoded);
        if (!resolved.startsWith(rootDir + sep) && resolved !== rootDir) {
          failures.push(`${rel}:${line} link escapes the repo: ${target}`);
          continue;
        }
        if (!existsSync(resolved)) {
          failures.push(`${rel}:${line} missing file: ${target}`);
          continue;
        }
        targetFile = resolved;
      }
      if (fragment !== undefined && fragment !== '') {
        if (!targetFile.endsWith('.md')) continue; // fragments into non-md files: not checkable
        if (statSync(targetFile).isDirectory()) continue;
        const anchors = anchorsOf(targetFile);
        const frag = fragment.toLowerCase();
        if (!anchors.has(fragment) && !anchors.has(frag) && !anchors.has(frag.replace(/^user-content-/, ''))) {
          failures.push(`${rel}:${line} broken anchor: ${target}`);
        }
      }
    }
  }

  return { files: files.length, checkedCount, externalCount, failures };
}

// ─────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const rootDir = resolve(process.argv[2] ?? process.cwd());
  if (!existsSync(rootDir)) {
    console.error(`docs-links: no such directory ${rootDir}`);
    process.exit(2);
  }
  const { files, checkedCount, externalCount, failures } = checkRepo(rootDir);
  console.log(
    `docs-links: ${files} markdown files · ${checkedCount} internal links checked · ` +
      `${externalCount} external links skipped (checked on a schedule/at release, never per-PR)`,
  );
  if (failures.length > 0) {
    for (const f of failures) console.error(`  FAIL ${f}`);
    console.error(`docs-links: ${failures.length} broken internal link(s)`);
    process.exit(1);
  }
  console.log('docs-links: OK');
}
