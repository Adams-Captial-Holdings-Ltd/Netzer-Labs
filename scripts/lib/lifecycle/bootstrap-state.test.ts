import { describe, it, expect } from 'vitest';
import {
  BOOTSTRAP_TAGS,
  bootstrapState,
  type EcrClientLike,
  ensureEcrRepo,
  ensureLockTable,
  ensureStateBucket,
  resolveStateNames,
  STATE_META_KEY,
} from './bootstrap-state.js';

const ENV = {
  AWS_ACCOUNT_ID: '111122223333',
  AWS_REGION: 'ca-central-1',
  CCE_TIER: '1',
  CCE_DEPLOY_MODE: 'infra-only',
};

function awsErr(name: string, status?: number): Error {
  return Object.assign(new Error(name), {
    name,
    ...(status !== undefined ? { $metadata: { httpStatusCode: status } } : {}),
  });
}

type Call = { client: string; name: string; input: any };

/** Send-based fake whose handlers are keyed by Command class name (sans "Command"). */
function fakeSendClient(
  clientLabel: string,
  calls: Call[],
  handlers: Record<string, (input: any) => unknown>,
) {
  return {
    send: async (cmd: any): Promise<any> => {
      const name = (cmd.constructor.name as string).replace(/Command$/, '');
      calls.push({ client: clientLabel, name, input: cmd.input });
      const handler = handlers[name];
      if (!handler) throw new Error(`fake ${clientLabel}: no handler for ${name}`);
      const result = handler(cmd.input);
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

function fakeEcr(
  calls: Call[],
  handlers: { describe: () => unknown; create?: (input: any) => unknown },
): EcrClientLike {
  return {
    describeRepositories: async (input) => {
      calls.push({ client: 'ecr', name: 'DescribeRepositories', input });
      const r = handlers.describe();
      if (r instanceof Error) throw r;
      return r;
    },
    createRepository: async (input) => {
      calls.push({ client: 'ecr', name: 'CreateRepository', input });
      const r = handlers.create ? handlers.create(input) : {};
      if (r instanceof Error) throw r;
      return r;
    },
  };
}

describe('resolveStateNames', () => {
  it('builds globally-unique bucket name from account + region', () => {
    expect(resolveStateNames(ENV)).toEqual({
      stateBucket: 'claudeclaw-deploy-111122223333-ca-central-1',
      lockTable: 'claudeclaw-deploy-lock',
      ecrRepo: 'claudeclaw-orchestrator',
    });
  });

  it('honors CCE_NAME_SUFFIX in all three names', () => {
    expect(resolveStateNames({ ...ENV, CCE_NAME_SUFFIX: 'team2' })).toEqual({
      stateBucket: 'claudeclaw-team2-deploy-111122223333-ca-central-1',
      lockTable: 'claudeclaw-team2-deploy-lock',
      ecrRepo: 'claudeclaw-team2-orchestrator',
    });
  });

  it('honors explicit DEPLOY_MANIFEST_BUCKET and ECR_REPO_NAME overrides', () => {
    const names = resolveStateNames({
      ...ENV,
      DEPLOY_MANIFEST_BUCKET: 'my-bucket',
      ECR_REPO_NAME: 'my-repo',
    });
    expect(names.stateBucket).toBe('my-bucket');
    expect(names.ecrRepo).toBe('my-repo');
  });

  it('requires account + region when the bucket name must be derived', () => {
    expect(() => resolveStateNames({})).toThrow(/AWS_ACCOUNT_ID and AWS_REGION/);
  });

  it('rejects a suffix that cannot be a bucket-name segment', () => {
    expect(() => resolveStateNames({ ...ENV, CCE_NAME_SUFFIX: 'Bad_Suffix' })).toThrow(
      /CCE_NAME_SUFFIX/,
    );
  });
});

describe('ensureStateBucket', () => {
  it('creates + hardens the bucket when absent (404)', async () => {
    const calls: Call[] = [];
    const s3 = fakeSendClient('s3', calls, {
      HeadBucket: () => awsErr('NotFound', 404),
      CreateBucket: () => ({}),
      PutBucketVersioning: () => ({}),
      PutBucketEncryption: () => ({}),
      PutPublicAccessBlock: () => ({}),
      PutBucketTagging: () => ({}),
    });
    await ensureStateBucket(s3, 'b', 'ca-central-1');
    const names = calls.map((c) => c.name);
    expect(names).toEqual([
      'HeadBucket',
      'CreateBucket',
      'PutBucketVersioning',
      'PutBucketEncryption',
      'PutPublicAccessBlock',
      'PutBucketTagging',
    ]);
    const create = calls.find((c) => c.name === 'CreateBucket')!;
    expect(create.input.CreateBucketConfiguration).toEqual({ LocationConstraint: 'ca-central-1' });
    const tagging = calls.find((c) => c.name === 'PutBucketTagging')!;
    expect(tagging.input.Tagging.TagSet).toEqual(BOOTSTRAP_TAGS);
  });

  it('omits CreateBucketConfiguration in us-east-1', async () => {
    const calls: Call[] = [];
    const s3 = fakeSendClient('s3', calls, {
      HeadBucket: () => awsErr('NotFound', 404),
      CreateBucket: () => ({}),
      PutBucketVersioning: () => ({}),
      PutBucketEncryption: () => ({}),
      PutPublicAccessBlock: () => ({}),
      PutBucketTagging: () => ({}),
    });
    await ensureStateBucket(s3, 'b', 'us-east-1');
    expect(calls.find((c) => c.name === 'CreateBucket')!.input.CreateBucketConfiguration).toBeUndefined();
  });

  it('validates an existing owned bucket and fixes up missing hardening', async () => {
    const calls: Call[] = [];
    const s3 = fakeSendClient('s3', calls, {
      HeadBucket: () => ({}),
      GetBucketVersioning: () => ({ Status: 'Suspended' }),
      PutBucketVersioning: () => ({}),
      GetBucketEncryption: () => awsErr('ServerSideEncryptionConfigurationNotFoundError', 404),
      PutBucketEncryption: () => ({}),
      GetPublicAccessBlock: () => ({
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          IgnorePublicAcls: true,
          BlockPublicPolicy: true,
          RestrictPublicBuckets: true,
        },
      }),
    });
    await ensureStateBucket(s3, 'b', 'ca-central-1');
    const names = calls.map((c) => c.name);
    expect(names).toContain('PutBucketVersioning');
    expect(names).toContain('PutBucketEncryption');
    expect(names).not.toContain('CreateBucket');
    expect(names).not.toContain('PutPublicAccessBlock');
  });

  it('a 403 on HeadBucket is a CROSS-ACCOUNT collision naming CCE_NAME_SUFFIX', async () => {
    const s3 = fakeSendClient('s3', [], { HeadBucket: () => awsErr('Forbidden', 403) });
    await expect(ensureStateBucket(s3, 'b', 'ca-central-1')).rejects.toThrow(
      /ANOTHER AWS account.*CCE_NAME_SUFFIX/s,
    );
  });

  it('BucketAlreadyExists on create is also a cross-account collision', async () => {
    const s3 = fakeSendClient('s3', [], {
      HeadBucket: () => awsErr('NotFound', 404),
      CreateBucket: () => awsErr('BucketAlreadyExists', 409),
    });
    await expect(ensureStateBucket(s3, 'b', 'ca-central-1')).rejects.toThrow(/CCE_NAME_SUFFIX/);
  });

  it('BucketAlreadyOwnedByYou proceeds to validate instead of failing', async () => {
    const calls: Call[] = [];
    const s3 = fakeSendClient('s3', calls, {
      HeadBucket: () => awsErr('NotFound', 404),
      CreateBucket: () => awsErr('BucketAlreadyOwnedByYou', 409),
      GetBucketVersioning: () => ({ Status: 'Enabled' }),
      GetBucketEncryption: () => ({}),
      GetPublicAccessBlock: () => ({
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          IgnorePublicAcls: true,
          BlockPublicPolicy: true,
          RestrictPublicBuckets: true,
        },
      }),
    });
    await ensureStateBucket(s3, 'b', 'ca-central-1');
    expect(calls.map((c) => c.name)).toContain('GetBucketVersioning');
  });
});

describe('ensureLockTable', () => {
  it('creates the table when absent and waits for ACTIVE', async () => {
    const calls: Call[] = [];
    let described = 0;
    const ddb = fakeSendClient('ddb', calls, {
      DescribeTable: () => {
        described += 1;
        if (described === 1) return awsErr('ResourceNotFoundException');
        if (described === 2) return { Table: { TableStatus: 'CREATING' } };
        return { Table: { TableStatus: 'ACTIVE' } };
      },
      CreateTable: () => ({}),
    });
    await ensureLockTable(ddb, 't', { pollMs: 1, sleep: async () => {} });
    const create = calls.find((c) => c.name === 'CreateTable')!;
    expect(create.input.BillingMode).toBe('PAY_PER_REQUEST');
    expect(create.input.KeySchema).toEqual([{ AttributeName: 'pk', KeyType: 'HASH' }]);
    expect(create.input.Tags).toEqual(BOOTSTRAP_TAGS);
    expect(described).toBe(3);
  });

  it('returns immediately when the table is already ACTIVE', async () => {
    const calls: Call[] = [];
    const ddb = fakeSendClient('ddb', calls, {
      DescribeTable: () => ({ Table: { TableStatus: 'ACTIVE' } }),
    });
    await ensureLockTable(ddb, 't');
    expect(calls.map((c) => c.name)).toEqual(['DescribeTable']);
  });

  it('times out loudly when the table never goes ACTIVE', async () => {
    const ddb = fakeSendClient('ddb', [], {
      DescribeTable: () => ({ Table: { TableStatus: 'CREATING' } }),
    });
    await expect(
      ensureLockTable(ddb, 't', { pollMs: 1, timeoutMs: 0, sleep: async () => {} }),
    ).rejects.toThrow(/still CREATING/);
  });
});

describe('ensureEcrRepo', () => {
  it('creates the repo with scan-on-push + tags when absent', async () => {
    const calls: Call[] = [];
    const ecr = fakeEcr(calls, { describe: () => awsErr('RepositoryNotFoundException') });
    await ensureEcrRepo(ecr, 'r');
    const create = calls.find((c) => c.name === 'CreateRepository')!;
    expect(create.input).toEqual({
      repositoryName: 'r',
      imageScanningConfiguration: { scanOnPush: true },
      tags: BOOTSTRAP_TAGS,
    });
  });

  it('is a no-op when the repo exists', async () => {
    const calls: Call[] = [];
    const ecr = fakeEcr(calls, { describe: () => ({ repositories: [{ repositoryName: 'r' }] }) });
    await ensureEcrRepo(ecr, 'r');
    expect(calls.map((c) => c.name)).toEqual(['DescribeRepositories']);
  });
});

describe('bootstrapState', () => {
  /** Full happy-path fakes: everything absent, creation succeeds, lock free. */
  function freshWorld() {
    const calls: Call[] = [];
    const objects = new Map<string, string>();
    let tableDescribes = 0;
    const s3 = fakeSendClient('s3', calls, {
      HeadBucket: () => awsErr('NotFound', 404),
      CreateBucket: () => ({}),
      PutBucketVersioning: () => ({}),
      PutBucketEncryption: () => ({}),
      PutPublicAccessBlock: () => ({}),
      PutBucketTagging: () => ({}),
      PutObject: (input: any) => {
        if (input.IfNoneMatch === '*' && objects.has(input.Key)) {
          return awsErr('PreconditionFailed', 412);
        }
        objects.set(input.Key, input.Body);
        return {};
      },
      GetObject: (input: any) => {
        const body = objects.get(input.Key);
        if (body === undefined) return awsErr('NoSuchKey', 404);
        return { Body: { transformToString: async () => body } };
      },
    });
    const ddb = fakeSendClient('ddb', calls, {
      DescribeTable: () => {
        tableDescribes += 1;
        return tableDescribes === 1
          ? awsErr('ResourceNotFoundException')
          : { Table: { TableStatus: 'ACTIVE' } };
      },
      CreateTable: () => ({}),
      UpdateItem: () => ({
        Attributes: { fencingToken: { N: '1' }, expiresAt: { N: '99' }, owner: { S: 'me' } },
      }),
    });
    const ecr = fakeEcr(calls, { describe: () => awsErr('RepositoryNotFoundException') });
    return { calls, objects, s3, ddb, ecr };
  }

  it('creates all three primitives, locks, then writes meta exactly once', async () => {
    const w = freshWorld();
    const result = await bootstrapState({ s3: w.s3, ddb: w.ddb, ecr: w.ecr }, ENV, {
      owner: 'me',
      operation: 'deploy',
    });
    expect(result.names.stateBucket).toBe('claudeclaw-deploy-111122223333-ca-central-1');
    expect(result.lock.fencingToken).toBe(1);

    const names = w.calls.map((c) => `${c.client}.${c.name}`);
    expect(names).toContain('s3.CreateBucket');
    expect(names).toContain('ddb.CreateTable');
    expect(names).toContain('ecr.CreateRepository');

    // meta is written ONLY AFTER the lock is acquired, with IfNoneMatch '*'.
    const lockIdx = names.indexOf('ddb.UpdateItem');
    const metaIdx = w.calls.findIndex((c) => c.name === 'PutObject' && c.input.Key === STATE_META_KEY);
    expect(lockIdx).toBeGreaterThanOrEqual(0);
    expect(metaIdx).toBeGreaterThan(lockIdx);
    expect(w.calls[metaIdx]!.input.IfNoneMatch).toBe('*');
    expect(JSON.parse(w.objects.get(STATE_META_KEY)!)).toMatchObject({
      account: '111122223333',
      region: 'ca-central-1',
      tier: 1,
      mode: 'infra-only',
    });
  });

  it('validates existing primitives without re-creating them', async () => {
    const calls: Call[] = [];
    const meta = JSON.stringify({
      account: '111122223333',
      region: 'ca-central-1',
      tier: 1,
      mode: 'infra-only',
      createdAt: 'x',
    });
    const s3 = fakeSendClient('s3', calls, {
      HeadBucket: () => ({}),
      GetBucketVersioning: () => ({ Status: 'Enabled' }),
      GetBucketEncryption: () => ({}),
      GetPublicAccessBlock: () => ({
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          IgnorePublicAcls: true,
          BlockPublicPolicy: true,
          RestrictPublicBuckets: true,
        },
      }),
      PutObject: () => awsErr('PreconditionFailed', 412),
      GetObject: () => ({ Body: { transformToString: async () => meta } }),
    });
    const ddb = fakeSendClient('ddb', calls, {
      DescribeTable: () => ({ Table: { TableStatus: 'ACTIVE' } }),
      UpdateItem: () => ({
        Attributes: { fencingToken: { N: '4' }, expiresAt: { N: '99' } },
      }),
    });
    const ecr = fakeEcr(calls, { describe: () => ({}) });

    const result = await bootstrapState({ s3, ddb, ecr }, ENV, { owner: 'me', operation: 'seed' });
    expect(result.lock.fencingToken).toBe(4);
    const names = calls.map((c) => c.name);
    expect(names).not.toContain('CreateBucket');
    expect(names).not.toContain('CreateTable');
    expect(names).not.toContain('CreateRepository');
  });

  it('surfaces the cross-account collision message', async () => {
    const w = freshWorld();
    const s3 = fakeSendClient('s3', [], { HeadBucket: () => awsErr('Forbidden', 403) });
    await expect(
      bootstrapState({ s3, ddb: w.ddb, ecr: w.ecr }, ENV, { owner: 'me', operation: 'deploy' }),
    ).rejects.toThrow(/CCE_NAME_SUFFIX/);
  });

  it('does NOT write meta when the lock cannot be acquired', async () => {
    const w = freshWorld();
    const calls: Call[] = [];
    const ddb = fakeSendClient('ddb', calls, {
      DescribeTable: () => ({ Table: { TableStatus: 'ACTIVE' } }),
      UpdateItem: () => awsErr('ConditionalCheckFailedException'),
      GetItem: () => ({
        Item: {
          owner: { S: 'someone-else' },
          operation: { S: 'teardown' },
          expiresAt: { N: '9999999999999' },
        },
      }),
    });
    await expect(
      bootstrapState({ s3: w.s3, ddb, ecr: w.ecr }, ENV, { owner: 'me', operation: 'deploy' }),
    ).rejects.toThrow(/held by "someone-else"/);
    expect(w.objects.has(STATE_META_KEY)).toBe(false);
  });

  it('throws loudly when existing meta belongs to another account/region', async () => {
    const w = freshWorld();
    // Pre-initialize meta for a DIFFERENT account.
    w.objects.set(
      STATE_META_KEY,
      JSON.stringify({ account: '999988887777', region: 'ca-central-1', tier: 0, mode: 'chat', createdAt: 'x' }),
    );
    await expect(
      bootstrapState({ s3: w.s3, ddb: w.ddb, ecr: w.ecr }, ENV, { owner: 'me', operation: 'deploy' }),
    ).rejects.toThrow(/initialized for account 999988887777.*targets 111122223333/s);
  });

  it('accepts existing meta that matches this account + region (race loser is fine)', async () => {
    const w = freshWorld();
    w.objects.set(
      STATE_META_KEY,
      JSON.stringify({ account: '111122223333', region: 'ca-central-1', tier: 1, mode: 'infra-only', createdAt: 'x' }),
    );
    await expect(
      bootstrapState({ s3: w.s3, ddb: w.ddb, ecr: w.ecr }, ENV, { owner: 'me', operation: 'deploy' }),
    ).resolves.toMatchObject({ lock: { fencingToken: 1 } });
  });
});
