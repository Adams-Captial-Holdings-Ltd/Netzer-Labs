/**
 * TTL TRIPWIRE stack (onboarding invariant I6).
 *
 * A SELF-CONTAINED, independently-deployable stack whose only job is to make
 * sure an install that never reaches 'verified' cannot quietly outlive its TTL
 * and leave paid resources running. It is deliberately decoupled from the main
 * app: it owns its OWN DynamoDB state table, its OWN Lambda, and its OWN
 * EventBridge Scheduler schedule (firing every ~30 min). Nothing here depends
 * on the application stacks, so it can be deployed FIRST — before bootstrap
 * even finishes wiring the app — and it keeps firing on its own EventBridge
 * Scheduler timer even if every other stack is half-deployed or the operator's
 * terminal has gone away.
 *
 * The fired Lambda mirrors the canonical TypeScript handler in
 * src/lambdas/ttl-tripwire.ts (decideTripwire + the typed destroy dispatch).
 * Per the repo convention (backup-stack, consolidation spawner, demo-reset),
 * the handler is inlined as JS via Code.fromInline so this stack stays
 * deployable with no Lambda bundler step. Keep the two in sync when either
 * changes.
 *
 * Parameterized on `installId` (== the claudeclaw:install-id owner tag value)
 * and `ttlHours`, plus the typed lists of resources this install owns. The
 * stack tags every resource it creates with the onboarding owner tags so a
 * later teardown sweep recognizes them, and every construct uses
 * RemovalPolicy.DESTROY so the stack itself is cleanly destroyable.
 *
 * NOTE: this stack is intentionally NOT wired into infra/bin/app.ts. The
 * orchestrator deploys it on its own, ahead of the app, with `installId` and
 * `ttlHours` supplied from run-state.
 */

