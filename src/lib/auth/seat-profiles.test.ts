import { describe, it, expect } from 'vitest';
import {
  TEMPLATED_PROFILES,
  TEMPLATED_PROFILE_IDS,
  resolveCapabilities,
  hasCapability,
  canAssignProfile,
} from './permissions.js';

// Absorbed from PR #42: the seat-user / org-admin profile contracts, adapted
// to the trimmed taxonomy (no workspace capabilities).

describe('seat-user profile', () => {
  const caps = TEMPLATED_PROFILES['seat-user'];

  it('is the floor: coarse dashboard read + own usage, nothing else', () => {
    expect(caps).toEqual(['dashboard:read', 'usage:self:read']);
  });

  it('holds NO per-tab reads, no seat administration, no org usage', () => {
    for (const denied of [
      'overview:read',
      'agents:read',
      'sessions:read',
      'seats:read',
      'seats:write',
      'seat-policies:read',
      'seat-policies:write',
      'usage:org:read',
      'security:read',
      'members:read',
    ] as const) {
      expect(hasCapability(caps, denied)).toBe(false);
    }
  });
});

describe('org-admin profile', () => {
  const caps = TEMPLATED_PROFILES['org-admin'];

  it('holds everything admin holds', () => {
    for (const cap of TEMPLATED_PROFILES.admin) {
      expect(hasCapability(caps, cap)).toBe(true);
    }
  });

  it('adds the full seat-administration plane', () => {
    for (const cap of [
      'seats:read',
      'seats:write',
      'seat-policies:read',
      'seat-policies:write',
      'usage:org:read',
      'usage:self:read',
    ] as const) {
      expect(hasCapability(caps, cap)).toBe(true);
    }
  });

  it('still lacks owner:admin (org-admin < owner strictly)', () => {
    expect(hasCapability(caps, 'owner:admin')).toBe(false);
  });
});

describe('profile lattice invariants', () => {
  it('plain admin does NOT hold seat administration (fail-closed default)', () => {
    for (const cap of ['seats:read', 'seats:write', 'usage:org:read'] as const) {
      expect(hasCapability(TEMPLATED_PROFILES.admin, cap)).toBe(false);
    }
  });

  it('owner holds every seat capability (ALL_CAPABILITIES derivation)', () => {
    for (const cap of [
      'seats:read',
      'seats:write',
      'seat-policies:read',
      'seat-policies:write',
      'usage:org:read',
      'usage:self:read',
    ] as const) {
      expect(hasCapability(resolveCapabilities('owner'), cap)).toBe(true);
    }
  });

  it('both new ids are registered templated profiles', () => {
    expect(TEMPLATED_PROFILE_IDS).toContain('seat-user');
    expect(TEMPLATED_PROFILE_IDS).toContain('org-admin');
  });

  it('an admin cannot assign org-admin (granted caps must be a subset)', () => {
    expect(canAssignProfile(TEMPLATED_PROFILES.admin, 'org-admin')).toBe(false);
  });

  it('an org-admin can assign seat-user and admin, but not owner', () => {
    const actor = TEMPLATED_PROFILES['org-admin'];
    expect(canAssignProfile(actor, 'seat-user')).toBe(true);
    expect(canAssignProfile(actor, 'admin')).toBe(true);
    expect(canAssignProfile(actor, 'owner')).toBe(false);
  });
});
