import { describe, it, expect } from 'vitest';
import { makeCheck, makeEnvelope, type Check, type CommandId, type Status } from './lib/envelope/envelope.js';
import {
  CHECK_ISOLATION,
  CHECK_ACCOUNT_PROFILE,
  CHECK_CREDENTIAL_GUARD,
  CHECK_TRIPWIRE,
  CHECK_STATE_PRIMITIVES,
} from './bootstrap.js';
import {
  extractEnvelope,
  classifyStep,
  decideTier1,
  BOOTSTRAP_READONLY_GATE_IDS,
  BOOTSTRAP_PROVISIONING_IDS,
} from './tier1-validate.js';

function check(id: string, status: Status): Check {
  return makeCheck({ id, title: id, status });
}
function envelope(command: CommandId, checks: Check[]): string {
  return JSON.stringify(makeEnvelope({ command, checks }));
}

describe('extractEnvelope', () => {
  it('parses a clean envelope', () => {
    const s = envelope('doctor', [check('aws-identity', 'pass')]);
    expect(extractEnvelope(s).command).toBe('doctor');
  });

  it('parses an envelope preceded by a prose line (e.g. early-win answer)', () => {
    const s = 'Claude answered: hello there\n' + envelope('early-win', [check('early-win-bedrock-turn', 'pass')]);
    expect(extractEnvelope(s).command).toBe('early-win');
  });

  it('throws (fail closed) on prose-only output', () => {
    expect(() => extractEnvelope('everything is fine, trust me')).toThrow(/no valid command envelope/i);
  });

  it('throws on an empty string', () => {
    expect(() => extractEnvelope('')).toThrow(/no valid command envelope/i);
  });
});

describe('classifyStep', () => {
  it('doctor: all pass => gate ok', () => {
    const env = makeEnvelope({ command: 'doctor', checks: [check('a', 'pass'), check('b', 'warn')] });
    const v = classifyStep('doctor', env);
    expect(v.ok).toBe(true);
    expect(v.blocking).toEqual([]);
  });

  it('doctor: a fail blocks', () => {
    const env = makeEnvelope({ command: 'doctor', checks: [check('bedrock', 'fail')] });
    expect(classifyStep('doctor', env).ok).toBe(false);
  });

  it('doctor: a pending blocks', () => {
    const env = makeEnvelope({ command: 'doctor', checks: [check('bedrock', 'pending')] });
    expect(classifyStep('doctor', env).ok).toBe(false);
  });

  it('early-win: pass => ok', () => {
    const env = makeEnvelope({ command: 'early-win', checks: [check('early-win-bedrock-turn', 'pass')] });
    expect(classifyStep('early-win', env).ok).toBe(true);
  });

  it('bootstrap: read-only gates pass + provisioning pending => ok, provisioning deferred', () => {
    const env = makeEnvelope({
      command: 'bootstrap',
      checks: [
        check(CHECK_ISOLATION, 'pass'),
        check(CHECK_ACCOUNT_PROFILE, 'pass'),
        check(CHECK_CREDENTIAL_GUARD, 'pass'),
        check(CHECK_TRIPWIRE, 'pending'),
        check(CHECK_STATE_PRIMITIVES, 'pending'),
      ],
    });
    const v = classifyStep('bootstrap', env);
    expect(v.ok).toBe(true);
    expect(v.deferred.map((d) => d.id).sort()).toEqual([CHECK_STATE_PRIMITIVES, CHECK_TRIPWIRE].sort());
    expect(v.blocking).toEqual([]);
  });

  it('bootstrap: a read-only gate failing (not-empty account) BLOCKS', () => {
    const env = makeEnvelope({
      command: 'bootstrap',
      checks: [check(CHECK_ISOLATION, 'fail'), check(CHECK_ACCOUNT_PROFILE, 'pass'), check(CHECK_TRIPWIRE, 'pending')],
    });
    const v = classifyStep('bootstrap', env);
    expect(v.ok).toBe(false);
    expect(v.blocking.map((b) => b.id)).toContain(CHECK_ISOLATION);
  });

  it('bootstrap: a provisioning check that FAILS (not merely pending) blocks', () => {
    const env = makeEnvelope({
      command: 'bootstrap',
      checks: [check(CHECK_ISOLATION, 'pass'), check(CHECK_ACCOUNT_PROFILE, 'pass'), check(CHECK_CREDENTIAL_GUARD, 'pass'), check(CHECK_TRIPWIRE, 'fail')],
    });
    expect(classifyStep('bootstrap', env).ok).toBe(false);
  });
});

describe('decideTier1', () => {
  it('green when every step is ok', () => {
    const steps = [
      classifyStep('doctor', makeEnvelope({ command: 'doctor', checks: [check('a', 'pass')] })),
      classifyStep('early-win', makeEnvelope({ command: 'early-win', checks: [check('b', 'pass')] })),
    ];
    const d = decideTier1(steps);
    expect(d.verdict).toBe('green');
    expect(d.reasons).toEqual([]);
  });

  it('blocked with reasons when a step has blocking checks', () => {
    const steps = [classifyStep('doctor', makeEnvelope({ command: 'doctor', checks: [check('bedrock', 'fail')] }))];
    const d = decideTier1(steps);
    expect(d.verdict).toBe('blocked');
    expect(d.reasons[0]).toMatch(/doctor: bedrock is fail/);
  });
});

describe('gate id partitions are disjoint and complete', () => {
  it('no id is both a read-only gate and a provisioning step', () => {
    const overlap = BOOTSTRAP_READONLY_GATE_IDS.filter((id) => BOOTSTRAP_PROVISIONING_IDS.includes(id));
    expect(overlap).toEqual([]);
  });
});
