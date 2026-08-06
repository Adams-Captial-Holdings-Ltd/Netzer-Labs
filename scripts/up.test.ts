/**
 * Unit tests for the up conductor's pure core (scripts/up.ts).
 *
 * Covers the decision function that turns one step's typed envelope into a
 * proceed / wait / abort verdict, the waitable-doctor allowlist semantics,
 * and the poll-delay math (floor, human-gate cadence, wait_retry caps).
 * No I/O: envelopes are built with the real makeEnvelope/makeCheck builders
 * so summary/ok can never drift from the checks.
 */

import { describe, expect, it } from 'vitest';
import { allChecks as preflightChecks } from './lib/preflight/checks.js';
import { allChecks } from './lib/verify/checks.js';
import {
  makeCheck,
  makeEnvelope,
  humanGateAction,
  waitRetryAction,
  noneAction,
  type Check,
  type Envelope,
} from './lib/envelope/envelope.js';
import {
  decideFromEnvelope,
  DOCTOR_GATE_POLL_SEC,
  formatDuration,
  GATE_MAX_WAIT_SEC,
  HUMAN_GATE_POLL_SEC,
  looksLikeDeadCredentials,
  MIN_POLL_SEC,
  UP_STEPS,
  VERIFY_SETTLE_MAX_SEC,
  VERIFY_SETTLE_POLL_SEC,
  WAIT_RETRY_DEFAULT_MAX_SEC,
  WAITABLE_DOCTOR_CHECKS,
  WAITABLE_VERIFY_CHECKS,
} from './up.js';

function envelopeWith(checks: Check[]): Envelope {
  return makeEnvelope({ command: 'doctor', checks });
}

const passCheck = makeCheck({ id: 'aws-identity', title: 'AWS identity', status: 'pass' });

