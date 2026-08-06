/**
 * Chaos engineering experiments (F3).
 *
 * Ships one AWS FIS experiment template that operators run on demand
 * to verify graceful degradation. The stack only defines the
 * template; `aws fis start-experiment` is operator-initiated. See
 * docs/runbooks/chaos-testing.md for the invocation commands.
 *
 *   - kill-fargate-task   stop one orchestrator task; ECS replaces it.
 *                         Validates that the surviving tasks absorb
 *                         traffic and the ALB target group recovers.
 *
 * Two additional experiments (Bedrock InvokeModel throttling and
 * SecretsManager GetSecretValue throttling) were originally drafted
 * but the FIS `aws:fis:inject-api-throttle-error` action does not
 * support `bedrock-runtime` or `secretsmanager` as target services
 * (CFN returns "service parameter value is not supported for the
 * action"). Simulating those failure modes therefore needs an
 * application-level fault injector inside the Bedrock client wrapper
 * and the secret-fetch helper. That work is tracked as a follow-up;
 * it does not block the kill-task experiment from shipping today.
 *
 * Gated on `tier >= 2`; lower tiers stay out of FIS scope so they
 * don't pay for an idle service. FIS templates themselves are free;
 * experiment runs are charged per action-minute (~$0.10 per minute).
 */

import { Stack, CfnOutput } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import {
  Role,
  ServicePrincipal,
  PolicyStatement,
  Effect,
} from 'aws-cdk-lib/aws-iam';
import { CfnExperimentTemplate } from 'aws-cdk-lib/aws-fis';
import { APP, RESOURCE_NAMES, TAGS } from './constants.js';
import type { BaseStackProps } from './interfaces.js';

export interface ChaosStackProps extends BaseStackProps {
  /** ARN of the orchestrator task role. The two throttle experiments
   * target this role so the injection blast radius is scoped to our
   * workload's IAM identity and cannot leak into anything else in the
   * account. */
  taskRoleArn: string;
}

export class ChaosStack extends Stack {
  public readonly killTaskTemplateId?: string;

  constructor(scope: Construct, id: string, props: ChaosStackProps) {
    super(scope, id, props);
    Object.entries(TAGS).forEach(([k, v]) => this.tags.setTag(k, v));

    // F3 ships on T2+. Below that the construct is a no-op so the
    // stack dependency graph stays uniform across tiers.
    if (props.tier < 2) return;

    const account = this.account;
    const region = this.region;
    const cluster = RESOURCE_NAMES.ecsCluster;
    const service = RESOURCE_NAMES.fargateService;

    // Per-experiment execution role. FIS assumes this to call the
    // targeted AWS APIs. We use one role rather than three because
    // the IAM blast radius is identical (read targets + invoke one
    // narrow action per experiment) and consolidating cuts CDK noise.
    const fisRole = new Role(this, 'FisExecRole', {
      roleName: `${APP}-chaos-exec`,
      assumedBy: new ServicePrincipal('fis.amazonaws.com'),
      description:
        'Assumed by AWS FIS to run chaos experiments against ClaudeClaw',
    });

    // ECS StopTask on the orchestrator cluster + service only.
    fisRole.addToPolicy(
      new PolicyStatement({
        sid: 'EcsStopTaskOrchestrator',
        effect: Effect.ALLOW,
        actions: ['ecs:StopTask', 'ecs:ListTasks', 'ecs:DescribeTasks'],
        resources: [
          `arn:aws:ecs:${region}:${account}:task/${cluster}/*`,
          `arn:aws:ecs:${region}:${account}:cluster/${cluster}`,
          `arn:aws:ecs:${region}:${account}:service/${cluster}/${service}`,
        ],
      }),
    );

    // FIS API-throttle injection needs no extra AWS API perms beyond
    // the FIS service principal. The Bedrock and SecretsManager
    // experiments below use that action.

    // CloudWatch metrics emission for the experiment's own status.
    fisRole.addToPolicy(
      new PolicyStatement({
        sid: 'FisLogging',
        effect: Effect.ALLOW,
        actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: [`arn:aws:logs:${region}:${account}:log-group:/aws/fis/*`],
      }),
    );

    // ── Experiment 1: kill a Fargate task ─────────────────────────
    // FIS picks one running task by tag and stops it. ECS rolls a
    // replacement; the ALB target group should remain healthy on the
    // surviving tasks throughout. Duration 0 (immediate) — the
    // disruption window is the time ECS takes to replace, ~30-60s.
    const killTask = new CfnExperimentTemplate(this, 'KillTaskTemplate', {
      description: 'Stop one orchestrator Fargate task; verify ECS replaces and ALB stays healthy',
      roleArn: fisRole.roleArn,
      tags: { Name: `${APP}-chaos-kill-fargate-task` },
      stopConditions: [
        // No CloudWatch alarm gate — the experiment is short and
        // self-bounded by the ECS replacement window. Add a gate
        // if you ever lift the experiment to "stop multiple tasks".
        { source: 'none' },
      ],
      targets: {
        Tasks: {
          resourceType: 'aws:ecs:task',
          selectionMode: 'COUNT(1)',
          resourceTags: {
            'aws:ecs:clusterName': cluster,
            'aws:ecs:serviceName': service,
          },
        },
      },
      actions: {
        StopTask: {
          actionId: 'aws:ecs:stop-task',
          parameters: {},
          targets: { Tasks: 'Tasks' },
        },
      },
    });
    this.killTaskTemplateId = killTask.attrId;

    new CfnOutput(this, 'KillTaskTemplateId', { value: killTask.attrId });
  }
}
