/**
 * CodeBuild project for image-only deploys.
 *
 * Triggered by a GitHub webhook on a DEPLOY-TAG push (default `deploy/v*`,
 * configurable via CCE_DEPLOY_TAG_PATTERN, see deploy-tag-pattern.ts).
 * Builds the Docker image, pushes to ECR, and rolls the Fargate service.
 * No local Docker needed.
 */

import { Stack, CfnOutput } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import {
  Project,
  Source,
  BuildSpec,
  LinuxBuildImage,
  BuildEnvironmentVariableType,
  FilterGroup,
  EventAction,
} from 'aws-cdk-lib/aws-codebuild';
import {
  Role,
  ServicePrincipal,
  PolicyStatement,
  Effect,
} from 'aws-cdk-lib/aws-iam';
import { TAGS, RESOURCE_NAMES } from './constants.js';
import { normalizeDeployTagPattern } from './deploy-tag-pattern.js';
import type { BaseStackProps } from './interfaces.js';

export interface CodeBuildStackProps extends BaseStackProps {
  githubOwner: string;
  githubRepo: string;
  githubBranch?: string;
}

export class CodeBuildStack extends Stack {
  constructor(scope: Construct, id: string, props: CodeBuildStackProps) {
    super(scope, id, props);
    Object.entries(TAGS).forEach(([k, v]) => this.tags.setTag(k, v));

    const branch = props.githubBranch ?? 'main';

    // ONE source of truth for the deploy-tag namespace (item 39): the
    // webhook filter below, the buildspec runtime refusal, and the GitHub
    // rulesets operators are told to create are all derived from the same
    // normalized CCE_DEPLOY_TAG_PATTERN (default `deploy/v*`). Validation
    // throws at synth on ambiguous patterns or anything overlapping the
    // upstream `v*` release namespace.
    const deployTag = normalizeDeployTagPattern(process.env);

    const buildRole = new Role(this, 'CodeBuildRole', {
      assumedBy: new ServicePrincipal('codebuild.amazonaws.com'),
      description: 'CodeBuild role for ClaudeClaw image-only deploys',
    });

    buildRole.addToPolicy(
      new PolicyStatement({
        sid: 'EcrAuth',
        effect: Effect.ALLOW,
        actions: ['ecr:GetAuthorizationToken'],
        resources: ['*'],
      }),
    );
    buildRole.addToPolicy(
      new PolicyStatement({
        sid: 'EcrPush',
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
        ],
        resources: [
          `arn:aws:ecr:${this.region}:${this.account}:repository/${RESOURCE_NAMES.ecrRepo}`,
        ],
      }),
    );
    buildRole.addToPolicy(
      new PolicyStatement({
        sid: 'EcsRoll',
        effect: Effect.ALLOW,
        actions: [
          'ecs:UpdateService',
          'ecs:DescribeServices',
          'ecs:DescribeTasks',
          'ecs:ListTasks',
          'ecs:DescribeTaskDefinition',
          'ecs:RegisterTaskDefinition',
        ],
        resources: ['*'],
      }),
    );
    buildRole.addToPolicy(
      new PolicyStatement({
        sid: 'PassRoleForTaskDef',
        effect: Effect.ALLOW,
        actions: ['iam:PassRole'],
        resources: [`arn:aws:iam::${this.account}:role/*`],
        conditions: {
          StringEquals: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' },
        },
      }),
    );
    buildRole.addToPolicy(
      new PolicyStatement({
        sid: 'Logs',
        effect: Effect.ALLOW,
        actions: [
          'logs:CreateLogGroup',
          'logs:CreateLogStream',
          'logs:PutLogEvents',
        ],
        resources: ['*'],
      }),
    );

    // Unified-deploy (CCE_DEPLOY_INFRA=1) needs to run `cdk deploy`, which works
    // by assuming the CDK bootstrap roles. Grant only that (not raw admin) —
    // the bootstrap roles carry the deploy permissions. Harmless when the
    // unified path is off.
    buildRole.addToPolicy(
      new PolicyStatement({
        sid: 'AssumeCdkBootstrapRoles',
        effect: Effect.ALLOW,
        actions: ['sts:AssumeRole'],
        resources: [`arn:aws:iam::${this.account}:role/cdk-hnb659fds-*`],
      }),
    );

    // Forwarded so a unified deploy reproduces the deployed state (esp.
    // DOMAIN_NAME for the HTTPS edge). Sourced from the env that deploys this
    // stack. CCE_DAILY_COST_CAP_USD is deliberately NOT forwarded.
    const plain = (v: string | undefined) => ({
      type: BuildEnvironmentVariableType.PLAINTEXT,
      value: v ?? '',
    });

