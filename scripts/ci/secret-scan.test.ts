/**
 * Self-test for scripts/ci/secret-scan.mjs (IaC readiness plan, item 29).
 *
 * Exercises the real CLI as a child process (the exact thing CI runs), so
 * exit codes, file:line output, and denylist plumbing are all covered. The
 * fake AWS key below is AWS's own documented example key, never a live
 * credential.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, 'secret-scan.mjs');

const dir = mkdtempSync(join(tmpdir(), 'secret-scan-test-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function runScan(args: string[]): { code: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  return { code: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

function fixture(name: string, content: string): string {
  const file = join(dir, name);
  writeFileSync(file, content);
  return file;
}

describe('secret-scan CLI', () => {
  it('flags a fake AWS access key id with file:line', () => {
    // AWS's documented example access key id, split so the publish-time
    // history scan never trips on this test file itself.
    const fakeKey = 'AKIA' + 'IOSFODNN7EXAMPLE';
    const file = fixture('akia.txt', `first line\nkey = ${fakeKey}\n`);
    const r = runScan([file]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('aws-access-key-id');
    expect(r.stderr).toContain(':2:'); // hit reported on line 2
  });

  it('passes clean text', () => {
    const file = fixture(
      'clean.txt',
      'Resources:\n  S3Key: asset.0123456789abcdef.zip\n  nothing secret here\n',
    );
    const r = runScan([file]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('clean');
  });

  it('flags a denylist literal (case-insensitive)', () => {
    const deny = fixture('deny.txt', '# comment line\nMy-Personal-Domain.example\n');
    const file = fixture('denyhit.txt', 'see https://my-personal-domain.example/path\n');
    const r = runScan(['--denylist', deny, file]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('denylist-literal');
  });

  it('flags Slack, Telegram, and PEM shapes', () => {
    const file = fixture(
      'shapes.txt',
      [
        'slack: xoxb-0000000000-111111111111-fakefakefakefake',
        'tg: 123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        '-----BEGIN RSA PRIVATE KEY-----',
      ].join('\n') + '\n',
    );
    const r = runScan([file]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('slack-token');
    expect(r.stderr).toContain('telegram-bot-token');
    expect(r.stderr).toContain('pem-private-key');
  });

  it('does not false-positive on cdk.out asset hashes (S3Key etc.)', () => {
    const file = fixture(
      'cdkout.json',
      JSON.stringify({
        S3Key: '56f7467bbde8a5efebcf57ae9e460027607099bab9f844669dcf5d800172ee5a.zip',
        sourceHash: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      }),
    );
    const r = runScan([file]);
    expect(r.code).toBe(0);
  });

  it('ignores placeholder-valued secret-named env entries but flags real ones', () => {
    const placeholder = fixture(
      'taskdef-placeholder.json',
      '{"name": "TAVILY_API_KEY", "value": "REPLACE_ME_AT_DEPLOY_TIME"}',
    );
    expect(runScan([placeholder]).code).toBe(0);

    const real = fixture(
      'taskdef-real.json',
      '{"name": "TAVILY_API_KEY", "value": "tvly-abcdefghijklmnopqrstuv"}',
    );
    const r = runScan([real]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('ecs-env-secret-value');
  });

  it('exits 2 on usage errors', () => {
    expect(runScan([]).code).toBe(2);
    expect(runScan(['--bogus', dir]).code).toBe(2);
  });
});
