// NZR-3 G4 E2E: drives the real entry point of this story, the netzar-clone.sh CLI
// (factory script, no HTTP route or UI). Everything runs in a temp dir: a local bare
// repo as origin, fake secrets built at run time, stub npm/npx/free on PATH (no network).
// E2E_BASE / E2E_TOKEN are unused: there is no app for this story.
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, copyFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const SCRIPT = join(REPO, 'scripts/factory/netzar-clone/netzar-clone.sh');
const T = mkdtempSync(join(tmpdir(), 'nzr3-e2e-'));
const P = (...a) => join(T, ...a);

const results = [];
function rec(name, pass, detail = '') {
  results.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
}

// Fake secret built from pieces so this file never matches a scanner; output is masked defensively.
const FAKE = 'nvapi-' + 'A'.repeat(24);
const mask = (s) => String(s).split(FAKE).join('[MASKED]');

const git = (cwd, ...a) =>
  execFileSync('git', ['-c', 'user.email=e2e@example.invalid', '-c', 'user.name=e2e', ...a], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// stub npm/npx/free; STUB_DRIFT=1 makes `npm ci --ignore-scripts` rewrite the lockfile
mkdirSync(P('bin'));
const stub = (n, body) => { writeFileSync(P('bin', n), `#!/usr/bin/env bash\n${body}\n`); chmodSync(P('bin', n), 0o755); };
const rec_ = (n) => `echo "$(date +%s%N) start ${n} $*" >>"$STUB_LOG"; sleep 0.2\n` +
  (n === 'npm' ? `[ "\${STUB_DRIFT:-}" = 1 ] && [ "$*" = "ci --ignore-scripts" ] && echo '{"lock":"drift"}' >package-lock.json\n` : '') +
  `echo "$(date +%s%N) end ${n} $*" >>"$STUB_LOG"`;
stub('npm', rec_('npm'));
stub('npx', rec_('npx'));
stub('free', 'echo "              total        used        free      shared  buff/cache   available"\n' +
  'echo "Mem:           3900        1500        1000          10        1400        ${STUB_AVAIL:-3000}"');

const env = {
  ...process.env,
  PATH: `${P('bin')}:${process.env.PATH}`,
  STUB_LOG: P('stub.log'),
  NETZAR_ORIGIN: P('origin.git'),
  NETZAR_CLONE: P('clone'),
  NETZAR_LOG_DIR: P('logs'),
  NETZAR_APPROVALS: P('approvals.jsonl'),
  NETZAR_HOOKS: P('hooks'),
  NETZAR_PUSH_CRED: 'true', // local-path push needs no credentials
  GIT_TERMINAL_PROMPT: '0',
};
writeFileSync(P('stub.log'), '');
const run = (cmd, args = [], extra = {}) => {
  const r = spawnSync('bash', [SCRIPT, cmd, ...args], { env: { ...env, ...extra }, encoding: 'utf8', timeout: 120000 });
  return { rc: r.status, out: mask(r.stdout) + mask(r.stderr), raw: r.stdout + r.stderr };
};
const latest = (prefix) => {
  const f = readdirSync(P('logs')).filter((x) => x.startsWith(prefix) && x.endsWith('.json')).sort().pop();
  return JSON.parse(readFileSync(P('logs', f), 'utf8'));
};
const lines = (f) => readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

try {
  // seed origin: bare repo + development branch with tracked templates, lockfiles and the repo scanner
  git(T, 'init', '-q', '--bare', '-b', 'development', 'origin.git');
  mkdirSync(P('seed'));
  git(P('seed'), 'init', '-q', '-b', 'development');
  mkdirSync(P('seed/web'));
  mkdirSync(P('seed/scripts/ci'), { recursive: true });
  writeFileSync(P('seed/.env.example'), 'API_KEY=changeme\n');
  writeFileSync(P('seed/package.json'), '{"name":"x"}\n');
  writeFileSync(P('seed/package-lock.json'), '{"lock":"ok"}\n');
  writeFileSync(P('seed/web/package-lock.json'), '{"lock":"ok"}\n');
  copyFileSync(join(REPO, 'scripts/ci/secret-scan.mjs'), P('seed/scripts/ci/secret-scan.mjs'));
  git(P('seed'), 'add', '-A');
  git(P('seed'), 'commit', '-qm', 'seed');
  git(P('seed'), 'push', '-q', P('origin.git'), 'development');

  // --- init + check happy path
  const init = run('init');
  rec('init creates clone with push block', init.rc === 0 && /^INIT /.test(init.out) &&
    git(P('clone'), 'config', 'remote.origin.pushurl') === 'DISABLED-owner-yes-required');
  const sha0 = git(P('clone'), 'rev-parse', 'HEAD');
  let c = run('check');
  const rep = c.rc === 0 ? latest('clone-check') : {};
  rec('check passes on fresh clone', c.rc === 0 && c.out.includes(`CLONE CLEAN ${sha0}`) && rep.sha === sha0 &&
    rep.env_files?.length === 0 && rep.key_files?.length === 0 && rep.scanner_hits === 0 && rep.extra_pattern_hits === 0 &&
    rep.tracked_templates?.includes('.env.example'), c.out.trim().slice(0, 120));

  // --- check failure path: untracked .env, key file, fake nvapi string
  writeFileSync(P('clone/.env'), 'FAKE=1\n');
  writeFileSync(P('clone/id_rsa'), 'not a key\n');
  writeFileSync(P('clone/notes.txt'), `token ${FAKE}\n`);
  c = run('check');
  rec('check fails on .env, key file and nvapi string', c.rc === 1 &&
    c.out.includes('CLONE NOT CLEAN: .env (env file)') && c.out.includes('CLONE NOT CLEAN: id_rsa (key file)') &&
    c.out.includes('CLONE NOT CLEAN: notes.txt'), c.out.trim().split('\n')[0]);
  rec('check never prints the secret value', !c.raw.includes(FAKE));
  const bad = latest('clone-check');
  rec('failing report lists paths, not values', bad.env_files?.includes('.env') && bad.key_files?.includes('id_rsa') &&
    bad.extra_pattern_hits >= 1 && !JSON.stringify(bad).includes(FAKE));

  // --- fetch: dirty tree refused, then clean tree reports the new origin sha
  let f = run('fetch');
  rec('fetch refuses a dirty tree (exit 3)', f.rc === 3 && f.out.includes('REFUSED: dirty tree'));
  for (const x of ['.env', 'id_rsa', 'notes.txt']) rmSync(P('clone', x));
  writeFileSync(P('seed/new.txt'), 'new\n');
  git(P('seed'), 'add', '-A');
  git(P('seed'), 'commit', '-qm', 'second');
  git(P('seed'), 'push', '-q', P('origin.git'), 'development');
  const sha1 = git(P('seed'), 'rev-parse', 'HEAD');
  f = run('fetch');
  rec('fetch prints the new origin sha', f.rc === 0 && f.out.includes(`FETCHED origin/development ${sha1}`) && sha1 !== sha0);

  // --- install: serial order, then drift and low memory refusals
  const inst = run('install');
  const order = readFileSync(P('stub.log'), 'utf8').split('\n').filter(Boolean).map((l) => l.split(' ').slice(1).join(' '));
  const want = ['start npm ci --ignore-scripts', 'end npm ci --ignore-scripts', 'start npm ci --prefix web', 'end npm ci --prefix web',
    'start npx playwright install chromium', 'end npx playwright install chromium'];
  const ir = latest('install-');
  rec('install runs the three commands serially in order', inst.rc === 0 && JSON.stringify(order) === JSON.stringify(want) &&
    ir.ok === true && ir.steps.length === 3 && ir.steps.every((s) => s.exit === 0) && typeof ir.min_avail_mb === 'number',
    `rc=${inst.rc}`);
  rec('install leaves lockfiles unchanged', git(P('clone'), 'status', '--porcelain', '--', 'package-lock.json', 'web/package-lock.json') === '');

  // a changed lockfile hash vs the stamp forces the npm steps again
  writeFileSync(P('seed/package-lock.json'), '{"lock":"v2"}\n');
  git(P('seed'), 'add', '-A');
  git(P('seed'), 'commit', '-qm', 'lock v2');
  git(P('seed'), 'push', '-q', P('origin.git'), 'development');
  run('fetch');
  git(P('clone'), 'merge', '-q', '--ff-only', 'origin/development');
  writeFileSync(P('stub.log'), '');
  let d = run('install', [], { STUB_DRIFT: '1' });
  const ran = readFileSync(P('stub.log'), 'utf8');
  rec('install fails on lockfile drift and runs nothing later', d.rc === 1 && d.out.includes('LOCKFILE CHANGED: package-lock.json') &&
    !ran.includes('--prefix web') && !ran.includes('playwright'));
  git(P('clone'), 'checkout', '-q', '--', 'package-lock.json');
  d = run('install', [], { STUB_AVAIL: '100' });
  rec('install aborts below 250 MB available', d.rc === 1 && d.out.includes('ABORTED: low memory (100 MB available)'));

  // --- push: refused without approval (plain, --no-verify, explicit URL)
  git(P('clone'), 'checkout', '-q', '-b', 'docs/x');
  writeFileSync(P('clone/x.txt'), 'x\n');
  git(P('clone'), 'add', 'x.txt');
  git(P('clone'), 'commit', '-qm', 'x');
  const cs = git(P('clone'), 'rev-parse', 'HEAD');
  const tryPush = (...a) => spawnSync('git', ['push', ...a], { cwd: P('clone'), env: { ...env, GIT_TERMINAL_PROMPT: '0' }, encoding: 'utf8', timeout: 60000 });
  // explicit URL must be unreachable https: a local path needs no credentials and would land the push
  const attempts = [tryPush(), tryPush('--no-verify', 'origin', 'HEAD'), tryPush('--no-verify', 'https://example.invalid/x.git', 'HEAD')];
  const noRemote = () => spawnSync('git', ['--git-dir', P('origin.git'), 'rev-parse', '--verify', '-q', 'refs/heads/docs/x']).status !== 0;
  rec('plain, --no-verify and explicit-URL pushes all fail', attempts.every((r) => r.status !== 0) && noRemote(),
    attempts.map((r) => r.status).join(','));

  // --- approved push: allowed once, only for its sha and ref
  const logf = P('logs/push-attempts.jsonl');
  let p = run('push', [cs, 'docs/x']);
  rec('push without approval exits 4 and is logged', p.rc === 4 && noRemote() &&
    lines(logf).some((l) => l.result === 'refused' && l.sha === cs && l.reason === `no owner yes for ${cs.slice(0, 12)} -> refs/heads/docs/x`));
  writeFileSync(P('approvals.jsonl'), JSON.stringify({ ts: new Date().toISOString(), sha: cs, ref: 'refs/heads/docs/x', owner_text: 'yes push docs/x', used: false }) + '\n');
  p = run('push', [cs, 'other']);
  rec('approval does not cover a different branch', p.rc === 4 && noRemote());
  p = run('push', [cs, 'docs/x']);
  rec('approved push is allowed and lands on origin', p.rc === 0 && p.out.includes(`PUSHED ${cs} -> refs/heads/docs/x`) &&
    spawnSync('git', ['--git-dir', P('origin.git'), 'rev-parse', 'refs/heads/docs/x'], { encoding: 'utf8' }).stdout.trim() === cs);
  rec('allowed push is logged', lines(logf).some((l) => l.result === 'allowed' && l.sha === cs));
  p = run('push', [cs, 'docs/x']);
  rec('approval is single-use', p.rc === 4 && p.out.includes('no owner yes'));
} catch (e) {
  rec('e2e run completed', false, mask(e.message).slice(0, 200));
} finally {
  rmSync(T, { recursive: true, force: true });
}

const pass = results.filter(Boolean).length;
console.log(`SUMMARY: ${pass}/${results.length} passed`);
process.exit(pass === results.length && results.length > 0 ? 0 : 1);
