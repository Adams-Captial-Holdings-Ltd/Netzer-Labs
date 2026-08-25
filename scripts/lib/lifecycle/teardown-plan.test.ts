import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  accountMismatchWarning,
  buildTeardownPlan,
  checkTypedConfirmation,
  classifyCatalog,
  confirmationString,
  codebuildGithubProjects,
  createRunner,
  currentAppStackNames,
  ddbExportCommands,
  deleteOrphanStacks,
  deleteRuntimeSchedules,
  emptyAndDeleteVersionedBucket,
  eraseKmsKey,
  findKmsDependents,
  kmsDeletionDecision,
  listLiveStacks,
  oidcDependentRoles,
  parseCatalog,
  planStacks,
  resolveCatalogName,
  scheduleDeleteSecrets,
  SECRET_RECOVERY_WINDOW_DAYS,
  wormResidualNotice,
  type CatalogEntry,
  type CfnClientLike,
  type S3TeardownClientLike,
  type SchedulerClientLike,
} from './teardown-plan.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const CATALOG_PATH = join(__dir, '..', '..', '..', 'docs', 'out-of-band-catalog.json');

function realCatalog(): CatalogEntry[] {
  return parseCatalog(readFileSync(CATALOG_PATH, 'utf8'));
}

// ─────────────────────────────────────────────────────────────────────
// Catalog: app-owned vs shared classification
// ─────────────────────────────────────────────────────────────────────

describe('out-of-band catalog classification', () => {
  it('parses the committed catalog and validates every entry', () => {
    const entries = realCatalog();
    expect(entries.length).toBeGreaterThanOrEqual(10);
    const ids = entries.map((e) => e.id);
    // The three bootstrap primitives must be cataloged (plan item 6).
    expect(ids).toContain('state-bucket');
    expect(ids).toContain('deploy-lock-table');
    expect(ids).toContain('private-ecr-repo');
  });

  it('classifies the three bootstrap primitives as app-owned + deletable', () => {
    const { appOwned } = classifyCatalog(realCatalog());
    const ownedIds = appOwned.map((e) => e.id);
    for (const id of ['state-bucket', 'deploy-lock-table', 'private-ecr-repo']) {
      expect(ownedIds).toContain(id);
      const entry = appOwned.find((e) => e.id === id);
      expect(entry?.createdBy).toBe('bootstrap-state');
      expect(entry?.teardown).toBe('delete');
    }
  });

  it('classifies OIDC provider, CodeBuild credential, and CDKToolkit as shared + report-only', () => {
    const { sharedPrereqs } = classifyCatalog(realCatalog());
    const sharedIds = sharedPrereqs.map((e) => e.id);
    expect(sharedIds).toContain('github-oidc-provider');
    expect(sharedIds).toContain('codebuild-source-credential');
    expect(sharedIds).toContain('cdk-bootstrap-stack');
    // Invariant: shared prerequisites are NEVER 'delete' in the catalog.
    for (const e of sharedPrereqs) expect(e.teardown).toBe('report-only');
  });

  it('rejects a catalog where a shared prerequisite claims teardown=delete', () => {
    const bad = JSON.stringify([
      {
        id: 'x', kind: 'k', nameOrPattern: 'n', createdBy: 'cli-runbook',
        ownership: 'shared-account-prerequisite', teardown: 'delete', notes: 'n',
      },
    ]);
    expect(() => parseCatalog(bad)).toThrow(/report-only/);
  });

  it('resolves <suffix>/<account>/<region> placeholders (suffix carries the hyphen)', () => {
    const ctx = { suffix: 'staging', account: '111122223333', region: 'us-east-1' };
    expect(resolveCatalogName('claudeclaw<suffix>-deploy-<account>-<region>', ctx)).toBe(
      'claudeclaw-staging-deploy-111122223333-us-east-1',
    );
    expect(
      resolveCatalogName('claudeclaw<suffix>-deploy-lock', { ...ctx, suffix: '' }),
    ).toBe('claudeclaw-deploy-lock');
  });
});

