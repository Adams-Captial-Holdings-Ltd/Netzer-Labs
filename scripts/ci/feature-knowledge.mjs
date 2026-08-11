#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';

const FIXED_FILES = [
  'docs/features/missions/README.md', 'docs/features/missions/HANDOFF.md',
  'handoff.md', 'AGENTS.md', 'docs/README.md', 'development.md',
  'docs/missions-v2-backlog.md', 'docs/missions-v2-audit.md',
];
const REQUIRED_META = ['feature', 'document_role', 'status', 'observed_at', 'as_of_commit'];
const ROLES = new Set(['index', 'handoff', 'decision', 'backlog', 'evidence', 'compatibility']);
const STATUSES = new Set(['current', 'accepted', 'historical', 'superseded', 'compatibility']);
const RELATIONSHIPS = new Set(['implemented_by', 'tested_by', 'decisions', 'approved_work', 'evidence']);
const WORK_STATES = new Set(['approved', 'in_progress', 'blocked']);
const OUTCOMES = new Set(['landed', 'rejected', 'superseded', 'claimed_unverified']);
const VERIFICATIONS = new Set(['not_run', 'code_verified', 'environment_verified']);

function parseFrontmatter(text) {
  const lines = text.replaceAll('\r\n', '\n').split('\n');
  if (lines[0] !== '---') return { fields: new Map(), lists: new Map(), keys: [], body: text, error: 'missing frontmatter' };
  const end = lines.indexOf('---', 1);
  if (end < 0) return { fields: new Map(), lists: new Map(), keys: [], body: '', error: 'unterminated frontmatter' };
  const fields = new Map(); const lists = new Map(); const keys = [];
  let listKey;
  for (const line of lines.slice(1, end)) {
    const scalar = line.match(/^([a-z_]+):(?:\s*(.*))?$/);
    if (scalar) {
      listKey = undefined; keys.push(scalar[1]);
      if (scalar[2]) fields.set(scalar[1], scalar[2].trim());
      else { listKey = scalar[1]; lists.set(listKey, []); }
      continue;
    }
    const item = line.match(/^\s{2}-\s+(.+)$/);
    if (item && listKey) lists.get(listKey).push(item[1].trim());
  }
  return { fields, lists, keys, body: lines.slice(end + 1).join('\n'), error: undefined };
}

