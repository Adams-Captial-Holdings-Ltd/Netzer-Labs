// NZR-7 frozen checklist (story test plan): ADR-PARTS, FORWARD-LINKS, NO-HISTORY-EDIT, no duplicate ADR numbers, Docs CI.
// Docs-only story, so the "entry point" is the repo's own grep checks and Docs CI scripts. Prints check names and exit codes only.
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const ADR = join(ROOT, 'docs/adr');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const run = (cmd, ...a) => spawnSync(cmd, a, { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
const MARKERS = ['**Status:**', '## Context', '## Decision', '**Decided by.**', '## Consequences', '- **Reversibility:**', '- **Revisit trigger:**', '## Alternatives considered'];
const NEW = ['0022-netzar-owns-work-state-paperclip-replaced.md', '0023-customers-build-workflows.md', '0024-netzar-owns-its-workflow-engine.md'];

// Problems in one ADR text: missing or out-of-order markers, < 2 alternatives, no Q number, no blueprint link.
function adrProblems(text) {
  const out = [];
  let at = -1;
  for (const m of MARKERS) {
    const i = text.indexOf(m, at + 1);
    if (i < 0) out.push(`missing ${m}`);
    else at = i;
  }
  const alts = text.split('## Alternatives considered')[1] ?? '';
  if ((alts.match(/^- \*\*/gm) ?? []).length < 2) out.push('fewer than 2 alternatives');
  if (!/\bQ\d+\b/.test(text)) out.push('no Q number');
  if (!text.includes('blueprint.md')) out.push('no blueprint.md link');
  return out;
}

const results = [];
const rec = (name, pass, detail = '') => {
  results.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
};
const exists = (f) => readdirSync(ADR).includes(f);

for (const f of NEW) {
  const p = exists(f) ? adrProblems(read(`docs/adr/${f}`)) : ['file missing'];
  rec(`ADR-PARTS ${f.slice(0, 4)} has all eight markers in order`, p.length === 0, p.join('; '));
}
// Failure path: the checker must catch a removed marker, so ADR-PARTS is not vacuous.
const sample = exists(NEW[0]) ? read(`docs/adr/${NEW[0]}`) : '';
rec('ADR-PARTS flags an ADR with ## Decision removed', sample !== '' && adrProblems(sample.replace('## Decision', '## Choice')).length > 0);

const adr12 = read('docs/adr/0012-paperclip-owns-work-state.md');
rec('FORWARD-LINKS 0012 links 0022', /ADR 0022|0022-/.test(adr12));
rec('FORWARD-LINKS 0012 line 3 starts **Status:** Superseded', adr12.split('\n')[2].startsWith('**Status:** Superseded'));
rec('FORWARD-LINKS 0017 links 0023', read('docs/adr/0017-netzer-identity-and-work-ui.md').includes('0023'));
rec('FORWARD-LINKS decision-log row 21 links 0023', read('docs/features/paperclip/decision-log.md').split('\n').some((l) => l.startsWith('| 21 |') && l.includes('0023')));
rec('FORWARD-LINKS do-not-build links 0024', read('docs/features/paperclip/do-not-build.md').includes('0024'));

for (const f of ['docs/adr/0012-paperclip-owns-work-state.md', 'docs/adr/0017-netzer-identity-and-work-ui.md']) {
  const r = run('git', 'diff', '--numstat', 'origin/development', '--', f);
  const [add, del] = (r.stdout.trim() || '0\t0').split('\t').map(Number);
  rec(`NO-HISTORY-EDIT ${f.slice(9, 13)} annotated with deletions <= 1`, r.status === 0 && add >= 1 && del <= 1, `exit ${r.status}`);
}

const nums = readdirSync(ADR).filter((f) => /^\d{4}-/.test(f)).map((f) => f.slice(0, 4));
rec('no duplicate ADR numbers', new Set(nums).size === nums.length);
const index = read('docs/adr/README.md');
rec('ADR index has rows 0022, 0023, 0024', NEW.every((f) => index.includes(`](${f})`)));
const front = read('docs/features/netzar-studio/README.md').split('\n---')[0];
rec('netzar-studio README decisions: lists the three ADRs', /^decisions:/m.test(front) && NEW.every((f) => front.includes(`docs/adr/${f}`)));

for (const s of ['docs-links.mjs', 'feature-knowledge.mjs', 'runnable-blocks.mjs']) {
  const r = run('node', `scripts/ci/${s}`);
  rec(`Docs CI ${s} exits 0`, r.status === 0, `exit ${r.status}`);
}

const passed = results.filter(Boolean).length;
console.log(`SUMMARY: ${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
