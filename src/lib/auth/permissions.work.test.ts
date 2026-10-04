/**
 * FROZEN acceptance tests for Work Platform step 7: the two Work capabilities.
 * Written by the coordinator BEFORE any production code. Do not edit without
 * the owner's yes: the step gate pins this file.
 *
 * Names: ADR 0017 (ONE-WAY). Default profiles: owner 2026-10-04, "Operator and
 * up": cases can hold health information, so a read-only viewer does not see
 * them unless a custom profile grants it.
 */
import { describe, it, expect } from 'vitest';
import { CAPABILITIES, TEMPLATED_PROFILES, hasCapability, isCapability, type Capability } from './permissions.js';

const WORK = ['work:read', 'work:approve'] as const;

describe('the Work capabilities', () => {
  it('work:read and work:approve are capabilities, and nothing else starts with work:', () => {
    for (const name of WORK) expect(isCapability(name)).toBe(true);
    expect((CAPABILITIES as readonly string[]).filter((c) => c.startsWith('work:')).sort()).toEqual(['work:approve', 'work:read']);
  });

  it.each(['operator', 'admin', 'org-admin', 'owner'] as const)('%s has both by default', (profile) => {
    for (const name of WORK) expect(TEMPLATED_PROFILES[profile]).toContain(name);
  });

  it.each(['seat-user', 'viewer', 'analyst'] as const)('%s has neither by default', (profile) => {
    for (const name of WORK) expect(TEMPLATED_PROFILES[profile]).not.toContain(name);
  });

  it('holding read does not imply approve: the two are separate', () => {
    const readOnly = ['work:read'] as Capability[];
    expect(hasCapability(readOnly, 'work:read' as Capability)).toBe(true);
    expect(hasCapability(readOnly, 'work:approve' as Capability)).toBe(false);
  });
});