    const project = new Project(this, 'DeployProject', {
      projectName: `${RESOURCE_NAMES.ecrRepo}-deploy`,
      description: 'Build + push Docker image, roll Fargate service',
      role: buildRole,
      environment: {
        buildImage: LinuxBuildImage.STANDARD_7_0,
        privileged: true,
      },
      environmentVariables: {
        AWS_ACCOUNT_ID: { type: BuildEnvironmentVariableType.PLAINTEXT, value: this.account },
        AWS_DEFAULT_REGION: { type: BuildEnvironmentVariableType.PLAINTEXT, value: this.region },
        // Unified-deploy toggle + the env a `cdk deploy` needs. Default OFF
        // (image-only). Set CCE_DEPLOY_INFRA=1 (in the env that deploys this
        // stack) to make every release also reconcile infra — but only after
        // DOMAIN_NAME and the model IDs below are populated, or the buildspec
        // guard aborts.
        CCE_DEPLOY_INFRA: plain(process.env.CCE_DEPLOY_INFRA),
        CDK_STACK_NAME: plain(process.env.CDK_STACK_NAME ?? 'CCE'),
        DEPLOY_TIER: plain(process.env.DEPLOY_TIER ?? process.env.CCE_TIER),
        DOMAIN_NAME: plain(process.env.DOMAIN_NAME),
        BEDROCK_OPUS_MODEL: plain(process.env.BEDROCK_OPUS_MODEL),
        BEDROCK_SONNET_MODEL: plain(process.env.BEDROCK_SONNET_MODEL),
        BEDROCK_HAIKU_MODEL: plain(process.env.BEDROCK_HAIKU_MODEL),
        BEDROCK_DEFAULT_MODEL: plain(process.env.BEDROCK_DEFAULT_MODEL),
        BEDROCK_EMBED_MODEL: plain(process.env.BEDROCK_EMBED_MODEL),
        CCE_IAM_COPILOT_WRITE: plain(process.env.CCE_IAM_COPILOT_WRITE),
        CCE_COST_ALERT_EMAIL: plain(process.env.CCE_COST_ALERT_EMAIL),
        CCE_MONTHLY_BUDGET_USD: plain(process.env.CCE_MONTHLY_BUDGET_USD),
        CCE_ANOMALY_MONITOR_ARN: plain(process.env.CCE_ANOMALY_MONITOR_ARN),
        // The NORMALIZED deploy-tag pattern, injected so the buildspec's
        // runtime refusal provably guards the same namespace as the webhook
        // filter below. buildspec.yml falls back to the same default when
        // this is unset (manual project setups); both ultimately trace to
        // infra/lib/deploy-tag-pattern.ts.
        CCE_DEPLOY_TAG_PATTERN: plain(deployTag.pattern),
      },
      source: Source.gitHub({
        owner: props.githubOwner,
        repo: props.githubRepo,
        branchOrRef: branch,
        // ── BEHAVIOR CHANGE (item 39) ────────────────────────────────────
        // This project used to auto-deploy on UPSTREAM release tags
        // (`andTagIs('v.*')`, i.e. any v-prefixed tag push). It now deploys
        // ONLY on deploy-namespace tags: EVENT=PUSH AND HEAD_REF matching
        // the ANCHORED regex derived from CCE_DEPLOY_TAG_PATTERN (default
        // `^refs/tags/deploy/v.*$`). Pushing `v1.2.3` no longer ships;
        // pushing `deploy/v1.2.3` does. Rationale: in a fork, an upstream
        // release tag must never deploy into the fork owner's AWS account,
        // so the "upstream release" (`v*`) and "deploy to my account"
        // (`deploy/v*`) tag namespaces are split. The buildspec re-checks
        // the same pattern at runtime (defense in depth); both sides derive
        // from infra/lib/deploy-tag-pattern.ts.
        //
        // Note: an EMPTY webhookFilters array does NOT enable a webhook (CDK
        // only turns it on with at least one filter group). Webhook creation
        // uses the account-level GitHub PERSONAL_ACCESS_TOKEN source credential.
        webhook: true,
        webhookFilters: [
          FilterGroup.inEventOf(EventAction.PUSH).andHeadRefIs(
            deployTag.webhookHeadRefPattern,
          ),
        ],
      }),
      buildSpec: BuildSpec.fromSourceFilename('buildspec.yml'),
    });

    project.addToRolePolicy(
      new PolicyStatement({
        sid: 'CodeBuildReportGroup',
        effect: Effect.ALLOW,
        actions: ['codebuild:CreateReportGroup', 'codebuild:CreateReport', 'codebuild:BatchPutTestCases'],
        resources: ['*'],
      }),
    );

    new CfnOutput(this, 'ProjectName', { value: project.projectName });
    new CfnOutput(this, 'ProjectArn', { value: project.projectArn });
  }
}
