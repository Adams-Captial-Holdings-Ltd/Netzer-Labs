import { describe, expect, it, vi } from 'vitest';
import { options, resolveShadowResources, runShadowCli } from './paperclip-shadow.js';
import { ShadowAuditError, ShadowCommandError } from './lib/paperclip/shadow-core.js';

const fakeCore = () => ({
  pool: vi.fn(async () => {}), assign: vi.fn(async () => {}), rotate: vi.fn(async () => {}),
  retire: vi.fn(async () => {}), check: vi.fn(async () => true), probe: vi.fn(async () => false),
  list: vi.fn(async () => {}),
});
const run = async (argv: string[], core = fakeCore()) => {
  const lines: string[] = [];
  const code = await runShadowCli(argv, (line) => lines.push(line), { env: { CCE_NAME_SUFFIX: 'staging' }, core });
  return { code, lines, core };
};

describe('shadow command line', () => {
  it('accepts each command and a valid size', () => {
    expect(options(['pool'])).toEqual({ command: 'pool', size: 25 });
    expect(options(['--env=staging', 'pool', '--size', '5'])).toEqual({ command: 'pool', size: 5 });
    expect(options(['assign', '--user', 'u', '--name', 'N', '--classes', 'a,b'])).toEqual({
      command: 'assign', user: 'u', name: 'N', classes: ['a', 'b'],
    });
    for (const command of ['rotate', 'retire']) expect(options([command, '--user', 'u'])).toEqual({ command, user: 'u' });
    for (const command of ['check', 'probe', 'list']) expect(options([command])).toEqual({ command });
  });
  it.each([['pool', '--size', '05'], ['pool', '--size', '0'], ['pool', '--size', '100'],
    ['pool', '--size', '1.5'], ['pool', '--unknown'], ['assign', '--user', 'u', '--name', 'N', '--classes', 'a,,b']])(
    'refuses invalid arguments %j', (...argv) => { expect(() => options(argv)).toThrow('Usage:'); });
  it('resolves the right tables and secret names with and without a suffix', () => {
    expect(resolveShadowResources()).toMatchObject({ users: 'claudeclaw-users', audit: 'claudeclaw-audit-log',
      keys: '/claudeclaw/shadow-approvers', setup: '/claudeclaw/shadow-approvers-setup' });
    expect(resolveShadowResources('staging')).toMatchObject({ users: 'claudeclaw-staging-users',
      audit: 'claudeclaw-staging-audit-log', keys: '/claudeclaw-staging/shadow-approvers',
      setup: '/claudeclaw-staging/shadow-approvers-setup' });
  });
  it('returns success, failure, and usage exit codes', async () => {
    expect((await run(['list'])).code).toBe(0);
    expect((await run(['unknown'])).code).toBe(2);
    const core = fakeCore(); core.list.mockRejectedValueOnce(new ShadowCommandError('wrong state'));
    const failed = await run(['list'], core);
    expect(failed.code).toBe(1);
    expect(failed.lines.at(-1)).toBe('list ShadowCommandError: wrong state');
    expect((await run(['list'], core)).code).toBe(0);
  });
  it('uses probe and check verdicts as exit codes', async () => {
    const core = fakeCore();
    expect((await run(['probe'], core)).code).toBe(1);
    expect((await run(['check'], core)).code).toBe(0);
    core.check.mockResolvedValueOnce(false);
    expect((await run(['check'], core)).code).toBe(1);
  });
  it('reports completed work with a missing audit row exactly', async () => {
    const core = fakeCore(); core.assign.mockRejectedValueOnce(new ShadowAuditError('assign', 'ServiceError'));
    const result = await run(['assign', '--user', 'u', '--name', 'N', '--classes', 'money'], core);
    expect(result.code).toBe(1);
    expect(result.lines.at(-1)).toBe('assign done; the audit row was NOT written (ServiceError)');
  });
  it('hides a foreign error message and shows its HTTP status', async () => {
    const core = fakeCore();
    const error = Object.assign(new Error('secret@netzer.invalid password key'), {
      name: 'AwsError', $metadata: { httpStatusCode: 503 },
    });
    core.list.mockRejectedValueOnce(error);
    const result = await run(['list'], core);
    expect(result.lines.at(-1)).toBe('list AwsError HTTP 503');
  });
});
