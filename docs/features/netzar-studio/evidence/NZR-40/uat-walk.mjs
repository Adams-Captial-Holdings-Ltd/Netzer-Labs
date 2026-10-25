// UAT walker for NZR-40: runs every section-3 scenario against the real route-guard CLI, writes uat-transcript.md + uat.json.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '../../../../..');
const cli = join(repo, 'scripts/factory/route-guard/route-guard.mjs');
const md = ['# NZR-40 UAT transcript (G3)', '', `CLI under test: \`scripts/factory/route-guard/route-guard.mjs\` (node ${process.version}). No HTTP surface: the story is CLI-only (§4 "API contract: N/A"), so every request below is a CLI invocation; env paths are per-scenario temp files. No token used.`, ''];
const results = [];

function fresh() {
  const d = mkdtempSync(join(tmpdir(), 'nzr40-uat-'));
  return { GAUNTLET_ROUTES: join(d, 'routes.jsonl'), GAUNTLET_CONSENT: join(d, 'consent.json') };
}
function run(env, args) {
  const r = spawnSync(process.execPath, [cli, ...args], { env: { ...process.env, ...env }, encoding: 'utf8' });
  const out = (r.stdout + r.stderr).trim();
  md.push('```', `$ route-guard.mjs ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`, `exit ${r.status}`, out, '```');
  return { code: r.status, out };
}
const logLines = (env) => (existsSync(env.GAUNTLET_ROUTES) ? readFileSync(env.GAUNTLET_ROUTES, 'utf8').split('\n').filter(Boolean) : []);
function showLog(env) { md.push('Route log:', '```json', ...logLines(env), '```'); }
function scenario(n, title, fn) {
  md.push(`## Scenario ${n}: ${title}`, '');
  const checks = [];
  const expect = (label, ok) => checks.push([label, !!ok]);
  fn(expect);
  md.push('', ...checks.map(([l, ok]) => `- ${ok ? 'PASS' : 'FAIL'}: ${l}`));
  const pass = checks.every(([, ok]) => ok);
  md.push('', `**Result: ${pass ? 'PASS' : 'FAIL'}**`, '');
  results.push({ scenario: String(n), title, result: pass ? 'PASS' : 'FAIL', evidence: `uat-transcript.md#scenario-${n}` });
}
const B = ['--slug', 'uat', '--step'];

scenario(1, 'Routed step (happy path)', (expect) => {
  const env = fresh();
  const j = run(env, ['jev', ...B, 'nzr-12.s1', '--question', 'model', '--choice', 'sol', '--confidence', '0.86']);
  const a = run(env, ['check', ...B, 'nzr-12.s1', '--role', 'builder', '--provider', 'codex', '--model', 'gpt-6-sol', '--session', 'A']);
  const b = run(env, ['check', ...B, 'nzr-12.s1', '--role', 'critic', '--provider', 'claude', '--model', 'opus', '--session', 'B']);
  const s = run(env, ['summary', ...B, 'nzr-12.s1']);
  showLog(env);
  expect('jev recorded, exit 0', j.code === 0);
  expect('builder check exit 0 + ROUTE OK', a.code === 0 && a.out === 'ROUTE OK');
  expect('critic check exit 0 + ROUTE OK', b.code === 0 && b.out === 'ROUTE OK');
  expect('route log has two "allowed" lines', logLines(env).filter((l) => JSON.parse(l).result === 'allowed').length === 2);
  expect('summary prints exact line', s.code === 0 && s.out === 'ROUTE: builder codex/gpt-6-sol (s:A) | critic claude/opus (s:B) | JEV: model -> sol (0.86)');
  expect('no consent file was present', !existsSync(env.GAUNTLET_CONSENT));
});

