import { describe, it, expect } from 'vitest';
import {
  bootstrapQualifier,
  onboardingTags,
  resolveStateNames,
  toolkitStackName,
  isForeignToolkit,
  OWNER_TAG_KEY,
  ONBOARDING_TAG_KEY,
  CDK_DEFAULT_QUALIFIER,
  CDK_DEFAULT_TOOLKIT_STACK,
} from './naming.js';

describe('bootstrapQualifier', () => {
  it('is deterministic for the same account+region', () => {
    const a = bootstrapQualifier('111122223333', 'us-east-1');
    const b = bootstrapQualifier('111122223333', 'us-east-1');
    expect(a).toBe(b);
  });

  it('is exactly 9 lowercase alphanumeric chars', () => {
    const q = bootstrapQualifier('111122223333', 'us-east-1');
    expect(q).toHaveLength(9);
    expect(q).toMatch(/^[a-z0-9]{9}$/);
  });

  it('differs from the CDK default qualifier', () => {
    expect(bootstrapQualifier('111122223333', 'us-east-1')).not.toBe(CDK_DEFAULT_QUALIFIER);
  });

  it('varies by account and by region', () => {
    const base = bootstrapQualifier('111122223333', 'us-east-1');
    expect(bootstrapQualifier('444455556666', 'us-east-1')).not.toBe(base);
    expect(bootstrapQualifier('111122223333', 'us-west-2')).not.toBe(base);
  });

  it('throws without account or region', () => {
    expect(() => bootstrapQualifier('', 'us-east-1')).toThrow();
    expect(() => bootstrapQualifier('111122223333', '')).toThrow();
  });
});

describe('onboardingTags', () => {
  it('includes the install-id and onboarding markers plus base TAGS', () => {
    const tags = onboardingTags('run-xyz');
    expect(tags[OWNER_TAG_KEY]).toBe('run-xyz');
    expect(tags[ONBOARDING_TAG_KEY]).toBe('true');
    expect(tags.Application).toBe('claudeclaw-enterprise');
    expect(tags.ManagedBy).toBe('cdk');
  });

  it('exposes the expected tag-key constants', () => {
    expect(OWNER_TAG_KEY).toBe('claudeclaw:install-id');
    expect(ONBOARDING_TAG_KEY).toBe('claudeclaw:onboarding');
  });

  it('throws without a runId', () => {
    expect(() => onboardingTags('')).toThrow();
  });
});

describe('toolkit stack identity', () => {
  it('is not the CDK default toolkit name', () => {
    expect(toolkitStackName()).not.toBe(CDK_DEFAULT_TOOLKIT_STACK);
  });

  it('treats the default CDKToolkit as foreign', () => {
    expect(isForeignToolkit(CDK_DEFAULT_TOOLKIT_STACK)).toBe(true);
    expect(isForeignToolkit('SomeoneElsesStack')).toBe(true);
    expect(isForeignToolkit(toolkitStackName())).toBe(false);
  });
});

describe('resolveStateNames re-export', () => {
  it('produces the canonical bootstrap-state names', () => {
    const names = resolveStateNames({
      AWS_ACCOUNT_ID: '111122223333',
      AWS_REGION: 'us-east-1',
    });
    expect(names.stateBucket).toBe('claudeclaw-deploy-111122223333-us-east-1');
    expect(names.lockTable).toBe('claudeclaw-deploy-lock');
    expect(names.ecrRepo).toBe('claudeclaw-orchestrator');
  });
});
