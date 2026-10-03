/** Frozen acceptance tests for the `pack` CLI (Work Platform step 3, gate s3-proof). */
import { afterAll, describe, expect, it, vi } from 'vitest';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPackCli } from './pack.js';

const VALID = join(dirname(fileURLToPath(import.meta.url)), '../tests/fixtures/packs/valid');
const scratch = mkdtempSync(join(tmpdir(), 'pack-cli-test-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function run(argv: string[]): { code: number; lines: string[] } {
  const lines: string[] = [];
  const code = runPackCli(argv, (line) => lines.push(line));
  return { code, lines };
}
function badPack(): string {
  const dir = join(scratch, 'bad');
  cpSync(VALID, dir, { recursive: true });
  const file = join(dir, 'paperclip/routines/intake.json');
  writeFileSync(file, readFileSync(file, 'utf8').replace('always_enqueue', 'skip_if_active'));
  return dir;
}

describe('pack CLI', () => {
  it('S3-C12 exits 0 and says the pack is valid', () => {
    const r = run(['validate', VALID]);
    expect(r.code).toBe(0);
    expect(r.lines.join('\n')).toMatch(/valid/i);
  });
  it('S3-C12 exits 1 and prints one finding per line as "<code> <file> <message>"', () => {
    const r = run(['validate', badPack()]);
    expect(r.code).toBe(1);
    expect(r.lines.some((l) => /^PV-ENQUEUE paperclip\/routines\/intake\.json\S* .+/.test(l))).toBe(true);
  });
  it('S3-C12 exits 2 with usage when no command, an unknown command or no directory is given', () => {
    for (const argv of [[], ['install', VALID], ['validate']]) {
      const r = run(argv);
      expect(r.code).toBe(2);
      expect(r.lines.join('\n')).toMatch(/usage/i);
    }
  });
  it('S3-C12 exits 2 when the denylist file cannot be read', () => {
    expect(run(['validate', VALID, '--denylist', join(scratch, 'none.txt')]).code).toBe(2);
  });
  it('S3-C14 applies --denylist entries', () => {
    const deny = join(scratch, 'deny.txt');
    writeFileSync(deny, '# customers\nExample Referrals\n');
    const r = run(['validate', VALID, '--denylist', deny]);
    expect(r.code).toBe(1);
    expect(r.lines.some((l) => l.startsWith('PV-IDENTIFIER '))).toBe(true);
  });
  it('S3-C12 is wired as `npm run pack`', () => {
    const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../package.json'), 'utf8'));
    expect(pkg.scripts.pack).toBe('tsx scripts/pack.ts');
  });
});

describe('pack effect', () => {
  const key = { caseKey: 'case-1', stage: 'intake', step: 'write', stageEntryNo: 2 };
  const row = { kind: 'effect' as const, key, state: 'unknown' as const, payloadHash: 'secret-hash',
    result: 'secret-result', issueId: 'issue-1', version: 1, createdAt: 0, updatedAt: 1_750_000_000_000 };
  function fake() {
    return { listUnknown: vi.fn(async () => [row]), resolve: vi.fn(async () => {}) };
  }
  async function runEffect(argv: string[], executor: ReturnType<typeof fake>) {
    const lines: string[] = [];
    const code = await runPackCli(argv, (line) => lines.push(line), { executor });
    return { code, lines };
  }

  it('effect list prints IDs only and no result text', async () => {
    const executor = fake();
    const output = await runEffect(['effect', 'list'], executor);
    expect(output.code).toBe(0);
    expect(output.lines).toEqual([`case-1 intake write 2 ${new Date(row.updatedAt).toISOString()} issue-1`]);
    expect(output.lines.join(' ')).not.toContain('secret');
    executor.listUnknown.mockResolvedValueOnce([]);
    expect((await runEffect(['effect', 'list'], executor)).lines).toEqual(['No unknown effects']);
  });

  it('effect resolve applied calls the executor with parsed key and user', async () => {
    const executor = fake();
    const output = await runEffect(['effect', 'resolve', 'case-1', 'intake', 'write', '2', '--applied', '--by', 'user-1'], executor);
    expect(output.code).toBe(0);
    expect(output.lines).toHaveLength(1);
    expect(executor.resolve).toHaveBeenCalledWith(key, 'applied', 'user-1');
  });

  it('effect resolve not applied passes the other outcome', async () => {
    const executor = fake();
    expect((await runEffect(['effect', 'resolve', 'case-1', 'intake', 'write', '2', '--not-applied', '--by', 'user-1'], executor)).code).toBe(0);
    expect(executor.resolve).toHaveBeenCalledWith(key, 'not_applied', 'user-1');
  });

  it('effect resolve executor error exits 1 without leaking its message', async () => {
    const executor = fake();
    executor.resolve.mockRejectedValueOnce(Object.assign(new Error('private details'), { name: 'EffectUnknownError' }));
    expect(await runEffect(['effect', 'resolve', 'case-1', 'intake', 'write', '2', '--applied', '--by', 'user-1'], executor))
      .toEqual({ code: 1, lines: ['EffectUnknownError'] });
  });

  it('effect resolve bad arguments exit 2 and never call resolve', async () => {
    const executor = fake();
    const args = ['effect', 'resolve', 'case-1', 'intake', 'write', '2'];
    for (const suffix of [[], ['--applied'], ['--applied', '--not-applied', '--by', 'user-1'],
      ['--applied', '--by'], ['--applied', '--by', 'user-1', 'extra']]) {
      const output = await runEffect([...args, ...suffix], executor);
      expect(output.code).toBe(2);
      expect(output.lines).toHaveLength(1);
      expect(output.lines[0]).toMatch(/^Usage:/);
    }
    expect((await runEffect(['effect', 'resolve', 'case-1', 'intake', 'write', '0', '--applied', '--by', 'user-1'], executor)).code).toBe(2);
    expect(executor.resolve).not.toHaveBeenCalled();
  });
});