describe('decideFromEnvelope', () => {
  it('proceeds on an ok envelope', () => {
    const env = envelopeWith([passCheck]);
    expect(decideFromEnvelope('doctor', env)).toEqual({ kind: 'proceed' });
  });

  it('proceeds when the only non-pass checks are warns or skips', () => {
    const env = envelopeWith([
      passCheck,
      makeCheck({ id: 'service-quotas', title: 'Quotas', status: 'warn' }),
      makeCheck({ id: 'magic-link-email', title: 'Magic link', status: 'skip' }),
    ]);
    expect(decideFromEnvelope('doctor', env)).toEqual({ kind: 'proceed' });
  });

  it('waits on a doctor fail whose id is on the waitable allowlist', () => {
    const env = envelopeWith([
      passCheck,
      makeCheck({
        id: 'bedrock-grant-claude',
        title: 'Bedrock model access',
        status: 'fail',
        detail: 'model not granted\nremediation: request access in the console',
      }),
    ]);
    const d = decideFromEnvelope('doctor', env);
    expect(d.kind).toBe('wait');
    if (d.kind !== 'wait') return;
    expect(d.delaySec).toBe(DOCTOR_GATE_POLL_SEC);
    expect(d.maxWaitSec).toBe(GATE_MAX_WAIT_SEC);
    expect(d.blockers).toHaveLength(1);
    expect(d.blockers[0].id).toBe('bedrock-grant-claude');
    // A doctor gate asks the human for a browser step, so it reads ACTION NEEDED.
    expect(d.blockers[0].waitStyle).toBe('human');
  });

  it('settles on a verify fail whose id is on the post-deploy allowlist', () => {
    const env = envelopeWith([
      passCheck,
      makeCheck({
        id: 'ecs-service-steady',
        title: 'ECS service steady',
        status: 'fail',
        detail: 'service still stabilizing after the new task definition',
      }),
    ]);
    const d = decideFromEnvelope('verify', env);
    expect(d.kind).toBe('wait');
    if (d.kind !== 'wait') return;
    expect(d.delaySec).toBe(VERIFY_SETTLE_POLL_SEC);
    expect(d.maxWaitSec).toBe(VERIFY_SETTLE_MAX_SEC);
    // Settling asks nothing of the human; it must NOT read as ACTION NEEDED.
    expect(d.blockers[0].waitStyle).toBe('settle');
  });

  it('aborts on a verify fail that is not settle-shaped (needs a fix, not time)', () => {
    const env = envelopeWith([
      makeCheck({ id: 'manifest-present', title: 'Manifest', status: 'fail', detail: 'no manifest' }),
    ]);
    expect(decideFromEnvelope('verify', env).kind).toBe('abort');
  });

  it('the verify settle allowlist does not apply to the doctor step', () => {
    const env = envelopeWith([
      makeCheck({ id: 'ecs-service-steady', title: 'ECS', status: 'fail', action: noneAction() }),
    ]);
    expect(decideFromEnvelope('doctor', env).kind).toBe('abort');
  });

  it('aborts on a doctor fail that is not waitable (needs a fix, not time)', () => {
    const env = envelopeWith([
      makeCheck({ id: 'aws-identity', title: 'AWS identity', status: 'fail', detail: 'no credentials' }),
    ]);
    const d = decideFromEnvelope('doctor', env);
    expect(d.kind).toBe('abort');
    if (d.kind !== 'abort') return;
    expect(d.blockers[0].id).toBe('aws-identity');
  });

  it('aborts when waitable and non-waitable blockers are mixed', () => {
    const env = envelopeWith([
      makeCheck({ id: 'bedrock-grant-claude', title: 'Bedrock', status: 'fail' }),
      makeCheck({ id: 'name-collisions', title: 'Names', status: 'fail' }),
    ]);
    expect(decideFromEnvelope('doctor', env).kind).toBe('abort');
  });

  it('the waitable allowlist only applies to the doctor step', () => {
    const env = envelopeWith([
      makeCheck({ id: 'bedrock-grant-claude', title: 'Bedrock', status: 'fail', action: noneAction() }),
    ]);
    expect(decideFromEnvelope('verify', env).kind).toBe('abort');
  });

  it('honors a typed wait_retry action, flooring the delay and defaulting the cap', () => {
    const env = envelopeWith([
      makeCheck({
        id: 'early-win',
        title: 'Early win',
        status: 'pending',
        action: waitRetryAction({ retryAfterSec: 1 }),
      }),
    ]);
    const d = decideFromEnvelope('early-win', env);
    expect(d.kind).toBe('wait');
    if (d.kind !== 'wait') return;
    expect(d.delaySec).toBe(MIN_POLL_SEC);
    expect(d.maxWaitSec).toBe(WAIT_RETRY_DEFAULT_MAX_SEC);
    expect(d.blockers[0].waitStyle).toBe('settle');
  });

  it('honors a typed wait_retry action with explicit timing', () => {
    const env = envelopeWith([
      makeCheck({
        id: 'early-win',
        title: 'Early win',
        status: 'pending',
        action: waitRetryAction({ retryAfterSec: 120, maxWaitSec: 1800 }),
      }),
    ]);
    const d = decideFromEnvelope('early-win', env);
    expect(d.kind).toBe('wait');
    if (d.kind !== 'wait') return;
    expect(d.delaySec).toBe(120);
    expect(d.maxWaitSec).toBe(1800);
  });

  it('waits on a typed human_gate action and surfaces the console url', () => {
    const env = envelopeWith([
      makeCheck({
        id: 'early-win',
        title: 'Model access not requested',
        status: 'fail',
        action: humanGateAction('bedrock-model-access', 'https://console.aws.amazon.com/bedrock'),
      }),
    ]);
    const d = decideFromEnvelope('early-win', env);
    expect(d.kind).toBe('wait');
    if (d.kind !== 'wait') return;
    expect(d.delaySec).toBe(HUMAN_GATE_POLL_SEC);
    expect(d.maxWaitSec).toBe(GATE_MAX_WAIT_SEC);
    expect(d.blockers[0].consoleUrl).toBe('https://console.aws.amazon.com/bedrock');
    expect(d.blockers[0].gateId).toBe('bedrock-model-access');
    expect(d.blockers[0].waitStyle).toBe('human');
  });

  it('takes the slowest cadence when several gates are open at once', () => {
    const env = envelopeWith([
      makeCheck({
        id: 'a',
        title: 'A',
        status: 'pending',
        action: waitRetryAction({ retryAfterSec: 30, maxWaitSec: 600 }),
      }),
      makeCheck({
        id: 'b',
        title: 'B',
        status: 'fail',
        action: humanGateAction('gate-b'),
      }),
    ]);
    const d = decideFromEnvelope('early-win', env);
    expect(d.kind).toBe('wait');
    if (d.kind !== 'wait') return;
    expect(d.delaySec).toBe(HUMAN_GATE_POLL_SEC);
    expect(d.maxWaitSec).toBe(GATE_MAX_WAIT_SEC);
  });
});

