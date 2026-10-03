/** P4 WI-4.4: narrow S3 version-erasure grants, synthesized without AWS calls. */
import { createHash } from 'node:crypto';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { expect, it } from 'vitest';
import { StorageStack } from './storage-stack.js';
import { SecretsStack } from './secrets-stack.js';
import { DynamoStack } from './dynamo-stack.js';
import { MessagingStack } from './messaging-stack.js';
import { IamStack } from './iam-stack.js';

type Statement = { Sid?: string; Action?: string | string[]; Resource?: unknown; Condition?: unknown; Effect?: string };
const NEW_SIDS = ['S3ArtifactVersionDelete', 'S3ArtifactVersionList'];
const TASK_PROTECTION_SID = 'EcsTaskProtection';
const BASELINE_HASH = '836b06f8841beb6cd15bec365e8e425146dae5cb18e8ba89abe7fd054555e21b';

function statements(): Statement[] {
  const app = new App();
  const base = { env: { account: '123456789012', region: 'us-east-1' }, tier: 1 as const };
  const storage = new StorageStack(app, 'CCE-Storage', base);
  const secrets = new SecretsStack(app, 'CCE-Secrets', { ...base, dataKey: storage.dataKey });
  const dynamo = new DynamoStack(app, 'CCE-Dynamo', { ...base, dataKey: storage.dataKey });
  const messaging = new MessagingStack(app, 'CCE-Messaging', { ...base, configBucket: storage.configBucket });
  const iam = new IamStack(app, 'CCE-Iam', { ...base, storage, secrets, dynamo, messaging });
  const policies = Template.fromStack(iam).findResources('AWS::IAM::Policy');
  return Object.values(policies).flatMap((policy) =>
    ((policy.Properties as { PolicyDocument: { Statement: Statement[] } }).PolicyDocument.Statement));
}

it('P4 IAM grants only curated artifact version listing and deletion', () => {
  const rows = statements();
  const list = rows.find((row) => row.Sid === 'S3ArtifactVersionList');
  const del = rows.find((row) => row.Sid === 'S3ArtifactVersionDelete');
  expect(list, 'the task role needs ListBucketVersions on CURATED artifacts').toBeDefined();
  expect(del, 'the task role needs DeleteObjectVersion on CURATED artifacts').toBeDefined();
  expect(list).toMatchObject({ Action: 's3:ListBucketVersions', Effect: 'Allow',
    Condition: { StringLike: { 's3:prefix': 'artifacts/*' } } });
  expect(del).toMatchObject({ Action: 's3:DeleteObjectVersion', Effect: 'Allow' });
  for (const row of [list!, del!]) {
    const resource = JSON.stringify(row.Resource);
    expect(resource).toContain('CuratedBucket');
    expect(resource).not.toMatch(/RawBucket|ConfigBucket|VectorsBucket|VectorsStagingBucket/);
  }
  expect(JSON.stringify(del!.Resource)).toContain('/artifacts/*');
  expect(JSON.stringify(list!.Resource)).not.toContain('/artifacts/*'); // bucket-level action
});

it('P4 IAM leaves all existing role permissions and resources unchanged', () => {
  const rows = statements();
  expect(rows.filter((row) => NEW_SIDS.includes(row.Sid ?? '')).map((row) => row.Sid).sort(),
    'version erasure must add exactly two separate grants').toEqual(NEW_SIDS);
  const old = rows.filter((row) => !NEW_SIDS.includes(row.Sid ?? '') && row.Sid !== TASK_PROTECTION_SID);
  const hash = createHash('sha256').update(JSON.stringify(old.map((row) => JSON.stringify(row)).sort())).digest('hex');
  expect(hash, 'the 36 original statements must remain byte-identical in the synthesized policy')
    .toBe(BASELINE_HASH);
});
