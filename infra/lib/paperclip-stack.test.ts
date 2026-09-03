/**
 * Synth-level assertions for CCE-Paperclip (the Paperclip work engine service,
 * ADR 0010 Phase 2 / bar-and-phases Phase 4 + 4.5).
 *
 * Most of these are GUARDRAILS, not descriptions. The Paperclip service is
 * deliberately configured as the INVERSE of the orchestrator on three axes
 * (one task, no autoscaling, 0/100 rolling percentages), and every one of
 * those looks like an oversight to someone tidying the two stacks into
 * agreement. They are asserted here so that tidy-up fails in CI instead of
 * corrupting node-local Paperclip state in production.
 *
 * The load-bearing one is `readiness gates (M33)`: the first version of this
 * stack made the SERVICE conditional on a probe that could never succeed on
 * CI, so an armed deploy would have deleted a running service and exited 0.
 * Those tests assert the shape that cannot do that — nothing decides whether
 * a resource exists, and the default of every flag is the one that KEEPS it.
 *
 * A20: assertions are on LITERALS or on `buildResourceNames('')`, never on the
 * same constant the stack used to synthesize the value. `expect(family).toBe(
 * PAPERCLIP_TASK_FAMILY)` compares a constant with itself and passes under any
 * rename, which is the failure mode these tests exist to catch.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { App, Stack } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { Cluster } from 'aws-cdk-lib/aws-ecs';
import {
  ApplicationLoadBalancer,
  ApplicationProtocol,
  ListenerAction,
  ListenerCertificate,
} from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { NetworkStack } from './network-stack.js';
import { StorageStack } from './storage-stack.js';
import { SecretsStack } from './secrets-stack.js';
import { DynamoStack } from './dynamo-stack.js';
import { MessagingStack } from './messaging-stack.js';
import { IamStack } from './iam-stack.js';
import { FilesystemStack } from './filesystem-stack.js';
import { DatabaseStack } from './database-stack.js';
import { PaperclipStack } from './paperclip-stack.js';
import { ComputeStack } from './compute-stack.js';
import { buildResourceNames } from './constants.js';
import {
  PAPERCLIP_CONTAINER_NAME,
  SYNTH_INPUT_ALLOWLIST,
} from '../../scripts/lib/lifecycle/manifest.js';

const ENV = { account: '637423318609', region: 'us-east-1' };

interface SynthOpts {
  bootstrapWithoutTasks?: boolean;
  withListener?: boolean;
  imageDigest?: string;
}

/**
 * Synthesize CCE-Paperclip against a minimal host stack standing in for
 * ComputeStack (its ECS cluster and, optionally, its HTTPS:443 listener).
 * Deliberately not a whole-app synth: the point is the Paperclip template.
 *
 * Every knob is a PROP, not an environment variable, because the stack reads
 * no `process.env` at all — `infra/bin/app.ts` owns that. A test that had to
 * mutate the ambient environment to change a template would be testing the
 * very coupling this stack was reworked to remove.
 */
function synth(opts: SynthOpts = {}): {
  paperclip: Template;
  network: Template;
  raw: Record<string, unknown>;
} {
  const app = new App();
  const network = new NetworkStack(app, 'CCE-Network', { tier: 1, env: ENV });
  const storage = new StorageStack(app, 'CCE-Storage', { tier: 1, env: ENV });
  const secrets = new SecretsStack(app, 'CCE-Secrets', {
    tier: 1,
    env: ENV,
    dataKey: storage.dataKey,
  });
  const filesystem = new FilesystemStack(app, 'CCE-Filesystem', {
    tier: 1,
    env: ENV,
    vpc: network.vpc,
    paperclipSecurityGroup: network.paperclipSecurityGroup,
  });

  const host = new Stack(app, 'CCE-Compute', { env: ENV });
  const cluster = new Cluster(host, 'Cluster', {
    vpc: network.vpc,
    clusterName: 'claudeclaw-cluster',
  });
  if (opts.withListener) {
    const alb = new ApplicationLoadBalancer(host, 'Alb', {
      vpc: network.vpc,
      internetFacing: true,
      securityGroup: network.albSecurityGroup,
    });
    alb.addListener('HttpsListener', {
      port: 443,
      protocol: ApplicationProtocol.HTTPS,
      certificates: [
        ListenerCertificate.fromArn(
          `arn:aws:acm:${ENV.region}:${ENV.account}:certificate/00000000-0000-0000-0000-000000000000`,
        ),
      ],
      defaultAction: ListenerAction.fixedResponse(403, { messageBody: 'origin only' }),
    });
  }

  const paperclip = new PaperclipStack(app, 'CCE-Paperclip', {
    tier: 1,
    env: ENV,
    vpc: network.vpc,
    paperclipSecurityGroup: network.paperclipSecurityGroup,
    cluster,
    fileSystem: filesystem.paperclipFileSystem,
    accessPoint: filesystem.paperclipAccessPoint,
    logGroup: filesystem.paperclipLogGroup,
    paperclipSecret: secrets.paperclipSecret,
    imageDigest: opts.imageDigest,
    bootstrapWithoutTasks: opts.bootstrapWithoutTasks,
  });

  const template = Template.fromStack(paperclip);
  return {
    paperclip: template,
    network: Template.fromStack(network),
    raw: template.toJSON() as Record<string, unknown>,
  };
}

interface ContainerDef {
  Name: string;
  Image?: unknown;
  Command?: string[];
  Environment?: Array<{ Name: string; Value: unknown }>;
  Secrets?: Array<{ Name: string; ValueFrom: unknown }>;
  MountPoints?: Array<{ SourceVolume: string; ContainerPath: string; ReadOnly?: boolean }>;
  PortMappings?: Array<{ ContainerPort: number }>;
}

interface TaskDefProps {
  Family: string;
  Cpu: string;
  Memory: string;
  RuntimePlatform?: { CpuArchitecture?: string; OperatingSystemFamily?: string };
  ContainerDefinitions: ContainerDef[];
  Volumes?: Array<{
    Name: string;
    EFSVolumeConfiguration?: {
      TransitEncryption?: string;
      AuthorizationConfig?: { AccessPointId?: unknown; IAM?: string };
    };
  }>;
}

