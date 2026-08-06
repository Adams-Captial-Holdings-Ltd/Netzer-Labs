import { describe, it, expect } from 'vitest';
import {
  FORBIDDEN_FOOTHOLD_ACTIONS,
  FORBIDDEN_FOOTHOLD_CLASSES,
  BOOTSTRAP_ALLOWED_ACTIONS,
  buildBootstrapSessionPolicy,
  buildScopedDeployBoundary,
  buildScopedDeployRoleTrust,
  assertNoStrongerAdminCredential,
  denies,
  allows,
  SCOPED_ROLE_PROFILE_NAME,
  type AdminCredentialProbe,
} from './scoped-role.js';

// ─────────────────────────────────────────────────────────────────────
// I4 catalog
// ─────────────────────────────────────────────────────────────────────
describe('FORBIDDEN_FOOTHOLD_ACTIONS catalog', () => {
  it('is a flat, sorted, de-duplicated expansion of the classes', () => {
    const list = FORBIDDEN_FOOTHOLD_ACTIONS;
    expect(list.length).toBeGreaterThan(0);
    // de-duplicated
    expect(new Set(list).size).toBe(list.length);
    // sorted
    const sorted = [...list].sort();
    expect(list).toEqual(sorted);
  });

  it('covers every I4 class: iam create + trust, ec2/ram share, resource policy, kms, lambda url, logs, events, cost cap', () => {
    const expectations = [
      'iam:CreateUser',
      'iam:CreateRole',
      'iam:CreateAccessKey',
      'iam:UpdateAssumeRolePolicy',
      'iam:PutRolePolicy',
      'iam:CreateSAMLProvider',
      'iam:CreateOpenIDConnectProvider',
      'ec2:ModifyImageAttribute',
      'ec2:ModifySnapshotAttribute',
      'ram:CreateResourceShare',
      's3:PutBucketPolicy',
      'ecr:SetRepositoryPolicy',
      'secretsmanager:PutResourcePolicy',
      'sns:AddPermission',
      'sqs:AddPermission',
      'lambda:AddPermission',
      'kms:CreateGrant',
      'kms:PutKeyPolicy',
      'lambda:CreateFunctionUrlConfig',
      'logs:PutSubscriptionFilter',
      'events:PutRule',
      'events:PutTargets',
      'budgets:ModifyBudget',
      'budgets:DeleteBudget',
    ];
    for (const action of expectations) {
      expect(FORBIDDEN_FOOTHOLD_ACTIONS).toContain(action);
    }
  });

  it('every class member appears in the flat list', () => {
    for (const members of Object.values(FORBIDDEN_FOOTHOLD_CLASSES)) {
      for (const action of members) {
        expect(FORBIDDEN_FOOTHOLD_ACTIONS).toContain(action);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// Bootstrap session policy
// ─────────────────────────────────────────────────────────────────────
describe('buildBootstrapSessionPolicy', () => {
  const policy = buildBootstrapSessionPolicy();

  it('is a well-formed policy document', () => {
    expect(policy.Version).toBe('2012-10-17');
    expect(policy.Statement.length).toBeGreaterThanOrEqual(2);
  });

  it('denies a sample forbidden action (iam:CreateUser)', () => {
    expect(denies(policy, 'iam:CreateUser')).toBe(true);
  });

  it('denies a sample forbidden action (ec2:ModifySnapshotAttribute)', () => {
    expect(denies(policy, 'ec2:ModifySnapshotAttribute')).toBe(true);
  });

  it('denies EVERY action in the I4 catalog', () => {
    for (const action of FORBIDDEN_FOOTHOLD_ACTIONS) {
      expect(denies(policy, action)).toBe(true);
    }
  });

  it('allows a sample bootstrap action (cloudformation:CreateStack)', () => {
    expect(allows(policy, 'cloudformation:CreateStack')).toBe(true);
  });

  it('allows the state-primitive create actions', () => {
    expect(allows(policy, 's3:CreateBucket')).toBe(true);
    expect(allows(policy, 'dynamodb:CreateTable')).toBe(true);
    expect(allows(policy, 'ecr:CreateRepository')).toBe(true);
  });

  it('does not allow an un-listed action it should not have', () => {
    // iam:CreateUser is both un-listed in the allow set AND explicitly denied.
    expect(allows(policy, 'iam:CreateUser')).toBe(false);
    // A random unrelated action is implicitly denied (no Allow).
    expect(allows(policy, 'route53:CreateHostedZone')).toBe(false);
  });

  it('every BOOTSTRAP_ALLOWED_ACTIONS entry is allowed and none is a forbidden action', () => {
    for (const action of BOOTSTRAP_ALLOWED_ACTIONS) {
      expect(allows(policy, action)).toBe(true);
      expect(FORBIDDEN_FOOTHOLD_ACTIONS).not.toContain(action);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// Scoped deploy permission boundary
// ─────────────────────────────────────────────────────────────────────
describe('buildScopedDeployBoundary', () => {
  const boundary = buildScopedDeployBoundary();

  it('denies a cost-cap budget change', () => {
    expect(denies(boundary, 'budgets:ModifyBudget')).toBe(true);
    expect(denies(boundary, 'budgets:DeleteBudget')).toBe(true);
    expect(denies(boundary, 'budgets:CreateBudget')).toBe(true);
  });

  it('denies any cross-account / public share', () => {
    expect(denies(boundary, 'ec2:ModifyImageAttribute')).toBe(true);
    expect(denies(boundary, 'ram:CreateResourceShare')).toBe(true);
    expect(denies(boundary, 's3:PutBucketPolicy')).toBe(true);
    expect(denies(boundary, 'secretsmanager:PutResourcePolicy')).toBe(true);
    expect(denies(boundary, 'kms:CreateGrant')).toBe(true);
    expect(denies(boundary, 'lambda:CreateFunctionUrlConfig')).toBe(true);
    expect(denies(boundary, 'logs:PutSubscriptionFilter')).toBe(true);
    expect(denies(boundary, 'events:PutTargets')).toBe(true);
  });

  it('denies IAM trust edits even though iam:* is in the allow surface', () => {
    // iam:* is allowed broadly, but the explicit Deny must still win.
    expect(allows(boundary, 'iam:CreateRole')).toBe(false);
    expect(allows(boundary, 'iam:UpdateAssumeRolePolicy')).toBe(false);
    expect(allows(boundary, 'iam:PutRolePolicy')).toBe(false);
    expect(denies(boundary, 'iam:CreateRole')).toBe(true);
  });

  it('allows the app-stack deploy surface for non-forbidden actions', () => {
    expect(allows(boundary, 'cloudformation:CreateStack')).toBe(true);
    expect(allows(boundary, 'ecs:UpdateService')).toBe(true);
    expect(allows(boundary, 'dynamodb:CreateTable')).toBe(true);
    expect(allows(boundary, 's3:PutObject')).toBe(true);
    // budgets:ViewBudget (read) is not forbidden, but budgets:* is not in the
    // allow surface either, so it is implicitly denied. The deploy role has
    // no budget surface at all.
    expect(allows(boundary, 'budgets:ViewBudget')).toBe(false);
  });

  it('denies EVERY action in the I4 catalog', () => {
    for (const action of FORBIDDEN_FOOTHOLD_ACTIONS) {
      expect(denies(boundary, action)).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// Scoped deploy role trust policy
// ─────────────────────────────────────────────────────────────────────
describe('buildScopedDeployRoleTrust', () => {
  it('trusts only the same account root', () => {
    const trust = buildScopedDeployRoleTrust('111122223333');
    const allow = trust.Statement.find((s) => s.Effect === 'Allow');
    expect(allow).toBeDefined();
    expect(allow?.Principal).toEqual({ AWS: 'arn:aws:iam::111122223333:root' });
    expect(allow?.Action).toBe('sts:AssumeRole');
  });

  it('denies federated / web-identity assume', () => {
    const trust = buildScopedDeployRoleTrust('111122223333');
    const deny = trust.Statement.find((s) => s.Effect === 'Deny');
    expect(deny).toBeDefined();
    const actions = Array.isArray(deny?.Action) ? deny?.Action : [deny?.Action];
    expect(actions).toContain('sts:AssumeRoleWithWebIdentity');
    expect(actions).toContain('sts:AssumeRoleWithSAML');
  });

  it('rejects a non-12-digit account id', () => {
    expect(() => buildScopedDeployRoleTrust('')).toThrow();
    expect(() => buildScopedDeployRoleTrust('123')).toThrow();
    expect(() => buildScopedDeployRoleTrust('not-an-account')).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────
// denies() helper edge cases
// ─────────────────────────────────────────────────────────────────────
describe('denies() / allows() evaluator', () => {
  it('explicit Deny on a wildcard pattern matches sub-family members', () => {
    const policy = {
      Version: '2012-10-17' as const,
      Statement: [{ Effect: 'Deny' as const, Action: 'iam:Create*' }],
    };
    expect(denies(policy, 'iam:CreateUser')).toBe(true);
    expect(denies(policy, 'iam:CreateRole')).toBe(true);
    expect(denies(policy, 'iam:GetRole')).toBe(false);
  });

  it('explicit Deny always shadows an Allow for the same action', () => {
    const policy = {
      Version: '2012-10-17' as const,
      Statement: [
        { Effect: 'Allow' as const, Action: '*' },
        { Effect: 'Deny' as const, Action: 'budgets:ModifyBudget' },
      ],
    };
    expect(denies(policy, 'budgets:ModifyBudget')).toBe(true);
    expect(allows(policy, 'budgets:ModifyBudget')).toBe(false);
    expect(allows(policy, 'cloudformation:CreateStack')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────
// assertNoStrongerAdminCredential
// ─────────────────────────────────────────────────────────────────────
describe('assertNoStrongerAdminCredential', () => {
  it('flags an env with a fake long-lived admin key (no session token)', async () => {
    const env = {
      AWS_ACCESS_KEY_ID: 'AKIAFAKEEXAMPLEKEY123',
      AWS_SECRET_ACCESS_KEY: 'fake-secret-value-not-real',
    } as NodeJS.ProcessEnv;
    const result = await assertNoStrongerAdminCredential(env);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/long-lived AWS access key|AWS_ACCESS_KEY_ID/);
  });

  it('passes a clean env (no keys, no admin profile, no sso)', async () => {
    const env = {} as NodeJS.ProcessEnv;
    const result = await assertNoStrongerAdminCredential(env);
    expect(result.ok).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('passes when running as the scoped-role session (temporary creds + scoped marker)', async () => {
    const env = {
      CCE_SCOPED_ROLE_ACTIVE: '1',
      AWS_ACCESS_KEY_ID: 'ASIASCOPEDSESSIONKEY1',
      AWS_SESSION_TOKEN: 'a-temporary-session-token',
      AWS_PROFILE: SCOPED_ROLE_PROFILE_NAME,
    } as NodeJS.ProcessEnv;
    const result = await assertNoStrongerAdminCredential(env);
    expect(result.ok).toBe(true);
  });

  it('flags a non-scoped AWS_PROFILE', async () => {
    const env = { AWS_PROFILE: 'admin' } as NodeJS.ProcessEnv;
    const result = await assertNoStrongerAdminCredential(env);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/AWS_PROFILE/);
  });

  it('flags an SSO session', async () => {
    const env = {
      AWS_SSO_START_URL: 'https://example.awsapps.com/start',
      AWS_SSO_ACCOUNT_ID: '111122223333',
    } as NodeJS.ProcessEnv;
    const result = await assertNoStrongerAdminCredential(env);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/SSO/);
  });

  it('flags a static key co-existing with the scoped session', async () => {
    const env = {
      CCE_SCOPED_ROLE_ACTIVE: '1',
      AWS_ACCESS_KEY_ID: 'AKIASTATICALONGSIDE12',
      AWS_SESSION_TOKEN: 'session-token-present',
    } as NodeJS.ProcessEnv;
    const result = await assertNoStrongerAdminCredential(env);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/separate AWS_ACCESS_KEY_ID|static key/);
  });

  it('fails closed when the STS probe reports a stronger identity', async () => {
    const probe: AdminCredentialProbe = {
      isStrongerThanScopedRole: async () => true,
    };
    const result = await assertNoStrongerAdminCredential({} as NodeJS.ProcessEnv, probe);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/stronger than the scoped deploy role/);
  });

  it('fails closed when the STS probe throws', async () => {
    const probe: AdminCredentialProbe = {
      isStrongerThanScopedRole: async () => {
        throw new Error('sts unreachable');
      },
    };
    const result = await assertNoStrongerAdminCredential({} as NodeJS.ProcessEnv, probe);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/failing\s+closed|Could not verify/);
  });

  it('passes when the STS probe confirms the identity is not stronger', async () => {
    const probe: AdminCredentialProbe = {
      isStrongerThanScopedRole: async () => false,
    };
    const result = await assertNoStrongerAdminCredential({} as NodeJS.ProcessEnv, probe);
    expect(result.ok).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Regression: adversarial review findings (onboarding-adversarial-review)
// ─────────────────────────────────────────────────────────────────────

describe('regression: credential guard does not fail open on a scoped-profile name', () => {
  it('flags a static admin key even when AWS_PROFILE is the scoped-profile name (no session token)', async () => {
    // The static env key outranks AWS_PROFILE in the SDK provider chain, so a
    // profile NAMED after the scoped marker must not suppress the static-key check.
    const result = await assertNoStrongerAdminCredential({
      AWS_ACCESS_KEY_ID: 'AKIAADMINLONGLIVED123',
      AWS_SECRET_ACCESS_KEY: 'admin-secret',
      AWS_PROFILE: SCOPED_ROLE_PROFILE_NAME,
    } as NodeJS.ProcessEnv);
    expect(result.ok).toBe(false);
  });

  it('still accepts a real scoped session (session token + active marker)', async () => {
    const result = await assertNoStrongerAdminCredential({
      AWS_ACCESS_KEY_ID: 'ASIATEMP',
      AWS_SECRET_ACCESS_KEY: 'x',
      AWS_SESSION_TOKEN: 'tok',
      AWS_PROFILE: SCOPED_ROLE_PROFILE_NAME,
      CCE_SCOPED_ROLE_ACTIVE: '1',
    } as NodeJS.ProcessEnv);
    expect(result.ok).toBe(true);
  });
});

describe('regression: I4 catalog covers EventBridge egress + IAM/STS escalation', () => {
  const boundary = buildScopedDeployBoundary();
  const bootstrap = buildBootstrapSessionPolicy();
  for (const action of [
    'events:CreateConnection',
    'events:UpdateConnection',
    'events:CreateApiDestination',
    'events:UpdateApiDestination',
    'iam:CreatePolicyVersion',
    'iam:SetDefaultPolicyVersion',
    'sts:GetFederationToken',
    'sts:AssumeRoleWithWebIdentity',
    'sts:AssumeRoleWithSAML',
  ]) {
    it(`denies ${action} in both the boundary and the bootstrap session policy`, () => {
      expect(FORBIDDEN_FOOTHOLD_ACTIONS).toContain(action);
      expect(denies(boundary, action)).toBe(true);
      expect(allows(boundary, action)).toBe(false);
      expect(denies(bootstrap, action)).toBe(true);
    });
  }

  it('still allows sts:AssumeRole (the deploy assumes the CDK bootstrap roles)', () => {
    expect(denies(boundary, 'sts:AssumeRole')).toBe(false);
  });
});
