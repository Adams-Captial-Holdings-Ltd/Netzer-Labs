// NZR-41: scenarios 1-5 and 7 against the review-plan CLI, scenario 6 against the ledger selftest, scenario 5 also
// against the shipped policy file. Temp dirs per test, no network, no review tool, fake shas only.
import { spawnSync } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const PLAN = join(__dirname, 'review-plan.mjs');
const LEDGER = join(__dirname, '..', 'review-ledger', 'review-ledger.mjs');
const POLICY = join(__dirname, '..', 'review-ledger', 'gauntlet-review-policy.json');
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
let dir: string;

const exec = (script: string, args: string[], env: Record<string, string> = {}) => {
  const r = spawnSync('node', [script, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
  return { code: r.status, out: r.stdout + r.stderr };
};
const plan = (tier: string) => exec(PLAN, ['plan', '--tier', tier]);
const verify = (tier: string, lines: string[]) => {
  const log = join(dir, 'step.log');
  writeFileSync(log, `${lines.join('\n')}\n`);
  return exec(PLAN, ['verify', '--tier', tier, '--log', log]);
};
const sends = () => join(dir, 'sends.jsonl');
const sendCheck = (layer: string, step: string, sha: string) =>
  exec(PLAN, ['send-check', '--layer', layer, '--step', step, '--sha', sha], { GAUNTLET_SENDS: sends() });
const r = (layer: string, status = 'ran', sha = A, extra = '') => `REVIEW: ${layer} ${status} ${sha}${extra}`;
const t3 = (over: Record<string, string> = {}) => [
  r('L0'), r('critic'), r('step-maid'), r('L1'),
  over.L2 ?? r('L2'),
  over.L3 ?? r('L3', 'NOT RUN (no owner yes on NVIDIA terms)'),
  r('L4'), r('L5'),
  over.L6 ?? r('L6', 'ran', A, ' ledger=x1'),
];

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'nzr41-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('review-plan.mjs', () => {
  it('T2 plan excludes paid and third-party layers and verify rejects a Greptile run', () => {
    const p = plan('T2');
    expect(p.code).toBe(0);
    expect(JSON.parse(p.out)).toEqual({ tier: 'T2', required: ['L0', 'critic', 'step-maid'], forbidden: ['L1', 'L2', 'L3', 'L6'] });
    const bad = verify('T2', [r('L0'), r('critic'), r('step-maid'), r('L6')]);
    expect(bad.code).toBe(1);
    expect(bad.out).toContain('FORBIDDEN LAYER RAN: L6 greptile');
    expect(verify('T2', [r('L0'), r('critic'), r('step-maid')]).code).toBe(0);
  });

  it('T1 and docs require L0 only', () => {
    for (const tier of ['T1', 'docs']) {
      const p = JSON.parse(plan(tier).out);
      expect(p.required).toEqual(['L0']);
      expect(p.forbidden).toEqual(expect.arrayContaining(['L1', 'L2', 'L3', 'L6']));
      expect(verify(tier, [r('L0')]).code).toBe(0);
      const none = verify(tier, ['unrelated line']);
      expect(none.code).toBe(1);
      expect(none.out).toContain('MISSING LAYER: L0');
    }
    expect(plan('T9').code).toBe(2);
  });

  it('T3 requires all layers and exactly one Greptile pass on the final sha', () => {
    const ok = verify('T3', t3());
    expect(ok.code).toBe(0);
    expect(ok.out).toContain('TIER OK T3 (L3 NOT RUN: allowed exception)');
    expect(verify('T3', t3({ L2: 'REVIEW: L2 skipped (not substantial) ' + A })).code).toBe(0);
    const two = verify('T3', [...t3(), r('L6', 'ran', A, ' ledger=x2')]);
    expect(two.code).toBe(1);
    expect(two.out).toContain('GREPTILE PASSES: 2 (T3 allows 1)');
    const moved = verify('T3', t3({ L6: r('L6', 'ran', B, ' ledger=x1') }));
    expect(moved.code).toBe(1);
    expect(moved.out).toContain('GREPTILE SHA != FINAL SHA');
    expect(verify('T3', t3().filter((l) => !l.includes(' L4 '))).out).toContain('MISSING LAYER: L4');
    const junk = verify('T3', [...t3(), 'REVIEW: L1 maybe']);
    expect(junk.code).toBe(1);
    expect(junk.out).toContain('UNPARSEABLE');
  });

  it('kodus, coderabbit and greptile sends need a single-use per-run yes', () => {
    for (const layer of ['kodus', 'coderabbit', 'greptile']) {
      const ask = sendCheck(layer, 'nzr-5.s1', A);
      expect(ask.code).toBe(4);
      expect(ask.out).toContain(`ASK OWNER: ${layer} would send Netzer-Labs@${A.slice(0, 12)} (diff vs origin/development)`);
      expect(ask.out).toContain('Reply yes for this run only.');
    }
    expect(sendCheck('kodus', 'nzr-5.s1', A).out).toContain("to Kodus' service.");
    appendFileSync(sends(), `${JSON.stringify({ layer: 'kodus', step: 'nzr-5.s1', sha: A, owner_text: 'yes kodus this run' })}\n`);
    expect(sendCheck('kodus', 'nzr-5.s1', B).code).toBe(4); // other sha
    expect(sendCheck('coderabbit', 'nzr-5.s1', A).code).toBe(4); // other layer
    expect(sendCheck('kodus', 'nzr-5.s2', A).code).toBe(4); // other step
    const first = sendCheck('kodus', 'nzr-5.s1', A);
    expect(first.code).toBe(0);
    expect(first.out).toContain('SEND OK');
    const again = sendCheck('kodus', 'nzr-5.s1', A);
    expect(again.code).toBe(4);
    expect(again.out).toContain('yes already used');
    appendFileSync(sends(), `${JSON.stringify({ layer: 'greptile', step: 'nzr-5.s1', sha: A, owner_text: 'no' })}\n`);
    expect(sendCheck('greptile', 'nzr-5.s1', A).code).toBe(4); // not a yes
    expect(exec(PLAN, ['send-check', '--layer', 'other', '--step', 's', '--sha', A], { GAUNTLET_SENDS: sends() }).code).toBe(2);
    expect(exec(PLAN, ['send-check', '--layer', 'kodus', '--step', 's', '--sha', 'abc'], { GAUNTLET_SENDS: sends() }).code).toBe(2);
  });

  it('a used yes stays used when the sends file is rewritten; only a leading yes counts; slug is validated', () => {
    const rec = JSON.stringify({ layer: 'kodus', step: 's1', sha: A, owner_text: 'yes kodus this run', id: 'consent-0002' });
    writeFileSync(sends(), `${rec}\n`);
    expect(sendCheck('kodus', 's1', A).code).toBe(0);
    writeFileSync(sends(), `{"junk":1}\n${rec}\n`); // record moves to another line index
    expect(sendCheck('kodus', 's1', A).code).toBe(4);
    // same consent id, reordered properties and different spacing: still the used yes
    writeFileSync(sends(), `{ "id": "consent-0002",  "owner_text": "yes kodus this run", "sha": "${A}", "step": "s1", "layer": "kodus" }\n`);
    expect(sendCheck('kodus', 's1', A).code).toBe(4);
    // a yes without a consent id is not consent
    writeFileSync(sends(), `${JSON.stringify({ layer: 'kodus', step: 's1', sha: A, owner_text: 'yes kodus this run' })}\n`);
    expect(sendCheck('kodus', 's1', A).code).toBe(4);
    for (const text of ['not yes', 'yes?', 'no, yes later']) {
      writeFileSync(sends(), `${JSON.stringify({ layer: 'greptile', step: 's1', sha: A, owner_text: text })}\n`);
      expect(sendCheck('greptile', 's1', A).code).toBe(4);
    }
    for (const slug of ['../x', 'a/b', '..', 'a\\b']) {
      const res = exec(PLAN, ['send-check', '--layer', 'kodus', '--step', 's', '--sha', A, '--slug', slug], { GAUNTLET_SENDS: sends() });
      expect(res.code).toBe(2);
    }
  });

  it('only "skipped (not substantial)" excuses L2; other skip reasons fail the tier', () => {
    const bad = verify('T3', t3({ L2: `REVIEW: L2 skipped (coderabbit signed out) ${A}` }));
    expect(bad.code).toBe(1);
    expect(bad.out).toContain('UNSUPPORTED SKIP: L2');
    expect(bad.out).not.toContain('TIER OK');
    const other = verify('T3', t3().map((l) => (l.startsWith('REVIEW: L4 ') ? `REVIEW: L4 skipped (not substantial) ${A}` : l)));
    expect(other.code).toBe(1);
    expect(other.out).toContain('UNSUPPORTED SKIP: L4');
  });

  it('required layers must sit on the final L0 sha, skips and NOT RUN included', () => {
    const t2 = verify('T2', [r('L0', 'ran', A), r('critic', 'ran', A), r('step-maid', 'ran', A), r('L0', 'ran', B)]);
    expect(t2.code).toBe(1);
    expect(t2.out).toContain('STALE LAYER: critic');
    expect(t2.out).toContain('STALE LAYER: step-maid');
    expect(t2.out).not.toContain('TIER OK');
    for (const [layer, line] of [
      ['L1', r('L1', 'ran', A)],
      ['L2', `REVIEW: L2 skipped (not substantial) ${A}`],
      ['L3', r('L3', 'NOT RUN (no owner yes on NVIDIA terms)', A)],
      ['L4', r('L4', 'ran', A)],
    ]) {
      const res = verify('T3', [...t3().map((l) => (l.startsWith(`REVIEW: ${layer} `) ? line : l)), r('L0', 'ran', B)]);
      expect(res.code).toBe(1);
      expect(res.out).toContain(`STALE LAYER: ${layer}`);
    }
  });

  it('a later L0 that did not run on a newer sha fails verify instead of passing on the stale sha', () => {
    for (const status of ['NOT RUN (typecheck broke)', 'skipped (not needed)']) {
      const t1 = verify('T1', [r('L0', 'ran', A), r('L0', status, B)]);
      expect(t1.code).not.toBe(0);
      expect(t1.out).not.toContain('TIER OK');
      const t3res = verify('T3', [...t3(), r('L0', status, B)]);
      expect(t3res.code).not.toBe(0);
      expect(t3res.out).not.toContain('TIER OK');
    }
  });

  it('T3 needs ledger=<id> on the ran L6 line', () => {
    const res = verify('T3', t3({ L6: r('L6', 'ran', A) }));
    expect(res.code).toBe(1);
    expect(res.out).toContain('GREPTILE LEDGER ID MISSING');
  });

  it('a NOT RUN required layer makes a T3 step INCOMPLETE, not PASS', () => {
    const lines = t3().map((l) => (l.startsWith('REVIEW: L1 ') ? r('L1', 'NOT RUN (kodus signed out)') : l));
    const res = verify('T3', lines);
    expect(res.code).toBe(2);
    expect(res.out).toContain('INCOMPLETE: L1 NOT RUN');
    expect(res.out).not.toContain('TIER OK');
  });
});