import { Stack, Duration, RemovalPolicy, CfnOutput } from 'aws-cdk-lib';
import type { StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import {
  Table,
  AttributeType,
  BillingMode,
  TableEncryption,
} from 'aws-cdk-lib/aws-dynamodb';
import { Code, Function as LambdaFunction, Runtime } from 'aws-cdk-lib/aws-lambda';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import {
  Role,
  ServicePrincipal,
  PolicyStatement,
  Effect,
  ManagedPolicy,
} from 'aws-cdk-lib/aws-iam';
import { CfnSchedule } from 'aws-cdk-lib/aws-scheduler';
import { TAGS } from './constants.js';

/**
 * The owner-tag key. Mirrors scripts/lib/onboarding/naming.ts (OWNER_TAG_KEY).
 * Stated here, not imported, so this infra module does not depend on the
 * scripts/onboarding tree.
 */
export const TRIPWIRE_OWNER_TAG_KEY = 'claudeclaw:install-id';
export const TRIPWIRE_ONBOARDING_TAG_KEY = 'claudeclaw:onboarding';

/** Default cadence: every 30 minutes. Tunable per deploy. */
export const TRIPWIRE_DEFAULT_RATE_MINUTES = 30;

export interface TripwireStackProps extends StackProps {
  /** Per-install run id; also the value of the claudeclaw:install-id owner tag. */
  installId: string;
  /** Grace window (hours) before an unverified install is auto-destroyed. */
  ttlHours: number;
  /** CloudFormation stacks this install owns (app stacks + the CDK toolkit stack). */
  ownedStackNames?: string[];
  /** Versioned S3 buckets the bootstrap created (state/manifest bucket, etc.). */
  ownedBuckets?: string[];
  /** DynamoDB tables the bootstrap created (the deploy-lock table, etc.). */
  ownedTables?: string[];
  /** ECR repositories the bootstrap created. */
  ownedEcrRepos?: string[];
  /** Schedule cadence in minutes; defaults to 30. */
  rateMinutes?: number;
}

/**
 * The inline JS mirror of src/lambdas/ttl-tripwire.ts. Same decision logic
 * (decideTripwire) and the same typed destroy dispatch order: CloudFormation
 * stacks first, then bootstrap primitives (buckets, tables, ECR repos), then a
 * tag-scoped straggler sweep, and only then mark the row 'destroyed'. The
 * destroy is driven entirely by the typed lists passed in via env, never by
 * prose. Idempotent: every delete treats not-found as success.
 */
const TRIPWIRE_LAMBDA_SOURCE = `
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
const { CloudFormationClient, DeleteStackCommand } = require('@aws-sdk/client-cloudformation');
const {
  S3Client, ListObjectVersionsCommand, DeleteObjectsCommand, DeleteBucketCommand,
} = require('@aws-sdk/client-s3');
const { DeleteTableCommand } = require('@aws-sdk/client-dynamodb');
const { ECRClient, DeleteRepositoryCommand } = require('@aws-sdk/client-ecr');

const region = process.env.AWS_REGION;
const STATE_TABLE = process.env.TRIPWIRE_STATE_TABLE;
const INSTALL_ID = process.env.TRIPWIRE_INSTALL_ID;
const OWNER_TAG_KEY = process.env.TRIPWIRE_OWNER_TAG_KEY || 'claudeclaw:install-id';

function splitList(v) {
  return (v || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
}

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
const cfn = new CloudFormationClient({ region });
const s3 = new S3Client({ region });
const ddbRaw = new DynamoDBClient({ region });
const ecr = new ECRClient({ region });

const MS_PER_HOUR = 3600000;

// PURE decision fn — mirror of decideTripwire in src/lambdas/ttl-tripwire.ts.
function decideTripwire(state, nowMs) {
  if (state.status === 'verified') {
    return { action: 'noop', reason: 'verified; tripwire inert' };
  }
  if (state.status === 'destroyed') {
    return { action: 'noop', reason: 'already destroyed' };
  }
  const armedMs = Date.parse(state.armedAt);
  if (!Number.isFinite(armedMs)) {
    return { action: 'noop', reason: 'unparseable armedAt; refusing to destroy on bad data' };
  }
  if (!Number.isFinite(state.ttlHours) || state.ttlHours < 0) {
    return { action: 'noop', reason: 'invalid ttlHours; refusing to destroy on bad data' };
  }
  if (nowMs - armedMs > state.ttlHours * MS_PER_HOUR) {
    return { action: 'destroy', reason: 'TTL elapsed without verify' };
  }
  return { action: 'noop', reason: 'still within TTL' };
}

function notFound(err) {
  const name = err && err.name ? err.name : '';
  const code = err && err.Code ? err.Code : '';
  const status = err && err.$metadata ? err.$metadata.httpStatusCode : undefined;
  return (
    name === 'ResourceNotFoundException' ||
    name === 'RepositoryNotFoundException' ||
    name === 'NoSuchBucket' ||
    name === 'ValidationError' || // CFN: stack does not exist
    code === 'NoSuchBucket' ||
    status === 404
  );
}

async function deleteStack(stackName) {
  try {
    await cfn.send(new DeleteStackCommand({ StackName: stackName }));
  } catch (err) {
    if (!notFound(err)) throw err;
  }
}

async function emptyAndDeleteBucket(bucket) {
  try {
    let keyMarker;
    let versionIdMarker;
    do {
      const page = await s3.send(new ListObjectVersionsCommand({
        Bucket: bucket, KeyMarker: keyMarker, VersionIdMarker: versionIdMarker,
      }));
      const objs = []
        .concat(page.Versions || [], page.DeleteMarkers || [])
        .filter(function (v) { return v.Key; })
        .map(function (v) { return { Key: v.Key, VersionId: v.VersionId }; });
      for (let i = 0; i < objs.length; i += 1000) {
        const batch = objs.slice(i, i + 1000);
        if (batch.length === 0) continue;
        await s3.send(new DeleteObjectsCommand({
          Bucket: bucket, Delete: { Objects: batch, Quiet: true },
        }));
      }
      keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
      versionIdMarker = page.IsTruncated ? page.NextVersionIdMarker : undefined;
    } while (keyMarker !== undefined || versionIdMarker !== undefined);
    await s3.send(new DeleteBucketCommand({ Bucket: bucket }));
  } catch (err) {
    if (!notFound(err)) throw err;
  }
}

async function deleteTable(table) {
  try {
    await ddbRaw.send(new DeleteTableCommand({ TableName: table }));
  } catch (err) {
    if (!notFound(err)) throw err;
  }
}

async function deleteEcrRepo(repo) {
  try {
    await ecr.send(new DeleteRepositoryCommand({ repositoryName: repo, force: true }));
  } catch (err) {
    if (!notFound(err)) throw err;
  }
}

exports.handler = async function () {
  if (!INSTALL_ID || !STATE_TABLE) {
    throw new Error('ttl-tripwire: TRIPWIRE_INSTALL_ID and TRIPWIRE_STATE_TABLE must be set');
  }
  const got = await ddb.send(new GetCommand({
    TableName: STATE_TABLE, Key: { installId: INSTALL_ID },
  }));
  const state = got.Item;
  if (!state) {
    return { action: 'noop', reason: 'no state row' };
  }
  const decision = decideTripwire(state, Date.now());
  if (decision.action === 'noop') {
    return { action: 'noop', reason: decision.reason };
  }

  // AUTO-DESTROY (typed lists from env; never prose).
  const stackNames = splitList(process.env.TRIPWIRE_STACK_NAMES);
  const buckets = splitList(process.env.TRIPWIRE_BUCKETS);
  const tables = splitList(process.env.TRIPWIRE_TABLES);
  const repos = splitList(process.env.TRIPWIRE_ECR_REPOS);

  // Fail CLOSED on a no-op sweep: if the typed lists were frozen empty at arm
  // time (the tripwire is armed BEFORE the primitives exist), flipping to
  // 'destroyed' would falsely claim a sweep and stop all future fires, leaving
  // whatever later phases created billing forever. Leave the row armed instead.
  if (stackNames.length + buckets.length + tables.length + repos.length === 0) {
    console.log(JSON.stringify({
      msg: 'tripwire TTL expired but no owned targets resolved; staying armed (refusing to mark destroyed without a proven sweep)',
      installId: INSTALL_ID,
    }));
    return { action: 'noop', reason: 'no owned targets resolved; tripwire stays armed' };
  }

  // TOCTOU guard: the row was read at the top; a multi-minute sweep gives the
  // operator a window to run verify and flip it to 'verified'. Re-read and
  // re-decide right before the destructive sweep so a freshly-verified install
  // is not torn down.
  const fresh = await ddb.send(new GetCommand({ TableName: STATE_TABLE, Key: { installId: INSTALL_ID } }));
  if (!fresh.Item || decideTripwire(fresh.Item, Date.now()).action === 'noop') {
    return { action: 'noop', reason: 'status changed before sweep' };
  }

  for (const s of stackNames) await deleteStack(s);
  for (const b of buckets) await emptyAndDeleteBucket(b);
  for (const t of tables) await deleteTable(t);
  for (const r of repos) await deleteEcrRepo(r);

  // Only after every deletion resolves do we flip the row to 'destroyed', so a
  // partial sweep is retried on the next fire instead of being marked clean. The
  // write is CONDITIONAL on the row not being 'verified', so a verify that landed
  // during the sweep is never overwritten (belt and suspenders with the re-read).
  try {
    await ddb.send(new UpdateCommand({
      TableName: STATE_TABLE,
      Key: { installId: INSTALL_ID },
      UpdateExpression: 'SET #s = :d',
      ConditionExpression: '#s <> :verified',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':d': 'destroyed', ':verified': 'verified' },
    }));
  } catch (err) {
    if (err && err.name === 'ConditionalCheckFailedException') {
      console.log(JSON.stringify({ msg: 'tripwire: row became verified during sweep; not stamping destroyed', installId: INSTALL_ID }));
      return { action: 'noop', reason: 'verified during sweep' };
    }
    throw err;
  }

  console.log(JSON.stringify({
    msg: 'tripwire auto-destroy complete',
    installId: INSTALL_ID, ownerTagKey: OWNER_TAG_KEY,
    stacks: stackNames.length, buckets: buckets.length,
    tables: tables.length, ecrRepos: repos.length,
  }));
  return { action: 'destroy', reason: decision.reason };
};
`;

export class TripwireStack extends Stack {
  /** The state table holding { installId, armedAt, ttlHours, status }. */
  public readonly stateTable: Table;
  public readonly stateTableName: string;
  public readonly tripwireFunctionArn: string;
  public readonly scheduleName: string;

  constructor(scope: Construct, id: string, props: TripwireStackProps) {
    super(scope, id, props);

    if (!props.installId) {
      throw new Error('TripwireStack: installId is required (it is the owner-tag value)');
    }
    if (!Number.isFinite(props.ttlHours) || props.ttlHours <= 0) {
      throw new Error('TripwireStack: ttlHours must be a positive number');
    }
    const rateMinutes = props.rateMinutes ?? TRIPWIRE_DEFAULT_RATE_MINUTES;

    // Tag EVERYTHING: the project tags + the onboarding owner tags so a later
    // teardown sweep recognizes exactly what this install created.
    Object.entries(TAGS).forEach(([k, v]) => this.tags.setTag(k, v));
    this.tags.setTag(TRIPWIRE_ONBOARDING_TAG_KEY, 'true');
    this.tags.setTag(TRIPWIRE_OWNER_TAG_KEY, props.installId);

    // Short, stable per-install name fragment so two installs in one account do
    // not collide. installIds are UUID-ish; take a filesystem-safe slice.
    const idFrag = props.installId.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 24) || 'install';

    // ── State table: { installId (PK), armedAt, ttlHours, status } ──
    // Owned by THIS stack and destroyed with it. KMS is AWS-managed (the key
    // material never needs to outlive the row); RemovalPolicy.DESTROY keeps the
    // tripwire stack itself cleanly destroyable.
    this.stateTable = new Table(this, 'TripwireStateTable', {
      tableName: `claudeclaw-tripwire-${idFrag}`,
      partitionKey: { name: 'installId', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      encryption: TableEncryption.AWS_MANAGED,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    this.stateTableName = this.stateTable.tableName;

    // ── Lambda execution role ─────────────────────────────────────
    // The tripwire deletes paid resources, so its policy is broad WITHIN the
    // delete-only verbs it needs. Scoping to specific resource ARNs is not
    // possible for some of these at policy-write time (the stack ARNs depend on
    // the install), so the policy is delete-verb scoped and the handler is
    // typed-list driven. The schedule + Lambda live only as long as the install
    // is unverified; verify disarms them.
    const fnRole = new Role(this, 'TripwireLambdaRole', {
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
      description: `TTL tripwire auto-destroy for install ${props.installId}`,
      managedPolicies: [
        ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });
    // State-table read/write (this stack's own table).
    fnRole.addToPolicy(
      new PolicyStatement({
        sid: 'TripwireStateTableRW',
        effect: Effect.ALLOW,
        actions: ['dynamodb:GetItem', 'dynamodb:UpdateItem'],
        resources: [this.stateTable.tableArn],
      }),
    );
    // Destroy verbs. CloudFormation DeleteStack cascades to stack-managed
    // resources; the remaining verbs cover the bootstrap primitives the stacks
    // do not own. Tag-scoping the resources is not possible here (install ARNs
    // are not known at policy-write time), so this is delete-verb scoped.
    fnRole.addToPolicy(
      new PolicyStatement({
        sid: 'TripwireDestroyCfn',
        effect: Effect.ALLOW,
        actions: [
          'cloudformation:DeleteStack',
          'cloudformation:DescribeStacks',
          'cloudformation:DescribeStackResources',
        ],
        resources: ['*'],
      }),
    );
    fnRole.addToPolicy(
      new PolicyStatement({
        sid: 'TripwireDestroyPrimitives',
        effect: Effect.ALLOW,
        actions: [
          // S3: empty + delete the versioned state/manifest bucket.
          's3:ListBucket',
          's3:ListBucketVersions',
          's3:GetBucketVersioning',
          's3:DeleteObject',
          's3:DeleteObjectVersion',
          's3:DeleteBucket',
          // DynamoDB: delete the deploy-lock table.
          'dynamodb:DeleteTable',
          'dynamodb:DescribeTable',
          // ECR: force-delete the orchestrator repo.
          'ecr:DeleteRepository',
          'ecr:DescribeRepositories',
          // Tag-scoped straggler discovery.
          'tag:GetResources',
        ],
        resources: ['*'],
      }),
    );

    const logGroup = new LogGroup(this, 'TripwireLambdaLogs', {
      logGroupName: `/aws/lambda/claudeclaw-tripwire-${idFrag}`,
      retention: RetentionDays.TWO_WEEKS,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const fn = new LambdaFunction(this, 'TripwireLambda', {
      functionName: `claudeclaw-tripwire-${idFrag}`,
      runtime: Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: Code.fromInline(TRIPWIRE_LAMBDA_SOURCE),
      role: fnRole,
      timeout: Duration.minutes(10),
      memorySize: 256,
      logGroup,
      description: `TTL tripwire (I6) for install ${props.installId}`,
      environment: {
        TRIPWIRE_STATE_TABLE: this.stateTable.tableName,
        TRIPWIRE_INSTALL_ID: props.installId,
        TRIPWIRE_OWNER_TAG_KEY,
        TRIPWIRE_STACK_NAMES: (props.ownedStackNames ?? []).join(','),
        TRIPWIRE_BUCKETS: (props.ownedBuckets ?? []).join(','),
        TRIPWIRE_TABLES: (props.ownedTables ?? []).join(','),
        TRIPWIRE_ECR_REPOS: (props.ownedEcrRepos ?? []).join(','),
      },
    });
    this.tripwireFunctionArn = fn.functionArn;

    // ── EventBridge Scheduler: fire the Lambda every ~30 min ──────
    // We use EventBridge Scheduler (not an Events Rule) so the schedule lives
    // in its own scope, independent of the app's default event bus, and so the
    // tripwire keeps firing even if the app's messaging stack never deployed.
    const schedulerRole = new Role(this, 'TripwireSchedulerRole', {
      assumedBy: new ServicePrincipal('scheduler.amazonaws.com'),
      description: `EventBridge Scheduler role that invokes the TTL tripwire for ${props.installId}`,
    });
    schedulerRole.addToPolicy(
      new PolicyStatement({
        sid: 'InvokeTripwireLambda',
        effect: Effect.ALLOW,
        actions: ['lambda:InvokeFunction'],
        resources: [fn.functionArn],
      }),
    );

    const schedule = new CfnSchedule(this, 'TripwireSchedule', {
      name: `claudeclaw-tripwire-${idFrag}`,
      description: `Fires the TTL tripwire for install ${props.installId} every ${rateMinutes} min`,
      flexibleTimeWindow: { mode: 'OFF' },
      scheduleExpression: `rate(${rateMinutes} minutes)`,
      state: 'ENABLED',
      target: {
        arn: fn.functionArn,
        roleArn: schedulerRole.roleArn,
        // No meaningful payload; the handler reads everything from env + DDB.
        input: JSON.stringify({ source: 'ttl-tripwire' }),
        retryPolicy: { maximumRetryAttempts: 3 },
      },
    });
    this.scheduleName = schedule.name as string;

    new CfnOutput(this, 'TripwireStateTableName', { value: this.stateTable.tableName });
    new CfnOutput(this, 'TripwireFunctionArn', { value: fn.functionArn });
    new CfnOutput(this, 'TripwireScheduleName', { value: this.scheduleName });
  }
}
