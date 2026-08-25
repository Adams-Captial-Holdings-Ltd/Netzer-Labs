/**
 * Shared constants used across all CDK stacks.
 * Resource names, tag values, magic strings.
 */

const APP_BASE = 'claudeclaw';
export const APP_LONG = 'claudeclaw-enterprise';

/**
 * `CCE_NAME_SUFFIX` lets us deploy a second copy of every named resource
 * alongside prod inside the same AWS account. Defaults to empty (= prod).
 * Staging passes `staging`, which becomes `claudeclaw-staging-*` across
 * every DDB table, bucket, cluster, secret path, etc. Set BEFORE the CDK
 * app loads — `infra/bin/app.ts` reads it as the very first thing it does.
 */
export const APP_NAME_SUFFIX = process.env.CCE_NAME_SUFFIX ?? '';

/**
 * Helper: build the app slug from a suffix. Empty suffix yields the
 * prod-default `claudeclaw`; any non-empty value produces
 * `claudeclaw-<suffix>`. Exported for tests; production callers use `APP`.
 */
export function buildApp(suffix: string = APP_NAME_SUFFIX): string {
  return suffix ? `${APP_BASE}-${suffix}` : APP_BASE;
}

export const APP = buildApp();

export const TAGS = {
  Application: APP_LONG,
  ManagedBy: 'cdk',
} as const;

// Re-export the literal string so other files can reference it without a
// new import; the storage stack uses this in bucket-name construction.
export { APP as app };

/**
 * Port the Paperclip work engine listens on. Never 3000 — it is deliberately
 * distinct from the orchestrator's port so the two are separable in flow logs,
 * metrics and SG audits. Lives here rather than in paperclip-stack.ts because
 * three files have to agree on it: network-stack's SG rules, paperclip-stack's
 * container/target-group/health-check, and the internal URL below that
 * compute-stack hands the orchestrator.
 */
export const PAPERCLIP_PORT = 3100;

/**
 * Per-suffix resource-name shape. `buildResourceNames(suffix)` produces a
 * struct of deterministic names rooted at `claudeclaw[-suffix]`. The
 * default `RESOURCE_NAMES` below is what every stack actually uses; this
 * builder exists so tests can verify the staging shape without mutating
 * process.env.
 */
