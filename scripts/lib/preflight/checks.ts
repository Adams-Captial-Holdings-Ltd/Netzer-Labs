/**
 * Pre-deploy preflight checks (`npm run doctor`).
 *
 * HARD RULE: this module is PURE READ-ONLY. Every AWS call is a
 * read/describe/list/get. Nothing here may ever create, modify, or
 * delete a resource. The state bucket + lock table are created later by
 * bootstrap-state (plan item 6); doctor runs BEFORE that and only looks.
 *
 * Architecture: a check registry. Each check declares whether it applies
 * to the resolved context (deploy mode + feature flags) and returns a
 * single CheckResult. scripts/doctor.ts is the CLI; deploy.ts can import
 * `buildContext` + `runPreflight` to run the same checks programmatically.
 *
 * AWS clients are injected through the context so unit tests can pass
 * fakes (`{ send }`). Defaults are real SDK clients for services already
 * in package.json dependencies; for the five services whose SDK packages
 * are NOT dependencies (SSM, Service Quotas, ACM, Route 53, CodeBuild)
 * the default is a thin read-only `aws` CLI adapter with the same
 * `{ send }` shape — doctor must not grow the runtime dependency tree.
 */

import { capture } from '../shell.js';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { BedrockClient, ListFoundationModelsCommand } from '@aws-sdk/client-bedrock';
import { EC2Client, DescribeAddressesCommand, DescribeVpcsCommand } from '@aws-sdk/client-ec2';
import {
  ElasticLoadBalancingV2Client,
  DescribeLoadBalancersCommand,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import { S3Client, HeadBucketCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { SecretsManagerClient, DescribeSecretCommand } from '@aws-sdk/client-secrets-manager';
import { IAMClient, GetOpenIDConnectProviderCommand } from '@aws-sdk/client-iam';
import { CostExplorerClient } from '@aws-sdk/client-cost-explorer';
import { findServiceAnomalyMonitor } from '../aws-checks.js';
import { resolveImageModel } from '../image-model.js';
import { s3BodyToString } from '../lifecycle/journal.js';
import { CONFIG_EPOCH_KEY } from '../lifecycle/handover-plan.js';
import {
  checkForUpdates,
  type UpdateCheckResult,
} from '../../../src/lib/updates/discovery.js';

// ─────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'skip';

export interface CheckResult {
  id: string;
  title: string;
  status: CheckStatus;
  detail: string;
  remediation?: string;
}

export interface PreflightCheck {
  id: string;
  title: string;
  appliesTo(ctx: PreflightContext): boolean;
  run(ctx: PreflightContext): Promise<CheckResult>;
}

/** Minimal AWS-SDK-shaped client. Tests inject fakes with `{ send }`. */
export interface AwsClient {
  send(command: unknown): Promise<unknown>;
}

/** Command shape used by the CLI-backed clients (services whose SDK
 * package is not a dependency). Fakes receive the same object. */
export interface CliCommand {
  action: string;
  args: string[];
}

export type DeployMode = 'chat' | 'infra-only';

export interface FeatureFlags {
  imageGen: boolean;
  tts: boolean;
  knowledge: boolean;
  jarvisVoice: boolean;
}

export interface PreflightClients {
  sts: AwsClient;
  cloudFormation: AwsClient;
  bedrock: AwsClient;
  ec2: AwsClient;
  elbv2: AwsClient;
  s3: AwsClient;
  secretsManager: AwsClient;
  iam: AwsClient;
  /** Cost Explorer is a global service served from us-east-1. */
  costExplorer: AwsClient;
  /** CLI-backed by default (SDK package not in dependencies). */
  ssm: AwsClient;
  serviceQuotas: AwsClient;
  acm: AwsClient;
  route53: AwsClient;
  codeBuild: AwsClient;
}

export interface ExecProbeResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface PreflightContext {
  env: Record<string, string>;
  mode: DeployMode;
  features: FeatureFlags;
  tier: string;
  region: string;
  /** Account from .env (AWS_ACCOUNT_ID); may be '' when unset. */
  account: string;
  /** Account resolved live by the aws-identity check (STS). */
  resolvedAccount?: string;
  nameSuffix: string;
  clients: PreflightClients;
  /** Bedrock control-plane client for a region OTHER than the deploy region
   * (the image model's serving region, e.g. us-west-2 for Stability).
   * Returns `clients.bedrock` for the deploy region itself. */
  bedrockForRegion(region: string): AwsClient;
  /** Spawn probe for local binaries (session-manager-plugin). Injected in tests. */
  execProbe: (cmd: string, args: string[]) => Promise<ExecProbeResult>;
  /** Per-run memoization (e.g. ListFoundationModels called by 5 checks). */
  cache: Map<string, unknown>;
  /**
   * Update-discovery hook (plan item 46). Defaults to the real fail-silent
   * GitHub releases check from src/lib/updates/discovery.ts; tests inject a
   * fake. Read-only and informational — its check NEVER warns or fails.
   */
  updateDiscovery?: (env: Record<string, string>) => Promise<UpdateCheckResult>;
}

// ─────────────────────────────────────────────────────────────────────
// Context construction
// ─────────────────────────────────────────────────────────────────────

const PLACEHOLDER_RE = /replace_me/i;

/** Placeholder-shaped values (REPLACE_ME, empty, <your-...>) count as missing. */
export function isPlaceholder(value: string | undefined): boolean {
  if (value == null) return true;
  const v = value.trim();
  if (v === '') return true;
  if (PLACEHOLDER_RE.test(v)) return true;
  if (v.startsWith('<') && v.endsWith('>')) return true;
  return false;
}

function realValue(env: Record<string, string>, key: string): string {
  const v = env[key];
  return isPlaceholder(v) ? '' : v.trim();
}

export function resolveMode(env: Record<string, string>): DeployMode {
  return env.CCE_DEPLOY_MODE === 'infra-only' ? 'infra-only' : 'chat';
}

export function resolveFeatures(env: Record<string, string>): FeatureFlags {
  return {
    imageGen: env.CCE_IMAGE_GEN_ENABLED !== '0',
    tts: env.CCE_TTS_ENABLED !== '0',
    knowledge: env.CCE_KNOWLEDGE_ENABLED !== '0',
    jarvisVoice: env.JARVIS_LAUNCH_ENABLED === 'true' || env.JARVIS_LAUNCH_ENABLED === '1',
  };
}

/**
 * Read-only `aws` CLI adapter for services whose SDK package is not a
 * dependency. Only ever invoked with get/list/describe actions.
 */
export function cliClient(service: string, region: string): AwsClient {
  return {
    async send(command: unknown): Promise<unknown> {
      const cmd = command as CliCommand;
      const { code, stdout, stderr } = await capture('aws', [
        service,
        cmd.action,
        ...cmd.args,
        '--region',
        region,
        '--output',
        'json',
      ]);
      if (code !== 0) {
        // Mirror SDK error shape: `name` carries the AWS error code.
        const match = /An error occurred \(([^)]+)\)/.exec(stderr);
        const err = new Error(stderr.trim() || `aws ${service} ${cmd.action} exited ${code}`);
        err.name = match?.[1] ?? 'CliError';
        throw err;
      }
      return stdout.trim() ? (JSON.parse(stdout) as unknown) : {};
    },
  };
}

export interface BuildContextOptions {
  clients?: Partial<PreflightClients>;
  bedrockForRegion?: PreflightContext['bedrockForRegion'];
  execProbe?: PreflightContext['execProbe'];
  updateDiscovery?: PreflightContext['updateDiscovery'];
}

async function defaultExecProbe(cmd: string, args: string[]): Promise<ExecProbeResult> {
  try {
    return await capture(cmd, args);
  } catch (err) {
    // spawn ENOENT (binary not on PATH) rejects; normalize to exit 127.
    return { code: 127, stdout: '', stderr: err instanceof Error ? err.message : String(err) };
  }
}

export function buildContext(
  env: Record<string, string>,
  opts: BuildContextOptions = {},
): PreflightContext {
  const region = realValue(env, 'AWS_REGION') || 'us-east-1';
  const overrides = opts.clients ?? {};
  const clients: PreflightClients = {
    sts: overrides.sts ?? new STSClient({ region }),
    cloudFormation: overrides.cloudFormation ?? new CloudFormationClient({ region }),
    bedrock: overrides.bedrock ?? new BedrockClient({ region }),
    ec2: overrides.ec2 ?? new EC2Client({ region }),
    elbv2: overrides.elbv2 ?? new ElasticLoadBalancingV2Client({ region }),
    s3: overrides.s3 ?? new S3Client({ region }),
    secretsManager: overrides.secretsManager ?? new SecretsManagerClient({ region }),
    iam: overrides.iam ?? new IAMClient({ region }),
    // Cost Explorer is global; its endpoint lives in us-east-1 regardless of
    // the deploy region.
    costExplorer: overrides.costExplorer ?? new CostExplorerClient({ region: 'us-east-1' }),
    ssm: overrides.ssm ?? cliClient('ssm', region),
    serviceQuotas: overrides.serviceQuotas ?? cliClient('service-quotas', region),
    acm: overrides.acm ?? cliClient('acm', region),
    route53: overrides.route53 ?? cliClient('route53', region),
    codeBuild: overrides.codeBuild ?? cliClient('codebuild', region),
  };
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
    mode: resolveMode(env),
    features: resolveFeatures(env),
    tier: realValue(env, 'DEPLOY_TIER') || '1',
    region,
    account: realValue(env, 'AWS_ACCOUNT_ID'),
    nameSuffix: realValue(env, 'CCE_NAME_SUFFIX'),
    clients,
    bedrockForRegion,
    execProbe: opts.execProbe ?? defaultExecProbe,
    cache: new Map(),
    updateDiscovery: opts.updateDiscovery ?? ((env) => checkForUpdates(env)),
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

function accountOf(ctx: PreflightContext): string {
  return ctx.account || ctx.resolvedAccount || '<ACCOUNT_ID>';
}

function secretBase(ctx: PreflightContext): string {
  return ctx.nameSuffix ? `/claudeclaw-${ctx.nameSuffix}` : '/claudeclaw';
}

function stateBucketName(ctx: PreflightContext): string {
  const fromEnv = realValue(ctx.env, 'DEPLOY_MANIFEST_BUCKET');
  if (fromEnv) return fromEnv;
  const sfx = ctx.nameSuffix ? `-${ctx.nameSuffix}` : '';
  return `claudeclaw${sfx}-deploy-${accountOf(ctx)}-${ctx.region}`;
}

function modelAccessConsoleUrl(region: string): string {
  return `https://console.aws.amazon.com/bedrock/home?region=${region}#/model-catalog`;
}

/** Cross-region inference-profile prefixes (`us.`, `eu.`, ...) are stripped
 * before comparing against foundation-model ids. The list is explicit so
 * `anthropic.` / `amazon.` vendor prefixes are never stripped. */
const INFERENCE_PROFILE_PREFIX = /^(us|eu|apac|jp|au|ca|sa|us-gov|global)\./;

export function stripInferenceProfilePrefix(modelId: string): string {
  return modelId.replace(INFERENCE_PROFILE_PREFIX, '');
}

interface FoundationModelSummary {
  modelId?: string;
}

async function listModelIdsIn(ctx: PreflightContext, region: string): Promise<Set<string>> {
  const cacheKey = `bedrock:foundation-model-ids:${region}`;
  if (!ctx.cache.has(cacheKey)) {
    // Memoize the PROMISE so concurrent/sequential callers share one call
    // and a region failure surfaces identically in every dependent check.
    ctx.cache.set(
      cacheKey,
      (async () => {
        const client = ctx.bedrockForRegion(region);
        const out = (await client.send(new ListFoundationModelsCommand({}))) as {
          modelSummaries?: FoundationModelSummary[];
        };
        return new Set(
          (out.modelSummaries ?? []).map((m) => m.modelId ?? '').filter((id) => id !== ''),
        );
      })(),
    );
  }
  return ctx.cache.get(cacheKey) as Promise<Set<string>>;
}

function listGrantedModelIds(ctx: PreflightContext): Promise<Set<string>> {
  return listModelIdsIn(ctx, ctx.region);
}

/** Exact-id grant match after stripping inference-profile prefixes, with
 * tolerance for context-length variants (`...-v1:0` vs `...-v1:0:200k`). */
function modelGranted(grantedIds: Set<string>, configuredId: string): boolean {
  const want = stripInferenceProfilePrefix(configuredId);
  if (grantedIds.has(want)) return true;
  for (const id of grantedIds) {
    if (id.startsWith(`${want}:`) || want.startsWith(`${id}:`)) return true;
  }
  return false;
}

/** Family match for fixed Amazon model families (nova-canvas, titan-embed). */
function familyGranted(grantedIds: Set<string>, familyPrefix: string): boolean {
  for (const id of grantedIds) {
    if (id === familyPrefix || id.startsWith(familyPrefix)) return true;
  }
  return false;
}

const CLAUDE_MODEL_KEYS = [
  'BEDROCK_DEFAULT_MODEL',
  'BEDROCK_SONNET_MODEL',
  'BEDROCK_HAIKU_MODEL',
  'BEDROCK_OPUS_MODEL',
] as const;

function configuredClaudeModels(ctx: PreflightContext): string[] {
  const seen = new Set<string>();
  for (const key of CLAUDE_MODEL_KEYS) {
    const v = realValue(ctx.env, key);
    if (v) seen.add(v);
  }
  return [...seen];
}

const GRANT_PASS_NOTE = 'grant visible; invocation probed by npm run verify';

function bedrockListFailure(id: string, title: string, ctx: PreflightContext, err: unknown): CheckResult {
  return {
    id,
    title,
    status: 'fail',
    detail: `could not list Bedrock foundation models in ${ctx.region}: ${errMessage(err)}`,
    remediation: `Fix the region-capability failure first (Bedrock must be reachable in ${ctx.region}).`,
  };
}

// ─────────────────────────────────────────────────────────────────────
// 1. aws-identity
// ─────────────────────────────────────────────────────────────────────

const awsIdentity: PreflightCheck = {
  id: 'aws-identity',
  title: 'AWS identity (STS GetCallerIdentity)',
  appliesTo: () => true,
  async run(ctx) {
    let account: string;
    let arn: string;
    try {
      const out = (await ctx.clients.sts.send(new GetCallerIdentityCommand({}))) as {
        Account?: string;
        Arn?: string;
      };
      if (!out.Account || !out.Arn) throw new Error('STS returned incomplete identity');
      account = out.Account;
      arn = out.Arn;
    } catch (err) {
      return {
        id: this.id,
        title: this.title,
        status: 'fail',
        detail: `STS GetCallerIdentity failed: ${errMessage(err)}`,
        remediation:
          'Configure AWS credentials: `aws configure` (or set AWS_PROFILE / SSO login) and re-run.',
      };
    }
    ctx.resolvedAccount = account;
    if (ctx.account && ctx.account !== account) {
      return {
        id: this.id,
        title: this.title,
        status: 'fail',
        detail: `credentials resolve to account ${account} (${arn}) but .env AWS_ACCOUNT_ID is ${ctx.account} — wrong-account protection`,
        remediation:
          `Switch credentials to account ${ctx.account} (check AWS_PROFILE / aws configure), ` +
          `or update AWS_ACCOUNT_ID in .env if ${account} is genuinely the intended target.`,
      };
    }
    return {
      id: this.id,
      title: this.title,
      status: 'pass',
      detail: `account ${account} · ${arn}`,
    };
  },
};

// ─────────────────────────────────────────────────────────────────────
// 2. cdk-bootstrap
// ─────────────────────────────────────────────────────────────────────

const CDK_BOOTSTRAP_VERSION_PARAM = '/cdk-bootstrap/hnb659fds/version';
const CDK_BOOTSTRAP_MIN_VERSION = 6;

const cdkBootstrap: PreflightCheck = {
  id: 'cdk-bootstrap',
  title: 'CDK bootstrap (CDKToolkit stack + qualifier version)',
  appliesTo: () => true,
  async run(ctx) {
    const bootstrapCmd = `npx cdk bootstrap aws://${accountOf(ctx)}/${ctx.region}`;
    try {
      await ctx.clients.cloudFormation.send(
        new DescribeStacksCommand({ StackName: 'CDKToolkit' }),
      );
    } catch (err) {
      if (/does not exist/i.test(errMessage(err))) {
        return {
          id: this.id,
          title: this.title,
          status: 'fail',
          detail: `CDKToolkit stack not found in ${ctx.region} — this account/region is not CDK-bootstrapped`,
          remediation: bootstrapCmd,
        };
      }
      return {
        id: this.id,
        title: this.title,
        status: 'fail',
        detail: `could not describe CDKToolkit stack: ${errMessage(err)}`,
        remediation: `Verify CloudFormation read access, then if missing: ${bootstrapCmd}`,
      };
    }

    try {
      const out = (await ctx.clients.ssm.send({
        action: 'get-parameter',
        args: ['--name', CDK_BOOTSTRAP_VERSION_PARAM],
      } satisfies CliCommand)) as { Parameter?: { Value?: string } };
      const version = Number(out.Parameter?.Value ?? NaN);
      if (Number.isNaN(version)) {
        return {
          id: this.id,
          title: this.title,
          status: 'fail',
          detail: `bootstrap version parameter ${CDK_BOOTSTRAP_VERSION_PARAM} is missing or unreadable`,
          remediation: bootstrapCmd,
        };
      }
      if (version < CDK_BOOTSTRAP_MIN_VERSION) {
        return {
          id: this.id,
          title: this.title,
          status: 'warn',
          detail: `bootstrap version ${version} is older than ${CDK_BOOTSTRAP_MIN_VERSION} — modern CDK roles may be missing`,
          remediation: `Re-bootstrap to refresh roles: ${bootstrapCmd}`,
        };
      }
      return {
        id: this.id,
        title: this.title,
        status: 'pass',
        detail: `CDKToolkit stack present · bootstrap version ${version}`,
      };
    } catch (err) {
      if (errName(err) === 'ParameterNotFound') {
        return {
          id: this.id,
          title: this.title,
          status: 'fail',
          detail: `CDKToolkit stack exists but ${CDK_BOOTSTRAP_VERSION_PARAM} is missing — bootstrap is incomplete`,
          remediation: bootstrapCmd,
        };
      }
      return {
        id: this.id,
        title: this.title,
        status: 'fail',
        detail: `could not read ${CDK_BOOTSTRAP_VERSION_PARAM}: ${errMessage(err)}`,
        remediation: `Verify SSM read access, then if missing: ${bootstrapCmd}`,
      };
    }
  },
};

// ─────────────────────────────────────────────────────────────────────
// 3. region-capability
// ─────────────────────────────────────────────────────────────────────

const regionCapability: PreflightCheck = {
  id: 'region-capability',
  title: 'Region capability (Bedrock available)',
  appliesTo: () => true,
  async run(ctx) {
    try {
      const ids = await listGrantedModelIds(ctx);
      return {
        id: this.id,
        title: this.title,
        status: 'pass',
        detail: `Bedrock reachable in ${ctx.region} (${ids.size} foundation models listed)`,
      };
    } catch (err) {
      return {
        id: this.id,
        title: this.title,
        status: 'fail',
        detail: `Bedrock is not available in ${ctx.region}: ${errMessage(err)}`,
        remediation:
          'Pick a Bedrock-supported region (e.g. us-east-1, us-west-2) and set AWS_REGION in .env.',
      };
    }
  },
};

// ─────────────────────────────────────────────────────────────────────
// 4. bedrock model grants — one named check per grant so each missing
//    grant is its own named failure and disabled features SKIP.
// ─────────────────────────────────────────────────────────────────────

const bedrockGrantClaude: PreflightCheck = {
  id: 'bedrock-grant-claude',
  title: 'Bedrock model grant · Claude (configured models)',
  appliesTo: () => true,
  async run(ctx) {
    const models = configuredClaudeModels(ctx);
    if (models.length === 0) {
      return {
        id: this.id,
        title: this.title,
        status: 'warn',
        detail:
          'no Claude model configured (BEDROCK_DEFAULT/SONNET/HAIKU/OPUS_MODEL all unset) — nothing to validate',
        remediation: 'Run `npm run setup` to pick models, or set BEDROCK_DEFAULT_MODEL in .env.',
      };
    }
    let granted: Set<string>;
    try {
      granted = await listGrantedModelIds(ctx);
    } catch (err) {
      return bedrockListFailure(this.id, this.title, ctx, err);
    }
    const missing = models.filter((m) => !modelGranted(granted, m));
    if (missing.length > 0) {
      return {
        id: this.id,
        title: this.title,
        status: 'fail',
        detail: `missing Bedrock model access in ${ctx.region}: ${missing.join(', ')}`,
        remediation: `Grant Anthropic Claude model access in the Bedrock console: ${modelAccessConsoleUrl(ctx.region)}`,
      };
    }
    return {
      id: this.id,
      title: this.title,
      status: 'pass',
      detail: `${models.length} configured Claude model(s) listed · ${GRANT_PASS_NOTE}`,
    };
  },
};

function featureGrantCheck(opts: {
  id: string;
  title: string;
  feature: keyof FeatureFlags;
  featureLabel: string;
  family: string;
  /** Optional env key whose explicit value wins over the family prefix. */
  envKey?: string;
}): PreflightCheck {
  return {
    id: opts.id,
    title: opts.title,
    appliesTo: (ctx) => ctx.features[opts.feature],
    async run(ctx) {
      let granted: Set<string>;
      try {
        granted = await listGrantedModelIds(ctx);
      } catch (err) {
        return bedrockListFailure(opts.id, opts.title, ctx, err);
      }
      const explicit = opts.envKey ? realValue(ctx.env, opts.envKey) : '';
      const ok = explicit ? modelGranted(granted, explicit) : familyGranted(granted, opts.family);
      const wanted = explicit || `${opts.family}*`;
      if (!ok) {
        return {
          id: opts.id,
          title: opts.title,
          status: 'fail',
          detail: `${opts.featureLabel} is enabled but no ${wanted} model is accessible in ${ctx.region}`,
          remediation: `Grant ${opts.family} model access in the Bedrock console: ${modelAccessConsoleUrl(ctx.region)}`,
        };
      }
      return {
        id: opts.id,
        title: opts.title,
        status: 'pass',
        detail: `${wanted} listed · ${GRANT_PASS_NOTE}`,
      };
    },
  };
}

const bedrockGrantTitanEmbed = featureGrantCheck({
  id: 'bedrock-grant-titan-embed',
  title: 'Bedrock model grant · Titan embeddings (knowledge)',
  feature: 'knowledge',
  featureLabel: 'Knowledge (embeddings)',
  family: 'amazon.titan-embed',
  envKey: 'BEDROCK_EMBED_MODEL',
});

/**
 * Image gen is checked against the model the runtime will ACTUALLY invoke
 * (BEDROCK_IMAGE_MODEL → BEDROCK_NOVA_CANVAS_MODEL → the Stability default),
 * in its serving region (us-west-2 for Stability, not the deploy region) —
 * not via featureGrantCheck, whose family-in-deploy-region shape fit the
 * pre-Legacy Nova Canvas world.
 */
const bedrockGrantImage: PreflightCheck = {
  id: 'bedrock-grant-image',
  title: 'Bedrock model grant · image model (image gen)',
  appliesTo: (ctx) => ctx.features.imageGen,
  async run(ctx) {
    const { modelId, region } = resolveImageModel((k) => realValue(ctx.env, k), ctx.region);
    let listed: Set<string>;
    try {
      listed = await listModelIdsIn(ctx, region);
    } catch (err) {
      return {
        id: this.id,
        title: this.title,
        status: 'fail',
        detail: `could not list Bedrock foundation models in ${region}: ${errMessage(err)}`,
        remediation: `Bedrock must be reachable in ${region}, the image model's serving region (BEDROCK_IMAGE_REGION moves it).`,
      };
    }
    if (!modelGranted(listed, modelId)) {
      const pinnedCanvas = modelId.startsWith('amazon.nova-canvas');
      return {
        id: this.id,
        title: this.title,
        status: 'fail',
        detail: `Image generation is enabled but ${modelId} is not listed in ${region}`,
        remediation: pinnedCanvas
          ? 'Nova Canvas went provider-Legacy in mid-2026 and Bedrock refuses it for new callers. Unset BEDROCK_IMAGE_MODEL / BEDROCK_NOVA_CANVAS_MODEL to use the Stability default (us-west-2, auto-subscribes on first use), or set CCE_IMAGE_GEN_ENABLED=0.'
          : 'Check BEDROCK_IMAGE_MODEL / BEDROCK_IMAGE_REGION (Stability image models are us-west-2-only and auto-subscribe on first use), or set CCE_IMAGE_GEN_ENABLED=0.',
      };
    }
    return {
      id: this.id,
      title: this.title,
      status: 'pass',
      detail: `${modelId} listed in ${region} · ${GRANT_PASS_NOTE}`,
    };
  },
};

const bedrockGrantNovaSonic = featureGrantCheck({
  id: 'bedrock-grant-nova-sonic',
  title: 'Bedrock model grant · Nova Sonic (Jarvis voice)',
  feature: 'jarvisVoice',
  featureLabel: 'Jarvis voice',
  family: 'amazon.nova-sonic',
});

// ─────────────────────────────────────────────────────────────────────
// 5. service-quotas
// ─────────────────────────────────────────────────────────────────────

interface QuotaSpec {
  label: string;
  serviceCode: string;
  quotaCode: string;
  /** Quota a fresh deploy consumes. */
  need: number;
  /** Returns current usage, or null when usage is not checked. */
  usage: (ctx: PreflightContext) => Promise<number | null>;
}

const QUOTA_SPECS: QuotaSpec[] = [
  {
    label: 'EC2 EIPs',
    serviceCode: 'ec2',
    quotaCode: 'L-0263D0A3',
    need: 1, // 1 EIP for the NAT gateway
    usage: async (ctx) => {
      const out = (await ctx.clients.ec2.send(new DescribeAddressesCommand({}))) as {
        Addresses?: unknown[];
      };
      return (out.Addresses ?? []).length;
    },
  },
  {
    label: 'VPCs per region',
    serviceCode: 'vpc',
    quotaCode: 'L-F678F1CE',
    need: 1,
    usage: async (ctx) => {
      const out = (await ctx.clients.ec2.send(new DescribeVpcsCommand({}))) as {
        Vpcs?: unknown[];
      };
      return (out.Vpcs ?? []).length;
    },
  },
  {
    label: 'Fargate On-Demand vCPU',
    serviceCode: 'fargate',
    quotaCode: 'L-3032A538',
    need: 2, // static estimate; live vCPU usage is not checked here
    usage: async () => null,
  },
  {
    label: 'ALBs per region',
    serviceCode: 'elasticloadbalancing',
    quotaCode: 'L-53DA6B97',
    need: 1,
    usage: async (ctx) => {
      const out = (await ctx.clients.elbv2.send(new DescribeLoadBalancersCommand({}))) as {
        LoadBalancers?: Array<{ Type?: string }>;
      };
      return (out.LoadBalancers ?? []).filter((lb) => lb.Type === 'application').length;
    },
  },
];

const serviceQuotas: PreflightCheck = {
  id: 'service-quotas',
  title: 'Service quotas vs deploy blast radius',
  appliesTo: () => true,
  async run(ctx) {
    const lines: string[] = [];
    const remediations: string[] = [];
    let shortage = false;
    let unchecked = false;

    for (const spec of QUOTA_SPECS) {
      let quota: number;
      try {
        const out = (await ctx.clients.serviceQuotas.send({
          action: 'get-service-quota',
          args: ['--service-code', spec.serviceCode, '--quota-code', spec.quotaCode],
        } satisfies CliCommand)) as { Quota?: { Value?: number } };
        if (out.Quota?.Value == null) throw new Error('no quota value in response');
        quota = out.Quota.Value;
      } catch (err) {
        unchecked = true;
        lines.push(`${spec.label}: could not check (${errMessage(err)})`);
        continue;
      }

      let usage: number | null;
      try {
        usage = await spec.usage(ctx);
      } catch (err) {
        unchecked = true;
        lines.push(`${spec.label}: quota ${quota}, usage could not be checked (${errMessage(err)})`);
        continue;
      }

      if (usage == null) {
        // Fargate: WARN-level static need estimate only.
        if (quota < spec.need) {
          shortage = true;
          lines.push(
            `${spec.label}: quota ${quota} < static deploy estimate of ${spec.need} vCPU`,
          );
          remediations.push(
            `aws service-quotas request-service-quota-increase --service-code ${spec.serviceCode} --quota-code ${spec.quotaCode} --desired-value ${spec.need * 2}`,
          );
        } else {
          lines.push(
            `${spec.label}: quota ${quota} (usage not checked; fresh deploy needs ~${spec.need} vCPU)`,
          );
        }
        continue;
      }

      const remaining = quota - usage;
      if (remaining < spec.need) {
        shortage = true;
        lines.push(
          `${spec.label}: ${usage}/${quota} used, ${remaining} remaining < ${spec.need} needed`,
        );
        remediations.push(
          `aws service-quotas request-service-quota-increase --service-code ${spec.serviceCode} --quota-code ${spec.quotaCode} --desired-value ${quota + spec.need}`,
        );
      } else {
        lines.push(`${spec.label}: ${usage}/${quota} used, ${remaining} headroom (need ${spec.need})`);
      }
    }

    // Quota READ errors never fail the deploy: worst status here is warn.
    const status: CheckStatus = shortage || unchecked ? 'warn' : 'pass';
    return {
      id: this.id,
      title: this.title,
      status,
      detail: lines.join('\n'),
      remediation: remediations.length > 0 ? remediations.join('\n') : undefined,
    };
  },
};

// ─────────────────────────────────────────────────────────────────────
// 6. name-collisions
// ─────────────────────────────────────────────────────────────────────

const nameCollisions: PreflightCheck = {
  id: 'name-collisions',
  title: 'Resource-name collision scan',
  appliesTo: () => true,
  async run(ctx) {
    const lines: string[] = [];
    const stackName = `${realValue(ctx.env, 'CDK_STACK_NAME') || 'CCE'}-Network`;

    try {
      await ctx.clients.cloudFormation.send(new DescribeStacksCommand({ StackName: stackName }));
      lines.push(`stack ${stackName} already exists — existing install, deploy will update in place`);
    } catch (err) {
      if (/does not exist/i.test(errMessage(err))) {
        lines.push(`stack ${stackName} not present — fresh install`);
      } else {
        lines.push(`stack ${stackName}: could not check (${errMessage(err)})`);
      }
    }

    const bucket = stateBucketName(ctx);
    try {
      await ctx.clients.s3.send(new HeadBucketCommand({ Bucket: bucket }));
      lines.push(`state bucket ${bucket} exists and is accessible (ours)`);
    } catch (err) {
      const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
      const httpStatus = e.$metadata?.httpStatusCode;
      if (httpStatus === 403 || e.name === 'Forbidden' || e.name === '403') {
        return {
          id: this.id,
          title: this.title,
          status: 'fail',
          detail:
            lines.join('\n') +
            `\nstate bucket name ${bucket} exists but is owned by ANOTHER account (403) — S3 names are global`,
          remediation:
            'Set a fresh CCE_NAME_SUFFIX in .env so all named resources (including the state bucket) get a non-colliding name, then re-run doctor.',
        };
      }
      if (httpStatus === 404 || e.name === 'NotFound' || e.name === 'NoSuchBucket') {
        lines.push(`state bucket name ${bucket} is free`);
      } else {
        lines.push(`state bucket ${bucket}: could not check (${errMessage(err)})`);
      }
    }

    return { id: this.id, title: this.title, status: 'pass', detail: lines.join('\n') };
  },
};

// ─────────────────────────────────────────────────────────────────────
// 7. domain-tls
// ─────────────────────────────────────────────────────────────────────

/** True when `name` (possibly a wildcard SAN) covers `domain`. */
export function certNameCovers(name: string, domain: string): boolean {
  const n = name.toLowerCase().replace(/\.$/, '');
  const d = domain.toLowerCase().replace(/\.$/, '');
  if (n === d) return true;
  if (n.startsWith('*.')) {
    const suffix = n.slice(2);
    if (!d.endsWith(`.${suffix}`)) return false;
    // Wildcards cover exactly one extra label.
    return d.split('.').length === suffix.split('.').length + 1;
  }
  return false;
}

interface AcmCertSummary {
  CertificateArn?: string;
  DomainName?: string;
  Status?: string;
  SubjectAlternativeNameSummaries?: string[];
}

const domainTls: PreflightCheck = {
  id: 'domain-tls',
  title: 'Domain / TLS readiness',
  appliesTo: (ctx) => ctx.mode === 'chat' || realValue(ctx.env, 'DOMAIN_NAME') !== '',
  async run(ctx) {
    const domain = realValue(ctx.env, 'DOMAIN_NAME');
    if (!domain) {
      // Bring-your-own-cert path: the operator imports an ISSUED cert by ARN and
      // manages DNS themselves (e.g. apex hosted on Cloudflare with a delegated
      // subdomain in Route 53). Earn the pass by validating the ARN is an ISSUED
      // cert in the deploy region; CDK imports it at deploy time (compute-stack.ts
      // ACM_CERT_ARN branch). ACM certs are regional, so a wrong-region ARN can't
      // be attached to the ALB here.
      const certArn = realValue(ctx.env, 'ACM_CERT_ARN');
      if (certArn) {
        const arnRegion = certArn.split(':')[3];
        if (arnRegion && arnRegion !== ctx.region) {
          return {
            id: this.id,
            title: this.title,
            status: 'fail',
            detail: `ACM_CERT_ARN (${certArn}) is in region ${arnRegion}, but the deploy region is ${ctx.region}. ACM certificates are regional.`,
            remediation: `Provide an ISSUED ACM cert ARN in ${ctx.region}, or set DOMAIN_NAME for the auto-DNS path (which issues a cert in-region).`,
          };
        }
        try {
          const out = (await ctx.clients.acm.send({
            action: 'describe-certificate',
            args: ['--certificate-arn', certArn],
          } satisfies CliCommand)) as { Certificate?: { Status?: string; DomainName?: string } };
          const status = out.Certificate?.Status;
          if (status === 'ISSUED') {
            return {
              id: this.id,
              title: this.title,
              status: 'pass',
              detail: `ACM_CERT_ARN (${certArn}) is ISSUED in ${ctx.region} (bring-your-own-cert path; DNS managed by the operator).`,
            };
          }
          return {
            id: this.id,
            title: this.title,
            status: 'fail',
            detail: `ACM_CERT_ARN (${certArn}) Status is ${status ?? 'unknown'} (must be ISSUED).`,
            remediation: `Provide an ISSUED ACM cert ARN in ${ctx.region}, or set DOMAIN_NAME for the auto-DNS path.`,
          };
        } catch (err) {
          // Transient/permissions error — don't hard-fail; the cert ARN is
          // validated again when CDK imports it at deploy time.
          return {
            id: this.id,
            title: this.title,
            status: 'warn',
            detail: `ACM_CERT_ARN provided (${certArn}); could not verify ISSUED status (${errMessage(err)}) — it will be validated at deploy-time import.`,
          };
        }
      }
      // appliesTo guarantees mode === 'chat' here.
      return {
        id: this.id,
        title: this.title,
        status: 'fail',
        detail: 'chat mode requires HTTPS/domain but DOMAIN_NAME is not set',
        remediation:
          'Set DOMAIN_NAME in .env (Route 53 auto-DNS) or set ACM_CERT_ARN with your own DNS, ' +
          'or switch to CCE_DEPLOY_MODE=infra-only (dashboard only, no chat webhooks).',
      };
    }

    const failures: string[] = [];
    const remediations: string[] = [];
    const notes: string[] = [];
    let unchecked = false;

    try {
      const out = (await ctx.clients.acm.send({
        action: 'list-certificates',
        args: ['--certificate-statuses', 'ISSUED'],
      } satisfies CliCommand)) as { CertificateSummaryList?: AcmCertSummary[] };
      const certs = out.CertificateSummaryList ?? [];
      const covering = certs.find((c) => {
        const names = [c.DomainName ?? '', ...(c.SubjectAlternativeNameSummaries ?? [])];
        return names.some((n) => n !== '' && certNameCovers(n, domain));
      });
      if (covering) {
        notes.push(`ISSUED ACM cert in ${ctx.region} covers ${domain} (${covering.CertificateArn ?? 'arn unknown'})`);
      } else {
        failures.push(`no ISSUED ACM certificate in ${ctx.region} covers ${domain}`);
        remediations.push(
          `Request a cert in the deploy region: aws acm request-certificate --domain-name ${domain} --validation-method DNS --region ${ctx.region} (then complete DNS validation), or set ACM_CERT_ARN to an existing ISSUED cert in ${ctx.region}.`,
        );
      }
    } catch (err) {
      unchecked = true;
      notes.push(`ACM: could not check (${errMessage(err)})`);
    }

    const certArnProvided = realValue(ctx.env, 'ACM_CERT_ARN') !== '';
    if (!certArnProvided) {
      // Auto-DNS path: the apex hosted zone must exist in Route 53.
      try {
        const out = (await ctx.clients.route53.send({
          action: 'list-hosted-zones-by-name',
          args: ['--dns-name', domain],
        } satisfies CliCommand)) as { HostedZones?: Array<{ Name?: string }> };
        const zones = out.HostedZones ?? [];
        const fqdn = `${domain.toLowerCase().replace(/\.$/, '')}.`;
        const zone = zones.find((z) => {
          const name = (z.Name ?? '').toLowerCase();
          return name !== '' && fqdn.endsWith(name);
        });
        if (zone) {
          notes.push(`Route 53 hosted zone ${zone.Name} covers ${domain} (auto-DNS ready)`);
        } else {
          failures.push(`no Route 53 hosted zone covers ${domain} (required for the auto-DNS path)`);
          remediations.push(
            `Create a public hosted zone for the apex of ${domain} in Route 53 (and point the registrar at its nameservers), or pre-provide ACM_CERT_ARN and manage DNS yourself.`,
          );
        }
      } catch (err) {
        unchecked = true;
        notes.push(`Route 53: could not check (${errMessage(err)})`);
      }
    } else {
      notes.push('ACM_CERT_ARN provided — Route 53 hosted zone not required (manual DNS path)');
    }

    if (failures.length > 0) {
      return {
        id: this.id,
        title: this.title,
        status: 'fail',
        detail: [...failures, ...notes].join('\n'),
        remediation: remediations.join('\n'),
      };
    }
    return {
      id: this.id,
      title: this.title,
      status: unchecked ? 'warn' : 'pass',
      detail: notes.join('\n'),
    };
  },
};

// ─────────────────────────────────────────────────────────────────────
// 8. tunnel-prereq
// ─────────────────────────────────────────────────────────────────────

const tunnelPrereq: PreflightCheck = {
  id: 'tunnel-prereq',
  title: 'SSM tunnel prerequisite (session-manager-plugin)',
  appliesTo: (ctx) => ctx.mode === 'infra-only' && realValue(ctx.env, 'DOMAIN_NAME') === '',
  async run(ctx) {
    const probe = await ctx.execProbe('session-manager-plugin', ['--version']);
    const version = probe.stdout.trim() || probe.stderr.trim();
    if (probe.code === 0 && version !== '') {
      return {
        id: this.id,
        title: this.title,
        status: 'pass',
        detail: `session-manager-plugin ${version} on PATH (npm run dashboard:tunnel will work)`,
      };
    }
    return {
      id: this.id,
      title: this.title,
      status: 'fail',
      detail:
        'session-manager-plugin not found on PATH — the no-domain infra-only install is private-access only and needs it for `npm run dashboard:tunnel` (AWS CLI v2 alone does not bundle it)',
      remediation: [
        'macOS:        brew install --cask session-manager-plugin',
        'Linux (deb):  curl -o /tmp/smp.deb https://s3.amazonaws.com/session-manager-downloads/plugin/latest/ubuntu_64bit/session-manager-plugin.deb && sudo dpkg -i /tmp/smp.deb',
        'Linux (rpm):  sudo yum install -y https://s3.amazonaws.com/session-manager-downloads/plugin/latest/linux_64bit/session-manager-plugin.rpm',
        'Docs:         https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html',
      ].join('\n'),
    };
  },
};

// ─────────────────────────────────────────────────────────────────────
// 9. secrets-pending-deletion
// ─────────────────────────────────────────────────────────────────────

const SECRET_LEAF_NAMES = [
  'slack',
  'telegram',
  'dashboard',
  'db-encryption',
  'bedrock-guardrails',
  'vendor-keys',
] as const;

const secretsPendingDeletion: PreflightCheck = {
  id: 'secrets-pending-deletion',
  title: 'Secrets Manager · pending-deletion collisions',
  appliesTo: () => true,
  async run(ctx) {
    const base = secretBase(ctx);
    const pending: Array<{ id: string; deletedDate: string }> = [];
    const unchecked: string[] = [];
    let existing = 0;

    for (const leaf of SECRET_LEAF_NAMES) {
      const secretId = `${base}/${leaf}`;
      try {
        const out = (await ctx.clients.secretsManager.send(
          new DescribeSecretCommand({ SecretId: secretId }),
        )) as { DeletedDate?: Date | string };
        if (out.DeletedDate != null) {
          const d = out.DeletedDate instanceof Date ? out.DeletedDate.toISOString() : String(out.DeletedDate);
          pending.push({ id: secretId, deletedDate: d });
        } else {
          existing += 1;
        }
      } catch (err) {
        if (errName(err) === 'ResourceNotFoundException') continue; // free name: pass
        unchecked.push(`${secretId}: ${errMessage(err)}`);
      }
    }

    if (pending.length > 0) {
      const detail = pending
        .map((p) => `${p.id} is scheduled for deletion (DeletedDate ${p.deletedDate}) — the name is BLOCKED for the recovery window`)
        .join('\n');
      const remediation = [
        'Choose one option per blocked secret:',
        ...pending.map((p) => `  restore:      aws secretsmanager restore-secret --secret-id ${p.id}`),
        ...pending.map(
          (p) =>
            `  force-delete: aws secretsmanager delete-secret --secret-id ${p.id} --force-delete-without-recovery   (DESTRUCTIVE: the old secret value becomes unrecoverable)`,
        ),
        '  fresh names:  set a new CCE_NAME_SUFFIX in .env so this install uses non-colliding secret names',
      ].join('\n');
      return { id: this.id, title: this.title, status: 'fail', detail, remediation };
    }

    if (unchecked.length > 0) {
      return {
        id: this.id,
        title: this.title,
        status: 'warn',
        detail: `could not check:\n${unchecked.join('\n')}`,
      };
    }
    return {
      id: this.id,
      title: this.title,
      status: 'pass',
      detail:
        existing > 0
          ? `${existing} secret(s) under ${base}/ already exist (existing install); none pending deletion`
          : `no secrets under ${base}/ yet; all six names are free`,
    };
  },
};

// ─────────────────────────────────────────────────────────────────────
// 10. ci-coherence
// ─────────────────────────────────────────────────────────────────────

const ciCoherence: PreflightCheck = {
  id: 'ci-coherence',
  title: 'CI configuration coherence (OIDC / CodeBuild)',
  appliesTo: (ctx) => ctx.env.CCE_CICD_ENABLED === '1' || ctx.env.CCE_CODEBUILD_ENABLED === '1',
  async run(ctx) {
    const failures: string[] = [];
    const remediations: string[] = [];
    const warns: string[] = [];
    const notes: string[] = [];

    const owner = realValue(ctx.env, 'CCE_GITHUB_OWNER');
    const repo = realValue(ctx.env, 'CCE_GITHUB_REPO');

    if (ctx.env.CCE_CICD_ENABLED === '1') {
      const missing: string[] = [];
      if (!owner) missing.push('CCE_GITHUB_OWNER');
      if (!repo) missing.push('CCE_GITHUB_REPO');
      const refs = realValue(ctx.env, 'CCE_GITHUB_DEPLOY_REFS');
      const envs = realValue(ctx.env, 'CCE_GITHUB_DEPLOY_ENVIRONMENTS');
      if (!refs && !envs) missing.push('CCE_GITHUB_DEPLOY_REFS (or CCE_GITHUB_DEPLOY_ENVIRONMENTS)');
      if (missing.length > 0) {
        failures.push(`CCE_CICD_ENABLED=1 but missing: ${missing.join(', ')}`);
        remediations.push(
          'Set the missing CCE_GITHUB_* values in .env — synth fails closed without an explicit owner/repo + deploy ref so a fork can never inherit upstream deploy authority.',
        );
      }

      const providerArn = `arn:aws:iam::${accountOf(ctx)}:oidc-provider/token.actions.githubusercontent.com`;
      try {
        const out = (await ctx.clients.iam.send(
          new GetOpenIDConnectProviderCommand({ OpenIDConnectProviderArn: providerArn }),
        )) as { ClientIDList?: string[] };
        const audiences = out.ClientIDList ?? [];
        if (!audiences.includes('sts.amazonaws.com')) {
          failures.push(
            `GitHub OIDC provider exists but its audience list (ClientIDList) lacks sts.amazonaws.com (found: ${audiences.join(', ') || 'none'}) — shared-account provider audience validation`,
          );
          remediations.push(
            `aws iam add-client-id-to-open-id-connect-provider --open-id-connect-provider-arn ${providerArn} --client-id sts.amazonaws.com`,
          );
        } else {
          notes.push('GitHub OIDC provider present with sts.amazonaws.com audience');
        }
      } catch (err) {
        if (errName(err) === 'NoSuchEntityException' || errName(err) === 'NoSuchEntity') {
          warns.push('GitHub OIDC provider not found in this account');
          remediations.push('Create it: bash scripts/oidc-provider.sh');
        } else {
          warns.push(`could not check GitHub OIDC provider: ${errMessage(err)}`);
        }
      }
    }

    if (ctx.env.CCE_CODEBUILD_ENABLED === '1') {
      const missing: string[] = [];
      if (!owner) missing.push('CCE_GITHUB_OWNER');
      if (!repo) missing.push('CCE_GITHUB_REPO');
      if (missing.length > 0) {
        failures.push(`CCE_CODEBUILD_ENABLED=1 but missing: ${missing.join(', ')}`);
        remediations.push('Set the missing CCE_GITHUB_* values in .env.');
      }
      try {
        const out = (await ctx.clients.codeBuild.send({
          action: 'list-source-credentials',
          args: [],
        } satisfies CliCommand)) as { sourceCredentialsInfos?: Array<{ serverType?: string }> };
        const hasGithub = (out.sourceCredentialsInfos ?? []).some((c) => c.serverType === 'GITHUB');
        if (!hasGithub) {
          failures.push(
            'CCE_CODEBUILD_ENABLED=1 but no GITHUB source credential is imported in CodeBuild — tag-triggered builds cannot read the repo',
          );
          remediations.push(
            'aws codebuild import-source-credentials --server-type GITHUB --auth-type PERSONAL_ACCESS_TOKEN --token <github-pat>',
          );
        } else {
          notes.push('CodeBuild GITHUB source credential present');
        }
      } catch (err) {
        warns.push(`could not check CodeBuild source credentials: ${errMessage(err)}`);
      }
    }

    if (failures.length > 0) {
      return {
        id: this.id,
        title: this.title,
        status: 'fail',
        detail: [...failures, ...warns, ...notes].join('\n'),
        remediation: remediations.join('\n'),
      };
    }
    if (warns.length > 0) {
      return {
        id: this.id,
        title: this.title,
        status: 'warn',
        detail: [...warns, ...notes].join('\n'),
        remediation: remediations.length > 0 ? remediations.join('\n') : undefined,
      };
    }
    return { id: this.id, title: this.title, status: 'pass', detail: notes.join('\n') };
  },
};

// ─────────────────────────────────────────────────────────────────────
// 11. mode-readiness-inputs
// ─────────────────────────────────────────────────────────────────────

const modeReadinessInputs: PreflightCheck = {
  id: 'mode-readiness-inputs',
  title: 'Mode readiness inputs (.env values for the selected mode)',
  appliesTo: () => true,
  async run(ctx) {
    if (ctx.mode === 'chat') {
      const slack = realValue(ctx.env, 'SLACK_BOT_TOKEN');
      const telegram = realValue(ctx.env, 'TELEGRAM_TOKENS_JSON');
      if (!slack && !telegram) {
        return {
          id: this.id,
          title: this.title,
          status: 'fail',
          detail:
            'chat mode requires at least one surface token but SLACK_BOT_TOKEN and TELEGRAM_TOKENS_JSON are both missing or placeholder-shaped',
          remediation:
            'Set SLACK_BOT_TOKEN and/or TELEGRAM_TOKENS_JSON in .env (run `npm run setup`), or switch to CCE_DEPLOY_MODE=infra-only.',
        };
      }
      const surfaces = [slack ? 'Slack' : null, telegram ? 'Telegram' : null].filter(Boolean);
      return {
        id: this.id,
        title: this.title,
        status: 'pass',
        detail: `chat mode · surface token(s) present: ${surfaces.join(', ')}`,
      };
    }

    // infra-only
    const missing: string[] = [];
    if (!realValue(ctx.env, 'DASHBOARD_TOKEN')) missing.push('DASHBOARD_TOKEN');
    if (configuredClaudeModels(ctx).length === 0) {
      missing.push('a Bedrock model id (BEDROCK_DEFAULT/SONNET/HAIKU/OPUS_MODEL)');
    }
    if (missing.length > 0) {
      return {
        id: this.id,
        title: this.title,
        status: 'fail',
        detail: `infra-only mode requires dashboard auth + a model, missing: ${missing.join(', ')}`,
        remediation: 'Run `npm run setup` or set the missing values in .env (placeholder values like REPLACE_ME do not count).',
      };
    }
    return {
      id: this.id,
      title: this.title,
      status: 'pass',
      detail: 'infra-only mode · dashboard token + Bedrock model configured',
    };
  },
};

// ─────────────────────────────────────────────────────────────────────
// 12. config-epoch (IaC readiness item 45 — post-handover authority)
// ─────────────────────────────────────────────────────────────────────

/**
 * After a handover, the AUTHORITATIVE config source is the AWS side
 * (Secrets Manager + manifest + the stamped epoch), and that is enforced
 * here, not assumed: handover writes state/config-epoch.json and the new
 * operator's .env carries CCE_CONFIG_EPOCH. A mismatch means THIS .env
 * predates the recorded handover — typically the DEPARTING operator's
 * stale file — and deploying with it would silently re-point owner IDs
 * and secrets. That is a FAIL, the one mutation-blocking check in this
 * file that exists to protect a completed transfer.
 */
const configEpoch: PreflightCheck = {
  id: 'config-epoch',
  title: 'Config epoch (local .env vs recorded handover state)',
  appliesTo: () => true,
  async run(ctx) {
    const bucket = stateBucketName(ctx);
    let body: string;
    try {
      const res = (await ctx.clients.s3.send(
        new GetObjectCommand({ Bucket: bucket, Key: CONFIG_EPOCH_KEY }),
      )) as { Body?: unknown };
      body = await s3BodyToString(res.Body);
    } catch (err) {
      const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
      const status = e.$metadata?.httpStatusCode;
      if (
        e.name === 'NoSuchKey' ||
        e.name === 'NotFound' ||
        e.name === 'NoSuchBucket' ||
        status === 404
      ) {
        return {
          id: this.id,
          title: this.title,
          status: 'pass',
          detail: `no config epoch recorded at s3://${bucket}/${CONFIG_EPOCH_KEY} — no handover has completed for this install`,
        };
      }
      return {
        id: this.id,
        title: this.title,
        status: 'warn',
        detail: `could not read s3://${bucket}/${CONFIG_EPOCH_KEY}: ${errMessage(err)}`,
        remediation:
          'Verify S3 read access to the state bucket; if a handover ever completed here, do not deploy until this check can compare epochs.',
      };
    }

    let epoch: number;
    let completedAt = 'unknown';
    try {
      const parsed = JSON.parse(body) as { epoch?: unknown; completedAt?: unknown };
      if (typeof parsed.epoch !== 'number' || !Number.isInteger(parsed.epoch)) {
        throw new Error('no integer "epoch" field');
      }
      epoch = parsed.epoch;
      if (typeof parsed.completedAt === 'string') completedAt = parsed.completedAt;
    } catch (err) {
      return {
        id: this.id,
        title: this.title,
        status: 'warn',
        detail: `s3://${bucket}/${CONFIG_EPOCH_KEY} is malformed (${errMessage(err)}) — cannot compare epochs`,
        remediation: 'Inspect the object; it should be {"epoch": n, "completedAt": ..., "newOwnerLabelHash": ...} written by npm run handover.',
      };
    }

    const localRaw = realValue(ctx.env, 'CCE_CONFIG_EPOCH');
    const local = localRaw === '' ? null : Number(localRaw);
    if (local === null || local !== epoch) {
      return {
        id: this.id,
        title: this.title,
        status: 'fail',
        detail:
          `the state bucket records config epoch ${epoch} (handover completed ${completedAt}) but this ` +
          `.env has CCE_CONFIG_EPOCH=${localRaw || '(unset)'} — this local config PREDATES the recorded ` +
          'handover. Deploying with it would silently re-point owner IDs and secrets back to the departing operator.',
        remediation:
          'Re-run `npm run setup` against the recorded handover state (the incoming operator\'s values), ' +
          `which writes CCE_CONFIG_EPOCH=${epoch} into .env. A departing operator's stale .env must never deploy again.`,
      };
    }
    return {
      id: this.id,
      title: this.title,
      status: 'pass',
      detail: `local CCE_CONFIG_EPOCH=${epoch} matches the recorded handover state (completed ${completedAt})`,
    };
  },
};

// ─────────────────────────────────────────────────────────────────────
// 13. update-available (IaC readiness item 46 — informational only)
// ─────────────────────────────────────────────────────────────────────

/**
 * INFORMATIONAL: discovery is read-only and fail-silent, so this check
 * is 'pass' (verified result) or 'skip' (disabled / unverified /
 * unreachable) — NEVER warn or fail. Doctor must not go red because
 * GitHub is unreachable or because signed release metadata doesn't exist
 * yet. The pass line is the plan's "v1.4.0 available, you run v1.2.1;
 * N required actions" rendering.
 */
const updateAvailable: PreflightCheck = {
  id: 'update-available',
  title: 'Update available (GitHub releases, informational)',
  appliesTo: () => true,
  async run(ctx) {
    if (ctx.env.CCE_UPDATE_CHECK_DISABLED === '1') {
      return {
        id: this.id,
        title: this.title,
        status: 'skip',
        detail:
          'update check disabled (CCE_UPDATE_CHECK_DISABLED=1) — no request leaves this machine; ' +
          'you lose only this line and the dashboard banner',
      };
    }
    let result: UpdateCheckResult;
    try {
      const discover = ctx.updateDiscovery ?? ((env: Record<string, string>) => checkForUpdates(env));
      result = await discover(ctx.env);
    } catch (err) {
      // Discovery is fail-silent by contract; a throw here is a bug in the
      // injected hook, and even then this check stays informational.
      return {
        id: this.id,
        title: this.title,
        status: 'skip',
        detail: `update check unavailable (${errMessage(err)})`,
      };
    }
    if (result.reason === 'disabled') {
      return { id: this.id, title: this.title, status: 'skip', detail: 'update check disabled' };
    }
    if (result.reason === 'unreachable') {
      return {
        id: this.id,
        title: this.title,
        status: 'skip',
        detail: 'update check unavailable (releases feed unreachable; cached/backoff) — deploys are unaffected',
      };
    }
    if (!result.verified) {
      return {
        id: this.id,
        title: this.title,
        status: 'skip',
        detail:
          `update check unverified — ${result.latestTag ?? 'a release'} is published but its release ` +
          'metadata could not be verified against trust roots, so its claims are not displayed',
      };
    }
    if (!result.available) {
      return {
        id: this.id,
        title: this.title,
        status: 'pass',
        detail: `up to date (you run ${result.currentVersion})`,
      };
    }
    const n = result.requiredActionsCount ?? 0;
    return {
      id: this.id,
      title: this.title,
      status: 'pass',
      detail:
        `${result.latestTag} available, you run ${result.currentVersion}; ` +
        `${n} required action${n === 1 ? '' : 's'} — update with \`npm run update\` when ready`,
    };
  },
};

// ─────────────────────────────────────────────────────────────────────
// 14. cost-anomaly-monitor (issue #49 — one SERVICE monitor per account)
// ─────────────────────────────────────────────────────────────────────

/**
 * AWS allows exactly ONE DIMENSIONAL/SERVICE Cost Anomaly monitor per
 * account, and auto-creates "Default-Services-Monitor" the first time
 * anomaly detection is enabled. The CostGuardrails stack's default create
 * therefore collides on most non-fresh accounts. The deploy resolves this
 * before synth (attach-vs-create); this check surfaces what it will decide,
 * and warns when the discovery call itself is not permitted.
 */
const costAnomalyMonitor: PreflightCheck = {
  id: 'cost-anomaly-monitor',
  title: 'Cost Anomaly monitor (attach to existing vs create)',
  appliesTo: () => true,
  async run(ctx) {
    const pinned = realValue(ctx.env, 'CCE_ANOMALY_MONITOR_ARN');
    if (pinned) {
      return {
        id: this.id,
        title: this.title,
        status: 'pass',
        detail: `CCE_ANOMALY_MONITOR_ARN is set; the anomaly subscription will attach to ${pinned}`,
      };
    }
    try {
      const existing = await findServiceAnomalyMonitor(ctx.clients.costExplorer);
      if (existing) {
        return {
          id: this.id,
          title: this.title,
          status: 'pass',
          detail:
            `existing DIMENSIONAL/SERVICE monitor found ("${existing.name}"); ` +
            'deploy will attach the anomaly subscription to it instead of creating a colliding monitor',
        };
      }
      return {
        id: this.id,
        title: this.title,
        status: 'pass',
        detail: 'no existing service anomaly monitor; the CostGuardrails stack will create one',
      };
    } catch (err) {
      return {
        id: this.id,
        title: this.title,
        status: 'warn',
        detail: `cannot list Cost Anomaly monitors (${errName(err)}: ${errMessage(err)})`,
        remediation:
          'AWS allows one DIMENSIONAL/SERVICE anomaly monitor per account; if this account already has one ' +
          '(usually the auto-created "Default-Services-Monitor"), the CostGuardrails create will fail with ' +
          'AlreadyExists. Grant ce:GetAnomalyMonitors so the deploy can discover and attach to it, or set ' +
          'CCE_ANOMALY_MONITOR_ARN in .env explicitly (aws ce get-anomaly-monitors prints the ARN).',
      };
    }
  },
};

// ─────────────────────────────────────────────────────────────────────
// 15. magic-link-email (issue #51 — inert email sign-in on fresh deploys)
// ─────────────────────────────────────────────────────────────────────

/**
 * The dashboard login screen offers "email me a sign-in link", but sends
 * fail-soft (skippedReason 'unconfigured') until CCE_EMAIL_FROM and
 * CCE_DASHBOARD_URL reach the task env, and even then only invited ACTIVE
 * users receive links. On a fresh deploy the users table is empty and the
 * env vars are unset, so the login box looks broken while working exactly
 * as designed. This check makes that state expected: warn (never fail),
 * naming DASHBOARD_TOKEN as the initial way in.
 */
const magicLinkEmail: PreflightCheck = {
  id: 'magic-link-email',
  title: 'Dashboard email sign-in (magic links)',
  appliesTo: () => true,
  async run(ctx) {
    const from = realValue(ctx.env, 'CCE_EMAIL_FROM');
    const url = realValue(ctx.env, 'CCE_DASHBOARD_URL');
    const missing: string[] = [];
    if (!from) missing.push('CCE_EMAIL_FROM');
    if (!url) missing.push('CCE_DASHBOARD_URL');
    if (missing.length > 0) {
      return {
        id: this.id,
        title: this.title,
        status: 'warn',
        detail:
          `magic-link email sign-in will be silently inert (sends skip as "unconfigured"), missing: ` +
          `${missing.join(', ')}. Expected on a first deploy; sign in with the bearer DASHBOARD_TOKEN.`,
        remediation:
          'The dashboard token is the initial sign-in path; email login is optional. To enable it, set ' +
          'CCE_EMAIL_FROM to an SES-verified identity and CCE_DASHBOARD_URL to the dashboard URL in .env, ' +
          'verify the identity in SES (plus production access to email arbitrary recipients), redeploy, ' +
          'then invite users from the dashboard. Users come from invites, not self-signup.',
      };
    }
    return {
      id: this.id,
      title: this.title,
      status: 'pass',
      detail:
        `email sign-in configured (from ${from}); links still require the SES identity to be verified ` +
        'and the recipient to be an invited ACTIVE user',
    };
  },
};

// ─────────────────────────────────────────────────────────────────────
// Registry + runner
// ─────────────────────────────────────────────────────────────────────

export const allChecks: PreflightCheck[] = [
  awsIdentity, // first: fills ctx.resolvedAccount for later remediation strings
  cdkBootstrap,
  regionCapability,
  bedrockGrantClaude,
  bedrockGrantTitanEmbed,
  bedrockGrantImage,
  bedrockGrantNovaSonic,
  serviceQuotas,
  costAnomalyMonitor,
  nameCollisions,
  domainTls,
  tunnelPrereq,
  secretsPendingDeletion,
  ciCoherence,
  modeReadinessInputs,
  magicLinkEmail,
  configEpoch,
  updateAvailable,
];

export function checkById(id: string): PreflightCheck {
  const check = allChecks.find((c) => c.id === id);
  if (!check) throw new Error(`unknown preflight check: ${id}`);
  return check;
}

export async function runPreflight(
  ctx: PreflightContext,
  checks: PreflightCheck[] = allChecks,
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
    try {
      results.push(await check.run(ctx));
    } catch (err) {
      // A crashing check must never abort the rest of the preflight.
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

export interface PreflightSummary {
  pass: number;
  warn: number;
  fail: number;
  skip: number;
}

export function summarize(results: CheckResult[]): PreflightSummary {
  const summary: PreflightSummary = { pass: 0, warn: 0, fail: 0, skip: 0 };
  for (const r of results) summary[r.status] += 1;
  return summary;
}
