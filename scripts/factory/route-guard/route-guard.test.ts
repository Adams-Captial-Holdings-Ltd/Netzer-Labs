// NZR-40: the 8 story scenarios against the route-guard CLI. Temp dirs per test, no network, no model.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const GUARD = join(__dirname, 'route-guard.mjs');
let dir: string;
const log = () => join(dir, 'routes.jsonl');
const consent = () => join(dir, 'consent.json');
const lines = () => readFileSync(log(), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

const run = (...args: string[]) => {
  const r = spawnSync('node', [GUARD, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GAUNTLET_ROUTES: log(), GAUNTLET_CONSENT: consent() },
  });
  return { code: r.status, out: r.stdout + r.stderr };
};
const check = (step: string, role: string, provider: string, session: string, model = 'm') =>
  run('check', '--slug', 't', '--step', step, '--role', role, '--provider', provider, '--model', model, '--session', session);
const yes = { nvidia: { terms_yes: true, ts: '2026-10-25T00:00:00Z', owner_text: 'yes, I read the terms' } };

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'nzr40-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('route-guard.mjs', () => {
  it('allows codex builder and fresh claude critic and prints the summary line', () => {
    run('jev', '--slug', 't', '--step', 'nzr-12.s1', '--question', 'model', '--choice', 'sol', '--confidence', '0.86');
    const b = check('nzr-12.s1', 'builder', 'codex', 'A', 'gpt-6-sol');
    const c = check('nzr-12.s1', 'critic', 'claude', 'B', 'opus');
    expect([b.code, c.code]).toEqual([0, 0]);
    expect(b.out).toContain('ROUTE OK');
    expect(lines().filter((l) => l.result).map((l) => l.result)).toEqual(['allowed', 'allowed']);
    const s = run('summary', '--slug', 't', '--step', 'nzr-12.s1');
    expect(s.code).toBe(0);
    expect(s.out.trim()).toBe('ROUTE: builder codex/gpt-6-sol (s:A) | critic claude/opus (s:B) | JEV: model -> sol (0.86)');
  });

  it('refuses an nvidia builder without consent and names the codex fallback', () => {
    const r = check('s', 'builder', 'nvidia', 'C');
    expect(r.code).toBe(4);
    expect(r.out).toContain("ROUTE REFUSED: nvidia needs the owner's yes on the NVIDIA free-tier terms (Q65)");
    expect(r.out).toContain('FALLBACK: codex/');
    expect(lines()[0]).toMatchObject({ result: 'refused', reason: 'no_nvidia_consent', fallback: 'codex' });
  });

  it('refuses an nvidia reviewer without consent and marks L3 NOT RUN', () => {
    const r = check('s', 'reviewer', 'nvidia', 'D');
    expect(r.code).toBe(4);
    expect(r.out).toContain("ROUTE REFUSED: nvidia needs the owner's yes");
    expect(r.out).toContain('LAYER: L3 NOT RUN (no owner yes on NVIDIA terms)');
    expect(r.out).not.toContain('FALLBACK');
  });

  it('refuses codex reviewing codex-built work and allows it on claude-built work', () => {
    check('x', 'builder', 'codex', 'A', 'gpt-6-sol');
    for (const role of ['reviewer', 'security']) {
      const r = check('x', role, 'codex', 'E');
      expect(r.code).toBe(4);
      expect(r.out).toContain('ROUTE REFUSED: codex built this step; codex may not review it (Q51)');
    }
    check('y', 'builder', 'claude', 'F', 'opus');
    expect(check('y', 'reviewer', 'codex', 'G').code).toBe(0);
  });

  it('refuses a reused, non-claude or premature critic', () => {
    const early = check('s', 'critic', 'claude', 'B');
    expect(early.code).toBe(4);
    expect(early.out).toContain('ROUTE REFUSED: no builder recorded for this step');
    check('s', 'builder', 'codex', 'A');
    const same = check('s', 'critic', 'claude', 'A');
    expect(same.code).toBe(4);
    expect(same.out).toContain('ROUTE REFUSED: critic session A also built this step');
    const cx = check('s', 'critic', 'codex', 'B');
    expect(cx.code).toBe(4);
    expect(cx.out).toContain('ROUTE REFUSED: the critic must be a fresh Claude session');
  });

  it('refuses a builder session that already criticised the step (order-independent separation)', () => {
    run('jev', '--slug', 't', '--step', 's', '--question', 'q', '--choice', 'c', '--confidence', '0.9');
    check('s', 'builder', 'codex', 'A');
    check('s', 'critic', 'claude', 'B');
    const r = check('s', 'builder', 'codex', 'B');
    expect(r.code).toBe(4);
    expect(r.out).toContain('ROUTE REFUSED: builder session B already criticised this step');
    expect(run('summary', '--slug', 't', '--step', 's').out).toContain('(s:A) | critic claude/m (s:B)');
  });

  it('consent allows advisory nvidia review but not nvidia builds', () => {
    writeFileSync(consent(), JSON.stringify(yes));
    const b = check('s', 'builder', 'nvidia', 'C');
    expect(b.code).toBe(4);
    expect(b.out).toContain('ROUTE REFUSED: nvidia builders need a passed bake-off (Q65)');
    expect(b.out).toContain('FALLBACK: codex/');
    const r = check('s', 'reviewer', 'nvidia', 'D');
    expect(r.code).toBe(0);
    expect(r.out).toContain('ROUTE OK (advisory until bake-off qualifies)');
  });

  it('corrupt consent or log refuses; bad flags are usage errors', () => {
    writeFileSync(consent(), '{not json');
    const c = check('s', 'builder', 'codex', 'A');
    expect(c.code).toBe(5);
    expect(c.out).toContain(`ROUTE NOT CHECKED: ${consent()} is unreadable; fix it by hand`);
    rmSync(consent());
    writeFileSync(log(), 'garbage\n');
    const l = check('s', 'builder', 'codex', 'A');
    expect(l.code).toBe(5);
    expect(l.out).toContain(`ROUTE NOT CHECKED: ${log()} is unreadable`);
    expect(readFileSync(log(), 'utf8')).toBe('garbage\n');
    expect(check('s', 'wizard', 'codex', 'A').code).toBe(2);
    expect(check('s', 'builder', 'gemini', 'A').code).toBe(2);
  });

  it('records an advisor pick when Jev is down and flags a step with no pick', () => {
    check('s', 'builder', 'codex', 'A', 'gpt-6-sol');
    check('s', 'critic', 'claude', 'B', 'opus');
    const miss = run('summary', '--slug', 't', '--step', 's');
    expect(miss.code).toBe(4);
    expect(miss.out).toContain('MISSING: no Jev or advisor pick recorded');
    expect(run('jev', '--slug', 't', '--step', 's', '--unavailable', '--advisor', 'sonnet', '--answer', 'sol').code).toBe(0);
    const s = run('summary', '--slug', 't', '--step', 's');
    expect(s.code).toBe(0);
    expect(s.out).toContain('JEV: unavailable -> advisor (sonnet): sol');
  });

  it('competing processes recovering one abandoned lock never both pass the separation rule', async () => {
    const deadPid = spawnSync('node', ['-e', '']).pid;
    const go = (args: string[]) => new Promise<number | null>((res) => {
      spawn('node', [GUARD, ...args], { env: { ...process.env, GAUNTLET_ROUTES: log(), GAUNTLET_CONSENT: consent() }, stdio: 'ignore' }).on('close', res);
    });
    const c = (role: string, provider: string, session: string) =>
      ['check', '--slug', 't', '--step', 's', '--role', role, '--provider', provider, '--model', 'm', '--session', session];
    for (let round = 0; round < 10; round++) {
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir);
      check('s', 'builder', 'codex', 'Z');
      mkdirSync(`${log()}.lock`);
      writeFileSync(join(`${log()}.lock`, 'pid'), `${deadPid}\n`);
      // 6 critics + 6 builders all on session X; serial order allows at most one side of the pair.
      await Promise.all(Array.from({ length: 6 }, () => [go(c('critic', 'claude', 'X')), go(c('builder', 'codex', 'X'))]).flat());
      const ok = lines().filter((l) => l.session === 'X' && l.result === 'allowed').map((l) => l.role);
      expect(new Set(ok).size, `round ${round}: ${ok.join(',')}`).toBeLessThanOrEqual(1);
    }
  }, 60_000);

  it('selftest passes', () => {
    expect(run('selftest').code).toBe(0);
  });
});
