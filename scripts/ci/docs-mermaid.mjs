#!/usr/bin/env node
/**
 * Mermaid render check (IaC readiness items 32 / 38a).
 *
 *   node scripts/ci/docs-mermaid.mjs [rootDir]
 *   node scripts/ci/docs-mermaid.mjs --extract-only   # budget check, no render
 *
 * Extracts every ```mermaid block under docs/ (and README.md), then:
 *
 *  1. NODE BUDGET: fails any diagram with more than MAX_NODES nodes. The
 *     count is APPROXIMATE by design — it counts node-ish tokens (bracketed/
 *     braced/parenthesised shapes in flowcharts, `participant`/`actor` lines
 *     in sequence diagrams, state/class names) rather than parsing the full
 *     grammar. A diagram pushing 40 nodes is unreadable on GitHub regardless
 *     of exact count, which is the property the budget protects.
 *
 *  2. RENDER: pipes each block through the PINNED renderer
 *     `@mermaid-js/mermaid-cli@10.9.1` via npx into SVGs in a temp dir,
 *     failing on parse errors. The renderer version is printed so the job
 *     log RECORDS what validated the syntax — GitHub's own Mermaid version
 *     changes under us and exposes no contract (item 32), so each release
 *     also gets a manual smoke-check of rendering on github.com.
 *
 * npm-registry download only (npx). No AWS, no other network.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';

export const MERMAID_CLI_VERSION = '10.9.1';
export const MAX_NODES = 40;

/** Extract every ```mermaid fenced block. Returns [{ source, line }]. */
export function extractMermaidBlocks(markdown) {
  const lines = markdown.split(/\r?\n/);
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*`{3,}mermaid\s*$/.test(lines[i])) continue;
    const start = i + 1;
    let j = start;
    while (j < lines.length && !/^\s*`{3,}\s*$/.test(lines[j])) j++;
    blocks.push({ source: lines.slice(start, j).join('\n'), line: start });
    i = j;
  }
  return blocks;
}

/**
 * Approximate node count. Counts unique node ids in flowchart shape
 * declarations (`id[...]`, `id(...)`, `id{...}`, `id((...))`, `id[(...)]`),
 * sequence-diagram participants/actors, and state/class declarations.
 */
export function countNodes(source) {
  const ids = new Set();
  for (const rawLine of source.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('%%')) continue;
    // sequence diagrams
    const part = line.match(/^(?:participant|actor)\s+([\w-]+)/);
    if (part) {
      ids.add(`p:${part[1]}`);
      continue;
    }
    // state/class diagrams
    const decl = line.match(/^(?:state|class)\s+"?([\w-]+)"?/);
    if (decl) {
      ids.add(`d:${decl[1]}`);
      continue;
    }
    // flowchart shapes anywhere in the line (covers `A --> B[label]` chains)
    for (const m of line.matchAll(/(^|[\s>|&-])([A-Za-z][\w-]*)\s*(\[|\(|\{)/g)) {
      const id = m[2];
      // keywords that look like ids in front of brackets
      if (['subgraph', 'classDef', 'click', 'style', 'linkStyle', 'flowchart', 'graph'].includes(id)) continue;
      ids.add(`n:${id}`);
    }
  }
  return ids.size;
}

function listMarkdown(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...listMarkdown(p));
    else if (entry.endsWith('.md')) out.push(p);
  }
  return out;
}

export function collectDiagrams(rootDir) {
  const files = [];
  const docsDir = join(rootDir, 'docs');
  if (existsSync(docsDir)) files.push(...listMarkdown(docsDir));
  const readme = join(rootDir, 'README.md');
  if (existsSync(readme)) files.push(readme);

  const diagrams = [];
  for (const file of files) {
    const rel = relative(rootDir, file);
    for (const block of extractMermaidBlocks(readFileSync(file, 'utf-8'))) {
      diagrams.push({ file: rel, line: block.line, source: block.source });
    }
  }
  return diagrams;
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const extractOnly = process.argv.includes('--extract-only');
  const rootDir = resolve(args[0] ?? process.cwd());
  const diagrams = collectDiagrams(rootDir);
  console.log(`docs-mermaid: ${diagrams.length} mermaid block(s) · renderer @mermaid-js/mermaid-cli@${MERMAID_CLI_VERSION} (pinned)`);

  let failed = 0;
  for (const d of diagrams) {
    const nodes = countNodes(d.source);
    if (nodes > MAX_NODES) {
      console.error(`  FAIL ${d.file}:${d.line} ~${nodes} nodes exceeds the budget of ${MAX_NODES} (approximate count — split the diagram by concern)`);
      failed++;
    }
  }

  if (!extractOnly) {
    const tmp = mkdtempSync(join(tmpdir(), 'cce-mermaid-'));
    // CI runners (and most containers) have no usable Chromium SUID
    // sandbox; without --no-sandbox the headless browser refuses to
    // launch and every diagram "fails" for a non-mermaid reason. The
    // sandbox adds nothing here: the input is our own committed text.
    const puppeteerConfigPath = join(tmp, 'puppeteer.json');
    writeFileSync(puppeteerConfigPath, JSON.stringify({ args: ['--no-sandbox'] }));
    diagrams.forEach((d, i) => {
      const inPath = join(tmp, `d${i}.mmd`);
      const outPath = join(tmp, `d${i}.svg`);
      writeFileSync(inPath, d.source);
      try {
        execFileSync(
          'npx',
          [
            '-y',
            `@mermaid-js/mermaid-cli@${MERMAID_CLI_VERSION}`,
            '-i', inPath,
            '-o', outPath,
            '-p', puppeteerConfigPath,
            '-q',
          ],
          { stdio: ['ignore', 'pipe', 'pipe'] },
        );
        console.log(`  ok   ${d.file}:${d.line} (~${countNodes(d.source)} nodes)`);
      } catch (err) {
        const stderr = err.stderr ? err.stderr.toString().split('\n').slice(0, 6).join('\n    ') : err.message;
        console.error(`  FAIL ${d.file}:${d.line} renderer rejected the diagram:\n    ${stderr}`);
        failed++;
      }
    });
  }

  if (failed > 0) {
    console.error(`docs-mermaid: ${failed} failure(s)`);
    process.exit(1);
  }
  console.log('docs-mermaid: OK');
}
