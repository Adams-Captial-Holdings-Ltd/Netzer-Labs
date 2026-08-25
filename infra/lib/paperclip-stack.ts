import { Stack, Duration, CfnOutput } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Repository } from 'aws-cdk-lib/aws-ecr';
import {
  ContainerImage,
  CpuArchitecture,
  FargateService,
  FargateTaskDefinition,
  LogDrivers,
  OperatingSystemFamily,
  Secret as EcsSecret,
  PropagatedTagSource,
  type ICluster,
} from 'aws-cdk-lib/aws-ecs';
import { SubnetType, type IVpc, type SecurityGroup } from 'aws-cdk-lib/aws-ec2';
import {
  ApplicationProtocol,
  ApplicationTargetGroup,
  TargetType,
} from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Role, ServicePrincipal, PolicyStatement, Effect } from 'aws-cdk-lib/aws-iam';
import { Secret as SmSecret, type ISecret } from 'aws-cdk-lib/aws-secretsmanager';
import type { IFileSystem, IAccessPoint } from 'aws-cdk-lib/aws-efs';
import type { ILogGroup } from 'aws-cdk-lib/aws-logs';
import { PrivateDnsNamespace, DnsRecordType } from 'aws-cdk-lib/aws-servicediscovery';
import {
  APP,
  PAPERCLIP_PORT,
  RESOURCE_NAMES,
  TAGS,
  paperclipProvisioned,
} from './constants.js';
import type { BaseStackProps } from './interfaces.js';

/**
 * Container name of the Paperclip server. MUST stay equal to
 * `PAPERCLIP_CONTAINER_NAME` in `scripts/lib/lifecycle/manifest.ts`, which
 * Phase 1.5 wrote as a PREDICTION of what this stack would choose: the deploy
 * manifest records `(taskFamily, containerName, digest)` for rollback, so a
 * mismatch records a rollback target that matches nothing in ECS. Phase 4 owns
 * both strings; this file is where the prediction is either confirmed or
 * changed, and changing it means changing manifest.ts, `buildImageRecords()`
 * and the literals in `paperclip-image-pipeline.test.ts` in the same commit.
 *
 * It also matches upstream's own `docker/ecs-task-definition.json`, so an
 * operator comparing the two sees the same names.
 */
const PAPERCLIP_CONTAINER = 'paperclip-server';

/** Task-def family. Mirrors `${app}-paperclip` in buildImageRecords(). */
const PAPERCLIP_TASK_FAMILY = `${APP}-paperclip`;

/**
 * One-shot migration task-def family. `scripts/deploy.ts` phase b.5 runs it
 * with `aws ecs run-task` between phase b (secrets) and phase c (seed), and
 * refuses to continue on a non-zero exit.
 */
const PAPERCLIP_MIGRATE_TASK_FAMILY = `${APP}-paperclip-migrate`;

/** Health path. Verified against the pinned artifact: `GET /api/health` 200. */
const PAPERCLIP_HEALTH_PATH = '/api/health';

/**
 * The migration entrypoint, verified BY EXECUTION against the pinned artifact
 * on 2026-08-21: run inside the image with DATABASE_URL set it prints
 * "Migrating database via DATABASE_URL" then either "No pending migrations"
 * or "Migrations complete", and exits 0. It is idempotent, and it throws (exit
 * non-zero) when migrations end incomplete — which is exactly the signal phase
 * b.5 aborts the deploy on. The tsx loader is the image's own: its default CMD
 * is `node --import ./server/node_modules/tsx/dist/loader.mjs server/dist/index.js`,
 * so this only swaps the script, never the runtime.
 *
 * Two things previously carried as UNVERIFIED here are now SETTLED BY PROBE
 * (2026-08-21, pinned artifact against a local Postgres 17 reduced to
 * hostssl-only, i.e. the Aurora `rds.force_ssl=1` default):
 *
 *  1. The embedded-postgres fallback is NOT the silent false green it was
 *     recorded as. With DATABASE_URL empty the resolver does reach
 *     `ensureEmbeddedPostgresConnection`, but it exits **1**: the container
 *     runs as root (the image sets no USER and this task definition sets no
 *     `user`) and embedded-postgres refuses to run as root. The guard in
 *     phase b.5 stays regardless — what makes it exit 1 is a root check, not
 *     a refusal to migrate the wrong database, so the protection is
 *     incidental and would vanish the day this task definition gains a
 *     non-root user.
 *  2. The connection MUST carry `?sslmode=require`. Without it the job fails
 *     `no pg_hba.conf entry ... no encryption`; with it, 182 migrations
 *     applied and exit 0, and a re-run prints "No pending migrations".
 *     Both deploy drivers append it; see PAPERCLIP_DB_URL_TLS_SUFFIX in
 *     scripts/deploy.ts and the cross-driver test in paperclip-stack.test.ts.
 */
