/**
 * Unit tests for scripts/destroy.ts (npm run destroy, Phase 7).
 *
 * These exercise the PURE helpers and the per-identifier checks against
 * method-shaped fakes (no AWS, no subprocess). The deletion itself lives in
 * teardown.ts and is tested there; here we prove the VERIFICATION contract:
 *  - flag parsing + teardown argv forwarding,
 *  - the deterministic identifier set,
 *  - every check returns pass/warn/fail/skip/pending per the fail-closed rule,
 *  - the sweep marks the run reconciled only when every identifier is clean,
 *  - importing the module has NO side effects (main does not run on import).
 *
 * vitest runs with globals:false, so every helper is imported explicitly.
 */

import { describe, it, expect } from 'vitest';
import {
  parseDestroyFlags,
  teardownArgvFor,
  deriveSuffix,
  expectedNames,
  checkCfnStacks,
  checkManifestStacks,
  checkRunStateInventory,
  checkBuckets,
  checkTables,
  checkSecrets,
  checkLogGroups,
  checkEcrImages,
  checkNatGateways,
  checkLoadBalancers,
  checkEips,
  checkFootholdIam,
  runDestroySweep,
  type SweepClients,
  type ExpectedNames,
} from './destroy.js';
import { resolveStateNames } from './lib/lifecycle/bootstrap-state.js';
import type { DeployManifest } from './lib/lifecycle/manifest.js';
import type { RunState } from './lib/run-state/run-state.js';
import type { CfnClientLike } from './lib/lifecycle/teardown-plan.js';

const ACCOUNT = '123456789012';
const REGION = 'us-east-1';

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

function makeNames(suffix = ''): ExpectedNames {
  const env = { AWS_ACCOUNT_ID: ACCOUNT, AWS_REGION: REGION, CCE_NAME_SUFFIX: suffix };
  const names = resolveStateNames(env);
  return expectedNames({ names, suffix, account: ACCOUNT, region: REGION });
}

function cfnReturning(stacks: Array<{ name: string; status?: string; tagged?: boolean }>): CfnClientLike {
  return {
    async describeStacks() {
      return {
        Stacks: stacks.map((s) => ({
          StackName: s.name,
          StackStatus: s.status ?? 'CREATE_COMPLETE',
          Tags: s.tagged ? [{ Key: 'Application', Value: 'claudeclaw-enterprise' }] : [],
        })),
      };
    },
    async deleteStack() {
      return {};
    },
  };
}

// ─────────────────────────────────────────────────────────────────────
// Flag parsing + teardown forwarding
// ─────────────────────────────────────────────────────────────────────

describe('parseDestroyFlags', () => {
  it('parses every flag', () => {
    const f = parseDestroyFlags([
      '--dry-run',
      '--json',
      '--skip-teardown',
      '--export-first',
      '--cryptographic-erasure',
      '--delete-shared-prereqs',
      '--env=staging',
    ]);
    expect(f.dryRun).toBe(true);
    expect(f.json).toBe(true);
    expect(f.skipTeardown).toBe(true);
    expect(f.exportFirst).toBe(true);
    expect(f.cryptographicErasure).toBe(true);
    expect(f.deleteSharedPrereqs).toBe(true);
    expect(f.envFlag).toBe('staging');
  });

  it('defaults to prod with no flags set', () => {
    const f = parseDestroyFlags([]);
    expect(f.dryRun).toBe(false);
    expect(f.envFlag).toBe('prod');
  });
});

