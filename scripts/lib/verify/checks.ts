/**
 * Post-deploy verification checks (`npm run status` / `npm run verify`).
 *
 * IaC readiness plan, P2 (items 15-17). Three layers, all mode-aware
 * (CCE_DEPLOY_MODE), sharing the preflight CheckResult vocabulary and the
 * shared renderer (scripts/lib/preflight/render.ts):
 *
 *   LAYER A — CFN-derived: enumerate the live stacks by prefix and check
 *     each critical resource (ECS steady, dashboard endpoint over HTTPS per
 *     mode, stack-declared DDB tables ACTIVE, queues/topics, buckets, ECR
 *     image, scheduler group, WAF/CloudFront when the tier enables them),
 *     plus the private-posture scan (internal ALB + listener/SG rules) for
 *     no-domain infra-only installs and the plain-HTTP dashboard exposure
 *     probe in EVERY mode.
 *   LAYER B — value checks: secret version freshness vs the deploy manifest
 *     (DescribeSecret ONLY — verify never calls GetSecretValue), runtime-
 *     config seed rows, manifest presence + schema version.
 *   LAYER C — external: Slack/Telegram deliverability (reused from
 *     scripts/lib/surface-validate.ts with register:false — verify NEVER
 *     mutates), GitHub OIDC / CodeBuild credential when CI is enabled, and
 *     the feature-aware Bedrock probes (item 16).
 *
 * Mutation rules: verify performs READS plus, under --strict, exactly two
 * PAID model invocations (one Converse with the configured guardrail, one
 * Titan embedding when knowledge is enabled) and external vendor-API reads.
 * It never registers webhooks, never writes secrets, never touches infra.
 *
 * Honesty rules baked into check details:
 *   - when a check samples (e.g. probes one queue of several), it SAYS so;
 *   - placeholder (REPLACE_ME) detection without reading secret values is
 *     impossible, so it rides the app's own /ready semantics and the secret
 *     check says so;
 *   - a cross-region inference profile is resolved to its destination
 *     regions and availability is checked per region, but a single
 *     successful probe cannot force Bedrock to exercise every routed
 *     region — the detail states that plainly;
 *   - Nova Canvas / Nova Sonic get availability checks only; image/speech
 *     invocations are not cheap and are NOT exercised.
 *
 * AWS clients are injected through the context so unit tests pass fakes
 * (`{ send }`), mirroring scripts/lib/preflight/checks.ts. ECR and
 * CodeBuild SDK packages are not dependencies, so their defaults are the
 * read-only `aws` CLI adapter from preflight.
 */

