/**
 * Phased-deploy building blocks (IaC readiness plan items 8, 9, 10, 14).
 *
 * scripts/deploy.ts is the orchestration; the substantial, testable logic
 * lives here with injectable clients so unit tests run on fakes with zero
 * AWS calls:
 *
 *  - planSecretWrites / populateSecretsV2 — phase (b), the rewritten
 *    populateSecrets: per-deploy staging labels, label-collision refusal,
 *    configured-surface failures are FATAL with an exact recovery command,
 *    unconfigured failures stay warnings, old deploy labels are pruned.
 *  - extractGuardrailOutputs — bedrock-guardrails secret value from the
 *    phase-(a) Guardrails stack CfnOutputs.
 *  - manifest assembly helpers — per-stack template hashes, seed revision,
 *    the full container-image record set (orchestrator + worker + the
 *    pinned X-Ray sidecar at tier >= 2).
 *  - imageInspectHasArm64 — item 9's architecture gate over
 *    `docker buildx imagetools inspect` output.
 *  - imageJsonHasArm64 — single-manifest fallback for that gate, over
 *    `imagetools inspect --format '{{json .}}'` (.image.architecture).
 *  - resolveRuntimeConfigTable — same resolution rule as scripts/seed.ts
 *    (duplicated here because importing seed.ts would run its CLI main()).
 */

import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DescribeSecretCommand,
  PutSecretValueCommand,
  UpdateSecretVersionStageCommand,
} from '@aws-sdk/client-secrets-manager';
import { deployLabel } from './ids.js';
import type { AwsClientLike } from './lock.js';
import type { ContainerImageRecord, SecretVersionRecord } from './manifest.js';
import { buildResourceNames } from '../../../infra/lib/constants.js';
import type { SeedRow } from '../seed-defaults.js';

type Env = Record<string, string | undefined>;

// ─────────────────────────────────────────────────────────────────────
// Guardrail outputs (phase a → phase b input)
// ─────────────────────────────────────────────────────────────────────

export interface GuardrailOutputs {
  guardrailId: string;
  guardrailVersion: string;
}

/**
 * Pull GuardrailId/GuardrailVersion out of a `--outputs-file` object. The
 * Guardrails stack declares both as explicit CfnOutputs
 * (infra/lib/guardrails-stack.ts); the stack key is `<prefix>-Guardrails`.
 */
export function extractGuardrailOutputs(
  outputs: Record<string, Record<string, string>>,
): GuardrailOutputs {
  const stackKey = Object.keys(outputs).find((k) => k.includes('Guardrails'));
  if (!stackKey) {
    throw new Error(
      'foundation outputs contain no Guardrails stack — phase (a) must deploy ' +
        '<prefix>-Guardrails before the bedrock-guardrails secret can be written',
    );
  }
  const stack = outputs[stackKey];
  const guardrailId = stack.GuardrailId;
  const guardrailVersion = stack.GuardrailVersion;
  if (!guardrailId || !guardrailVersion) {
    throw new Error(
      `Guardrails stack outputs (${stackKey}) are missing GuardrailId/GuardrailVersion — ` +
        'the CfnOutputs in infra/lib/guardrails-stack.ts should provide both',
    );
  }
  return { guardrailId, guardrailVersion };
}

// ─────────────────────────────────────────────────────────────────────
// Secret write planning (phase b)
// ─────────────────────────────────────────────────────────────────────

export interface SecretWritePlan {
  /** Leaf name under the secret base path (slack, telegram, ...). */
  leaf: string;
  secretId: string;
  /** Human label for log lines. */
  label: string;
  /** JSON value to write. */
  value: string;
  /**
   * True when this secret backs a CONFIGURED surface (item 10): slack when
   * SLACK_BOT_TOKEN is set, telegram when TELEGRAM_TOKENS_JSON is set,
   * dashboard + db-encryption + bedrock-guardrails always. A write failure
   * for a configured secret FAILS the deploy; unconfigured stays a warning.
   */
  configured: boolean;
  /** Placeholder-valued JSON shape used in the printed recovery command. */
  placeholderShape: string;
}

/**
 * The full secret set for a deploy: surface secrets from env (same values
 * as the legacy populateSecrets) plus bedrock-guardrails from the phase-(a)
 * stack outputs.
 */
