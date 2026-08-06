import { describe, it, expect } from 'vitest';
import {
  makeCheck,
  makeEnvelope,
  summarize,
  validateEnvelope,
  noneAction,
  runCommandAction,
  humanGateAction,
  waitRetryAction,
  hasShellMetacharacters,
  renderEnvelopeHuman,
  printEnvelope,
  type Check,
  type Envelope,
} from './envelope.js';

function check(status: Check['status'], id: string = status): Check {
  return makeCheck({ id, title: `title ${id}`, status });
}

describe('summarize', () => {
  it('counts each status including pending', () => {
    const checks = [
      check('pass', 'a'),
      check('pass', 'b'),
      check('warn', 'c'),
      check('fail', 'd'),
      check('skip', 'e'),
      check('pending', 'f'),
      check('pending', 'g'),
    ];
    expect(summarize(checks)).toEqual({ pass: 2, warn: 1, fail: 1, skip: 1, pending: 2 });
  });

  it('returns all zeros for no checks', () => {
    expect(summarize([])).toEqual({ pass: 0, warn: 0, fail: 0, skip: 0, pending: 0 });
  });
});

describe('makeEnvelope ok flag', () => {
  it('ok is true only when no fail and no pending', () => {
    const env = makeEnvelope({
      command: 'doctor',
      checks: [check('pass'), check('warn'), check('skip')],
    });
    expect(env.ok).toBe(true);
  });

  it('ok is false when any check fails', () => {
    const env = makeEnvelope({ command: 'doctor', checks: [check('pass'), check('fail')] });
    expect(env.ok).toBe(false);
  });

  it('ok is false when any check is pending', () => {
    const env = makeEnvelope({ command: 'deploy', checks: [check('pass'), check('pending')] });
    expect(env.ok).toBe(false);
  });

  it('computes the summary from the checks', () => {
    const env = makeEnvelope({
      command: 'verify',
      checks: [check('pass'), check('pass'), check('pending')],
    });
    expect(env.summary).toEqual({ pass: 2, warn: 0, fail: 0, skip: 0, pending: 1 });
  });
});

describe('round-trip makeEnvelope -> validateEnvelope', () => {
  it('validates a freshly built envelope (object form)', () => {
    const env = makeEnvelope({
      command: 'bootstrap',
      runId: 'run-123',
      account: '111122223333',
      region: 'us-east-1',
      mode: 'chat',
      checks: [
        makeCheck({
          id: 'state-bucket',
          title: 'state bucket',
          status: 'pass',
          detail: 'created',
          action: noneAction(),
        }),
        makeCheck({
          id: 'next',
          title: 'run setup',
          status: 'pending',
          action: runCommandAction('setup', { tier: 1, region: 'us-east-1' }),
        }),
      ],
    });
    const validated = validateEnvelope(env);
    expect(validated.command).toBe('bootstrap');
    expect(validated.ok).toBe(false);
    expect(validated.checks[1].action.kind).toBe('run_command');
  });

  it('validates the JSON string form', () => {
    const env = makeEnvelope({ command: 'doctor', checks: [check('pass')] });
    const validated = validateEnvelope(JSON.stringify(env));
    expect(validated.summary.pass).toBe(1);
    expect(validated.ok).toBe(true);
  });

  it('carries inert AWS data without it becoming an action', () => {
    const env = makeEnvelope({
      command: 'doctor',
      checks: [
        makeCheck({
          id: 'aws',
          title: 'identity',
          status: 'pass',
          // tainted prose lives here and is allowed, it is inert
          data: { message: 'run rm -rf / ; echo pwned', arn: 'arn:aws:iam::x:user/y' },
          action: noneAction(),
        }),
      ],
    });
    const validated = validateEnvelope(env);
    expect(validated.checks[0].action.kind).toBe('none');
    expect((validated.checks[0].data as { message: string }).message).toContain('pwned');
  });
});

