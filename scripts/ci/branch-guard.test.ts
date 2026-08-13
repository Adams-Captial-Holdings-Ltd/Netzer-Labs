/**
 * Unit tests for scripts/ci/branch-guard.mjs.
 *
 * The guard's decision logic is pure and exported, so it is tested directly —
 * the git plumbing that feeds it (merge-parent lookup, force-push flag) lives
 * in the CLI wrapper and is exercised by the workflow itself.
 */

import { describe, expect, it } from 'vitest';
// @ts-expect-error — plain .mjs sibling, no type declarations by design.
import { validatePromotionSource, validatePush, ladderPathTo } from './branch-guard.mjs';

describe('validatePromotionSource', () => {
  it('accepts each rung of the ladder', () => {
    expect(validatePromotionSource({ base: 'production', head: 'staging' }).allowed).toBe(true);
    expect(validatePromotionSource({ base: 'staging', head: 'qa' }).allowed).toBe(true);
    expect(validatePromotionSource({ base: 'qa', head: 'development' }).allowed).toBe(true);
  });

  it('rejects the development -> production shortcut that this repo has taken before', () => {
    const r = validatePromotionSource({ base: 'production', head: 'development' });
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('only accepts staging');
    expect(r.reason).toContain('development -> qa -> staging -> production');
  });

  it('rejects a feature branch aimed straight at a promotion branch', () => {
    expect(validatePromotionSource({ base: 'staging', head: 'feature/x' }).allowed).toBe(false);
  });

  it('leaves non-promotion branches open so feature work can land', () => {
    expect(validatePromotionSource({ base: 'development', head: 'feature/x' }).allowed).toBe(true);
  });
});

describe('validatePush', () => {
  const merged = { branch: 'production', forced: false, isMerge: true, mergedFromUpstream: true };

  it('accepts a merge that came from the rung below', () => {
    expect(validatePush(merged).allowed).toBe(true);
  });

  it('flags a force-push', () => {
    const r = validatePush({ ...merged, forced: true });
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('FORCE-PUSH');
  });

  it('flags a direct commit that bypassed a pull request', () => {
    const r = validatePush({ ...merged, isMerge: false });
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('DIRECT PUSH');
  });

  it('flags a merge that skipped the ladder', () => {
    const r = validatePush({ ...merged, mergedFromUpstream: false });
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('ladder was skipped');
  });

  it('ignores branches outside the ladder', () => {
    expect(validatePush({ ...merged, branch: 'development', isMerge: false }).allowed).toBe(true);
  });

  it('does not fail a newly created branch, which has nothing to compare against', () => {
    expect(validatePush({ ...merged, isMerge: false, isNewBranch: true }).allowed).toBe(true);
  });

  it('still reports a force-push on a branch creation', () => {
    expect(validatePush({ ...merged, forced: true, isNewBranch: true }).allowed).toBe(false);
  });
});

describe('ladderPathTo', () => {
  it('spells out the full promotion path', () => {
    expect(ladderPathTo('production')).toEqual(['development', 'qa', 'staging', 'production']);
    expect(ladderPathTo('qa')).toEqual(['development', 'qa']);
  });
});
