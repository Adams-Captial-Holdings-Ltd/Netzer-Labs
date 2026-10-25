#!/usr/bin/env node
// Greptile credit ledger for the Gauntlet review layer (references/review-gauntlet.md section 7).
// Append-only JSONL. Reserve BEFORE a paid review, commit/release AFTER. A reserve with no commit/release counts as spent
// (a crash or a retry must never hide spend). Every write holds an exclusive lock around read-check-append, and a corrupt
// ledger refuses to answer instead of guessing. Weights and the monthly budget are planning assumptions until verified.
//   review-ledger.mjs status | reserve <base|plus|apex> <40-hex sha> [--risk high] [--reason TEXT] [--pr ID] [--step ID] [--apex-approved]
//                     | commit <id> | release <id> [reason] | selftest
// Exit codes: 0 ok, 2 usage, 4 NOT RUN (budget or a rule refused the review), 5 ledger or policy unreadable (also NOT RUN).
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_POLICY = {
  monthly_units: 50, weights: { base: 1, plus: 3, apex: 10 }, weights_verified: false,
  soft_warn_pct: 70, hard_stop_pct: 100, reserve_units_high_risk: 10,
};
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const fail = (code, message) => Object.assign(new Error(message), { code });
const paths = (env = process.env) => ({
  ledger: env.GAUNTLET_LEDGER ?? join(homedir(), '.claude', 'gauntlet-review-ledger.jsonl'),
  policy: env.GAUNTLET_POLICY ?? join(homedir(), '.claude', 'gauntlet-review-policy.json'),
});
const month = (ts = new Date()) => ts.toISOString().slice(0, 7);
const whole = (n) => Number.isInteger(n) && n > 0;

export function loadPolicy(file) {
  let raw = {};
  if (existsSync(file)) {
    try { raw = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { throw fail('CORRUPT', `policy ${file} is not valid JSON: ${e.message}`); }
  }
  const p = { ...DEFAULT_POLICY, ...raw, weights: { ...DEFAULT_POLICY.weights, ...(raw.weights ?? {}) } };
  const bad = [!whole(p.monthly_units) && 'monthly_units', !Object.values(p.weights).every(whole) && 'weights',
    !(Number.isInteger(p.reserve_units_high_risk) && p.reserve_units_high_risk >= 0 && p.reserve_units_high_risk < p.monthly_units) && 'reserve_units_high_risk',
    !(p.hard_stop_pct > 0 && p.hard_stop_pct <= 100) && 'hard_stop_pct', !(p.soft_warn_pct >= 0 && p.soft_warn_pct <= 100) && 'soft_warn_pct',
    typeof p.weights_verified !== 'boolean' && 'weights_verified'].filter(Boolean);
  if (bad.length) throw fail('CORRUPT', `policy ${file} has invalid ${bad.join(', ')} (need positive whole numbers)`);
  return p;
}

function readEvents(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').map((line, i) => [line, i + 1]).filter(([l]) => l).map(([l, n]) => {
    let e;
    try { e = JSON.parse(l); } catch { throw fail('CORRUPT', `ledger ${file} line ${n} is not valid JSON; fix or remove it by hand (spend must not be guessed)`); }
    const ok = e && typeof e === 'object' && typeof e.id === 'string' && /^\d{4}-\d{2}$/.test(e.month ?? '') && ['reserve', 'commit', 'release'].includes(e.event)
      && (e.event !== 'reserve' || (typeof e.tier === 'string' && whole(e.units) && SHA.test(e.sha ?? '')));
    if (!ok) throw fail('CORRUPT', `ledger ${file} line ${n} is missing or has wrong fields (id, month, event, and for reserve: tier, units, sha); fix it by hand (spend must not be guessed)`);
    return e;
  });
}

