/**
 * Security posture repository (Tier B, READ-ONLY).
 *
 * Reads encryption / secrets / backup posture from AWS describe + get
 * APIs and renders them as green/amber/red status cards. There are NO
 * write paths here, and the module NEVER fetches or returns a secret
 * VALUE - only metadata (name, last-rotated date, rotation schedule,
 * ARN suffix).
 *
 * Every AWS call is wrapped so a denied permission or transient error
 * degrades a single card to 'unknown' (amber) with an error note. The
 * posture page must never 500 because one describe call was refused.
 *
 * A short in-memory cache fronts the whole snapshot so repeated dashboard
 * polls do not throttle KMS / Secrets Manager / DynamoDB.
 */

import {
  KMSClient,
  ListAliasesCommand,
  GetKeyRotationStatusCommand,
  DescribeKeyCommand,
  type AliasListEntry,
} from '@aws-sdk/client-kms';
import {
  SecretsManagerClient,
  DescribeSecretCommand,
} from '@aws-sdk/client-secrets-manager';
import {
  DynamoDBClient,
  DescribeContinuousBackupsCommand,
} from '@aws-sdk/client-dynamodb';
import {
  S3Client,
  GetBucketEncryptionCommand,
  GetObjectLockConfigurationCommand,
  GetBucketVersioningCommand,
} from '@aws-sdk/client-s3';
import { logger } from '../../observability/logger.js';

const REGION = process.env.AWS_REGION ?? 'us-east-1';
const APP_PREFIX = process.env.CCE_RESOURCE_PREFIX ?? 'claudeclaw';

/** A single posture card. Shape is identical across all four routers. */
export interface PostureCard {
  id: string;
  label: string;
  status: 'ok' | 'warn' | 'crit' | 'unknown';
  detail: string;
  value?: string;
}

// ── Lazy AWS clients (reuse across calls; region from ECS) ──────────
let _kms: KMSClient | null = null;
let _sm: SecretsManagerClient | null = null;
let _ddb: DynamoDBClient | null = null;
let _s3: S3Client | null = null;

function kms(): KMSClient {
  if (!_kms) _kms = new KMSClient({ region: REGION });
  return _kms;
}
function sm(): SecretsManagerClient {
  if (!_sm) _sm = new SecretsManagerClient({ region: REGION });
  return _sm;
}
function ddbRaw(): DynamoDBClient {
  if (!_ddb) _ddb = new DynamoDBClient({ region: REGION });
  return _ddb;
}
function s3(): S3Client {
  if (!_s3) _s3 = new S3Client({ region: REGION });
  return _s3;
}