export function buildResourceNames(suffix: string = APP_NAME_SUFFIX) {
  const app = buildApp(suffix);
  return {
    // ECR
    ecrRepo: `${app}-orchestrator`,
    // Paperclip work engine (ADR 0010). Second repo so the pinned+patched
    // Paperclip image never shares a tag namespace with the orchestrator.
    paperclipEcrRepo: `${app}-paperclip`,

    // S3 buckets (suffixed with account+region at provision time for global uniqueness)
    configBucket: `${app}-config`,
    rawBucket: `${app}-raw`,
    curatedBucket: `${app}-curated`,
    vectorsStagingBucket: `${app}-vectors-staging`,
    logsBucket: `${app}-logs`,
    auditLockBucket: `${app}-audit-lock`,

    // KMS key aliases
    dataKeyAlias: `alias/${app}-data`,
    curatedKeyAlias: `alias/${app}-curated`,
    logsKeyAlias: `alias/${app}-logs`,

    // DynamoDB tables
    ddb: {
      sessions: `${app}-sessions`,
      hiveMind: `${app}-hive-mind`,
      auditLog: `${app}-audit-log`,
      chatConfig: `${app}-chat-config`,
      tokenUsage: `${app}-token-usage`,
      memories: `${app}-memories`,
      consolidations: `${app}-consolidations`,
      agentFileHistory: `${app}-agent-file-history`,
      missionTasks: `${app}-mission-tasks`,
      scheduledTasks: `${app}-scheduled-tasks`,
      killSwitches: `${app}-kill-switches`,
      interAgentTasks: `${app}-inter-agent-tasks`,
      compactionEvents: `${app}-compaction-events`,
      queueLease: `${app}-queue-lease`,
      // C4: cross-surface identity mapping.
      identities: `${app}-identities`,
      // v5.6: hook idempotency + consolidation spawn ledger + extensions
      hookIdempotency: `${app}-hook-idempotency`,
      spawnLedger: `${app}-spawn-ledger`,
      // C2-full: atomic daily Bedrock spend ledger (reserve-before-spend).
      spendLedger: `${app}-spend-ledger`,
      extensionSubnetPool: `${app}-extension-subnet-pool`,
      extensionsRegistry: `${app}-extensions-registry`,
      // v5.6: war room
      warroomMeetings: `${app}-warroom-meetings`,
      warroomTurns: `${app}-warroom-turns`,
      warroomConnections: `${app}-warroom-connections`,
      // v5.6: rate limits
      rateLimits: `${app}-rate-limits`,
      agents: `${app}-agents`,
      dashboardTokens: `${app}-dashboard-tokens`,
      runtimeConfig: `${app}-runtime-config`,
      // Multi-user + RBAC (Wave 4a). Single-table design: user profiles AND
      // magic-link tokens live here (no separate invitations table). GSI1 is
      // the email→user lookup for passwordless login.
      users: `${app}-users`,
      // Jarvis voice co-pilot (Phase 1) — single-use WS tickets, transactional
      // concurrency leases, the strongly-consistent spend ledger, and the
      // canary allowlist (Reference Contracts B / D).
      jarvisTickets: `${app}-jarvis-tickets`,
      jarvisLeases: `${app}-jarvis-leases`,
      jarvisLedger: `${app}-jarvis-ledger`,
      jarvisCanary: `${app}-jarvis-canary`,
    },

    // ECS / compute
    ecsCluster: `${app}-cluster`,
    fargateService: `${app}-service`,
    taskFamily: `${app}-orchestrator`,

    // ALB
    alb: `${app}-alb`,
    targetGroup: `${app}-tg`,

    // Secrets Manager paths
    secrets: {
      slack: `/${app}/slack`,
      telegram: `/${app}/telegram`,
      dashboard: `/${app}/dashboard`,
      dbEncryption: `/${app}/db-encryption`,
      bedrockGuardrails: `/${app}/bedrock-guardrails`,
      // Optional vendor API keys (search/Gemini). Kept in Secrets Manager,
      // never in plain task-def env, so synth artifacts contain no keys.
      vendorKeys: `/${app}/vendor-keys`,
      // Cloudflare Tunnel connector token for opt-in private WARP access.
      // Written ONLY by `npm run warp:setup` (never by populate-secrets, never
      // from .env) and read only by the cloudflared sidecar via
      // EcsSecret.fromSecretsManager. Retained on stack removal so a redeploy
      // never has to re-authorize the tunnel.
      cloudflareTunnel: `/${app}/cloudflare-tunnel`,
      // Paperclip work engine (ADR 0010): operator-populated fields
      // (better_auth_secret, reconciler_key, agent_keys, dispatch_secret).
      // The Aurora-generated DB credentials live in their own secret below.
      paperclip: `/${app}/paperclip`,
      paperclipDb: `/${app}/paperclip-db`,
    },

    // Bedrock guardrail
    guardrail: `${app}-default`,

    // CloudWatch
    logGroupOrchestrator: `/${app}/orchestrator`,
    logGroupAlb: `/${app}/alb-access`,
    paperclipLogGroup: `/${app}/paperclip`,

    // Paperclip work engine (ADR 0010): Aurora cluster identifier + EFS
    // name tag. Suffix-aware so CCE_NAME_SUFFIX staging keeps working.
    paperclipDbCluster: `${app}-paperclip-db`,
    paperclipEfs: `${app}-paperclip-efs`,

    // Paperclip service discovery (Cloud Map). Without these the orchestrator
    // has no address for the engine at all: the ONLY route into Paperclip was
    // an ALB listener rule that is emitted only when DOMAIN_NAME is set, which
    // both real environments deliberately leave empty — so a standard install
    // provisioned a service nothing could reach.
    //
    // Deterministic and derived from `app`, exactly like every other name in
    // this file, for the reason stated on RESOURCE_NAMES: the orchestrator's
    // task definition is written by CCE-Compute, which is created BEFORE
    // CCE-Paperclip (Paperclip imports Compute's cluster and listener), so a
    // real cross-stack reference to the discovery record would be a cycle. A
    // name both sides compute from the same constant is not.
    //
    // COLLISION: a private DNS namespace is a Route 53 private hosted zone
    // associated with ONE VPC — the one NetworkStack creates in this same app
    // — and this repo creates no other namespace anywhere (grep
    // `PrivateDnsNamespace`). The name is app-suffixed, so prod
    // (`claudeclaw.internal`) and staging (`claudeclaw-staging.internal`) are
    // distinct even in one account. An out-of-band namespace already attached
    // to this VPC under the same name would fail the CREATE loudly, which is
    // the right direction.
    paperclipNamespace: `${app}.internal`,
    paperclipDiscoveryName: 'paperclip',
    /** What compute-stack sets as PAPERCLIP_BASE_URL on the orchestrator. */
    paperclipInternalUrl: `http://paperclip.${app}.internal:${PAPERCLIP_PORT}`,
    alertTopic: `${app}-ops-alerts`,
    cloudTrailName: `${app}-audit`,

    // SNS / SQS for config invalidation
    configInvalidationTopic: `${app}-config-invalidation`,
    configInvalidationQueuePrefix: `${app}-config-invalidation-task-`,
    ingestQueue: `${app}-ingest`,

    // A1: SQS queue EventBridge Scheduler fires into for each due task.
    // Drained in-process by the orchestrator; per-task one-shot schedule
    // pattern (see src/lib/scheduler/eb-scheduler.ts).
    scheduledFireQueue: `${app}-scheduled-fire`,
    schedulerExecutionRole: `${app}-scheduler-exec`,
    schedulerGroupName: app,

    // v5.6: extensions
    extensionsBucket: `${app}-extensions`,
    extensionsSignerProfile: `${app}-ext-signer`,

    // v5.6: SQS DLQs + work queues
    hookDlq: `${app}-hook-dlq`,
    consolidationDlq: `${app}-consolidation-dlq`,
    consolidationWorkQueue: `${app}-consolidation-work`,

    // v5.6: war room
    warroomFanoutTopic: `${app}-warroom-fanout`,
  } as const;
}

