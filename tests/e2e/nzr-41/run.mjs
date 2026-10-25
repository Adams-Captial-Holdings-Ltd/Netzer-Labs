// NZR-41 G4 E2E: drives the real entry points, the review-plan.mjs and review-ledger.mjs CLIs (factory scripts, no HTTP route).
// Temp dir for logs, sends and ledger; prints step names and exit codes only, never file contents.
import { spawnSync } from 'node:child_process';
import { appendFileSync, copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../scripts/factory');
const T = mkdtempSync(join(tmpdir(), 'nzr41-e2e-'));
const env = { ...process.env, GAUNTLET_SENDS: join(T, 'sends.jsonl'), GAUNTLET_LEDGER: join(T, 'l.jsonl'), GAUNTLET_POLICY: join(T, 'p.json') };
const cli = (script, ...a) => {
  const r = spawnSync('node', [join(ROOT, script), ...a], { env, encoding: 'utf8', timeout: 30000 });
  return { rc: r.status, out: (r.stdout + r.stderr).trim() };
};
const A = 'a'.repeat(40);
const line = (l, s = 'ran') => `REVIEW: ${l} ${s} ${A}`;
const verify = (tier, lines) => {
  const f = join(T, 'step.log');
  writeFileSync(f, `${lines.join('\n')}\n`);
  return cli('review-plan/review-plan.mjs', 'verify', '--tier', tier, '--log', f);
};

const results = [];
const rec = (name, pass, detail = '') => {
  results.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
};

try {
  let r = cli('review-plan/review-plan.mjs', 'plan', '--tier', 'T2');
  rec('T2 plan lists required and forbidden layers', r.rc === 0 && r.out.includes('"forbidden":["L1","L2","L3","L6"]'), `exit ${r.rc}`);
  r = verify('T2', [line('L0'), line('critic'), line('step-maid')]);
  rec('T2 log with free layers only passes', r.rc === 0, `exit ${r.rc}`);
  r = verify('T2', [line('L0'), line('critic'), line('step-maid'), line('L6')]);
  rec('T2 log with a Greptile run is rejected', r.rc === 1 && r.out.includes('FORBIDDEN LAYER RAN: L6 greptile'), `exit ${r.rc}`);
  const t3 = [line('L0'), line('critic'), line('step-maid'), line('L1'), line('L2'), line('L3', 'NOT RUN (no owner yes on NVIDIA terms)'), line('L4'), line('L5'), `${line('L6')} ledger=e2e`];
  r = verify('T3', t3);
  rec('T3 log with one Greptile pass passes', r.rc === 0 && r.out.includes('TIER OK T3'), `exit ${r.rc}`);
  r = verify('T3', t3.map((l) => (l.startsWith('REVIEW: L1 ') ? line('L1', 'NOT RUN (kodus signed out)') : l)));
  rec('T3 log with a NOT RUN layer is INCOMPLETE', r.rc === 2, `exit ${r.rc}`);

  r = cli('review-plan/review-plan.mjs', 'send-check', '--layer', 'kodus', '--step', 'e2e.s1', '--sha', A);
  rec('send without a yes is refused', r.rc === 4 && r.out.startsWith('ASK OWNER:'), `exit ${r.rc}`);
  appendFileSync(env.GAUNTLET_SENDS, `${JSON.stringify({ layer: 'kodus', step: 'e2e.s1', sha: A, owner_text: 'yes kodus this run', id: 'e2e-consent-1' })}\n`);
  r = cli('review-plan/review-plan.mjs', 'send-check', '--layer', 'kodus', '--step', 'e2e.s1', '--sha', A);
  rec('send with a yes is allowed once', r.rc === 0, `exit ${r.rc}`);
  r = cli('review-plan/review-plan.mjs', 'send-check', '--layer', 'kodus', '--step', 'e2e.s1', '--sha', A);
  rec('the same yes cannot be reused', r.rc === 4 && r.out.includes('yes already used'), `exit ${r.rc}`);

  copyFileSync(join(ROOT, 'review-ledger/gauntlet-review-policy.json'), env.GAUNTLET_POLICY);
  r = cli('review-ledger/review-ledger.mjs', 'reserve', 'base', A, '--step', 'e2e.s1');
  rec('first reserve for a step is granted', r.rc === 0, `exit ${r.rc}`);
  r = cli('review-ledger/review-ledger.mjs', 'reserve', 'base', 'b'.repeat(40), '--step', 'e2e.s1');
  rec('second reserve for the step needs --reason', r.rc === 4 && r.out.includes('a second needs --reason'), `exit ${r.rc}`);
} finally {
  rmSync(T, { recursive: true, force: true });
}
const passed = results.filter(Boolean).length;
console.log(`SUMMARY: ${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