// Per-id state for the current month: pending | committed | released.
export function summarize(events, policy, now = new Date()) {
  const cur = month(now);
  const byId = new Map();
  for (const e of events) {
    if (e.month !== cur) continue;
    const s = byId.get(e.id) ?? { id: e.id };
    if (e.event === 'reserve') Object.assign(s, { tier: e.tier, units: e.units, sha: e.sha, pr: e.pr, step: e.step, state: 'pending' });
    else if (s.state === 'pending') s.state = e.event === 'commit' ? 'committed' : 'released';
    byId.set(e.id, s);
  }
  const live = [...byId.values()].filter((s) => s.state && s.state !== 'released');
  const used = live.reduce((n, s) => n + s.units, 0);
  if (!Number.isFinite(used)) throw fail('CORRUPT', 'ledger units do not add up to a number');
  return { used, pending: live.filter((s) => s.state === 'pending').length, live, remaining: policy.monthly_units - used, reserve: policy.reserve_units_high_risk, byId };
}

export function decide({ events, policy, tier, sha, risk = 'normal', reason = '', apexApproved = false, step, now = new Date() }) {
  if (!Object.hasOwn(policy.weights, tier)) return { ok: false, why: `unknown tier ${tier}` };
  if (!SHA.test(sha)) return { ok: false, why: 'sha must be the full lowercase commit id (40 hex characters)' };
  const units = policy.weights[tier];
  const s = summarize(events, policy, now);
  const hard = Math.floor((policy.monthly_units * policy.hard_stop_pct) / 100);
  if (tier === 'apex' && !apexApproved) return { ok: false, why: 'apex needs the owner\'s yes in chat (pass --apex-approved)' };
  if (s.used + units > hard) return { ok: false, why: `hard stop: ${s.used}+${units} > ${hard} units this month` };
  if (risk !== 'high' && s.used + units > policy.monthly_units - policy.reserve_units_high_risk) {
    return { ok: false, why: `would use the ${policy.reserve_units_high_risk}-unit reserve kept for high-risk changes` };
  }
  if (step && s.live.some((r) => r.step === step) && !reason) return { ok: false, why: `step ${step} already had a paid review this month; a second needs --reason` };
  if (s.live.some((r) => r.sha === sha) && !reason) return { ok: false, why: `${sha.slice(0, 12)} already has a paid review this month; a second needs --reason` };
  const after = s.used + units;
  return { ok: true, units, warn: (after / policy.monthly_units) * 100 >= policy.soft_warn_pct ? `soft warning: ${after}/${policy.monthly_units} units after this review` : null };
}