function taskDefs(t: Template): TaskDefProps[] {
  return Object.values(t.findResources('AWS::ECS::TaskDefinition')).map(
    (r) => r.Properties as TaskDefProps,
  );
}

function byFamily(t: Template, family: string): TaskDefProps {
  const found = taskDefs(t).find((d) => d.Family === family);
  if (!found) throw new Error(`no task definition with family ${family}`);
  return found;
}

function envOf(c: ContainerDef): Record<string, unknown> {
  return Object.fromEntries((c.Environment ?? []).map((e) => [e.Name, e.Value]));
}

const { paperclip, network, raw } = synth();
const serviceTask = byFamily(paperclip, 'claudeclaw-paperclip');
const serviceContainer = serviceTask.ContainerDefinitions.find(
  (c) => c.Name === 'paperclip-server',
)!;
const migrateTask = byFamily(paperclip, 'claudeclaw-paperclip-migrate');
const migrateContainer = migrateTask.ContainerDefinitions[0];

// ─────────────────────────────────────────────────────────────────────
// The guardrails. Each of these is the inverse of the orchestrator and
// each would look like an oversight to a "consistency" refactor.
// ─────────────────────────────────────────────────────────────────────

describe('single-writer guardrails', () => {
  it('pins DesiredCount to exactly 1', () => {
    // Paperclip keeps node-local state (git worktrees, spawned children, an
    // in-process port registry, a PROCESS-LOCAL worktree cleanup lock). EFS
    // does not fix that: the lock does not coordinate across processes.
    paperclip.hasResourceProperties('AWS::ECS::Service', { DesiredCount: 1 });
  });

  it('creates NO autoscaling for this service, at all', () => {
    // compute-stack calls autoScaleTaskCount + two scaling policies. Doing
    // the same here would run two Paperclip tasks over one EFS filesystem.
    paperclip.resourceCountIs('AWS::ApplicationAutoScaling::ScalableTarget', 0);
    paperclip.resourceCountIs('AWS::ApplicationAutoScaling::ScalingPolicy', 0);
    expect(JSON.stringify(raw)).not.toMatch(/ApplicationAutoScaling/);
  });

  it('rolls at 0/100, the inverse of the orchestrator 100/200', () => {
    // 100/200 briefly runs TWO tasks during a deploy, which is exactly what
    // DesiredCount 1 exists to prevent. The trade is a short availability
    // gap on every roll, which is correct for a single-writer service.
    paperclip.hasResourceProperties('AWS::ECS::Service', {
      DeploymentConfiguration: Match.objectLike({
        MinimumHealthyPercent: 0,
        MaximumPercent: 100,
      }),
    });
  });

  it('keeps exactly one ECS service in the stack', () => {
    paperclip.resourceCountIs('AWS::ECS::Service', 1);
  });
});

// ─────────────────────────────────────────────────────────────────────
// M33. The rejected first version of this stack gated the SERVICE on a
// probe that read a gitignored file, defaulting to "omit". On CI that
// probe could never succeed, so an armed `cdk deploy --all` would have
// DELETED a running service and its listener rule and exited 0.
//
// These four tests assert the shape that cannot do that.
// ─────────────────────────────────────────────────────────────────────