/** Test seam: inject mock clients and reset the snapshot cache. */
export function __setSecurityPostureClients(
  next: {
    kms?: KMSClient | null;
    sm?: SecretsManagerClient | null;
    ddb?: DynamoDBClient | null;
    s3?: S3Client | null;
  } = {},
): void {
  if ('kms' in next) _kms = next.kms ?? null;
  if ('sm' in next) _sm = next.sm ?? null;
  if ('ddb' in next) _ddb = next.ddb ?? null;
  if ('s3' in next) _s3 = next.s3 ?? null;
  _cache = null;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Last 6 chars of an ARN / id, for display without leaking the full value. */
function arnSuffix(arn: string | undefined): string {
  if (!arn) return 'unknown';
  return arn.length > 6 ? arn.slice(-6) : arn;
}

// ── KMS: customer-managed key rotation ──────────────────────────────

const KMS_ALIASES: Array<{ id: string; envVar: string; label: string }> = [
  { id: 'kms-data', envVar: 'CCE_KMS_DATA_KEY_ALIAS', label: 'data key rotation' },
  { id: 'kms-curated', envVar: 'CCE_KMS_CURATED_KEY_ALIAS', label: 'curated key rotation' },
  { id: 'kms-logs', envVar: 'CCE_KMS_LOGS_KEY_ALIAS', label: 'logs key rotation' },
];

/**
 * For each known CMK alias, resolve the alias -> target key id via
 * ListAliases, then GetKeyRotationStatus + DescribeKey. We never read or
 * return key material; only rotation status and the customer-managed flag.
 */
async function fetchKmsCards(): Promise<PostureCard[]> {
  const wanted = KMS_ALIASES.map((a) => ({
    ...a,
    aliasName: process.env[a.envVar],
  }));

  // Resolve all alias -> key-id mappings up front (single paginated list).
  let aliasMap: Map<string, string> | null = null;
  let listErr: string | null = null;
  try {
    aliasMap = new Map();
    let marker: string | undefined;
    do {
      const resp = await kms().send(new ListAliasesCommand({ Marker: marker }));
      for (const a of (resp.Aliases ?? []) as AliasListEntry[]) {
        if (a.AliasName && a.TargetKeyId) aliasMap.set(a.AliasName, a.TargetKeyId);
      }
      marker = resp.Truncated ? resp.NextMarker : undefined;
    } while (marker);
  } catch (err) {
    listErr = errMsg(err);
    logger.warn({ errMessage: listErr }, 'posture: kms ListAliases failed');
  }

  const cards: PostureCard[] = [];
  for (const a of wanted) {
    if (!a.aliasName) {
      cards.push({
        id: a.id,
        label: a.label,
        status: 'unknown',
        detail: `alias env (${a.envVar}) not set; cannot resolve key`,
      });
      continue;
    }
    if (!aliasMap) {
      cards.push({
        id: a.id,
        label: a.label,
        status: 'unknown',
        detail: `could not list KMS aliases: ${listErr ?? 'unknown error'}`,
      });
      continue;
    }
    const keyId = aliasMap.get(a.aliasName);
    if (!keyId) {
      cards.push({
        id: a.id,
        label: a.label,
        status: 'unknown',
        detail: `alias ${a.aliasName} not found in account`,
      });
      continue;
    }
    try {
      const [rot, desc] = await Promise.all([
        kms().send(new GetKeyRotationStatusCommand({ KeyId: keyId })),
        kms().send(new DescribeKeyCommand({ KeyId: keyId })),
      ]);
      const enabled = rot.KeyRotationEnabled === true;
      const customerManaged = desc.KeyMetadata?.KeyManager === 'CUSTOMER';
      cards.push({
        id: a.id,
        label: a.label,
        status: enabled ? 'ok' : 'warn',
        detail: customerManaged
          ? enabled
            ? 'CMK rotation enabled'
            : 'CMK rotation NOT enabled'
          : 'key is AWS-managed (rotation governed by AWS)',
        value: `…${arnSuffix(keyId)}`,
      });
    } catch (err) {
      cards.push({
        id: a.id,
        label: a.label,
        status: 'unknown',
        detail: `rotation status unavailable: ${errMsg(err)}`,
      });
    }
  }
  return cards;
}

// ── Secrets Manager: rotation metadata only (NEVER the value) ────────

const SECRETS: Array<{ id: string; envVar: string; label: string }> = [
  { id: 'secret-slack', envVar: 'CCE_SECRET_SLACK_ARN', label: 'slack secret' },
  { id: 'secret-telegram', envVar: 'CCE_SECRET_TELEGRAM_ARN', label: 'telegram secret' },
  { id: 'secret-dashboard', envVar: 'CCE_SECRET_DASHBOARD_ARN', label: 'dashboard secret' },
  { id: 'secret-db-encryption', envVar: 'CCE_SECRET_DB_ENCRYPTION_ARN', label: 'db-encryption secret' },
  { id: 'secret-bedrock-guardrails', envVar: 'CCE_SECRET_BEDROCK_GUARDRAILS_ARN', label: 'guardrails secret' },
  { id: 'secret-vendor-keys', envVar: 'CCE_SECRET_VENDOR_KEYS_ARN', label: 'vendor-keys secret' },
];

/**
 * DescribeSecret on each known secret ARN. DescribeSecret returns metadata
 * ONLY (name, rotation config, last-rotated/changed timestamps); it does
 * NOT return the secret value, so this never leaks credentials.
 */
async function fetchSecretCards(): Promise<PostureCard[]> {
  const cards: PostureCard[] = [];
  for (const s of SECRETS) {
    const arn = process.env[s.envVar];
    if (!arn) {
      cards.push({
        id: s.id,
        label: s.label,
        status: 'unknown',
        detail: `secret ARN env (${s.envVar}) not set`,
      });
      continue;
    }
    try {
      // DescribeSecret never returns SecretString / SecretBinary.
      const resp = await sm().send(new DescribeSecretCommand({ SecretId: arn }));
      const rotationOn = resp.RotationEnabled === true;
      const lastRotated = resp.LastRotatedDate
        ? resp.LastRotatedDate.toISOString().slice(0, 10)
        : null;
      const lastChanged = resp.LastChangedDate
        ? resp.LastChangedDate.toISOString().slice(0, 10)
        : null;
      const detailParts: string[] = [];
      detailParts.push(rotationOn ? 'rotation schedule on' : 'no rotation schedule');
      if (lastRotated) detailParts.push(`last rotated ${lastRotated}`);
      else if (lastChanged) detailParts.push(`last changed ${lastChanged}`);
      else detailParts.push('never rotated');
      cards.push({
        id: s.id,
        label: s.label,
        // A configured secret with no rotation schedule is amber, not red:
        // many of these are static app secrets where manual rotation is
        // acceptable. Present-and-readable is the baseline 'ok'.
        status: rotationOn ? 'ok' : 'warn',
        detail: detailParts.join(', '),
        value: `…${arnSuffix(arn)}`,
      });
    } catch (err) {
      cards.push({
        id: s.id,
        label: s.label,
        status: 'unknown',
        detail: `describe failed: ${errMsg(err)}`,
      });
    }
  }
  return cards;
}

// ── DynamoDB: point-in-time recovery on key tables ──────────────────

const PITR_TABLES: Array<{ envVar: string; fallback: string }> = [
  { envVar: 'TABLE_AUDIT_LOG', fallback: `${APP_PREFIX}-audit-log` },
  { envVar: 'TABLE_KILL_SWITCHES', fallback: `${APP_PREFIX}-kill-switches` },
  { envVar: 'TABLE_RUNTIME_CONFIG', fallback: `${APP_PREFIX}-runtime-config` },
  { envVar: 'TABLE_SESSIONS', fallback: `${APP_PREFIX}-sessions` },
];

/**
 * DescribeContinuousBackups per key table -> one rollup card
 * 'PITR enabled on N/M tables'. A table we cannot describe is counted as
 * not-confirmed and noted, but does not fail the card.
 */
async function fetchPitrCard(): Promise<PostureCard> {
  const tables = PITR_TABLES.map((t) => process.env[t.envVar] ?? t.fallback);
  let enabled = 0;
  const failures: string[] = [];

  await Promise.all(
    tables.map(async (name) => {
      try {
        const resp = await ddbRaw().send(
          new DescribeContinuousBackupsCommand({ TableName: name }),
        );
        const status =
          resp.ContinuousBackupsDescription?.PointInTimeRecoveryDescription
            ?.PointInTimeRecoveryStatus;
        if (status === 'ENABLED') enabled += 1;
      } catch (err) {
        failures.push(`${name}: ${errMsg(err)}`);
      }
    }),
  );

  const total = tables.length;
  // If every describe failed, we genuinely do not know the state -> amber.
  if (failures.length === total) {
    return {
      id: 'ddb-pitr',
      label: 'DynamoDB PITR',
      status: 'unknown',
      detail: `could not read continuous-backups: ${failures[0] ?? 'unknown error'}`,
    };
  }
  const detail =
    failures.length > 0
      ? `PITR enabled on ${enabled}/${total} key tables (${failures.length} unreadable)`
      : `PITR enabled on ${enabled}/${total} key tables`;
  return {
    id: 'ddb-pitr',
    label: 'DynamoDB PITR',
    status: enabled === total ? 'ok' : enabled > 0 ? 'warn' : 'crit',
    detail,
    value: `${enabled}/${total}`,
  };
}

// ── S3: audit-lock bucket encryption / object-lock / versioning ─────

/**
 * Inspect the audit-lock (WORM) bucket: server-side encryption, object-lock
 * configuration, and versioning. Object lock on the audit bucket is the
 * tamper-evidence control, so a missing lock config is treated as critical.
 */
async function fetchS3Cards(): Promise<PostureCard[]> {
  const bucket = process.env.AUDIT_LOCK_BUCKET;
  if (!bucket) {
    return [
      {
        id: 's3-audit-encrypted',
        label: 'audit bucket encrypted',
        status: 'unknown',
        detail: 'AUDIT_LOCK_BUCKET env not set',
      },
      {
        id: 's3-audit-object-lock',
        label: 'audit bucket object lock',
        status: 'unknown',
        detail: 'AUDIT_LOCK_BUCKET env not set',
      },
    ];
  }

  const cards: PostureCard[] = [];

  // Encryption.
  try {
    const enc = await s3().send(new GetBucketEncryptionCommand({ Bucket: bucket }));
    const rule = enc.ServerSideEncryptionConfiguration?.Rules?.[0];
    const algo = rule?.ApplyServerSideEncryptionByDefault?.SSEAlgorithm;
    cards.push({
      id: 's3-audit-encrypted',
      label: 'audit bucket encrypted',
      status: algo ? 'ok' : 'warn',
      detail: algo ? `default SSE: ${algo}` : 'no default SSE rule found',
      ...(algo ? { value: algo } : {}),
    });
  } catch (err) {
    cards.push({
      id: 's3-audit-encrypted',
      label: 'audit bucket encrypted',
      status: 'unknown',
      detail: `encryption config unavailable: ${errMsg(err)}`,
    });
  }

  // Object lock (and versioning, which object lock requires).
  try {
    const [lock, ver] = await Promise.all([
      s3().send(new GetObjectLockConfigurationCommand({ Bucket: bucket })),
      s3()
        .send(new GetBucketVersioningCommand({ Bucket: bucket }))
        .catch(() => ({ Status: undefined })),
    ]);
    const lockEnabled =
      lock.ObjectLockConfiguration?.ObjectLockEnabled === 'Enabled';
    const versioning = (ver as { Status?: string }).Status === 'Enabled';
    const mode =
      lock.ObjectLockConfiguration?.Rule?.DefaultRetention?.Mode;
    const detailParts: string[] = [];
    detailParts.push(lockEnabled ? 'object lock enabled' : 'object lock NOT enabled');
    if (mode) detailParts.push(`retention mode ${mode}`);
    detailParts.push(versioning ? 'versioning on' : 'versioning off');
    cards.push({
      id: 's3-audit-object-lock',
      label: 'audit bucket object lock',
      status: lockEnabled && versioning ? 'ok' : 'crit',
      detail: detailParts.join(', '),
    });
  } catch (err) {
    // GetObjectLockConfiguration throws ObjectLockConfigurationNotFoundError
    // when lock was never configured. That is a real (critical) finding for
    // the audit bucket, but a generic access error is just 'unknown'.
    const msg = errMsg(err);
    const notConfigured = /ObjectLockConfigurationNotFound/i.test(msg);
    cards.push({
      id: 's3-audit-object-lock',
      label: 'audit bucket object lock',
      status: notConfigured ? 'crit' : 'unknown',
      detail: notConfigured
        ? 'object lock is not configured on the audit bucket'
        : `object-lock config unavailable: ${msg}`,
    });
  }

  return cards;
}

// ── Snapshot assembly + short in-memory cache ───────────────────────

const CACHE_TTL_MS = 30_000;
let _cache: { at: number; cards: PostureCard[] } | null = null;

/**
 * Assemble the full security-posture card set. Each source has its own
 * try/catch wrapper (above), so one denied permission degrades a card
 * rather than the whole snapshot. Result is cached for CACHE_TTL_MS to
 * avoid throttling KMS / Secrets Manager on repeated dashboard polls.
 */
export async function getSecurityPosture(
  opts: { force?: boolean } = {},
): Promise<PostureCard[]> {
  const now = Date.now();
  if (!opts.force && _cache && now - _cache.at < CACHE_TTL_MS) {
    return _cache.cards;
  }

  const groups = await Promise.all([
    fetchKmsCards().catch((err) => {
      logger.warn({ errMessage: errMsg(err) }, 'posture: kms group failed');
      return [
        {
          id: 'kms',
          label: 'KMS rotation',
          status: 'unknown',
          detail: `kms posture unavailable: ${errMsg(err)}`,
        } satisfies PostureCard,
      ];
    }),
    fetchSecretCards().catch((err) => {
      logger.warn({ errMessage: errMsg(err) }, 'posture: secrets group failed');
      return [
        {
          id: 'secrets',
          label: 'secrets metadata',
          status: 'unknown',
          detail: `secrets posture unavailable: ${errMsg(err)}`,
        } satisfies PostureCard,
      ];
    }),
    fetchPitrCard()
      .then((c) => [c])
      .catch((err) => {
        logger.warn({ errMessage: errMsg(err) }, 'posture: pitr group failed');
        return [
          {
            id: 'ddb-pitr',
            label: 'DynamoDB PITR',
            status: 'unknown',
            detail: `pitr posture unavailable: ${errMsg(err)}`,
          } satisfies PostureCard,
        ];
      }),
    fetchS3Cards().catch((err) => {
      logger.warn({ errMessage: errMsg(err) }, 'posture: s3 group failed');
      return [
        {
          id: 's3-audit',
          label: 'audit bucket',
          status: 'unknown',
          detail: `s3 posture unavailable: ${errMsg(err)}`,
        } satisfies PostureCard,
      ];
    }),
  ]);

  const cards = groups.flat();
  _cache = { at: now, cards };
  return cards;
}
