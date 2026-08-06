/**
 * Unit tests for the support-bundle redactor (IaC readiness item 36).
 * Pure-function tests — no AWS, no env files, no checks executed.
 */

import { describe, expect, it } from 'vitest';
import {
  buildBundle,
  hashValue,
  redactText,
  remediationLinkFor,
  BUNDLE_SCHEMA_VERSION,
  type RedactOptions,
} from './support-bundle.js';
import type { CheckResult } from './lib/verify/checks.js';

const OPTS: RedactOptions = {
  salt: 'test-salt-aaaa',
  appSlug: 'claudeclaw',
  stackPrefix: 'CCE',
  domain: 'cce.example.com',
};

describe('redactText', () => {
  it('masks 12-digit account ids', () => {
    const { text } = redactText('caller account 123456789012 is not bootstrapped', OPTS);
    expect(text).not.toContain('123456789012');
    expect(text).toMatch(/\[account-id:[0-9a-f]{12}\]/);
    // Semantics survive.
    expect(text).toContain('caller account');
    expect(text).toContain('is not bootstrapped');
  });

  it('masks ARNs (which embed account ids and names) as a single unit', () => {
    const arn = 'arn:aws:ecs:us-east-1:123456789012:cluster/claudeclaw-cluster';
    const { text, ids } = redactText(`service in ${arn} not steady`, OPTS);
    expect(text).not.toContain('123456789012');
    expect(text).not.toContain('claudeclaw-cluster');
    expect(text).toMatch(/\[arn:[0-9a-f]{12}\]/);
    expect(ids.some((i) => i.kind === 'arn')).toBe(true);
  });

  it('masks http(s) URLs by host hash', () => {
    const { text } = redactText('probe of https://cce.example.com/ready returned 503', OPTS);
    expect(text).not.toContain('cce.example.com');
    expect(text).toMatch(/\[url-host:[0-9a-f]{12}\]/);
    expect(text).toContain('returned 503');
  });

  it('masks resource names containing the app prefix and the stack prefix', () => {
    const { text } = redactText(
      'bucket claudeclaw-deploy-state missing; stack CCE-Compute is in UPDATE_ROLLBACK_FAILED',
      OPTS,
    );
    expect(text).not.toContain('claudeclaw-deploy-state');
    expect(text).not.toContain('CCE-Compute');
    expect(text).toContain('UPDATE_ROLLBACK_FAILED');
  });

  it('masks the bare configured domain', () => {
    const { text } = redactText('DNS for cce.example.com does not resolve', OPTS);
    expect(text).not.toContain('cce.example.com');
    expect(text).toMatch(/\[domain:[0-9a-f]{12}\]/);
  });

  it('same input + same salt = same hash (correlation within a deployment)', () => {
    const a = redactText('account 123456789012', OPTS).text;
    const b = redactText('account 123456789012', OPTS).text;
    expect(a).toEqual(b);
    expect(hashValue('x', 's')).toEqual(hashValue('x', 's'));
  });

  it('different salt = different hash (no correlation across deployments)', () => {
    const a = redactText('account 123456789012', OPTS).text;
    const b = redactText('account 123456789012', { ...OPTS, salt: 'other-salt' }).text;
    expect(a).not.toEqual(b);
    expect(hashValue('x', 's1')).not.toEqual(hashValue('x', 's2'));
  });

  it('collects each masked value once in hashedResourceIds', () => {
    const { ids } = redactText('123456789012 and again 123456789012', OPTS);
    expect(ids.filter((i) => i.kind === 'account-id')).toHaveLength(1);
  });
});

describe('buildBundle', () => {
  const results: CheckResult[] = [
    {
      id: 'stacks-live',
      title: 'CloudFormation stacks by prefix',
      status: 'fail',
      detail: 'stack CCE-Compute in account 123456789012 is UPDATE_ROLLBACK_FAILED',
      remediation: 'aws cloudformation describe-stack-events --stack-name CCE-Compute',
    },
    {
      id: 'ecs-service-steady',
      title: 'ECS service steady',
      status: 'pass',
      detail: 'service steady',
    },
  ];

  function bundleWith(salt: string) {
    return buildBundle({
      results,
      manifest: { deployId: 'd-1', gitSha: 'abc1234', imageTag: 'sha-abc1234' },
      tier: 1,
      mode: 'chat',
      region: 'us-east-1',
      redact: true,
      redactOptions: { ...OPTS, salt },
      saltSource: 'session',
      now: new Date('2026-06-11T00:00:00Z'),
    });
  }

  it('check id and status survive redaction; identifying values do not', () => {
    const bundle = bundleWith('s1');
    expect(bundle.schemaVersion).toBe(BUNDLE_SCHEMA_VERSION);
    const failed = bundle.checks.find((c) => c.id === 'stacks-live');
    expect(failed).toBeDefined();
    expect(failed!.status).toBe('fail');
    expect(failed!.sanitizedDetail).not.toContain('123456789012');
    expect(failed!.sanitizedDetail).not.toContain('CCE-Compute');
    expect(failed!.sanitizedDetail).toContain('UPDATE_ROLLBACK_FAILED');
    expect(failed!.remediationLink).toBe('docs/troubleshooting.md#stacks-live-a');
    expect(bundle.deployedVersion).toEqual({
      deployId: 'd-1',
      gitSha: 'abc1234',
      imageTag: 'sha-abc1234',
    });
    expect(bundle.hashedResourceIds.length).toBeGreaterThan(0);
  });

  it('same salt yields identical hashed ids; different salt differs', () => {
    const a = bundleWith('s1');
    const b = bundleWith('s1');
    const c = bundleWith('s2');
    expect(a.hashedResourceIds).toEqual(b.hashedResourceIds);
    expect(a.hashedResourceIds).not.toEqual(c.hashedResourceIds);
  });

  it('raw mode keeps details intact and states the danger', () => {
    const bundle = buildBundle({
      results,
      manifest: null,
      tier: 1,
      mode: 'chat',
      region: 'us-east-1',
      redact: false,
      redactOptions: { ...OPTS, salt: 's' },
      saltSource: 'session',
    });
    expect(bundle.checks[0].sanitizedDetail).toContain('123456789012');
    expect(bundle.redaction.applied).toBe(false);
    expect(bundle.redaction.note).toMatch(/Never paste publicly/);
    expect(bundle.hashedResourceIds).toEqual([]);
  });
});

describe('remediationLinkFor', () => {
  it('links a known check to its troubleshooting anchor', () => {
    expect(remediationLinkFor('manifest-present')).toBe(
      'docs/troubleshooting.md#manifest-present-b',
    );
  });
  it('falls back to the troubleshooting index for unknown ids', () => {
    expect(remediationLinkFor('nope')).toBe('docs/troubleshooting.md');
  });
});
