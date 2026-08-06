#!/usr/bin/env node
/**
 * Secret-pattern scan over synth artifacts and fixtures (IaC readiness plan,
 * items 14 / 29). Dependency-free on purpose so CI can run it with bare Node,
 * no `npm ci`.
 *
 *   node scripts/ci/secret-scan.mjs [--denylist <file>]... <path>...
 *
 * Paths may be files or directories (recursed). Binary files (NUL byte in the
 * first 8 KB), `.git/` and `node_modules/` are skipped. Exits 1 with
 * `file:line` hits on any finding, 0 when clean, 2 on usage errors.
 *
 * Patterns:
 *   - AWS access key ids (AKIA/ASIA + 16 chars)
 *   - 40-char base64-ish values assigned to *_SECRET / *_KEY / *TOKEN names
 *     (the shape of an AWS secret access key landing in a template)
 *   - ECS task-def env entries: a secret-named env var carrying a literal
 *     value in plain `environment` (vendor keys must ride Secrets Manager,
 *     plan item 5)
 *   - Slack tokens (xox[abopr]-...)
 *   - Telegram bot tokens (digits:35-char body)
 *   - PEM private-key headers
 *   - a configurable literal denylist (scripts/ci/denylist.txt holds
 *     placeholders only; the PRIVATE checkout supplies the real
 *     personal-value list at publish time, never committed)
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';

/** Values that look like config placeholders, not leaked secrets. */
const PLACEHOLDER = /REPLACE_ME|PLACEHOLDER|EXAMPLE|CHANGE_?ME|\$\{|\{\{/i;

/** Resource references (KMS aliases, ARNs), legitimately non-secret values. */
const RESOURCE_REF = /^(?:alias\/|arn:)/;

export const PATTERNS = [
  {
    id: 'aws-access-key-id',
    re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  },
  {
    id: 'secret-assignment',
    // UPPER_SNAKE name ending in SECRET/_KEY/TOKEN, assigned a 40-char
    // base64-ish literal (exactly 40: the AWS secret-access-key shape; the
    // trailing lookahead keeps 64-char asset hashes from matching).
    re: /\b[A-Z][A-Z0-9_]*(?:SECRET|_KEY|TOKEN)\b["']?\s*[:=]\s*["']?([A-Za-z0-9+/=]{40})(?![A-Za-z0-9+/=])/g,
  },
  {
    id: 'ecs-env-secret-value',
    // CloudFormation task-def shape: {"Name":"X_TOKEN","Value":"<literal>"}.
    // Secret-named env vars must be wired via Secrets Manager, never plain
    // environment (plan item 5). Case-insensitive keys: CFN uses Name/Value.
    // The name is SUFFIX-anchored (must END in SECRET/TOKEN/API_KEY/_KEY):
    // infix matches flag benign vars like TABLE_TOKEN_USAGE or
    // CCE_KMS_DATA_KEY_ALIAS, whose values are resource names, not secrets.
    re: /"name"\s*:\s*"[A-Z0-9_]*(?:SECRET|TOKEN|API_KEY|_KEY)"\s*,\s*"value"\s*:\s*"([^"]{16,})"/gi,
    allowPlaceholders: true,
  },
  {
    id: 'slack-token',
    re: /\bxox[abopr]-[A-Za-z0-9-]{10,}/g,
  },
  {
    id: 'telegram-bot-token',
    re: /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g,
  },
  {
    id: 'pem-private-key',
    re: /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/g,
  },
];

/** Parse a denylist file: one literal per line, `#` comments, blanks ignored. */
export function parseDenylist(text) {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));
}

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/** Never echo a full candidate secret into CI logs. */
function redact(match) {
  const flat = match.replace(/\s+/g, ' ');
  return flat.length <= 12 ? flat : `${flat.slice(0, 8)}…(${flat.length} chars)`;
}

/**
 * Scan one text blob. Returns hits: { file, line, id, excerpt }.
 * `denylist` entries match as case-insensitive literal substrings.
 */
export function scanText(text, file, denylist = []) {
  const hits = [];
  for (const p of PATTERNS) {
    p.re.lastIndex = 0;
    let m;
    while ((m = p.re.exec(text)) !== null) {
      const candidate = m[1] ?? m[0];
      if (p.allowPlaceholders && (PLACEHOLDER.test(candidate) || RESOURCE_REF.test(candidate))) {
        continue;
      }
      hits.push({ file, line: lineOf(text, m.index), id: p.id, excerpt: redact(m[0]) });
    }
  }
  const lower = text.toLowerCase();
  for (const literal of denylist) {
    const needle = literal.toLowerCase();
    let from = 0;
    let idx;
    while ((idx = lower.indexOf(needle, from)) !== -1) {
      hits.push({ file, line: lineOf(text, idx), id: 'denylist-literal', excerpt: redact(literal) });
      from = idx + needle.length;
    }
  }
  return hits;
}

const SKIP_DIRS = new Set(['.git', 'node_modules']);

function* walk(path) {
  const st = statSync(path);
  if (st.isFile()) {
    yield path;
    return;
  }
  if (!st.isDirectory()) return;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walk(join(path, entry.name));
    } else if (entry.isFile()) {
      yield join(path, entry.name);
    }
  }
}

function isBinary(buf) {
  const probe = buf.subarray(0, 8192);
  return probe.includes(0);
}

export function scanPaths(paths, denylist = []) {
  const hits = [];
  for (const root of paths) {
    for (const file of walk(root)) {
      const buf = readFileSync(file);
      if (isBinary(buf)) continue;
      const rel = relative(process.cwd(), file) || file;
      hits.push(...scanText(buf.toString('utf8'), rel, denylist));
    }
  }
  return hits;
}

// ── CLI ───────────────────────────────────────────────────────────────

function main(argv) {
  const paths = [];
  const denylist = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--denylist') {
      const file = argv[++i];
      if (!file) {
        console.error('secret-scan: --denylist requires a file path');
        return 2;
      }
      denylist.push(...parseDenylist(readFileSync(file, 'utf8')));
    } else if (argv[i].startsWith('--')) {
      console.error(`secret-scan: unknown flag ${argv[i]}`);
      return 2;
    } else {
      paths.push(argv[i]);
    }
  }
  if (paths.length === 0) {
    console.error('usage: node scripts/ci/secret-scan.mjs [--denylist <file>]... <path>...');
    return 2;
  }

  let hits;
  try {
    hits = scanPaths(paths, denylist);
  } catch (err) {
    console.error(`secret-scan: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }

  if (hits.length > 0) {
    for (const h of hits) {
      console.error(`${h.file}:${h.line}: [${h.id}] ${h.excerpt}`);
    }
    console.error(`secret-scan: ${hits.length} hit(s), see file:line above`);
    return 1;
  }
  console.log(
    `secret-scan: clean (${paths.length} path(s), ${denylist.length} denylist literal(s))`,
  );
  return 0;
}

// Only run the CLI when invoked directly, so vitest can import the exports.
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  process.exit(main(process.argv.slice(2)));
}