// ─────────────────────────────────────────────────────────────────────
// Stacks come from LIVE CFN + manifest, never from a fresh synth
// ─────────────────────────────────────────────────────────────────────

describe('stack plan: live + manifest, not a fresh synth', () => {
  it('includes a live CodeBuild stack the current app no longer synthesizes', () => {
    // CodeBuild was enabled at deploy time; the flag is off today, so a
    // fresh synth would silently omit it. The plan must still find it.
    const currentApp = currentAppStackNames('CCE', { CCE_CODEBUILD_ENABLED: undefined });
    expect(currentApp).not.toContain('CCE-CodeBuild');

    const plan = planStacks({
      liveStackNames: ['CCE-Network', 'CCE-Storage', 'CCE-CodeBuild'],
      manifestStacks: ['CCE-Network', 'CCE-Storage', 'CCE-CodeBuild'],
      currentAppStacks: currentApp,
    });
    const codebuild = plan.find((s) => s.name === 'CCE-CodeBuild');
    expect(codebuild).toBeDefined();
    expect(codebuild?.live).toBe(true);
    expect(codebuild?.inCurrentApp).toBe(false);
    // Absent from the current app → direct DeleteStack, not cdk destroy.
    expect(codebuild?.method).toBe('direct-delete');
    expect(plan.find((s) => s.name === 'CCE-Network')?.method).toBe('cdk-destroy');
  });

  it('always lists the Paperclip stacks so a live Aurora takes the cdk-destroy path', () => {
    // The Aurora cluster carries deletionProtection. A stack this list omits
    // is classified "not in the current app" and routed to direct
    // DeleteStack, which cannot delete a deletion-protected cluster.
    //
    // UNCONDITIONAL since Phase 9. The three Paperclip stacks are constructed
    // at every tier and gated INSIDE (TierShape.paperclipEnabled), so `cdk ls`
    // prints them in every configuration and this list must too — including
    // for an install that later dropped to Tier 0, where the stacks are empty
    // but the RETAIN'd cluster from its Tier 1 past is still very much alive.
    const names = currentAppStackNames('CCE', {});
    expect(names).toContain('CCE-Database');
    expect(names).toContain('CCE-Filesystem');
    expect(names).toContain('CCE-Paperclip');
    // The old env gate is gone, and must not come back through the back door:
    // this list may not vary with CCE_PAPERCLIP_ENABLED, which is now a
    // runtime router flag that provisions nothing.
    expect(currentAppStackNames('CCE', { CCE_PAPERCLIP_ENABLED: '1' })).toEqual(names);
    expect(currentAppStackNames('CCE', { CCE_PAPERCLIP_ENABLED: '0' })).toEqual(names);

    // EQUALITY, not toContain. `toContain` only proves the names you thought
    // to name are present; it cannot see a stack nobody remembered. This list
    // spot-checked three Paperclip names and passed while silently missing
    // CCE-PowerSwitch, so it returned 17 names where `cdk ls` prints 18 and
    // the comment above it claimed the counts already agreed.
    //
    // This literal is the verified output of `npx cdk ls` (18, and now the
    // same 18 with CCE_PAPERCLIP_ENABLED unset, '0' and '1' — see
    // infra/bin/app.stack-set.test.ts, which synthesizes the app for real
    // rather than transcribing it). If you add a stack to infra/bin/app.ts,
    // this test fails until this list is updated — which is the whole point:
    // the failure is the reminder.
    expect(names).toHaveLength(18);
    expect([...names].sort()).toEqual(
      [
        'CCE-Backup',
        'CCE-Chaos',
        'CCE-Compute',
        'CCE-CostGuardrails',
        'CCE-Database',
        'CCE-Dynamo',
        'CCE-Extensions',
        'CCE-Filesystem',
        'CCE-Guardrails',
        'CCE-Iam',
        'CCE-Messaging',
        'CCE-Network',
        'CCE-Observability',
        'CCE-Paperclip',
        'CCE-PowerSwitch',
        'CCE-Security',
        'CCE-Secrets',
        'CCE-Storage',
      ].sort(),
    );

    const plan = planStacks({
      liveStackNames: ['CCE-Network', 'CCE-Database'],
      manifestStacks: ['CCE-Network', 'CCE-Database'],
      currentAppStacks: names,
    });
    expect(plan.find((s) => s.name === 'CCE-Database')?.method).toBe('cdk-destroy');
  });

  it('unions manifest-only stacks (already-deleted ones are skipped, not lost)', () => {
    const plan = planStacks({
      liveStackNames: ['CCE-Network'],
      manifestStacks: ['CCE-Network', 'CCE-Extensions'],
      currentAppStacks: ['CCE-Network', 'CCE-Extensions'],
    });
    const ext = plan.find((s) => s.name === 'CCE-Extensions');
    expect(ext?.live).toBe(false);
    expect(ext?.inManifest).toBe(true);
    expect(ext?.method).toBe('skip-already-deleted');
  });

  it('listLiveStacks filters by prefix OR app tag, drops deleted + nested stacks', async () => {
    const fakeCfn: CfnClientLike = {
      async describeStacks() {
        return {
          Stacks: [
            { StackName: 'CCE-Network', StackStatus: 'CREATE_COMPLETE' },
            { StackName: 'CCE-Old', StackStatus: 'DELETE_COMPLETE' },
            { StackName: 'unrelated-app', StackStatus: 'CREATE_COMPLETE' },
            {
              StackName: 'tagged-but-renamed',
              StackStatus: 'UPDATE_COMPLETE',
              Tags: [{ Key: 'Application', Value: 'claudeclaw-enterprise' }],
            },
            {
              StackName: 'CCE-Nested-ABC',
              StackStatus: 'CREATE_COMPLETE',
              ParentId: 'arn:aws:cloudformation:us-east-1:1:stack/CCE-Network/x',
            },
          ],
        };
      },
      async deleteStack() {
        return {};
      },
    };
    const live = await listLiveStacks(fakeCfn, {
      stackPrefix: 'CCE',
      appTagValue: 'claudeclaw-enterprise',
    });
    expect(live).toEqual(['CCE-Network', 'tagged-but-renamed']);
  });
});