function taskRecords(markdown) {
  const matches = [...markdown.matchAll(/^#{2,3}\s+(MISSION-\d+)\b.*$/gm)];
  return matches.map((match, index) => {
    const text = markdown.slice(match.index, matches[index + 1]?.index ?? markdown.length);
    const yaml = text.match(/```yaml\s*\n([\s\S]*?)```/)?.[1] ?? '';
    const fields = new Map([...yaml.matchAll(/^([a-z_]+):\s*(.+)$/gm)].map((m) => [m[1], m[2].trim()]));
    return { id: match[1], fields };
  });
}

/** Pure validation over an in-memory repository snapshot. */
export function validateFeatureKnowledge({ files, trackedFiles, existingFiles = trackedFiles }) {
  const failures = [];
  const canonical = [
    ['docs/features/missions/README.md', 'index', 'current'],
    ['docs/features/missions/HANDOFF.md', 'handoff', 'current'],
  ];
  for (const [path, expectedRole, expectedStatus] of canonical) {
    if (!(path in files)) { failures.push(`missing canonical Missions ${path.endsWith('README.md') ? 'README' : 'HANDOFF'}: ${path}`); continue; }
    const parsed = parseFrontmatter(files[path]);
    if (parsed.error) failures.push(`${path}: ${parsed.error}`);
    for (const key of REQUIRED_META) if (!parsed.fields.has(key)) failures.push(`${path}: missing ${key}`);
    const role = parsed.fields.get('document_role'); const status = parsed.fields.get('status');
    if (!ROLES.has(role) || role !== expectedRole) failures.push(`${path}: invalid document_role ${role ?? '(missing)'}`);
    if (!STATUSES.has(status) || status !== expectedStatus) failures.push(`${path}: invalid status ${status ?? '(missing)'}`);
    if (parsed.fields.get('feature') !== 'missions') failures.push(`${path}: feature must be missions`);
    for (const key of RELATIONSHIPS) {
      if (parsed.fields.has(key)) failures.push(`${path}: relationship ${key} must be a YAML list`);
      if (!parsed.lists.has(key)) continue;
      const paths = parsed.lists.get(key);
      if (paths.length === 0) failures.push(`${path}: relationship ${key} must be a non-empty YAML list`);
      for (const target of paths) {
        if (target.startsWith('/') || target.includes('..')) failures.push(`${path}: relationship ${target} is not repository-relative`);
        else if (!existingFiles.has(target)) failures.push(`${path}: relationship ${target} does not resolve`);
        else if (!trackedFiles.has(target)) failures.push(`${path}: relationship ${target} is not Git-tracked`);
      }
    }
  }

  const root = files['handoff.md'];
  if (!root) failures.push('missing root handoff.md compatibility pointer');
  else {
    const parsed = parseFrontmatter(root);
    for (const key of REQUIRED_META) if (!parsed.fields.has(key)) failures.push(`root handoff.md: missing ${key}`);
    if (parsed.fields.get('feature') !== 'missions') failures.push('root handoff.md: feature must be missions');
    if (parsed.fields.get('document_role') !== 'compatibility' || parsed.fields.get('status') !== 'compatibility') failures.push('root handoff.md must use compatibility metadata');
    if (parsed.keys.length !== REQUIRED_META.length || parsed.keys.some((key) => !REQUIRED_META.includes(key))) failures.push('root handoff.md must contain only compatibility metadata');
    const bodyLines = parsed.body.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (bodyLines.length !== 1 || bodyLines[0].length > 180) failures.push('root handoff.md must contain only one short pointer sentence');
    const links = [...parsed.body.matchAll(/(?<!!)\[[^\]]*\]\(\s*(?:<([^>]+)>|([^\s)]+))/g)].map((match) => match[1] ?? match[2]);
    if (links.length !== 1 || links[0] !== 'docs/features/missions/HANDOFF.md') failures.push('root handoff.md must contain exactly one Markdown link targeting docs/features/missions/HANDOFF.md');
  }

  if (!/\]\(docs\/features\/missions\/README\.md\)/.test(files['AGENTS.md'] ?? '')) failures.push('AGENTS.md must link the Missions README');
  if (!/\]\((?:\.\/)?features\/missions\/README\.md\)/.test(files['docs/README.md'] ?? '')) failures.push('docs/README.md must link the Missions README');
  const development = files['development.md'] ?? '';
  if (!development.includes('docs/features/<slug>/HANDOFF.md')) failures.push('development.md must name docs/features/<slug>/HANDOFF.md');
  if (/(?:update|write|keep|maintain)[^\n]{0,80}(?:root|global)\s+(?:`?handoff\.md`?|operational handoff)/i.test(development)) failures.push('development.md must not instruct authors to use a global operational handoff');

  const backlog = files['docs/missions-v2-backlog.md'] ?? '';
  const records = taskRecords(backlog);
  const retired = new Set();
  for (const { id, fields } of records) {
    const work = fields.get('work_state'); const outcome = fields.get('outcome');
    if (work) {
      if (!WORK_STATES.has(work)) failures.push(`${id}: invalid work_state ${work}`);
      if (outcome) failures.push(`${id}: active work must not also declare outcome`);
    } else {
      for (const key of ['outcome', 'reachable_commit', 'present_in_current_source', 'deployment', 'verification']) if (!fields.has(key)) failures.push(`${id}: missing ${key}`);
      if (!OUTCOMES.has(outcome)) failures.push(`${id}: invalid outcome ${outcome ?? '(missing)'}`);
      if (!/^(?:true|false)$/.test(fields.get('present_in_current_source') ?? '')) failures.push(`${id}: invalid present_in_current_source`);
      if (!VERIFICATIONS.has(fields.get('verification'))) failures.push(`${id}: invalid verification`);
      if (outcome === 'rejected' || outcome === 'superseded') retired.add(id);
    }
  }
  for (const line of backlog.split(/\r?\n/).filter((line) => /^\*\*Dependencies\.\*\*/.test(line))) {
    for (const id of line.match(/MISSION-\d+/g) ?? []) if (retired.has(id)) failures.push(`${id}: retired/rejected ID appears in dependency sequencing`);
  }

  const audit = files['docs/missions-v2-audit.md'] ?? '';
  const auditFailures = [];
  if (!/historical/i.test(audit)) auditFailures.push('historical');
  if (!/\]\((?:\.\/)?features\/missions\/README\.md\)/.test(audit)) auditFailures.push('Missions README');
  if (!/\]\(adr\/0009-mission-container-model\.md\)/.test(audit)) auditFailures.push('ADR');
  if (auditFailures.length) failures.push(`audit must be labeled historical and link the current Missions README and ADR; missing: ${auditFailures.join(', ')}`);
  return failures;
}

export function snapshotRepository(rootDir) {
  const trackedFiles = new Set(execFileSync('git', ['ls-files', '-z'], { cwd: rootDir, encoding: 'utf8' }).split('\0').filter(Boolean).map((path) => path.replaceAll('\\', '/')));
  const existingFiles = new Set([...trackedFiles].filter((path) => existsSync(resolve(rootDir, path))));
  const files = Object.fromEntries(FIXED_FILES.filter((path) => existsSync(resolve(rootDir, path))).map((path) => [path, readFileSync(resolve(rootDir, path), 'utf8')]));
  return { files, trackedFiles, existingFiles };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const rootDir = resolve(process.argv[2] ?? process.cwd());
  const failures = validateFeatureKnowledge(snapshotRepository(rootDir));
  if (failures.length) {
    for (const failure of failures) console.error(`  FAIL ${failure}`);
    console.error(`feature-knowledge: ${failures.length} contract failure(s)`);
    process.exit(1);
  }
  console.log('feature-knowledge: OK');
}