const PAPERCLIP_MIGRATE_COMMAND = [
  'node',
  '--import',
  './server/node_modules/tsx/dist/loader.mjs',
  'packages/db/src/migrate.ts',
];

export interface PaperclipStackProps extends BaseStackProps {
  vpc: IVpc;
  /** Task SG from network-stack: orchestrator -> 3100 ingress, NAT egress. */
  paperclipSecurityGroup: SecurityGroup;
  /** Reused from compute-stack; a second cluster would buy nothing. */
  cluster: ICluster;
  /**
   * EFS + access point (posix 1000:1000, path /paperclip) + log group.
   * All three are UNDEFINED at Tier 0, where FilesystemStack creates nothing
   * — and so does this stack, which returns before it reads them.
   */
  fileSystem?: IFileSystem;
  accessPoint?: IAccessPoint;
  logGroup?: ILogGroup;
  /** `/claudeclaw[-suffix]/paperclip` — better_auth_secret + database_url. */
  paperclipSecret: ISecret;
  /**
   * `sha256:...` of the patched image built in Phase 3. Read from the env by
   * `infra/bin/app.ts`, never by this file: a stack that reads the ambient
   * process environment decides what EXISTS from ambient state, which is the
   * M33 defect. A colocated test greps this file to keep it that way.
   */
  imageDigest?: string;
  /** First-deploy escape hatch. See `desiredCount` below; default `false`. */
  bootstrapWithoutTasks?: boolean;
}

