import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDeployMode } from './deploy-mode.js';

/**
 * The mode resolution is extracted into deploy-mode.ts precisely so the
 * privateAccessOnly invariants are testable without synthesizing the full
 * ComputeStack (which needs a VPC, security groups, secrets, messaging
 * outputs, ...). These tests pin the contract; the source-level assertions
 * at the bottom pin that compute-stack actually consumes it.
 */

describe('resolveDeployMode', () => {
  it('defaults to chat when CCE_DEPLOY_MODE is unset (today\'s prod synth)', () => {
    const r = resolveDeployMode({});
    expect(r.mode).toBe('chat');
    expect(r.privateAccessOnly).toBe(false);
  });

  it('is chat for explicit "chat" and for any unrecognized value (typo-safe)', () => {
    for (const value of ['chat', 'CHAT', 'infraonly', 'infra_only', '', '  ', 'true']) {
      const r = resolveDeployMode({ CCE_DEPLOY_MODE: value });
      expect(r.mode).toBe('chat');
      expect(r.privateAccessOnly).toBe(false);
    }
  });

  it('infra-only WITHOUT a domain is private-access-only (internal ALB)', () => {
    const r = resolveDeployMode({ CCE_DEPLOY_MODE: 'infra-only' });
    expect(r.mode).toBe('infra-only');
    expect(r.hasDomain).toBe(false);
    expect(r.privateAccessOnly).toBe(true);
  });

  it('treats a blank DOMAIN_NAME as no domain', () => {
    const r = resolveDeployMode({ CCE_DEPLOY_MODE: 'infra-only', DOMAIN_NAME: '   ' });
    expect(r.hasDomain).toBe(false);
    expect(r.privateAccessOnly).toBe(true);
  });

  it('infra-only WITH a domain keeps the public (HTTPS) ALB path', () => {
    const r = resolveDeployMode({
      CCE_DEPLOY_MODE: 'infra-only',
      DOMAIN_NAME: 'claw.example.com',
    });
    expect(r.mode).toBe('infra-only');
    expect(r.hasDomain).toBe(true);
    expect(r.privateAccessOnly).toBe(false);
  });

  it('chat mode with a domain is never private-access-only (prod shape)', () => {
    const r = resolveDeployMode({ CCE_DEPLOY_MODE: 'chat', DOMAIN_NAME: 'claw.example.com' });
    expect(r.privateAccessOnly).toBe(false);
  });
});

describe('compute-stack wiring (source-level)', () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), 'compute-stack.ts'),
    'utf8',
  );

  it('imports and calls resolveDeployMode from deploy-mode.ts', () => {
    expect(source).toMatch(/import \{ resolveDeployMode \} from '\.\/deploy-mode\.js'/);
    expect(source).toMatch(/resolveDeployMode\(process\.env\)/);
  });

  it('keys the ALB scheme off privateAccessOnly (internal when private)', () => {
    expect(source).toMatch(/internetFacing: !privateAccessOnly/);
  });

  it('pins the internal ALB to private subnets in privateAccessOnly mode', () => {
    expect(source).toMatch(
      /privateAccessOnly\s*\?\s*\{ vpcSubnets: \{ subnetType: SubnetType\.PRIVATE_WITH_EGRESS \} \}/,
    );
  });

  it('keeps ECS Exec enabled (the tunnel transport) on the service', () => {
    expect(source).toMatch(/enableExecuteCommand: true/);
  });

  it('grants the ssmmessages channel to the task role, gated to private mode', () => {
    const gated = source.slice(source.indexOf('if (privateAccessOnly) {'));
    for (const action of [
      'ssmmessages:CreateControlChannel',
      'ssmmessages:CreateDataChannel',
      'ssmmessages:OpenControlChannel',
      'ssmmessages:OpenDataChannel',
    ]) {
      expect(gated).toContain(action);
    }
  });
});
