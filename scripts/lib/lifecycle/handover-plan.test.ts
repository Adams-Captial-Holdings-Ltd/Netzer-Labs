import { describe, it, expect } from 'vitest';
import {
  APP_IAM_TAG,
  CONFIG_EPOCH_KEY,
  classifyIamUsers,
  forceServiceRedeploy,
  generateDashboardSecretValues,
  hashOwnerIdentity,
  inventorySecrets,
  readConfigEpoch,
  renderInventory,
  rotateAppOwnedAccessKeys,
  rotateDashboardSecret,
  runExternalCredentialGate,
  secretPopulationStatus,
  snsSubscriptionReport,
  route53NameserverReport,
  stampConfigEpoch,
  verifyOwnerPaths,
  type ExternalCredentialSpec,
  type IamHandoverClientLike,
} from './handover-plan.js';
import { createRunner } from './teardown-plan.js';
import type { AwsClientLike, LockHandle } from './lock.js';
import { buildContext, checkById, type PreflightClients } from '../preflight/checks.js';

// ─────────────────────────────────────────────────────────────────────
// Fakes — every client is injected; no real AWS or network call ever
// happens from this file.
// ─────────────────────────────────────────────────────────────────────

const lock: LockHandle = { owner: 'test', fencingToken: 7, expiresAt: 9e12, leaseMs: 60_000 };

/** Fake S3 keyed by object key; honors GetObject 404 + PutObject capture. */
function fakeS3(initial: Record<string, string> = {}): {
  client: AwsClientLike;
  objects: Map<string, string>;
  puts: () => number;
} {
  const objects = new Map(Object.entries(initial));
  let puts = 0;
  const client: AwsClientLike = {
    async send(cmd: any) {
      const name = cmd?.constructor?.name as string;
      const input = cmd?.input as { Bucket?: string; Key?: string; Body?: string };
      if (name === 'GetObjectCommand') {
        const body = objects.get(input.Key ?? '');
        if (body === undefined) {
          throw Object.assign(new Error('no such key'), {
            name: 'NoSuchKey',
            $metadata: { httpStatusCode: 404 },
          });
        }
        return { Body: body };
      }
      if (name === 'PutObjectCommand') {
        puts += 1;
        objects.set(input.Key ?? '', input.Body ?? '');
        return {};
      }
      throw new Error(`unexpected S3 command ${name}`);
    },
  };
  return { client, objects, puts: () => puts };
}

const denyS3: AwsClientLike = {
  send: async (cmd: any) => {
    const name = cmd?.constructor?.name as string;
    if (name === 'GetObjectCommand') {
      // Reads are fine in a dry run; report "nothing recorded".
      throw Object.assign(new Error('no such key'), {
        name: 'NoSuchKey',
        $metadata: { httpStatusCode: 404 },
      });
    }
    throw new Error(`MUTATION IN DRY RUN: S3 ${name}`);
  },
};

const HANDOVER_ID = 'CCE-20260611120000-abcdefabcdef-1a2b';

// ─────────────────────────────────────────────────────────────────────
// Credential classification — tagged vs untagged IAM users
// ─────────────────────────────────────────────────────────────────────

