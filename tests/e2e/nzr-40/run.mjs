// NZR-40 G4 E2E: drives the real entry point, the route-guard.mjs CLI (factory script, no HTTP route or UI).
// Temp dir for log and consent; prints exit codes only, never file contents.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const GUARD = resolve(dirname(fileURLToPath(import.meta.url)), '../../../scripts/factory/route-guard/route-guard.mjs');
const T = mkdtempSync(join(tmpdir(), 'nzr40-e2e-'));
const env = { ...process.env, GAUNTLET_ROUTES: join(T, 'routes.jsonl'), GAUNTLET_CONSENT: join(T, 'consent.json') };
const guard = (...a) => {
  const r = spawnSync('node', [GUARD, ...a], { env, encoding: 'utf8', timeout: 20000 });
  return { rc: r.status, out: (r.stdout + r.stderr).trim() };
};
const check = (step, role, provider, session, model = 'm') =>
  guard('check', '--step', step, '--role', role, '--provider', provider, '--model', model, '--session', session);

const results = [];
const rec = (name, pass, detail = '') => {
  results.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
};

try {
  guard('jev', '--step', 'e2e.s1', '--question', 'model', '--choice', 'sol', '--confidence', '0.86');
  let r = check('e2e.s1', 'builder', 'codex', 'A', 'gpt-6-sol');
  rec('codex builder allowed', r.rc === 0, `exit ${r.rc}`);
  r = check('e2e.s1', 'critic', 'claude', 'B', 'opus');
  rec('fresh claude critic allowed', r.rc === 0, `exit ${r.rc}`);
  r = guard('summary', '--step', 'e2e.s1');
  rec('summary prints the ROUTE and JEV line', r.rc === 0 && r.out === 'ROUTE: builder codex/gpt-6-sol (s:A) | critic claude/opus (s:B) | JEV: model -> sol (0.86)', `exit ${r.rc}`);

  r = check('e2e.s1', 'critic', 'claude', 'A', 'opus');
  rec('critic reusing the builder session refused', r.rc === 4, `exit ${r.rc}`);
  r = check('e2e.s1', 'reviewer', 'codex', 'C');
  rec('codex reviewer refused on a codex-built step', r.rc === 4, `exit ${r.rc}`);
  r = check('e2e.s2', 'builder', 'nvidia', 'D');
  rec('nvidia builder refused without consent, codex fallback printed', r.rc === 4 && r.out.includes('FALLBACK: codex/'), `exit ${r.rc}`);
  writeFileSync(env.GAUNTLET_CONSENT, '{broken');
  r = check('e2e.s3', 'builder', 'codex', 'E');
  rec('broken consent file fails closed', r.rc === 5, `exit ${r.rc}`);
} finally {
  rmSync(T, { recursive: true, force: true });
}

const passed = results.filter(Boolean).length;
console.log(`SUMMARY: ${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
