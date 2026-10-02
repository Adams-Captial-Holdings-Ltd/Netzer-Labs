import { readdirSync, readFileSync, lstatSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { parseAllDocuments, isAlias, isMap, isSeq, type Node } from 'yaml';
import { scanText } from '../../ci/secret-scan.mjs';
import type { PackFinding } from './validate.js';

const ZERO_WIDTH = /[\u200b-\u200d\ufeff\u00ad]/g;
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
  const text = value.replace(ZERO_WIDTH, '');
  if (ACCOUNT.test(text)) return true;
  const lower = text.toLowerCase();
  if (denylist.some((entry) => entry && lower.includes(entry.replace(ZERO_WIDTH, '').toLowerCase()))) return true;
  for (const match of text.matchAll(EMAIL)) if (!reservedHost(match[1] ?? '')) return true;
  for (const match of text.matchAll(URL)) {
    const host = match[1] ?? '';
    const prefix = match[0].slice(0, match[0].length - host.length);
    if (prefix.endsWith('//') && !prefix.includes(':') && (!host.includes('.') || !/\p{L}/u.test(host))) continue;
    if (!reservedHost(host)) return true;
  }
  return false;
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

function parseContent(file: string, text: string): unknown {
  if (file.endsWith('.json')) {
    const value: unknown = JSON.parse(text);
    if (hasProto(value)) throw new Error('Forbidden JSON key');
    return value;
  }
  if (file.endsWith('.yaml') || file.endsWith('.yml')) {
    const docs = parseAllDocuments(text, { uniqueKeys: true });
    if (/^\s*%TAG\b/m.test(text) || docs.length !== 1 || docs[0]?.errors.length || yamlUnsafe(docs[0]?.contents)) {
      throw new Error('Invalid YAML');
    }
    return docs[0]?.toJS();
  }
  return undefined;
}

export function inspectDirectory(dir: string, add: Add, denylist: string[]) {
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
      try {
        const stat = lstatSync(full);
        if (stat.isDirectory()) { walk(full); continue; }
        if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error('Invalid pack file');
        const bytes = readFileSync(full);
        if (bytes.length > MAX_FILE_BYTES || bytes.includes(0)) throw new Error('Invalid text file');
        const text = decoder.decode(bytes);
        let value: unknown;
        try { value = parseContent(file, text); }
        catch { invalid.add(file); add('PV-SCHEMA', file, 'Invalid file syntax or forbidden key'); continue; }
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
      } catch {
        invalid.add(file);
        add('PV-SCHEMA', file, 'File must be regular UTF-8 text of at most 1 MiB');
      }
    }
  };
  walk(dir);
  return { parsed, scans, invalid };
}