describe('ledger policy and step rule', () => {
  const env = () => ({ GAUNTLET_LEDGER: join(dir, 'l.jsonl'), GAUNTLET_POLICY: join(dir, 'p.json') });
  const sha = (n: number) => n.toString(16).padStart(40, 'c');

  it('policy file: warn at 35, stop at 45', () => {
    copyFileSync(POLICY, env().GAUNTLET_POLICY);
    const month = new Date().toISOString().slice(0, 7);
    writeFileSync(env().GAUNTLET_LEDGER, `${JSON.stringify({ id: 'seed', month, event: 'reserve', tier: 'base', units: 34, sha: sha(1) })}\n`);
    const res = (n: number) => exec(LEDGER, ['reserve', 'base', sha(n)], env());
    const at35 = res(2);
    expect(at35.code).toBe(0);
    expect(at35.out).toContain('soft warning: 35/50 units after this review');
    for (let n = 3; n <= 11; n++) expect(res(n).code).toBe(0); // 36..44
    expect(res(12).code).toBe(0); // 45
    const over = res(13);
    expect(over.code).toBe(4);
    expect(over.out).toContain('NOT RUN: hard stop: 45+1 > 45 units this month');
  });

  it('one Greptile reserve per step unless --reason', () => {
    copyFileSync(POLICY, env().GAUNTLET_POLICY);
    expect(exec(LEDGER, ['reserve', 'base', sha(1), '--step', 'nzr-5.s1'], env()).code).toBe(0);
    const second = exec(LEDGER, ['reserve', 'base', sha(2), '--step', 'nzr-5.s1'], env());
    expect(second.code).toBe(4);
    expect(second.out).toContain('NOT RUN: step nzr-5.s1 already had a paid review this month; a second needs --reason');
    expect(exec(LEDGER, ['reserve', 'base', sha(2), '--step', 'nzr-5.s1', '--reason', 'owner yes: rerun after blocker fix'], env()).code).toBe(0);
  });

  it('racing processes recovering one abandoned lock never overspend the budget', async () => {
    const { spawn } = await import('node:child_process');
    const { mkdirSync } = await import('node:fs');
    for (let round = 0; round < 6; round++) {
      const e = { ...process.env, GAUNTLET_LEDGER: join(dir, `r${round}.jsonl`), GAUNTLET_POLICY: join(dir, `r${round}.json`), GAUNTLET_TEST_DELAY_MS: '50', GAUNTLET_SELFTEST: '1' };
      writeFileSync(e.GAUNTLET_POLICY, JSON.stringify({ monthly_units: 4, reserve_units_high_risk: 0 }));
      mkdirSync(`${e.GAUNTLET_LEDGER}.lock`);
      writeFileSync(join(`${e.GAUNTLET_LEDGER}.lock`, 'pid'), '999999\n'); // dead holder
      const codes = await Promise.all(Array.from({ length: 12 }, (_, i) => new Promise<number | null>((res) => {
        spawn('node', [LEDGER, 'reserve', 'base', sha(i + 1)], { env: e, stdio: 'ignore' }).on('close', res);
      })));
      expect(codes.filter((c) => c === 0).length).toBe(4);
    }
  }, 60_000);

  it('ledger selftest passes with the new step assertion', () => {
    const s = exec(LEDGER, ['selftest']);
    expect(s.out).toContain('review-ledger selftest: ok');
    expect(s.code).toBe(0);
    expect(existsSync(POLICY)).toBe(true);
    expect(JSON.parse(readFileSync(POLICY, 'utf8'))).toMatchObject({ hard_stop_pct: 90, soft_warn_pct: 70, reserve_units_high_risk: 0 });
  }, 30_000); // selftest spawns 30 racing processes; the 5s default flakes under the full suite
});