export function planSecretWrites(
  env: Env,
  secretBase: string,
  guardrails: GuardrailOutputs,
): SecretWritePlan[] {
  const plans: SecretWritePlan[] = [];

  if (env.SLACK_BOT_TOKEN || env.SLACK_SIGNING_SECRET || env.SLACK_APP_TOKEN) {
    plans.push({
      leaf: 'slack',
      secretId: `${secretBase}/slack`,
      label: 'Slack',
      value: JSON.stringify({
        bot_token: env.SLACK_BOT_TOKEN ?? '',
        signing_secret: env.SLACK_SIGNING_SECRET ?? '',
        app_token: env.SLACK_APP_TOKEN ?? '',
      }),
      configured: Boolean(env.SLACK_BOT_TOKEN),
      placeholderShape: JSON.stringify({
        bot_token: '<xoxb-...>',
        signing_secret: '<signing-secret>',
        app_token: '<xapp-...>',
      }),
    });
  }

  if (env.TELEGRAM_TOKENS_JSON || env.TELEGRAM_WEBHOOK_SECRET) {
    plans.push({
      leaf: 'telegram',
      secretId: `${secretBase}/telegram`,
      label: 'Telegram',
      value: JSON.stringify({
        tokens: env.TELEGRAM_TOKENS_JSON ?? '{}',
        webhook_secret: env.TELEGRAM_WEBHOOK_SECRET ?? '',
      }),
      configured: Boolean(env.TELEGRAM_TOKENS_JSON),
      placeholderShape: JSON.stringify({
        tokens: '{"main":"<bot-token>"}',
        webhook_secret: '<webhook-secret>',
      }),
    });
  }

  // Dashboard: always written, always configured.
  plans.push({
    leaf: 'dashboard',
    secretId: `${secretBase}/dashboard`,
    label: 'Dashboard',
    value: JSON.stringify({
      token: env.DASHBOARD_TOKEN ?? '',
      pin_hash: env.SECURITY_PIN_HASH ?? '',
      kill_phrase: env.EMERGENCY_KILL_PHRASE ?? '',
    }),
    configured: true,
    placeholderShape: JSON.stringify({
      token: '<dashboard-token>',
      pin_hash: '<pin-hash>',
      kill_phrase: '<kill-phrase>',
    }),
  });

  // DB encryption: written when the key exists (as today), but it ALWAYS
  // backs a configured surface — a failed write is a deploy failure.
  if (env.APP_ENCRYPTION_KEY) {
    plans.push({
      leaf: 'db-encryption',
      secretId: `${secretBase}/db-encryption`,
      label: 'DB encryption',
      value: JSON.stringify({ key: env.APP_ENCRYPTION_KEY }),
      configured: true,
      placeholderShape: JSON.stringify({ key: '<32-byte-hex-key>' }),
    });
  }

  // Optional vendor API keys — never a configured surface; failures warn.
  if (
    env.TAVILY_API_KEY ||
    env.BRAVE_SEARCH_API_KEY ||
    env.EXA_API_KEY ||
    env.SERPER_API_KEY ||
    env.GOOGLE_GEMINI_API_KEY
  ) {
    plans.push({
      leaf: 'vendor-keys',
      secretId: `${secretBase}/vendor-keys`,
      label: 'Vendor keys',
      value: JSON.stringify({
        tavily_api_key: env.TAVILY_API_KEY || 'REPLACE_ME',
        brave_search_api_key: env.BRAVE_SEARCH_API_KEY || 'REPLACE_ME',
        exa_api_key: env.EXA_API_KEY || 'REPLACE_ME',
        serper_api_key: env.SERPER_API_KEY || 'REPLACE_ME',
        google_gemini_api_key: env.GOOGLE_GEMINI_API_KEY || 'REPLACE_ME',
      }),
      configured: false,
      placeholderShape: JSON.stringify({
        tavily_api_key: '<key-or-REPLACE_ME>',
        brave_search_api_key: '<key-or-REPLACE_ME>',
        exa_api_key: '<key-or-REPLACE_ME>',
        serper_api_key: '<key-or-REPLACE_ME>',
        google_gemini_api_key: '<key-or-REPLACE_ME>',
      }),
    });
  }

  // Bedrock guardrails: value comes from the phase-(a) stack outputs, not
  // env; always configured (item 10: "or the guardrails secret").
  plans.push({
    leaf: 'bedrock-guardrails',
    secretId: `${secretBase}/bedrock-guardrails`,
    label: 'Bedrock guardrails',
    value: JSON.stringify({
      guardrail_id: guardrails.guardrailId,
      guardrail_version: guardrails.guardrailVersion,
    }),
    configured: true,
    placeholderShape: JSON.stringify({
      guardrail_id: '<guardrail-id-from-Guardrails-stack-outputs>',
      guardrail_version: '<guardrail-version>',
    }),
  });

  return plans;
}

