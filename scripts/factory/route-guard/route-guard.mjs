#!/usr/bin/env node
// Gauntlet route guard (NZR-40): checks a role's route against the owner's rules BEFORE it starts and logs the result.
// Install: copy to /root/.claude/bin/route-guard.mjs. Node built-ins only; no network; reads no key.
//   route-guard.mjs check   --slug S --step ID --role builder|critic|security|reviewer --provider codex|claude|nvidia|openrouter --model M --session SID
//                   jev     --slug S --step ID (--question Q --choice C --confidence N | --unavailable --advisor R --answer C)
//                   summary --slug S --step ID
//                   selftest
// Env: GAUNTLET_ROUTES (route log), GAUNTLET_CONSENT (consent file). Exit: 0 ok, 2 usage, 4 refused/missing, 5 file unreadable.
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROLES = ['builder', 'critic', 'security', 'reviewer'];
const PROVIDERS = ['codex', 'claude', 'nvidia', 'openrouter'];
const USAGE = 'usage: route-guard.mjs check|jev|summary --slug S --step ID ... | selftest (see file header)';
const fail = (code, message) => Object.assign(new Error(message), { code });

const paths = (env, slug) => ({
  log: env.GAUNTLET_ROUTES ?? join(homedir(), '.claude', 'plans', `${slug ?? 'default'}-logs`, 'routes.jsonl'),
  consent: env.GAUNTLET_CONSENT ?? join(homedir(), '.claude', 'gauntlet-consent.json'),
});

