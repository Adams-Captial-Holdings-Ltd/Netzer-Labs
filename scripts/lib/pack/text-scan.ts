import { readdirSync, readFileSync, lstatSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { parseAllDocuments, isAlias, isMap, isSeq, type Node } from 'yaml';
import { scanText } from '../../ci/secret-scan.mjs';
import type { PackFinding } from './validate.js';

const FORMAT = /\p{Cf}/gu;
const ACCOUNT = /(?:^|\D)(?:\d{12}|\d{4}[- ]\d{4}[- ]\d{4})(?!\d)/;
const EMAIL = /(?:^|[^\p{L}\p{N}._%+-])[\p{L}\p{N}._%+-]+@([^\s/?:#\\'"<>),;]+)/gu;
const URL = /(?:^|[^a-z0-9+.-])(?:[a-z][a-z0-9+.-]*:\/\/|\/\/|www\.)([^\s/?:#\\'"<>),;]+)/gi;
const RESERVED = new Set(['example.com', 'example.org', 'example.net', 'localhost']);
const RESERVED_SUFFIX = /\.(?:example\.com|example\.org|example\.net|example|test|invalid)$/;

function reservedHost(value: string): boolean {
  const host = value.replace(/[.,]+$/, '').toLowerCase();
  return RESERVED.has(host) || RESERVED_SUFFIX.test(host);
}

export function hasIdentifier(value: string, denylist: string[]): boolean {
  const text = value.normalize('NFKC').replace(FORMAT, '');
  if (ACCOUNT.test(text)) return true;
  const lower = text.toLowerCase();
  if (denylist.some((entry) => {
    const normalized = entry.normalize('NFKC').replace(FORMAT, '').toLowerCase();
    return normalized && lower.includes(normalized);
  })) return true;
  for (const match of text.matchAll(EMAIL)) if (!reservedHost(match[1] ?? '')) return true;
  for (const match of text.matchAll(URL)) {
    const host = match[1] ?? '';
    const prefix = match[0].slice(0, match[0].length - host.length);
    if (prefix.endsWith('//') && !prefix.includes(':') && (!host.includes('.') || !/\p{L}/u.test(host))) continue;
    if (!reservedHost(host)) return true;
  }
  return false;
}

export function redactPath(file: string, denylist: string[]): string {
  return file.split('/').map((segment) => hasIdentifier(segment, denylist) ? '<redacted>' : segment).join('/');
}

export function scanTextValues(file: string, values: string[], denylist: string[]): string[] {
  const found: string[] = [];
  if (values.some((value) => scanText(value, file).length > 0)) found.push('PV-SECRET');
  if (values.some((value) => hasIdentifier(value, denylist))) found.push('PV-IDENTIFIER');
  return found;
}

const MAX_FILE_BYTES = 1024 * 1024;
const decoder = new TextDecoder('utf-8', { fatal: true });
type Add = (code: string, file: string, message: string, pointer?: string) => void;

function readTextFile(path: string): string | undefined {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return undefined;
    const bytes = readFileSync(path);
    if (bytes.length > MAX_FILE_BYTES || bytes.includes(0)) return undefined;
    return decoder.decode(bytes);
  } catch { return undefined; }
}

export function stringsIn(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, item]) => [key, ...stringsIn(item)]);
  }
  return [];
}

function hasProto(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(hasProto);
  return Object.entries(value).some(([key, item]) => key === '__proto__' || hasProto(item));
}

function yamlUnsafe(node: Node | null | undefined): boolean {
  if (!node) return false;
  if (isAlias(node) || node.anchor || node.tag) return true;
  if (isMap(node)) return node.items.some((item) => yamlUnsafe(item.key as Node) || yamlUnsafe(item.value as Node));
  if (isSeq(node)) return node.items.some((item) => yamlUnsafe(item as Node));
  return false;
}

function parseContent(file: string, text: string, strict: boolean): unknown {
  if (file.endsWith('.json')) {
    const value: unknown = JSON.parse(text);
    if (strict && hasProto(value)) throw new Error('Forbidden JSON key');
    return value;
  }
  if (file.endsWith('.yaml') || file.endsWith('.yml')) {
    const docs = parseAllDocuments(text, { uniqueKeys: strict });
    if (docs.some((doc) => doc.errors.length) || (strict
      && (/^\s*%TAG\b/m.test(text) || docs.length !== 1 || yamlUnsafe(docs[0]?.contents)))) {
      throw new Error('Invalid YAML');
    }
    return strict ? docs[0]?.toJS() : docs.map((doc) => doc.toJS());
  }
  return undefined;
}

function listedPaths(dir: string): Set<string> {
  const listed = new Set(['pack.json']);
  const text = readTextFile(join(dir, 'pack.json'));
  if (text === undefined) return listed;
  try {
    const pack = JSON.parse(text) as Record<string, unknown>;
    const add = (value: unknown) => { if (typeof value === 'string') listed.add(value); };
    const addArray = (value: unknown) => { if (Array.isArray(value)) value.forEach(add); };
    const resources = pack.resources as Record<string, unknown> | undefined;
    if (resources && typeof resources === 'object') {
      for (const key of ['connectors', 'policies', 'ui', 'studioLayout']) add(resources[key]);
      for (const key of ['pipelines', 'skills']) addArray(resources[key]);
      if (Array.isArray(resources.routines)) for (const item of resources.routines) {
        add((item as Record<string, unknown> | null)?.path);
      }
    }
    if (Array.isArray(pack.agents)) for (const item of pack.agents) {
      add((item as Record<string, unknown> | null)?.definition);
    }
    add((pack.requires as Record<string, unknown> | undefined)?.config);
    add(pack.checksums);
  } catch { /* pack.json gets its own strict syntax finding during the walk. */ }
  return listed;
}

export function inspectDirectory(dir: string, add: Add, denylist: string[]) {
  const listed = listedPaths(dir);
  const parsed = new Map<string, unknown>();
  const scans: PackFinding[] = [];
  const invalid = new Set<string>();
  const walk = (path: string) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      const file = relative(dir, full).split(sep).join('/');
      if (hasIdentifier(file, denylist)) {
        scans.push({ code: 'PV-IDENTIFIER', file, message: 'Customer identifier found' });
      }
      if (entry.isDirectory()) { walk(full); continue; }
      const text = readTextFile(full);
      if (text === undefined) {
        invalid.add(file);
        add('PV-SCHEMA', file, 'File must be regular UTF-8 text of at most 1 MiB');
        continue;
      }
      let value: unknown;
      try { value = parseContent(file, text, listed.has(file)); }
      catch {
        if (listed.has(file)) {
          invalid.add(file);
          add('PV-SCHEMA', file, 'Invalid file syntax or forbidden key');
          continue;
        }
      }
      if (value !== undefined) parsed.set(file, value);
      const values = [text, ...(value === undefined ? [] : stringsIn(value))];
      try {
        for (const code of scanTextValues(file, values, denylist)) {
          const message = code === 'PV-SECRET' ? 'Secret-like value found' : 'Customer identifier found';
          scans.push({ code, file, message });
        }
      } catch {
        invalid.add(file);
        add('PV-SCHEMA', file, 'Internal validator error');
      }
    }
  };
  walk(dir);
  return { parsed, scans, invalid };
}