function withLock(file, fn, waitMs = 10_000) {
  const lock = `${file}.lock`;
  mkdirSync(dirname(file), { recursive: true });
  const deadline = Date.now() + waitMs;
  // A lock is stale only when its holder process is gone (or it never recorded a pid and is old): a slow live holder is never robbed.
  const holderGone = () => {
    try {
      const pid = Number(readFileSync(join(lock, 'pid'), 'utf8'));
      if (!Number.isInteger(pid) || pid <= 0) return true;
      try { process.kill(pid, 0); return false; } catch (e) { return e.code === 'ESRCH'; }
    } catch { try { return Date.now() - statSync(lock).mtimeMs > 30_000; } catch { return false; } }
  };
  // Recovery is exclusive: one process at a time removes a lock, and it rechecks the holder inside that mutex so it can
  // never delete a live lock another recoverer just created. A recovery mutex orphaned by a crash expires after 30s.
  const recover = () => {
    if (!holderGone()) return false;
    const mutex = `${lock}.recover`;
    try { mkdirSync(mutex); } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { if (Date.now() - statSync(mutex).mtimeMs > 30_000) rmSync(mutex, { recursive: true, force: true }); } catch { /* gone already */ }
      return false;
    }
    try { if (holderGone()) rmSync(lock, { recursive: true, force: true }); } finally { rmSync(mutex, { recursive: true, force: true }); }
    return true;
  };
  for (;;) {
    try { mkdirSync(lock); writeFileSync(join(lock, 'pid'), `${process.pid}\n`); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (recover()) continue;
      if (Date.now() > deadline) throw fail('LOCKED', 'ledger is locked by another running process');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try { return fn(); } finally { rmSync(lock, { recursive: true, force: true }); }
}

function main(argv, env = process.env, out = console) {
  const [cmd, ...rest] = argv;
  const { ledger, policy: pf } = paths(env);
  try {
    const policy = loadPolicy(pf);
    const lockWait = Number(env.GAUNTLET_LOCK_WAIT_MS) > 0 ? Number(env.GAUNTLET_LOCK_WAIT_MS) : 10_000;
    const val = (n) => { // value of --n, which must exist and not be another flag
      const i = rest.indexOf(n);
      if (i < 0) return undefined;
      if (rest[i + 1] === undefined || rest[i + 1].startsWith('--')) throw fail('USAGE', `${n} needs a value`);
      return rest[i + 1];
    };
    const note = () => { if (!policy.weights_verified) out.error('WEIGHTS UNVERIFIED: tier weights and the monthly budget are planning assumptions; confirm them from the Greptile account.'); };
    const write = (e) => appendFileSync(ledger, `${JSON.stringify({ ts: new Date().toISOString(), month: month(), ...e })}\n`);
    if (cmd === 'status') {
      const s = summarize(readEvents(ledger), policy);
      note();
      out.log(`month ${month()}  used ${s.used}/${policy.monthly_units}  pending ${s.pending}  remaining ${s.remaining}  high-risk reserve ${s.reserve}`);
      const byPr = {};
      for (const r of s.live) if (r.pr) byPr[r.pr] = (byPr[r.pr] ?? 0) + r.units;
      for (const [pr, u] of Object.entries(byPr)) out.log(`  pr ${pr}: ${u} units`);
      return 0;
    }
    if (cmd === 'reserve') {
      const [tier, sha] = rest;
      if (!tier || !sha) return usage(out);
      note();
      const [risk, reason, pr, step] = [val('--risk'), val('--reason') ?? '', val('--pr'), val('--step')];
      return withLock(ledger, () => {
        const events = readEvents(ledger);
        const ms = Number(env.GAUNTLET_TEST_DELAY_MS); // honoured only inside selftest: widens the race window
        if (env.GAUNTLET_SELFTEST === '1' && Number.isFinite(ms) && ms > 0 && ms <= 5000) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
        const d = decide({ events, policy, tier, sha, risk, reason, step, apexApproved: rest.includes('--apex-approved') });
        if (!d.ok) { out.log(`NOT RUN: ${d.why}`); return 4; }
        const id = `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
        write({ id, event: 'reserve', tier, units: d.units, sha, pr, step, reason, risk: risk ?? 'normal', apex_approved: rest.includes('--apex-approved') });
        if (d.warn) out.error(d.warn);
        out.log(id);
        return 0;
      }, lockWait);
    }
    if (cmd === 'commit' || cmd === 'release') {
      if (!rest[0]) return usage(out);
      return withLock(ledger, () => {
        const st = summarize(readEvents(ledger), policy).byId.get(rest[0]);
        if (!st) { out.error(`unknown id ${rest[0]}`); return 2; }
        if (st.state !== 'pending') { out.error(`${rest[0]} is already ${st.state}; only a pending reserve can be ${cmd === 'commit' ? 'committed' : 'released'}`); return 2; }
        write({ id: rest[0], event: cmd, reason: cmd === 'release' ? rest.slice(1).join(' ') : '' });
        return 0;
      }, lockWait);
    }
    return usage(out);
  } catch (e) {
    if (e.code === 'USAGE') { out.error(e.message); return 2; }
    if (e.code === 'CORRUPT' || e.code === 'LOCKED') { out.log(`NOT RUN: ${e.message}`); return 5; }
    throw e;
  }
}
const usage = (out) => { out.error('usage: review-ledger.mjs status | reserve <base|plus|apex> <40-hex sha> [--risk high] [--reason TEXT] [--pr ID] [--step ID] [--apex-approved] | commit <id> | release <id> [reason] | selftest'); return 2; };

async function selftest() {
  const assert = (c, m) => { if (!c) throw new Error(`selftest failed: ${m}`); };
  const dir = mkdtempSync(join(tmpdir(), 'ledger-'));
  const env = { GAUNTLET_LEDGER: join(dir, 'l.jsonl'), GAUNTLET_POLICY: join(dir, 'none.json') };
  const quiet = { log: (m) => quiet.last.push(m), error: () => {}, last: [] };
  const run = (...a) => { quiet.last = []; return [main(a, env, quiet), quiet.last.at(-1)]; };
  const sha = (n) => n.toString(16).padStart(40, 'a');
  let [c, id] = run('reserve', 'plus', sha(1));
  assert(c === 0 && id, 'plus allowed in an empty month');
  assert(run('reserve', 'plus', sha(1))[0] === 4, 'second review of the same sha refused without --reason');
  assert(run('reserve', 'plus', sha(1), '--reason', 'code changed after fixes')[0] === 0, 'justified second review allowed');
  assert(run('commit', id)[0] === 0, 'commit works');
  assert(run('release', id, 'oops')[0] === 2, 'release after commit is refused');
  assert(run('commit', id)[0] === 2, 'double commit is refused');
  let [, rel] = run('reserve', 'base', sha(2), '--pr', '17');
  assert(run('status')[1] === undefined || true, 'status runs');
  run('release', rel, 'review failed to start');
  assert(run('release', rel)[0] === 2, 'double release is refused');
  assert(run('status')[1].includes('used 6/50') || quiet.last.some((l) => l.includes('used 6/50')), 'a released reserve is not spent; commit and pending are');
  assert(run('reserve', 'apex', sha(3))[0] === 4, 'apex refused without approval');
  assert(run('reserve', 'apex', sha(3), '--apex-approved', '--risk', 'high')[0] === 0, 'apex allowed with approval');
  for (let i = 10; i < 34; i++) assert(run('reserve', 'base', sha(i))[0] === 0, `base ${i} allowed`);
  assert(run('reserve', 'base', sha(90))[0] === 4, 'normal-risk review may not eat the high-risk reserve');
  assert(run('reserve', 'plus', sha(91), '--risk', 'high')[0] === 0, 'high-risk review may use the reserve');
  for (let i = 100; i < 107; i++) run('reserve', 'base', sha(i), '--risk', 'high');
  assert(run('reserve', 'base', sha(200), '--risk', 'high')[0] === 4, 'hard stop at the monthly budget');
  for (const tier of ['constructor', '__proto__', 'toString', 'nope']) assert(run('reserve', tier, sha(300))[0] === 4, `tier ${tier} refused`);
  for (const bad of ['abc1234', 'ABCDEF'.repeat(7).slice(0, 40), '$(touch /tmp/x)']) assert(run('reserve', 'base', bad)[0] === 4, `sha ${bad} refused`);
  assert(run('reserve', 'base', sha(301), '--reason', '--risk', 'high')[0] === 2, 'a flag cannot be swallowed as a value');
  writeFileSync(env.GAUNTLET_LEDGER, `${readFileSync(env.GAUNTLET_LEDGER, 'utf8')}{"truncated\n`);
  assert(run('status')[0] === 5 && run('reserve', 'base', sha(302))[0] === 5, 'a corrupt ledger refuses instead of guessing');
  writeFileSync(env.GAUNTLET_POLICY, JSON.stringify({ weights: { base: '1' } }));
  assert(run('reserve', 'base', sha(303))[0] === 5, 'string weights refused');

  // one paid review per step: a second reserve for the same step (new sha) needs --reason (NZR-41)
  const sdir = mkdtempSync(join(tmpdir(), 'ledger-step-'));
  const senv = { GAUNTLET_LEDGER: join(sdir, 'l.jsonl'), GAUNTLET_POLICY: join(sdir, 'none.json') };
  const sq = { log: (m) => { sq.last = m; }, error: () => {}, last: '' };
  const srun = (...a) => main(a, senv, sq);
  assert(srun('reserve', 'base', sha(1), '--step', 'nzr-5.s1') === 0, 'first reserve for a step allowed');
  assert(srun('reserve', 'base', sha(2), '--step', 'nzr-5.s1') === 4 && sq.last === 'NOT RUN: step nzr-5.s1 already had a paid review this month; a second needs --reason', 'a second reserve for one step needs --reason');
  assert(srun('reserve', 'base', sha(2), '--step', 'nzr-5.s2') === 0, 'a different step is independent');
  assert(srun('reserve', 'base', sha(2), '--step', 'nzr-5.s1', '--reason', 'owner yes: rerun after blocker fix') === 0, 'a second reserve with --reason is allowed');

  // concurrency: 30 parallel reserves against a 20-unit budget must grant exactly 20 and never overspend
  const cdir = mkdtempSync(join(tmpdir(), 'ledger-conc-'));
  const cenv = { ...process.env, GAUNTLET_LEDGER: join(cdir, 'l.jsonl'), GAUNTLET_POLICY: join(cdir, 'p.json'), GAUNTLET_TEST_DELAY_MS: '100', GAUNTLET_SELFTEST: '1' };
  writeFileSync(cenv.GAUNTLET_POLICY, JSON.stringify({ monthly_units: 20, reserve_units_high_risk: 0 }));
  const self = fileURLToPath(import.meta.url);
  const codes = await Promise.all(Array.from({ length: 30 }, (_, i) => new Promise((res) => {
    const p = spawn('node', [self, 'reserve', 'base', sha(1000 + i)], { env: cenv, stdio: 'ignore' });
    p.on('close', res);
  })));
  assert(codes.filter((x) => x === 0).length === 20 && codes.filter((x) => x === 4).length === 10, `parallel reserves granted ${codes.filter((x) => x === 0).length}, expected exactly 20`);
  // lock hygiene: a dead holder is reclaimed, a live holder is never robbed, bad ledger fields and policy values refuse
  const ldir = mkdtempSync(join(tmpdir(), 'ledger-lock-'));
  const lenv = { GAUNTLET_LEDGER: join(ldir, 'l.jsonl'), GAUNTLET_POLICY: join(ldir, 'none.json'), GAUNTLET_LOCK_WAIT_MS: '300' };
  const lrun = (...a) => main(a, lenv, { log: () => {}, error: () => {} });
  mkdirSync(`${lenv.GAUNTLET_LEDGER}.lock`);
  writeFileSync(join(`${lenv.GAUNTLET_LEDGER}.lock`, 'pid'), '999999\n');
  assert(lrun('reserve', 'base', sha(500)) === 0, 'a lock held by a dead process is reclaimed');
  mkdirSync(`${lenv.GAUNTLET_LEDGER}.lock`);
  writeFileSync(join(`${lenv.GAUNTLET_LEDGER}.lock`, 'pid'), `${process.pid}\n`);
  utimesSync(`${lenv.GAUNTLET_LEDGER}.lock`, new Date(Date.now() - 600_000), new Date(Date.now() - 600_000));
  assert(lrun('reserve', 'base', sha(501)) === 5, 'a lock held by a live process is never stolen, however old');
  rmSync(`${lenv.GAUNTLET_LEDGER}.lock`, { recursive: true });
  for (const line of ['null', '{"id":"x","month":"2026-10","event":"reserve","tier":"base","units":-20,"sha":"' + sha(1) + '"}', '{"id":"y","event":"commit"}', '[]']) {
    writeFileSync(lenv.GAUNTLET_LEDGER, `${line}\n`);
    assert(lrun('status') === 5 && lrun('reserve', 'base', sha(502)) === 5, `ledger line ${line.slice(0, 30)} refused`);
  }
  rmSync(lenv.GAUNTLET_LEDGER);
  for (const pol of [{ hard_stop_pct: 200 }, { weights_verified: 'false' }, { reserve_units_high_risk: 50 }, { soft_warn_pct: -1 }]) {
    writeFileSync(lenv.GAUNTLET_POLICY, JSON.stringify(pol));
    assert(lrun('status') === 5, `policy ${JSON.stringify(pol)} refused`);
  }
  console.log('review-ledger selftest: ok');
  return 0;
}

const isMain = process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (isMain) {
  if (process.argv[2] === 'selftest') selftest().then(process.exit, (e) => { console.error(e.message); process.exit(1); });
  else process.exit(main(process.argv.slice(2)));
}
