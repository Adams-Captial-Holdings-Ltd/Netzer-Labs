import { describe, it, expect } from 'vitest';
import { TEMPLATED_PROFILES, legacyRoleForCapabilities } from './permissions.js';

// NZR-5 gate finding: adding knowledge:private:read to the admin template must
// not demote a saved custom profile that holds every pre-existing admin cap.
// /tokens* is still legacy-admin gated, so a demotion would strip token controls.
describe('legacyRoleForCapabilities', () => {
  const preNzr5Admin = TEMPLATED_PROFILES.admin.filter((c) => c !== 'knowledge:private:read');

  it('keeps a custom full-admin profile without knowledge:private:read at admin', () => {
    expect(legacyRoleForCapabilities(preNzr5Admin)).toBe('admin');
  });

  it('maps the templated profiles to their own rung', () => {
    expect(legacyRoleForCapabilities(TEMPLATED_PROFILES.admin)).toBe('admin');
    expect(legacyRoleForCapabilities(TEMPLATED_PROFILES.operator)).toBe('operator');
    expect(legacyRoleForCapabilities(TEMPLATED_PROFILES.viewer)).toBe('viewer');
  });

  it('never grants admin for knowledge:private:read on top of operator caps', () => {
    expect(
      legacyRoleForCapabilities([...TEMPLATED_PROFILES.operator, 'knowledge:private:read']),
    ).toBe('operator');
  });

  it('drops a profile missing tokens:write below admin', () => {
    expect(legacyRoleForCapabilities(preNzr5Admin.filter((c) => c !== 'tokens:write'))).toBe(
      'operator',
    );
  });
});