/**
 * The Paperclip work engine as a Fargate service (ADR 0010 Phase 2 / the
 * bar-and-phases Phase 4 + 4.5).
 *
 * The shape is copied from compute-stack, but three settings are DELIBERATELY
 * INVERTED and a fourth is deliberately absent. Read this before "making it
 * consistent" with the orchestrator:
 *
 *  1. `desiredCount: 1` and NO auto-scaling. Paperclip keeps node-local state:
 *     git worktrees, spawned child processes, an in-process port registry, and
 *     a PROCESS-LOCAL worktree cleanup lock. EFS does not fix that — the lock
 *     does not coordinate across processes, so a second task corrupts shared
 *     state rather than sharing it. `paperclip-stack.test.ts` asserts that no
 *     `AWS::ApplicationAutoScaling::ScalableTarget` exists for this service,
 *     precisely so a future "consistency" refactor fails loudly.
 *  2. `minHealthyPercent: 0` / `maxHealthyPercent: 100` — the inverse of the
 *     orchestrator's 100/200. At 100/200 a roll would briefly run TWO tasks,
 *     which is the exact condition (1) forbids. The cost is a short gap in
 *     availability on every deploy; that is the correct trade for a
 *     single-writer service.
 *  3. NO `PAPERCLIP_MIGRATION_AUTO_APPLY` on the service. Schema migration is
 *     the one-shot job's, not the long-running service's: a service that
 *     migrates on boot turns a rollout into an unreviewed DDL run, and with
 *     `minHealthyPercent: 0` it would do so with no healthy task to fall back
 *     to. (The variable is also absent from the MIGRATE container, because a
 *     probe of the pinned artifact found `packages/db/src/migrate.ts` reads no
 *     environment at all — it was decoration that read as a control.)
 *  4. NO `PAPERCLIP_DEPLOYMENT_MODE=local_trusted`, ever. That mode makes
 *     every request an instance admin with no credential at all.
 *
 * ── READINESS, AND WHAT HAPPENS WHEN THE CHECK FAILS (M33) ─────────────
 *
 * Paperclip needs a migrated database and a populated secret before its first
 * task can be healthy, so there IS a first-deploy problem. The first attempt
 * at this stack solved it by making the SERVICE ITSELF conditional on a probe.
 * That is rejected and must not come back, because CloudFormation deletes what
 * a template omits: on CI, a fresh clone, or a second engineer's machine the
 * probe could never succeed, so an armed `cdk deploy --all` would have DELETED
 * a running service and its target-group attachment and exited 0.
 *
 * The rule this stack now follows: **nothing decides whether a resource
 * exists.** The service, both task definitions and the target group are
 * unconditional. The only thing readiness moves is
 * `desiredCount`, and only in the create direction that is safe:
 *
 *   | State of the flag                     | Effect on a service that ALREADY EXISTS |
 *   | ------------------------------------- | --------------------------------------- |
 *   | unset / empty / unreadable (default)   | `DesiredCount: 1` — untouched, keeps    |
 *   |                                        | running. This is the CI and fresh-clone |
 *   |                                        | case, and it is the SAFE default.       |
 *   | `CCE_PAPERCLIP_BOOTSTRAP=1` (explicit) | `DesiredCount: 0` — scales to zero. The |
 *   |                                        | service, its ARN, its target-group      |
 *   |                                        | attachment survive; one redeploy without|
 *   |                                        | the flag restores it. A recoverable     |
 *   |                                        | outage, not an unrecoverable delete.    |
 *
 * `desiredCount: 0` means no task starts, so no rollout fails, so
 * CloudFormation does not roll CCE-Paperclip back and the migration task
 * definition survives to be run.
 *
 * WHO SETS IT, and this changed in Phase 9. It is still an operator escape
 * hatch — an operator may set it at any time to park the service — but it is
 * NO LONGER "the first armed deploy only", because there is no armed deploy
 * any more: the substrate installs at Tier 1+ by default, so the first-install
 * case is the DEFAULT path and cannot depend on a human having set a variable.
 * Both deploy drivers now arm it for themselves on that one path and clear it
 * in the same run (`scripts/deploy.ts` phase b.5, and the "Migrate Paperclip
 * database" step in `.github/workflows/deploy.yml`).
 *
 * That is not the probe this stack rejects. The rejected one let a probe
 * decide whether the SERVICE EXISTS and read "I could not find out" as "not
 * ready" — the conflation that removed the cloudflared sidecar from production
 * on 2026-08-14. The drivers arm this flag only on an AFFIRMATIVE "the stack
 * is not there", where no service exists to scale down; every unreadable probe
 * still fails the deploy. And the worst this flag can ever do is move
 * DesiredCount, per the table above.
 *
 * ── THE ONE THING THAT DECIDES WHETHER ANY OF IT EXISTS ────────────────
 *
 * The tier, and nothing else. This stack is now part of a standard install:
 * it is always CONSTRUCTED (so `npx cdk ls` prints the same names at every
 * tier and under every value of CCE_PAPERCLIP_ENABLED), and at Tier 0 it
 * creates nothing — see TierShape.paperclipEnabled for why Hobby is out.
 * That is a tier knob an operator picks once at install time, not a per-deploy
 * flag, so it cannot flicker a running service in and out of a template the
 * way the rejected probe would have.
 *
 * CCE_PAPERCLIP_ENABLED no longer reaches this file, or synth at all. It
 * survives as the RUNTIME router flag the orchestrator task reads
 * (src/lib/missions/mission-acl.ts), which is a separate decision:
 * provisioning the engine and serving `/api/missions` from it are different
 * changes and retire on different schedules.
 */
