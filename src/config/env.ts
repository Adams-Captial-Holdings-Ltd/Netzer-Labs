/**
 * Environment loading and validation.
 *
 * The orchestrator reads non-secret config from environment variables set
 * by the ECS task definition. Secrets (Slack signing, Telegram tokens,
 * dashboard token, guardrail ID) are also injected as env vars by the
 * task definition via Secrets Manager value resolution.
 *
 * Validation is zod-based. Required vars throw at startup if missing in
 * production. In dev mode (`NODE_ENV !== 'production'`), we permit missing
 * AWS-dependent vars so `/health` works without deployed infra.
 */

import { z } from 'zod';

/**
 * Optional string that treats Secrets Manager's unpopulated REPLACE_ME
 * placeholder (and empty string) as "not configured". Used for the
 * optional vendor keys injected from the vendor-keys secret: an
 * operator who never populates the secret must get the same behavior
 * as one who never created the key at all.
 */
function optionalNonPlaceholder(): z.ZodEffects<
  z.ZodOptional<z.ZodString>,
  string | undefined,
  string | undefined
> {
  return z
    .string()
    .optional()
    .transform((v) => (!v || v === 'REPLACE_ME' ? undefined : v));
}

const envSchema = z.object({
  // ── Runtime ─────────────────────────────────────────────────────
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // ── AWS context ─────────────────────────────────────────────────
  AWS_REGION: z.string().default('us-east-1'),
  AWS_ACCOUNT_ID: z.string().optional(),

  // ── Bedrock model IDs (cross-region inference profiles) ─────────
  BEDROCK_DEFAULT_MODEL: z.string().optional(),
  BEDROCK_OPUS_MODEL: z.string().optional(),
  BEDROCK_SONNET_MODEL: z.string().optional(),
  BEDROCK_HAIKU_MODEL: z.string().optional(),
  BEDROCK_EMBED_MODEL: z.string().default('amazon.titan-embed-text-v2:0'),
  BEDROCK_GUARDRAIL_ID: z.string().optional(),
  BEDROCK_GUARDRAIL_VERSION: z.string().default('DRAFT'),

  // ── Buckets and tables (populated by CDK outputs after deploy) ──
  CONFIG_BUCKET: z.string().optional(),
  RAW_BUCKET: z.string().optional(),
  CURATED_BUCKET: z.string().optional(),
  VECTORS_STAGING_BUCKET: z.string().optional(),
  /**
   * Durable vector index (`index/<scope>/<docId>.jsonl`). A DIFFERENT bucket
   * from VECTORS_STAGING_BUCKET: staging carries a 7-day expiry and this one
   * must never carry any expiry. They were the same bucket until 2026-08,
   * which cost the production knowledge base.
   */
  VECTORS_BUCKET: z.string().optional(),
  AUDIT_LOCK_BUCKET: z.string().optional(),

  // ── Cost cap + feature flags ────────────────────────────────────
  CCE_DAILY_COST_CAP_USD: z.string().optional(),
  // Onboarding I3 (atomic reserve-settle spend ledger, src/lib/cost/*). OFF by
  // default so existing behavior is unchanged until the ledger table + the
  // key-separated KMS MAC key are deployed and validated against a live account.
  CCE_LEDGER_ENABLED: z.string().optional(),
  TABLE_SPEND_LEDGER: z.string().optional(),
  // The separated KMS HMAC key for ledger integrity (I3 key separation). Read
  // only by the auditor principal, NEVER injected into the task env.
  CCE_LEDGER_MAC_KEY_ARN: z.string().optional(),
  // Onboarding I6 (TTL tripwire, infra/lib/tripwire-stack.ts). The grace window
  // in hours before an unverified install auto-destroys, and the install id the
  // tripwire stack is armed for (set by bootstrap; gates the standalone synth).
  CCE_TRIPWIRE_TTL_HOURS: z.string().optional(),
  CCE_TRIPWIRE_INSTALL_ID: z.string().optional(),
  CCE_SCHEDULER_TICK_SEC: z.string().optional(),
  CCE_SCHEDULER_DISABLED: z.string().optional(),
  CCE_TRANSCRIBE_DISABLED: z.string().optional(),
  CCE_PROMPT_CACHE: z.string().optional(),
  CCE_SHOW_FOOTER: z.string().optional(),
  CCE_TIER: z.string().optional(),
  CCE_TIER_LABEL: z.string().optional(),
  CCE_XRAY_ENABLED: z.string().optional(),
  // ── Deployment mode (IaC readiness item 11) ─────────────────────
  // `chat` (default): webhook surfaces are first-class; readiness needs
  // a real surface token. `infra-only`: dashboard-only install — no
  // chat surface required, readiness is model + dashboard auth.
  CCE_DEPLOY_MODE: z.enum(['chat', 'infra-only']).optional(),
  // Knowledge ingestion / embeddings feature flag (Titan grant only
  // probed when enabled). Default on; '0' disables.
  CCE_KNOWLEDGE_ENABLED: z.string().optional(),
  CCE_IMAGE_GEN_ENABLED: z.string().optional(),
  CCE_TTS_ENABLED: z.string().optional(),
  CCE_EMAIL_FROM: z.string().optional(),
  CCE_SES_CONFIG_SET: z.string().optional(),
  CCE_CANARY_ENABLED: z.string().optional(),

  // ── Update discovery (IaC readiness item 46) ─────────────────────
  // Where the daily backend check looks for new releases (GitHub
  // releases API). DISCOVERY ONLY, never deploy authority: the defaults
  // point at the upstream placeholder repo and only feed the dashboard
  // banner + doctor line.
  CCE_UPSTREAM_OWNER: z.string().optional(),
  CCE_UPSTREAM_REPO: z.string().optional(),
  // Privacy boundary, stated honestly: the update check sends NO payload
  // telemetry, but the HTTPS request itself necessarily reveals this
  // install's egress IP and timing to GitHub. Set to '1' to opt out
  // (air-gapped/strict installs); you lose nothing but the update banner
  // and the doctor line — health/verify never depend on it.
  CCE_UPDATE_CHECK_DISABLED: z.string().optional(),

  // ── Outbound PII policy on web_search (B3) ──────────────────────
  // refuse | redact (default) | allow. Controls what happens when the
  // query about to be sent to Tavily/Brave/Exa/Serper contains PII.
  CCE_WEB_SEARCH_PII_POLICY: z.enum(['refuse', 'redact', 'allow']).optional(),

  // ── Cross-surface owner aliasing (C3) ───────────────────────────
  // CSV of Telegram chat IDs and Slack user IDs that should map to a
  // single synthetic owner chatId. All matched interactions land in
  // one memory namespace across surfaces.
  CCE_OWNER_TELEGRAM_CHATS: z.string().optional(),
  CCE_OWNER_SLACK_USERS: z.string().optional(),
  // Default ('owner') lives in src/lib/identity/owner-alias.ts so zod's
  // inferred type stays optional and existing tests don't have to add it.
  CCE_OWNER_LABEL: z.string().optional(),

  // ── Add-on vendor keys (optional). Tools register themselves only
  // when their required key is present, so a deploy without any of
  // these still boots cleanly. The keys are injected from Secrets
  // Manager at task start; an unpopulated secret injects the
  // REPLACE_ME placeholder, which must read as "not configured" —
  // otherwise the tool registry would arm tools with a garbage key.
  TAVILY_API_KEY: optionalNonPlaceholder(),
  BRAVE_SEARCH_API_KEY: optionalNonPlaceholder(),
  EXA_API_KEY: optionalNonPlaceholder(),
  SERPER_API_KEY: optionalNonPlaceholder(),
  GOOGLE_GEMINI_API_KEY: optionalNonPlaceholder(),

  TABLE_SESSIONS: z.string().optional(),
  TABLE_HIVE_MIND: z.string().optional(),
  TABLE_AUDIT_LOG: z.string().optional(),
  TABLE_CHAT_CONFIG: z.string().optional(),
  TABLE_TOKEN_USAGE: z.string().optional(),
  TABLE_MEMORIES: z.string().optional(),
  TABLE_CONSOLIDATIONS: z.string().optional(),
  TABLE_AGENT_FILE_HISTORY: z.string().optional(),
  TABLE_MISSION_TASKS: z.string().optional(),
  TABLE_SCHEDULED_TASKS: z.string().optional(),
  TABLE_KILL_SWITCHES: z.string().optional(),
  TABLE_INTER_AGENT_TASKS: z.string().optional(),
  TABLE_COMPACTION_EVENTS: z.string().optional(),
  TABLE_QUEUE_LEASE: z.string().optional(),
  TABLE_IDENTITIES: z.string().optional(),
  TABLE_AGENTS: z.string().optional(),
  TABLE_RUNTIME_CONFIG: z.string().optional(),
  TABLE_RATE_LIMITS: z.string().optional(),

  // ── Dashboard access ───────────────────────────────────────────
  CCE_DASHBOARD_URL: z.string().optional(),
  CCE_TUNNEL_DOMAIN: z.string().optional(),

  // ── Cross-surface identity resolution (C4) ──────────────────────
  // Set to "1" to bypass the identities table lookup and use the
  // legacy v3 chatId shape (per-surface namespacing). Rollback knob
  // if the resolver misbehaves in production.
  CCE_IDENTITY_RESOLUTION_DISABLED: z.string().optional(),

  // ── D5 status page ──────────────────────────────────────────────
  // App-name prefix (claudeclaw, claudeclaw-staging) used to filter
  // CloudWatch alarms shown on /status. CFN compute-stack name used
  // to pull recent deploy events. Both have safe defaults.
  CCE_RESOURCE_PREFIX: z.string().optional(),
  CCE_COMPUTE_STACK: z.string().optional(),

  // ── Tier B security-posture reads (/api/posture/*) ──────────────
  // Deterministic identifiers the posture routers target with describe /
  // get calls. All metadata only; no secret VALUES live here. When unset
  // (e.g. local dev), the readers discover targets via list/describe or
  // emit an 'unknown'/amber card.
  CCE_CLOUDTRAIL_NAME: z.string().optional(),
  CCE_KMS_DATA_KEY_ALIAS: z.string().optional(),
  CCE_KMS_CURATED_KEY_ALIAS: z.string().optional(),
  CCE_KMS_LOGS_KEY_ALIAS: z.string().optional(),
  CCE_SECRET_SLACK_ARN: z.string().optional(),
  CCE_SECRET_TELEGRAM_ARN: z.string().optional(),
  CCE_SECRET_DASHBOARD_ARN: z.string().optional(),
  CCE_SECRET_DB_ENCRYPTION_ARN: z.string().optional(),
  CCE_SECRET_BEDROCK_GUARDRAILS_ARN: z.string().optional(),
  CCE_SECRET_VENDOR_KEYS_ARN: z.string().optional(),

  // ── Messaging (set by CDK outputs) ──────────────────────────────
  INGEST_QUEUE_URL: z.string().optional(),
  // Config-invalidation SNS topic ARN (set by compute-stack from
  // RESOURCE_NAMES.configInvalidationTopic). Each task subscribes an
  // ephemeral SQS queue to this topic for fast config-cache fanout and
  // publishes invalidation messages on write. Optional so local dev and
  // the in-process 30s cache poll keep working without it.
  CCE_CONFIG_TOPIC_ARN: z.string().optional(),

  // ── Ops alert SNS topic (set by compute-stack from RESOURCE_NAMES) ──
  // ARN of the existing ops-alert SNS topic owned by observability-stack.
  // The alert-recipient admin console Subscribes / Unsubscribes operator
  // emails on this topic. Optional so local dev boots without it.
  CCE_ALERT_TOPIC_ARN: z.string().optional(),

  // ── A1: EventBridge Scheduler ────────────────────────────────────
  // When CCE_USE_IN_PROCESS_SCHEDULER=1, the orchestrator falls back to
  // the legacy DDB-polling tick in src/agent/scheduler.ts and skips both
  // the queue drain and EB Scheduler create/update/delete calls.
  // Default (=0 or unset) → use EB Scheduler + queue drain.
  CCE_USE_IN_PROCESS_SCHEDULER: z.string().optional(),
  SCHEDULED_FIRE_QUEUE_URL: z.string().optional(),
  SCHEDULED_FIRE_QUEUE_ARN: z.string().optional(),
  SCHEDULER_GROUP_NAME: z.string().optional(),
  SCHEDULER_ROLE_ARN: z.string().optional(),

  // ── Secrets (injected from Secrets Manager by ECS task def) ─────
  SLACK_BOT_TOKEN: z.string().optional(),
  SLACK_SIGNING_SECRET: z.string().optional(),
  SLACK_APP_TOKEN: z.string().optional(),
  TELEGRAM_TOKENS_JSON: z.string().optional(),
  TELEGRAM_WEBHOOK_SECRET: z.string().optional(),
  DASHBOARD_TOKEN: z.string().optional(),
  /** Emergency kill phrase (setup Q9); injected from the dashboard secret's
   * kill_phrase field. When present, any chat message containing it trips
   * the panic freeze (agent-loop matchesKillPhrase). Absent = dormant. */
  EMERGENCY_KILL_PHRASE: z.string().optional(),
  APP_ENCRYPTION_KEY: z.string().optional(),

  // ── Config cache ────────────────────────────────────────────────
  CONFIG_CACHE_TTL_SECONDS: z.coerce.number().int().min(10).default(300),

  // ── Jarvis voice co-pilot (Nova 2 Sonic) ────────────────────────
  // NOVA_SONIC_MODEL: amazon.nova-2-sonic-v1:0 is the launch target
  // (v1, amazon.nova-sonic-v1:0, is legacy/EOL 2026-09-14 — see
  // JARVIS-PLAN.md §1c). The bidirectional stream HARD-CLOSES at 8 min,
  // so JARVIS_MAX_SESSION_SECONDS defaults to 420s with a hard 480s ceiling
  // and NOVA_HTTP2_TIMEOUT_MS aligns to ≥ the session length.
  NOVA_SONIC_MODEL: z.string().default('amazon.nova-2-sonic-v1:0'),
  JARVIS_MAX_SESSION_SECONDS: z.coerce.number().int().min(1).max(480).default(420),
  // Jarvis speaks with Nova 2 Sonic's NATIVE audio (true speech-to-speech, no
  // Polly hop). `amy` is Nova's British-English (en-GB) voice — the closest to a
  // British butler in Nova's roster (it has NO British MALE voice; see
  // docs.aws.amazon.com/nova/.../sonic-language-support.html). Voice ids are
  // lowercase.
  JARVIS_VOICE_ID: z.string().default('amy'),
  JARVIS_MAX_CONCURRENT_SESSIONS: z.coerce.number().int().min(1).default(5),
  // The Polly TTS knobs below are NO LONGER on the Nova voice path (Nova speaks
  // natively). They drive the greeting "kick" (a short throwaway Polly clip fed
  // to Nova at session start so it greets first — never played to the user), the
  // Telegram voice adapter, AND the spoken narration on the text path (guided
  // routine chips). Keep this a FEMALE en-GB voice matching the 'amy' persona —
  // 'Amy' is Polly's en-GB female neural voice (Brian is male, a mismatch).
  JARVIS_TTS_VOICE_ID: z.string().default('Amy'),
  // 'generative' is the warm, natural-sounding Polly engine (neural sounds more
  // robotic). Amy supports it in us-east-1. JARVIS_TTS_RATE is an SSML prosody
  // rate (e.g. '116%') so text-path narration is brisk rather than slow.
  JARVIS_TTS_ENGINE: z.string().default('generative'),
  JARVIS_TTS_LANGUAGE: z.string().default('en-GB'),
  JARVIS_TTS_RATE: z.string().default('116%'),
  // OPTIONAL greeting OVERRIDE. Unset by default — Jarvis composes its own warm,
  // by-name opener at runtime (see buildGreetingLine in adapters/dashboard/jarvis.ts),
  // addressing the user by the runtime-config profile/first_name when known and a
  // warm neutral form otherwise. NEVER defaults to "sir": the old curt
  // 'Hello, sir. How may I help you?' default is intentionally gone (round-2
  // persona fix). Set this only to pin an exact opening line.
  JARVIS_GREETING: z.string().optional(),
  // Fail-closed launch gate (H7). Default OFF: a fresh deploy never exposes
  // Jarvis regardless of DDB state. String-flag convention ("true" = on);
  // interpreted by src/lib/jarvis/jarvis-flags.ts.
  JARVIS_LAUNCH_ENABLED: z.string().optional(),
  NOVA_HTTP2_TIMEOUT_MS: z.coerce.number().int().min(1000).default(470_000),

  // ── Paperclip (ADR 0010) ────────────────────────────────────────
  // Nine runtime keys are read through src/lib/paperclip/config.ts,
  // which turns "unset" into a typed PaperclipDisabledError naming the
  // remediation location rather than letting a request reach `undefined/api/…`.
  //
  // WHY EVERY ONE IS optionalNonPlaceholder() AND NOT z.coerce.number() OR
  // z.string().default(): `node --env-file` turns a bare `KEY=` into the empty
  // string, `.env.example` ships 58 such lines, and infra/lib/compute-stack.ts
  // builds the container environment with `process.env.X ?? 'default'` — which
  // `??` does NOT rescue from ''. Against a coerced number an empty value makes
  // loadEnv() THROW at startup (Number('') === 0 fails a .min()); against a
  // .default() it silently defeats the default. optionalNonPlaceholder() maps
  // both '' and Secrets Manager's REPLACE_ME to undefined, which is the only
  // declaration in this file that is safe on all three paths. The two numeric
  // keys are therefore parsed, with a finite-and-positive guard, in config.ts.
  //
  // Three arrive as ECS secret fields and their SPELLINGS ARE LOAD-BEARING
  // (C-19): `agent_keys` → PAPERCLIP_AGENT_KEYS_JSON (a JSON string, because
  // one secret field injects as one env var), `dispatch_secret` →
  // PAPERCLIP_DISPATCH_SECRET, `reconciler_key` → PAPERCLIP_RECONCILER_KEY.
  // `agent_keys_json` / `dispatch_token` are the plan's wrong variants and a
  // field mismatch is a task that cannot START.
  /** String-flag convention ("1"/"true"). The seventh home of a flag that had six. */
  CCE_PAPERCLIP_ENABLED: optionalNonPlaceholder(),
  /** Origin only, no path. Runtime-config `paperclip/base_url` wins over this. */
  PAPERCLIP_BASE_URL: optionalNonPlaceholder(),
  /** Per-environment callback persisted into Paperclip agent adapter config at bootstrap. */
  PAPERCLIP_DISPATCH_URL: optionalNonPlaceholder(),
  /** Per-environment accountable operator used only for tenant bootstrap. */
  CCE_PAPERCLIP_ADMIN_EMAIL: optionalNonPlaceholder(),
  /** The single tenant's company uuid; what company-id pinning compares against. */
  PAPERCLIP_COMPANY_ID: optionalNonPlaceholder(),
  /** JSON object, agent slug → agent API key. Secret field `agent_keys`. */
  PAPERCLIP_AGENT_KEYS_JSON: optionalNonPlaceholder(),
  /** Secret field `reconciler_key`. A second key on the same agent, not a distinct actor class. */
  PAPERCLIP_RECONCILER_KEY: optionalNonPlaceholder(),
  /** Secret field `dispatch_secret`; the shared secret C-17 settled on for the dispatch route. */
  PAPERCLIP_DISPATCH_SECRET: optionalNonPlaceholder(),
  /** Agent slug signing requests that name no actor. Defaults to `main`. */
  PAPERCLIP_DEFAULT_AGENT: optionalNonPlaceholder(),
  /** Milliseconds. Overrides the 10 s read timeout (A2-11's divergence from Linear). */
  PAPERCLIP_READ_TIMEOUT_MS: optionalNonPlaceholder(),
  /** Milliseconds. Overrides the 20 s write timeout. */
  PAPERCLIP_WRITE_TIMEOUT_MS: optionalNonPlaceholder(),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

export function loadEnv(): Env {
  if (cached) return cached;
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  // Prod fail-fast (IaC readiness item 11, finally implemented). Schema parse
  // alone never throws for a deployed task that is missing its Bedrock model,
  // tables, or surface tokens — every AWS field is optional — so a misconfigured
  // task would boot, pass the liveness probe, and 500 on the first real turn.
  // Only assert on an actually-deployed task (NODE_ENV=production, set on the
  // task def, plus the ECS/Fargate runtime markers). Local dev defaults
  // NODE_ENV to development and sets no markers, so a developer who put
  // CCE_DEPLOY_MODE in their .env is not treated as deployed and keeps the
  // permissive dev-mode behavior. CCE_DEPLOY_MODE still drives WHICH
  // requirements apply (chat vs infra-only), just not whether we fail fast.
  if (isDeployedTask(process.env)) {
    const missing = missingDeployConfig(result.data);
    if (missing.length > 0) {
      throw new Error(
        `Refusing to start: required production config is missing or placeholder ` +
          `(deploy mode=${process.env.CCE_DEPLOY_MODE ?? 'chat'}):\n` +
          missing.map((m) => `  ${m}`).join('\n'),
      );
    }
  }
  cached = result.data;
  return cached;
}

/**
 * True when we are running as an actually-deployed task (ECS/Fargate), where a
 * missing-config crash-loop is the right, visible failure. We treat the task as
 * deployed when the deploy mode is set OR the ECS agent injected its runtime
 * markers. Unit tests / local tooling set none of these, so the startup
 * fail-fast stays inert there.
 */
export function isDeployedTask(env: NodeJS.ProcessEnv = process.env): boolean {
  // Real ECS/Fargate tasks set these runtime markers AND NODE_ENV=production.
  // Do NOT key off CCE_DEPLOY_MODE: a developer may set it in .env to exercise
  // chat/infra-only mode locally, and we must not then crash-loop their dev
  // process on missing AWS secrets (dev mode permits absent AWS-dependent vars).
  return Boolean(
    env.ECS_CONTAINER_METADATA_URI_V4 || env.AWS_EXECUTION_ENV || env.NODE_ENV === 'production',
  );
}

/**
 * The required-config gaps for the current deploy mode, as human-readable
 * strings. Empty array means the task has everything it needs to serve. Mirrors
 * isReadyForTraffic()'s requirements but reports WHICH field is missing so the
 * startup fail-fast is actionable.
 */
export function missingDeployConfig(env: Env): string[] {
  const out: string[] = [];
  const hasBedrock =
    isRealConfigValue(env.BEDROCK_DEFAULT_MODEL) ||
    isRealConfigValue(env.BEDROCK_SONNET_MODEL) ||
    isRealConfigValue(env.BEDROCK_OPUS_MODEL) ||
    isRealConfigValue(env.BEDROCK_HAIKU_MODEL);
  if (!hasBedrock) {
    out.push('a Bedrock model id (BEDROCK_DEFAULT_MODEL / SONNET / OPUS / HAIKU)');
  }
  if (env.CCE_DEPLOY_MODE === 'infra-only') {
    if (!isRealConfigValue(env.DASHBOARD_TOKEN)) out.push('DASHBOARD_TOKEN');
    return out;
  }
  // chat mode: at least one real surface token.
  const hasTelegram =
    isRealConfigValue(env.TELEGRAM_TOKENS_JSON) &&
    /[A-Za-z0-9]/.test(env.TELEGRAM_TOKENS_JSON ?? '') &&
    !(env.TELEGRAM_TOKENS_JSON ?? '').includes('REPLACE_ME');
  if (!isRealConfigValue(env.SLACK_BOT_TOKEN) && !hasTelegram) {
    out.push('a chat surface token (SLACK_BOT_TOKEN or TELEGRAM_TOKENS_JSON)');
  }
  return out;
}

/** Reset the cached env. Tests use this; production never calls it. */
export function resetEnvCache(): void {
  cached = null;
}

/**
 * A value "counts" toward readiness only when it is real: empty strings,
 * Secrets Manager's REPLACE_ME placeholder, and template-shaped
 * `<your-...>` values are all rejected (IaC readiness item 11). Without
 * this, a task started against unpopulated secrets reports ready and
 * then 500s on the first turn.
 */
export function isRealConfigValue(value: string | undefined): boolean {
  if (!value) return false;
  const v = value.trim();
  if (v.length === 0) return false;
  if (v === 'REPLACE_ME') return false;
  if (v.startsWith('<') && v.endsWith('>')) return false;
  return true;
}

/**
 * Mode-aware readiness (IaC readiness item 11). Deployment mode comes
 * from CCE_DEPLOY_MODE:
 *   - `chat` (default): Bedrock model + at least one REAL surface token.
 *   - `infra-only`: Bedrock model + dashboard auth; no chat surface
 *     required (dashboard-only install, no webhook surfaces).
 * Used by /ready to distinguish "alive" from "ready to serve" — /ready
 * stays 503 until the mode's requirements are genuinely met.
 *
 * Any Claude model is sufficient (Sonnet preferred, Haiku acceptable).
 * Embed model has its own default.
 */
export function isReadyForTraffic(env: Env): boolean {
  const hasBedrock =
    isRealConfigValue(env.BEDROCK_DEFAULT_MODEL) ||
    isRealConfigValue(env.BEDROCK_SONNET_MODEL) ||
    isRealConfigValue(env.BEDROCK_OPUS_MODEL) ||
    isRealConfigValue(env.BEDROCK_HAIKU_MODEL);
  if (!hasBedrock) return false;

  if (env.CCE_DEPLOY_MODE === 'infra-only') {
    return isRealConfigValue(env.DASHBOARD_TOKEN);
  }

  // chat mode: a Telegram tokens map full of placeholders is not a surface.
  const hasTelegram =
    isRealConfigValue(env.TELEGRAM_TOKENS_JSON) &&
    /[A-Za-z0-9]/.test(env.TELEGRAM_TOKENS_JSON ?? '') &&
    !(env.TELEGRAM_TOKENS_JSON ?? '').includes('REPLACE_ME');
  const hasSurface = isRealConfigValue(env.SLACK_BOT_TOKEN) || hasTelegram;
  return hasSurface;
}