/** Exact recovery command printed when a configured-surface write fails. */
export function recoveryCommand(plan: SecretWritePlan, region: string): string {
  return (
    `aws secretsmanager put-secret-value --secret-id ${plan.secretId} ` +
    `--secret-string '${plan.placeholderShape}' --region ${region}`
  );
}

/** Thrown when a configured-surface secret write fails (deploy FAILURE). */
export class SecretWriteFailure extends Error {
  readonly secretId: string;
  readonly recovery: string;
  constructor(message: string, secretId: string, recovery: string) {
    super(message);
    this.name = 'SecretWriteFailure';
    this.secretId = secretId;
    this.recovery = recovery;
  }
}

// ─────────────────────────────────────────────────────────────────────
// populateSecretsV2 (phase b)
// ─────────────────────────────────────────────────────────────────────

/** Staging labels minted by deploys: CCE-<14-digit ts>-... (lexicographically
 * sortable by timestamp, so "newest" = highest string). */
const DEPLOY_LABEL_PREFIX_RE = /^CCE-\d{14}-/;

/** Staging labels Secrets Manager itself manages; never touched by pruning. */
const AWS_MANAGED_STAGES = new Set(['AWSCURRENT', 'AWSPREVIOUS', 'AWSPENDING']);

/** How many per-deploy labels to keep on each secret (item 10 pruning). */
export const KEEP_DEPLOY_LABELS = 10;

interface DescribeSecretShape {
  VersionIdsToStages?: Record<string, string[]>;
}

export interface PopulateSecretsOptions {
  /** Secrets Manager client (real SecretsManagerClient or a `{ send }` fake). */
  client: AwsClientLike;
  env: Env;
  /** `/claudeclaw[-suffix]` base path. */
  secretBase: string;
  deployId: string;
  region: string;
  guardrails: GuardrailOutputs;
  keepLabels?: number;
  /** Injectable for deterministic tests; defaults to crypto.randomUUID. */
  uuid?: () => string;
  /** Progress logger (deploy.ts passes its ok/warn printers). */
  log?: (line: string) => void;
}