/**
 * Deterministic resource names for this CDK process. The suffix is fixed
 * at module-load time from `CCE_NAME_SUFFIX`; production deploys leave it
 * empty, staging deploys set it to `staging`. We avoid CDK auto-generated
 * hashes so the orchestrator can be configured via env vars without
 * circular dependency on CDK outputs.
 */
export const RESOURCE_NAMES = buildResourceNames();

/**
 * Bedrock model IDs. These are cross-region inference profile IDs which
 * include the `us.` or `eu.` prefix. Actual current IDs resolve at deploy
 * time via `aws bedrock list-inference-profiles`. These defaults are the
 * expected shape, not a guarantee.
 */
export const BEDROCK_MODELS = {
  opus: 'us.anthropic.claude-opus-4-7',
  opus1m: 'us.anthropic.claude-opus-4-7-1m',
  sonnet: 'us.anthropic.claude-sonnet-4-6',
  sonnet1m: 'us.anthropic.claude-sonnet-4-6-1m',
  haiku: 'us.anthropic.claude-haiku-4-5',
  embedTitanV2: 'amazon.titan-embed-text-v2:0',
} as const;

export type DeployTier = 0 | 1 | 2 | 3;

/**
 * Coerce a raw tier env string to a valid DeployTier, defaulting to 1.
 *
 * THE ONE PARSER. `infra/bin/app.ts` and `scripts/lib/cost-gate.ts` both call
 * this, because since Phase 9 the tier decides whether the Paperclip substrate
 * EXISTS — a bare `Number(process.env.CCE_TIER ?? '1')` in app.ts read a blank
 * tier as `Number('') === 0`, i.e. Hobby, i.e. an EMPTY Aurora stack, while the
 * deploy driver's clampTier read the same blank value as Standard. Two parsers
 * that disagree about `''` is two answers to "does this install have a
 * database".
 */
export function clampTier(raw: string | undefined): DeployTier {
  const trimmed = (raw ?? '').trim();
  // Guard the empty string explicitly: Number('') is 0, which is a VALID
  // tier, and an unset tier must mean the tier-1 default, not Hobby.
  if (trimmed === '') return 1;
  const n = Number(trimmed);
  return (n === 0 || n === 1 || n === 2 || n === 3 ? n : 1) as DeployTier;
}