import { CloudFormationClient, DescribeStacksCommand, ListStackResourcesCommand } from '@aws-sdk/client-cloudformation';
import { ECSClient, DescribeServicesCommand } from '@aws-sdk/client-ecs';
import {
  ElasticLoadBalancingV2Client,
  DescribeLoadBalancersCommand,
  DescribeListenersCommand,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import { EC2Client, DescribeSecurityGroupsCommand } from '@aws-sdk/client-ec2';
import { S3Client, HeadBucketCommand } from '@aws-sdk/client-s3';
import { SecretsManagerClient, DescribeSecretCommand } from '@aws-sdk/client-secrets-manager';
import { DynamoDBClient, DescribeTableCommand, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { SQSClient, GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { SNSClient, GetTopicAttributesCommand } from '@aws-sdk/client-sns';
import { SchedulerClient, GetScheduleGroupCommand } from '@aws-sdk/client-scheduler';
import { WAFV2Client, ListWebACLsCommand } from '@aws-sdk/client-wafv2';
import { IAMClient, GetOpenIDConnectProviderCommand } from '@aws-sdk/client-iam';
import {
  BedrockClient,
  ListFoundationModelsCommand,
  GetInferenceProfileCommand,
  GetFoundationModelCommand,
} from '@aws-sdk/client-bedrock';
import { BedrockRuntimeClient, ConverseCommand, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';

import {
  cliClient,
  isPlaceholder,
  resolveFeatures,
  type AwsClient,
  type CheckResult,
  type CheckStatus,
  type CliCommand,
  type FeatureFlags,
} from '../preflight/checks.js';
export { summarize, type PreflightSummary } from '../preflight/checks.js';
export type { CheckResult, CheckStatus } from '../preflight/checks.js';
import { resolveDeployMode, type DeployMode } from '../../../infra/lib/deploy-mode.js';
import { resolveImageModel } from '../image-model.js';
import { buildApp, buildResourceNames } from '../../../infra/lib/constants.js';
import { resolveStateNames } from '../lifecycle/bootstrap-state.js';
import { readLatestManifest } from '../lifecycle/journal.js';
import type { DeployManifest } from '../lifecycle/manifest.js';
import {
  validateSlackSurface,
  validateTelegramSurface,
  validateDashboardSurface,
  type FetchFn,
  type SurfaceCheck,
} from '../surface-validate.js';
import { SEED_DEFAULTS } from '../seed-defaults.js';

// ─────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────

export type VerifyLayer = 'A' | 'B' | 'C';

export interface VerifyCheck {
  id: string;
  title: string;
  layer: VerifyLayer;
  /**
   * Strict-only checks run only under `--strict` (`npm run verify` =
   * `status --strict`): the two paid Bedrock probes and the external
   * vendor-API deliverability checks. Non-strict runs report them as
   * skip with a "run --strict" detail.
   */
  strictOnly?: boolean;
  strictSkipDetail?: string;
  appliesTo(ctx: VerifyContext): boolean;
  run(ctx: VerifyContext): Promise<CheckResult>;
}

export interface VerifyClients {
  cloudFormation: AwsClient;
  ecs: AwsClient;
  elbv2: AwsClient;
  ec2: AwsClient;
  s3: AwsClient;
  secretsManager: AwsClient;
  dynamoDb: AwsClient;
  sqs: AwsClient;
  sns: AwsClient;
  scheduler: AwsClient;
  wafv2: AwsClient;
  iam: AwsClient;
  bedrock: AwsClient;
  bedrockRuntime: AwsClient;
  /** CLI-backed by default (SDK package not in dependencies). */
  ecr: AwsClient;
  codeBuild: AwsClient;
}

export interface VerifyContext {
  env: Record<string, string>;
  mode: DeployMode;
  hasDomain: boolean;
  /** infra-only WITHOUT a domain: the ALB must be internal, access is the SSM tunnel. */
  privateAccessOnly: boolean;
  features: FeatureFlags;
  tier: number;
  region: string;
  account: string;
  nameSuffix: string;
  strict: boolean;
  /** Deterministic resource names (infra/lib/constants.ts), per suffix. */
  names: ReturnType<typeof buildResourceNames>;
  /** `claudeclaw[-suffix]` slug (WAF WebACL name root, etc.). */
  appSlug: string;
  stackPrefix: string;
  clients: VerifyClients;
  /** Bedrock control-plane client for a DESTINATION region of an inference profile. */
  bedrockForRegion(region: string): AwsClient;
  fetchFn: FetchFn;
  /** Per-run memoization (stack list, ALB description, manifest, model ids). */
  cache: Map<string, unknown>;
}

export interface BuildVerifyContextOptions {
  strict?: boolean;
  clients?: Partial<VerifyClients>;
  bedrockForRegion?: (region: string) => AwsClient;
  fetchFn?: FetchFn;
}

// ─────────────────────────────────────────────────────────────────────
// Context construction
// ─────────────────────────────────────────────────────────────────────

function realValue(env: Record<string, string>, key: string): string {
  const v = env[key];
  return isPlaceholder(v) ? '' : (v as string).trim();
}

export function buildVerifyContext(
  env: Record<string, string>,
  opts: BuildVerifyContextOptions = {},
): VerifyContext {
  const region = realValue(env, 'AWS_REGION') || 'us-east-1';
  const overrides = opts.clients ?? {};
  const clients: VerifyClients = {
    cloudFormation: overrides.cloudFormation ?? new CloudFormationClient({ region }),
    ecs: overrides.ecs ?? new ECSClient({ region }),
    elbv2: overrides.elbv2 ?? new ElasticLoadBalancingV2Client({ region }),
    ec2: overrides.ec2 ?? new EC2Client({ region }),
    s3: overrides.s3 ?? new S3Client({ region }),
    secretsManager: overrides.secretsManager ?? new SecretsManagerClient({ region }),
    dynamoDb: overrides.dynamoDb ?? new DynamoDBClient({ region }),
    sqs: overrides.sqs ?? new SQSClient({ region }),
    sns: overrides.sns ?? new SNSClient({ region }),
    scheduler: overrides.scheduler ?? new SchedulerClient({ region }),
    wafv2: overrides.wafv2 ?? new WAFV2Client({ region }),
    iam: overrides.iam ?? new IAMClient({ region }),
    bedrock: overrides.bedrock ?? new BedrockClient({ region }),
    bedrockRuntime: overrides.bedrockRuntime ?? new BedrockRuntimeClient({ region }),
    ecr: overrides.ecr ?? cliClient('ecr', region),
    codeBuild: overrides.codeBuild ?? cliClient('codebuild', region),
  };
  const resolved = resolveDeployMode(env);
  const nameSuffix = realValue(env, 'CCE_NAME_SUFFIX');
  const regionalBedrock = new Map<string, AwsClient>();
  const bedrockForRegion =
    opts.bedrockForRegion ??
    ((r: string): AwsClient => {
      if (r === region) return clients.bedrock;
      let c = regionalBedrock.get(r);
      if (!c) {
        c = new BedrockClient({ region: r });
        regionalBedrock.set(r, c);
      }
      return c;
    });
  return {
    env,
    mode: resolved.mode,
    hasDomain: resolved.hasDomain,
    privateAccessOnly: resolved.privateAccessOnly,
    features: resolveFeatures(env),
    tier: Number(realValue(env, 'DEPLOY_TIER') || '1'),
    region,
    account: realValue(env, 'AWS_ACCOUNT_ID'),
    nameSuffix,
    strict: opts.strict ?? false,
    names: buildResourceNames(nameSuffix),
    appSlug: buildApp(nameSuffix),
    stackPrefix: realValue(env, 'CDK_STACK_NAME') || 'CCE',
    clients,
    bedrockForRegion,
    fetchFn: opts.fetchFn ?? (fetch as FetchFn),
    cache: new Map(),
  };
}

// ─────────────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────────────

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function errName(err: unknown): string {
  return err instanceof Error ? err.name : 'UnknownError';
}

function modelAccessRemediation(modelId: string, region: string): string {
  return (
    `Grant access to ${modelId} in the Bedrock console (Model access page): ` +
    `https://console.aws.amazon.com/bedrock/home?region=${region}#/model-catalog`
  );
}

function memo<T>(ctx: VerifyContext, key: string, make: () => Promise<T>): Promise<T> {
  if (!ctx.cache.has(key)) ctx.cache.set(key, make());
  return ctx.cache.get(key) as Promise<T>;
}

interface StackSummary {
  StackName?: string;
  StackStatus?: string;
}

/** All live stacks whose name starts with `<CDK_STACK_NAME>-` (paginated). */
function listPrefixedStacks(ctx: VerifyContext): Promise<StackSummary[]> {
  return memo(ctx, 'cfn:stacks', async () => {
    const stacks: StackSummary[] = [];
    let next: string | undefined;
    do {
      const out = (await ctx.clients.cloudFormation.send(
        new DescribeStacksCommand({ NextToken: next }),
      )) as { Stacks?: StackSummary[]; NextToken?: string };
      stacks.push(...(out.Stacks ?? []));
      next = out.NextToken;
    } while (next);
    return stacks.filter((s) => (s.StackName ?? '').startsWith(`${ctx.stackPrefix}-`));
  });
}

export interface StackResource {
  LogicalResourceId?: string;
  PhysicalResourceId?: string;
  ResourceType?: string;
  ResourceStatus?: string;
}

/** Stack resources of one stack (paginated, memoized per stack). */
function listStackResources(ctx: VerifyContext, stackName: string): Promise<StackResource[]> {
  return memo(ctx, `cfn:resources:${stackName}`, async () => {
    const resources: StackResource[] = [];
    let next: string | undefined;
    do {
      const out = (await ctx.clients.cloudFormation.send(
        new ListStackResourcesCommand({ StackName: stackName, NextToken: next }),
      )) as { StackResourceSummaries?: StackResource[]; NextToken?: string };
      resources.push(...(out.StackResourceSummaries ?? []));
      next = out.NextToken;
    } while (next);
    return resources;
  });
}

interface AlbDescription {
  LoadBalancerArn?: string;
  DNSName?: string;
  Scheme?: string;
  SecurityGroups?: string[];
}

/** The app ALB by its deterministic name, or null when absent (memoized). */
function describeAlb(ctx: VerifyContext): Promise<AlbDescription | null> {
  return memo(ctx, 'elbv2:alb', async () => {
    try {
      const out = (await ctx.clients.elbv2.send(
        new DescribeLoadBalancersCommand({ Names: [ctx.names.alb] }),
      )) as { LoadBalancers?: AlbDescription[] };
      return out.LoadBalancers?.[0] ?? null;
    } catch (err) {
      if (errName(err) === 'LoadBalancerNotFoundException') return null;
      throw err;
    }
  });
}

export interface ManifestLoad {
  manifest: DeployManifest | null;
  /** Set when the bucket/manifest exists but cannot be read or parsed. */
  error?: string;
}

/** Latest deploy manifest from the state bucket (memoized; never throws). */
export function getManifest(ctx: VerifyContext): Promise<ManifestLoad> {
  return memo(ctx, 'state:manifest', async () => {
    let bucket: string;
    try {
      bucket = resolveStateNames(ctx.env).stateBucket;
    } catch (err) {
      return { manifest: null, error: errMessage(err) };
    }
    try {
      const manifest = await readLatestManifest(ctx.clients.s3, bucket);
      return { manifest };
    } catch (err) {
      return { manifest: null, error: errMessage(err) };
    }
  });
}

/** Foundation-model ids visible in the HOME region (memoized). */
function listModelIdsIn(ctx: VerifyContext, region: string): Promise<Set<string>> {
  return memo(ctx, `bedrock:model-ids:${region}`, async () => {
    const client = region === ctx.region ? ctx.clients.bedrock : ctx.bedrockForRegion(region);
    const out = (await client.send(new ListFoundationModelsCommand({}))) as {
      modelSummaries?: Array<{ modelId?: string }>;
    };
    return new Set((out.modelSummaries ?? []).map((m) => m.modelId ?? '').filter((id) => id !== ''));
  });
}

function listHomeModelIds(ctx: VerifyContext): Promise<Set<string>> {
  return listModelIdsIn(ctx, ctx.region);
}

const CLAUDE_MODEL_KEYS = [
  'BEDROCK_DEFAULT_MODEL',
  'BEDROCK_SONNET_MODEL',
  'BEDROCK_HAIKU_MODEL',
  'BEDROCK_OPUS_MODEL',
] as const;

function configuredClaudeModel(ctx: VerifyContext): string {
  for (const key of CLAUDE_MODEL_KEYS) {
    const v = realValue(ctx.env, key);
    if (v) return v;
  }
  return '';
}

/** Cross-region inference-profile prefixes (kept in sync with preflight). */
const INFERENCE_PROFILE_PREFIX = /^(us|eu|apac|jp|au|ca|sa|us-gov|global)\./;

export function isInferenceProfileId(modelId: string): boolean {
  return INFERENCE_PROFILE_PREFIX.test(modelId) || modelId.startsWith('arn:');
}

export interface ProfileResolution {
  /** Destination region → whether the underlying model is available there. */
  regions: Array<{ region: string; modelId: string; available: boolean; error?: string }>;
  resolveError?: string;
}

/**
 * Resolve an inference profile to its DESTINATION regions
 * (bedrock GetInferenceProfile) and check model availability per region.
 * One Converse probe cannot force Bedrock to route to every region; the
 * caller's detail must state that plainly.
 */
export async function resolveInferenceProfile(
  ctx: VerifyContext,
  modelId: string,
): Promise<ProfileResolution> {
  let modelArns: string[];
  try {
    const out = (await ctx.clients.bedrock.send(
      new GetInferenceProfileCommand({ inferenceProfileIdentifier: modelId }),
    )) as { models?: Array<{ modelArn?: string }> };
    modelArns = (out.models ?? []).map((m) => m.modelArn ?? '').filter((a) => a !== '');
  } catch (err) {
    return { regions: [], resolveError: errMessage(err) };
  }
  const regions: ProfileResolution['regions'] = [];
  for (const arn of modelArns) {
    // arn:aws:bedrock:<region>::foundation-model/<modelId>
    const parts = arn.split(':');
    const region = parts[3] ?? '';
    const destModelId = arn.split('/').pop() ?? '';
    if (!region || !destModelId) continue;
    try {
      await ctx.bedrockForRegion(region).send(
        new GetFoundationModelCommand({ modelIdentifier: destModelId }),
      );
      regions.push({ region, modelId: destModelId, available: true });
    } catch (err) {
      regions.push({ region, modelId: destModelId, available: false, error: errMessage(err) });
    }
  }
  return { regions };
}

const COMPLETE_STATUS_RE = /(^CREATE_COMPLETE|^UPDATE_COMPLETE|^IMPORT_COMPLETE)$/;

// ─────────────────────────────────────────────────────────────────────
// LAYER A · CFN-derived
// ─────────────────────────────────────────────────────────────────────

const stacksLive: VerifyCheck = {
  id: 'stacks-live',
  title: `CloudFormation stacks by prefix`,
  layer: 'A',
  appliesTo: () => true,
  async run(ctx) {
    let stacks: StackSummary[];
    try {
      stacks = await listPrefixedStacks(ctx);
    } catch (err) {
      return {
        id: this.id,
        title: this.title,
        status: 'fail',
        detail: `could not enumerate stacks: ${errMessage(err)}`,
        remediation: 'Verify AWS credentials/region, then re-run.',
      };
    }
    if (stacks.length === 0) {
      return {
        id: this.id,
        title: this.title,
        status: 'fail',
        detail: `no live stacks named ${ctx.stackPrefix}-* in ${ctx.region} — nothing is deployed`,
        remediation: 'Run `npm run deploy` first.',
      };
    }
    const lines = stacks.map((s) => `${s.StackName}: ${s.StackStatus}`);
    const broken = stacks.filter((s) => /FAILED|ROLLBACK_IN_PROGRESS|DELETE/.test(s.StackStatus ?? ''));
    const rolledBack = stacks.filter((s) => s.StackStatus === 'UPDATE_ROLLBACK_COMPLETE');
    const inProgress = stacks.filter((s) => /IN_PROGRESS$/.test(s.StackStatus ?? ''));
    if (broken.length > 0) {
      return {
        id: this.id,
        title: this.title,
        status: 'fail',
        detail: lines.join('\n'),
        remediation: `Inspect the failed stack(s): aws cloudformation describe-stack-events --stack-name ${broken[0].StackName} --region ${ctx.region}`,
      };
    }
    if (rolledBack.length > 0 || inProgress.length > 0) {
      return {
        id: this.id,
        title: this.title,
        status: 'warn',
        detail:
          lines.join('\n') +
          (rolledBack.length > 0 ? '\nUPDATE_ROLLBACK_COMPLETE means the last update was rolled back' : '') +
          (inProgress.length > 0 ? '\nan operation is still in progress — re-run verify once it settles' : ''),
      };
    }
    return {
      id: this.id,
      title: this.title,
      status: 'pass',
      detail: `${stacks.length} live stack(s), all stable:\n${lines.join('\n')}`,
    };
  },
};

interface EcsDeployment {
  status?: string;
  rolloutState?: string;
  rolloutStateReason?: string;
}

const ecsServiceSteady: VerifyCheck = {
  id: 'ecs-service-steady',
  title: 'ECS service steady (running == desired, no failed deployments)',
  layer: 'A',
  appliesTo: () => true,
  async run(ctx) {
    let service:
      | {
          status?: string;
          runningCount?: number;
          desiredCount?: number;
          deployments?: EcsDeployment[];
        }
      | undefined;
    try {
      const out = (await ctx.clients.ecs.send(
        new DescribeServicesCommand({
          cluster: ctx.names.ecsCluster,
          services: [ctx.names.fargateService],
        }),
      )) as { services?: Array<NonNullable<typeof service>>; failures?: Array<{ reason?: string }> };
      service = out.services?.[0];
      if (!service || service.status === 'INACTIVE') {
        return {
          id: this.id,
          title: this.title,
          status: 'fail',
          detail: `service ${ctx.names.fargateService} not found in cluster ${ctx.names.ecsCluster}${out.failures?.[0]?.reason ? ` (${out.failures[0].reason})` : ''}`,
          remediation: 'Run `npm run deploy` — the Compute stack creates the service.',
        };
      }
    } catch (err) {
      return {
        id: this.id,
        title: this.title,
        status: 'fail',
        detail: `DescribeServices failed: ${errMessage(err)}`,
        remediation: 'Verify ECS read access and the cluster name, then re-run.',
      };
    }
    const running = service.runningCount ?? 0;
    const desired = service.desiredCount ?? 0;
    const failedDeployments = (service.deployments ?? []).filter(
      (d) => d.rolloutState === 'FAILED',
    );
    const problems: string[] = [];
    if (desired === 0) problems.push('desiredCount is 0 — the service is scaled to zero');
    if (running !== desired) problems.push(`runningCount ${running} != desiredCount ${desired}`);
    for (const d of failedDeployments) {
      problems.push(`deployment FAILED: ${d.rolloutStateReason ?? 'no reason given'}`);
    }
    if (problems.length > 0) {
      return {
        id: this.id,
        title: this.title,
        status: 'fail',
        detail: problems.join('\n'),
        remediation: `Check task logs: the service events panel and CloudWatch ${ctx.names.logGroupOrchestrator} usually name the crash cause.`,
      };
    }
    return {
      id: this.id,
      title: this.title,
      status: 'pass',
      detail: `${running}/${desired} tasks running, ${(service.deployments ?? []).length} deployment(s), none failed`,
    };
  },
};

const TUNNEL_NOTE =
  'full dashboard verification (auth round-trip) rides `npm run dashboard:tunnel` in this mode';

const dashboardEndpoint: VerifyCheck = {
  id: 'dashboard-endpoint',
  title: 'Dashboard endpoint over HTTPS (per deploy mode)',
  layer: 'A',
  appliesTo: () => true,
  async run(ctx) {
    if (ctx.privateAccessOnly) {
      // No public endpoint exists BY DESIGN; probing one would be wrong.
      return {
        id: this.id,
        title: this.title,
        status: 'skip',
        detail:
          'infra-only without a domain: no public endpoint by design — the private-posture ' +
          `scan (check private-posture) is the verification here; ${TUNNEL_NOTE}`,
      };
    }
    const domain = realValue(ctx.env, 'DOMAIN_NAME');
    if (!domain) {
      const certArn = realValue(ctx.env, 'ACM_CERT_ARN');
      if (certArn) {
        // Bring-your-own-cert path (ACM_CERT_ARN set, DOMAIN_NAME blank): the
        // operator manages DNS (e.g. an alias to the ALB), so there is no public
        // URL derived from .env to probe here. Skip the public-URL probe rather
        // than fail; the cert/endpoint are verified manually / at deploy time.
        return {
          id: this.id,
          title: this.title,
          status: 'skip',
          detail:
            'ACM_CERT_ARN provided (bring-your-own-cert path) but DOMAIN_NAME is not set, ' +
            'so there is no public URL to probe here. The operator manages DNS (e.g. an alias ' +
            'to the ALB); verify the cert and endpoint manually.',
        };
      }
      return {
        id: this.id,
        title: this.title,
        status: 'fail',
        detail: `${ctx.mode} mode requires HTTPS/domain but DOMAIN_NAME is not set`,
        remediation: 'Set DOMAIN_NAME in .env (chat mode requires it), or switch to CCE_DEPLOY_MODE=infra-only.',
      };
    }
    const base = `https://${domain}`;

    if (ctx.mode === 'chat') {
      const url = `${base}/ready`;
      try {
        const resp = await ctx.fetchFn(url, { signal: AbortSignal.timeout(10_000) } as RequestInit);
        if (resp.status === 200) {
          return {
            id: this.id,
            title: this.title,
            status: 'pass',
            detail: `GET ${url} returned 200 — ready for traffic`,
          };
        }
        if (resp.status === 503) {
          return {
            id: this.id,
            title: this.title,
            status: 'fail',
            detail: `GET ${url} returned 503 — the deployment is up but NOT ready for traffic (placeholder secrets or missing surface tokens keep /ready at 503)`,
            remediation:
              'Check the /ready response body and task logs; populate the missing/placeholder values it names, then force a new ECS deployment.',
          };
        }
        return {
          id: this.id,
          title: this.title,
          status: 'fail',
          detail: `GET ${url} returned unexpected HTTP ${resp.status}`,
          remediation: 'Confirm DNS resolves to the ALB and the HTTPS listener forwards to the service.',
        };
      } catch (err) {
        return {
          id: this.id,
          title: this.title,
          status: 'fail',
          detail: `GET ${url} failed: ${errMessage(err)}`,
          remediation: 'Confirm DNS resolves to the ALB and the ACM cert/HTTPS listener are live.',
        };
      }
    }

    // infra-only WITH a domain: /health 200 + dashboard auth round-trip.
    const lines: string[] = [];
    const healthUrl = `${base}/health`;
    try {
      const resp = await ctx.fetchFn(healthUrl, { signal: AbortSignal.timeout(10_000) } as RequestInit);
      if (resp.status !== 200) {
        return {
          id: this.id,
          title: this.title,
          status: 'fail',
          detail: `GET ${healthUrl} returned HTTP ${resp.status} (expected 200)`,
          remediation: 'Confirm the service is running and the HTTPS listener forwards /health.',
        };
      }
      lines.push(`GET ${healthUrl} returned 200`);
    } catch (err) {
      return {
        id: this.id,
        title: this.title,
        status: 'fail',
        detail: `GET ${healthUrl} failed: ${errMessage(err)}`,
        remediation: 'Confirm DNS resolves to the ALB and the ACM cert/HTTPS listener are live.',
      };
    }
    const token = realValue(ctx.env, 'DASHBOARD_TOKEN');
    const [auth] = await validateDashboardSurface({
      baseUrl: base,
      token: token || undefined,
      fetchFn: ctx.fetchFn,
    });
    lines.push(`${auth.id}: ${auth.status} — ${auth.detail}`);
    if (auth.status === 'fail') {
      return {
        id: this.id,
        title: this.title,
        status: 'fail',
        detail: lines.join('\n'),
        remediation: auth.remediation,
      };
    }
    if (auth.status === 'skip') {
      return {
        id: this.id,
        title: this.title,
        status: 'warn',
        detail: lines.join('\n') + '\ninfra-only mode expects dashboard auth; set DASHBOARD_TOKEN to verify it',
      };
    }
    return { id: this.id, title: this.title, status: 'pass', detail: lines.join('\n') };
  },
};

interface ListenerSummary {
  Port?: number;
  Protocol?: string;
}

interface SgPermission {
  IpProtocol?: string;
  FromPort?: number;
  ToPort?: number;
  IpRanges?: Array<{ CidrIp?: string }>;
  Ipv6Ranges?: Array<{ CidrIpv6?: string }>;
}

function permissionIsWorldOpen(p: SgPermission): boolean {
  return (
    (p.IpRanges ?? []).some((r) => r.CidrIp === '0.0.0.0/0') ||
    (p.Ipv6Ranges ?? []).some((r) => r.CidrIpv6 === '::/0')
  );
}

function permissionCoversPort(p: SgPermission, port: number): boolean {
  if (p.IpProtocol === '-1') return true;
  if (p.FromPort == null || p.ToPort == null) return false;
  return p.FromPort <= port && port <= p.ToPort;
}

const INTERNET_FACING_REASON =
  'private access means not reachable from the internet — the ALB must be internal in this mode';

const privatePosture: VerifyCheck = {
  id: 'private-posture',
  title: 'Private posture scan (internal ALB, no public ingress path)',
  layer: 'A',
  appliesTo: (ctx) => ctx.privateAccessOnly,
  async run(ctx) {
    let alb: AlbDescription | null;
    try {
      alb = await describeAlb(ctx);
    } catch (err) {
      return {
        id: this.id,
        title: this.title,
        status: 'fail',
        detail: `DescribeLoadBalancers failed: ${errMessage(err)}`,
        remediation: 'Verify ELBv2 read access, then re-run.',
      };
    }
    if (!alb) {
      return {
        id: this.id,
        title: this.title,
        status: 'fail',
        detail: `ALB ${ctx.names.alb} not found — cannot verify private posture`,
        remediation: 'Run `npm run deploy`; the Compute stack creates the ALB.',
      };
    }

    // Listeners + SG rules, so the verdict is based on the LIVE network
    // surface rather than what the template intended.
    let listeners: ListenerSummary[] = [];
    let listenerNote = '';
    try {
      const out = (await ctx.clients.elbv2.send(
        new DescribeListenersCommand({ LoadBalancerArn: alb.LoadBalancerArn }),
      )) as { Listeners?: ListenerSummary[] };
      listeners = out.Listeners ?? [];
    } catch (err) {
      listenerNote = `could not list listeners: ${errMessage(err)}`;
    }
    let permissions: SgPermission[] = [];
    let sgNote = '';
    try {
      if ((alb.SecurityGroups ?? []).length > 0) {
        const out = (await ctx.clients.ec2.send(
          new DescribeSecurityGroupsCommand({ GroupIds: alb.SecurityGroups }),
        )) as { SecurityGroups?: Array<{ IpPermissions?: SgPermission[] }> };
        permissions = (out.SecurityGroups ?? []).flatMap((g) => g.IpPermissions ?? []);
      }
    } catch (err) {
      sgNote = `could not read security-group rules: ${errMessage(err)}`;
    }

    const listenerPorts = listeners.map((l) => l.Port ?? 0).filter((p) => p > 0);
    const openToWorldPorts = listenerPorts.filter((port) =>
      permissions.some((p) => permissionIsWorldOpen(p) && permissionCoversPort(p, port)),
    );

    const scanned =
      `scanned ${listeners.length} listener(s) [${listenerPorts.join(', ') || 'none'}] and ` +
      `${permissions.length} security-group ingress rule(s) on ${(alb.SecurityGroups ?? []).length} group(s)`;
    const notes = [listenerNote, sgNote].filter((n) => n !== '');

    if (alb.Scheme !== 'internal') {
      const lines = [
        `ALB ${ctx.names.alb} Scheme is "${alb.Scheme ?? 'unknown'}" — ${INTERNET_FACING_REASON}`,
      ];
      if (openToWorldPorts.length > 0) {
        lines.push(
          `worse: 0.0.0.0/0 or ::/0 ingress reaches the dashboard target on listener port(s) ${openToWorldPorts.join(', ')} of an internet-facing ALB`,
        );
      }
      lines.push(scanned, ...notes);
      return {
        id: this.id,
        title: this.title,
        status: 'fail',
        detail: lines.join('\n'),
        remediation:
          'Redeploy with CCE_DEPLOY_MODE=infra-only and no DOMAIN_NAME so the Compute stack synthesizes the ALB internal, or set a domain + ACM cert for legitimate public HTTPS access.',
      };
    }

    if (openToWorldPorts.length > 0 || notes.length > 0) {
      return {
        id: this.id,
        title: this.title,
        status: 'warn',
        detail: [
          `ALB is internal (not internet-routable)${openToWorldPorts.length > 0 ? `, but its security group still has world-open ingress on port(s) ${openToWorldPorts.join(', ')} — tighten it (defense in depth)` : ''}`,
          scanned,
          ...notes,
        ].join('\n'),
      };
    }
    return {
      id: this.id,
      title: this.title,
      status: 'pass',
      detail: `ALB ${ctx.names.alb} is internal; no world-open ingress reaches any listener port · ${scanned} · ${TUNNEL_NOTE}`,
    };
  },
};

const dashboardPlainHttp: VerifyCheck = {
  id: 'dashboard-plain-http',
  title: 'Dashboard auth must never answer on plain HTTP (every mode)',
  layer: 'A',
  appliesTo: () => true,
  async run(ctx) {
    const token = realValue(ctx.env, 'DASHBOARD_TOKEN');
    if (!token) {
      return {
        id: this.id,
        title: this.title,
        status: 'skip',
        detail: 'DASHBOARD_TOKEN not configured — plain-HTTP exposure probe has nothing to authenticate with',
      };
    }
    let alb: AlbDescription | null;
    try {
      alb = await describeAlb(ctx);
    } catch (err) {
      return {
        id: this.id,
        title: this.title,
        status: 'warn',
        detail: `could not resolve the ALB (${errMessage(err)}); plain-HTTP exposure not checked`,
      };
    }
    if (!alb?.DNSName) {
      return {
        id: this.id,
        title: this.title,
        status: 'warn',
        detail: `ALB ${ctx.names.alb} not found; plain-HTTP exposure not checked`,
      };
    }
    const url = `http://${alb.DNSName}/api/agents`;
    try {
      const resp = await ctx.fetchFn(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
        // A plain-HTTP→HTTPS redirect is the CORRECT posture; do not follow
        // it into a misleading 200.
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
      } as RequestInit);
      if (resp.status === 200) {
        return {
          id: this.id,
          title: this.title,
          status: 'fail',
          detail: `authenticated GET ${url} returned 200 over PLAIN HTTP — dashboard auth must never ride plain HTTP`,
          remediation:
            'Make port 80 redirect to HTTPS (domain + ACM cert path) or remove the public HTTP listener entirely; bearer tokens on plain HTTP are interceptable.',
        };
      }
      return {
        id: this.id,
        title: this.title,
        status: 'pass',
        detail: `GET ${url} did not serve authenticated traffic over plain HTTP (HTTP ${resp.status})`,
      };
    } catch (err) {
      // Connection refused / timeout means plain HTTP is not answering at
      // all — exactly the wanted posture (internal ALB or no :80 listener).
      return {
        id: this.id,
        title: this.title,
        status: 'pass',
        detail: `plain HTTP ${url} is not reachable (${errMessage(err)}) — no plain-HTTP exposure`,
      };
    }
  },
};

const ddbTablesActive: VerifyCheck = {
  id: 'ddb-tables-active',
  title: 'DynamoDB tables ACTIVE (enumerated from the Dynamo stack)',
  layer: 'A',
  appliesTo: () => true,
  async run(ctx) {
    const stackName = `${ctx.stackPrefix}-Dynamo`;
    let tables: StackResource[];
    try {
      tables = (await listStackResources(ctx, stackName)).filter(
        (r) => r.ResourceType === 'AWS::DynamoDB::Table',
      );
    } catch (err) {
      return {
        id: this.id,
        title: this.title,
        status: 'fail',
        detail: `could not list ${stackName} resources: ${errMessage(err)}`,
        remediation: 'Confirm the Dynamo stack exists (see stacks-live) and CFN read access.',
      };
    }
    if (tables.length === 0) {
      return {
        id: this.id,
        title: this.title,
        status: 'fail',
        detail: `${stackName} declares no DynamoDB tables — unexpected for any tier`,
      };
    }
    const problems: string[] = [];
    for (const t of tables) {
      const name = t.PhysicalResourceId ?? '';
      try {
        const out = (await ctx.clients.dynamoDb.send(
          new DescribeTableCommand({ TableName: name }),
        )) as { Table?: { TableStatus?: string } };
        const status = out.Table?.TableStatus ?? 'unknown';
        if (status !== 'ACTIVE') problems.push(`${name}: ${status}`);
      } catch (err) {
        problems.push(`${name}: ${errMessage(err)}`);
      }
    }
    if (problems.length > 0) {
      return {
        id: this.id,
        title: this.title,
        status: 'fail',
        detail: `of ${tables.length} stack-declared tables, ${problems.length} are not ACTIVE:\n${problems.join('\n')}`,
        remediation: 'A deleted/perpetually-non-ACTIVE table means CFN drift; see docs/lifecycle.md data-restore notes.',
      };
    }
    return {
      id: this.id,
      title: this.title,
      status: 'pass',
      detail: `all ${tables.length} stack-declared tables ACTIVE (enumerated from ${stackName} resources, not a hardcoded list)`,
    };
  },
};

const messagingQueuesTopics: VerifyCheck = {
  id: 'messaging-queues-topics',
  title: 'SQS queues + SNS topics exist (Messaging stack resources)',
  layer: 'A',
  appliesTo: () => true,
  async run(ctx) {
    const stackName = `${ctx.stackPrefix}-Messaging`;
    let resources: StackResource[];
    try {
      resources = await listStackResources(ctx, stackName);
    } catch (err) {
      return {
        id: this.id,
        title: this.title,
        status: 'fail',
        detail: `could not list ${stackName} resources: ${errMessage(err)}`,
        remediation: 'Confirm the Messaging stack exists (see stacks-live) and CFN read access.',
      };
    }
    const queues = resources.filter((r) => r.ResourceType === 'AWS::SQS::Queue');
    const topics = resources.filter((r) => r.ResourceType === 'AWS::SNS::Topic');
    const notComplete = [...queues, ...topics].filter(
      (r) => !COMPLETE_STATUS_RE.test(r.ResourceStatus ?? ''),
    );
    if (notComplete.length > 0) {
      return {
        id: this.id,
        title: this.title,
        status: 'fail',
        detail: notComplete
          .map((r) => `${r.LogicalResourceId} (${r.ResourceType}): ${r.ResourceStatus}`)
          .join('\n'),
      };
    }
    const problems: string[] = [];
    // SAMPLING: live-probe ONE queue and ONE topic; the rest are asserted
    // from CFN resource records only. The detail says so.
    const sampledQueue = queues[0]?.PhysicalResourceId;
    if (sampledQueue) {
      try {
        await ctx.clients.sqs.send(
          new GetQueueAttributesCommand({ QueueUrl: sampledQueue, AttributeNames: ['QueueArn'] }),
        );
      } catch (err) {
        problems.push(`sampled queue ${sampledQueue}: ${errMessage(err)}`);
      }
    }
    const sampledTopic = topics[0]?.PhysicalResourceId;
    if (sampledTopic) {
      try {
        await ctx.clients.sns.send(new GetTopicAttributesCommand({ TopicArn: sampledTopic }));
      } catch (err) {
        problems.push(`sampled topic ${sampledTopic}: ${errMessage(err)}`);
      }
    }
    const sampledNote =
      `SAMPLED: live-probed 1 of ${queues.length} queue(s) and 1 of ${topics.length} topic(s); ` +
      'the remaining existence claims come from CFN resource records, not live probes';
    if (problems.length > 0) {
      return {
        id: this.id,
        title: this.title,
        status: 'fail',
        detail: [...problems, sampledNote].join('\n'),
        remediation: 'A CFN-recorded queue/topic that fails a live probe means out-of-band deletion; redeploy the Messaging stack.',
      };
    }
    return {
      id: this.id,
      title: this.title,
      status: 'pass',
      detail: `${queues.length} queue(s) + ${topics.length} topic(s) recorded complete in ${stackName} · ${sampledNote}`,
    };
  },
};

const storageBuckets: VerifyCheck = {
  id: 'storage-buckets',
  title: 'S3 buckets reachable (Storage stack resources)',
  layer: 'A',
  appliesTo: () => true,
  async run(ctx) {
    const stackName = `${ctx.stackPrefix}-Storage`;
    let buckets: StackResource[];
    try {
      buckets = (await listStackResources(ctx, stackName)).filter(
        (r) => r.ResourceType === 'AWS::S3::Bucket',
      );
    } catch (err) {
      return {
        id: this.id,
        title: this.title,
        status: 'fail',
        detail: `could not list ${stackName} resources: ${errMessage(err)}`,
        remediation: 'Confirm the Storage stack exists (see stacks-live) and CFN read access.',
      };
    }
    if (buckets.length === 0) {
      return {
        id: this.id,
        title: this.title,
        status: 'fail',
        detail: `${stackName} declares no S3 buckets — unexpected`,
      };
    }
    const problems: string[] = [];
    for (const b of buckets) {
      const name = b.PhysicalResourceId ?? '';
      try {
        await ctx.clients.s3.send(new HeadBucketCommand({ Bucket: name }));
      } catch (err) {
        problems.push(`${name}: ${errMessage(err)}`);
      }
    }
    if (problems.length > 0) {
      return {
        id: this.id,
        title: this.title,
        status: 'fail',
        detail: `HeadBucket failed for ${problems.length} of ${buckets.length} stack-declared bucket(s):\n${problems.join('\n')}`,
      };
    }
    return {
      id: this.id,
      title: this.title,
      status: 'pass',
      detail: `HeadBucket succeeded on all ${buckets.length} stack-declared bucket(s)`,
    };
  },
};

const ecrImage: VerifyCheck = {
  id: 'ecr-image',
  title: "ECR repo exists and holds the manifest's image tag",
  layer: 'A',
  appliesTo: () => true,
  async run(ctx) {
    let repo: string;
    try {
      repo = resolveStateNames(ctx.env).ecrRepo;
    } catch (err) {
      return { id: this.id, title: this.title, status: 'fail', detail: errMessage(err) };
    }
    try {
      await ctx.clients.ecr.send({
        action: 'describe-repositories',
        args: ['--repository-names', repo],
      } satisfies CliCommand);
    } catch (err) {
      return {
        id: this.id,
        title: this.title,
        status: 'fail',
        detail: `ECR repo ${repo} not found or unreadable: ${errMessage(err)}`,
        remediation: 'Run `npm run deploy` — bootstrap-state creates the repo before the first build.',
      };
    }
    const { manifest } = await getManifest(ctx);
    if (!manifest) {
      return {
        id: this.id,
        title: this.title,
        status: 'warn',
        detail: `repo ${repo} exists, but no readable deploy manifest pins an expected image tag (see manifest-present)`,
      };
    }
    try {
      await ctx.clients.ecr.send({
        action: 'describe-images',
        args: ['--repository-name', repo, '--image-ids', `imageTag=${manifest.imageTag}`],
      } satisfies CliCommand);
    } catch (err) {
      return {
        id: this.id,
        title: this.title,
        status: 'fail',
        detail: `manifest image tag ${manifest.imageTag} is NOT in ECR repo ${repo}: ${errMessage(err)} — rollback to this deploy would have nothing to run`,
        remediation:
          'The lifecycle policy must keep per-deploy tags (plan item 18). Re-push the image or run a fresh deploy.',
      };
    }
    return {
      id: this.id,
      title: this.title,
      status: 'pass',
      detail: `repo ${repo} holds manifest image tag ${manifest.imageTag}`,
    };
  },
};

const schedulerGroup: VerifyCheck = {
  id: 'scheduler-group',
  title: 'EventBridge Scheduler group exists',
  layer: 'A',
  appliesTo: () => true,
  async run(ctx) {
    const name = ctx.names.schedulerGroupName;
    try {
      const out = (await ctx.clients.scheduler.send(new GetScheduleGroupCommand({ Name: name }))) as {
        State?: string;
      };
      if (out.State && out.State !== 'ACTIVE') {
        return {
          id: this.id,
          title: this.title,
          status: 'fail',
          detail: `scheduler group ${name} exists but is ${out.State}`,
        };
      }
      return { id: this.id, title: this.title, status: 'pass', detail: `scheduler group ${name} ACTIVE` };
    } catch (err) {
      if (errName(err) === 'ResourceNotFoundException') {
        return {
          id: this.id,
          title: this.title,
          status: 'fail',
          detail: `scheduler group ${name} not found — scheduled tasks cannot fire`,
          remediation: 'The Messaging stack owns the group; redeploy it.',
        };
      }
      return { id: this.id, title: this.title, status: 'fail', detail: `GetScheduleGroup failed: ${errMessage(err)}` };
    }
  },
};

const wafCloudFront: VerifyCheck = {
  id: 'waf-cloudfront',
  title: 'WAF WebACL (tier ≥ 2) + CloudFront distribution (tier 3)',
  layer: 'A',
  appliesTo: (ctx) => ctx.tier >= 2,
  async run(ctx) {
    const lines: string[] = [];
    const problems: string[] = [];
    const aclName = `${ctx.appSlug}-web-acl`;
    try {
      const out = (await ctx.clients.wafv2.send(new ListWebACLsCommand({ Scope: 'REGIONAL' }))) as {
        WebACLs?: Array<{ Name?: string }>;
      };
      if ((out.WebACLs ?? []).some((a) => a.Name === aclName)) {
        lines.push(`regional WebACL ${aclName} present`);
      } else {
        problems.push(`regional WebACL ${aclName} not found (tier ${ctx.tier} requires WAF)`);
      }
    } catch (err) {
      problems.push(`ListWebACLs failed: ${errMessage(err)}`);
    }
    if (ctx.tier >= 3) {
      try {
        const resources = await listStackResources(ctx, `${ctx.stackPrefix}-Security`);
        const dist = resources.find((r) => r.ResourceType === 'AWS::CloudFront::Distribution');
        if (dist && COMPLETE_STATUS_RE.test(dist.ResourceStatus ?? '')) {
          lines.push(
            `CloudFront distribution ${dist.PhysicalResourceId} recorded ${dist.ResourceStatus} (CFN-derived; edge behavior is not live-probed here)`,
          );
        } else {
          problems.push(
            dist
              ? `CloudFront distribution is ${dist.ResourceStatus}`
              : 'no CloudFront distribution in the Security stack (tier 3 requires one)',
          );
        }
      } catch (err) {
        problems.push(`could not list Security stack resources: ${errMessage(err)}`);
      }
    }
    if (problems.length > 0) {
      return {
        id: this.id,
        title: this.title,
        status: 'fail',
        detail: [...problems, ...lines].join('\n'),
        remediation: 'Redeploy the Security stack at this tier; WAF/CloudFront are tier-gated there.',
      };
    }
    return { id: this.id, title: this.title, status: 'pass', detail: lines.join('\n') };
  },
};

// ─────────────────────────────────────────────────────────────────────
// LAYER B · value checks
// ─────────────────────────────────────────────────────────────────────

const MANIFEST_REMEDIATION =
  'Run a deploy with this version of the tooling (`npm run deploy`) so a current-schema manifest is promoted to the state bucket.';

const manifestPresent: VerifyCheck = {
  id: 'manifest-present',
  title: 'Deploy manifest present in the state bucket (current schema)',
  layer: 'B',
  appliesTo: () => true,
  async run(ctx) {
    const { manifest, error } = await getManifest(ctx);
    if (error) {
      return {
        id: this.id,
        title: this.title,
        status: 'fail',
        detail: `could not read/parse the latest deploy manifest: ${error}`,
        remediation: MANIFEST_REMEDIATION,
      };
    }
    if (!manifest) {
      return {
        id: this.id,
        title: this.title,
        status: 'fail',
        detail: 'no deploy manifest has ever been promoted to the state bucket',
        remediation: MANIFEST_REMEDIATION,
      };
    }
    return {
      id: this.id,
      title: this.title,
      status: 'pass',
      detail: `deploy ${manifest.deployId} · git ${manifest.gitSha} · image ${manifest.imageTag} · mode ${manifest.mode}`,
    };
  },
};

const PLACEHOLDER_HONESTY =
  'NOTE: placeholder (REPLACE_ME) detection without reading secret values is impossible — this check uses DescribeSecret only, never GetSecretValue; placeholder detection rides the app\'s own /ready semantics (layer A dashboard-endpoint).';

const secretVersionsFresh: VerifyCheck = {
  id: 'secret-versions-fresh',
  title: 'Secret versions fresh vs manifest (DescribeSecret only)',
  layer: 'B',
  appliesTo: () => true,
  async run(ctx) {
    const { manifest } = await getManifest(ctx);
    if (!manifest) {
      return {
        id: this.id,
        title: this.title,
        status: 'skip',
        detail: 'no readable deploy manifest — recorded secret versions unknown (see manifest-present)',
      };
    }
    const records = manifest.secretVersions ?? [];
    if (records.length === 0) {
      return {
        id: this.id,
        title: this.title,
        status: 'warn',
        detail: `manifest ${manifest.deployId} records no secret versions — nothing to compare\n${PLACEHOLDER_HONESTY}`,
      };
    }
    const missing: string[] = [];
    const drifted: string[] = [];
    const ok: string[] = [];
    const unreadable: string[] = [];
    for (const rec of records) {
      try {
        const out = (await ctx.clients.secretsManager.send(
          new DescribeSecretCommand({ SecretId: rec.secretId }),
        )) as { VersionIdsToStages?: Record<string, string[]> };
        const stages = out.VersionIdsToStages ?? {};
        if (!(rec.versionId in stages)) {
          missing.push(
            `${rec.secretId}: recorded version ${rec.versionId} no longer exists — rollback to this deploy cannot restore it`,
          );
          continue;
        }
        const current = Object.entries(stages).find(([, s]) => s.includes('AWSCURRENT'))?.[0];
        if (current !== rec.versionId) {
          drifted.push(
            `${rec.secretId}: AWSCURRENT is ${current ?? '(none)'} but the manifest recorded ${rec.versionId} — the secret changed after the deploy (naming drift)`,
          );
        } else {
          ok.push(rec.secretId);
        }
      } catch (err) {
        unreadable.push(`${rec.secretId}: ${errMessage(err)}`);
      }
    }
    const summaryLine = `${ok.length} current, ${drifted.length} drifted, ${missing.length} missing, ${unreadable.length} unreadable of ${records.length} recorded secret version(s)`;
    if (missing.length > 0 || unreadable.length > 0) {
      return {
        id: this.id,
        title: this.title,
        status: 'fail',
        detail: [summaryLine, ...missing, ...unreadable, ...drifted, PLACEHOLDER_HONESTY].join('\n'),
        remediation:
          'A missing recorded version means per-deploy labels were pruned or the secret was force-rotated; run a fresh deploy to re-establish a rollback-able baseline.',
      };
    }
    if (drifted.length > 0) {
      return {
        id: this.id,
        title: this.title,
        status: 'warn',
        detail: [summaryLine, ...drifted, PLACEHOLDER_HONESTY].join('\n'),
        remediation:
          'If the rotation was intentional, the next deploy re-records versions; if not, investigate who moved AWSCURRENT.',
      };
    }
    return {
      id: this.id,
      title: this.title,
      status: 'pass',
      detail: `${summaryLine}\n${PLACEHOLDER_HONESTY}`,
    };
  },
};

const runtimeConfigSeed: VerifyCheck = {
  id: 'runtime-config-seed',
  title: 'Runtime-config seed rows present',
  layer: 'B',
  appliesTo: () => true,
  async run(ctx) {
    const table = ctx.names.ddb.runtimeConfig;
    const missing: string[] = [];
    const unreadable: string[] = [];
    for (const row of SEED_DEFAULTS) {
      try {
        const out = (await ctx.clients.dynamoDb.send(
          new GetItemCommand({
            TableName: table,
            Key: { PK: { S: `CONFIG#${row.category}` }, SK: { S: row.key } },
          }),
        )) as { Item?: Record<string, unknown> };
        if (!out.Item) missing.push(`${row.category}/${row.key}`);
      } catch (err) {
        unreadable.push(`${row.category}/${row.key}: ${errMessage(err)}`);
      }
    }
    if (missing.length > 0 || unreadable.length > 0) {
      return {
        id: this.id,
        title: this.title,
        status: 'fail',
        detail: [
          missing.length > 0 ? `missing seed rows in ${table}: ${missing.join(', ')}` : '',
          ...unreadable,
        ]
          .filter((l) => l !== '')
          .join('\n'),
        remediation: 'Run `npm run seed` (deploy embeds it; a standalone run is idempotent and never overwrites tuned values).',
      };
    }
    return {
      id: this.id,
      title: this.title,
      status: 'pass',
      detail: `all ${SEED_DEFAULTS.length} seed rows present in ${table}`,
    };
  },
};

// ─────────────────────────────────────────────────────────────────────
// LAYER C · external + Bedrock probes
// ─────────────────────────────────────────────────────────────────────

const STRICT_EXTERNAL_SKIP =
  'external deliverability check — run --strict (`npm run verify`) to exercise it';

function surfaceChecksToResult(id: string, title: string, checks: SurfaceCheck[]): CheckResult {
  const lines = checks.map((c) => `${c.id}: ${c.status} — ${c.detail}`);
  const failed = checks.filter((c) => c.status === 'fail');
  const status: CheckStatus = failed.length > 0 ? 'fail' : 'pass';
  return {
    id,
    title,
    status,
    detail: lines.join('\n'),
    remediation:
      failed.length > 0
        ? failed.map((c) => c.remediation).filter((r): r is string => Boolean(r)).join('\n')
        : undefined,
  };
}

const externalSlack: VerifyCheck = {
  id: 'external-slack',
  title: 'Slack token + signed-request delivery',
  layer: 'C',
  strictOnly: true,
  strictSkipDetail: STRICT_EXTERNAL_SKIP,
  appliesTo: (ctx) => realValue(ctx.env, 'SLACK_BOT_TOKEN') !== '',
  async run(ctx) {
    const domain = realValue(ctx.env, 'DOMAIN_NAME');
    const checks = await validateSlackSurface({
      botToken: realValue(ctx.env, 'SLACK_BOT_TOKEN'),
      signingSecret: realValue(ctx.env, 'SLACK_SIGNING_SECRET') || undefined,
      baseUrl: domain ? `https://${domain}` : undefined,
      fetchFn: ctx.fetchFn,
    });
    return surfaceChecksToResult(this.id, this.title, checks);
  },
};

const externalTelegram: VerifyCheck = {
  id: 'external-telegram',
  title: 'Telegram webhook URL match (read-only, register:false)',
  layer: 'C',
  strictOnly: true,
  strictSkipDetail: STRICT_EXTERNAL_SKIP,
  appliesTo: (ctx) => realValue(ctx.env, 'TELEGRAM_TOKENS_JSON') !== '',
  async run(ctx) {
    const domain = realValue(ctx.env, 'DOMAIN_NAME');
    const checks = await validateTelegramSurface({
      tokensJson: realValue(ctx.env, 'TELEGRAM_TOKENS_JSON'),
      webhookSecret: realValue(ctx.env, 'TELEGRAM_WEBHOOK_SECRET') || undefined,
      expectedBaseUrl: domain ? `https://${domain}` : undefined,
      // verify NEVER mutates: a webhook mismatch fails with the manual
      // setWebhook remediation instead of re-registering it.
      register: false,
      fetchFn: ctx.fetchFn,
    });
    return surfaceChecksToResult(this.id, this.title, checks);
  },
};

const githubOidc: VerifyCheck = {
  id: 'github-oidc',
  title: 'GitHub OIDC provider (CCE_CICD_ENABLED=1)',
  layer: 'C',
  appliesTo: (ctx) => ctx.env.CCE_CICD_ENABLED === '1',
  async run(ctx) {
    const account = ctx.account || '<ACCOUNT_ID>';
    const providerArn = `arn:aws:iam::${account}:oidc-provider/token.actions.githubusercontent.com`;
    try {
      const out = (await ctx.clients.iam.send(
        new GetOpenIDConnectProviderCommand({ OpenIDConnectProviderArn: providerArn }),
      )) as { ClientIDList?: string[] };
      const audiences = out.ClientIDList ?? [];
      if (!audiences.includes('sts.amazonaws.com')) {
        return {
          id: this.id,
          title: this.title,
          status: 'fail',
          detail: `OIDC provider exists but its audience list lacks sts.amazonaws.com (found: ${audiences.join(', ') || 'none'})`,
          remediation: `aws iam add-client-id-to-open-id-connect-provider --open-id-connect-provider-arn ${providerArn} --client-id sts.amazonaws.com`,
        };
      }
      return {
        id: this.id,
        title: this.title,
        status: 'pass',
        detail: 'GitHub OIDC provider present with sts.amazonaws.com audience',
      };
    } catch (err) {
      if (errName(err) === 'NoSuchEntityException' || errName(err) === 'NoSuchEntity') {
        return {
          id: this.id,
          title: this.title,
          status: 'fail',
          detail: 'CCE_CICD_ENABLED=1 but the GitHub OIDC provider does not exist in this account',
          remediation: 'Create it: bash scripts/oidc-provider.sh',
        };
      }
      return {
        id: this.id,
        title: this.title,
        status: 'fail',
        detail: `could not check the GitHub OIDC provider: ${errMessage(err)}`,
      };
    }
  },
};

const codeBuildCredential: VerifyCheck = {
  id: 'codebuild-credential',
  title: 'CodeBuild GitHub source credential (CCE_CODEBUILD_ENABLED=1)',
  layer: 'C',
  appliesTo: (ctx) => ctx.env.CCE_CODEBUILD_ENABLED === '1',
  async run(ctx) {
    try {
      const out = (await ctx.clients.codeBuild.send({
        action: 'list-source-credentials',
        args: [],
      } satisfies CliCommand)) as { sourceCredentialsInfos?: Array<{ serverType?: string }> };
      const hasGithub = (out.sourceCredentialsInfos ?? []).some((c) => c.serverType === 'GITHUB');
      if (!hasGithub) {
        return {
          id: this.id,
          title: this.title,
          status: 'fail',
          detail: 'no GITHUB source credential is imported in CodeBuild — tag-triggered builds cannot read the repo',
          remediation:
            'aws codebuild import-source-credentials --server-type GITHUB --auth-type PERSONAL_ACCESS_TOKEN --token <github-pat>',
        };
      }
      return { id: this.id, title: this.title, status: 'pass', detail: 'CodeBuild GITHUB source credential present' };
    } catch (err) {
      return {
        id: this.id,
        title: this.title,
        status: 'fail',
        detail: `could not check CodeBuild source credentials: ${errMessage(err)}`,
      };
    }
  },
};

// ── Bedrock probes (item 16, feature-aware) ──────────────────────────

const bedrockProbeClaude: VerifyCheck = {
  id: 'bedrock-probe-claude',
  title: 'Bedrock probe · Claude Converse WITH the configured guardrail',
  layer: 'C',
  strictOnly: true,
  strictSkipDetail: 'PAID probe (one Converse call, ~a cent) — run --strict (`npm run verify`) to exercise it',
  appliesTo: () => true,
  async run(ctx) {
    const modelId = configuredClaudeModel(ctx);
    if (!modelId) {
      return {
        id: this.id,
        title: this.title,
        status: 'fail',
        detail: 'no Claude model configured (BEDROCK_DEFAULT/SONNET/HAIKU/OPUS_MODEL all unset) — nothing to probe',
        remediation: 'Run `npm run setup` or set BEDROCK_DEFAULT_MODEL in .env.',
      };
    }

    const lines: string[] = [];

    // Cross-region inference profiles, handled honestly: resolve the
    // profile to its destination regions and check model availability per
    // region; one successful Converse probe proves only the route it took.
    if (isInferenceProfileId(modelId)) {
      const resolution = await resolveInferenceProfile(ctx, modelId);
      if (resolution.resolveError) {
        lines.push(`could not resolve inference profile destinations: ${resolution.resolveError}`);
      } else {
        for (const r of resolution.regions) {
          lines.push(
            r.available
              ? `destination ${r.region}: ${r.modelId} available`
              : `destination ${r.region}: ${r.modelId} NOT available (${r.error ?? 'unknown'})`,
          );
        }
        lines.push(
          'HONESTY: a single successful probe cannot force Bedrock to exercise every routed region — per-region availability above is the best static signal',
        );
        const unavailable = resolution.regions.filter((r) => !r.available);
        if (unavailable.length > 0) {
          return {
            id: this.id,
            title: this.title,
            status: 'fail',
            detail: [`inference profile ${modelId} routes to a region without model access:`, ...lines].join('\n'),
            remediation: unavailable
              .map((r) => modelAccessRemediation(r.modelId, r.region))
              .join('\n'),
          };
        }
      }
    }

    const guardrailId = realValue(ctx.env, 'BEDROCK_GUARDRAIL_ID');
    const guardrailVersion = realValue(ctx.env, 'BEDROCK_GUARDRAIL_VERSION') || 'DRAFT';
    try {
      await ctx.clients.bedrockRuntime.send(
        new ConverseCommand({
          modelId,
          messages: [{ role: 'user', content: [{ text: 'ping' }] }],
          inferenceConfig: { maxTokens: 16 },
          ...(guardrailId
            ? { guardrailConfig: { guardrailIdentifier: guardrailId, guardrailVersion } }
            : {}),
        }),
      );
    } catch (err) {
      return {
        id: this.id,
        title: this.title,
        status: 'fail',
        detail: [
          `live Converse probe against ${modelId}${guardrailId ? ` with guardrail ${guardrailId}/${guardrailVersion}` : ''} failed: ${errMessage(err)}`,
          ...lines,
        ].join('\n'),
        remediation:
          modelAccessRemediation(modelId, ctx.region) +
          (guardrailId
            ? '\nIf the error names the guardrail, confirm BEDROCK_GUARDRAIL_ID/VERSION match the Guardrails stack outputs.'
            : ''),
      };
    }
    lines.unshift(
      `live Converse probe succeeded against ${modelId} (maxTokens 16, prompt "ping" — the one PAID probe in verify, costs ~a cent)` +
        (guardrailId
          ? ` · guardrail ${guardrailId}/${guardrailVersion} attached`
          : ' · no guardrail configured (BEDROCK_GUARDRAIL_ID unset), probed without one'),
    );
    return { id: this.id, title: this.title, status: 'pass', detail: lines.join('\n') };
  },
};

const DEFAULT_EMBED_MODEL = 'amazon.titan-embed-text-v2:0';

const bedrockProbeTitanEmbed: VerifyCheck = {
  id: 'bedrock-probe-titan-embed',
  title: 'Bedrock probe · Titan embeddings (knowledge enabled)',
  layer: 'C',
  strictOnly: true,
  strictSkipDetail: 'PAID probe (one tiny embedding call) — run --strict (`npm run verify`) to exercise it',
  appliesTo: (ctx) => ctx.features.knowledge,
  async run(ctx) {
    const modelId = realValue(ctx.env, 'BEDROCK_EMBED_MODEL') || DEFAULT_EMBED_MODEL;
    try {
      await ctx.clients.bedrockRuntime.send(
        new InvokeModelCommand({
          modelId,
          contentType: 'application/json',
          accept: 'application/json',
          body: JSON.stringify({ inputText: 'ping' }),
        }),
      );
    } catch (err) {
      return {
        id: this.id,
        title: this.title,
        status: 'fail',
        detail: `live InvokeModel embedding probe against ${modelId} failed: ${errMessage(err)}`,
        remediation: modelAccessRemediation(modelId, ctx.region),
      };
    }
    return {
      id: this.id,
      title: this.title,
      status: 'pass',
      detail: `live InvokeModel embedding probe succeeded against ${modelId} (input "ping" — tiny PAID call)`,
    };
  },
};

function availabilityCheck(opts: {
  id: string;
  title: string;
  feature: keyof FeatureFlags;
  family: string;
  featureLabel: string;
  invocationNote: string;
}): VerifyCheck {
  return {
    id: opts.id,
    title: opts.title,
    layer: 'C',
    appliesTo: (ctx) => ctx.features[opts.feature],
    async run(ctx) {
      let ids: Set<string>;
      try {
        ids = await listHomeModelIds(ctx);
      } catch (err) {
        return {
          id: opts.id,
          title: opts.title,
          status: 'fail',
          detail: `could not list Bedrock foundation models in ${ctx.region}: ${errMessage(err)}`,
        };
      }
      const match = [...ids].find((id) => id === opts.family || id.startsWith(opts.family));
      if (!match) {
        return {
          id: opts.id,
          title: opts.title,
          status: 'fail',
          detail: `${opts.featureLabel} is enabled but no ${opts.family}* model is accessible in ${ctx.region}`,
          remediation: modelAccessRemediation(`${opts.family}*`, ctx.region),
        };
      }
      return {
        id: opts.id,
        title: opts.title,
        status: 'pass',
        detail: `${match} listed (availability check ONLY — ${opts.invocationNote})`,
      };
    },
  };
}

/**
 * Image gen availability follows the runtime's model resolution
 * (BEDROCK_IMAGE_MODEL → BEDROCK_NOVA_CANVAS_MODEL → the Stability default)
 * and lists in the model's SERVING region (us-west-2 for Stability), so a
 * default install is checked against the model it will actually invoke —
 * not against the Legacy-flagged Nova Canvas family in the deploy region.
 */
const bedrockAvailabilityImage: VerifyCheck = {
  id: 'bedrock-availability-image',
  title: 'Bedrock availability · image model (image gen enabled)',
  layer: 'C',
  appliesTo: (ctx) => ctx.features.imageGen,
  async run(ctx) {
    const { modelId, region } = resolveImageModel((k) => realValue(ctx.env, k), ctx.region);
    let ids: Set<string>;
    try {
      ids = await listModelIdsIn(ctx, region);
    } catch (err) {
      return {
        id: this.id,
        title: this.title,
        status: 'fail',
        detail: `could not list Bedrock foundation models in ${region} (the image model's serving region): ${errMessage(err)}`,
      };
    }
    const match =
      ids.has(modelId) ||
      [...ids].some((id) => id.startsWith(`${modelId}:`) || modelId.startsWith(`${id}:`));
    if (!match) {
      const pinnedCanvas = modelId.startsWith('amazon.nova-canvas');
      return {
        id: this.id,
        title: this.title,
        status: 'fail',
        detail: `Image generation is enabled but ${modelId} is not accessible in ${region}`,
        remediation: pinnedCanvas
          ? 'Nova Canvas went provider-Legacy in mid-2026 and Bedrock refuses it for new callers. Unset BEDROCK_IMAGE_MODEL / BEDROCK_NOVA_CANVAS_MODEL to use the Stability default (us-west-2, auto-subscribes on first use), or set CCE_IMAGE_GEN_ENABLED=0.'
          : 'Check BEDROCK_IMAGE_MODEL / BEDROCK_IMAGE_REGION (Stability image models are us-west-2-only and auto-subscribe on first use), or set CCE_IMAGE_GEN_ENABLED=0.',
      };
    }
    return {
      id: this.id,
      title: this.title,
      status: 'pass',
      detail: `${modelId} listed in ${region} (availability check ONLY — image-generation invocation is NOT exercised; it is not cheap)`,
    };
  },
};

const bedrockAvailabilityNovaSonic = availabilityCheck({
  id: 'bedrock-availability-nova-sonic',
  title: 'Bedrock availability · Nova Sonic (JARVIS_LAUNCH_ENABLED)',
  feature: 'jarvisVoice',
  family: 'amazon.nova-sonic',
  featureLabel: 'Jarvis voice',
  invocationNote: 'speech invocation is NOT exercised; it is not cheap',
});

// ─────────────────────────────────────────────────────────────────────
// Registry + runner
// ─────────────────────────────────────────────────────────────────────

export const allChecks: VerifyCheck[] = [
  // Layer A — CFN-derived
  stacksLive,
  ecsServiceSteady,
  dashboardEndpoint,
  privatePosture,
  dashboardPlainHttp,
  ddbTablesActive,
  messagingQueuesTopics,
  storageBuckets,
  ecrImage,
  schedulerGroup,
  wafCloudFront,
  // Layer B — value checks
  manifestPresent,
  secretVersionsFresh,
  runtimeConfigSeed,
  // Layer C — external + Bedrock probes
  externalSlack,
  externalTelegram,
  githubOidc,
  codeBuildCredential,
  bedrockProbeClaude,
  bedrockProbeTitanEmbed,
  bedrockAvailabilityImage,
  bedrockAvailabilityNovaSonic,
];

export function checkById(id: string): VerifyCheck {
  const check = allChecks.find((c) => c.id === id);
  if (!check) throw new Error(`unknown verify check: ${id}`);
  return check;
}

export async function runVerify(
  ctx: VerifyContext,
  checks: VerifyCheck[] = allChecks,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const check of checks) {
    if (!check.appliesTo(ctx)) {
      results.push({
        id: check.id,
        title: check.title,
        status: 'skip',
        detail: 'not applicable for this deploy mode / feature set',
      });
      continue;
    }
    if (check.strictOnly && !ctx.strict) {
      results.push({
        id: check.id,
        title: check.title,
        status: 'skip',
        detail: check.strictSkipDetail ?? 'strict-only check — run --strict',
      });
      continue;
    }
    try {
      results.push(await check.run(ctx));
    } catch (err) {
      // A crashing check must never abort the rest of the verification.
      results.push({
        id: check.id,
        title: check.title,
        status: 'fail',
        detail: `check crashed: ${errMessage(err)}`,
      });
    }
  }
  return results;
}