export interface PopulateSecretsResult {
  /** Per-secret version records for the manifest (NO secret values). */
  records: SecretVersionRecord[];
  /** Non-fatal problems: unconfigured write failures, prune hiccups. */
  warnings: string[];
  /** Labels removed by pruning, per secretId. */
  pruned: Record<string, string[]>;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Phase (b): write every planned secret with a per-deploy staging label.
 *
 *  - DescribeSecret first: capture the previous AWSCURRENT VersionId and
 *    refuse to proceed if the deploy label ALREADY exists anywhere on the
 *    secret (reusing a label silently moves it off the old version — always
 *    a deploy failure, item 10).
 *  - PutSecretValue with a fresh ClientRequestToken and
 *    VersionStages ['AWSCURRENT', <deploy label>].
 *  - A write failure on a configured-surface secret throws
 *    SecretWriteFailure with the exact recovery command; unconfigured
 *    failures are recorded as warnings and the loop continues.
 *  - After a successful write, prune old `CCE-*` deploy labels down to the
 *    most recent `keepLabels` (labels embed yyyymmddHHMMSS so plain
 *    lexicographic order is chronological). AWSCURRENT/AWSPREVIOUS/
 *    AWSPENDING are never touched.
 */
export async function populateSecretsV2(
  opts: PopulateSecretsOptions,
): Promise<PopulateSecretsResult> {
  const label = deployLabel(opts.deployId);
  const keep = opts.keepLabels ?? KEEP_DEPLOY_LABELS;
  const uuid = opts.uuid ?? randomUUID;
  const log = opts.log ?? ((): void => {});
  const plans = planSecretWrites(opts.env, opts.secretBase, opts.guardrails);

  const records: SecretVersionRecord[] = [];
  const warnings: string[] = [];
  const pruned: Record<string, string[]> = {};

  for (const plan of plans) {
    // 1. DescribeSecret: previous AWSCURRENT + label-collision check.
    let previousVersionId: string | undefined;
    try {
      const desc = (await opts.client.send(
        new DescribeSecretCommand({ SecretId: plan.secretId }),
      )) as DescribeSecretShape;
      const stagesByVersion = desc.VersionIdsToStages ?? {};
      for (const [versionId, stages] of Object.entries(stagesByVersion)) {
        if (stages.includes('AWSCURRENT')) previousVersionId = versionId;
        if (stages.includes(label)) {
          throw new SecretWriteFailure(
            `staging label ${label} ALREADY exists on ${plan.secretId} (version ${versionId}). ` +
              'Reusing a per-deploy label would silently move it off the old version; ' +
              'a deployId is single-use — re-run the deploy to mint a fresh one.',
            plan.secretId,
            recoveryCommand(plan, opts.region),
          );
        }
      }
    } catch (err) {
      if (err instanceof SecretWriteFailure) throw err; // label collision: always fatal
      const message =
        `${plan.label} secret (${plan.secretId}): DescribeSecret failed: ${errMessage(err)}` +
        ' — the foundation stacks (phase a) own this secret; it should exist before phase (b)';
      if (plan.configured) {
        throw new SecretWriteFailure(message, plan.secretId, recoveryCommand(plan, opts.region));
      }
      warnings.push(message);
      continue;
    }

    // 2. PutSecretValue with the per-deploy label.
    let versionId: string;
    try {
      const put = (await opts.client.send(
        new PutSecretValueCommand({
          SecretId: plan.secretId,
          SecretString: plan.value,
          ClientRequestToken: uuid(),
          VersionStages: ['AWSCURRENT', label],
        }),
      )) as { VersionId?: string };
      if (!put.VersionId) throw new Error('PutSecretValue returned no VersionId');
      versionId = put.VersionId;
    } catch (err) {
      const message = `${plan.label} secret (${plan.secretId}): write failed: ${errMessage(err)}`;
      if (plan.configured) {
        throw new SecretWriteFailure(message, plan.secretId, recoveryCommand(plan, opts.region));
      }
      warnings.push(message);
      continue;
    }

    records.push({ secretId: plan.secretId, versionId, label, previousVersionId });
    log(`${plan.label} secret populated (version ${versionId}, label ${label})`);

    // 3. Prune old deploy labels (non-fatal).
    try {
      const removed = await pruneDeployLabels(opts.client, plan.secretId, keep);
      if (removed.length > 0) pruned[plan.secretId] = removed;
    } catch (err) {
      warnings.push(
        `${plan.label} secret (${plan.secretId}): label pruning failed (non-fatal): ${errMessage(err)}`,
      );
    }
  }

  return { records, warnings, pruned };
}

/**
 * Remove all but the newest `keep` deploy labels from a secret. Only stages
 * matching the `CCE-<timestamp>-` deploy-label shape are ever candidates;
 * AWS-managed stages and anything else are left alone. Returns the removed
 * labels.
 */
export async function pruneDeployLabels(
  client: AwsClientLike,
  secretId: string,
  keep: number = KEEP_DEPLOY_LABELS,
): Promise<string[]> {
  const desc = (await client.send(
    new DescribeSecretCommand({ SecretId: secretId }),
  )) as DescribeSecretShape;
  const stagesByVersion = desc.VersionIdsToStages ?? {};

  const deployLabels: Array<{ stage: string; versionId: string }> = [];
  for (const [versionId, stages] of Object.entries(stagesByVersion)) {
    for (const stage of stages) {
      if (AWS_MANAGED_STAGES.has(stage)) continue;
      if (DEPLOY_LABEL_PREFIX_RE.test(stage)) deployLabels.push({ stage, versionId });
    }
  }

  // Labels embed yyyymmddHHMMSS right after `CCE-`, so a plain descending
  // string sort is newest-first.
  deployLabels.sort((a, b) => (a.stage < b.stage ? 1 : a.stage > b.stage ? -1 : 0));
  const stale = deployLabels.slice(keep);

  const removed: string[] = [];
  for (const { stage, versionId } of stale) {
    await client.send(
      new UpdateSecretVersionStageCommand({
        SecretId: secretId,
        VersionStage: stage,
        RemoveFromVersionId: versionId,
      }),
    );
    removed.push(stage);
  }
  return removed;
}

// ─────────────────────────────────────────────────────────────────────
// Manifest assembly helpers (item 14)
// ─────────────────────────────────────────────────────────────────────

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** seedRevision for the manifest: hash of the serialized seed rows. */
export function seedRevisionOf(rows: SeedRow[]): string {
  return sha256Hex(JSON.stringify(rows));
}

/**
 * sha256 of every `cdk.out/*.template.json`, keyed by stack name (filename
 * without the `.template.json` suffix). Asset manifests etc. are ignored —
 * the full directory is archived separately as cdk.out.zip.
 */
export function hashStackTemplates(cdkOutDir: string): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const file of readdirSync(cdkOutDir)) {
    if (!file.endsWith('.template.json')) continue;
    const stackName = file.slice(0, -'.template.json'.length);
    hashes[stackName] = sha256Hex(readFileSync(join(cdkOutDir, file)));
  }
  return hashes;
}

export const XRAY_SIDECAR_REPO = 'public.ecr.aws/xray/aws-xray-daemon';

