import { Stack } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import {
  Role,
  ServicePrincipal,
  PolicyStatement,
  Effect,
  FederatedPrincipal,
  ManagedPolicy,
  OpenIdConnectProvider,
} from 'aws-cdk-lib/aws-iam';
import { APP, TAGS, RESOURCE_NAMES } from './constants.js';
import { resolveGithubOidcTrust } from './github-oidc.js';
import type {
  BaseStackProps,
  IamOutputs,
  StorageOutputs,
  SecretsOutputs,
  DynamoOutputs,
  MessagingOutputs,
} from './interfaces.js';

export interface IamStackProps extends BaseStackProps {
  storage: StorageOutputs;
  secrets: SecretsOutputs;
  dynamo: DynamoOutputs;
  /** A1: messaging outputs (scheduled-fire queue + scheduler exec role). */
  messaging: MessagingOutputs;
}

/**
 * IAM roles for the Fargate task.
 *
 * Grants are expressed exclusively as PolicyStatements on the task role,
 * never as `.grantX(role)` calls into resources owned by other stacks.
 * The bidirectional grants would create circular cross-stack dependencies.
 * KMS, S3, Secrets, and DDB rely on their default account-root key/resource
 * policies to permit IAM-based access in conjunction with our role policy.
 */
/**
 * `ecr:RepositoryName` patterns the CI deploy role may create.
 *
 * Every ECR repo name the deploy can bootstrap MUST match one of these, or the
 * run dies with AccessDeniedException at the image-build phase — before
 * `cdk deploy`, so it cannot apply its own fix. `iam-ecr-create.test.ts` checks
 * this list against `buildResourceNames()` for a range of `CCE_NAME_SUFFIX`
 * values, so adding a repo to `constants.ts` without adding it here fails the
 * build rather than a deploy.
 */
export const ECR_CREATE_NAME_PATTERNS = [
  'claudeclaw-orchestrator',
  'claudeclaw-*-orchestrator',
  'claudeclaw-paperclip',
  'claudeclaw-*-paperclip',
];

export class IamStack extends Stack implements IamOutputs {
  public readonly taskRole: Role;