describe('readiness gates (M33)', () => {
  it('creates the service on a bare synth, with no flag set at all', () => {
    // THE test. A fresh clone, a CI runner and a second engineer's machine
    // all synthesize with nothing configured; if that omitted the service,
    // CloudFormation would delete the running one. The default must be the
    // direction that KEEPS the resource.
    const bare = synth();
    bare.paperclip.resourceCountIs('AWS::ECS::Service', 1);
    bare.paperclip.hasResourceProperties('AWS::ECS::Service', { DesiredCount: 1 });
  });

  it('reads no process.env, so ambient state cannot change what exists', () => {
    // The rejected version read CCE_PAPERCLIP_SERVICE_READY, _HOSTNAME and
    // _IMAGE_DIGEST in the stack body. infra/bin/app.ts owns env reading and
    // passes props; this asserts the file itself stays clean, because the
    // defect is reintroduced by ONE `process.env` lookup, not by a bad value.
    const source = readFileSync(
      new URL('./paperclip-stack.ts', import.meta.url),
      'utf-8',
    );
    expect(source).not.toMatch(/process\.env/);
  });

  it('scales a bootstrap deploy to zero tasks instead of deleting the service', () => {
    // The fresh-install and maintenance escape hatch while the database is not
    // ready. It must degrade, never destroy: the service resource, its
    // Cloud Map registration and both task definitions all survive, so one
    // redeploy without the flag restores the running system.
    const boot = synth({ bootstrapWithoutTasks: true });
    boot.paperclip.resourceCountIs('AWS::ECS::Service', 1);
    boot.paperclip.hasResourceProperties('AWS::ECS::Service', { DesiredCount: 0 });
    expect(byFamily(boot.paperclip, 'claudeclaw-paperclip-migrate')).toBeDefined();
    boot.paperclip.resourceCountIs('AWS::ElasticLoadBalancingV2::TargetGroup', 0);
  });

  it('keeps the migration task definition on every synth, flag or no flag', () => {
    // Phase b.5 runs `aws ecs run-task` against this family. If any flag
    // could omit it, the recovery path would delete the only thing that can
    // migrate the database, and the deploy would deadlock.
    for (const opts of [
      {},
      { bootstrapWithoutTasks: true },
      { withListener: true },
    ]) {
      expect(byFamily(synth(opts).paperclip, 'claudeclaw-paperclip-migrate')).toBeDefined();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// Wire contract: port, health path, names the deploy manifest predicted.
// ─────────────────────────────────────────────────────────────────────

describe('private service and container wiring', () => {
  it('does not attach an orphan target group to the Cloud Map-only service', () => {
    paperclip.resourceCountIs('AWS::ElasticLoadBalancingV2::TargetGroup', 0);
    expect(JSON.stringify(raw)).not.toContain('"LoadBalancers"');
  });

  it('exposes 3100 on the container, never 3000', () => {
    expect((serviceContainer.PortMappings ?? []).map((p) => p.ContainerPort)).toEqual([3100]);
    expect(JSON.stringify(serviceContainer.PortMappings)).not.toMatch(/3000/);
    expect(envOf(serviceContainer).PORT).toBe('3100');
  });

  it('container-health-checks the same path on the same port', () => {
    // ECS owns health for the private Cloud Map-only route. `curl` is used
    // because /usr/bin/curl was probed present in the pinned image; a check
    // naming a binary the image lacks is UNHEALTHY forever, which at
    // minHealthyPercent 0 is an outage.
    expect(JSON.stringify(raw)).toContain('http://127.0.0.1:3100/api/health');
    expect(JSON.stringify(raw)).toContain('curl -f http://127.0.0.1:3100/api/health');
  });

  it('uses the task family and container name the manifest already predicted', () => {
    // Phase 1.5 wrote both as PREDICTIONS of what this stack would choose, and
    // buildImageRecords() records them for rollback. A mismatch records a
    // rollback target that matches nothing in ECS. Literals on the left so a
    // rename has to be made in both places.
    expect(serviceTask.Family).toBe('claudeclaw-paperclip');
    expect(serviceContainer.Name).toBe('paperclip-server');
    expect(PAPERCLIP_CONTAINER_NAME).toBe('paperclip-server');
    // ...and the family tracks the ECR repo name, which is suffix-aware.
    expect(buildResourceNames('').paperclipEcrRepo).toBe('claudeclaw-paperclip');
  });

  it('runs ARM64 at 2 vCPU / 4 GB', () => {
    // The whole compute plane is ARM64; the pinned upstream artifact is a
    // multi-arch index, so a wrong-platform build crash-loops with
    // "exec format error" rather than failing the build.
    expect(serviceTask.RuntimePlatform?.CpuArchitecture).toBe('ARM64');
    expect(serviceTask.Cpu).toBe('2048');
    expect(serviceTask.Memory).toBe('4096');
  });

  it('pins the image by DIGEST when one is supplied', () => {
    const digest = 'sha256:' + 'c'.repeat(64);
    const pinned = synth({ imageDigest: digest });
    expect(JSON.stringify(pinned.raw)).toContain(`@${digest}`);
    // No floating :latest is ever published into this repo.
    expect(JSON.stringify(pinned.raw)).not.toMatch(/paperclip:latest/);
  });

  it('renders an unresolvable placeholder rather than a floating tag when none is supplied', () => {
    // Both drivers forward a real digest. When one does not, the task
    // definition must fail to PULL — loudly — instead of quietly running
    // whatever `:latest` happens to be.
    expect(JSON.stringify(raw)).toContain('paperclip-digest-unset');
    expect(JSON.stringify(raw)).not.toMatch(/@sha256:/);
  });
});

// ─────────────────────────────────────────────────────────────────────
// EFS: the access point, not the filesystem root.
// ─────────────────────────────────────────────────────────────────────

describe('EFS mount', () => {
  it('mounts the access point at /paperclip with transit encryption and IAM', () => {
    const volume = (serviceTask.Volumes ?? [])[0];
    expect(volume?.EFSVolumeConfiguration?.TransitEncryption).toBe('ENABLED');
    expect(volume?.EFSVolumeConfiguration?.AuthorizationConfig?.IAM).toBe('ENABLED');
    expect(volume?.EFSVolumeConfiguration?.AuthorizationConfig?.AccessPointId).toBeDefined();
    expect(serviceContainer.MountPoints).toEqual([
      { SourceVolume: volume!.Name, ContainerPath: '/paperclip', ReadOnly: false },
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────
// UI serving (Phase 4.5) and the mode that must never be shipped.
// ─────────────────────────────────────────────────────────────────────

describe('UI serving and deployment mode', () => {
  it('serves the built board and stays in authenticated mode', () => {
    const env = envOf(serviceContainer);
    expect(env.SERVE_UI).toBe('true');
    expect(env.PAPERCLIP_DEPLOYMENT_MODE).toBe('authenticated');
    expect(env.PAPERCLIP_HOME).toBe('/paperclip');
  });

  it('never ships local_trusted anywhere in the template', () => {
    // local_trusted makes EVERY request an instance admin with no credential.
    expect(JSON.stringify(raw)).not.toMatch(/local_trusted/);
  });

  it('omits PAPERCLIP_PUBLIC_URL rather than guessing it', () => {
    // boardMutationGuard builds its trusted-origin set from localhost:3100,
    // 127.0.0.1:3100, the request Host/X-Forwarded-Host and this variable. A
    // wrong value 403s EVERY board mutation with "Board mutation requires
    // trusted browser origin", so absent beats guessed.
    expect(envOf(serviceContainer).PAPERCLIP_PUBLIC_URL).toBeUndefined();
  });

  it('does not expose open self-registration through an existing public listener', () => {
    const hosted = synth({ withListener: true });
    hosted.paperclip.resourceCountIs('AWS::ElasticLoadBalancingV2::ListenerRule', 0);
    const container = byFamily(hosted.paperclip, 'claudeclaw-paperclip')
      .ContainerDefinitions.find((c) => c.Name === 'paperclip-server')!;
    expect(envOf(container).PAPERCLIP_PUBLIC_URL).toBeUndefined();
  });

  it('keeps the AWS-authenticated SSM tunnel reachable', () => {
    paperclip.hasResourceProperties('AWS::ECS::Service', {
      EnableExecuteCommand: true,
    });
    paperclip.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: 'SsmExec',
            Effect: 'Allow',
            Action: [
              'ssmmessages:CreateControlChannel',
              'ssmmessages:CreateDataChannel',
              'ssmmessages:OpenControlChannel',
              'ssmmessages:OpenDataChannel',
            ],
            Resource: '*',
          }),
        ]),
      },
    });
  });

  it('keeps the operator console out of every Netzar SPA source file', () => {
    const webRoot = new URL('../../web/src/', import.meta.url);
    const source = readdirSync(webRoot, { recursive: true, encoding: 'utf8' })
      .filter((name) => {
        const url = new URL(name.replaceAll('\\', '/'), webRoot);
        return /\.(?:js|jsx|ts|tsx)$/.test(name) && statSync(url).isFile();
      })
      .map((name) => readFileSync(new URL(name.replaceAll('\\', '/'), webRoot), 'utf8'))
      .join('\n');
    expect(source).not.toMatch(/paperclip-ops\.|CCE_PAPERCLIP_HOSTNAME/);
  });
});

// ─────────────────────────────────────────────────────────────────────
// A23: the HTTPS listener normally does not exist.
// ─────────────────────────────────────────────────────────────────────

describe('listener rule (A23)', () => {
  it('synthesizes cleanly with NO listener, which is the normal case', () => {
    // Both real environments set DOMAIN_NAME empty on purpose, so
    // compute-stack's httpsListener is undefined. That must not throw and
    // must not silently invent an ALB of its own.
    expect(() => synth({ withListener: false })).not.toThrow();
    paperclip.resourceCountIs('AWS::ElasticLoadBalancingV2::ListenerRule', 0);
    paperclip.resourceCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', 0);
    paperclip.resourceCountIs('AWS::ElasticLoadBalancingV2::Listener', 0);
  });

  it('still runs the service when there is no listener to attach it to', () => {
    // The degrade decision (Phase 4.5 acceptance 6): no listener means no ALB
    // path to the console, NOT a missing service. Operators reach it over
    // ECS Exec / the SSM port-forward to 3100.
    const t = synth({ withListener: false });
    t.paperclip.resourceCountIs('AWS::ECS::Service', 1);
    t.paperclip.resourceCountIs('AWS::ElasticLoadBalancingV2::ListenerRule', 0);
  });

  it('never attaches the console to the existing potentially public listener', () => {
    // A38: authenticated mode still leaves self-registration open. Until an
    // independently access-controlled listener exists, SSM is the only path.
    const t = synth({ withListener: true });
    t.paperclip.resourceCountIs('AWS::ElasticLoadBalancingV2::ListenerRule', 0);
    t.paperclip.resourceCountIs('AWS::ECS::Service', 1);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Migrations belong to the job, not the service.
// ─────────────────────────────────────────────────────────────────────

describe('migration job', () => {
  it('never lets the long-running service auto-apply migrations', () => {
    expect(envOf(serviceContainer).PAPERCLIP_MIGRATION_AUTO_APPLY).toBeUndefined();
  });

  it('ships no PAPERCLIP_MIGRATION_AUTO_APPLY on the migrate job either', () => {
    // It was there, described as "this container IS the migration". A probe of
    // the pinned artifact found packages/db/src/migrate.ts reads no
    // environment at all — the variable is referenced only by the long-running
    // server. An inert setting that reads as a control is worse than nothing,
    // because the next reader trusts it (A30).
    expect(JSON.stringify(raw)).not.toMatch(/PAPERCLIP_MIGRATION_AUTO_APPLY/);
  });

  it('runs the migration entrypoint proven against the pinned artifact', () => {
    expect(migrateContainer.Command).toEqual([
      'node',
      '--import',
      './server/node_modules/tsx/dist/loader.mjs',
      'packages/db/src/migrate.ts',
    ]);
    expect(migrateTask.Family).toBe('claudeclaw-paperclip-migrate');
  });

  it('gives the migration job NO EFS mount and no port', () => {
    // It talks only to Aurora. Mounting PAPERCLIP_HOME would hand a job with
    // no business touching worktrees write access to them.
    expect(migrateTask.Volumes ?? []).toEqual([]);
    expect(migrateContainer.MountPoints ?? []).toEqual([]);
    expect(migrateContainer.PortMappings ?? []).toEqual([]);
  });

  it('feeds both containers DATABASE_URL from Secrets Manager, never as plain env', () => {
    for (const c of [serviceContainer, migrateContainer]) {
      expect((c.Secrets ?? []).map((s) => s.Name)).toContain('DATABASE_URL');
      expect(envOf(c).DATABASE_URL).toBeUndefined();
    }
  });
});

/**
 * Synthesize the real ComputeStack at a given tier. Heavier than the
 * Paperclip synth above (it needs storage, secrets, dynamo, messaging and
 * IAM), but the orchestrator's task definition is written there and nowhere
 * else, so the only alternative is asserting on a source-level grep.
 */
function computeTemplate(tier: 0 | 1): Template {
  // `paperclipProvisioned` is the tier OR the environment-scoped override, and
  // it reads process.env. A developer with the override exported would make
  // the Tier 0 case assert the opposite of what it says, so "unset" is made to
  // mean unset here — the same treatment app.stack-set.test.ts gives it.
  const before = process.env.CCE_PAPERCLIP_PROVISION_ENV_OVERRIDE;
  delete process.env.CCE_PAPERCLIP_PROVISION_ENV_OVERRIDE;
  try {
    return computeTemplateUnguarded(tier);
  } finally {
    if (before === undefined) delete process.env.CCE_PAPERCLIP_PROVISION_ENV_OVERRIDE;
    else process.env.CCE_PAPERCLIP_PROVISION_ENV_OVERRIDE = before;
  }
}

function computeTemplateUnguarded(tier: 0 | 1): Template {
  const app = new App();
  const net = new NetworkStack(app, 'CCE-Network', { tier, env: ENV });
  const storage = new StorageStack(app, 'CCE-Storage', { tier, env: ENV });
  const secretsStack = new SecretsStack(app, 'CCE-Secrets', {
    tier,
    env: ENV,
    dataKey: storage.dataKey,
  });
  const dynamo = new DynamoStack(app, 'CCE-Dynamo', {
    tier,
    env: ENV,
    dataKey: storage.dataKey,
  });
  const messaging = new MessagingStack(app, 'CCE-Messaging', {
    tier,
    env: ENV,
    configBucket: storage.configBucket,
  });
  const iam = new IamStack(app, 'CCE-Iam', {
    tier,
    env: ENV,
    storage,
    secrets: secretsStack,
    dynamo,
    messaging,
  });
  const compute = new ComputeStack(app, 'CCE-Compute', {
    tier,
    env: ENV,
    vpc: net.vpc,
    albSecurityGroup: net.albSecurityGroup,
    fargateSecurityGroup: net.fargateSecurityGroup,
    taskRole: iam.taskRole,
    secrets: secretsStack,
    logsBucket: storage.logsBucket,
    messaging,
  });
  return Template.fromStack(compute);
}

// ─────────────────────────────────────────────────────────────────────
// Reachability. Before this, a standard install provisioned a Paperclip
// the orchestrator could neither address nor connect to: PAPERCLIP_BASE_URL
// appeared in no file under infra/, and PaperclipSg admitted only the ALB.
// The address and orchestrator ingress are asserted separately because either
// one alone still leaves the service unreachable.
// ─────────────────────────────────────────────────────────────────────

describe('orchestrator to Paperclip reachability', () => {
  it('carries the bootstrapped company id through the Paperclip secret', () => {
    const app = new App();
    const storage = new StorageStack(app, 'CCE-Storage', { tier: 1, env: ENV });
    const secrets = new SecretsStack(app, 'CCE-Secrets', {
      tier: 1,
      env: ENV,
      dataKey: storage.dataKey,
    });
    const secretsTemplate = Template.fromStack(secrets);
    const paperclipSecret = Object.values(
      secretsTemplate.findResources('AWS::SecretsManager::Secret'),
    ).find((resource) => resource.Properties?.Name === '/claudeclaw/paperclip')!;
    // Upgrade safety: CloudFormation's original SecretString must not change,
    // or it would replace the live database URL and keys with placeholders.
    expect(JSON.stringify(paperclipSecret.Properties?.SecretString)).not.toContain('company_id');

    const orchestrator = taskDefs(computeTemplate(1))
      .flatMap((d) => d.ContainerDefinitions)
      .find((c) => c.Name === 'orchestrator')!;
    const companyId = (orchestrator.Secrets ?? []).find(
      (secret) => secret.Name === 'PAPERCLIP_COMPANY_ID',
    );
    expect(JSON.stringify(companyId?.ValueFrom)).toContain(':company_id::');
    expect(envOf(orchestrator).PAPERCLIP_COMPANY_ID).toBeUndefined();

    const deployPhases = readFileSync(
      new URL('../../scripts/lib/lifecycle/deploy-phases.ts', import.meta.url),
      'utf8',
    );
    expect(deployPhases).toContain("defaults: JSON.stringify({ company_id: 'REPLACE_ME' })");
  });

  it('does not reference the additive company-id field at Tier 0', () => {
    const orchestrator = taskDefs(computeTemplate(0))
      .flatMap((d) => d.ContainerDefinitions)
      .find((c) => c.Name === 'orchestrator')!;
    expect(
      (orchestrator.Secrets ?? []).some(
        (secret) => secret.Name === 'PAPERCLIP_COMPANY_ID',
      ),
    ).toBe(false);
  });

  it('opens PaperclipSg to the orchestrator Fargate SG on 3100', () => {
    // A20: literal port, and the SOURCE is asserted, not just the count —
    // an ingress from the ALB on the same port would satisfy a count check
    // and leave the orchestrator locked out, which is the shipped bug.
    const rules = Object.values(network.findResources('AWS::EC2::SecurityGroupIngress'))
      .map(
        (r) =>
          r.Properties as {
            FromPort: number;
            GroupId: unknown;
            SourceSecurityGroupId: unknown;
          },
      )
      .filter((r) => /PaperclipSg/.test(JSON.stringify(r.GroupId)));
    const fromFargate = rules.filter((r) =>
      /FargateSg/.test(JSON.stringify(r.SourceSecurityGroupId)),
    );
    expect(fromFargate).toHaveLength(1);
    expect(fromFargate[0].FromPort).toBe(3100);
    // SSM-only console posture: the ALB must not be admitted on this port.
    expect(
      rules.filter((r) => /AlbSg/.test(JSON.stringify(r.SourceSecurityGroupId))),
    ).toHaveLength(0);
  });

  it('registers a stable Cloud Map A record in a VPC-private namespace', () => {
    // The name is what has to be stable. desiredCount 1 at minHealthyPercent 0
    // replaces the single task — and its IP — on every deploy, so anything
    // holding an address rather than a name breaks on the next roll.
    paperclip.hasResourceProperties('AWS::ServiceDiscovery::PrivateDnsNamespace', {
      Name: 'claudeclaw.internal',
    });
    paperclip.hasResourceProperties('AWS::ServiceDiscovery::Service', {
      Name: 'paperclip',
      DnsConfig: Match.objectLike({
        DnsRecords: [Match.objectLike({ Type: 'A' })],
      }),
    });
    // ...and the SERVICE is attached to it. A discovery service with nothing
    // registered resolves NXDOMAIN, which looks identical to "not deployed".
    paperclip.hasResourceProperties('AWS::ECS::Service', {
      ServiceRegistries: [Match.objectLike({ RegistryArn: Match.anyValue() })],
    });
  });

  it('leaves the ALB console path unbound', () => {
    // A38 keeps the operator console off the shared ALB entirely.
    const withListener = synth({ withListener: true });
    withListener.paperclip.resourceCountIs('AWS::ElasticLoadBalancingV2::ListenerRule', 0);
    withListener.paperclip.resourceCountIs('AWS::ElasticLoadBalancingV2::TargetGroup', 0);
    paperclip.resourceCountIs('AWS::ElasticLoadBalancingV2::TargetGroup', 0);
  });

  it('gives the orchestrator task definition PAPERCLIP_BASE_URL', () => {
    // The half that lives in the OTHER stack. src/lib/paperclip/config.ts
    // reads `runtimeConfig ?? env.PAPERCLIP_BASE_URL`, and `paperclip/base_url`
    // is deliberately not seeded (scripts/lib/seed-defaults.ts), so this env
    // var is what the client resolves. A20: the expected value is spelled out
    // as a literal, not rebuilt from the constant the stack synthesized it
    // from.
    const compute = computeTemplate(1);
    const orchestrator = taskDefs(compute)
      .flatMap((d) => d.ContainerDefinitions)
      .find((c) => c.Name === 'orchestrator')!;
    expect(envOf(orchestrator).PAPERCLIP_BASE_URL).toBe(
      'http://paperclip.claudeclaw.internal:3100',
    );
  });

  it('sets NO base URL at Tier 0, where no engine is provisioned', () => {
    // Tier 0 creates no Paperclip at all. A URL there would turn the typed
    // PaperclipDisabledError ("no base URL", with its remediation) into a DNS
    // failure inside a fetch — a worse error for the same absence.
    const orchestrator = taskDefs(computeTemplate(0))
      .flatMap((d) => d.ContainerDefinitions)
      .find((c) => c.Name === 'orchestrator')!;
    expect(envOf(orchestrator)).not.toHaveProperty('PAPERCLIP_BASE_URL');
  });
});

// ─────────────────────────────────────────────────────────────────────
// Service boundary (DL-2). Paperclip is not the orchestrator.
// ─────────────────────────────────────────────────────────────────────

describe('service boundary', () => {
  it('admits Aurora ingress from the Paperclip SG and never the Fargate SG', () => {
    const app = new App();
    const net = new NetworkStack(app, 'CCE-Network', { tier: 1, env: ENV });
    const db = new DatabaseStack(app, 'CCE-Database', {
      tier: 1,
      env: ENV,
      vpc: net.vpc,
      paperclipSecurityGroup: net.paperclipSecurityGroup,
    });
    const dbTemplate = Template.fromStack(db);
    const rules = Object.values(
      dbTemplate.findResources('AWS::EC2::SecurityGroupIngress'),
    ).map((r) => r.Properties as { FromPort: number; SourceSecurityGroupId: unknown });
    expect(rules).toHaveLength(1);
    expect(rules[0].FromPort).toBe(5432);
    expect(JSON.stringify(rules[0].SourceSecurityGroupId)).toMatch(/PaperclipSg/);
    expect(JSON.stringify(dbTemplate.toJSON())).not.toMatch(/FargateSg/);
  });

  it('runs the task on the Paperclip SG, in private subnets, with no public IP', () => {
    paperclip.hasResourceProperties('AWS::ECS::Service', {
      NetworkConfiguration: Match.objectLike({
        AwsvpcConfiguration: Match.objectLike({ AssignPublicIp: 'DISABLED' }),
      }),
    });
    expect(JSON.stringify(raw)).toMatch(/PaperclipSg/);
    expect(JSON.stringify(raw)).not.toMatch(/FargateSg/);
  });

  it('grants the task role no Bedrock, DynamoDB or S3', () => {
    // DL-2 is a service boundary. Paperclip must never inherit the
    // orchestrator's runtime identity or any of its grants.
    const json = JSON.stringify(raw);
    expect(json).not.toMatch(/bedrock:/);
    expect(json).not.toMatch(/dynamodb:/);
    expect(json).not.toMatch(/"s3:/);
  });

  it('leaves the orchestrator Fargate SG untouched', () => {
    const fargateRules = Object.values(
      network.findResources('AWS::EC2::SecurityGroupIngress'),
    )
      .map((r) => r.Properties as { FromPort: number; GroupId: unknown })
      .filter((r) => /FargateSg/.test(JSON.stringify(r.GroupId)));
    expect(fargateRules).toHaveLength(1);
    expect(fargateRules[0].FromPort).toBe(3000);
  });

  it('emits only outputs a deploy script actually reads', () => {
    // House rule: an output nothing consumes is a name that drifts silently.
    // These four are read by resolvePaperclipMigrationTargets() in
    // scripts/deploy.ts to start the one-shot migration job.
    expect(Object.keys((raw as { Outputs?: Record<string, unknown> }).Outputs ?? {}).sort()).toEqual(
      [
        'PaperclipClusterName',
        'PaperclipMigrateSecurityGroup',
        'PaperclipMigrateSubnets',
        'PaperclipMigrateTaskDefFamily',
      ],
    );
  });

  it('keeps the manifest replay list free of anything that can remove a resource', () => {
    // CCE_PAPERCLIP_SERVICE_READY belonged to the REJECTED design, in which
    // synth omitted the FargateService unless a probe said '1'. Replaying an
    // empty value from an archived manifest would then delete a running
    // service. It is gone from the tree; the replacement can only move
    // DesiredCount, so the worst a replay does is scale down, recoverably.
    expect(SYNTH_INPUT_ALLOWLIST).not.toContain('CCE_PAPERCLIP_SERVICE_READY');
    // ...and the flag that DOES change synth output is in the list, because a
    // rollback that re-synthesized without it would bring a deliberately
    // scaled-to-zero service back up against an unmigrated database.
    expect(SYNTH_INPUT_ALLOWLIST).toContain('CCE_PAPERCLIP_BOOTSTRAP');
    expect(SYNTH_INPUT_ALLOWLIST).toContain('CCE_PAPERCLIP_IMAGE_DIGEST');
  });

  it('composes DATABASE_URL with TLS on BOTH deploy drivers, or neither', () => {
    // The one value this phase newly owns on both drivers, and the axis the
    // last two rounds were rejected on. Aurora 17 runs the default cluster
    // parameter group (rds.force_ssl=1) and the image's driver connects in
    // plaintext unless the URL says so — there is no `ssl` option anywhere in
    // packages/db, so the query string is the only channel.
    //
    // PROBED 2026-08-21, pinned artifact against a hostssl-only Postgres 17:
    // without the suffix the migration dies `no pg_hba.conf entry ... no
    // encryption` (exit 1); with it, "Migrations complete" (exit 0).
    //
    // CI does NOT run scripts/deploy.ts (M27), so the string is composed
    // twice — once in TS, once in jq. Two copies of one load-bearing value is
    // exactly how a driver silently diverges, so this asserts they agree
    // rather than trusting the mirror comment on each side.
    const tsDriver = readFileSync(
      new URL('../../scripts/deploy.ts', import.meta.url),
      'utf-8',
    );
    const ciDriver = readFileSync(
      new URL('../../.github/workflows/deploy.yml', import.meta.url),
      'utf-8',
    );
    for (const [name, src] of [
      ['scripts/deploy.ts', tsDriver],
      ['.github/workflows/deploy.yml', ciDriver],
    ] as const) {
      // Composes a postgres URL at all...
      expect(src, `${name} composes a Paperclip DATABASE_URL`).toMatch(/postgres:\/\//);
      // ...and every one it composes carries the TLS instruction.
      expect(src, `${name} must append ?sslmode=require`).toContain('?sslmode=require');
      // `verify-full` would fail closed: the image carries no RDS CA bundle.
      expect(src, `${name} must not demand chain verification`).not.toContain(
        'sslmode=verify-full',
      );
    }
  });

  it('keeps every security group description ASCII', () => {
    // EC2 rejects GroupDescription outside ASCII ("Character sets beyond
    // ASCII are not supported"), and this repo writes em dashes everywhere
    // else. One slipped in and rolled back a staging deploy.
    for (const sg of Object.values(paperclip.findResources('AWS::EC2::SecurityGroup'))) {
      const d = (sg.Properties as { GroupDescription?: string })?.GroupDescription;
      if (typeof d === 'string') expect(d).toMatch(/^[ -~]*$/);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// The deploy role. Paperclip CI writes a secret and runs a one-shot task, so
// both need explicit grants. deploy.yml applies the environment's IAM stack
// exclusively before those consumers run, including on a fresh install; M34
// still requires the statements in BOTH environment branches so their
// resource scopes stay exact.
//
// A20: every expectation below is a LITERAL. Asserting against
// RESOURCE_NAMES would compare the constant with itself, and worse, that
// constant is derived at import time from CCE_NAME_SUFFIX — so in the
// staging branch it would say whatever the test runner was launched with.
// ─────────────────────────────────────────────────────────────────────

interface Statement {
  Sid?: string;
  Action?: string | string[];
  Resource?:
    | string
    | Record<string, unknown>
    | Array<string | Record<string, unknown>>;
  Condition?: Record<string, Record<string, string>>;
}

/**
 * Synthesize CCE-Iam with CCE_CICD_ENABLED armed, in whichever branch
 * CCE_NAME_SUFFIX selects, and return every policy statement it attaches.
 * The env is restored afterwards: iam-stack reads it at synth time.
 */
function iamStatements(nameSuffix: string): Statement[] {
  const before = {
    cicd: process.env.CCE_CICD_ENABLED,
    suffix: process.env.CCE_NAME_SUFFIX,
    owner: process.env.CCE_GITHUB_OWNER,
    repo: process.env.CCE_GITHUB_REPO,
    refs: process.env.CCE_GITHUB_DEPLOY_REFS,
    envs: process.env.CCE_GITHUB_DEPLOY_ENVIRONMENTS,
  };
  process.env.CCE_CICD_ENABLED = '1';
  process.env.CCE_NAME_SUFFIX = nameSuffix;
  // The OIDC trust resolver is fail-closed and errors without these.
  process.env.CCE_GITHUB_OWNER = 'Adams-Captial-Holdings-Ltd';
  process.env.CCE_GITHUB_REPO = 'Netzer-Labs';
  process.env.CCE_GITHUB_DEPLOY_REFS = 'refs/heads/production,refs/heads/staging';
  process.env.CCE_GITHUB_DEPLOY_ENVIRONMENTS = 'production,staging';
  try {
    const app = new App();
    const storage = new StorageStack(app, 'CCE-Storage', { tier: 1, env: ENV });
    const secretsStack = new SecretsStack(app, 'CCE-Secrets', {
      tier: 1,
      env: ENV,
      dataKey: storage.dataKey,
    });
    const dynamo = new DynamoStack(app, 'CCE-Dynamo', {
      tier: 1,
      env: ENV,
      dataKey: storage.dataKey,
    });
    const messaging = new MessagingStack(app, 'CCE-Messaging', {
      tier: 1,
      env: ENV,
      configBucket: storage.configBucket,
    });
    const iam = new IamStack(app, 'CCE-Iam', {
      tier: 1,
      env: ENV,
      storage,
      secrets: secretsStack,
      dynamo,
      messaging,
    });
    const t = Template.fromStack(iam);
    return Object.values(t.findResources('AWS::IAM::Policy')).flatMap(
      (p) =>
        ((p.Properties as { PolicyDocument?: { Statement?: Statement[] } })
          .PolicyDocument?.Statement ?? []) as Statement[],
    );
  } finally {
    process.env.CCE_CICD_ENABLED = before.cicd;
    process.env.CCE_NAME_SUFFIX = before.suffix;
    process.env.CCE_GITHUB_OWNER = before.owner;
    process.env.CCE_GITHUB_REPO = before.repo;
    process.env.CCE_GITHUB_DEPLOY_REFS = before.refs;
    process.env.CCE_GITHUB_DEPLOY_ENVIRONMENTS = before.envs;
  }
}

function bySid(statements: Statement[], sid: string): Statement {
  const found = statements.find((s) => s.Sid === sid);
  if (!found) throw new Error(`no policy statement with Sid ${sid}`);
  return found;
}

function actionsOf(s: Statement): string[] {
  return Array.isArray(s.Action) ? s.Action : [s.Action ?? ''];
}

function resourcesOf(s: Statement): string {
  return JSON.stringify(s.Resource);
}

describe('deploy role grants for the CI Paperclip steps (M34)', () => {
  const prod = iamStatements('');
  const staging = iamStatements('staging');

  it('lets the prod deploy role read AND write the Paperclip secret', () => {
    // put-secret-value appeared ZERO times in deploy.yml before Phase 4, so
    // this capability is genuinely new. GetSecretValue is required as well as
    // Put because the write is a read-modify-write merge: PutSecretValue swaps
    // the whole string and would otherwise wipe better_auth_secret and every
    // key scripts/paperclip-bootstrap.ts minted.
    const s = bySid(prod, 'PaperclipSecretPopulate');
    expect(actionsOf(s).sort()).toEqual([
      'secretsmanager:DescribeSecret',
      'secretsmanager:GetSecretValue',
      'secretsmanager:PutSecretValue',
    ]);
    expect(resourcesOf(s)).toContain(':secret:/claudeclaw/paperclip*');
    expect(resourcesOf(s)).toContain(':secret:/claudeclaw-*/paperclip*');

    const kms = bySid(prod, 'PaperclipSecretKmsData');
    expect(actionsOf(kms).sort()).toEqual(['kms:Decrypt', 'kms:GenerateDataKey']);
    expect(Array.isArray(kms.Resource) ? kms.Resource : [kms.Resource]).toHaveLength(1);
    expect(resourcesOf(kms)).toMatch(/DataKey/i);
  });

  it('mirrors that grant into the STAGING branch, narrowed to staging', () => {
    // M34 exactly: cicdRole is created only by the prod IAM stack, so a grant
    // written only in the !isStagingDeploy branch makes a staging arm depend on
    // a production IAM deploy. The CodeBuild pair above was mirrored for this
    // reason; the secret pair is mirrored for the same one.
    const s = bySid(staging, 'PaperclipSecretPopulateStaging');
    expect(actionsOf(s)).toContain('secretsmanager:PutSecretValue');
    expect(resourcesOf(s)).toContain(':secret:/claudeclaw-staging/paperclip*');
    // It must NOT reach production's secret from the staging stack.
    expect(resourcesOf(s)).not.toContain(':secret:/claudeclaw/paperclip');

    const kms = bySid(staging, 'PaperclipSecretKmsDataStaging');
    expect(actionsOf(kms).sort()).toEqual(['kms:Decrypt', 'kms:GenerateDataKey']);
    expect(Array.isArray(kms.Resource) ? kms.Resource : [kms.Resource]).toHaveLength(1);
    expect(resourcesOf(kms)).toMatch(/DataKey/i);
  });

  it('scopes RunTask to the MIGRATE family, never the service family', () => {
    // This role starts schema migrations. It has no business being able to
    // start the long-running Paperclip server out of band.
    for (const [statements, sid, want] of [
      [prod, 'PaperclipMigrationRunTask', 'claudeclaw-paperclip-migrate:*'],
      [staging, 'PaperclipMigrationRunTaskStaging', 'claudeclaw-staging-paperclip-migrate:*'],
    ] as const) {
      const s = bySid(statements as Statement[], sid);
      expect(actionsOf(s).sort()).toEqual(['ecs:DescribeTasks', 'ecs:RunTask']);
      expect(resourcesOf(s)).toContain(want);
      expect(resourcesOf(s)).not.toMatch(/task-definition\/claudeclaw[a-z-]*-paperclip:/);
    }
  });

  it('conditions PassRole on ecs-tasks, in both branches', () => {
    // RunTask hands the task definition's execution role to ECS. The role is
    // CDK-generated so its name is not knowable here; the constraint that
    // actually matters is which service it may be passed to.
    for (const [statements, sid] of [
      [prod, 'PaperclipMigrationPassRole'],
      [staging, 'PaperclipMigrationPassRoleStaging'],
    ] as const) {
      const s = bySid(statements as Statement[], sid);
      expect(actionsOf(s)).toEqual(['iam:PassRole']);
      expect(s.Condition?.StringEquals?.['iam:PassedToService']).toBe(
        'ecs-tasks.amazonaws.com',
      );
    }
  });

  it('runs the staging contract probe only through the orchestrator task family', () => {
    const s = bySid(staging, 'PaperclipProbeRunTaskStaging');
    expect(actionsOf(s).sort()).toEqual(['ecs:DescribeTasks', 'ecs:RunTask']);
    expect(resourcesOf(s)).toContain(
      ':task-definition/claudeclaw-staging-orchestrator:*',
    );
    expect(resourcesOf(s)).toContain(':task/claudeclaw-staging-cluster/*');
    expect(resourcesOf(s)).not.toContain(
      ':task-definition/claudeclaw-staging-paperclip:',
    );
    expect(s.Condition?.ArnEquals?.['ecs:cluster']).toBe(
      'arn:aws:ecs:us-east-1:637423318609:cluster/claudeclaw-staging-cluster',
    );
  });

  it('passes only the exact task role and narrow staging execution-role family', () => {
    const s = bySid(staging, 'PaperclipProbePassRoleStaging');
    const resources = Array.isArray(s.Resource) ? s.Resource : [s.Resource];
    expect(actionsOf(s)).toEqual(['iam:PassRole']);
    expect(resourcesOf(s)).toContain('"Fn::GetAtt":["TaskRole');
    expect(resourcesOf(s)).toContain(
      ':role/CCE-STAGING-Compute-TaskExecutionRole*',
    );
    expect(resourcesOf(s)).not.toContain(':role/CCE-STAGING-Compute-*');
    expect(resources).not.toContain('*');
    expect(s.Condition?.StringEquals?.['iam:PassedToService']).toBe(
      'ecs-tasks.amazonaws.com',
    );
  });

  it('reads only the staging orchestrator log group for probe evidence', () => {
    const s = bySid(staging, 'PaperclipProbeLogsStaging');
    expect(actionsOf(s).sort()).toEqual([
      'logs:DescribeLogStreams',
      'logs:FilterLogEvents',
      'logs:GetLogEvents',
    ]);
    expect(resourcesOf(s)).toContain(
      ':log-group:/claudeclaw-staging/orchestrator"',
    );
    expect(resourcesOf(s)).toContain(
      ':log-group:/claudeclaw-staging/orchestrator:*',
    );
    expect(resourcesOf(s)).not.toContain(
      ':log-group:/claudeclaw/orchestrator',
    );
  });
});
