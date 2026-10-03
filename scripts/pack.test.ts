/** Frozen acceptance tests for the `pack` CLI (Work Platform step 3, gate s3-proof). */
import { afterAll, describe, expect, it } from 'vitest';
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