scenario(2, 'No NVIDIA builder before consent', (expect) => {
  const env = fresh();
  const r = run(env, ['check', ...B, 's2', '--role', 'builder', '--provider', 'nvidia', '--model', 'nemotron-x', '--session', 'C']);
  showLog(env);
  const e = JSON.parse(logLines(env)[0]);
  expect('exit 4', r.code === 4);
  expect('REFUSED message', r.out.includes("ROUTE REFUSED: nvidia needs the owner's yes on the NVIDIA free-tier terms (Q65)"));
  expect('FALLBACK: codex/... printed', /^FALLBACK: codex\//m.test(r.out));
  expect('log result refused / no_nvidia_consent / fallback codex', e.result === 'refused' && e.reason === 'no_nvidia_consent' && e.fallback === 'codex');
});

scenario(3, 'No NVIDIA reviewer before consent', (expect) => {
  const env = fresh();
  const r = run(env, ['check', ...B, 's3', '--role', 'reviewer', '--provider', 'nvidia', '--model', 'nemotron-x', '--session', 'D']);
  showLog(env);
  const e = JSON.parse(logLines(env)[0]);
  expect('exit 4', r.code === 4);
  expect('REFUSED message', r.out.includes("ROUTE REFUSED: nvidia needs the owner's yes"));
  expect('LAYER: L3 NOT RUN line', r.out.includes('LAYER: L3 NOT RUN (no owner yes on NVIDIA terms)'));
  expect('no fallback substituted', !/FALLBACK/.test(r.out) && e.fallback === null);
});

scenario(4, 'Codex never reviews code Codex built', (expect) => {
  const env = fresh();
  run(env, ['check', ...B, 's4a', '--role', 'builder', '--provider', 'codex', '--model', 'gpt-6-sol', '--session', 'A']);
  const rv = run(env, ['check', ...B, 's4a', '--role', 'reviewer', '--provider', 'codex', '--model', 'gpt-6-sol', '--session', 'R']);
  const sc = run(env, ['check', ...B, 's4a', '--role', 'security', '--provider', 'codex', '--model', 'gpt-6-sol', '--session', 'S']);
  run(env, ['check', ...B, 's4b', '--role', 'builder', '--provider', 'claude', '--model', 'opus', '--session', 'A2']);
  const ok = run(env, ['check', ...B, 's4b', '--role', 'reviewer', '--provider', 'codex', '--model', 'gpt-6-sol', '--session', 'R2']);
  showLog(env);
  const msg = 'ROUTE REFUSED: codex built this step; codex may not review it (Q51)';
  expect('codex reviewer on codex-built step: exit 4 + message', rv.code === 4 && rv.out === msg);
  expect('codex security on codex-built step: exit 4 + message', sc.code === 4 && sc.out === msg);
  expect('codex reviewer on claude-built step: exit 0', ok.code === 0);
});

scenario(5, 'The critic is a fresh Claude session', (expect) => {
  const env = fresh();
  const pre = run(env, ['check', ...B, 's5', '--role', 'critic', '--provider', 'claude', '--model', 'opus', '--session', 'B']);
  run(env, ['check', ...B, 's5', '--role', 'builder', '--provider', 'codex', '--model', 'gpt-6-sol', '--session', 'A']);
  const reused = run(env, ['check', ...B, 's5', '--role', 'critic', '--provider', 'claude', '--model', 'opus', '--session', 'A']);
  const codex = run(env, ['check', ...B, 's5', '--role', 'critic', '--provider', 'codex', '--model', 'gpt-6-sol', '--session', 'B']);
  showLog(env);
  expect('reused session: exit 4 + "critic session A also built this step"', reused.code === 4 && reused.out === 'ROUTE REFUSED: critic session A also built this step');
  expect('codex critic: exit 4 + "the critic must be a fresh Claude session"', codex.code === 4 && codex.out === 'ROUTE REFUSED: the critic must be a fresh Claude session');
  expect('premature critic: exit 4 + "no builder recorded for this step"', pre.code === 4 && pre.out === 'ROUTE REFUSED: no builder recorded for this step');
});

scenario(6, 'Consent alone does not let NVIDIA build', (expect) => {
  const env = fresh();
  const consent = { nvidia: { terms_yes: true, ts: '2026-10-25T00:00:00Z', owner_text: 'yes, I read the terms' } };
  writeFileSync(env.GAUNTLET_CONSENT, JSON.stringify(consent), { mode: 0o600 });
  md.push('Consent fixture:', '```json', JSON.stringify(consent), '```');
  const b = run(env, ['check', ...B, 's6', '--role', 'builder', '--provider', 'nvidia', '--model', 'nemotron-x', '--session', 'N1']);
  const r = run(env, ['check', ...B, 's6', '--role', 'reviewer', '--provider', 'nvidia', '--model', 'nemotron-x', '--session', 'N2']);
  showLog(env);
  expect('builder: exit 4 + bake-off message', b.code === 4 && b.out.includes('ROUTE REFUSED: nvidia builders need a passed bake-off (Q65)'));
  expect('builder: FALLBACK: codex/...', /^FALLBACK: codex\//m.test(b.out));
  expect('reviewer: exit 0 + advisory note', r.code === 0 && r.out === 'ROUTE OK (advisory until bake-off qualifies)');
});

scenario(7, 'Broken inputs fail closed', (expect) => {
  const env = fresh();
  writeFileSync(env.GAUNTLET_CONSENT, '{not json');
  md.push('Fixture: consent file contains `{not json`');
  const c = run(env, ['check', ...B, 's7', '--role', 'builder', '--provider', 'codex', '--model', 'gpt-6-sol', '--session', 'A']);
  expect('corrupt consent: exit 5 + NOT CHECKED message', c.code === 5 && c.out === `ROUTE NOT CHECKED: ${env.GAUNTLET_CONSENT} is unreadable; fix it by hand`);
  expect('corrupt consent: nothing recorded', logLines(env).length === 0);
  const env2 = fresh();
  writeFileSync(env2.GAUNTLET_ROUTES, '{"step":"s7"}\nnot json\n');
  md.push('Fixture: route log second line is `not json`');
  const l = run(env2, ['check', ...B, 's7', '--role', 'builder', '--provider', 'codex', '--model', 'gpt-6-sol', '--session', 'A']);
  expect('corrupt log: exit 5 + NOT CHECKED message', l.code === 5 && l.out === `ROUTE NOT CHECKED: ${env2.GAUNTLET_ROUTES} is unreadable; fix it by hand`);
  expect('corrupt log: nothing appended', logLines(env2).length === 2);
  const env3 = fresh();
  const role = run(env3, ['check', ...B, 's7', '--role', 'wizard', '--provider', 'codex', '--model', 'm', '--session', 'A']);
  const prov = run(env3, ['check', ...B, 's7', '--role', 'builder', '--provider', 'acme', '--model', 'm', '--session', 'A']);
  expect('unknown --role: exit 2 + usage line', role.code === 2 && role.out.startsWith('usage:'));
  expect('unknown --provider: exit 2 + usage line', prov.code === 2 && prov.out.startsWith('usage:'));
});

scenario(8, 'Jev is down', (expect) => {
  const env = fresh();
  const stub = join(dirname(env.GAUNTLET_ROUTES), 'jev-stub.sh');
  writeFileSync(stub, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const jr = spawnSync(stub, [], { encoding: 'utf8' });
  md.push('```', `$ JEV_SH=${stub} $JEV_SH model nzr-8.s1`, `exit ${jr.status}`, '```');
  expect('stubbed JEV_SH exits 1', jr.status === 1);
  run(env, ['check', ...B, 's8', '--role', 'builder', '--provider', 'codex', '--model', 'gpt-6-sol', '--session', 'A']);
  run(env, ['check', ...B, 's8', '--role', 'critic', '--provider', 'claude', '--model', 'opus', '--session', 'B']);
  const miss = run(env, ['summary', ...B, 's8']);
  expect('no pick: summary exit 4 + MISSING line', miss.code === 4 && miss.out === 'MISSING: no Jev or advisor pick recorded');
  const j = run(env, ['jev', ...B, 's8', '--unavailable', '--advisor', 'sonnet', '--answer', 'sol']);
  const s = run(env, ['summary', ...B, 's8']);
  showLog(env);
  expect('advisor pick recorded, exit 0', j.code === 0);
  expect('summary carries "JEV: unavailable -> advisor (sonnet): sol"', s.code === 0 && s.out.endsWith('| JEV: unavailable -> advisor (sonnet): sol'));
});

writeFileSync(join(here, 'uat-transcript.md'), `${md.join('\n')}\n`);
writeFileSync('/root/.hermes/netzar-runner/runs/NZR-40/uat.json', `${JSON.stringify(results, null, 2)}\n`);
console.log(results.map((r) => `${r.scenario} ${r.result}`).join('\n'));