/**
 * Fallback only — the real value is read from infra/lib/compute-stack.ts at
 * deploy time (xrayDigestFromComputeStackSource) so the manifest can never
 * drift from the task definition. This mirrors the digest pinned there.
 */
export const XRAY_SIDECAR_DIGEST_FALLBACK =
  'sha256:c64b7d6dd3a9bd5bbf117ca4e876b7677ff548a6de2f2377b9bb1fd649a31b3b';

/**
 * Extract the pinned X-Ray sidecar digest from the compute-stack source so
 * the manifest records exactly what the task definition references.
 */
export function xrayDigestFromComputeStackSource(source: string): string | null {
  const match = /aws-xray-daemon:[^@'"\s]*@(sha256:[0-9a-f]{64})/.exec(source);
  return match ? match[1] : null;
}

export interface BuildImageRecordsOptions {
  /** `claudeclaw` or `claudeclaw-<suffix>` (infra/lib/constants.ts buildApp). */
  app: string;
  /** Full ECR repo URI for the orchestrator image. */
  repoUri: string;
  imageDigest: string;
  tier: number;
  /** Resolved X-Ray digest (xrayDigestFromComputeStackSource or fallback). */
  xrayDigest?: string;
}

/**
 * Every container in every task definition (item 9): the orchestrator task,
 * the consolidation-worker task (same image, container 'worker'), and at
 * tier >= 2 the X-Ray daemon sidecar pinned by digest in compute-stack.ts.
 */
export function buildImageRecords(opts: BuildImageRecordsOptions): ContainerImageRecord[] {
  const records: ContainerImageRecord[] = [
    {
      taskFamily: `${opts.app}-orchestrator`,
      containerName: 'orchestrator',
      repo: opts.repoUri,
      digest: opts.imageDigest,
      platform: 'linux/arm64',
    },
    {
      taskFamily: `${opts.app}-consolidation-worker`,
      containerName: 'worker',
      repo: opts.repoUri,
      digest: opts.imageDigest,
      platform: 'linux/arm64',
    },
  ];
  if (opts.tier >= 2) {
    records.push({
      taskFamily: `${opts.app}-orchestrator`,
      containerName: 'xray-daemon',
      repo: XRAY_SIDECAR_REPO,
      // The pinned digest is a multi-arch manifest INDEX; the platform is
      // selected per-index at pull time, so the record says so honestly.
      digest: opts.xrayDigest ?? XRAY_SIDECAR_DIGEST_FALLBACK,
      platform: 'per-index (multi-arch manifest list)',
    });
  }
  return records;
}

// ─────────────────────────────────────────────────────────────────────
// Image architecture gate (item 9)
// ─────────────────────────────────────────────────────────────────────

/**
 * True when `docker buildx imagetools inspect` output shows a linux/arm64
 * manifest. Fargate runs ARM64 (Graviton); an x86 operator's default
 * `docker build` pushes amd64 that crash-loops with "exec format error".
 */
export function imageInspectHasArm64(inspectOutput: string): boolean {
  return /linux\/arm64/.test(inspectOutput);
}

/**
 * True when `docker buildx imagetools inspect --format '{{json .}}'` output
 * shows a single-manifest arm64 image. The default (non-JSON) inspect output
 * lists `linux/arm64` only for a multi-arch index; a lone manifest exposes its
 * architecture solely in the structured form at `.image.architecture` (proven
 * on the live arm64 image — top-level keys name/manifest/image). Malformed or
 * non-JSON input → false (the caller already covers the index case).
 */
export function imageJsonHasArm64(jsonOutput: string): boolean {
  try {
    const parsed = JSON.parse(jsonOutput) as { image?: { architecture?: string } };
    return parsed.image?.architecture === 'arm64';
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────
// Seed-table resolution (phase c)
// ─────────────────────────────────────────────────────────────────────

/**
 * Resolve the runtime-config table name the same way scripts/seed.ts does:
 * explicit TABLE_RUNTIME_CONFIG wins; otherwise derive
 * `claudeclaw[-suffix]-runtime-config` with the suffix following deploy.ts's
 * rule (explicit CCE_NAME_SUFFIX, else the --env name, '' for prod).
 * Duplicated from seed.ts because importing it would execute its CLI main().
 */
export function resolveRuntimeConfigTable(env: Env, envFlag: string): string {
  if (env.TABLE_RUNTIME_CONFIG) return env.TABLE_RUNTIME_CONFIG;
  const suffix = env.CCE_NAME_SUFFIX ?? (envFlag === 'prod' ? '' : envFlag);
  return buildResourceNames(suffix).ddb.runtimeConfig;
}