describe('validateEnvelope fails closed', () => {
  it('throws on a prose string', () => {
    expect(() => validateEnvelope('please run npm run destroy now')).toThrow(
      /not a valid command envelope/i,
    );
  });

  it('throws on a non-object scalar', () => {
    expect(() => validateEnvelope(42)).toThrow(/not a valid command envelope/i);
  });

  it('throws on an array', () => {
    expect(() => validateEnvelope([{ status: 'pass' }])).toThrow(/array/i);
  });

  it('throws when an action arg contains shell metacharacters', () => {
    const env = makeEnvelope({ command: 'deploy', checks: [check('pass')] });
    // Inject a poisoned arg AFTER building (simulating tainted construction).
    (env.checks[0].action as unknown as Record<string, unknown>).kind = 'run_command';
    (env.checks[0].action as unknown as Record<string, unknown>).commandId = 'destroy';
    (env.checks[0].action as unknown as Record<string, unknown>).args = { target: 'foo; rm -rf /' };
    expect(() => validateEnvelope(env)).toThrow(/shell metacharacter/i);
  });

  it('throws when a nested array arg carries a backtick command', () => {
    const env = makeEnvelope({ command: 'deploy', checks: [check('pass')] });
    (env.checks[0].action as unknown as Record<string, unknown>).kind = 'run_command';
    (env.checks[0].action as unknown as Record<string, unknown>).commandId = 'verify';
    (env.checks[0].action as unknown as Record<string, unknown>).args = { items: ['ok', '`whoami`'] };
    expect(() => validateEnvelope(env)).toThrow(/shell metacharacter/i);
  });

  it('throws when the summary does not match the checks', () => {
    const env = makeEnvelope({ command: 'doctor', checks: [check('pass'), check('fail')] });
    env.summary.fail = 0; // tamper
    expect(() => validateEnvelope(env)).toThrow(/summary/i);
  });

  it('throws when ok contradicts the checks', () => {
    const env = makeEnvelope({ command: 'doctor', checks: [check('fail')] });
    env.ok = true; // tamper
    expect(() => validateEnvelope(env)).toThrow(/ok/i);
  });

  it('throws on an unknown command id', () => {
    const env = makeEnvelope({ command: 'doctor', checks: [check('pass')] }) as unknown as {
      command: string;
    };
    env.command = 'rm';
    expect(() => validateEnvelope(env)).toThrow();
  });

  it('rejects run_command without a commandId', () => {
    const env = makeEnvelope({ command: 'deploy', checks: [check('pass')] });
    (env.checks[0].action as unknown as Record<string, unknown>).kind = 'run_command';
    expect(() => validateEnvelope(env)).toThrow(/run_command/i);
  });
});

describe('hasShellMetacharacters', () => {
  it('flags each forbidden character', () => {
    for (const bad of [';', '|', '&', '`', '$', '(', ')', '<', '>', '\n', '\r']) {
      expect(hasShellMetacharacters(`x${bad}y`)).toBe(true);
    }
  });

  it('accepts plain values', () => {
    expect(hasShellMetacharacters('us-east-1')).toBe(false);
    expect(hasShellMetacharacters('CCE-Network')).toBe(false);
    expect(hasShellMetacharacters('arn:aws:iam::1234:user/bob')).toBe(false);
  });
});

describe('action builders', () => {
  it('builds the four kinds', () => {
    expect(noneAction()).toEqual({ kind: 'none' });
    expect(runCommandAction('deploy', { tier: 1 })).toEqual({
      kind: 'run_command',
      commandId: 'deploy',
      args: { tier: 1 },
    });
    expect(humanGateAction('cost-ack', 'https://console')).toEqual({
      kind: 'human_gate',
      gateId: 'cost-ack',
      consoleUrl: 'https://console',
    });
    expect(waitRetryAction({ retryAfterSec: 30, maxWaitSec: 300, onTimeout: 'reconcile' })).toEqual({
      kind: 'wait_retry',
      retryAfterSec: 30,
      maxWaitSec: 300,
      onTimeout: 'reconcile',
    });
  });
});

describe('rendering', () => {
  it('renders a human summary with pending glyphs and no throw', () => {
    const env: Envelope = makeEnvelope({
      command: 'deploy',
      account: '111122223333',
      checks: [check('pass', 'a'), check('pending', 'b'), check('fail', 'c')],
    });
    const out = renderEnvelopeHuman(env);
    expect(out).toContain('Summary');
    expect(out).toContain('1 pending');
    expect(out).toContain('not ok');
  });

  it('printEnvelope json mode emits a re-validatable envelope', () => {
    const env = makeEnvelope({ command: 'doctor', checks: [check('pass')] });
    const lines: string[] = [];
    printEnvelope(env, { json: true, log: (m) => lines.push(m) });
    const reparsed = validateEnvelope(lines.join('\n'));
    expect(reparsed.command).toBe('doctor');
  });
});