  constructor(scope: Construct, id: string, props: IamStackProps) {
    super(scope, id, props);
    Object.entries(TAGS).forEach(([k, v]) => this.tags.setTag(k, v));

    const secretArns = [
      props.secrets.slackSecret.secretArn,
      props.secrets.telegramSecret.secretArn,
      props.secrets.dashboardSecret.secretArn,
      props.secrets.dbEncryptionSecret.secretArn,
      props.secrets.bedrockGuardrailsSecret.secretArn,
      // Vendor keys: the security-posture reader DescribeSecret's it via
      // CCE_SECRET_VENDOR_KEYS_ARN (metadata only, never the value).
      props.secrets.vendorKeysSecret.secretArn,
    ];
    const tableArns = [
      props.dynamo.sessionsTable.tableArn,
      props.dynamo.hiveMindTable.tableArn,
      props.dynamo.auditLogTable.tableArn,
      props.dynamo.chatConfigTable.tableArn,
      props.dynamo.tokenUsageTable.tableArn,
      props.dynamo.memoriesTable.tableArn,
      props.dynamo.consolidationsTable.tableArn,
      props.dynamo.agentFileHistoryTable.tableArn,
      props.dynamo.missionTasksTable.tableArn,
      props.dynamo.scheduledTasksTable.tableArn,
      props.dynamo.killSwitchesTable.tableArn,
      props.dynamo.interAgentTasksTable.tableArn,
      props.dynamo.compactionEventsTable.tableArn,
      props.dynamo.queueLeaseTable.tableArn,
      props.dynamo.identitiesTable.tableArn,
      // Dashboard tokens: read at auth time (lookupToken) and written by the
      // root-token seed. Without this grant the fail-closed Jarvis WS handshake
      // and every per-operator token login fail, so the task role must read and
      // write it.
      props.dynamo.dashboardTokensTable.tableArn,
      // v5.6 tables
      props.dynamo.hookIdempotencyTable.tableArn,
      props.dynamo.spawnLedgerTable.tableArn,
      props.dynamo.extensionSubnetPoolTable.tableArn,
      props.dynamo.extensionsRegistryTable.tableArn,
      props.dynamo.warroomMeetingsTable.tableArn,
      props.dynamo.warroomTurnsTable.tableArn,
      props.dynamo.warroomConnectionsTable.tableArn,
      props.dynamo.rateLimitsTable.tableArn,
      props.dynamo.agentsTable.tableArn,
      props.dynamo.runtimeConfigTable.tableArn,
      // Wave 4a: multi-user + RBAC table (user profiles + magic-link tokens).
      // The auth router reads/writes user rows on invite/accept/login/verify
      // and mints sessions; the members router lists/updates/disables users.
      // Referenced by deterministic ARN (not the typed DynamoOutputs prop) so
      // the grant lands without widening the cross-stack interface contract;
      // the table name is fixed at module-load from RESOURCE_NAMES, identical
      // to how the budget + scheduler ARNs are built in this same stack.
      `arn:aws:dynamodb:${this.region}:${this.account}:table/${RESOURCE_NAMES.ddb.users}`,
      // Jarvis (Phase 1). Canary is read-mostly, but the admin-gated
      // POST/DELETE /api/jarvis/canary endpoint runs as this same task role, so
      // it is granted RW like the rest (the admin wall is the app-layer
      // requiredRole check, consistent with every other dashboard write).
      props.dynamo.jarvisTicketsTable.tableArn,
      props.dynamo.jarvisLeasesTable.tableArn,
      props.dynamo.jarvisLedgerTable.tableArn,
      props.dynamo.jarvisCanaryTable.tableArn,
      // C2-full: the atomic spend ledger. Conditional single-item writes +
      // TransactWriteItems only; covered by the shared DdbRW action set.
      props.dynamo.spendLedgerTable.tableArn,
    ];
    const tableArnsWithIndexes = tableArns.flatMap((arn) => [arn, `${arn}/index/*`]);
    const bucketArns = [
      props.storage.configBucket.bucketArn,
      props.storage.rawBucket.bucketArn,
      props.storage.curatedBucket.bucketArn,
      props.storage.vectorsStagingBucket.bucketArn,
    ];
    const kmsKeyArns = [
      props.storage.dataKey.keyArn,
      props.storage.curatedKey.keyArn,
      // LogsKey encrypts the ops-alerts SNS topic; the task role publishes to
      // it (cost-watch alerter, ops alerts), so it needs GenerateDataKey/Decrypt
      // on this key too. (Was previously only present as deployed drift.)
      props.storage.logsKey.keyArn,
    ];

    // ─── Task role (application runtime) ────────────────────────
    this.taskRole = new Role(this, 'TaskRole', {
      assumedBy: new ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'Application runtime role for ClaudeClaw orchestrator',
    });

    // Bedrock model invoke + Guardrails + cross-region inference profiles.
    // Codex #3: must cover source region foundation model + every
    // destination region the profile fans out to.
    this.taskRole.addToPolicy(
      new PolicyStatement({
        sid: 'BedrockInvoke',
        effect: Effect.ALLOW,
        actions: [
          'bedrock:InvokeModel',
          'bedrock:InvokeModelWithResponseStream',
          'bedrock:Converse',
          'bedrock:ConverseStream',
          'bedrock:ApplyGuardrail',
        ],
        resources: [
          // Claude foundation models in source + cross-region destinations.
          // The us.* profile fans out to us-east-1, us-east-2, us-west-2.
          // The eu.* profile fans out to eu-central-1, eu-west-1, eu-north-1.
          `arn:aws:bedrock:${this.region}::foundation-model/anthropic.claude-*`,
          `arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-*`,
          `arn:aws:bedrock:us-east-2::foundation-model/anthropic.claude-*`,
          `arn:aws:bedrock:us-west-2::foundation-model/anthropic.claude-*`,
          `arn:aws:bedrock:eu-west-1::foundation-model/anthropic.claude-*`,
          `arn:aws:bedrock:eu-central-1::foundation-model/anthropic.claude-*`,
          `arn:aws:bedrock:eu-north-1::foundation-model/anthropic.claude-*`,
          // Titan embeddings, same cross-region pattern.
          `arn:aws:bedrock:${this.region}::foundation-model/amazon.titan-embed-*`,
          `arn:aws:bedrock:us-east-1::foundation-model/amazon.titan-embed-*`,
          `arn:aws:bedrock:us-east-2::foundation-model/amazon.titan-embed-*`,
          `arn:aws:bedrock:us-west-2::foundation-model/amazon.titan-embed-*`,
          // Amazon Nova family — Canvas (images), Reel (video), text models.
          `arn:aws:bedrock:${this.region}::foundation-model/amazon.nova-*`,
          `arn:aws:bedrock:us-east-1::foundation-model/amazon.nova-*`,
          `arn:aws:bedrock:us-east-2::foundation-model/amazon.nova-*`,
          `arn:aws:bedrock:us-west-2::foundation-model/amazon.nova-*`,
          // Model Playground (us-east-1, on-demand): OpenAI gpt-oss + DeepSeek.
          // Scoped to the two providers explicitly enabled for cross-model
          // comparison. Other providers in the catalog stay AccessDenied by
          // design (broaden here to enable more). Applied live as the attached
          // customer-managed policy CCE-Playground-NonAnthropicInvoke (the
          // role's inline budget was full); this cdk entry keeps source in sync
          // so a future deploy reflects the same grant.
          `arn:aws:bedrock:us-east-1::foundation-model/openai.gpt-oss-*`,
          `arn:aws:bedrock:us-east-1::foundation-model/deepseek.*`,
          // Inference profile + guardrail in our account
          `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/*`,
          `arn:aws:bedrock:${this.region}:${this.account}:guardrail/*`,
        ],
      }),
    );
    // Jarvis voice co-pilot (Nova 2 Sonic) — a SEPARATE statement so it can be
    // revoked independently of the text models (JARVIS-PLAN.md §5 / 03-security).
    // The bidirectional InvokeModelWithBidirectionalStream operation requires the
    // `bedrock:InvokeModel` action — there is NO `*WithBidirectionalStream` IAM
    // action (§1c). Scoped to Nova Sonic (v1 legacy + the nova-2 target) across
    // its In-Region homes only: us-east-1, us-west-2, eu-north-1, ap-northeast-1
    // (NOT us-east-2 — Nova Sonic is not offered there).
    this.taskRole.addToPolicy(
      new PolicyStatement({
        sid: 'BedrockBidirectionalStream',
        effect: Effect.ALLOW,
        actions: ['bedrock:InvokeModel'],
        resources: [
          'arn:aws:bedrock:us-east-1::foundation-model/amazon.nova*sonic*',
          'arn:aws:bedrock:us-west-2::foundation-model/amazon.nova*sonic*',
          'arn:aws:bedrock:eu-north-1::foundation-model/amazon.nova*sonic*',
          'arn:aws:bedrock:ap-northeast-1::foundation-model/amazon.nova*sonic*',
        ],
      }),
    );
    this.taskRole.addToPolicy(
      new PolicyStatement({
        sid: 'BedrockListing',
        effect: Effect.ALLOW,
        actions: [
          'bedrock:ListFoundationModels',
          'bedrock:ListInferenceProfiles',
          'bedrock:GetFoundationModel',
          'bedrock:GetInferenceProfile',
        ],
        resources: ['*'],
      }),
    );

    // AWS Marketplace permissions for Bedrock to auto-verify foundation
    // model subscriptions on first invocation per region. Required for
    // cross-region inference profiles that route to multiple destination
    // regions. Without these, the first call may succeed (cached) but
    // subsequent calls to other destinations fail with "Model access
    // is denied due to AWS Marketplace actions required".
    this.taskRole.addToPolicy(
      new PolicyStatement({
        sid: 'BedrockMarketplaceSubscription',
        effect: Effect.ALLOW,
        actions: [
          'aws-marketplace:ViewSubscriptions',
          'aws-marketplace:Subscribe',
          'aws-marketplace:Unsubscribe',
        ],
        resources: ['*'],
      }),
    );
    if (props.tier >= 2) {
      this.taskRole.addToPolicy(
        new PolicyStatement({
          sid: 'BedrockKbRetrieve',
          effect: Effect.ALLOW,
          actions: ['bedrock:Retrieve', 'bedrock:RetrieveAndGenerate'],
          resources: [`arn:aws:bedrock:${this.region}:${this.account}:knowledge-base/*`],
        }),
      );
    }

    // S3 read/write per bucket
    this.taskRole.addToPolicy(
      new PolicyStatement({
        sid: 'S3List',
        effect: Effect.ALLOW,
        actions: ['s3:ListBucket'],
        resources: bucketArns,
      }),
    );
    this.taskRole.addToPolicy(
      new PolicyStatement({
        sid: 'S3ConfigReadWrite',
        effect: Effect.ALLOW,
        // Dashboard agent file editor writes new CLAUDE.md revisions
        // back to the config bucket. Without PutObject the editor
        // returns 500 even though the DDB history row gets saved.
        // DeleteObject lets DELETE /agents/:id remove the agent's
        // CLAUDE.md (agents/{agentId}/...) instead of AccessDenied.
        // Scoped to the agents/ prefix only.
        actions: [
          's3:GetObject',
          's3:GetObjectVersion',
          's3:PutObject',
          's3:PutObjectAcl',
          's3:DeleteObject',
        ],
        resources: [`${props.storage.configBucket.bucketArn}/agents/*`],
      }),
    );
    this.taskRole.addToPolicy(
      new PolicyStatement({
        sid: 'S3DataReadWrite',
        effect: Effect.ALLOW,
        actions: [
          's3:GetObject',
          's3:PutObject',
          's3:DeleteObject',
          's3:GetObjectVersion',
        ],
        resources: [
          `${props.storage.rawBucket.bucketArn}/*`,
          `${props.storage.curatedBucket.bucketArn}/*`,
          `${props.storage.vectorsStagingBucket.bucketArn}/*`,
        ],
      }),
    );

    // KMS encrypt+decrypt on data and curated CMKs.
    // The default CMK key policy allows account-root principals with
    // matching IAM permissions; our role policy here is enough.
    this.taskRole.addToPolicy(
      new PolicyStatement({
        sid: 'KmsDataOps',
        effect: Effect.ALLOW,
        actions: [
          'kms:Decrypt',
          'kms:Encrypt',
          'kms:GenerateDataKey',
          'kms:DescribeKey',
        ],
        resources: kmsKeyArns,
      }),
    );

    // DynamoDB read/write per table
    this.taskRole.addToPolicy(
      new PolicyStatement({
        sid: 'DdbRW',
        effect: Effect.ALLOW,
        actions: [
          'dynamodb:GetItem',
          'dynamodb:BatchGetItem',
          'dynamodb:Query',
          'dynamodb:Scan',
          'dynamodb:PutItem',
          'dynamodb:UpdateItem',
          'dynamodb:DeleteItem',
          'dynamodb:BatchWriteItem',
          'dynamodb:TransactWriteItems',
          'dynamodb:TransactGetItems',
          'dynamodb:ConditionCheckItem',
        ],
        resources: tableArnsWithIndexes,
      }),
    );

    // Audit log: append-only. Deny delete/update on the audit table.
    // Codex #40: audit retention is not audit immutability without this.
    this.taskRole.addToPolicy(
      new PolicyStatement({
        sid: 'AuditAppendOnly',
        effect: Effect.DENY,
        actions: [
          'dynamodb:DeleteItem',
          'dynamodb:DeleteTable',
          'dynamodb:UpdateItem',
        ],
        resources: [
          props.dynamo.auditLogTable.tableArn,
          `${props.dynamo.auditLogTable.tableArn}/index/*`,
        ],
      }),
    );

    // Secrets read at runtime
    this.taskRole.addToPolicy(
      new PolicyStatement({
        sid: 'SecretsRead',
        effect: Effect.ALLOW,
        actions: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'],
        resources: secretArns,
      }),
    );

    // Power-switch token, read-only: the dashboard's /api/power proxy attaches
    // it server-side when calling the isolated pause/wake Lambda, so the token
    // never reaches a browser. Constructed ARN (suffix wildcard) because the
    // PowerSwitch stack is deliberately isolated and imports/exports nothing.
    this.taskRole.addToPolicy(
      new PolicyStatement({
        sid: 'PowerTokenRead',
        effect: Effect.ALLOW,
        actions: ['secretsmanager:GetSecretValue'],
        resources: [
          `arn:aws:secretsmanager:${this.region}:${this.account}:secret:${APP}/power-switch-token-*`,
        ],
      }),
    );

    // CloudWatch metric publishing in our namespace only
    this.taskRole.addToPolicy(
      new PolicyStatement({
        sid: 'CloudWatchMetrics',
        effect: Effect.ALLOW,
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'],
        conditions: {
          StringEquals: { 'cloudwatch:namespace': 'ClaudeClaw' },
        },
      }),
    );

    // SNS publish for ops alerts + config invalidation fanout
    this.taskRole.addToPolicy(
      new PolicyStatement({
        sid: 'SnsPublish',
        effect: Effect.ALLOW,
        actions: ['sns:Publish', 'sns:Subscribe', 'sns:Unsubscribe'],
        resources: [`arn:aws:sns:${this.region}:${this.account}:claudeclaw-*`],
      }),
    );

    // Alert-recipient management on the EXISTING ops-alert topic only.
    // The alert-recipient admin console subscribes / unsubscribes an
    // operator email (AWS sends a confirmation link; the subscription
    // stays PendingConfirmation until clicked) and lists current
    // subscribers to render the console. Subscribe is the only write;
    // everything else is read. Strictly scoped to the ops-alert topic
    // ARN built from RESOURCE_NAMES.alertTopic, not the claudeclaw-*
    // wildcard, so this grant cannot touch any other topic.
    // Topic-level actions act on the bare topic ARN.
    const alertTopicArn = `arn:aws:sns:${this.region}:${this.account}:${RESOURCE_NAMES.alertTopic}`;
    this.taskRole.addToPolicy(
      new PolicyStatement({
        sid: 'SnsAlertTopicRecipients',
        effect: Effect.ALLOW,
        actions: ['sns:Subscribe', 'sns:ListSubscriptionsByTopic'],
        resources: [alertTopicArn],
      }),
    );
    // Unsubscribe and GetSubscriptionAttributes act on SUBSCRIPTION ARNs
    // (arn:aws:sns:...:claudeclaw-ops-alerts:<sub-uuid>), not the bare topic
    // ARN, so they must be scoped to subscriptions under the topic or the
    // policy will not match at eval time and the actions are implicitly
    // denied. `${topicArn}:*` covers exactly the subscriptions of this topic
    // and nothing else.
    this.taskRole.addToPolicy(
      new PolicyStatement({
        sid: 'SnsAlertTopicSubscriptions',
        effect: Effect.ALLOW,
        actions: ['sns:Unsubscribe', 'sns:GetSubscriptionAttributes'],
        resources: [`${alertTopicArn}:*`],
      }),
    );

    // SQS for config invalidation + ingest (consume-only; queues are
    // provisioned by CDK, not at runtime)
    this.taskRole.addToPolicy(
      new PolicyStatement({
        sid: 'SqsQueueOps',
        effect: Effect.ALLOW,
        actions: [
          'sqs:ReceiveMessage',
          'sqs:DeleteMessage',
          'sqs:GetQueueAttributes',
          'sqs:GetQueueUrl',
          'sqs:SendMessage',
          'sqs:ChangeMessageVisibility',
        ],
        resources: [`arn:aws:sqs:${this.region}:${this.account}:claudeclaw-*`],
      }),
    );

    // ─── Config-invalidation fanout: ephemeral per-task SQS subscriber ──
    // This is the ONLY new write grant for the fanout feature, and it is
    // scoped to the orchestrator's OWN ephemeral queues plus its OWN config
    // topic. Each Fargate task, at boot, creates a throwaway SQS queue named
    // `claudeclaw-config-sub-<task-uuid>`, subscribes it to the config
    // invalidation topic, and polls it to invalidate config caches faster
    // than the 30s in-process poll. On SIGTERM the task unsubscribes and
    // deletes its own queue. The fanout is purely an accelerator: if any of
    // these calls fail the 30s cache poll still keeps every task correct.
    //
    // Queue lifecycle actions are scoped to the `claudeclaw-config-sub-*`
    // name prefix where resource-level scoping is supported. CreateQueue is
    // the exception: SQS does not support resource-level scoping on
    // CreateQueue (the queue ARN does not exist yet at call time), so it must
    // use `*`. We constrain blast radius with a sqs:QueueName condition on
    // the same prefix, so this role cannot create arbitrarily-named queues.
    const configSubQueueArnPrefix = `arn:aws:sqs:${this.region}:${this.account}:claudeclaw-config-sub-*`;
    this.taskRole.addToPolicy(
      new PolicyStatement({
        sid: 'ConfigSubQueueCreate',
        effect: Effect.ALLOW,
        actions: ['sqs:CreateQueue'],
        resources: ['*'],
        conditions: {
          StringLike: { 'sqs:QueueName': 'claudeclaw-config-sub-*' },
        },
      }),
    );
    this.taskRole.addToPolicy(
      new PolicyStatement({
        sid: 'ConfigSubQueueLifecycle',
        effect: Effect.ALLOW,
        actions: [
          'sqs:DeleteQueue',
          'sqs:GetQueueAttributes',
          'sqs:SetQueueAttributes',
          'sqs:GetQueueUrl',
          'sqs:ReceiveMessage',
          'sqs:DeleteMessage',
        ],
        resources: [configSubQueueArnPrefix],
      }),
    );

    // SNS subscribe / unsubscribe / publish on the config-invalidation topic
    // only. Subscribe (attach the ephemeral queue), Publish (broadcast an
    // invalidation message on write), and ListSubscriptionsByTopic (find +
    // clean up the task's own subscription) act on the bare topic ARN.
    // Unsubscribe acts on a SUBSCRIPTION ARN (`<topicArn>:<sub-uuid>`), so it
    // is scoped to `${topicArn}:*` like the ops-alert topic's unsubscribe.
    // Strictly scoped to the config topic built from
    // RESOURCE_NAMES.configInvalidationTopic, never the claudeclaw-* wildcard.
    const configTopicArn = `arn:aws:sns:${this.region}:${this.account}:${RESOURCE_NAMES.configInvalidationTopic}`;
    this.taskRole.addToPolicy(
      new PolicyStatement({
        sid: 'SnsConfigTopicFanout',
        effect: Effect.ALLOW,
        actions: [
          'sns:Subscribe',
          'sns:Publish',
          'sns:ListSubscriptionsByTopic',
        ],
        resources: [configTopicArn],
      }),
    );
    this.taskRole.addToPolicy(
      new PolicyStatement({
        sid: 'SnsConfigTopicUnsubscribe',
        effect: Effect.ALLOW,
        actions: ['sns:Unsubscribe'],
        resources: [`${configTopicArn}:*`],
      }),
    );

    // ECS Exec (Session Manager) for break-glass debugging
    this.taskRole.addToPolicy(
      new PolicyStatement({
        sid: 'SsmExec',
        effect: Effect.ALLOW,
        actions: [
          'ssmmessages:CreateControlChannel',
          'ssmmessages:CreateDataChannel',
          'ssmmessages:OpenControlChannel',
          'ssmmessages:OpenDataChannel',
        ],
        resources: ['*'],
      }),
    );

    // Audit lock bucket: write-only (Object Lock prevents tampering).
    // Tier-gated with the bucket itself (plan item 26): T0/T1 have no WORM
    // bucket, so granting against its would-be ARN would be a dangling
    // grant — skip it entirely below tier 2.
    if (props.tier >= 2) {
      const auditLockBucketName = `${RESOURCE_NAMES.auditLockBucket}-${this.account}-${this.region}`;
      this.taskRole.addToPolicy(
        new PolicyStatement({
          sid: 'AuditLockWriteOnly',
          effect: Effect.ALLOW,
          actions: ['s3:PutObject', 's3:GetBucketLocation'],
          resources: [
            `arn:aws:s3:::${auditLockBucketName}`,
            `arn:aws:s3:::${auditLockBucketName}/*`,
          ],
        }),
      );
    }

    // Amazon Transcribe — voice / audio transcription. Job names are
     // scoped to our prefix so we can't read other workloads' jobs.
    this.taskRole.addToPolicy(
      new PolicyStatement({
        sid: 'TranscribeJobs',
        effect: Effect.ALLOW,
        actions: [
          'transcribe:StartTranscriptionJob',
          'transcribe:GetTranscriptionJob',
          'transcribe:ListTranscriptionJobs',
          'transcribe:DeleteTranscriptionJob',
        ],
        resources: ['*'],
      }),
    );

    // ─── A1 · EventBridge Scheduler grants ──────────────────────
    // The orchestrator creates / updates / deletes a per-task EB
    // Schedule for each row in scheduled_tasks. The schedule's target
    // is the scheduled-fire SQS queue; PassRole lets us hand the
    // scheduler exec role (from messaging-stack) to EB Scheduler when
    // we create schedules.
    //
    // Schedule names live under the deterministic group from
    // RESOURCE_NAMES.schedulerGroupName, scoped to this account + region.
    // The `*` on resources is intentional: schedule ARNs are
    // arn:aws:scheduler:<region>:<account>:schedule/<group>/<name>, and
    // we don't pre-know task IDs. Scoping by group prefix prevents this
    // role from touching schedules in any other group.
    const schedulerGroupArn = `arn:aws:scheduler:${this.region}:${this.account}:schedule-group/${props.messaging.schedulerGroupName}`;
    const schedulesInGroupArn = `arn:aws:scheduler:${this.region}:${this.account}:schedule/${props.messaging.schedulerGroupName}/*`;
    this.taskRole.addToPolicy(
      new PolicyStatement({
        sid: 'SchedulerManageSchedules',
        effect: Effect.ALLOW,
        actions: [
          'scheduler:CreateSchedule',
          'scheduler:UpdateSchedule',
          'scheduler:DeleteSchedule',
          'scheduler:GetSchedule',
          'scheduler:TagResource',
        ],
        resources: [schedulesInGroupArn],
      }),
    );
    this.taskRole.addToPolicy(
      new PolicyStatement({
        sid: 'SchedulerListSchedules',
        effect: Effect.ALLOW,
        actions: ['scheduler:ListSchedules', 'scheduler:GetScheduleGroup'],
        resources: [schedulerGroupArn, '*'],
      }),
    );
    // PassRole the scheduler execution role to EB Scheduler when
    // creating schedules. Strictly scoped to that single role ARN.
    this.taskRole.addToPolicy(
      new PolicyStatement({
        sid: 'SchedulerPassExecutionRole',
        effect: Effect.ALLOW,
        actions: ['iam:PassRole'],
        resources: [props.messaging.schedulerExecutionRoleArn],
        conditions: {
          StringEquals: {
            'iam:PassedToService': 'scheduler.amazonaws.com',
          },
        },
      }),
    );

    // Amazon Polly — TTS voice replies (Phase A2).
    this.taskRole.addToPolicy(
      new PolicyStatement({
        sid: 'PollySynthesize',
        effect: Effect.ALLOW,
        actions: ['polly:SynthesizeSpeech', 'polly:DescribeVoices'],
        resources: ['*'],
      }),
    );

    // Amazon SES v2 — email send tool (Phase A3) AND the Wave 4a passwordless
    // magic-link auth flow (invite / login links). Both routes go through the
    // guarded SES send path that honors the email_send_disabled kill switch +
    // a send cap, so this single grant covers both senders.
    this.taskRole.addToPolicy(
      new PolicyStatement({
        sid: 'SesSendEmail',
        effect: Effect.ALLOW,
        actions: ['ses:SendEmail', 'ses:SendRawEmail'],
        resources: ['*'],
      }),
    );

    // Bedrock Nova Canvas inference (Phase A1) — already covered by
    // BedrockInvoke statement above via the amazon.* foundation-model
    // pattern. The grant matches any amazon.nova-canvas-* model in the
    // same regions as the Claude foundation models. (Explicit no-op.)

    // D5: public status page reads CloudWatch alarms + CFN stack
    // events to render the page. Read-only, account-scoped resources.
    this.taskRole.addToPolicy(
      new PolicyStatement({
        sid: 'StatusPageReads',
        effect: Effect.ALLOW,
        actions: [
          'cloudwatch:DescribeAlarms',
          'cloudformation:DescribeStackEvents',
          'cloudformation:DescribeStacks',
        ],
        resources: ['*'],
      }),
    );

    // CloudWatch metric namespace expansion for X-Ray + custom metrics
    // (Phase C3 + dashboard). xray:PutTraceSegments lives at root.
    this.taskRole.addToPolicy(
      new PolicyStatement({
        sid: 'XRayTrace',
        effect: Effect.ALLOW,
        actions: [
          'xray:PutTraceSegments',
          'xray:PutTelemetryRecords',
          'xray:GetSamplingRules',
          'xray:GetSamplingTargets',
        ],
        resources: ['*'],
      }),
    );

    // ─── GitHub Actions deploy role (A2) ────────────────────────
    // Gated on CCE_CICD_ENABLED=1 so the role only materializes when CI
    // is opted in. The role trusts the existing account OIDC provider
    // for token.actions.githubusercontent.com, scoped to this repo on
    // main / staging refs and the `production` / `staging` GH environments.
    //
    // The role is a single account-wide identity used by BOTH prod and
    // staging deploys — its grants already cover the suffixed staging
    // resource names. Creating it only from the prod IAM stack avoids
    // the EntityAlreadyExists conflict when staging deploys after prod.
    const isStagingDeploy = (process.env.CCE_NAME_SUFFIX ?? '').length > 0;
    if (process.env.CCE_CICD_ENABLED === '1' && !isStagingDeploy) {
      // Fail closed: synth ERRORS unless owner/repo + deploy subjects are
      // explicit. Exact-match (StringEquals) subjects only — never a
      // repo-wide `repo:owner/name:*`. See github-oidc.ts.
      const trust = resolveGithubOidcTrust(process.env);
      const oidcProvider = OpenIdConnectProvider.fromOpenIdConnectProviderArn(
        this,
        'GithubOidcProvider',
        `arn:aws:iam::${this.account}:oidc-provider/token.actions.githubusercontent.com`,
      );
      const cicdRole = new Role(this, 'GithubDeployRole', {
        roleName: 'ClaudeClawGitHubDeploy',
        assumedBy: new FederatedPrincipal(
          oidcProvider.openIdConnectProviderArn,
          trust.conditions,
          'sts:AssumeRoleWithWebIdentity',
        ),
        description: 'GitHub Actions OIDC deploy role for ClaudeClaw',
      });

      // CDK CLI assumes the four cdk-* roles produced by `cdk bootstrap`.
      // The cfn-exec role is assumed by CloudFormation itself, not the CLI,
      // so it's not needed in this allow-list.
      cicdRole.addToPolicy(
        new PolicyStatement({
          sid: 'AssumeCdkBootstrapRoles',
          effect: Effect.ALLOW,
          actions: ['sts:AssumeRole'],
          resources: [
            `arn:aws:iam::${this.account}:role/cdk-hnb659fds-deploy-role-${this.account}-*`,
            `arn:aws:iam::${this.account}:role/cdk-hnb659fds-file-publishing-role-${this.account}-*`,
            `arn:aws:iam::${this.account}:role/cdk-hnb659fds-image-publishing-role-${this.account}-*`,
            `arn:aws:iam::${this.account}:role/cdk-hnb659fds-lookup-role-${this.account}-*`,
          ],
        }),
      );

      // ECR auth + push for the orchestrator image (built outside cdk-assets).
      cicdRole.addToPolicy(
        new PolicyStatement({
          sid: 'EcrAuth',
          effect: Effect.ALLOW,
          actions: ['ecr:GetAuthorizationToken'],
          resources: ['*'],
        }),
      );
      // Cover both prod (`claudeclaw-orchestrator`) and staging
      // (`claudeclaw-staging-orchestrator`) repos with one wildcard.
      cicdRole.addToPolicy(
        new PolicyStatement({
          sid: 'EcrPushOrchestrator',
          effect: Effect.ALLOW,
          actions: [
            'ecr:BatchCheckLayerAvailability',
            'ecr:GetDownloadUrlForLayer',
            'ecr:BatchGetImage',
            'ecr:InitiateLayerUpload',
            'ecr:UploadLayerPart',
            'ecr:CompleteLayerUpload',
            'ecr:PutImage',
            'ecr:DescribeRepositories',
            'ecr:DescribeImages',
          ],
          resources: [
            `arn:aws:ecr:${this.region}:${this.account}:repository/claudeclaw-orchestrator`,
            `arn:aws:ecr:${this.region}:${this.account}:repository/claudeclaw-*-orchestrator`,
          ],
        }),
      );
      // Allow the deploy workflow's "Ensure ECR repo exists" step to
      // bootstrap a fresh-environment repo on first deploy. CreateRepository
      // requires `resources: ['*']` because the repo ARN doesn't exist yet
      // when the create call is made; the API itself does not accept an
      // ARN-scoped Resource for Create. We narrow blast radius with a
      // resource-name condition on the app's repo naming patterns, so this
      // role cannot create arbitrary ECR repositories.
      //
      // BOTH app repos must be listed. Paperclip (ADR 0010) introduced a
      // second repo, `claudeclaw[-suffix]-paperclip`, created by the same
      // deploy phase; while this condition named only the orchestrator, an
      // armed deploy died with AccessDeniedException on CreateRepository.
      // That failure is unrecoverable in-run: the create happens during the
      // image-build phase, BEFORE `cdk deploy`, so the run can never apply
      // its own IAM fix. Adding a third repo means adding it here too.
      cicdRole.addToPolicy(
        new PolicyStatement({
          sid: 'EcrCreateAppRepos',
          effect: Effect.ALLOW,
          actions: ['ecr:CreateRepository'],
          resources: ['*'],
          conditions: {
            StringLike: {
              'ecr:RepositoryName': ECR_CREATE_NAME_PATTERNS,
            },
          },
        }),
      );

      // Force ECS rollout after the new image is published. Cluster +
      // service names follow `claudeclaw[-suffix]-{cluster,service}`.
      cicdRole.addToPolicy(
        new PolicyStatement({
          sid: 'EcsForceRollout',
          effect: Effect.ALLOW,
          actions: [
            'ecs:UpdateService',
            'ecs:DescribeServices',
            'ecs:DescribeTasks',
            'ecs:ListTasks',
          ],
          resources: [
            `arn:aws:ecs:${this.region}:${this.account}:service/claudeclaw-cluster/claudeclaw-service`,
            `arn:aws:ecs:${this.region}:${this.account}:service/claudeclaw-*-cluster/claudeclaw-*-service`,
            `arn:aws:ecs:${this.region}:${this.account}:task/claudeclaw-cluster/*`,
            `arn:aws:ecs:${this.region}:${this.account}:task/claudeclaw-*-cluster/*`,
          ],
        }),
      );

      // Read-only CloudFormation describe for diagnostics after deploy.
      cicdRole.addToPolicy(
        new PolicyStatement({
          sid: 'CloudFormationDescribe',
          effect: Effect.ALLOW,
          actions: [
            'cloudformation:DescribeStacks',
            'cloudformation:DescribeStackEvents',
            'cloudformation:DescribeStackResources',
            'cloudformation:GetTemplate',
            'cloudformation:ListStacks',
          ],
          resources: ['*'],
        }),
      );

      // Public connector readiness probe. DescribeSecret ONLY: the workflow
      // checks whether the CCE-PUBLIC-READY version stage exists and never
      // reads the token, so GetSecretValue is deliberately not granted.
      cicdRole.addToPolicy(
        new PolicyStatement({
          sid: 'PublicTunnelReadiness',
          effect: Effect.ALLOW,
          actions: ['secretsmanager:DescribeSecret'],
          resources: [
            `arn:aws:secretsmanager:${this.region}:${this.account}:secret:claudeclaw-public-tunnel*`,
            `arn:aws:secretsmanager:${this.region}:${this.account}:secret:claudeclaw-*-public-tunnel*`,
          ],
        }),
      );
    }

    // The deploy role is an account-wide singleton created by the PROD stack
    // above, so a staging deploy cannot extend it there. Staging still needs
    // the readiness probe for its own tunnel secret, and granting it from the
    // staging stack keeps this deployable without touching production at all.
    // Same DescribeSecret-only scope, narrowed to this environment's secret.
    if (process.env.CCE_CICD_ENABLED === '1' && isStagingDeploy) {
      Role.fromRoleName(this, 'GithubDeployRoleRef', 'ClaudeClawGitHubDeploy').addToPrincipalPolicy(
        new PolicyStatement({
          sid: 'PublicTunnelReadinessStaging',
          effect: Effect.ALLOW,
          actions: ['secretsmanager:DescribeSecret'],
          resources: [
            `arn:aws:secretsmanager:${this.region}:${this.account}:secret:${APP}-public-tunnel*`,
          ],
        }),
      );
    }

    // v5.6: ECS RunTask for consolidation worker (Fargate one-shots)
    this.taskRole.addToPolicy(
      new PolicyStatement({
        sid: 'EcsConsolidationWorker',
        effect: Effect.ALLOW,
        actions: ['ecs:RunTask', 'ecs:DescribeTasks', 'ecs:StopTask'],
        resources: [
          `arn:aws:ecs:${this.region}:${this.account}:task-definition/claudeclaw-*`,
          `arn:aws:ecs:${this.region}:${this.account}:task/claudeclaw-*`,
        ],
      }),
    );
    this.taskRole.addToPolicy(
      new PolicyStatement({
        sid: 'EcsConsolidationPassRole',
        effect: Effect.ALLOW,
        actions: ['iam:PassRole'],
        resources: [`arn:aws:iam::${this.account}:role/claudeclaw-*`],
        conditions: {
          StringEquals: {
            'iam:PassedToService': 'ecs-tasks.amazonaws.com',
          },
        },
      }),
    );

    // v5.6: Lambda invoke for extensions (hooks + skills)
    this.taskRole.addToPolicy(
      new PolicyStatement({
        sid: 'LambdaInvokeExtensions',
        effect: Effect.ALLOW,
        actions: ['lambda:InvokeFunction'],
        resources: [
          `arn:aws:lambda:${this.region}:${this.account}:function:claudeclaw-extension-*`,
        ],
      }),
    );

    // v5.6: API Gateway ManageConnections for war room WebSocket pushes
    this.taskRole.addToPolicy(
      new PolicyStatement({
        sid: 'ApiGwWarroomConnections',
        effect: Effect.ALLOW,
        actions: ['execute-api:ManageConnections'],
        resources: [
          `arn:aws:execute-api:${this.region}:${this.account}:*/@connections/*`,
        ],
      }),
    );

    // ─── Read-only security posture reads (Tier B posture dashboard) ──
    // The posture routers under /api/posture/* call describe / get / list
    // APIs ONLY. No write paths. Most of these describe actions do not
    // support resource-level scoping, so resources: ['*'] is required for
    // the describe/list set. This statement is strictly READ-ONLY: it
    // grants nothing that can mutate AWS state, and the readers fail soft
    // (return an 'unknown'/amber card) when any of these is denied.
    this.taskRole.addToPolicy(
      new PolicyStatement({
        sid: 'SecurityPostureReadOnly',
        effect: Effect.ALLOW,
        actions: [
          // WAFv2 — which WebACL protects the ALB and its rules. The
          // network reader discovers the ACL by listing then getting it
          // (no compute->security cross-stack prop), so ListWebACLs is
          // required alongside the get/resource lookups.
          'wafv2:ListWebACLs',
          'wafv2:GetWebACL',
          'wafv2:ListResourcesForWebACL',
          'wafv2:GetWebACLForResource',
          // EC2 networking — VPC, subnets, SGs, endpoints, flow logs.
          'ec2:DescribeVpcs',
          'ec2:DescribeSubnets',
          'ec2:DescribeSecurityGroups',
          'ec2:DescribeVpcEndpoints',
          'ec2:DescribeFlowLogs',
          // GuardDuty — detector enablement + finding severity counts.
          'guardduty:ListDetectors',
          'guardduty:GetDetector',
          'guardduty:ListFindings',
          'guardduty:GetFindings',
          // KMS — key rotation status + alias enumeration.
          'kms:DescribeKey',
          'kms:GetKeyRotationStatus',
          'kms:ListAliases',
          // Secrets Manager — metadata ONLY (name, last-rotated, ARN).
          // The readers never call GetSecretValue here.
          'secretsmanager:DescribeSecret',
          'secretsmanager:ListSecrets',
          // CloudTrail — trail config, logging status, event selectors.
          'cloudtrail:DescribeTrails',
          'cloudtrail:GetTrailStatus',
          'cloudtrail:GetEventSelectors',
          // DynamoDB — PITR / continuous-backups + table description.
          'dynamodb:DescribeContinuousBackups',
          'dynamodb:DescribeTable',
          // S3 — bucket encryption, object lock, versioning posture.
          's3:GetBucketEncryption',
          's3:GetObjectLockConfiguration',
          's3:GetBucketVersioning',
          // CloudWatch — alarm + metric reads for observability cards.
          'cloudwatch:DescribeAlarms',
          'cloudwatch:GetMetricData',
          'cloudwatch:GetMetricStatistics',
        ],
        // Describe/list actions above do not support resource-level
        // scoping; '*' is acceptable for a clearly read-only posture set.
        resources: ['*'],
      }),
    );

    // ─── Read-only cost visibility (Tier B cost dashboard) ───────────
    // The /api/cost router reads Cost Explorer for spend + projection and
    // runs a handful of ec2/elb describes to flag wasteful resources (idle
    // NAT, redundant endpoints, unattached EIPs, orphaned EBS, surplus
    // load balancers). Every action here is READ-ONLY and cannot mutate
    // AWS state; the reader fails soft (returns available:false) on denial.
    // Cost Explorer (ce:*) does not support resource-level scoping.
    this.taskRole.addToPolicy(
      new PolicyStatement({
        sid: 'CostExplorerReadOnly',
        effect: Effect.ALLOW,
        actions: [
          'ce:GetCostAndUsage',
          'ce:GetCostForecast',
          'ce:GetDimensionValues',
          // Resource describes used only by the waste scan. These are reads;
          // none can create, modify, or delete a resource.
          'ec2:DescribeNatGateways',
          'ec2:DescribeAddresses',
          'ec2:DescribeVolumes',
          'elasticloadbalancing:DescribeLoadBalancers',
          // Waste scan also flags ClaudeClaw log groups with no retention.
          'logs:DescribeLogGroups',
        ],
        resources: ['*'],
      }),
    );

    // ─── Cost remediation: WRITE, off by default (out-of-band policy) ─
    // POST /api/cost/remediate (src/lib/aws/cost-remediation.ts) deletes/
    // releases ONE idle resource from the Cost tab. These are the only cost
    // actions that MUTATE AWS, so they are deliberately NOT granted to the task
    // role here. They live in a customer-managed policy `CCE-CostRemediation`
    // that is created and attached OUT OF BAND (like CCE-Playground-NonAnthropic
    // Invoke and CCE-IamCopilot — the role's inline budget is full), so the
    // grant can be detached to revoke without a deploy. Until it is attached AND
    // runtime-config cost/remediation_enabled === 'true', the route is inert.
    // The policy document (source of truth):
    //   Allow ec2:ReleaseAddress, ec2:DeleteVolume, ec2:DeleteNatGateway,
    //         ec2:DeleteVpcEndpoints, ec2:DescribeRouteTables,
    //         ec2:DescribeVpcEndpoints,
    //         elasticloadbalancing:DeleteLoadBalancer,
    //         elasticloadbalancing:DescribeTargetGroups,
    //         elasticloadbalancing:DescribeTargetHealth,
    //         logs:PutRetentionPolicy   (set-log-retention; the executor hard-
    //                                    scopes to /claudeclaw/ groups in code)
    //   on Resource "*" (these EC2/ELB/logs actions do not support resource scoping).
    // Arm:    aws iam create-policy --policy-name CCE-CostRemediation ... &&
    //         aws iam attach-role-policy --role-name <taskRole> --policy-arn ...
    //         then set cost/remediation_enabled=true in runtime-config.
    // Revoke: detach the policy (immediate) and/or flip the flag off.

    // ─── Opt-in managed policies (IaC readiness item 27) ─────────────
    // The capability grants that were historically created + live-attached
    // out of band are now also available as env-gated CDK constructs,
    // DEFAULT OFF. ESCAPE HATCH for existing installs: an account that
    // already carries a live-attached copy keeps the flag off — enabling
    // it would fail with EntityAlreadyExists on the same policy name. The
    // live-attach path (create-policy + attach-role-policy by hand)
    // remains the documented revoke-without-deploy mechanism either way:
    // detaching the policy kills the capability immediately. Account-wide
    // names, so never created from a suffixed staging deploy.
    if (process.env.CCE_POLICY_PLAYGROUND_NONANTHROPIC === '1' && !isStagingDeploy) {
      new ManagedPolicy(this, 'PlaygroundNonAnthropicPolicy', {
        managedPolicyName: 'CCE-Playground-NonAnthropicInvoke',
        description:
          'Playground cross-model invoke: OpenAI gpt-oss + DeepSeek only. Detach to revoke.',
        statements: [
          new PolicyStatement({
            sid: 'PlaygroundNonAnthropicInvoke',
            effect: Effect.ALLOW,
            actions: [
              'bedrock:InvokeModel',
              'bedrock:InvokeModelWithResponseStream',
              'bedrock:Converse',
              'bedrock:ConverseStream',
            ],
            resources: [
              'arn:aws:bedrock:us-east-1::foundation-model/openai.gpt-oss-*',
              'arn:aws:bedrock:us-east-1::foundation-model/deepseek.*',
            ],
          }),
        ],
        roles: [this.taskRole],
      });
    }
    if (process.env.CCE_POLICY_COST_REMEDIATION === '1' && !isStagingDeploy) {
      new ManagedPolicy(this, 'CostRemediationPolicy', {
        managedPolicyName: 'CCE-CostRemediation',
        description:
          'Cost-tab remediation writes (release/delete ONE idle resource). Detach to revoke; also gated by runtime-config cost/remediation_enabled.',
        statements: [
          new PolicyStatement({
            sid: 'CostRemediationWrites',
            effect: Effect.ALLOW,
            actions: [
              'ec2:ReleaseAddress',
              'ec2:DeleteVolume',
              'ec2:DeleteNatGateway',
              'ec2:DeleteVpcEndpoints',
              'ec2:DescribeRouteTables',
              'ec2:DescribeVpcEndpoints',
              'elasticloadbalancing:DeleteLoadBalancer',
              'elasticloadbalancing:DescribeTargetGroups',
              'elasticloadbalancing:DescribeTargetHealth',
              // The executor hard-scopes to /claudeclaw/ groups in code.
              'logs:PutRetentionPolicy',
            ],
            // These EC2/ELB/logs actions do not support resource scoping.
            resources: ['*'],
          }),
        ],
        roles: [this.taskRole],
      });
    }
    if (process.env.CCE_POLICY_IAM_COPILOT === '1' && !isStagingDeploy) {
      new ManagedPolicy(this, 'IamCopilotPolicy', {
        managedPolicyName: 'CCE-IamCopilot',
        description:
          'IAM copilot read/validate + gated write, with a Deny protecting infra roles. Detach to revoke; also gated by runtime-config iam/apply_enabled.',
        statements: [
          new PolicyStatement({
            sid: 'IamCopilotValidateAndApply',
            effect: Effect.ALLOW,
            actions: [
              'access-analyzer:ValidatePolicy',
              'iam:CreatePolicy',
              'iam:CreateUser',
              'iam:AttachRolePolicy',
              'iam:AttachUserPolicy',
              'iam:PutRolePolicy',
              'iam:PutUserPolicy',
              'iam:GetRole',
              'iam:GetUser',
              'iam:GetPolicy',
              'iam:ListRoles',
              'iam:ListUsers',
              'iam:ListPolicies',
            ],
            resources: ['*'],
          }),
          // The copilot must never modify the roles that run or deploy
          // this system, even if an operator asks it to.
          new PolicyStatement({
            sid: 'IamCopilotProtectInfraRoles',
            effect: Effect.DENY,
            actions: ['iam:*'],
            resources: [
              `arn:aws:iam::${this.account}:role/CCE-Iam-TaskRole*`,
              `arn:aws:iam::${this.account}:role/cdk-hnb659fds-*`,
              `arn:aws:iam::${this.account}:role/ClaudeClawGitHubDeploy`,
            ],
          }),
        ],
        roles: [this.taskRole],
      });
    }

    // ─── CDK drift detection (drift-watch worker) ────────────────────
    // Read-only: starts + reads CloudFormation drift detection so out-of-band
    // changes to deployed resources surface as an ops-alert. DetectStackDrift
    // initiates a scan; it does not modify any resource.
    this.taskRole.addToPolicy(
      new PolicyStatement({
        sid: 'CloudFormationDriftReadOnly',
        effect: Effect.ALLOW,
        actions: [
          'cloudformation:ListStacks',
          'cloudformation:DescribeStacks',
          'cloudformation:DetectStackDrift',
          'cloudformation:DetectStackResourceDrift',
          'cloudformation:DescribeStackDriftDetectionStatus',
          'cloudformation:DescribeStackResourceDrifts',
        ],
        resources: ['*'],
      }),
    );

    // ─── Cost cap → AWS Budget sync ──────────────────────────────────
    // POST /api/cost-cap mirrors the in-app daily cap onto the AWS monthly
    // Budget (src/lib/aws/budget-writer.ts). Scoped to the one budget.
    this.taskRole.addToPolicy(
      new PolicyStatement({
        sid: 'CostCapBudgetSync',
        effect: Effect.ALLOW,
        actions: ['budgets:ViewBudget', 'budgets:ModifyBudget'],
        resources: [`arn:aws:budgets::${this.account}:budget/claudeclaw-monthly-cost`],
      }),
    );

    // ─── IAM copilot: read + validate (always on, READ-ONLY) ─────────
    // The IAM policy drafter validates drafts with Access Analyzer and reads
    // roles/policies for the UI. No write actions here.
    this.taskRole.addToPolicy(
      new PolicyStatement({
        sid: 'IamCopilotReadValidate',
        effect: Effect.ALLOW,
        actions: [
          'access-analyzer:ValidatePolicy',
          'iam:GetRole',
          'iam:ListRoles',
          'iam:ListPolicies',
          'iam:ListAttachedRolePolicies',
          'iam:ListRolePolicies',
        ],
        resources: ['*'],
      }),
    );

    // ─── IAM copilot: WRITE (opt-in; privilege-escalation surface) ───
    // OFF unless CCE_IAM_COPILOT_WRITE=1 at deploy. Even when granted, runtime
    // is still gated by runtime-config iam/apply_enabled + admin + confirm +
    // app-level guardrails. The explicit Deny protects the orchestrator's own
    // task role and the CDK bootstrap roles from being rewritten via the
    // copilot, defense-in-depth on top of the code guardrails.
    if (process.env.CCE_IAM_COPILOT_WRITE === '1') {
      this.taskRole.addToPolicy(
        new PolicyStatement({
          sid: 'IamCopilotWrite',
          effect: Effect.ALLOW,
          actions: [
            'iam:CreatePolicy',
            'iam:CreatePolicyVersion',
            'iam:PutRolePolicy',
            'iam:AttachRolePolicy',
            // NO iam:CreateUser: the copilot drafts and attaches policies to
            // EXISTING principals. Minting a fresh user is the one escalation
            // path the infra-role Deny below cannot cover (it can only
            // enumerate known role ARNs), so it stays ungranted.
            'iam:PutUserPolicy',
            'iam:AttachUserPolicy',
          ],
          resources: ['*'],
        }),
      );
      this.taskRole.addToPolicy(
        new PolicyStatement({
          sid: 'IamCopilotProtectInfraRoles',
          effect: Effect.DENY,
          actions: [
            'iam:PutRolePolicy',
            'iam:AttachRolePolicy',
            'iam:DeleteRolePolicy',
            'iam:DetachRolePolicy',
            'iam:UpdateAssumeRolePolicy',
            'iam:DeleteRole',
            'iam:PutRolePermissionsBoundary',
          ],
          resources: [
            `arn:aws:iam::${this.account}:role/CCE-Iam-TaskRole*`,
            `arn:aws:iam::${this.account}:role/cdk-hnb659fds-*`,
          ],
        }),
      );
    }

    // Narrow IAM read scoped to the task role's OWN posture only. Lets the
    // IAM posture card describe THIS role's inline + attached policies. The
    // role ARN is self-referential; policy ARNs cannot be pre-known, so the
    // GetPolicy / GetPolicyVersion pair stays at '*' (read-only, no mutate).
    this.taskRole.addToPolicy(
      new PolicyStatement({
        sid: 'IamSelfPostureReadOnly',
        effect: Effect.ALLOW,
        actions: [
          'iam:GetRole',
          'iam:ListRolePolicies',
          'iam:GetRolePolicy',
          'iam:ListAttachedRolePolicies',
        ],
        resources: [this.taskRole.roleArn],
      }),
    );
    // The IAM posture reader resolves its own role name via STS when the
    // CCE_TASK_ROLE_NAME env var is not set. GetCallerIdentity returns only
    // the caller's account/arn (no secret material); without it the IAM
    // cards fail soft to 'unknown'.
    this.taskRole.addToPolicy(
      new PolicyStatement({
        sid: 'PostureCallerIdentity',
        effect: Effect.ALLOW,
        actions: ['sts:GetCallerIdentity'],
        resources: ['*'],
      }),
    );
    this.taskRole.addToPolicy(
      new PolicyStatement({
        sid: 'IamSelfPostureManagedPolicyRead',
        effect: Effect.ALLOW,
        actions: ['iam:GetPolicy', 'iam:GetPolicyVersion'],
        // Managed-policy ARNs attached to the role are discovered at
        // runtime via ListAttachedRolePolicies, so they cannot be
        // enumerated here. Read-only describe of policy documents only.
        resources: ['*'],
      }),
    );

    // Tier 2: Athena + Glue catalog reads
    if (props.tier >= 2) {
      this.taskRole.addToPolicy(
        new PolicyStatement({
          sid: 'AthenaTier2',
          effect: Effect.ALLOW,
          actions: [
            'athena:StartQueryExecution',
            'athena:GetQueryExecution',
            'athena:GetQueryResults',
            'athena:StopQueryExecution',
          ],
          resources: [`arn:aws:athena:${this.region}:${this.account}:workgroup/claudeclaw`],
        }),
      );
      this.taskRole.addToPolicy(
        new PolicyStatement({
          sid: 'GlueTier2',
          effect: Effect.ALLOW,
          actions: ['glue:GetTable', 'glue:GetDatabase', 'glue:GetPartitions'],
          resources: [
            `arn:aws:glue:${this.region}:${this.account}:catalog`,
            `arn:aws:glue:${this.region}:${this.account}:database/claudeclaw_*`,
            `arn:aws:glue:${this.region}:${this.account}:table/claudeclaw_*/*`,
          ],
        }),
      );
    }
  }
}
