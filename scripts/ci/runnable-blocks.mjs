#!/usr/bin/env node
/**
 * Runnable-block annotation extractor + validator (IaC readiness item 38).
 * Dependency-free; schema validation ONLY. EXECUTION of runnable blocks is
 * the RELEASE-TIME canary's job (items 30/38) in its defined environment
 * contract — per-PR CI must stay hermetic, so this script never runs a
 * single command from the docs.
 *
 *   node scripts/ci/runnable-blocks.mjs [rootDir]
 *
 * Contract (documented in docs/runnable-blocks.md): a fenced code block is
 * "runnable" when the line(s) immediately above it carry an HTML comment:
 *
 *   <!-- runnable: {"id":"quickstart-setup","mode":"execute","timeout":120} -->
 *   ```bash
 *   npm run setup -- --answers answers.json
 *   ```
 *
 * Validated here: JSON parses; required keys present; `id` unique across all
 * docs; `mode` ∈ execute|validate-prereq|manual-external|destructive; types
 * of cwd/env/requires/timeout/asserts; the annotation is attached to a fenced
 * block; execute/destructive blocks must not contain interactive wizards
 * (a bare `npm run setup` without --answers is the canonical offender).
 *
 * Exit codes: 0 valid, 1 violations, 2 usage error.
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';

export const MODES = ['execute', 'validate-prereq', 'manual-external', 'destructive'];
const KNOWN_KEYS = new Set(['id', 'mode', 'cwd', 'env', 'requires', 'timeout', 'asserts']);
const KNOWN_ASSERTS = new Set(['exit0']);

/** Commands that read stdin interactively when run as written. */
const INTERACTIVE_RE = /\bnpm run setup\b(?![^\n]*--answers)/;

/**
 * Extract annotations and their attached fenced blocks from one markdown
 * string. Returns { blocks: [{ meta, code, line }], errors: [string] }.
 */
export function extractBlocks(markdown) {
  const lines = markdown.split(/\r?\n/);
  const blocks = [];
  const errors = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    // An annotation INSIDE a fenced block is documentation about the
    // contract (this very page has one), not a real runnable block.
    if (/^\s*`{3,}/.test(lines[i])) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = lines[i].match(/^\s*<!--\s*runnable:\s*(\{.*\})\s*-->\s*$/);
    if (!m) continue;
    let meta;
    try {
      meta = JSON.parse(m[1]);
    } catch (err) {
      errors.push(`line ${i + 1}: runnable annotation is not valid JSON (${err.message})`);
      continue;
    }
    // The fence must follow, allowing blank lines between.
    let j = i + 1;
    while (j < lines.length && lines[j].trim() === '') j++;
    const fence = j < lines.length && lines[j].match(/^\s*(`{3,})(\S*)/);
    if (!fence) {
      errors.push(`line ${i + 1}: runnable annotation is not followed by a fenced code block`);
      continue;
    }
    const code = [];
    let k = j + 1;
    while (k < lines.length && !lines[k].match(/^\s*`{3,}\s*$/)) {
      code.push(lines[k]);
      k++;
    }
    blocks.push({ meta, code: code.join('\n'), line: i + 1, lang: fence[2] || '' });
  }
  return { blocks, errors };
}

/** Validate one annotation's schema. Returns error strings (empty = valid). */
export function validateMeta(meta, code = '') {
  const errors = [];
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) {
    return ['annotation must be a JSON object'];
  }
  for (const key of Object.keys(meta)) {
    if (!KNOWN_KEYS.has(key)) errors.push(`unknown key "${key}"`);
  }
  if (typeof meta.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(meta.id)) {
    errors.push('id must be a lowercase-kebab string');
  }
  if (!MODES.includes(meta.mode)) {
    errors.push(`mode must be one of ${MODES.join('|')}`);
  }
  if (meta.cwd !== undefined && typeof meta.cwd !== 'string') errors.push('cwd must be a string');
  for (const listKey of ['env', 'requires']) {
    const v = meta[listKey];
    if (v !== undefined && (!Array.isArray(v) || v.some((x) => typeof x !== 'string'))) {
      errors.push(`${listKey} must be an array of strings`);
    }
  }
  if (meta.timeout !== undefined && (typeof meta.timeout !== 'number' || meta.timeout <= 0)) {
    errors.push('timeout must be a positive number of seconds');
  }
  if (meta.asserts !== undefined) {
    if (!Array.isArray(meta.asserts) || meta.asserts.some((a) => typeof a !== 'string')) {
      errors.push('asserts must be an array of strings');
    } else {
      for (const a of meta.asserts) {
        if (!KNOWN_ASSERTS.has(a)) errors.push(`unknown assert "${a}"`);
      }
    }
  }
  if ((meta.mode === 'execute' || meta.mode === 'destructive') && INTERACTIVE_RE.test(code)) {
    errors.push(
      'execute/destructive blocks must be noninteractive — `npm run setup` needs `-- --answers <file.json>`',
    );
  }
  return errors;
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

export function checkRepo(rootDir) {
  const files = [];
  const docsDir = join(rootDir, 'docs');
  if (existsSync(docsDir)) files.push(...listMarkdown(docsDir));
  const readme = join(rootDir, 'README.md');
  if (existsSync(readme)) files.push(readme);

  const failures = [];
  const seenIds = new Map();
  let total = 0;
  const byMode = Object.fromEntries(MODES.map((m) => [m, 0]));

  for (const file of files) {
    const rel = relative(rootDir, file);
    const { blocks, errors } = extractBlocks(readFileSync(file, 'utf-8'));
    for (const e of errors) failures.push(`${rel}: ${e}`);
    for (const block of blocks) {
      total++;
      const errs = validateMeta(block.meta, block.code);
      for (const e of errs) failures.push(`${rel}:${block.line} [${block.meta?.id ?? '?'}] ${e}`);
      if (typeof block.meta?.id === 'string') {
        const prev = seenIds.get(block.meta.id);
        if (prev) failures.push(`${rel}:${block.line} duplicate runnable id "${block.meta.id}" (also in ${prev})`);
        else seenIds.set(block.meta.id, `${rel}:${block.line}`);
      }
      if (MODES.includes(block.meta?.mode)) byMode[block.meta.mode]++;
    }
  }
  return { files: files.length, total, byMode, failures };
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const rootDir = resolve(process.argv[2] ?? process.cwd());
  if (!existsSync(rootDir)) {
    console.error(`runnable-blocks: no such directory ${rootDir}`);
    process.exit(2);
  }
  const { files, total, byMode, failures } = checkRepo(rootDir);
  console.log(
    `runnable-blocks: ${total} annotated block(s) across ${files} markdown files ` +
      `(${Object.entries(byMode).map(([m, n]) => `${m}=${n}`).join(' ')})`,
  );
  console.log('runnable-blocks: schema validation only — execution happens in the release-time canary');
  if (failures.length > 0) {
    for (const f of failures) console.error(`  FAIL ${f}`);
    process.exit(1);
  }
  console.log('runnable-blocks: OK');
}