/**
 * Per-tier resource shape. The setup wizard writes the chosen tier into
 * `DEPLOY_TIER` in the project .env; CDK reads it via `app.ts`.
 *
 * T0 Hobby      — single Fargate, single NAT, 7-day logs, no WAF/CloudFront/X-Ray/Flow Logs
 * T1 Standard   — current production shape: 2x HA, 30-day logs, Flow Logs ON
 * T2 Pro        — autoscale, 90-day logs, WAF, X-Ray
 * T3 Enterprise — T2 + CloudFront, daily DDB export, AWS Config (when D4 lands)
 */
export interface TierShape {
  /** Marketing label. */
  label: string;
  fargateCpu: number;
  fargateMemoryMb: number;
  fargateMinTasks: number;
  fargateMaxTasks: number;
  albIdleTimeoutSec: number;
  natGatewayCount: 1 | 2;
  configCacheTtlSec: number;
  logRetentionDays: 7 | 30 | 90 | 365;
  /**
   * Aurora Serverless v2 ceiling for the Paperclip cluster (ADR 0010).
   * Only the CEILING is tiered. The floor stays 0.5 on every tier because
   * min ACU is what bills continuously, and lowering it further means
   * scale-to-zero, which is a runtime behaviour change, not a size knob.
   */
  paperclipAuroraMaxAcu: number;
  /**
   * Whether the Paperclip work engine (ADR 0010) is PROVISIONED at this tier.
   *
   * The Database, Filesystem and Paperclip stacks are always CONSTRUCTED —
   * `npx cdk ls` prints the same stack names at every tier and in every value
   * of CCE_PAPERCLIP_ENABLED — and this flag decides whether they create any
   * resources, the same shape SecurityStack (WAF at T2+) and BackupStack (T1+)
   * already use.
   *
   * T0 Hobby is OUT because the Aurora floor is not tiered: only the ceiling
   * above is, and database-stack.ts holds `serverlessV2MinCapacity` at 0.5 on
   * every tier because min ACU bills continuously. Provisioning at T0 would put
   * roughly $110/mo of always-on cost (~$50 Aurora floor + EFS, ~$58 for the
   * always-on 2 vCPU / 4 GB Fargate task) on a Hobby install, for a RETAIN'd,
   * deletion-protected cluster its owner cannot casually tear down.
   */
  paperclipEnabled: boolean;
  wafEnabled: boolean;
  cloudFrontEnabled: boolean;
  flowLogsEnabled: boolean;
  xrayEnabled: boolean;
  dailyCostCapDefaultUsd: number;
}

export const TIERS: Record<DeployTier, TierShape> = {
  0: {
    label: 'Hobby',
    fargateCpu: 512,
    fargateMemoryMb: 1024,
    fargateMinTasks: 1,
    fargateMaxTasks: 1,
    albIdleTimeoutSec: 4000,
    natGatewayCount: 1,
    configCacheTtlSec: 300,
    logRetentionDays: 7,
    paperclipAuroraMaxAcu: 1,
    paperclipEnabled: false,
    wafEnabled: false,
    cloudFrontEnabled: false,
    flowLogsEnabled: false,
    xrayEnabled: false,
    dailyCostCapDefaultUsd: 5,
  },
  1: {
    label: 'Standard',
    fargateCpu: 1024,
    fargateMemoryMb: 2048,
    fargateMinTasks: 2,
    fargateMaxTasks: 4,
    albIdleTimeoutSec: 4000,
    natGatewayCount: 2,
    configCacheTtlSec: 300,
    logRetentionDays: 30,
    paperclipAuroraMaxAcu: 2,
    paperclipEnabled: true,
    wafEnabled: false,
    cloudFrontEnabled: false,
    flowLogsEnabled: true,
    xrayEnabled: false,
    dailyCostCapDefaultUsd: 50,
  },
  2: {
    label: 'Pro',
    fargateCpu: 2048,
    fargateMemoryMb: 4096,
    fargateMinTasks: 2,
    fargateMaxTasks: 10,
    albIdleTimeoutSec: 4000,
    // Capped at 2 because the VPC ships with 2 AZs and CDK can't add a
    // 3rd AZ in-place (CIDR re-layout collision). Tripling NAT count
    // would also need 3 AZs; we keep 2/2 here for compatibility and
    // document the trade-off in CloudWatch dashboards.
    natGatewayCount: 2,
    configCacheTtlSec: 300,
    logRetentionDays: 90,
    paperclipAuroraMaxAcu: 4,
    paperclipEnabled: true,
    wafEnabled: true,
    cloudFrontEnabled: false,
    flowLogsEnabled: true,
    xrayEnabled: true,
    dailyCostCapDefaultUsd: 200,
  },
  3: {
    label: 'Enterprise',
    fargateCpu: 2048,
    fargateMemoryMb: 4096,
    fargateMinTasks: 3,
    fargateMaxTasks: 20,
    albIdleTimeoutSec: 4000,
    natGatewayCount: 2,
    configCacheTtlSec: 300,
    logRetentionDays: 365,
    paperclipAuroraMaxAcu: 8,
    paperclipEnabled: true,
    wafEnabled: true,
    cloudFrontEnabled: true,
    flowLogsEnabled: true,
    xrayEnabled: true,
    dailyCostCapDefaultUsd: 1000,
  },
};

