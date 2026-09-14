import { describe, it, expect } from 'vitest';
import {
  assertSchemaSafety,
  buildTaskDefForRegister,
  collectPrivateEcrDigests,
  listDeployIds,
  pickPreviousDeployId,
  runRollback,
  TASK_DEF_STRIP_FIELDS,
  type CfnClientLike,
  type EcrImagesClientLike,
  type EcsClientLike,
  type RollbackDeps,
  type RollbackOptions,
  type ShellLike,
} from './rollback-classes.js';
import { ECR_LIFECYCLE_POLICY, ensureEcrLifecyclePolicy } from './bootstrap-state.js';
import { manifestKey, LATEST_MANIFEST_KEY } from './journal.js';
import type { DeployManifest } from './manifest.js';

// ─────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────

const ENV = {
  AWS_ACCOUNT_ID: '111122223333',
  AWS_REGION: 'ca-central-1',
  CDK_STACK_NAME: 'CCE',
};
const BUCKET = 'claudeclaw-deploy-111122223333-ca-central-1';
const REPO_URI = '111122223333.dkr.ecr.ca-central-1.amazonaws.com/claudeclaw-orchestrator';
const DIGEST_A = 'sha256:' + 'a'.repeat(64);
const DIGEST_B = 'sha256:' + 'b'.repeat(64);

const ID_OLD = 'CCE-20260601000000-aaaaaaaaaaaa-0001';
const ID_MID = 'CCE-20260605000000-bbbbbbbbbbbb-0002';
const ID_LIVE = 'CCE-20260610000000-cccccccccccc-0003';