describe('teardownArgvFor', () => {
  it('forwards teardown-understood flags and the env, never destroy-only flags', () => {
    const f = parseDestroyFlags(['--dry-run', '--json', '--skip-teardown', '--cryptographic-erasure']);
    const argv = teardownArgvFor(f, 'prod');
    expect(argv).toContain('--dry-run');
    expect(argv).toContain('--cryptographic-erasure');
    expect(argv).toContain('--env=prod');
    // destroy-only flags must NOT be forwarded
    expect(argv).not.toContain('--json');
    expect(argv).not.toContain('--skip-teardown');
  });

  it('produces a flat string[] safe for spawn (no shell metacharacters)', () => {
    const f = parseDestroyFlags(['--export-first', '--delete-shared-prereqs']);
    const argv = teardownArgvFor(f, 'staging');
    expect(Array.isArray(argv)).toBe(true);
    for (const a of argv) {
      expect(typeof a).toBe('string');
      expect(/[;|&`$()<>\n\r]/.test(a)).toBe(false);
    }
  });
});

describe('deriveSuffix', () => {
  it('prod implies no suffix', () => {
    expect(deriveSuffix({}, 'prod')).toBe('');
  });
  it('staging implies the staging suffix when env does not set one', () => {
    expect(deriveSuffix({}, 'staging')).toBe('staging');
  });
  it('an explicit CCE_NAME_SUFFIX wins', () => {
    expect(deriveSuffix({ CCE_NAME_SUFFIX: 'pr42' }, 'staging')).toBe('pr42');
  });
});

// ─────────────────────────────────────────────────────────────────────
// Deterministic identifier set
// ─────────────────────────────────────────────────────────────────────

describe('expectedNames', () => {
  it('includes the state bucket and the audit-lock bucket, account+region embedded', () => {
    const n = makeNames('');
    expect(n.buckets).toContain(`claudeclaw-deploy-${ACCOUNT}-${REGION}`);
    expect(n.buckets.some((b) => b.includes('audit-lock'))).toBe(true);
    expect(n.tablePrefix).toBe('claudeclaw-');
    expect(n.secretPrefix).toBe('/claudeclaw/');
    expect(n.logGroupPrefix).toBe('/claudeclaw');
    expect(n.ecrRepo).toBe('claudeclaw-orchestrator');
  });

  it('applies the suffix to every identifier', () => {
    const n = makeNames('staging');
    expect(n.tablePrefix).toBe('claudeclaw-staging-');
    expect(n.secretPrefix).toBe('/claudeclaw-staging/');
    expect(n.ecrRepo).toBe('claudeclaw-staging-orchestrator');
  });
});

// ─────────────────────────────────────────────────────────────────────
// CloudFormation + manifest checks
// ─────────────────────────────────────────────────────────────────────

describe('checkCfnStacks', () => {
  it('passes when no live stacks remain', async () => {
    const c = await checkCfnStacks(cfnReturning([]), {
      stackPrefix: 'CCE',
      appTagValue: 'claudeclaw-enterprise',
    });
    expect(c.status).toBe('pass');
  });

  it('fails when a prefixed stack is still live', async () => {
    const c = await checkCfnStacks(cfnReturning([{ name: 'CCE-Network' }]), {
      stackPrefix: 'CCE',
      appTagValue: 'claudeclaw-enterprise',
    });
    expect(c.status).toBe('fail');
    expect(c.data).toEqual(['CCE-Network']);
  });

  it('fails closed (pending) when the CFN read throws', async () => {
    const cfn: CfnClientLike = {
      async describeStacks() {
        throw new Error('AccessDenied');
      },
      async deleteStack() {
        return {};
      },
    };
    const c = await checkCfnStacks(cfn, { stackPrefix: 'CCE', appTagValue: 'claudeclaw-enterprise' });
    expect(c.status).toBe('pending');
  });
});

describe('checkManifestStacks', () => {
  const opts = { stackPrefix: 'CCE', appTagValue: 'claudeclaw-enterprise' };

  it('skips when the state bucket is unreadable (break-glass)', async () => {
    const c = await checkManifestStacks(null, false, cfnReturning([]), opts);
    expect(c.status).toBe('skip');
  });

  it('passes when manifest stacks are all gone', async () => {
    const manifest = { stacks: ['CCE-Network', 'CCE-Compute'] } as DeployManifest;
    const c = await checkManifestStacks(manifest, true, cfnReturning([]), opts);
    expect(c.status).toBe('pass');
  });

  it('fails when a manifest-recorded stack is still live (caught by prefix even if untagged)', async () => {
    const manifest = { stacks: ['CCE-Network'] } as DeployManifest;
    const c = await checkManifestStacks(
      manifest,
      true,
      cfnReturning([{ name: 'CCE-Network' }]),
      opts,
    );
    expect(c.status).toBe('fail');
    expect(c.data).toEqual(['CCE-Network']);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Run-state cross-reference
// ─────────────────────────────────────────────────────────────────────

describe('checkRunStateInventory', () => {
  const state = {
    writeAheadInventory: [
      { id: 'a', type: 's3-bucket', phase: 2, plannedAt: '2026-01-01T00:00:00Z' },
    ],
  } as unknown as RunState;

  it('skips when there is no run-state', () => {
    expect(checkRunStateInventory(null, true).status).toBe('skip');
  });

  it('passes when other checks are clean', () => {
    expect(checkRunStateInventory(state, true).status).toBe('pass');
  });

  it('fails when another identifier still reports a leftover', () => {
    const c = checkRunStateInventory(state, false);
    expect(c.status).toBe('fail');
  });
});

// ─────────────────────────────────────────────────────────────────────
// Resource-identifier checks
// ─────────────────────────────────────────────────────────────────────

function notFound(): Error {
  const e = new Error('Not Found') as Error & { name: string; $metadata: { httpStatusCode: number } };
  e.name = 'NotFound';
  e.$metadata = { httpStatusCode: 404 };
  return e;
}

describe('checkBuckets', () => {
  it('passes when every expected bucket is absent (404)', async () => {
    const s3 = {
      async headBucket() {
        throw notFound();
      },
    };
    const c = await checkBuckets(s3, ['claudeclaw-config-x']);
    expect(c.status).toBe('pass');
  });

  it('fails when a bucket still exists', async () => {
    const s3 = {
      async headBucket() {
        return {};
      },
    };
    const c = await checkBuckets(s3, ['claudeclaw-config-x']);
    expect(c.status).toBe('fail');
    expect(c.data).toEqual(['claudeclaw-config-x']);
  });

  it('fails closed (pending) when a probe is a 403, not a 404', async () => {
    const s3 = {
      async headBucket() {
        const e = new Error('Forbidden') as Error & { name: string; $metadata: { httpStatusCode: number } };
        e.name = 'Forbidden';
        e.$metadata = { httpStatusCode: 403 };
        throw e;
      },
    };
    const c = await checkBuckets(s3, ['claudeclaw-config-x']);
    expect(c.status).toBe('pending');
  });
});

describe('checkTables', () => {
  it('passes when no table matches the prefix', async () => {
    const ddb = {
      async listTables() {
        return { TableNames: ['unrelated-thing'] };
      },
    };
    const c = await checkTables(ddb, 'claudeclaw-');
    expect(c.status).toBe('pass');
  });

  it('fails when a prefixed table remains', async () => {
    const ddb = {
      async listTables() {
        return { TableNames: ['claudeclaw-sessions'] };
      },
    };
    const c = await checkTables(ddb, 'claudeclaw-');
    expect(c.status).toBe('fail');
    expect(c.data).toEqual(['claudeclaw-sessions']);
  });
});

describe('checkSecrets', () => {
  it('passes when no secret matches the prefix', async () => {
    const secrets = {
      async listSecrets() {
        return { SecretList: [] };
      },
    };
    expect((await checkSecrets(secrets, '/claudeclaw/')).status).toBe('pass');
  });

  it('warns (not fails) for secrets in the recovery window', async () => {
    const secrets = {
      async listSecrets() {
        return { SecretList: [{ Name: '/claudeclaw/telegram', DeletedDate: new Date() }] };
      },
    };
    const c = await checkSecrets(secrets, '/claudeclaw/');
    expect(c.status).toBe('warn');
  });

  it('fails for an active (never scheduled) secret', async () => {
    const secrets = {
      async listSecrets() {
        return { SecretList: [{ Name: '/claudeclaw/telegram' }] };
      },
    };
    const c = await checkSecrets(secrets, '/claudeclaw/');
    expect(c.status).toBe('fail');
  });
});

describe('checkLogGroups', () => {
  it('passes when none match', async () => {
    const logs = {
      async describeLogGroups() {
        return { logGroups: [] };
      },
    };
    expect((await checkLogGroups(logs, '/claudeclaw')).status).toBe('pass');
  });

  it('fails when a log group remains', async () => {
    const logs = {
      async describeLogGroups() {
        return { logGroups: [{ logGroupName: '/claudeclaw/agent' }] };
      },
    };
    expect((await checkLogGroups(logs, '/claudeclaw')).status).toBe('fail');
  });
});

describe('checkEcrImages', () => {
  it('passes when the repo is gone (count null)', async () => {
    const c = await checkEcrImages(async () => ({ count: null }), 'claudeclaw-orchestrator');
    expect(c.status).toBe('pass');
  });

  it('fails when the repo exists but is empty (delete --force should have removed it)', async () => {
    const c = await checkEcrImages(async () => ({ count: 0 }), 'claudeclaw-orchestrator');
    expect(c.status).toBe('fail');
  });

  it('fails when images remain', async () => {
    const c = await checkEcrImages(async () => ({ count: 3 }), 'claudeclaw-orchestrator');
    expect(c.status).toBe('fail');
  });

  it('fails closed (pending) when the lister throws', async () => {
    const c = await checkEcrImages(async () => {
      throw new Error('CLI exited 255');
    }, 'claudeclaw-orchestrator');
    expect(c.status).toBe('pending');
  });
});

describe('checkNatGateways', () => {
  it('passes when only deleted/deleting NATs exist', async () => {
    const ec2 = {
      async describeNatGateways() {
        return { NatGateways: [{ NatGatewayId: 'nat-1', State: 'deleted' }] };
      },
    };
    expect((await checkNatGateways(ec2, 'claudeclaw-enterprise')).status).toBe('pass');
  });

  it('fails on an active NAT gateway even when untagged', async () => {
    const ec2 = {
      async describeNatGateways() {
        return { NatGateways: [{ NatGatewayId: 'nat-1', State: 'available', Tags: [] }] };
      },
    };
    const c = await checkNatGateways(ec2, 'claudeclaw-enterprise');
    expect(c.status).toBe('fail');
    expect(c.data).toEqual([{ id: 'nat-1', tagged: false }]);
  });
});

describe('checkLoadBalancers', () => {
  it('passes when none present', async () => {
    const elbv2 = {
      async describeLoadBalancers() {
        return { LoadBalancers: [] };
      },
    };
    expect((await checkLoadBalancers(elbv2, 'CCE')).status).toBe('pass');
  });

  it('fails when a load balancer remains', async () => {
    const elbv2 = {
      async describeLoadBalancers() {
        return { LoadBalancers: [{ LoadBalancerArn: 'arn:lb/1', LoadBalancerName: 'cce-alb' }] };
      },
    };
    expect((await checkLoadBalancers(elbv2, 'CCE')).status).toBe('fail');
  });
});

describe('checkEips', () => {
  it('passes with no addresses', async () => {
    const ec2 = {
      async describeAddresses() {
        return { Addresses: [] };
      },
    };
    expect((await checkEips(ec2)).status).toBe('pass');
  });

  it('fails on an allocated EIP', async () => {
    const ec2 = {
      async describeAddresses() {
        return { Addresses: [{ AllocationId: 'eipalloc-1' }] };
      },
    };
    const c = await checkEips(ec2);
    expect(c.status).toBe('fail');
    expect(c.data).toEqual(['eipalloc-1']);
  });
});

describe('checkFootholdIam', () => {
  const empty = {
    async listUsers() {
      return { Users: [] };
    },
    async listOpenIDConnectProviders() {
      return { OpenIDConnectProviderList: [] };
    },
    async listSAMLProviders() {
      return { SAMLProviderList: [] };
    },
  };

  it('passes a clean account', async () => {
    const c = await checkFootholdIam(empty, { deleteSharedPrereqs: false });
    expect(c.status).toBe('pass');
  });

  it('fails on a leftover IAM user (a long-lived off-account principal)', async () => {
    const iam = {
      ...empty,
      async listUsers() {
        return { Users: [{ UserName: 'leftover-user' }] };
      },
    };
    const c = await checkFootholdIam(iam, { deleteSharedPrereqs: false });
    expect(c.status).toBe('fail');
    expect(c.data).toContain('iam-user leftover-user');
  });

  it('fails on a non-GitHub OIDC federation provider', async () => {
    const iam = {
      ...empty,
      async listOpenIDConnectProviders() {
        return { OpenIDConnectProviderList: [{ Arn: 'arn:aws:iam::1:oidc-provider/evil.example.com' }] };
      },
    };
    const c = await checkFootholdIam(iam, { deleteSharedPrereqs: false });
    expect(c.status).toBe('fail');
  });

  it('warns (not fails) on the shared GitHub OIDC provider when not deleting shared prereqs', async () => {
    const iam = {
      ...empty,
      async listOpenIDConnectProviders() {
        return {
          OpenIDConnectProviderList: [
            { Arn: 'arn:aws:iam::1:oidc-provider/token.actions.githubusercontent.com' },
          ],
        };
      },
    };
    const c = await checkFootholdIam(iam, { deleteSharedPrereqs: false });
    expect(c.status).toBe('warn');
  });

  it('fails on the GitHub OIDC provider when --delete-shared-prereqs was requested', async () => {
    const iam = {
      ...empty,
      async listOpenIDConnectProviders() {
        return {
          OpenIDConnectProviderList: [
            { Arn: 'arn:aws:iam::1:oidc-provider/token.actions.githubusercontent.com' },
          ],
        };
      },
    };
    const c = await checkFootholdIam(iam, { deleteSharedPrereqs: true });
    expect(c.status).toBe('fail');
  });

  it('fails closed (pending) when an IAM read throws', async () => {
    const iam = {
      ...empty,
      async listUsers() {
        throw new Error('AccessDenied');
      },
    };
    const c = await checkFootholdIam(iam, { deleteSharedPrereqs: false });
    expect(c.status).toBe('pending');
  });
});

// ─────────────────────────────────────────────────────────────────────
// Full sweep orchestration
// ─────────────────────────────────────────────────────────────────────

function cleanClients(): SweepClients {
  return {
    cfn: cfnReturning([]),
    s3: {
      async headBucket() {
        throw notFound();
      },
    },
    ddb: {
      async listTables() {
        return { TableNames: [] };
      },
    },
    secrets: {
      async listSecrets() {
        return { SecretList: [] };
      },
    },
    logs: {
      async describeLogGroups() {
        return { logGroups: [] };
      },
    },
    ec2: {
      async describeNatGateways() {
        return { NatGateways: [] };
      },
      async describeAddresses() {
        return { Addresses: [] };
      },
    },
    elbv2: {
      async describeLoadBalancers() {
        return { LoadBalancers: [] };
      },
    },
    iam: {
      async listUsers() {
        return { Users: [] };
      },
      async listOpenIDConnectProviders() {
        return { OpenIDConnectProviderList: [] };
      },
      async listSAMLProviders() {
        return { SAMLProviderList: [] };
      },
    },
    async ecrListImages() {
      return { count: null };
    },
  };
}

describe('runDestroySweep', () => {
  it('a fully clean account yields all pass/skip checks and reconciles the inventory', async () => {
    const runState = {
      runId: 'r1',
      writeAheadInventory: [{ id: 'x', type: 's3-bucket', phase: 2, plannedAt: '2026-01-01T00:00:00Z' }],
    } as unknown as RunState;
    const checks = await runDestroySweep({
      clients: cleanClients(),
      names: makeNames(''),
      stackPrefix: 'CCE',
      appTagValue: 'claudeclaw-enterprise',
      manifest: null,
      stateBucketReadable: false,
      runState,
      deleteSharedPrereqs: false,
    });
    const bad = checks.filter((c) => c.status === 'fail' || c.status === 'pending');
    expect(bad).toEqual([]);
    const inv = checks.find((c) => c.id === 'destroy.run-state-inventory');
    expect(inv?.status).toBe('pass');
  });

  it('a leftover NAT gateway fails the sweep AND blocks inventory reconciliation', async () => {
    const clients = cleanClients();
    clients.ec2 = {
      async describeNatGateways() {
        return { NatGateways: [{ NatGatewayId: 'nat-9', State: 'available', Tags: [] }] };
      },
      async describeAddresses() {
        return { Addresses: [] };
      },
    };
    const runState = {
      runId: 'r1',
      writeAheadInventory: [{ id: 'x', type: 'nat', phase: 2, plannedAt: '2026-01-01T00:00:00Z' }],
    } as unknown as RunState;
    const checks = await runDestroySweep({
      clients,
      names: makeNames(''),
      stackPrefix: 'CCE',
      appTagValue: 'claudeclaw-enterprise',
      manifest: null,
      stateBucketReadable: false,
      runState,
      deleteSharedPrereqs: false,
    });
    expect(checks.find((c) => c.id === 'destroy.nat-gateways')?.status).toBe('fail');
    expect(checks.find((c) => c.id === 'destroy.run-state-inventory')?.status).toBe('fail');
  });

  it('a pending (un-runnable) check keeps the inventory from reconciling', async () => {
    const clients = cleanClients();
    clients.ddb = {
      async listTables() {
        throw new Error('AccessDenied');
      },
    };
    const runState = {
      runId: 'r1',
      writeAheadInventory: [],
    } as unknown as RunState;
    const checks = await runDestroySweep({
      clients,
      names: makeNames(''),
      stackPrefix: 'CCE',
      appTagValue: 'claudeclaw-enterprise',
      manifest: null,
      stateBucketReadable: false,
      runState,
      deleteSharedPrereqs: false,
    });
    expect(checks.find((c) => c.id === 'destroy.dynamodb-tables')?.status).toBe('pending');
    expect(checks.find((c) => c.id === 'destroy.run-state-inventory')?.status).toBe('fail');
  });
});

// ─────────────────────────────────────────────────────────────────────
// Import-safety: the module must not run main() on import
// ─────────────────────────────────────────────────────────────────────

describe('import safety', () => {
  it('importing destroy.ts has no side effects (no AWS, no spawn, exitCode untouched)', async () => {
    const before = process.exitCode;
    const mod = await import('./destroy.js');
    expect(typeof mod.main).toBe('function');
    expect(typeof mod.runDestroySweep).toBe('function');
    // import did not set a failure exit code or otherwise run the CLI
    expect(process.exitCode).toBe(before);
  });
});
