#!/usr/bin/env node
/**
 * Feature-knowledge contract checker.
 *
 *   node scripts/ci/feature-knowledge.mjs [rootDir]
 *
 * Enforces the specification in docs/features/README.md against EVERY
 * docs/features/<slug>/ folder, not one hard-coded feature. Dependency-free so
 * CI can run it with bare Node, no `npm ci`.
 *
 * What it checks:
 *   - the framework spec exists and at least one feature folder conforms to it;
 *   - every feature folder has README.md (index) + HANDOFF.md (handoff), both
 *     `current`, both carrying the five required frontmatter keys, and both
 *     declaring `feature:` equal to their own directory name;
 *   - every session log under docs/features/<slug>/handoffs/ is named
 *     YYYY-MM-DD-<kebab-slug>.md, carries the session-handoff frontmatter, and
 *     keeps all nine sections of docs/features/HANDOFF-TEMPLATE.md;
 *   - relationship keys are YAML lists of repository-relative, Git-tracked,
 *     existing paths;
 *   - each declared `approved_work` queue uses the task-record vocabulary, never
 *     reuses an ID, and never sequences against a retired one;
 *   - each declared `evidence` document is labeled historical and links back to
 *     the feature README that claims it;
 *   - the root handoff.md stays a one-sentence compatibility pointer;
 *   - AGENTS.md, docs/README.md, and development.md all reach the framework, and
 *     development.md never reinstates a global operational handoff.
 *
 * Exit codes: 0 clean, 1 contract failures.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';

const FRAMEWORK = 'docs/features/README.md';
const ROOT_HANDOFF = 'handoff.md';
const AGENTS = 'AGENTS.md';
const DOCS_INDEX = 'docs/README.md';
const DEVELOPMENT = 'development.md';

const REQUIRED_META = ['feature', 'document_role', 'status', 'observed_at', 'as_of_commit'];
const ROLES = new Set(['index', 'handoff', 'session-handoff', 'decision', 'backlog', 'evidence', 'compatibility']);
const STATUSES = new Set(['current', 'accepted', 'historical', 'superseded', 'compatibility']);
const RELATIONSHIPS = new Set(['implemented_by', 'tested_by', 'decisions', 'approved_work', 'evidence']);
const WORK_STATES = new Set(['approved', 'in_progress', 'blocked']);
const OUTCOMES = new Set(['landed', 'rejected', 'superseded', 'claimed_unverified']);
const VERIFICATIONS = new Set(['not_run', 'code_verified', 'environment_verified']);
const CLOSED_KEYS = ['outcome', 'reachable_commit', 'present_in_current_source', 'deployment', 'verification'];

const FEATURE_FILE = /^docs\/features\/([^/]+)\/(.+)$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TASK_ID = /[A-Z][A-Z0-9]*-\d+/;
const CANONICAL = [['README.md', 'index'], ['HANDOFF.md', 'handoff']];

/** Session logs: docs/features/<slug>/handoffs/<file>.md, direct children only. */
const SESSION_FILE = /^docs\/features\/([^/]+)\/handoffs\/([^/]+)$/;
const SESSION_NAME = /^\d{4}-\d{2}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;
const SESSION_META = [...REQUIRED_META, 'session_slug', 'supersedes'];
/**
 * A session log is only useful if it answers the same questions every time, so
 * the nine `##` sections of docs/features/HANDOFF-TEMPLATE.md are required.
 * Delete placeholder text, never a heading: write "None this session." instead.
 */
const SESSION_SECTIONS = [
  'Session Metadata',
  'Current State Summary',
  'Codebase Understanding',
  'Work Completed',
  'Errors, Mistakes & Learnings',
  'Pending Work',
  'Context for Resuming Agent',
  'Environment State',
  'Related Resources',
];
/** History stays readable as `current`, or honestly dated as `historical`. */
const SESSION_STATUSES = new Set(['current', 'historical']);

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** POSIX-style relative link from one repository path to another. */
export function relativeLink(fromFile, toFile) {
  const from = fromFile.split('/').slice(0, -1);
  const to = toFile.split('/');
  let shared = 0;
  while (shared < from.length && shared < to.length - 1 && from[shared] === to[shared]) shared += 1;
  return [...from.slice(shared).map(() => '..'), ...to.slice(shared)].join('/');
}