function mkManifest(over: Partial<DeployManifest> = {}): DeployManifest {
  return {
    schemaVersion: 1,
    appSchemaVersion: 1,
    deployId: ID_LIVE,
    gitSha: 'c'.repeat(40),
    cleanTree: true,
    account: '111122223333',
    region: 'ca-central-1',
    tier: 1,
    mode: 'chat',
    featureFlags: {},
    imageTag: 'cccccccccccc',
    imageDigest: DIGEST_A,
    ecrRepo: REPO_URI,
    images: [
      {
        taskFamily: 'claudeclaw-orchestrator',
        containerName: 'orchestrator',
        repo: REPO_URI,
        digest: DIGEST_A,
        platform: 'linux/arm64',
      },
    ],
    cdkVersion: '2.170.0',
    synthInputs: { AWS_REGION: 'ca-central-1', CCE_TIER: '1' },
    stacks: ['CCE-Network', 'CCE-Compute'],
    stackTemplateHashes: {},
    secretVersions: [
      {
        secretId: '/claudeclaw/slack',
        versionId: 'v-slack-target',
        label: ID_LIVE,
        previousVersionId: 'v-slack-prev',
      },
      {
        secretId: '/claudeclaw/dashboard',
        versionId: 'v-dash-target',
        label: ID_LIVE,
      },
    ],
    deployedAt: '2026-06-10T00:00:00.000Z',
    ...over,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Fakes
// ─────────────────────────────────────────────────────────────────────

type Call = { name: string; input: any };

/** Send-based fake keyed by Command class name (sans "Command"). */
function fakeSendClient(calls: Call[], handlers: Record<string, (input: any) => unknown>) {
  return {
    send: async (cmd: any): Promise<any> => {
      const name = (cmd.constructor.name as string).replace(/Command$/, '');
      calls.push({ name, input: cmd.input });
      const handler = handlers[name];
      if (!handler) throw new Error(`fake client: no handler for ${name}`);
      const result = handler(cmd.input);
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

function awsErr(name: string, status?: number): Error {
  return Object.assign(new Error(name), {
    name,
    ...(status !== undefined ? { $metadata: { httpStatusCode: status } } : {}),
  });
}

/** S3 fake backed by a key→string map; records journal writes. */
function fakeS3(objects: Record<string, string>, calls: Call[], journalWrites: Call[]) {
  return fakeSendClient(calls, {
    GetObject: (input: { Key: string }) => {
      const body = objects[input.Key];
      if (body === undefined) return awsErr('NoSuchKey', 404);
      return { Body: body };
    },
    ListObjectsV2: (input: { Prefix: string }) => ({
      Contents: Object.keys(objects)
        .filter((k) => k.startsWith(input.Prefix))
        .map((Key) => ({ Key })),
      IsTruncated: false,
    }),
    PutObject: (input: { Key: string; Body: string }) => {
      journalWrites.push({ name: 'PutObject', input });
      return {};
    },
  });
}

function fakeDdb(calls: Call[]) {
  return fakeSendClient(calls, {
    UpdateItem: () => ({
      Attributes: { fencingToken: { N: '3' }, expiresAt: { N: String(Date.now() + 300_000) } },
    }),
    DeleteItem: () => ({}),
    GetItem: () => ({}),
  });
}

function fakeEcr(missingDigests: string[] = []): { client: EcrImagesClientLike; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    client: {
      describeImages: async (input) => {
        calls.push({ name: 'DescribeImages', input });
        for (const id of input.imageIds) {
          if (missingDigests.includes(id.imageDigest)) throw awsErr('ImageNotFoundException');
        }
        return { imageDetails: input.imageIds };
      },
    },
  };
}

function fakeEcs(ops: string[], liveTaskDef: Record<string, unknown>) {
  const registered: Array<Record<string, unknown>> = [];
  const updates: Array<{ cluster: string; service: string; taskDefinition?: string }> = [];
  const client: EcsClientLike = {
    describeTaskDefinition: async () => structuredClone(liveTaskDef),
    registerTaskDefinition: async (def) => {
      ops.push('register-task-def');
      registered.push(def);
      return { revision: 7 };
    },
    updateService: async (input) => {
      ops.push(input.taskDefinition ? `update-service:${input.taskDefinition}` : 'force-redeploy');
      updates.push(input);
    },
    waitServicesStable: async () => {
      ops.push('wait-stable');
    },
  };
  return { client, registered, updates };
}

const idleCfn: CfnClientLike = { stackStatus: async () => 'UPDATE_COMPLETE' };

function fakeShell(
  calls: Array<{ cmd: string; args: string[]; env?: Record<string, string> }>,
): ShellLike {
  return {
    run: async (cmd, args, o) => {
      calls.push({ cmd, args, env: (o as { env?: Record<string, string> } | undefined)?.env });
      return 0;
    },
    capture: async (cmd, args, o) => {
      calls.push({ cmd, args, env: (o as { env?: Record<string, string> } | undefined)?.env });
      return { code: 0, stdout: '', stderr: '' };
    },
  };
}

const LIVE_TASK_DEF: Record<string, unknown> = {
  family: 'claudeclaw-orchestrator',
  taskDefinitionArn: 'arn:aws:ecs:ca-central-1:111122223333:task-definition/claudeclaw-orchestrator:6',
  revision: 6,
  status: 'ACTIVE',
  requiresAttributes: [{ name: 'ecs.capability.execution-role-ecr-pull' }],
  compatibilities: ['FARGATE'],
  registeredAt: '2026-06-10T00:00:00Z',
  registeredBy: 'arn:aws:iam::111122223333:user/x',
  cpu: '1024',
  memory: '2048',
  containerDefinitions: [
    { name: 'orchestrator', image: `${REPO_URI}:cccccccccccc`, environment: [{ name: 'X', value: '1' }] },
    { name: 'xray-daemon', image: 'public.ecr.aws/xray/aws-xray-daemon@sha256:' + 'd'.repeat(64) },
  ],
};

interface SetupOptions {
  current?: DeployManifest;
  target?: DeployManifest;
  extraObjects?: Record<string, string>;
  missingDigests?: string[];
  secretHandlers?: Record<string, (input: any) => unknown>;
}

function setup(o: SetupOptions = {}) {
  const current = o.current ?? mkManifest();
  const target =
    o.target ??
    mkManifest({
      deployId: ID_MID,
      gitSha: 'b'.repeat(40),
      imageTag: 'bbbbbbbbbbbb',
      imageDigest: DIGEST_B,
      images: [
        {
          taskFamily: 'claudeclaw-orchestrator',
          containerName: 'orchestrator',
          repo: REPO_URI,
          digest: DIGEST_B,
          platform: 'linux/arm64',
        },
      ],
      deployedAt: '2026-06-05T00:00:00.000Z',
    });

  const objects: Record<string, string> = {
    [LATEST_MANIFEST_KEY]: JSON.stringify(current),
    [manifestKey(current.deployId)]: JSON.stringify(current),
    [manifestKey(target.deployId)]: JSON.stringify(target),
    ...(o.extraObjects ?? {}),
  };

  const s3Calls: Call[] = [];
  const journalWrites: Call[] = [];
  const ddbCalls: Call[] = [];
  const secretCalls: Call[] = [];
  const ops: string[] = [];
  const shellCalls: Array<{ cmd: string; args: string[]; env?: Record<string, string> }> = [];

  const ecr = fakeEcr(o.missingDigests ?? []);
  const ecs = fakeEcs(ops, LIVE_TASK_DEF);

  // Default secret state: each recorded version exists, AWSCURRENT sits on
  // a different (newer) version that the rollback displaces.
  const secrets = fakeSendClient(secretCalls, {
    DescribeSecret: (input: { SecretId: string }) => ({
      VersionIdsToStages: {
        [`v-live-${input.SecretId}`]: ['AWSCURRENT'],
        'v-slack-target': [ID_MID],
        'v-dash-target': [ID_MID],
      },
    }),
    UpdateSecretVersionStage: (input: { SecretId: string }) => {
      ops.push(`stage-move:${input.SecretId}`);
      return {};
    },
    ...(o.secretHandlers ?? {}),
  });

  const deps: RollbackDeps = {
    s3: fakeS3(objects, s3Calls, journalWrites),
    ddb: fakeDdb(ddbCalls),
    secrets,
    ecr: ecr.client,
    ecs: ecs.client,
    cfn: idleCfn,
    shell: fakeShell(shellCalls),
    env: { ...ENV },
    mkTempDir: () => '/tmp/fake',
    writeFile: () => {},
  };

  return { deps, current, target, s3Calls, journalWrites, ddbCalls, secretCalls, ops, shellCalls, ecr, ecs };
}

function opts(over: Partial<RollbackOptions> & Pick<RollbackOptions, 'rollbackClass'>): RollbackOptions {
  return {
    to: ID_MID,
    dryRun: false,
    acceptSchemaDowngrade: false,
    rebuildFromGit: false,
    owner: 'test@host#1',
    envFlag: 'prod',
    repoRoot: '/repo',
    heartbeatMs: 60_000,
    ...over,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Schema-version safety (item 18)
// ─────────────────────────────────────────────────────────────────────

describe('schema-version safety', () => {
  it('refuses a downgrade with neither override flag', async () => {
    const { deps, ddbCalls, ops } = setup({
      current: mkManifest({ appSchemaVersion: 2 }),
      target: mkManifest({ deployId: ID_MID, gitSha: 'b'.repeat(40), appSchemaVersion: 1 }),
    });
    await expect(runRollback(deps, opts({ rollbackClass: 'config' }))).rejects.toThrow(/REFUSED/);
    expect(ops).toEqual([]); // no mutations
    expect(ddbCalls).toEqual([]); // not even the lock
  });

  it('refuses with --accept-schema-downgrade but NO migration plan', async () => {
    const { deps } = setup({
      current: mkManifest({ appSchemaVersion: 2 }),
      target: mkManifest({ deployId: ID_MID, gitSha: 'b'.repeat(40), appSchemaVersion: 1 }),
    });
    await expect(
      runRollback(deps, opts({ rollbackClass: 'config', acceptSchemaDowngrade: true })),
    ).rejects.toThrow(/migration-plan/);
  });

  it('refuses with a migration plan but WITHOUT --accept-schema-downgrade', async () => {
    const { deps } = setup({
      current: mkManifest({ appSchemaVersion: 2 }),
      target: mkManifest({ deployId: ID_MID, gitSha: 'b'.repeat(40), appSchemaVersion: 1 }),
    });
    await expect(
      runRollback(deps, opts({ rollbackClass: 'config', migrationPlan: 'revert migration 7' })),
    ).rejects.toThrow(/REFUSED/);
  });

  it('proceeds with BOTH flags and records the plan text in the journal', async () => {
    const { deps, journalWrites } = setup({
      current: mkManifest({ appSchemaVersion: 2 }),
      target: mkManifest({ deployId: ID_MID, gitSha: 'b'.repeat(40), appSchemaVersion: 1 }),
    });
    const result = await runRollback(
      deps,
      opts({
        rollbackClass: 'config',
        acceptSchemaDowngrade: true,
        migrationPlan: 'run scripts/migrations/007-revert.ts before traffic resumes',
      }),
    );
    expect(result.dryRun).toBe(false);
    const start = journalWrites.find((w) => String(w.input.Key).includes('-rollback-start'));
    expect(start).toBeDefined();
    const body = JSON.parse(start!.input.Body);
    expect(body.data.schemaDowngradeAccepted).toBe(true);
    expect(body.data.migrationPlan).toBe('run scripts/migrations/007-revert.ts before traffic resumes');
  });

  it('assertSchemaSafety allows same and upgrade versions silently', () => {
    expect(
      assertSchemaSafety(mkManifest({ appSchemaVersion: 1 }), mkManifest({ appSchemaVersion: 1 }), {
        acceptSchemaDowngrade: false,
      }),
    ).toBe(false);
    expect(
      assertSchemaSafety(mkManifest({ appSchemaVersion: 1 }), mkManifest({ appSchemaVersion: 2 }), {
        acceptSchemaDowngrade: false,
      }),
    ).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Image class (item 18)
// ─────────────────────────────────────────────────────────────────────

describe('image class', () => {
  it('preflight fails EARLY, naming the pruned digest, before any ECS call', async () => {
    const { deps, ops, ddbCalls } = setup({ missingDigests: [DIGEST_B] });
    await expect(runRollback(deps, opts({ rollbackClass: 'image' }))).rejects.toThrow(
      new RegExp(DIGEST_B.replace(/[:]/g, '[:]')),
    );
    expect(ops).toEqual([]); // no register/update/wait happened
    expect(ddbCalls).toEqual([]); // failed before the lock — nothing touched
  });

  it('clones the live task def, swaps the orchestrator image BY DIGEST, rolls, waits', async () => {
    const { deps, ops, ecs } = setup();
    const result = await runRollback(deps, opts({ rollbackClass: 'image' }));
    expect(ops).toEqual([
      'register-task-def',
      'update-service:claudeclaw-orchestrator:7',
      'wait-stable',
    ]);
    const def = ecs.registered[0];
    const containers = def.containerDefinitions as Array<Record<string, unknown>>;
    expect(containers.find((c) => c.name === 'orchestrator')?.image).toBe(`${REPO_URI}@${DIGEST_B}`);
    // sidecar untouched; register-rejected fields stripped (buildspec jq parity)
    expect(containers.find((c) => c.name === 'xray-daemon')?.image).toContain('public.ecr.aws');
    for (const f of TASK_DEF_STRIP_FIELDS) expect(def[f]).toBeUndefined();
    expect(result.actions).toContain('register-task-definition:claudeclaw-orchestrator:7');
  });
});

// ─────────────────────────────────────────────────────────────────────
// Config class (item 21)
// ─────────────────────────────────────────────────────────────────────

describe('config class', () => {
  it('preflight fails when a recorded VersionId no longer exists, before any mutation', async () => {
    const { deps, ops, ddbCalls } = setup({
      secretHandlers: {
        DescribeSecret: (input: { SecretId: string }) =>
          input.SecretId === '/claudeclaw/dashboard'
            ? { VersionIdsToStages: { 'v-other': ['AWSCURRENT'] } } // recorded version pruned
            : { VersionIdsToStages: { 'v-slack-target': [ID_MID], 'v-x': ['AWSCURRENT'] } },
      },
    });
    await expect(runRollback(deps, opts({ rollbackClass: 'config' }))).rejects.toThrow(
      /\/claudeclaw\/dashboard.*v-dash-target/s,
    );
    expect(ops).toEqual([]);
    expect(ddbCalls).toEqual([]);
  });

  it('moves AWSCURRENT on ALL secrets first, THEN forces one redeploy and waits', async () => {
    const { deps, ops, secretCalls } = setup();
    const result = await runRollback(deps, opts({ rollbackClass: 'config' }));
    expect(ops).toEqual([
      'stage-move:/claudeclaw/slack',
      'stage-move:/claudeclaw/dashboard',
      'force-redeploy',
      'wait-stable',
    ]);
    // the stage moves carry MoveTo + the displaced RemoveFrom version
    const moves = secretCalls.filter((c) => c.name === 'UpdateSecretVersionStage');
    expect(moves[0].input).toMatchObject({
      SecretId: '/claudeclaw/slack',
      VersionStage: 'AWSCURRENT',
      MoveToVersionId: 'v-slack-target',
      RemoveFromVersionId: 'v-live-/claudeclaw/slack',
    });
    expect(result.actions).toEqual([
      'stage-move:/claudeclaw/slack',
      'stage-move:/claudeclaw/dashboard',
      'force-new-deployment:claudeclaw-service',
    ]);
  });

  it('skips a secret whose recorded version is already AWSCURRENT', async () => {
    const { deps, ops } = setup({
      secretHandlers: {
        DescribeSecret: (input: { SecretId: string }) =>
          input.SecretId === '/claudeclaw/slack'
            ? { VersionIdsToStages: { 'v-slack-target': ['AWSCURRENT', ID_MID] } }
            : { VersionIdsToStages: { 'v-dash-target': [ID_MID], 'v-live': ['AWSCURRENT'] } },
      },
    });
    await runRollback(deps, opts({ rollbackClass: 'config' }));
    expect(ops).toEqual(['stage-move:/claudeclaw/dashboard', 'force-redeploy', 'wait-stable']);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Target resolution (--to=previous)
// ─────────────────────────────────────────────────────────────────────

describe('--to=previous', () => {
  it('picks the newest promoted deploy that is not the live one', async () => {
    const older = mkManifest({ deployId: ID_OLD, gitSha: 'a'.repeat(40) });
    const { deps } = setup({
      extraObjects: { [manifestKey(ID_OLD)]: JSON.stringify(older) },
    });
    const result = await runRollback(deps, opts({ rollbackClass: 'image', to: 'previous', dryRun: true }));
    expect(result.currentDeployId).toBe(ID_LIVE);
    expect(result.targetDeployId).toBe(ID_MID); // newest != live, NOT ID_OLD
  });

  it('pickPreviousDeployId throws when only the live deploy exists', () => {
    expect(() => pickPreviousDeployId([ID_LIVE], ID_LIVE)).toThrow(/Nothing to roll back/);
  });

  it('listDeployIds ignores journal objects and sorts newest first', async () => {
    const calls: Call[] = [];
    const s3 = fakeS3(
      {
        [manifestKey(ID_OLD)]: '{}',
        [manifestKey(ID_LIVE)]: '{}',
        [manifestKey(ID_MID)]: '{}',
        [`deploys/${ID_MID}/journal/0001-image-pushed.json`]: '{}',
        [`deploys/${ID_MID}/cdk.out.zip`]: 'zip',
      },
      calls,
      [],
    );
    expect(await listDeployIds(s3, BUCKET)).toEqual([ID_LIVE, ID_MID, ID_OLD]);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Dry-run: zero mutations
// ─────────────────────────────────────────────────────────────────────

describe('--dry-run', () => {
  it('image: plans + preflights but mutates NOTHING (no lock, no journal, no ECS)', async () => {
    const { deps, ops, ddbCalls, journalWrites, ecr } = setup();
    const result = await runRollback(deps, opts({ rollbackClass: 'image', dryRun: true }));
    expect(result.dryRun).toBe(true);
    expect(result.actions).toEqual([]);
    expect(ops).toEqual([]); // no register / update-service / wait
    expect(ddbCalls).toEqual([]); // lock never acquired (it is a write)
    expect(journalWrites).toEqual([]); // journal writes are mutations too
    expect(ecr.calls.length).toBeGreaterThan(0); // preflight reads DID run
  });

  it('config: describes secrets but never moves a stage or rolls the service', async () => {
    const { deps, ops, ddbCalls, journalWrites, secretCalls } = setup();
    await runRollback(deps, opts({ rollbackClass: 'config', dryRun: true }));
    expect(ops).toEqual([]);
    expect(ddbCalls).toEqual([]);
    expect(journalWrites).toEqual([]);
    expect(secretCalls.every((c) => c.name === 'DescribeSecret')).toBe(true);
  });

  it('infra: fetches + unzips + diffs the archived assembly, never deploys', async () => {
    const target = mkManifest({
      deployId: ID_MID,
      gitSha: 'b'.repeat(40),
      cdkOutArchiveKey: `deploys/${ID_MID}/cdk.out.zip`,
    });
    const { deps, shellCalls, ddbCalls, journalWrites } = setup({
      target,
      extraObjects: { [`deploys/${ID_MID}/cdk.out.zip`]: 'PK-zip-bytes' },
    });
    await runRollback(deps, opts({ rollbackClass: 'infra', dryRun: true }));
    const cmds = shellCalls.map((c) => `${c.cmd} ${c.args[0] ?? ''}${c.args[1] ? ' ' + c.args[1] : ''}`);
    expect(cmds).toContain('unzip -q -o');
    expect(shellCalls.some((c) => c.cmd === 'npx' && c.args[1] === 'diff')).toBe(true);
    expect(shellCalls.some((c) => c.cmd === 'npx' && c.args[1] === 'deploy')).toBe(false);
    expect(ddbCalls).toEqual([]);
    expect(journalWrites).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Infra class specifics
// ─────────────────────────────────────────────────────────────────────

describe('infra class', () => {
  it('refuses the git fallback without --rebuild-from-git when the archive is gone', async () => {
    const target = mkManifest({ deployId: ID_MID, gitSha: 'b'.repeat(40) });
    delete (target as Partial<DeployManifest>).cdkOutArchiveKey;
    const { deps } = setup({ target });
    await expect(runRollback(deps, opts({ rollbackClass: 'infra' }))).rejects.toThrow(
      /--rebuild-from-git/,
    );
  });

  it('deploys the archived assembly with --app and diffs first', async () => {
    const target = mkManifest({
      deployId: ID_MID,
      gitSha: 'b'.repeat(40),
      cdkOutArchiveKey: `deploys/${ID_MID}/cdk.out.zip`,
    });
    const { deps, shellCalls, journalWrites } = setup({
      target,
      extraObjects: { [`deploys/${ID_MID}/cdk.out.zip`]: 'PK-zip-bytes' },
    });
    await runRollback(deps, opts({ rollbackClass: 'infra' }));
    const npx = shellCalls.filter((c) => c.cmd === 'npx');
    expect(npx[0].args.slice(0, 4)).toEqual(['cdk', 'diff', '--app', '/tmp/fake/cdk.out']);
    expect(npx[1].args).toEqual([
      'cdk',
      'deploy',
      '--app',
      '/tmp/fake/cdk.out',
      '--all',
      '--require-approval',
      'never',
    ]);
    // diff strictly before deploy
    expect(shellCalls.findIndex((c) => c.args[1] === 'diff')).toBeLessThan(
      shellCalls.findIndex((c) => c.args[1] === 'deploy'),
    );
    expect(journalWrites.some((w) => String(w.input.Key).includes('rollback-infra-deploy-complete'))).toBe(
      true,
    );
  });

  // ── The tier, on the rebuild-from-git path ────────────────────────
  //
  // Since Phase 9 the tier decides what EXISTS, not just how big it is: the
  // whole Paperclip substrate is provisioned at Tier 1+ and empty at Tier 0.
  // This path builds the child env from `synthInputs` ALONE — process.env is
  // deliberately not spread — so a manifest with no tier key falls through to
  // app.ts's `?? '1'`. On a Tier 0 install that means a ROLLBACK newly creates
  // a RETAIN'd, deletion-protected Aurora cluster. Adding DEPLOY_TIER to
  // SYNTH_INPUT_ALLOWLIST only helps manifests written from now on; every
  // manifest already in a state bucket was written when the list held
  // CCE_TIER, which cdkEnvBag never set.
  function tierlessTarget(): DeployManifest {
    const target = mkManifest({ deployId: ID_MID, gitSha: 'b'.repeat(40) });
    delete (target as Partial<DeployManifest>).cdkOutArchiveKey;
    target.synthInputs = { AWS_REGION: 'ca-central-1' };
    return target;
  }

  it('refuses a manifest that records no tier, rather than defaulting to 1', async () => {
    const target = tierlessTarget();
    const { deps } = setup({ target });
    delete deps.env.CCE_TIER;
    delete deps.env.DEPLOY_TIER;
    const prevC = process.env.CCE_TIER;
    const prevD = process.env.DEPLOY_TIER;
    delete process.env.CCE_TIER;
    delete process.env.DEPLOY_TIER;
    try {
      await expect(
        runRollback(deps, opts({ rollbackClass: 'infra', rebuildFromGit: true })),
      ).rejects.toThrow(/records no deploy tier/);
    } finally {
      if (prevC !== undefined) process.env.CCE_TIER = prevC;
      if (prevD !== undefined) process.env.DEPLOY_TIER = prevD;
    }
  });

  it('injects the exported tier under BOTH spellings when the manifest has none', async () => {
    const target = tierlessTarget();
    const { deps, shellCalls } = setup({ target });
    const prevC = process.env.CCE_TIER;
    process.env.CCE_TIER = '0';
    try {
      await runRollback(deps, opts({ rollbackClass: 'infra', rebuildFromGit: true }));
    } finally {
      if (prevC === undefined) delete process.env.CCE_TIER;
      else process.env.CCE_TIER = prevC;
    }
    const synth = shellCalls.find((c) => c.cmd === 'npx' && c.args[1] === 'deploy');
    // app.ts reads `CCE_TIER ?? DEPLOY_TIER`; the driver's cdkEnvBag forwards
    // both from one value, and so must this.
    expect(synth?.env?.CCE_TIER).toBe('0');
    expect(synth?.env?.DEPLOY_TIER).toBe('0');
  });

  it('prefers the tier the manifest actually recorded', async () => {
    const target = mkManifest({ deployId: ID_MID, gitSha: 'b'.repeat(40) });
    delete (target as Partial<DeployManifest>).cdkOutArchiveKey;
    target.synthInputs = { AWS_REGION: 'ca-central-1', DEPLOY_TIER: '2' };
    const { deps, shellCalls } = setup({ target });
    const prevC = process.env.CCE_TIER;
    process.env.CCE_TIER = '0';
    try {
      await runRollback(deps, opts({ rollbackClass: 'infra', rebuildFromGit: true }));
    } finally {
      if (prevC === undefined) delete process.env.CCE_TIER;
      else process.env.CCE_TIER = prevC;
    }
    const synth = shellCalls.find((c) => c.cmd === 'npx' && c.args[1] === 'deploy');
    expect(synth?.env?.CCE_TIER).toBe('2');
    expect(synth?.env?.DEPLOY_TIER).toBe('2');
  });

  // ── The image, on the rebuild-from-git path (release plan P5) ─────
  //
  // The rebuilt task definition must pin the image the target deploy ran, and
  // since P5 that is its DIGEST: compute-stack.ts reads CCE_IMAGE_DIGEST ahead
  // of the tag. The real shell merges this env OVER process.env
  // (scripts/rollback.ts:150), so leaving the key out does not leave it unset —
  // a digest exported in the operator's shell would pin the rollback to THAT
  // image. A manifest written before digests were recorded therefore gets an
  // EMPTY digest, which compute-stack treats as unset, falling back to the
  // recorded tag exactly as before.
  function digestTarget(): DeployManifest {
    const target = mkManifest({
      deployId: ID_MID,
      gitSha: 'b'.repeat(40),
      imageTag: 'bbbbbbbbbbbb',
      imageDigest: DIGEST_B,
    });
    delete (target as Partial<DeployManifest>).cdkOutArchiveKey;
    return target;
  }

  /** The synth env of the `cdk diff` preview and of the `cdk deploy`. Both must agree. */
  function cdkChildEnvs(
    shellCalls: Array<{ cmd: string; args: string[]; env?: Record<string, string> }>,
  ): Array<Record<string, string>> {
    const diff = shellCalls.find((c) => c.cmd === 'npx' && c.args[1] === 'diff');
    const deploy = shellCalls.find((c) => c.cmd === 'npx' && c.args[1] === 'deploy');
    expect(diff?.env, 'the cdk diff preview received no synth env').toBeDefined();
    expect(deploy?.env, 'the cdk deploy received no synth env').toBeDefined();
    return [diff!.env!, deploy!.env!];
  }

  it('replays the recorded image digest, and still the tag, into the rebuilt synth env', async () => {
    const { deps, shellCalls } = setup({ target: digestTarget() });
    await runRollback(deps, opts({ rollbackClass: 'infra', rebuildFromGit: true }));
    for (const env of cdkChildEnvs(shellCalls)) {
      expect(env.CCE_IMAGE_DIGEST).toBe(DIGEST_B);
      expect(env.CCE_IMAGE_TAG).toBe('bbbbbbbbbbbb');
    }
  });

  it('blanks the digest for a manifest that predates it, so an exported one cannot leak in', async () => {
    const target = digestTarget();
    delete (target as Partial<DeployManifest>).imageDigest;
    const { deps, shellCalls } = setup({ target });
    await runRollback(deps, opts({ rollbackClass: 'infra', rebuildFromGit: true }));
    const STALE = 'sha256:' + 'e'.repeat(64);
    for (const env of cdkChildEnvs(shellCalls)) {
      // What the child process actually receives: the operator's shell, overlaid by this env.
      const effective = { CCE_IMAGE_DIGEST: STALE, ...env };
      expect(effective.CCE_IMAGE_DIGEST).toBe('');
      expect(env.CCE_IMAGE_TAG).toBe('bbbbbbbbbbbb');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// Pure helpers
// ─────────────────────────────────────────────────────────────────────

describe('buildTaskDefForRegister', () => {
  it('strips exactly the buildspec jq del() fields and swaps only the named container', () => {
    const def = buildTaskDefForRegister(LIVE_TASK_DEF, `${REPO_URI}@${DIGEST_B}`);
    for (const f of TASK_DEF_STRIP_FIELDS) expect(f in def).toBe(false);
    expect(def.family).toBe('claudeclaw-orchestrator');
    expect(def.cpu).toBe('1024');
    const containers = def.containerDefinitions as Array<Record<string, unknown>>;
    expect(containers[0].image).toBe(`${REPO_URI}@${DIGEST_B}`);
    expect(containers[0].environment).toEqual([{ name: 'X', value: '1' }]); // env preserved
    expect(containers[1].image).toContain('public.ecr.aws'); // sidecar untouched
  });

  it('fails loud when the container is missing', () => {
    expect(() =>
      buildTaskDefForRegister({ containerDefinitions: [{ name: 'other' }] }, 'img'),
    ).toThrow(/no container named "orchestrator"/);
  });
});

describe('collectPrivateEcrDigests', () => {
  it('verifies private-ECR digests, dedupes, and reports public registries separately', () => {
    const m = mkManifest({
      images: [
        {
          taskFamily: 'claudeclaw-orchestrator',
          containerName: 'orchestrator',
          repo: REPO_URI,
          digest: DIGEST_A, // same as manifest.imageDigest → deduped
          platform: 'linux/arm64',
        },
        {
          taskFamily: 'claudeclaw-orchestrator',
          containerName: 'xray-daemon',
          repo: 'public.ecr.aws/xray/aws-xray-daemon',
          digest: 'sha256:' + 'd'.repeat(64),
          platform: 'per-index (multi-arch manifest list)',
        },
      ],
    });
    const { toVerify, skippedPublic } = collectPrivateEcrDigests(m, 'claudeclaw-orchestrator');
    expect(toVerify).toEqual([{ repositoryName: 'claudeclaw-orchestrator', digest: DIGEST_A }]);
    expect(skippedPublic).toEqual(['public.ecr.aws/xray/aws-xray-daemon@sha256:' + 'd'.repeat(64)]);
  });
});

// ─────────────────────────────────────────────────────────────────────
// ECR lifecycle policy (item 18, bootstrap-state)
// ─────────────────────────────────────────────────────────────────────

describe('ECR lifecycle policy', () => {
  it('keeps exactly one rule: the newest 50 images, of any tag status', () => {
    // The untagged-expiry rule is gone since release plan P5. It assumed an
    // untagged image is never a rollback target, and a digest-pinned task
    // definition ends that: a same-commit re-push moves the tag, so the digest a
    // live or rollback revision pins loses every tag, and the rule would expire
    // an image ECS still has to pull. The count rule alone bounds the repo.
    expect(ECR_LIFECYCLE_POLICY.rules).toEqual([
      {
        rulePriority: 2,
        description: 'keep only the newest 50 images (deploy tags are the only tags we push)',
        selection: { tagStatus: 'any', countType: 'imageCountMoreThan', countNumber: 50 },
        action: { type: 'expire' },
      },
    ]);
  });

  it('ensureEcrLifecyclePolicy puts valid JSON and is a no-op for clients without support', async () => {
    const puts: Array<{ repositoryName: string; lifecyclePolicyText: string }> = [];
    const withSupport = {
      describeRepositories: async () => ({}),
      createRepository: async () => ({}),
      putLifecyclePolicy: async (input: { repositoryName: string; lifecyclePolicyText: string }) => {
        puts.push(input);
        return {};
      },
    };
    expect(await ensureEcrLifecyclePolicy(withSupport, 'claudeclaw-orchestrator')).toBe('applied');
    expect(puts).toHaveLength(1);
    expect(puts[0].repositoryName).toBe('claudeclaw-orchestrator');
    expect(JSON.parse(puts[0].lifecyclePolicyText)).toEqual(ECR_LIFECYCLE_POLICY);

    const withoutSupport = {
      describeRepositories: async () => ({}),
      createRepository: async () => ({}),
    };
    expect(await ensureEcrLifecyclePolicy(withoutSupport, 'x')).toBe('unsupported');
  });
});