describe('conductor plan', () => {
  it('runs the five quickstart steps in order', () => {
    expect(UP_STEPS.map((s) => s.id)).toEqual(['setup', 'doctor', 'early-win', 'deploy', 'verify']);
  });

  it('setup and deploy are passthrough; the rest speak the typed envelope', () => {
    for (const s of UP_STEPS) {
      if (s.id === 'setup' || s.id === 'deploy') expect(s.envelopeFlag).toBeNull();
      else expect(s.envelopeFlag).toMatch(/^--(envelope|json)$/);
    }
  });

  it('every bedrock grant check is on the waitable allowlist', () => {
    for (const id of [
      'bedrock-grant-claude',
      'bedrock-grant-titan-embed',
      'bedrock-grant-image',
      'bedrock-grant-nova-sonic',
    ]) {
      expect(WAITABLE_DOCTOR_CHECKS).toContain(id);
    }
  });

  it('the verify settle allowlist covers the propagation-shaped checks', () => {
    for (const id of [
      'ecs-service-steady',
      'dashboard-endpoint',
      'waf-cloudfront',
      'bedrock-probe-claude',
      'bedrock-probe-titan-embed',
    ]) {
      expect(WAITABLE_VERIFY_CHECKS).toContain(id);
    }
    // Config-shaped verify checks must stay abort-on-fail; settling on them
    // would hide a broken install for 15 minutes.
    for (const id of ['manifest-present', 'secret-versions-fresh', 'runtime-config-seed']) {
      expect(WAITABLE_VERIFY_CHECKS).not.toContain(id);
    }
  });

  it('every settle-allowlist id exists in the verify registry (rename guard)', () => {
    const registryIds = new Set(allChecks.map((c) => c.id));
    for (const id of WAITABLE_VERIFY_CHECKS) {
      expect(registryIds).toContain(id);
    }
  });

  it('every doctor-waitable id exists in the preflight registry (rename guard)', () => {
    // A silent rename in preflight/checks.ts would flip the conductor from
    // waiting through a gate to aborting on it, with no failing test.
    const registryIds = new Set(preflightChecks.map((c) => c.id));
    for (const id of WAITABLE_DOCTOR_CHECKS) {
      expect(registryIds).toContain(id);
    }
  });
});

describe('deploy decline exit-code contract', () => {
  it('is a distinct code: not success (0), not generic failure (1)', async () => {
    const { DEPLOY_EXIT_DECLINED } = await import('./lib/exit-codes.js');
    expect(DEPLOY_EXIT_DECLINED).not.toBe(0);
    expect(DEPLOY_EXIT_DECLINED).not.toBe(1);
    // Pinned: deploy.ts throws it at the money gate; up.ts keys on it to
    // stop cleanly instead of running verify against nothing.
    expect(DEPLOY_EXIT_DECLINED).toBe(10);
  });
});

describe('looksLikeDeadCredentials', () => {
  it('matches the credential-expiry shapes SSO and static keys produce', () => {
    for (const text of [
      'ExpiredTokenException: The security token included in the request is expired',
      'ExpiredToken: The security token included in the request is expired',
      'TokenRefreshRequired: token has expired and refresh failed',
      'InvalidClientTokenId: The security token included in the request is invalid',
      'UnrecognizedClientException: The security token included in the request is invalid.',
      'CredentialsProviderError: Could not load credentials from any providers',
      'Error: The SSO session associated with this profile has expired or is otherwise invalid.',
    ]) {
      expect(looksLikeDeadCredentials(text)).toBe(true);
    }
  });

  it('never blames credentials for network, throttling, or permission errors', () => {
    for (const text of [
      'TimeoutError: socket hang up',
      'Error: getaddrinfo ENOTFOUND sts.us-east-1.amazonaws.com',
      'ThrottlingException: Rate exceeded',
      'AccessDeniedException: User is not authorized to perform sts:GetCallerIdentity',
      'ValidationException: 1 validation error detected',
    ]) {
      expect(looksLikeDeadCredentials(text)).toBe(false);
    }
  });
});

describe('formatDuration', () => {
  it('reads short runs as about a minute', () => {
    expect(formatDuration(45)).toBe('about a minute');
    expect(formatDuration(89)).toBe('about a minute');
  });

  it('formats minutes and hours', () => {
    expect(formatDuration(23 * 60)).toBe('23m');
    expect(formatDuration(64 * 60)).toBe('1h 04m');
  });
});