export class PaperclipStack extends Stack {
  /** Undefined at Tier 0, where this stack creates no resources at all. */
  public readonly service: FargateService | undefined;

  constructor(scope: Construct, id: string, props: PaperclipStackProps) {
    super(scope, id, props);
    Object.entries(TAGS).forEach(([k, v]) => this.tags.setTag(k, v));

    // Tier 0 (Hobby): no service, no task definitions, no target group, no
    // roles. Nothing here is stateful, so a later tier bump creates it all.
    if (!paperclipProvisioned(props.tier)) return;

    // Above Tier 0 the FilesystemStack really did create these, so an absent
    // one is a wiring mistake rather than a tier. Fail at synth, loudly,
    // instead of rendering a task definition with no volume.
    const { fileSystem, accessPoint, logGroup } = props;
    if (!fileSystem || !accessPoint || !logGroup) {
      throw new Error(
        `PaperclipStack at tier ${props.tier} requires the FilesystemStack outputs ` +
          '(fileSystem, accessPoint, logGroup); one of them is undefined.',
      );
    }

    const account = this.account;
    const region = this.region;

    // ── Image, pinned BY DIGEST ─────────────────────────────────
    // Phase 3 builds the pinned+patched image into this repo and records its
    // digest in the deploy manifest. The task definition references the
    // DIGEST, never a tag: `:latest` is deliberately never published into
    // this repo, and a mutable tag would make an archived-template rollback
    // non-reproducible.
    const ecrRepo = Repository.fromRepositoryName(
      this,
      'PaperclipRepo',
      RESOURCE_NAMES.paperclipEcrRepo,
    );
    // `EcrImage` renders `uri@sha256:...` for a digest and `uri:tag` for a
    // tag, so this placeholder keeps a bare `cdk synth` / `cdk ls` resolvable
    // (both are required to work with the flag armed) without ever letting a
    // mutable tag reach a real task definition. BOTH deploy drivers forward a
    // real digest: scripts/deploy.ts via cdkEnvBag, and CI via the
    // `paperclip_digest` output of the Paperclip build step. A task definition
    // carrying this placeholder cannot pull, which is a loud failure — the
    // direction to fail in.
    const imageRef = props.imageDigest?.trim() || 'paperclip-digest-unset';
    const paperclipImage = ContainerImage.fromEcrRepository(ecrRepo, imageRef);

    // ── Execution role ──────────────────────────────────────────
    // Local to this stack for the same reason compute-stack keeps its own:
    // EcsSecret.fromSecretsManager auto-grants read on the secret, and a
    // shared role would make that grant a bidirectional cross-stack
    // reference. The explicit statements below mirror compute-stack's.
    const executionRole = new Role(this, 'PaperclipExecutionRole', {
      assumedBy: new ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'ECS task execution role for the Paperclip work engine',
    });
    executionRole.addToPolicy(
      new PolicyStatement({
        sid: 'EcrAuth',
        effect: Effect.ALLOW,
        actions: ['ecr:GetAuthorizationToken'],
        resources: ['*'],
      }),
    );
    executionRole.addToPolicy(
      new PolicyStatement({
        sid: 'EcrPull',
        effect: Effect.ALLOW,
        actions: [
          'ecr:BatchCheckLayerAvailability',
          'ecr:GetDownloadUrlForLayer',
          'ecr:BatchGetImage',
        ],
        resources: [ecrRepo.repositoryArn],
      }),
    );
    executionRole.addToPolicy(
      new PolicyStatement({
        sid: 'Logs',
        effect: Effect.ALLOW,
        actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: [`arn:aws:logs:${region}:${account}:log-group:/claudeclaw/*`],
      }),
    );
    // The Aurora-generated credentials secret is read by scripts/deploy.ts
    // (phase b.5 composes DATABASE_URL from it), not by the container — but
    // the execution role is granted on it by NAME PATTERN so a future field
    // injection does not fail at task start with a ResourceInitializationError
    // instead of an application error. The trailing `-*` is Secrets Manager's
    // six-character ARN suffix, which is not knowable at synth time.
    const secretArns = [
      props.paperclipSecret.secretArn,
      `arn:aws:secretsmanager:${region}:${account}:secret:${RESOURCE_NAMES.secrets.paperclipDb}-*`,
    ];
    executionRole.addToPolicy(
      new PolicyStatement({
        sid: 'SecretsRead',
        effect: Effect.ALLOW,
        actions: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'],
        resources: secretArns,
      }),
    );
    executionRole.addToPolicy(
      new PolicyStatement({
        sid: 'KmsDecryptForSecrets',
        effect: Effect.ALLOW,
        actions: ['kms:Decrypt', 'kms:DescribeKey'],
        resources: ['*'],
        conditions: {
          StringEquals: { 'kms:ViaService': `secretsmanager.${region}.amazonaws.com` },
        },
      }),
    );

    // ── Task role ───────────────────────────────────────────────
    // Deliberately NOT the orchestrator's task role (iam-stack): DL-2 is a
    // service boundary, and Paperclip must never inherit Bedrock, DynamoDB or
    // S3 grants. It gets EFS access and the SSM messages channel, the latter
    // because `aws ecs execute-command` is the only way to run the one-time
    // `auth bootstrap-ceo` against a private, internal-only instance.
    const taskRole = new Role(this, 'PaperclipTaskRole', {
      assumedBy: new ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'Runtime identity for the Paperclip work engine',
    });
    taskRole.addToPolicy(
      new PolicyStatement({
        sid: 'EfsAccessPoint',
        effect: Effect.ALLOW,
        actions: [
          'elasticfilesystem:ClientMount',
          'elasticfilesystem:ClientWrite',
          'elasticfilesystem:ClientRootAccess',
        ],
        resources: [fileSystem.fileSystemArn],
        conditions: {
          StringEquals: {
            'elasticfilesystem:AccessPointArn': accessPoint.accessPointArn,
          },
        },
      }),
    );
    taskRole.addToPolicy(
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

    // Re-import by ARN so CDK's auto-grant cannot rewrite the source stack's
    // resource policy and cycle the two stacks (compute-stack's pattern).
    const paperclipSecret = SmSecret.fromSecretCompleteArn(
      this,
      'PaperclipSecretImport',
      props.paperclipSecret.secretArn,
    ) as SmSecret;

    // ── UI serving + browser-origin trust (Phase 4.5) ───────────
    // SERVE_UI=true serves Paperclip's OWN built React board from the same
    // origin as its API. That matters twice over: Paperclip ships NO CORS
    // middleware, so a browser cannot call it cross-origin at all, and
    // `boardMutationGuard` builds its trusted-origin set from localhost:3100,
    // 127.0.0.1:3100, the request Host/X-Forwarded-Host, and
    // PAPERCLIP_PUBLIC_URL. Set PAPERCLIP_PUBLIC_URL to anything other than
    // the exact hostname the browser types and EVERY board mutation answers
    // 403 "Board mutation requires trusted browser origin".
    //
    // The console is SSM-tunnel-only until a separate access-controlled
    // listener contract exists. Do not guess PAPERCLIP_PUBLIC_URL: the SSM
    // request Host is the exact browser origin and boardMutationGuard trusts
    // it. A guessed hosted URL would only make legitimate mutations fail.

    // ── Service task definition ─────────────────────────────────
    const taskDef = new FargateTaskDefinition(this, 'PaperclipTaskDef', {
      family: PAPERCLIP_TASK_FAMILY,
      // Upstream's own docker/ecs-task-definition.json sizes the server at
      // 2 vCPU / 4 GB. Not tiered: Paperclip spawns agent child processes
      // inside the task, and a smaller shape starves them.
      cpu: 2048,
      memoryLimitMiB: 4096,
      runtimePlatform: {
        operatingSystemFamily: OperatingSystemFamily.LINUX,
        // The whole compute plane is ARM64 (Graviton). The pinned upstream
        // artifact is a multi-arch index, so a wrong-platform build produces
        // amd64 that crash-loops with "exec format error"; the CodeBuild
        // buildspec's `test "$ARCH" = "arm64"` gate is the other half of this.
        cpuArchitecture: CpuArchitecture.ARM64,
      },
      taskRole,
      executionRole,
    });

    // EFS holds PAPERCLIP_HOME: instance config.json, git worktrees, and the
    // secrets master key file. The access point pins posix 1000:1000 and root
    // /paperclip, matching the `node` user the image's docker-entrypoint drops
    // to; rootDirectory is therefore left to the access point.
    taskDef.addVolume({
      name: 'paperclip-data',
      efsVolumeConfiguration: {
        fileSystemId: fileSystem.fileSystemId,
        transitEncryption: 'ENABLED',
        authorizationConfig: {
          accessPointId: accessPoint.accessPointId,
          iam: 'ENABLED',
        },
      },
    });

    const serviceContainer = taskDef.addContainer(PAPERCLIP_CONTAINER, {
      image: paperclipImage,
      containerName: PAPERCLIP_CONTAINER,
      portMappings: [{ containerPort: PAPERCLIP_PORT }],
      essential: true,
      logging: LogDrivers.awsLogs({ streamPrefix: 'server', logGroup }),
      environment: {
        NODE_ENV: 'production',
        HOST: '0.0.0.0',
        PORT: String(PAPERCLIP_PORT),
        PAPERCLIP_HOME: '/paperclip',
        PAPERCLIP_INSTANCE_ID: 'default',
        PAPERCLIP_CONFIG: '/paperclip/instances/default/config.json',
        // Phase 4.5: serve Paperclip's own built board. The image already
        // ships /app/ui/dist; vendor/paperclip/Dockerfile symlinks it to the
        // /app/server/ui-dist path the server actually resolves.
        //
        // LEDGER A38, and it is the reason no browser listener is emitted:
        // serving the board also serves `POST /api/auth/sign-up/email`, which
        // the probed artifact answers 200 to WITH NO CREDENTIAL, even under
        // PAPERCLIP_DEPLOYMENT_MODE=authenticated below. Open self-
        // registration is therefore contained by NETWORK POSTURE ONLY: the
        // console is reachable only through the AWS-authenticated SSM tunnel.
        // Anyone who reaches the board can create themselves an account.
        // Whoever wires that rule must put an authorizer in front of it or
        // close sign-up upstream FIRST — this flag is not a control.
        SERVE_UI: 'true',
        // NEVER local_trusted (Phase 4.5 acceptance 1). Note this does not
        // gate sign-up; see the A38 note above.
        PAPERCLIP_DEPLOYMENT_MODE: 'authenticated',
        PAPERCLIP_DEPLOYMENT_EXPOSURE: 'private',
        // PAPERCLIP_MIGRATION_AUTO_APPLY is deliberately ABSENT here. See the
        // class doc; paperclip-stack.test.ts asserts the absence.
      },
      secrets: {
        // Composed and written by scripts/deploy.ts phase b.5 and by the CI
        // workflow's "Populate Paperclip secret" step (the Aurora secret is
        // RDS-managed and carries no URL form). Field spelling is load-bearing:
        // a mismatch is a ResourceInitializationError at task start, not an
        // application error.
        DATABASE_URL: EcsSecret.fromSecretsManager(paperclipSecret, 'database_url'),
        BETTER_AUTH_SECRET: EcsSecret.fromSecretsManager(
          paperclipSecret,
          'better_auth_secret',
        ),
      },
      healthCheck: {
        // `curl` is present at /usr/bin/curl in the pinned image (probed
        // 2026-08-21). A container health check that names a binary the image
        // does not ship reports UNHEALTHY forever, and at minHealthyPercent 0
        // that is an outage rather than a warning, so the probe is the claim.
        command: [
          'CMD-SHELL',
          `curl -f http://127.0.0.1:${PAPERCLIP_PORT}${PAPERCLIP_HEALTH_PATH} || exit 1`,
        ],
        interval: Duration.seconds(30),
        timeout: Duration.seconds(5),
        retries: 3,
        startPeriod: Duration.seconds(90),
      },
    });
    serviceContainer.addMountPoints({
      sourceVolume: 'paperclip-data',
      containerPath: '/paperclip',
      readOnly: false,
    });

    // ── One-shot migration task definition ──────────────────────
    // Same image, migration command, and NO EFS volume: the migration talks
    // only to Aurora, so mounting PAPERCLIP_HOME would give a job that has no
    // business touching worktrees write access to them, and would make the job
    // wait on a mount target it does not need. Mirrors the ConsolidationTaskDef
    // pattern in compute-stack (same image, different command, no ports).
    //
    // Unconditional, like everything else here. Phase b.5 needs it to exist
    // BEFORE it can migrate, and a template that omits it on any deploy would
    // delete the one thing the recovery path depends on.
    const migrateTaskDef = new FargateTaskDefinition(this, 'PaperclipMigrateTaskDef', {
      family: PAPERCLIP_MIGRATE_TASK_FAMILY,
      cpu: 512,
      memoryLimitMiB: 1024,
      runtimePlatform: {
        operatingSystemFamily: OperatingSystemFamily.LINUX,
        cpuArchitecture: CpuArchitecture.ARM64,
      },
      executionRole,
    });
    migrateTaskDef.addContainer('migrate', {
      image: paperclipImage,
      containerName: 'migrate',
      command: PAPERCLIP_MIGRATE_COMMAND,
      essential: true,
      logging: LogDrivers.awsLogs({ streamPrefix: 'migrate', logGroup }),
      environment: {
        NODE_ENV: 'production',
        PAPERCLIP_HOME: '/tmp/paperclip',
      },
      secrets: {
        DATABASE_URL: EcsSecret.fromSecretsManager(paperclipSecret, 'database_url'),
      },
    });

    // ── Target group ────────────────────────────────────────────
    const targetGroup = new ApplicationTargetGroup(this, 'PaperclipTargetGroup', {
      vpc: props.vpc,
      targetGroupName: `${APP}-paperclip-tg`,
      port: PAPERCLIP_PORT,
      protocol: ApplicationProtocol.HTTP,
      targetType: TargetType.IP,
      healthCheck: {
        path: PAPERCLIP_HEALTH_PATH,
        healthyHttpCodes: '200',
        interval: Duration.seconds(30),
        timeout: Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
      // Short, because a roll already drops to zero healthy targets
      // (minHealthyPercent 0) and a long drain only lengthens that window.
      deregistrationDelay: Duration.seconds(20),
    });

    // ── Operator console posture (Phase 4.5) ────────────────────
    // The pinned artifact keeps email self-registration open even in
    // authenticated mode (A38). Therefore this stack deliberately emits NO
    // listener rule onto Compute's potentially internet-facing ALB. The only
    // supported operator path is the AWS-authenticated ECS Exec/SSM tunnel to
    // port 3100. This also handles the normal no-listener environments without
    // inventing a certificate, public hostname or false access guarantee.

    // ── Service discovery (Cloud Map) ───────────────────────────
    // THE ROUTE THE ORCHESTRATOR ACTUALLY USES, and until now there was none.
    // Before Cloud Map, a standard install brought up a Paperclip task with no
    // stable address the orchestrator could call; PAPERCLIP_BASE_URL appeared
    // nowhere in infra/.
    //
    // A private DNS namespace gives a STABLE name (`paperclip.<app>.internal`)
    // in front of an ephemeral task IP, which is the property that matters:
    // `desiredCount: 1` with `minHealthyPercent: 0` means every deploy replaces
    // the task and its IP, so anything that cached an IP would break on the
    // next roll. The record is app-suffixed and the namespace is attached to
    // THIS app's VPC; see RESOURCE_NAMES.paperclipNamespace for the collision
    // argument.
    //
    // The orchestrator does NOT learn this name through a cross-stack
    // reference. CCE-Compute is created BEFORE CCE-Paperclip (Paperclip
    // imports Compute's cluster and listener), so a reference in that
    // direction is a cycle; compute-stack builds the same string from
    // RESOURCE_NAMES instead, exactly as it already does for every other
    // deterministic name it hands the task.
    //
    // ADDITIVE. The target group remains for ECS health; no browser listener
    // is attached while A38 remains true.
    const namespace = new PrivateDnsNamespace(this, 'PaperclipNamespace', {
      name: RESOURCE_NAMES.paperclipNamespace,
      vpc: props.vpc,
      description: 'Private DNS for the Paperclip work engine (ADR 0010)',
    });

    // ── The service. Unconditional; see the M33 table in the class doc ──
    this.service = new FargateService(this, 'PaperclipService', {
      serviceName: `${APP}-paperclip`,
      cluster: props.cluster,
      taskDefinition: taskDef,
      // EXPLICIT, unlike compute-stack which omits it so autoscaling owns the
      // count. There is no autoscaling here and there must never be one, so
      // the template pins the count — 1 normally, 0 only when an operator has
      // deliberately asked for a bootstrap deploy that starts no task. Zero
      // scales a service down; it never deletes one.
      desiredCount: props.bootstrapWithoutTasks ? 0 : 1,
      securityGroups: [props.paperclipSecurityGroup],
      vpcSubnets: { subnetType: SubnetType.PRIVATE_WITH_EGRESS },
      assignPublicIp: false,
      // The break-glass path, and the ONLY way to run the one-time
      // `auth bootstrap-ceo` against a private instance.
      enableExecuteCommand: true,
      circuitBreaker: { rollback: true },
      // Inverted on purpose: 0/100 means a roll STOPS the old task before
      // starting the new one, so two Paperclip processes never share the
      // EFS worktrees or the port registry. See the class doc.
      minHealthyPercent: 0,
      maxHealthyPercent: 100,
      propagateTags: PropagatedTagSource.SERVICE,
      healthCheckGracePeriod: Duration.seconds(120),
      // A records, not SRV: the consumer is `fetch()` against a URL whose port
      // is already fixed at 3100, so an SRV lookup would be a second resolver
      // the Node HTTP client does not perform. Short TTL because the address
      // changes on every deploy (minHealthyPercent 0 replaces the one task).
      cloudMapOptions: {
        cloudMapNamespace: namespace,
        name: RESOURCE_NAMES.paperclipDiscoveryName,
        dnsRecordType: DnsRecordType.A,
        dnsTtl: Duration.seconds(15),
      },
    });
    this.service.attachToApplicationTargetGroup(targetGroup);
    // NO autoScaleTaskCount(). Intentionally. See the class doc and the
    // guardrail assertion in paperclip-stack.test.ts.

    // The only outputs, and each one is READ: scripts/deploy.ts phase b.5
    // pulls all four out of the previous deploy's outputs file to start the
    // migration job, the way resolveClusterService() already reads the
    // orchestrator cluster and service. Nothing else is emitted — an output
    // no script reads is a name that drifts silently.
    new CfnOutput(this, 'PaperclipClusterName', { value: props.cluster.clusterName });
    new CfnOutput(this, 'PaperclipMigrateTaskDefFamily', {
      value: PAPERCLIP_MIGRATE_TASK_FAMILY,
    });
    new CfnOutput(this, 'PaperclipMigrateSubnets', {
      value: props.vpc
        .selectSubnets({ subnetType: SubnetType.PRIVATE_WITH_EGRESS })
        .subnetIds.join(','),
    });
    new CfnOutput(this, 'PaperclipMigrateSecurityGroup', {
      value: props.paperclipSecurityGroup.securityGroupId,
    });
  }
}