// ─────────────────────────────────────────────────────────────────────
// KMS: blocked by default, dependents listed (item 24)
// ─────────────────────────────────────────────────────────────────────

describe('KMS deletion decisions', () => {
  const inventory = {
    buckets: [
      { name: 'claudeclaw-curated-1-us-east-1', kmsKeyRef: 'arn:aws:kms:us-east-1:1:key/key-curated' },
      { name: 'claudeclaw-raw-1-us-east-1', kmsKeyRef: 'arn:aws:kms:us-east-1:1:key/key-data' },
    ],
    tables: [{ name: 'claudeclaw-sessions', kmsKeyRef: 'arn:aws:kms:us-east-1:1:key/key-data' }],
    logGroups: [{ name: '/claudeclaw/orchestrator', kmsKeyRef: 'key-logs' }],
    secrets: [{ name: '/claudeclaw/slack' }],
  };

  it('lists exact live encrypted dependents per key', () => {
    expect(findKmsDependents('key-data', inventory)).toEqual([
      's3 bucket claudeclaw-raw-1-us-east-1',
      'dynamodb table claudeclaw-sessions',
    ]);
    expect(findKmsDependents('key-logs', inventory)).toEqual(['log group /claudeclaw/orchestrator']);
  });

  it('blocks deletion when dependents exist, even with --cryptographic-erasure', () => {
    const dependents = findKmsDependents('key-data', inventory);
    const d = kmsDeletionDecision({ keyRef: 'alias/claudeclaw-data', cryptographicErasure: true, dependents });
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain('s3 bucket claudeclaw-raw-1-us-east-1');
    expect(d.reason).toContain('dynamodb table claudeclaw-sessions');
    expect(d.reason).toContain('permanently unreadable');
  });

  it('blocks deletion by default even with zero dependents', () => {
    const d = kmsDeletionDecision({ keyRef: 'alias/claudeclaw-data', cryptographicErasure: false, dependents: [] });
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain('--cryptographic-erasure');
    expect(d.reason).toContain('7–30 day window');
  });

  it('allows erase only with the flag AND zero dependents, stating the window', () => {
    const d = kmsDeletionDecision({ keyRef: 'alias/claudeclaw-data', cryptographicErasure: true, dependents: [] });
    expect(d.allowed).toBe(true);
    expect(d.reason).toContain('7-day window');
  });

  it('eraseKmsKey refuses a disallowed decision and never calls the client', async () => {
    const calls: string[] = [];
    const kms = {
      disableKey: async () => { calls.push('disable'); return {}; },
      scheduleKeyDeletion: async () => { calls.push('schedule'); return {}; },
    };
    const runner = createRunner(true);
    const blocked = kmsDeletionDecision({ keyRef: 'k', cryptographicErasure: false, dependents: [] });
    await expect(eraseKmsKey(kms, 'k', blocked, runner)).rejects.toThrow(/refusing to erase/);
    expect(calls).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Break-glass (item 25)
// ─────────────────────────────────────────────────────────────────────

describe('break-glass teardown plan', () => {
  const base = {
    account: '111122223333',
    region: 'us-east-1',
    stateBucket: 'claudeclaw-deploy-111122223333-us-east-1',
    liveStackNames: ['CCE-Network', 'CCE-Storage'],
    currentAppStacks: currentAppStackNames('CCE', {}),
    catalog: realCatalog(),
  };

  it('degrades (banner + extra confirmation + loud lock skip) when the state bucket is gone', () => {
    const plan = buildTeardownPlan({
      ...base,
      stateBucketAccessible: false,
      manifest: null,
      lockHeld: false,
    });
    expect(plan.degraded).toBe(true);
    expect(plan.banner).toContain('BREAK-GLASS');
    expect(plan.banner).toContain('Manifest-backed precision');
    expect(plan.requireExtraAccountConfirmation).toBe(true);
    expect(plan.lockSkipped).toBe(true);
    // Still plans from live CFN + catalog — never strands paid resources.
    expect(plan.stacks.map((s) => s.name)).toEqual(['CCE-Network', 'CCE-Storage']);
    expect(plan.catalogShared.length).toBeGreaterThan(0);
  });

  it('runs normally (no banner, no extra confirmation) when state is healthy', () => {
    const plan = buildTeardownPlan({
      ...base,
      stateBucketAccessible: true,
      manifest: { account: '111122223333', stacks: ['CCE-Network', 'CCE-Storage'] },
      lockHeld: true,
    });
    expect(plan.degraded).toBe(false);
    expect(plan.banner).toBeNull();
    expect(plan.requireExtraAccountConfirmation).toBe(false);
    expect(plan.lockSkipped).toBe(false);
    expect(plan.accountWarning).toBeNull();
  });

  it('warns when the manifest records a DIFFERENT account than live STS', () => {
    const plan = buildTeardownPlan({
      ...base,
      stateBucketAccessible: true,
      manifest: { account: '999988887777', stacks: [] },
      lockHeld: true,
    });
    expect(plan.accountWarning).toContain('999988887777');
    expect(plan.accountWarning).toContain('111122223333');
    expect(plan.accountWarning).toContain('WRONG-ACCOUNT');
  });
});

// ─────────────────────────────────────────────────────────────────────
// Typed confirmation
// ─────────────────────────────────────────────────────────────────────

describe('typed confirmation', () => {
  it('requires exactly "destroy <account-id>" against the LIVE account', () => {
    expect(confirmationString('111122223333')).toBe('destroy 111122223333');
    expect(checkTypedConfirmation('destroy 111122223333', '111122223333')).toBe(true);
    expect(checkTypedConfirmation('  destroy 111122223333  ', '111122223333')).toBe(true);
    expect(checkTypedConfirmation('destroy 999988887777', '111122223333')).toBe(false);
    expect(checkTypedConfirmation('destroy', '111122223333')).toBe(false);
    expect(checkTypedConfirmation('yes', '111122223333')).toBe(false);
    expect(checkTypedConfirmation('DESTROY 111122223333', '111122223333')).toBe(false);
  });

  it('account mismatch warning only fires on a genuine mismatch', () => {
    expect(accountMismatchWarning('1', '1')).toBeNull();
    expect(accountMismatchWarning('1', undefined)).toBeNull();
    expect(accountMismatchWarning('1', '2')).toContain('WRONG-ACCOUNT');
  });
});

// ─────────────────────────────────────────────────────────────────────
// Dry run: full plan, ZERO mutations (fakes record every call)
// ─────────────────────────────────────────────────────────────────────

describe('dry run makes zero mutating calls', () => {
  function recordingFakes() {
    const mutations: string[] = [];
    const reads: string[] = [];
    const s3: S3TeardownClientLike = {
      async listObjectVersions(input) {
        reads.push(`listObjectVersions ${input.Bucket}`);
        return {
          Versions: [
            { Key: 'a.json', VersionId: 'v1' },
            { Key: 'a.json', VersionId: 'v2' },
          ],
          DeleteMarkers: [{ Key: 'b.json', VersionId: 'm1' }],
          IsTruncated: false,
        };
      },
      async deleteObjects(input) {
        mutations.push(`deleteObjects ${input.Bucket} x${input.Delete.Objects.length}`);
        return {};
      },
      async deleteBucket(input) {
        mutations.push(`deleteBucket ${input.Bucket}`);
        return {};
      },
    };
    const scheduler: SchedulerClientLike = {
      async listSchedules(input) {
        reads.push(`listSchedules ${input.GroupName}`);
        return { Schedules: [{ Name: 'task-1' }, { Name: 'task-2' }] };
      },
      async deleteSchedule(input) {
        mutations.push(`deleteSchedule ${input.Name}`);
        return {};
      },
    };
    const secrets = {
      async deleteSecret(input: { SecretId: string; RecoveryWindowInDays: number }) {
        mutations.push(`deleteSecret ${input.SecretId} window=${input.RecoveryWindowInDays}`);
        return {};
      },
    };
    const cfn: CfnClientLike = {
      async describeStacks() {
        reads.push('describeStacks');
        return { Stacks: [] };
      },
      async deleteStack(input) {
        mutations.push(`deleteStack ${input.StackName}`);
        return {};
      },
    };
    const kms = {
      async disableKey(input: { KeyId: string }) {
        mutations.push(`disableKey ${input.KeyId}`);
        return {};
      },
      async scheduleKeyDeletion(input: { KeyId: string; PendingWindowInDays: number }) {
        mutations.push(`scheduleKeyDeletion ${input.KeyId} window=${input.PendingWindowInDays}`);
        return {};
      },
    };
    return { mutations, reads, s3, scheduler, secrets, cfn, kms };
  }

  it('records the full action plan but never calls a mutating method', async () => {
    const f = recordingFakes();
    const runner = createRunner(false); // ← dry run

    await emptyAndDeleteVersionedBucket(f.s3, 'claudeclaw-curated-1-us-east-1', runner);
    await scheduleDeleteSecrets(f.secrets, ['/claudeclaw/slack', '/claudeclaw/telegram'], runner);
    const schedules = await deleteRuntimeSchedules(f.scheduler, 'claudeclaw', runner);
    await deleteOrphanStacks(
      f.cfn,
      planStacks({
        liveStackNames: ['CCE-CodeBuild'],
        manifestStacks: [],
        currentAppStacks: currentAppStackNames('CCE', {}),
      }),
      runner,
    );
    const allowed = kmsDeletionDecision({ keyRef: 'alias/x', cryptographicErasure: true, dependents: [] });
    await eraseKmsKey(f.kms, 'key-1', allowed, runner);

    // The PLAN is complete…
    expect(schedules).toEqual(['task-1', 'task-2']);
    expect(runner.actions.length).toBeGreaterThanOrEqual(8);
    expect(runner.actions.join('\n')).toContain('s3:DeleteBucket claudeclaw-curated-1-us-east-1');
    expect(runner.actions.join('\n')).toContain(`recovery window ${SECRET_RECOVERY_WINDOW_DAYS} days`);
    expect(runner.actions.join('\n')).toContain('scheduler:DeleteSchedule claudeclaw/task-1');
    expect(runner.actions.join('\n')).toContain('cloudformation:DeleteStack CCE-CodeBuild');
    expect(runner.actions.join('\n')).toContain('kms:ScheduleKeyDeletion key-1');
    // …and ZERO mutations happened. Reads are fine; that is what a plan is.
    expect(f.mutations).toEqual([]);
    expect(f.reads.length).toBeGreaterThan(0);
  });

  it('execute=true drives the same steps through the real client methods', async () => {
    const f = recordingFakes();
    const runner = createRunner(true);
    await emptyAndDeleteVersionedBucket(f.s3, 'b', runner);
    await scheduleDeleteSecrets(f.secrets, ['/claudeclaw/slack'], runner);
    expect(f.mutations).toContain('deleteObjects b x3');
    expect(f.mutations).toContain('deleteBucket b');
    expect(f.mutations).toContain(`deleteSecret /claudeclaw/slack window=${SECRET_RECOVERY_WINDOW_DAYS}`);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Shared-prereq dependents + WORM + misc
// ─────────────────────────────────────────────────────────────────────

describe('shared prerequisite blast radius helpers', () => {
  it('finds IAM roles trusting the OIDC provider (URL-encoded trust docs)', () => {
    const providerArn = 'arn:aws:iam::1:oidc-provider/token.actions.githubusercontent.com';
    const roles = [
      { roleName: 'cce-deploy', assumeRolePolicyDocument: encodeURIComponent(JSON.stringify({ Statement: [{ Principal: { Federated: providerArn } }] })) },
      { roleName: 'other-team-ci', assumeRolePolicyDocument: encodeURIComponent(JSON.stringify({ Statement: [{ Principal: { Federated: providerArn } }] })) },
      { roleName: 'unrelated', assumeRolePolicyDocument: encodeURIComponent(JSON.stringify({ Statement: [{ Principal: { Service: 'ec2.amazonaws.com' } }] })) },
    ];
    expect(oidcDependentRoles(roles, providerArn)).toEqual(['cce-deploy', 'other-team-ci']);
  });

  it('finds CodeBuild projects riding the account GitHub credential', () => {
    expect(
      codebuildGithubProjects([
        { name: 'cce-deploy', sourceType: 'GITHUB' },
        { name: 'legacy', sourceType: 'GITHUB_ENTERPRISE' },
        { name: 's3-source', sourceType: 'S3' },
      ]),
    ).toEqual(['cce-deploy', 'legacy']);
  });
});

describe('WORM residual + export commands', () => {
  it('worm notice names bypass-governance permission, command, and ongoing cost', () => {
    const notice = wormResidualNotice('claudeclaw-audit-lock-1-us-east-1');
    expect(notice).toContain('INTENTIONAL RESIDUAL');
    expect(notice).toContain('s3:BypassGovernanceRetention');
    expect(notice).toContain('--bypass-governance-retention');
    expect(notice).toContain('ONGOING COST');
  });

  it('ddb export commands target the right table ARNs and bucket', () => {
    const cmds = ddbExportCommands({
      tables: ['claudeclaw-sessions'],
      account: '111122223333',
      region: 'us-east-1',
      bucket: 'claudeclaw-deploy-111122223333-us-east-1',
    });
    expect(cmds).toHaveLength(1);
    expect(cmds[0]).toContain('arn:aws:dynamodb:us-east-1:111122223333:table/claudeclaw-sessions');
    expect(cmds[0]).toContain('--s3-bucket claudeclaw-deploy-111122223333-us-east-1');
  });
});
