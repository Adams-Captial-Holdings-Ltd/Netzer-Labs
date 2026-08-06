import { describe, it, expect } from 'vitest';
import {
  isWellFormedPolicyArn,
  isKnownDangerousPolicyArn,
  isDangerousPolicy,
} from './iam-copilot.js';

// C1 regression: the attach_*_policy paths take a managed-policy ARN that the
// inline-document lint never inspected, so `attach AdministratorAccess` was a
// one-step escalation. These cover the ARN guard that now gates attach.

describe('isWellFormedPolicyArn', () => {
  it('accepts AWS-managed and customer-managed policy ARNs', () => {
    expect(isWellFormedPolicyArn('arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess')).toBe(true);
    expect(isWellFormedPolicyArn('arn:aws:iam::123456789012:policy/MyTeamPolicy')).toBe(true);
    expect(isWellFormedPolicyArn('arn:aws-us-gov:iam::aws:policy/AdministratorAccess')).toBe(true);
  });

  it('rejects junk, role ARNs, and missing values', () => {
    expect(isWellFormedPolicyArn(undefined)).toBe(false);
    expect(isWellFormedPolicyArn('')).toBe(false);
    expect(isWellFormedPolicyArn('AdministratorAccess')).toBe(false);
    expect(isWellFormedPolicyArn('arn:aws:iam::123456789012:role/SomeRole')).toBe(false);
    expect(isWellFormedPolicyArn('arn:aws:iam::aws:policy/')).toBe(false);
  });
});

describe('isKnownDangerousPolicyArn', () => {
  it('flags the account-admin / IAM-admin managed policies', () => {
    expect(isKnownDangerousPolicyArn('arn:aws:iam::aws:policy/AdministratorAccess')).toBe(true);
    expect(isKnownDangerousPolicyArn('arn:aws:iam::aws:policy/IAMFullAccess')).toBe(true);
    expect(isKnownDangerousPolicyArn('arn:aws:iam::aws:policy/PowerUserAccess')).toBe(true);
  });

  it('flags customer-managed copies that carry a dangerous name', () => {
    expect(isKnownDangerousPolicyArn('arn:aws:iam::123456789012:policy/CopyOfAdministratorAccess')).toBe(
      true,
    );
  });

  it('does not flag ordinary least-privilege policies', () => {
    expect(isKnownDangerousPolicyArn('arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess')).toBe(false);
    expect(isKnownDangerousPolicyArn('arn:aws:iam::123456789012:policy/MyTeamReadOnly')).toBe(false);
  });
});

describe('isDangerousPolicy (inline document lint, unchanged)', () => {
  it('flags a wildcard admin document', () => {
    const doc = JSON.stringify({
      Version: '2012-10-17',
      Statement: [{ Effect: 'Allow', Action: '*', Resource: '*' }],
    });
    expect(isDangerousPolicy(doc)).toBe(true);
  });

  it('flags IAM write on all resources', () => {
    const doc = JSON.stringify({
      Version: '2012-10-17',
      Statement: [{ Effect: 'Allow', Action: 'iam:AttachRolePolicy', Resource: '*' }],
    });
    expect(isDangerousPolicy(doc)).toBe(true);
  });

  it('passes a scoped read policy', () => {
    const doc = JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        { Effect: 'Allow', Action: 's3:GetObject', Resource: 'arn:aws:s3:::my-bucket/*' },
      ],
    });
    expect(isDangerousPolicy(doc)).toBe(false);
  });
});