describe('classifyIamUsers', () => {
  it('rotates only users tagged app=claudeclaw; humans/untagged are checklist-only', () => {
    const result = classifyIamUsers([
      { userName: 'claudeclaw-ci', tags: [{ key: 'app', value: 'claudeclaw' }] },
      { userName: 'emmanuel', tags: [] },
      { userName: 'alice-admin', tags: [{ key: 'team', value: 'platform' }] },
      { userName: 'other-app-bot', tags: [{ key: 'app', value: 'somethingelse' }] },
    ]);
    expect(result.appOwned).toEqual(['claudeclaw-ci']);
    expect(result.checklistOnly).toEqual(['emmanuel', 'alice-admin', 'other-app-bot']);
    expect(APP_IAM_TAG).toEqual({ key: 'app', value: 'claudeclaw' });
  });

  it('rotateAppOwnedAccessKeys creates-then-deletes for app-owned users only', async () => {
    const created: string[] = [];
    const deleted: string[] = [];
    const iam: IamHandoverClientLike = {
      listUsers: async () => ({ Users: [] }),
      listUserTags: async () => ({ Tags: [] }),
      listAccessKeys: async ({ UserName }) => ({
        AccessKeyMetadata: [{ AccessKeyId: `OLD-${UserName}`, Status: 'Active' }],
      }),
      createAccessKey: async ({ UserName }) => {
        created.push(UserName);
        return { AccessKey: { AccessKeyId: `NEW-${UserName}`, SecretAccessKey: 'shhh' } };
      },
      deleteAccessKey: async ({ AccessKeyId }) => {
        deleted.push(AccessKeyId);
        return {};
      },
    };
    const runner = createRunner(true);
    const rotated = await rotateAppOwnedAccessKeys(
      iam,
      { appOwned: ['claudeclaw-ci'], checklistOnly: ['emmanuel'] },
      runner,
    );
    expect(created).toEqual(['claudeclaw-ci']); // never 'emmanuel'
    expect(deleted).toEqual(['OLD-claudeclaw-ci']);
    expect(rotated).toEqual([
      {
        userName: 'claudeclaw-ci',
        newAccessKeyId: 'NEW-claudeclaw-ci',
        newSecretAccessKey: 'shhh',
        deletedKeyIds: ['OLD-claudeclaw-ci'],
      },
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────
// External-credential gate — blocks completion until verified
// ─────────────────────────────────────────────────────────────────────

describe('runExternalCredentialGate', () => {
  const specs = (telegramOk: boolean, slackOk: boolean): ExternalCredentialSpec[] => [
    {
      id: 'telegram-bot-token',
      label: 'Telegram bot token (BotFather reissue)',
      required: true,
      verify: async () =>
        telegramOk ? { ok: true, detail: '@newbot' } : { ok: false, error: '401 Unauthorized' },
    },
    {
      id: 'slack-bot-token',
      label: 'Slack bot token (app reissue)',
      required: true,
      verify: async () =>
        slackOk ? { ok: true, detail: 'workspace acme' } : { ok: false, error: 'invalid_auth' },
    },
  ];

  it('blocks when a required value is missing', async () => {
    const result = await runExternalCredentialGate(specs(true, true), {
      'telegram-bot-token': '123:abc',
      // slack token never supplied
    });
    expect(result.complete).toBe(false);
    expect(result.missing).toEqual(['slack-bot-token']);
    expect(result.verified.map((v) => v.id)).toEqual(['telegram-bot-token']);
  });

  it('blocks when a supplied value fails live verification', async () => {
    const result = await runExternalCredentialGate(specs(true, false), {
      'telegram-bot-token': '123:abc',
      'slack-bot-token': 'xoxb-bad',
    });
    expect(result.complete).toBe(false);
    expect(result.failed).toEqual([{ id: 'slack-bot-token', error: 'invalid_auth' }]);
  });

  it('completes only when every required value is supplied AND verified', async () => {
    const result = await runExternalCredentialGate(specs(true, true), {
      'telegram-bot-token': '123:abc',
      'slack-bot-token': 'xoxb-good',
    });
    expect(result.complete).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.failed).toEqual([]);
  });

  it('an optional credential left blank does not block completion', async () => {
    const optional: ExternalCredentialSpec = {
      id: 'vendor-keys',
      label: 'Vendor API keys',
      required: false,
      verify: async () => ({ ok: true }),
    };
    const result = await runExternalCredentialGate([optional], {});
    expect(result.complete).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Config epoch — write only under the lock, only after verification
// ─────────────────────────────────────────────────────────────────────

describe('stampConfigEpoch', () => {
  const baseOpts = {
    lock,
    ownerPathsVerified: true,
    handoverId: HANDOVER_ID,
    seq: 5,
    newOwnerLabelHash: hashOwnerIdentity(['12345', 'U999']),
    now: () => new Date('2026-06-11T12:00:00Z'),
  };

  it('refuses to stamp without the lifecycle lock', async () => {
    const { client, puts } = fakeS3();
    const runner = createRunner(true);
    await expect(
      stampConfigEpoch(client, 'bucket', { ...baseOpts, runner, lock: null }),
    ).rejects.toThrow(/lock is not held/);
    expect(puts()).toBe(0);
  });

  it('refuses to stamp before owner-path verification succeeded', async () => {
    const { client, puts } = fakeS3();
    const runner = createRunner(true);
    await expect(
      stampConfigEpoch(client, 'bucket', { ...baseOpts, runner, ownerPathsVerified: false }),
    ).rejects.toThrow(/verification has not succeeded/);
    expect(puts()).toBe(0);
  });

  it('stamps epoch n+1, journals it with the fencing token, and is readable back', async () => {
    const { client, objects } = fakeS3({
      [CONFIG_EPOCH_KEY]: JSON.stringify({ epoch: 2, completedAt: 'x', newOwnerLabelHash: 'y' }),
    });
    const runner = createRunner(true);
    const record = await stampConfigEpoch(client, 'bucket', { ...baseOpts, runner });
    expect(record.epoch).toBe(3);
    expect(record.completedAt).toBe('2026-06-11T12:00:00.000Z');

    const stored = JSON.parse(objects.get(CONFIG_EPOCH_KEY) ?? '{}');
    expect(stored.epoch).toBe(3);

    const journalKey = `deploys/${HANDOVER_ID}/journal/0005-config-epoch.json`;
    const journaled = JSON.parse(objects.get(journalKey) ?? '{}');
    expect(journaled.event).toBe('config-epoch');
    expect(journaled.fencingToken).toBe(7);
    expect(journaled.data.epoch).toBe(3);

    const readBack = await readConfigEpoch(client, 'bucket');
    expect(readBack?.epoch).toBe(3);
  });

  it('first-ever handover stamps epoch 1', async () => {
    const { client } = fakeS3(); // no prior epoch object
    const runner = createRunner(true);
    const record = await stampConfigEpoch(client, 'bucket', { ...baseOpts, runner });
    expect(record.epoch).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Dry run — zero mutations through every mutating helper
// ─────────────────────────────────────────────────────────────────────

describe('--dry-run (StepRunner execute=false)', () => {
  it('records every would-be mutation and calls no client', async () => {
    const runner = createRunner(false);
    const explode = async () => {
      throw new Error('MUTATION IN DRY RUN');
    };

    await rotateDashboardSecret(
      { describeSecret: explode, putSecretValue: explode },
      '/claudeclaw/dashboard',
      generateDashboardSecretValues(),
      runner,
    );
    await rotateAppOwnedAccessKeys(
      {
        listUsers: async () => ({ Users: [] }),
        listUserTags: async () => ({ Tags: [] }),
        listAccessKeys: async () => ({ AccessKeyMetadata: [{ AccessKeyId: 'OLD', Status: 'Active' }] }),
        createAccessKey: explode,
        deleteAccessKey: explode,
      },
      { appOwned: ['claudeclaw-ci'], checklistOnly: [] },
      runner,
    );
    await forceServiceRedeploy({ updateService: explode }, 'cluster', 'service', runner);
    await stampConfigEpoch(denyS3, 'bucket', {
      lock,
      ownerPathsVerified: true,
      handoverId: HANDOVER_ID,
      seq: 9,
      newOwnerLabelHash: 'deadbeef',
      runner,
    });

    // The plan is complete and printable…
    expect(runner.actions.some((a) => a.includes('PutSecretValue'))).toBe(true);
    expect(runner.actions.some((a) => a.includes('CreateAccessKey'))).toBe(true);
    expect(runner.actions.some((a) => a.includes('DeleteAccessKey'))).toBe(true);
    expect(runner.actions.some((a) => a.includes('UpdateService'))).toBe(true);
    expect(runner.actions.some((a) => a.includes(CONFIG_EPOCH_KEY))).toBe(true);
    // …and nothing exploded, because nothing executed.
  });
});

// ─────────────────────────────────────────────────────────────────────
// Owner-path verification
// ─────────────────────────────────────────────────────────────────────

describe('verifyOwnerPaths', () => {
  it('sends a real Telegram message to every NEW owner chat and reports failures', async () => {
    const sent: string[] = [];
    const result = await verifyOwnerPaths({
      newTelegramToken: '123:abc',
      newOwnerChatIds: ['111', '222'],
      send: async (_token, chatId) => {
        sent.push(chatId);
        return chatId === '222' ? { ok: false, error: 'chat not found' } : { ok: true };
      },
      alertTopicArn: 'arn:aws:sns:us-east-1:1:alerts',
    });
    expect(sent).toEqual(['111', '222']);
    expect(result.ok).toBe(false);
    expect(result.lines.join('\n')).toContain('chat 222: FAILED');
    // SNS is an honest manual step, never a fake green check.
    expect(result.lines.join('\n')).toContain('MANUAL STEP');
  });

  it('cannot pass when owner chats exist but no new bot token was issued', async () => {
    const result = await verifyOwnerPaths({
      newOwnerChatIds: ['111'],
      send: async () => ({ ok: true }),
    });
    expect(result.ok).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Inventory + reports (metadata-only, pending-confirmation trap)
// ─────────────────────────────────────────────────────────────────────

describe('inventory + account-level reports', () => {
  it('judges secret population from DescribeSecret metadata only', () => {
    expect(secretPopulationStatus(null)).toBe('absent');
    expect(
      secretPopulationStatus({
        CreatedDate: '2026-01-01T00:00:00Z',
        LastChangedDate: '2026-01-01T00:00:30Z',
      }),
    ).toBe('placeholder-likely');
    expect(
      secretPopulationStatus({
        CreatedDate: '2026-01-01T00:00:00Z',
        LastChangedDate: '2026-03-01T00:00:00Z',
      }),
    ).toBe('populated');
    expect(
      secretPopulationStatus({
        CreatedDate: '2026-01-01T00:00:00Z',
        LastChangedDate: '2026-03-01T00:00:00Z',
        DeletedDate: '2026-06-01T00:00:00Z',
      }),
    ).toBe('pending-deletion');
  });

  it('inventories all six secrets and tolerates a missing one', async () => {
    const rows = await inventorySecrets(
      {
        describeSecret: async ({ SecretId }) => {
          if (SecretId.endsWith('/vendor-keys')) {
            throw Object.assign(new Error('gone'), { name: 'ResourceNotFoundException' });
          }
          return {
            CreatedDate: '2026-01-01T00:00:00Z',
            LastChangedDate: '2026-02-01T00:00:00Z',
          };
        },
        putSecretValue: async () => ({}),
      },
      '/claudeclaw',
    );
    expect(rows).toHaveLength(6);
    expect(rows.find((r) => r.secretId === '/claudeclaw/vendor-keys')?.population).toBe('absent');
    expect(rows.find((r) => r.secretId === '/claudeclaw/telegram')?.population).toBe('populated');

    const lines = renderInventory({
      meta: { account: '123456789012', region: 'us-east-1', tier: 2, mode: 'chat', createdAt: 'x' },
      manifest: null,
      stateBucket: 'claudeclaw-deploy-123456789012-us-east-1',
      domain: 'claw.example.com',
      secretBase: '/claudeclaw',
      secrets: rows,
      catalog: [],
      wormBucket: 'claudeclaw-audit-lock',
    });
    const text = lines.join('\n');
    expect(text).toContain('values never read');
    expect(text).toContain('configured surfaces: Slack, Telegram');
    expect(text).toContain('INTENTIONAL RESIDUAL');
  });

  it('flags SNS pending confirmations as going to the OLD operator', async () => {
    const lines = await snsSubscriptionReport(
      {
        listSubscriptionsByTopic: async () => ({
          Subscriptions: [
            { SubscriptionArn: 'arn:aws:sns:...:sub-1', Protocol: 'email', Endpoint: 'new@op.example' },
            { SubscriptionArn: 'PendingConfirmation', Protocol: 'email', Endpoint: 'old@op.example' },
          ],
        }),
      },
      'arn:aws:sns:us-east-1:1:alerts',
    );
    const text = lines.join('\n');
    expect(text).toContain('old@op.example');
    expect(text).toContain('PENDING CONFIRMATION');
    expect(text).toContain('OLD operator');
  });

  it('names the exact nameservers the registrar must keep pointing at', async () => {
    const lines = await route53NameserverReport(
      {
        listHostedZonesByName: async () => ({
          HostedZones: [{ Id: '/hostedzone/Z1', Name: 'example.com.' }],
        }),
        getHostedZone: async () => ({
          DelegationSet: { NameServers: ['ns-1.awsdns.example', 'ns-2.awsdns.example'] },
        }),
      },
      'claw.example.com',
    );
    const text = lines.join('\n');
    expect(text).toContain('ns-1.awsdns.example');
    expect(text).toContain('registrar');
  });
});

// ─────────────────────────────────────────────────────────────────────
// Dashboard secret generation
// ─────────────────────────────────────────────────────────────────────

describe('generateDashboardSecretValues', () => {
  it('returns a 64-hex token, a 4-word kill phrase, and a hashed 6-digit PIN', () => {
    const v = generateDashboardSecretValues();
    expect(v.token).toMatch(/^[0-9a-f]{64}$/);
    expect(v.killPhrase.split('-')).toHaveLength(4);
    expect(v.pin).toMatch(/^\d{6}$/);
    expect(v.pinHash).toMatch(/^[0-9a-f]{64}$/);
    expect(v.pinHash).not.toContain(v.pin);
  });
});

// ─────────────────────────────────────────────────────────────────────
// config-epoch preflight check (doctor/deploy fail on stale local config)
// ─────────────────────────────────────────────────────────────────────

describe('config-epoch preflight check', () => {
  const epochBody = JSON.stringify({
    epoch: 3,
    completedAt: '2026-06-11T12:00:00Z',
    newOwnerLabelHash: 'abc',
  });

  function ctxWith(env: Record<string, string>, s3: AwsClientLike) {
    const deny = { send: async () => { throw new Error('unexpected AWS call'); } };
    const clients: PreflightClients = {
      sts: deny, cloudFormation: deny, bedrock: deny, ec2: deny, elbv2: deny,
      s3, secretsManager: deny, iam: deny, costExplorer: deny, ssm: deny,
      serviceQuotas: deny, acm: deny, route53: deny, codeBuild: deny,
    };
    return buildContext(
      { AWS_ACCOUNT_ID: '123456789012', AWS_REGION: 'us-east-1', ...env },
      {
        clients,
        execProbe: async () => ({ code: 0, stdout: '', stderr: '' }),
        updateDiscovery: async () => {
          throw new Error('update discovery must not run in this test');
        },
      },
    );
  }

  it('FAILS when local CCE_CONFIG_EPOCH disagrees with the recorded handover state', async () => {
    const { client } = fakeS3({ [CONFIG_EPOCH_KEY]: epochBody });
    const ctx = ctxWith({ CCE_CONFIG_EPOCH: '2' }, client);
    const result = await checkById('config-epoch').run(ctx);
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('epoch 3');
    expect(result.remediation).toContain('npm run setup');
  });

  it('FAILS when the recorded epoch exists but local .env has none (stale departing-operator file)', async () => {
    const { client } = fakeS3({ [CONFIG_EPOCH_KEY]: epochBody });
    const ctx = ctxWith({}, client);
    const result = await checkById('config-epoch').run(ctx);
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('(unset)');
  });

  it('passes when local epoch matches', async () => {
    const { client } = fakeS3({ [CONFIG_EPOCH_KEY]: epochBody });
    const ctx = ctxWith({ CCE_CONFIG_EPOCH: '3' }, client);
    const result = await checkById('config-epoch').run(ctx);
    expect(result.status).toBe('pass');
  });

  it('passes when no handover was ever recorded', async () => {
    const { client } = fakeS3();
    const ctx = ctxWith({}, client);
    const result = await checkById('config-epoch').run(ctx);
    expect(result.status).toBe('pass');
    expect(result.detail).toContain('no handover');
  });
});

// ─────────────────────────────────────────────────────────────────────
// update-available preflight check (informational: pass/skip only)
// ─────────────────────────────────────────────────────────────────────

describe('update-available preflight check', () => {
  function ctxWith(
    env: Record<string, string>,
    discovery: NonNullable<Parameters<typeof buildContext>[1]>['updateDiscovery'],
  ) {
    const deny = { send: async () => { throw new Error('unexpected AWS call'); } };
    const clients: PreflightClients = {
      sts: deny, cloudFormation: deny, bedrock: deny, ec2: deny, elbv2: deny,
      s3: deny, secretsManager: deny, iam: deny, costExplorer: deny, ssm: deny,
      serviceQuotas: deny, acm: deny, route53: deny, codeBuild: deny,
    };
    return buildContext(
      { AWS_ACCOUNT_ID: '123456789012', AWS_REGION: 'us-east-1', ...env },
      { clients, execProbe: async () => ({ code: 0, stdout: '', stderr: '' }), updateDiscovery: discovery },
    );
  }

  it('renders the verified pass line with the required-actions count', async () => {
    const ctx = ctxWith({}, async () => ({
      available: true,
      latestTag: 'v1.4.0',
      currentVersion: 'v1.2.1',
      requiredActionsCount: 2,
      verified: true,
    }));
    const result = await checkById('update-available').run(ctx);
    expect(result.status).toBe('pass');
    expect(result.detail).toContain('v1.4.0 available, you run v1.2.1; 2 required actions');
  });

  it('skips (never warns/fails) when disabled, unverified, or unreachable', async () => {
    const disabled = await checkById('update-available').run(
      ctxWith({ CCE_UPDATE_CHECK_DISABLED: '1' }, async () => {
        throw new Error('must not be called when disabled');
      }),
    );
    expect(disabled.status).toBe('skip');

    const unverified = await checkById('update-available').run(
      ctxWith({}, async () => ({
        available: true,
        latestTag: 'v1.4.0',
        currentVersion: 'v1.2.1',
        verified: false,
        reason: 'unverified',
      })),
    );
    expect(unverified.status).toBe('skip');
    expect(unverified.detail).toContain('unverified');

    const unreachable = await checkById('update-available').run(
      ctxWith({}, async () => ({
        available: false,
        currentVersion: 'v1.2.1',
        verified: false,
        reason: 'unreachable',
      })),
    );
    expect(unreachable.status).toBe('skip');

    const crashed = await checkById('update-available').run(
      ctxWith({}, async () => {
        throw new Error('hook exploded');
      }),
    );
    expect(crashed.status).toBe('skip');
  });
});