/**
 * Does THIS DEPLOYMENT provision the Paperclip work engine substrate?
 *
 * THE ONE PREDICATE, for the same reason clampTier above is the one parser:
 * infra/bin/app.ts, the three substrate stacks, cost-guardrails-stack.ts, the
 * deploy gate copy, scripts/ci/tier-gate.ts and scripts/deploy.ts must all give
 * the same answer or CI builds an image for an engine CDK does not create.
 *
 * Two inputs, answering two DIFFERENT questions:
 *
 *   TIERS[tier].paperclipEnabled  — "how big is this customer". Tier 0 Hobby
 *     is out because the Aurora floor is not tiered (~$110/mo of always-on
 *     cost); Tier 1+ is in.
 *   CCE_PAPERCLIP_PROVISION_ENV_OVERRIDE — "provision the substrate in THIS
 *     ENVIRONMENT even though its tier would not".
 *
 * The override is ENVIRONMENT-SCOPED and it is ONE-DIRECTIONAL. It is set per
 * environment by a deploy driver — `.github/workflows/deploy.yml` sets it on
 * the staging branch of its CCE_TIER expression and NOWHERE else, so staging
 * stays pinned at Tier 0 (nothing else scales up) while still growing the
 * substrate the engine is validated on, and PRODUCTION is not the first
 * environment ever to run it. There is no value of it that EMPTIES a substrate
 * a tier provisions: that is what makes it a provisioning override and not a
 * resurrection of CCE_PAPERCLIP_ENABLED, the general-purpose feature gate
 * Phase 9 deleted, whose OFF value is what made a green deploy with no Aurora
 * behind it possible (M22).
 *
 * A genuine Tier 0 Hobby customer who sets nothing is unaffected: no Aurora,
 * no EFS, no Paperclip task, and still protected by the teardown guard in
 * infra/bin/app.ts, which refuses to synthesize an EMPTY substrate over a
 * provisioned one unless CCE_PAPERCLIP_TEARDOWN=1 declares it.
 */
export function paperclipProvisioned(
  tier: DeployTier,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return (
    TIERS[tier].paperclipEnabled || env.CCE_PAPERCLIP_PROVISION_ENV_OVERRIDE === '1'
  );
}

/** @deprecated use TIERS[tier]. Kept for back-compat with callers that
 * referenced the old flat object. */
export const TIER_DEFAULTS = TIERS[1];

/**
 * Helper to construct a globally unique bucket name from a logical prefix.
 * Buckets are global; using accountId+region makes the name deterministic
 * and avoids cross-account collisions.
 */
export function bucketName(prefix: string, account: string, region: string): string {
  return `${prefix}-${account}-${region}`;
}

// Convenience re-export for storage-stack's audit lock bucket naming.
// Always equals `APP` (= `claudeclaw[-suffix]`).
export const APP_PREFIX = APP;
