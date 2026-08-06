import { describe, it, expect } from 'vitest';
import { requiredRole, ROLE_RANK } from './handler.js';

describe('ROLE_RANK', () => {
  it('orders viewer < operator < admin', () => {
    expect(ROLE_RANK.viewer).toBeLessThan(ROLE_RANK.operator);
    expect(ROLE_RANK.operator).toBeLessThan(ROLE_RANK.admin);
  });
});

describe('requiredRole', () => {
  it('treats reads as viewer-level', () => {
    expect(requiredRole('GET', '/agents')).toBe('viewer');
    expect(requiredRole('GET', '/usage')).toBe('viewer');
    expect(requiredRole('GET', '/audit')).toBe('viewer');
    expect(requiredRole('GET', '/kill-switches')).toBe('viewer');
    expect(requiredRole('GET', '/whoami')).toBe('viewer');
  });

  it('treats routine mutations as operator-level', () => {
    expect(requiredRole('POST', '/agents/create')).toBe('operator');
    expect(requiredRole('PUT', '/agents/main/file')).toBe('operator');
    expect(requiredRole('PATCH', '/agents/main')).toBe('operator');
    expect(requiredRole('DELETE', '/scheduled/main/t1')).toBe('operator');
    expect(requiredRole('POST', '/ingest')).toBe('operator');
  });

  it('delegates kill-switch flips to the in-route capability gate (legacy rank relaxed)', () => {
    // The trip mutation is authorized by the inline security:write capability
    // check inside POST /kill-switches, so the legacy rank gate is relaxed to
    // viewer (same one-mechanism pattern as /members, /profiles, cost-watch).
    // Leaving it at 'admin' dead-ended a custom security:write profile.
    expect(requiredRole('POST', '/kill-switches')).toBe('viewer');
  });

  it('requires admin for all token management', () => {
    expect(requiredRole('GET', '/tokens')).toBe('admin');
    expect(requiredRole('POST', '/tokens')).toBe('admin');
    expect(requiredRole('DELETE', '/tokens/abc123')).toBe('admin');
  });

  it('requires admin for GDPR purge but keeps export at operator/viewer', () => {
    expect(requiredRole('DELETE', '/export')).toBe('admin');
    expect(requiredRole('GET', '/export')).toBe('viewer');
  });

  it('lets a viewer reach the Jarvis voice + manifest paths', () => {
    expect(requiredRole('GET', '/jarvis/voice')).toBe('viewer');
    expect(requiredRole('GET', '/jarvis/manifest')).toBe('viewer');
  });
});