// Same lock as review-ledger.mjs: a lock is stale only when its holder process is gone.
function withLock(file, fn, waitMs = 10_000) {
  const lock = `${file}.lock`;
  mkdirSync(dirname(file), { recursive: true });
  const deadline = Date.now() + waitMs;
  const holderGone = () => {
    try {
      const pid = Number(readFileSync(join(lock, 'pid'), 'utf8'));
      if (!Number.isInteger(pid) || pid <= 0) return true;
      try { process.kill(pid, 0); return false; } catch (e) { return e.code === 'ESRCH'; }
    } catch { try { return Date.now() - statSync(lock).mtimeMs > 30_000; } catch { return false; } }
  };
  for (;;) {
    try { mkdirSync(lock); writeFileSync(join(lock, 'pid'), `${process.pid}\n`); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (holderGone()) {
        // Recovery is exclusive: only the guard holder may remove, and it re-checks first, so it never deletes a lock a rival just took.
        let guard = `${lock}.recover`;
        try { mkdirSync(guard); } catch (g) {
          if (g.code !== 'EEXIST') throw g;
          // shortcut: a guard older than 30s means its owner crashed mid-recovery; removing it is itself unguarded.
          try { if (Date.now() - statSync(guard).mtimeMs > 30_000) rmSync(guard, { recursive: true, force: true }); } catch {}
          guard = null;
        }
        if (guard) {
          try { if (holderGone()) rmSync(lock, { recursive: true, force: true }); } finally { rmSync(guard, { recursive: true, force: true }); }
          continue;
        }
      }
      if (Date.now() > deadline) throw fail('LOCKED', 'route log is locked by another running process');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try { return fn(); } finally { rmSync(lock, { recursive: true, force: true }); }
}

const unreadable = (file) => fail('CORRUPT', `ROUTE NOT CHECKED: ${file} is unreadable; fix it by hand`);

function readLog(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => {
    let e;
    try { e = JSON.parse(l); } catch { throw unreadable(file); }
    if (!e || typeof e !== 'object' || Array.isArray(e)) throw unreadable(file);
    return e;
  });
}

// No file = no consent. A broken file is an error, never a silent "no".
function readConsent(file) {
  if (!existsSync(file)) return {};
  try {
    const c = JSON.parse(readFileSync(file, 'utf8'));
    if (!c || typeof c !== 'object' || Array.isArray(c)) throw new Error('not an object');
    return c;
  } catch { throw unreadable(file); }
}

const nvidiaYes = (c) => c.nvidia?.terms_yes === true && typeof c.nvidia.ts === 'string'
  && typeof c.nvidia.owner_text === 'string' && c.nvidia.owner_text.trim() !== '';

export function decide({ log, consent, step, role, provider, session }) {
  const builders = log.filter((e) => e.step === step && e.role === 'builder' && e.result === 'allowed');
  const refuse = (reason, msg, extra = []) => ({ ok: false, reason, lines: [`ROUTE REFUSED: ${msg}`, ...extra] });
  if (provider === 'nvidia') {
    if (!nvidiaYes(consent)) {
      const msg = "nvidia needs the owner's yes on the NVIDIA free-tier terms (Q65)";
      return role === 'builder'
        ? { ...refuse('no_nvidia_consent', msg, ['FALLBACK: codex/same rung']), fallback: 'codex' }
        : refuse('no_nvidia_consent', msg, ['LAYER: L3 NOT RUN (no owner yes on NVIDIA terms)']);
    }
    if (role === 'builder' && consent.nvidia.build_bakeoff_passed !== true) {
      return { ...refuse('no_build_bakeoff', 'nvidia builders need a passed bake-off (Q65)', ['FALLBACK: codex/same rung']), fallback: 'codex' };
    }
  }
  if (role === 'critic') {
    if (provider !== 'claude') return refuse('critic_not_claude', 'the critic must be a fresh Claude session');
    if (!builders.length) return refuse('no_builder', 'no builder recorded for this step');
    if (builders.some((b) => b.session === session)) return refuse('critic_reused_session', `critic session ${session} also built this step`);
  }
  // Separation must hold in either order (rule c / C-47): a session that criticised the step may not build it.
  if (role === 'builder' && log.some((e) => e.step === step && e.role === 'critic' && e.result === 'allowed' && e.session === session)) {
    return refuse('builder_was_critic', `builder session ${session} already criticised this step`);
  }
  if ((role === 'reviewer' || role === 'security') && provider === 'codex' && builders.some((b) => b.provider === 'codex')) {
    return refuse('codex_self_review', 'codex built this step; codex may not review it (Q51)');
  }
  return { ok: true, note: provider === 'nvidia' && role !== 'builder' ? ' (advisory until bake-off qualifies)' : '' };
}

function summary(log, step) {
  const last = (f) => log.filter((e) => e.step === step && f(e)).pop();
  const b = last((e) => e.role === 'builder' && e.result === 'allowed');
  const c = last((e) => e.role === 'critic' && e.result === 'allowed');
  const j = last((e) => e.kind === 'jev');
  const missing = [!b && 'no builder recorded', !c && 'no critic recorded', !j && 'no Jev or advisor pick recorded'].filter(Boolean);
  if (missing.length) return { ok: false, lines: missing.map((m) => `MISSING: ${m}`) };
  const jev = j.unavailable ? `unavailable -> advisor (${j.advisor}): ${j.answer}` : `${j.question} -> ${j.choice} (${j.confidence})`;
  return { ok: true, lines: [`ROUTE: builder ${b.provider}/${b.model} (s:${b.session}) | critic ${c.provider}/${c.model} (s:${c.session}) | JEV: ${jev}`] };
}

export function main(argv, env = process.env, out = console) {
  const [cmd, ...rest] = argv;
  const flags = {};
  try {
    for (let i = 0; i < rest.length; i++) {
      if (!rest[i].startsWith('--')) throw fail('USAGE', USAGE);
      const k = rest[i].slice(2);
      if (k === 'unavailable') { flags[k] = true; continue; }
      if (rest[i + 1] === undefined || rest[i + 1].startsWith('--')) throw fail('USAGE', `--${k} needs a value`);
      flags[k] = rest[++i];
    }
    const need = (...ks) => ks.forEach((k) => { if (!flags[k]) throw fail('USAGE', `${USAGE}\n--${k} is required`); });
    const { log: logFile, consent: consentFile } = paths(env, flags.slug);
    const lockWait = Number(env.GAUNTLET_LOCK_WAIT_MS) > 0 ? Number(env.GAUNTLET_LOCK_WAIT_MS) : 10_000;
    const append = (e) => appendFileSync(logFile, `${JSON.stringify(e)}\n`);
    const ts = () => new Date().toISOString();
    if (cmd === 'check') {
      need('step', 'role', 'provider', 'model', 'session');
      if (!ROLES.includes(flags.role)) throw fail('USAGE', `${USAGE}\nrole must be one of ${ROLES.join('|')}`);
      if (!PROVIDERS.includes(flags.provider)) throw fail('USAGE', `${USAGE}\nprovider must be one of ${PROVIDERS.join('|')}`);
      const d = withLock(logFile, () => {
        const r = decide({ log: readLog(logFile), consent: readConsent(consentFile), ...flags });
        append({ ts: ts(), step: flags.step, role: flags.role, provider: flags.provider, model: flags.model, session: flags.session, result: r.ok ? 'allowed' : 'refused', reason: r.reason ?? null, fallback: r.fallback ?? null });
        return r;
      }, lockWait);
      if (d.ok) { out.log(`ROUTE OK${d.note}`); return 0; }
      d.lines.forEach((l) => out.log(l));
      return 4;
    }
    if (cmd === 'jev') {
      need('step');
      const e = flags.unavailable
        ? (need('advisor', 'answer'), { unavailable: true, advisor: flags.advisor, answer: flags.answer })
        : (need('question', 'choice', 'confidence'), { question: flags.question, choice: flags.choice, confidence: flags.confidence });
      withLock(logFile, () => { readLog(logFile); append({ ts: ts(), step: flags.step, kind: 'jev', ...e }); }, lockWait);
      out.log('JEV recorded');
      return 0;
    }
    if (cmd === 'summary') {
      need('step');
      const s = summary(readLog(logFile), flags.step);
      s.lines.forEach((l) => out.log(l));
      return s.ok ? 0 : 4;
    }
    if (cmd === 'selftest') return selftest(out);
    throw fail('USAGE', USAGE);
  } catch (e) {
    if (e.code === 'USAGE') { out.error(e.message); return 2; }
    out.error(e.code === 'CORRUPT' ? e.message : `route-guard: ${e.message}`);
    return 5;
  }
}

function selftest(out) {
  const dir = mkdtempSync(join(tmpdir(), 'route-guard-'));
  const env = { GAUNTLET_ROUTES: join(dir, 'routes.jsonl'), GAUNTLET_CONSENT: join(dir, 'consent.json') };
  const quiet = { log() {}, error() {} };
  const run = (...a) => main(a, env, quiet);
  const c = (role, provider, session) => run('check', '--step', 's', '--role', role, '--provider', provider, '--model', 'm', '--session', session);
  const checks = [
    ['codex builder allowed', () => c('builder', 'codex', 'A') === 0],
    ['nvidia builder refused without consent', () => c('builder', 'nvidia', 'C') === 4],
    ['codex reviewer refused after codex built', () => c('reviewer', 'codex', 'D') === 4],
    ['critic reusing builder session refused', () => c('critic', 'claude', 'A') === 4],
    ['fresh claude critic allowed', () => c('critic', 'claude', 'B') === 0],
    ['summary needs a Jev pick', () => run('summary', '--step', 's') === 4],
    ['summary ok after jev', () => run('jev', '--step', 's', '--question', 'model', '--choice', 'sol', '--confidence', '0.9') === 0 && run('summary', '--step', 's') === 0],
  ];
  let bad = 0;
  for (const [name, f] of checks) { const ok = f(); if (!ok) bad++; out.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); }
  rmSync(dir, { recursive: true, force: true });
  return bad ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