/** True when `text` contains a Markdown link whose target is `fromFile`-relative `toFile`. */
function linksTo(text, fromFile, toFile) {
  const target = relativeLink(fromFile, toFile);
  const alternatives = [target, `./${target}`];
  return alternatives.some((candidate) =>
    new RegExp(`\\]\\(\\s*<?${escapeRegExp(candidate)}(?:[#)\\s>])`).test(text ?? ''));
}

export function parseFrontmatter(text) {
  // Strip a UTF-8 BOM first: PowerShell's `Set-Content -Encoding utf8` writes
  // one, and it would otherwise make line 1 "<BOM>---" and report "missing
  // frontmatter" on a file that visibly opens with `---`.
  const lines = text.replace(/^\uFEFF/, '').replaceAll('\r\n', '\n').split('\n');
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

/** Task records in a backlog: `## <ID>` / `### <ID>` followed by a ```yaml block. */
export function taskRecords(markdown) {
  const matches = [...markdown.matchAll(new RegExp(`^#{2,3}\\s+(${TASK_ID.source})\\b.*$`, 'gm'))];
  return matches.map((match, index) => {
    const text = markdown.slice(match.index, matches[index + 1]?.index ?? markdown.length);
    const yaml = text.match(/```yaml\s*\n([\s\S]*?)```/)?.[1] ?? '';
    const fields = new Map([...yaml.matchAll(/^([a-z_]+):\s*(.+)$/gm)].map((m) => [m[1], m[2].trim()]));
    return { id: match[1], fields };
  });
}

function validateWorkQueue(path, markdown) {
  const failures = [];
  const records = taskRecords(markdown);
  if (records.length === 0) return [`${path}: declared as approved_work but contains no task records`];
  const retired = new Set();
  const seen = new Set();
  for (const { id, fields } of records) {
    if (seen.has(id)) failures.push(`${path}: ${id}: duplicate task ID; retired/rejected IDs must never be reused`);
    seen.add(id);
    const work = fields.get('work_state');
    const outcome = fields.get('outcome');
    if (work) {
      if (!WORK_STATES.has(work)) failures.push(`${path}: ${id}: invalid work_state ${work}`);
      if (outcome) failures.push(`${path}: ${id}: active work must not also declare outcome`);
      continue;
    }
    for (const key of CLOSED_KEYS) if (!fields.has(key)) failures.push(`${path}: ${id}: missing ${key}`);
    if (!OUTCOMES.has(outcome)) failures.push(`${path}: ${id}: invalid outcome ${outcome ?? '(missing)'}`);
    if (!/^(?:true|false)$/.test(fields.get('present_in_current_source') ?? '')) failures.push(`${path}: ${id}: invalid present_in_current_source`);
    if (!VERIFICATIONS.has(fields.get('verification'))) failures.push(`${path}: ${id}: invalid verification`);
    if (outcome === 'rejected' || outcome === 'superseded') retired.add(id);
  }
  for (const line of markdown.split(/\r?\n/).filter((line) => /^\*\*Dependencies\.\*\*/.test(line))) {
    for (const id of line.match(new RegExp(TASK_ID.source, 'g')) ?? []) {
      if (retired.has(id)) failures.push(`${path}: ${id}: retired/rejected ID appears in dependency sequencing`);
    }
  }
  return failures;
}

/**
 * One session log. The template is enforced structurally, not by wording: the
 * file name, the frontmatter contract, and the presence of every `##` section.
 * What goes UNDER each heading is enforced by review, as it always was.
 */
export function validateSessionHandoff(path, markdown, slug) {
  const failures = [];
  const name = path.slice(path.lastIndexOf('/') + 1);
  if (!SESSION_NAME.test(name)) {
    failures.push(`${path}: session handoff must be named YYYY-MM-DD-<kebab-slug>.md`);
  }

  const parsed = parseFrontmatter(markdown);
  if (parsed.error) return [...failures, `${path}: ${parsed.error}`];

  for (const key of SESSION_META) if (!parsed.fields.has(key)) failures.push(`${path}: missing ${key}`);
  if (parsed.fields.get('document_role') !== 'session-handoff') {
    failures.push(`${path}: document_role must be session-handoff`);
  }
  const status = parsed.fields.get('status');
  if (!SESSION_STATUSES.has(status)) failures.push(`${path}: invalid status ${status ?? '(missing)'}`);
  if (parsed.fields.get('feature') !== slug) failures.push(`${path}: feature must be ${slug}`);

  for (const section of SESSION_SECTIONS) {
    if (!new RegExp(`^##\\s+${escapeRegExp(section)}\\s*$`, 'm').test(parsed.body)) {
      failures.push(`${path}: missing required section "## ${section}" (see docs/features/HANDOFF-TEMPLATE.md)`);
    }
  }
  return failures;
}

function validateEvidence(path, markdown, featureReadme) {
  const failures = [];
  if (!/historical/i.test(markdown)) failures.push(`${path}: evidence must be labeled historical`);
  if (!linksTo(markdown, path, featureReadme)) failures.push(`${path}: evidence must link the current feature README (${featureReadme})`);
  return failures;
}

/** Pure validation over an in-memory repository snapshot. */
export function validateFeatureKnowledge({ files, trackedFiles, existingFiles = trackedFiles }) {
  const failures = [];

  if (!(FRAMEWORK in files)) failures.push(`missing feature knowledge framework: ${FRAMEWORK}`);

  const slugs = new Set();
  for (const path of [...Object.keys(files), ...trackedFiles]) {
    const match = path.match(FEATURE_FILE);
    if (match) slugs.add(match[1]);
  }
  if (slugs.size === 0) failures.push('no feature folder found under docs/features/<slug>/');

  const handoffPaths = new Set();
  for (const slug of [...slugs].sort()) {
    if (!SLUG.test(slug)) failures.push(`docs/features/${slug}: slug must be lowercase kebab-case`);
    handoffPaths.add(`docs/features/${slug}/HANDOFF.md`);

    for (const [name, expectedRole] of CANONICAL) {
      const path = `docs/features/${slug}/${name}`;
      if (!(path in files)) {
        failures.push(`missing canonical ${slug} ${name === 'README.md' ? 'README' : 'HANDOFF'}: ${path}`);
        continue;
      }
      const parsed = parseFrontmatter(files[path]);
      if (parsed.error) failures.push(`${path}: ${parsed.error}`);
      for (const key of REQUIRED_META) if (!parsed.fields.has(key)) failures.push(`${path}: missing ${key}`);
      const role = parsed.fields.get('document_role');
      const status = parsed.fields.get('status');
      if (!ROLES.has(role) || role !== expectedRole) failures.push(`${path}: invalid document_role ${role ?? '(missing)'}`);
      if (!STATUSES.has(status) || status !== 'current') failures.push(`${path}: invalid status ${status ?? '(missing)'}`);
      if (parsed.fields.get('feature') !== slug) failures.push(`${path}: feature must be ${slug}`);

      for (const key of RELATIONSHIPS) {
        if (parsed.fields.has(key)) failures.push(`${path}: relationship ${key} must be a YAML list`);
        if (!parsed.lists.has(key)) continue;
        const targets = parsed.lists.get(key);
        if (targets.length === 0) failures.push(`${path}: relationship ${key} must be a non-empty YAML list`);
        for (const target of targets) {
          if (target.startsWith('/') || target.includes('..')) failures.push(`${path}: relationship ${target} is not repository-relative`);
          else if (!existingFiles.has(target)) failures.push(`${path}: relationship ${target} does not resolve`);
          else if (!trackedFiles.has(target)) failures.push(`${path}: relationship ${target} is not Git-tracked`);
          else if ((key === 'approved_work' || key === 'evidence') && !target.endsWith('.md')) {
            failures.push(`${path}: relationship ${key} target ${target} must be a Markdown document`);
          }
        }
      }

      if (expectedRole !== 'index') continue;
      if (!linksTo(parsed.body, path, FRAMEWORK)) failures.push(`${path}: must link the feature knowledge framework (${FRAMEWORK})`);
      for (const target of parsed.lists.get('approved_work') ?? []) {
        if (target in files) failures.push(...validateWorkQueue(target, files[target]));
      }
      for (const target of parsed.lists.get('evidence') ?? []) {
        if (target in files) failures.push(...validateEvidence(target, files[target], path));
      }
    }
  }

  for (const [path, markdown] of Object.entries(files)) {
    const match = path.match(SESSION_FILE);
    if (match) failures.push(...validateSessionHandoff(path, markdown, match[1]));
  }

  const root = files[ROOT_HANDOFF];
  if (root === undefined) failures.push('missing root handoff.md compatibility pointer');
  else {
    const parsed = parseFrontmatter(root);
    for (const key of REQUIRED_META) if (!parsed.fields.has(key)) failures.push(`root handoff.md: missing ${key}`);
    const feature = parsed.fields.get('feature');
    if (!slugs.has(feature)) failures.push(`root handoff.md: feature ${feature ?? '(missing)'} is not a known feature folder`);
    if (parsed.fields.get('document_role') !== 'compatibility' || parsed.fields.get('status') !== 'compatibility') failures.push('root handoff.md must use compatibility metadata');
    if (parsed.keys.length !== REQUIRED_META.length || parsed.keys.some((key) => !REQUIRED_META.includes(key))) failures.push('root handoff.md must contain only compatibility metadata');
    const bodyLines = parsed.body.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (bodyLines.length !== 1 || bodyLines[0].length > 180) failures.push('root handoff.md must contain only one short pointer sentence');
    const links = [...parsed.body.matchAll(/(?<!!)\[[^\]]*\]\(\s*(?:<([^>]+)>|([^\s)]+))/g)].map((match) => match[1] ?? match[2]);
    if (links.length !== 1 || !handoffPaths.has(links[0])) {
      failures.push('root handoff.md must contain exactly one Markdown link targeting a docs/features/<slug>/HANDOFF.md');
    }
  }

  if (!linksTo(files[AGENTS], AGENTS, FRAMEWORK)) failures.push(`${AGENTS} must link the feature knowledge framework (${FRAMEWORK})`);
  if (!linksTo(files[DOCS_INDEX], DOCS_INDEX, FRAMEWORK)) failures.push(`${DOCS_INDEX} must link the feature knowledge framework (${FRAMEWORK})`);

  const development = files[DEVELOPMENT] ?? '';
  if (!development.includes('docs/features/<slug>/HANDOFF.md')) failures.push(`${DEVELOPMENT} must name docs/features/<slug>/HANDOFF.md`);
  if (!linksTo(development, DEVELOPMENT, FRAMEWORK)) failures.push(`${DEVELOPMENT} must link the feature knowledge framework (${FRAMEWORK})`);
  if (/(?:update|write|keep|maintain)[^\n]{0,80}(?:root|global)\s+(?:`?handoff\.md`?|operational handoff)/i.test(development)) {
    failures.push(`${DEVELOPMENT} must not instruct authors to use a global operational handoff`);
  }

  return failures;
}

export function snapshotRepository(rootDir) {
  const trackedFiles = new Set(execFileSync('git', ['ls-files', '-z'], { cwd: rootDir, encoding: 'utf8' }).split('\0').filter(Boolean).map((path) => path.replaceAll('\\', '/')));
  const existingFiles = new Set([...trackedFiles].filter((path) => existsSync(resolve(rootDir, path))));
  const files = Object.fromEntries([...existingFiles].filter((path) => path.endsWith('.md')).map((path) => [path, readFileSync(resolve(rootDir, path), 'utf8')]));
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
