/**
 * Operator handover building blocks (IaC readiness plan, item 45).
 * scripts/handover.ts is the CLI orchestration; everything substantial and
 * testable lives here with INJECTED clients, so unit tests run on fakes
 * with zero AWS calls — the same split as teardown-plan.ts.
 *
 * The shape of the problem:
 *
 *  - INVENTORY: the complete state picture an incoming operator needs —
 *    account/region/tier/mode and deployed version from the manifest,
 *    stack list, domain, configured surfaces (secret POPULATION judged
 *    from DescribeSecret METADATA only, values are never read), feature
 *    flags, the six secret paths, state-bucket location, intentional
 *    residuals (WORM bucket), and the out-of-band catalog.
 *  - ACCESS TRANSFER: account-level state that breaks transfers even when
 *    app secrets rotate cleanly. API-checked where AWS exposes it
 *    (Route 53 nameserver authority, SES identities, SNS subscription
 *    confirmations), checklist-gated where it doesn't.
 *  - CREDENTIAL CLASSIFICATION, split honestly by who can act:
 *    COMMAND-OWNED rotations this tool performs (dashboard token / PIN
 *    hash / kill phrase via PutSecretValue; access keys ONLY of IAM users
 *    tagged app=claudeclaw) versus EXTERNAL reissues only a human can do
 *    (Slack app, Telegram BotFather, CodeBuild PAT, registrar, vendor
 *    keys). The external class BLOCKS completion until the newly issued
 *    values are supplied and verified live — the tool never pretends to
 *    rotate what it cannot reach.
 *  - CONFIG EPOCH: handover stamps state/config-epoch.json so the
 *    departing operator's stale .env can never silently re-point owner
 *    IDs — doctor/deploy FAIL on a mismatch until the new operator
 *    re-runs setup against the recorded state.
 *
 * Handover is a LOCKED mutating lifecycle operation (operation
 * 'handover', plan item 14): lock + heartbeat, every mutation journaled
 * with the fencing token, --dry-run prints everything with zero
 * mutations (it reuses teardown-plan's StepRunner).
 */

import { createHash, randomBytes, randomInt } from 'node:crypto';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import type { AwsClientLike, LockHandle } from './lock.js';
import { appendJournal, s3BodyToString } from './journal.js';
import type { DeployManifest } from './manifest.js';
import type { StateMeta } from './bootstrap-state.js';
import { type CatalogEntry, type StepRunner } from './teardown-plan.js';

// ─────────────────────────────────────────────────────────────────────
// Config epoch — the post-handover authority enforcement
// ─────────────────────────────────────────────────────────────────────

/** State-bucket object stamped at handover completion. */
export const CONFIG_EPOCH_KEY = 'state/config-epoch.json';

export interface ConfigEpochRecord {
  /** Monotonic: n+1 on every completed handover. 0 = never handed over. */
  epoch: number;
  completedAt: string;
  /**
   * sha256 of the incoming operator's owner identity (Telegram chat ids +
   * Slack user ids). A HASH on purpose: the state bucket must never hold
   * raw chat ids, but doctor can still prove which owner config the epoch
   * was stamped for.
   */
  newOwnerLabelHash: string;
}

export function hashOwnerIdentity(parts: string[]): string {
  return createHash('sha256')
    .update(parts.map((p) => p.trim()).filter((p) => p !== '').sort().join('\n'))
    .digest('hex');
}

function is404(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } } | null;
  return (
    e?.name === 'NoSuchKey' ||
    e?.name === 'NotFound' ||
    e?.name === 'NoSuchBucket' ||
    e?.$metadata?.httpStatusCode === 404
  );
}

/** Current epoch record, or null when no handover has ever completed. */
export async function readConfigEpoch(
  s3: AwsClientLike,
  bucket: string,
): Promise<ConfigEpochRecord | null> {
  let res: { Body?: unknown };
  try {
    res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: CONFIG_EPOCH_KEY }));
  } catch (err) {
    if (is404(err)) return null;
    throw err;
  }
  const raw = JSON.parse(await s3BodyToString(res.Body)) as Partial<ConfigEpochRecord>;
  if (typeof raw.epoch !== 'number' || !Number.isInteger(raw.epoch)) {
    throw new Error(
      `state object ${CONFIG_EPOCH_KEY} is malformed (no integer "epoch"); refusing to guess`,
    );
  }
  return raw as ConfigEpochRecord;
}

export interface StampEpochOptions {
  /** The HELD handover lock. Stamping without the lock is a bug. */
  lock: LockHandle | null;
  /** Set true only after the owner-path verification succeeded. */
  ownerPathsVerified: boolean;
  handoverId: string;
  /** Journal sequence number for the epoch event. */
  seq: number;
  newOwnerLabelHash: string;
  runner: StepRunner;
  now?: () => Date;
}

/**
 * Stamp the new config epoch (n+1) and journal it. HARD PRECONDITIONS:
 * the lifecycle lock must be held and the incoming operator's owner
 * paths must already be verified — the epoch is the "handover complete"
 * record, and writing it early would let doctor bless a half-finished
 * transfer. Mutations route through the StepRunner so --dry-run can
 * print them without executing (the CLI never reaches this step in a
 * dry run, but the invariant is enforced here, not by callers).
 */
export async function stampConfigEpoch(
  s3: AwsClientLike,
  bucket: string,
  opts: StampEpochOptions,
): Promise<ConfigEpochRecord> {
  if (!opts.lock) {
    throw new Error(
      'stampConfigEpoch: the handover lifecycle lock is not held — the config epoch may ' +
        'only be written under the lock (a stale holder must never re-stamp authority)',
    );
  }
  if (!opts.ownerPathsVerified) {
    throw new Error(
      'stampConfigEpoch: owner-path verification has not succeeded — the epoch is the ' +
        '"handover complete" record and must never be written before the incoming operator ' +
        'verifiably receives owner-only traffic',
    );
  }
  const current = await readConfigEpoch(s3, bucket);
  const record: ConfigEpochRecord = {
    epoch: (current?.epoch ?? 0) + 1,
    completedAt: (opts.now?.() ?? new Date()).toISOString(),
    newOwnerLabelHash: opts.newOwnerLabelHash,
  };
  await opts.runner.mutate(
    `s3:PutObject s3://${bucket}/${CONFIG_EPOCH_KEY} (epoch ${record.epoch})`,
    () =>
      s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: CONFIG_EPOCH_KEY,
          Body: JSON.stringify(record, null, 2) + '\n',
          ContentType: 'application/json',
          Metadata: { 'fencing-token': String(opts.lock?.fencingToken ?? '') },
        }),
      ),
  );
  await opts.runner.mutate(
    `journal: config-epoch event (handover ${opts.handoverId}, seq ${opts.seq})`,
    () =>
      appendJournal(s3, bucket, {
        deployId: opts.handoverId,
        seq: opts.seq,
        event: 'config-epoch',
        at: record.completedAt,
        fencingToken: opts.lock?.fencingToken ?? 0,
        data: { epoch: record.epoch, newOwnerLabelHash: record.newOwnerLabelHash },
      }),
  );
  return record;
}

// ─────────────────────────────────────────────────────────────────────
// Secret inventory — DescribeSecret METADATA only, never values
// ─────────────────────────────────────────────────────────────────────

/** The six secret leaves under /claudeclaw<suffix>/ (mirrors preflight). */
export const HANDOVER_SECRET_LEAVES: readonly string[] = [
  'slack',
  'telegram',
  'dashboard',
  'db-encryption',
  'bedrock-guardrails',
  'vendor-keys',
] as const;

export interface SecretDescribeLike {
  Name?: string;
  CreatedDate?: Date | string;
  LastChangedDate?: Date | string;
  DeletedDate?: Date | string;
}

export interface SecretsHandoverClientLike {
  describeSecret(input: { SecretId: string }): Promise<SecretDescribeLike>;
  putSecretValue(input: { SecretId: string; SecretString: string }): Promise<unknown>;
}

export type SecretPopulation = 'populated' | 'placeholder-likely' | 'pending-deletion' | 'absent';

function toMs(d: Date | string | undefined): number | null {
  if (d == null) return null;
  const ms = d instanceof Date ? d.getTime() : Date.parse(d);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Judge whether a secret has ever been populated from METADATA ONLY (the
 * inventory never calls GetSecretValue). CDK creates every secret with
 * REPLACE_ME placeholders; setup/deploy then write real values, which
 * moves LastChangedDate past CreatedDate. A secret whose LastChangedDate
 * still hugs its CreatedDate has most likely never been populated. This
 * is a stated heuristic, not a proof — the report says so.
 */
export function secretPopulationStatus(
  d: SecretDescribeLike | null,
  thresholdMs = 60_000,
): SecretPopulation {
  if (d === null) return 'absent';
  if (d.DeletedDate != null) return 'pending-deletion';
  const created = toMs(d.CreatedDate);
  const changed = toMs(d.LastChangedDate);
  if (created === null || changed === null) return 'placeholder-likely';
  return changed - created > thresholdMs ? 'populated' : 'placeholder-likely';
}

export interface SecretInventoryRow {
  secretId: string;
  population: SecretPopulation;
  lastChanged?: string;
}

/** Describe all six secrets; a missing secret is 'absent', never an error. */
export async function inventorySecrets(
  secrets: SecretsHandoverClientLike,
  secretBase: string,
): Promise<SecretInventoryRow[]> {
  const rows: SecretInventoryRow[] = [];
  for (const leaf of HANDOVER_SECRET_LEAVES) {
    const secretId = `${secretBase}/${leaf}`;
    let described: SecretDescribeLike | null = null;
    try {
      described = await secrets.describeSecret({ SecretId: secretId });
    } catch (err) {
      if ((err as { name?: string }).name !== 'ResourceNotFoundException') throw err;
    }
    const changed = toMs(described?.LastChangedDate);
    rows.push({
      secretId,
      population: secretPopulationStatus(described),
      ...(changed !== null ? { lastChanged: new Date(changed).toISOString() } : {}),
    });
  }
  return rows;
}

// ─────────────────────────────────────────────────────────────────────
// The inventory report
// ─────────────────────────────────────────────────────────────────────

export interface HandoverInventoryInput {
  meta: StateMeta | null;
  manifest: DeployManifest | null;
  stateBucket: string;
  domain: string;
  secretBase: string;
  secrets: SecretInventoryRow[];
  catalog: CatalogEntry[];
  /** WORM audit bucket name when tier ≥ 2, else undefined. */
  wormBucket?: string;
}

export function renderInventory(input: HandoverInventoryInput): string[] {
  const lines: string[] = [];
  lines.push('STATE INVENTORY (what the incoming operator takes over)');
  const m = input.manifest;
  lines.push(
    `  account/region: ${input.meta?.account ?? m?.account ?? 'unknown'} / ${input.meta?.region ?? m?.region ?? 'unknown'}`,
  );
  lines.push(
    `  tier/mode:      tier ${input.meta?.tier ?? m?.tier ?? '?'} · mode ${input.meta?.mode ?? m?.mode ?? '?'}`,
  );
  if (m) {
    lines.push(`  deployed:       ${m.deployId} (git ${m.gitSha.slice(0, 12)}, image ${m.imageTag}, at ${m.deployedAt})`);
    lines.push(`  stacks:         ${m.stacks.join(', ')}`);
    const flags = Object.entries(m.featureFlags ?? {})
      .map(([k, v]) => `${k}=${v ? 'on' : 'off'}`)
      .join(' · ');
    lines.push(`  feature flags:  ${flags || '(none recorded)'}`);
  } else {
    lines.push('  deployed:       NO MANIFEST PROMOTED (fresh or broken state bucket)');
  }
  lines.push(`  domain:         ${input.domain || '(none — tunnel/infra-only access)'}`);
  lines.push(`  state bucket:   s3://${input.stateBucket} (manifests, journals, config epoch)`);
  lines.push('  secrets (population judged from DescribeSecret metadata only — values never read):');
  for (const row of input.secrets) {
    lines.push(
      `    ${row.secretId.padEnd(40)} ${row.population}` +
        (row.lastChanged ? ` (last changed ${row.lastChanged})` : ''),
    );
  }
  const surfaces: string[] = [];
  for (const row of input.secrets) {
    if (row.population !== 'populated') continue;
    if (row.secretId.endsWith('/slack')) surfaces.push('Slack');
    if (row.secretId.endsWith('/telegram')) surfaces.push('Telegram');
  }
  lines.push(`  configured surfaces: ${surfaces.join(', ') || '(none populated — infra-only?)'}`);
  if (input.wormBucket) {
    lines.push(
      `  INTENTIONAL RESIDUAL: s3://${input.wormBucket} (WORM audit bucket, Object Lock ` +
        'governance retention) — it does NOT transfer ownership semantics; the audit history ' +
        'stays where it is and the new operator inherits it as-is.',
    );
  }
  lines.push('  out-of-band resources (docs/out-of-band-catalog.json — CDK does not know these):');
  for (const e of input.catalog) {
    lines.push(`    [${e.ownership}] ${e.kind} ${e.nameOrPattern} (created by ${e.createdBy})`);
  }
  return lines;
}

// ─────────────────────────────────────────────────────────────────────
// Access-transfer checklist + the three API-checked reads
// ─────────────────────────────────────────────────────────────────────

/**
 * Account-level access that must change hands and that NO API can
 * transfer for you. Printed every run; the operator works the list.
 */
export const ACCESS_TRANSFER_CHECKLIST: readonly string[] = [
  'AWS account ROOT credentials + billing + security alternate contacts (Console → Account): re-point email/phone to the incoming operator.',
  'IAM / SSO human users: create the incoming operator their own identity; disable the departing operator\'s. Handover NEVER touches human identities programmatically.',
  'GitHub repository: transfer or grant admin on the repo (and update branch protection / deploy environments).',
  'Slack app OWNERSHIP: transfer the app in the Slack workspace admin (api.slack.com/apps) — token rotation alone does not move ownership.',
  'Telegram bot: transfer via @BotFather (/mybots → Transfer Bot Ownership) or reissue the token to the new owner.',
  'Domain registrar + Route 53 NAMESERVER authority: the registrar may sit OUTSIDE AWS — whoever controls the NS records controls the domain, regardless of the hosted zone.',
  'ACM DNS-validation records: certificates renew only while the validation CNAMEs stay in DNS the new operator controls.',
  'SES identities / DKIM / MAIL-FROM: re-verify or transfer sending identities; DKIM CNAMEs live in the (possibly external) DNS.',
  'SNS subscription confirmations: PENDING confirmations email the OLD operator — re-subscribe the new alert addresses and confirm from the NEW inbox.',
  'CodeBuild source credential: the GitHub PAT is account-level (one per provider per account/region) and scoped to the OLD operator\'s GitHub identity — reissue it.',
] as const;

export interface Route53HandoverClientLike {
  listHostedZonesByName(input: { DNSName: string }): Promise<{
    HostedZones?: Array<{ Id?: string; Name?: string }>;
  }>;
  getHostedZone(input: { Id: string }): Promise<{
    DelegationSet?: { NameServers?: string[] };
  }>;
}

/**
 * API check 1: Route 53 hosted zone + the nameservers the registrar must
 * point at. The registrar itself is outside AWS — this read names exactly
 * what the registrar transfer has to preserve.
 */
export async function route53NameserverReport(
  route53: Route53HandoverClientLike,
  domain: string,
): Promise<string[]> {
  if (!domain) return ['Route 53: no DOMAIN_NAME configured — nameserver authority check skipped.'];
  const out = await route53.listHostedZonesByName({ DNSName: domain });
  const fqdn = `${domain.toLowerCase().replace(/\.$/, '')}.`;
  const zone = (out.HostedZones ?? []).find((z) => {
    const name = (z.Name ?? '').toLowerCase();
    return name !== '' && fqdn.endsWith(name);
  });
  if (!zone?.Id) {
    return [
      `Route 53: NO hosted zone covers ${domain} — DNS authority is entirely outside this account; transfer it at the registrar/DNS host.`,
    ];
  }
  const detail = await route53.getHostedZone({ Id: zone.Id });
  const ns = detail.DelegationSet?.NameServers ?? [];
  return [
    `Route 53: hosted zone ${zone.Name} covers ${domain}.`,
    `  Registrar MUST keep pointing at these nameservers (verify at the registrar, which may be outside AWS):`,
    ...ns.map((n) => `    - ${n}`),
  ];
}

export interface SesHandoverClientLike {
  listIdentities(input: Record<string, never>): Promise<{ Identities?: string[] }>;
  getIdentityVerificationAttributes(input: { Identities: string[] }): Promise<{
    VerificationAttributes?: Record<string, { VerificationStatus?: string }>;
  }>;
}

/** API check 2: SES identities + verification status. */
export async function sesIdentityReport(ses: SesHandoverClientLike): Promise<string[]> {
  const out = await ses.listIdentities({});
  const identities = out.Identities ?? [];
  if (identities.length === 0) return ['SES: no sending identities in this account/region.'];
  const attrs = await ses.getIdentityVerificationAttributes({ Identities: identities });
  return [
    'SES sending identities (DKIM/MAIL-FROM DNS records must survive the registrar transfer):',
    ...identities.map((id) => {
      const status = attrs.VerificationAttributes?.[id]?.VerificationStatus ?? 'Unknown';
      return `  - ${id}: ${status}`;
    }),
  ];
}

export interface SnsHandoverClientLike {
  listSubscriptionsByTopic(input: { TopicArn: string }): Promise<{
    Subscriptions?: Array<{ SubscriptionArn?: string; Protocol?: string; Endpoint?: string }>;
  }>;
}

/**
 * API check 3: SNS alert subscriptions. PENDING confirmations are the
 * trap — the confirmation email went to the OLD operator's inbox.
 */
export async function snsSubscriptionReport(
  sns: SnsHandoverClientLike,
  topicArn: string,
): Promise<string[]> {
  if (!topicArn) return ['SNS: no alert topic ARN configured — subscription check skipped.'];
  const out = await sns.listSubscriptionsByTopic({ TopicArn: topicArn });
  const subs = out.Subscriptions ?? [];
  if (subs.length === 0) return [`SNS: topic ${topicArn} has NO subscriptions — alerts go nowhere.`];
  const lines = [`SNS alert subscriptions on ${topicArn}:`];
  for (const s of subs) {
    const pending = s.SubscriptionArn === 'PendingConfirmation';
    lines.push(
      `  - ${s.Protocol ?? '?'} ${s.Endpoint ?? '?'}${
        pending
          ? '  ← PENDING CONFIRMATION: the confirm email went to the OLD operator; re-subscribe and confirm from the NEW inbox'
          : ''
      }`,
    );
  }
  return lines;
}

// ─────────────────────────────────────────────────────────────────────
// Credential classification — command-owned vs external
// ─────────────────────────────────────────────────────────────────────

/** Tag that marks an IAM user as app-owned and therefore rotatable here. */
export const APP_IAM_TAG = { key: 'app', value: 'claudeclaw' } as const;

export interface IamUserWithTags {
  userName: string;
  tags: Array<{ key: string; value: string }>;
}

export interface IamUserClassification {
  /** Tagged app=claudeclaw: this tool may rotate their access keys. */
  appOwned: string[];
  /** Everyone else: human/SSO/untagged — access-transfer checklist only. */
  checklistOnly: string[];
}

/**
 * Split IAM users by the app tag. ONLY tagged app=claudeclaw users are
 * rotation candidates; human identities, SSO, and anything untagged are
 * never touched programmatically — they are checklist items.
 */
export function classifyIamUsers(users: IamUserWithTags[]): IamUserClassification {
  const appOwned: string[] = [];
  const checklistOnly: string[] = [];
  for (const u of users) {
    const tagged = u.tags.some((t) => t.key === APP_IAM_TAG.key && t.value === APP_IAM_TAG.value);
    (tagged ? appOwned : checklistOnly).push(u.userName);
  }
  return { appOwned, checklistOnly };
}

export interface IamHandoverClientLike {
  listUsers(input: { Marker?: string }): Promise<{
    Users?: Array<{ UserName?: string }>;
    IsTruncated?: boolean;
    Marker?: string;
  }>;
  listUserTags(input: { UserName: string }): Promise<{
    Tags?: Array<{ Key?: string; Value?: string }>;
  }>;
  listAccessKeys(input: { UserName: string }): Promise<{
    AccessKeyMetadata?: Array<{ AccessKeyId?: string; Status?: string }>;
  }>;
  createAccessKey(input: { UserName: string }): Promise<{
    AccessKey?: { AccessKeyId?: string; SecretAccessKey?: string };
  }>;
  deleteAccessKey(input: { UserName: string; AccessKeyId: string }): Promise<unknown>;
}

/** List every IAM user with their tags (paginated). */
export async function listIamUsersWithTags(iam: IamHandoverClientLike): Promise<IamUserWithTags[]> {
  const users: IamUserWithTags[] = [];
  let marker: string | undefined;
  do {
    const page = await iam.listUsers({ Marker: marker });
    for (const u of page.Users ?? []) {
      if (!u.UserName) continue;
      const tagsOut = await iam.listUserTags({ UserName: u.UserName });
      users.push({
        userName: u.UserName,
        tags: (tagsOut.Tags ?? []).map((t) => ({ key: t.Key ?? '', value: t.Value ?? '' })),
      });
    }
    marker = page.IsTruncated ? page.Marker : undefined;
  } while (marker !== undefined);
  return users;
}

export interface RotatedAccessKey {
  userName: string;
  newAccessKeyId: string;
  newSecretAccessKey: string;
  deletedKeyIds: string[];
}

/**
 * Rotate access keys for APP-OWNED users only: create the new key first,
 * then delete every old one. The caller must hand the new key material to
 * the incoming operator — it is returned, never stored anywhere.
 */
export async function rotateAppOwnedAccessKeys(
  iam: IamHandoverClientLike,
  classification: IamUserClassification,
  runner: StepRunner,
): Promise<RotatedAccessKey[]> {
  const rotated: RotatedAccessKey[] = [];
  for (const userName of classification.appOwned) {
    const existing = await iam.listAccessKeys({ UserName: userName });
    const oldIds = (existing.AccessKeyMetadata ?? [])
      .map((k) => k.AccessKeyId ?? '')
      .filter((id) => id !== '');
    let created: { AccessKeyId?: string; SecretAccessKey?: string } | undefined;
    await runner.mutate(`iam:CreateAccessKey ${userName} (app-owned, tag ${APP_IAM_TAG.key}=${APP_IAM_TAG.value})`, async () => {
      const res = await iam.createAccessKey({ UserName: userName });
      created = res.AccessKey;
    });
    for (const oldId of oldIds) {
      await runner.mutate(`iam:DeleteAccessKey ${userName}/${oldId} (departing operator's key)`, () =>
        iam.deleteAccessKey({ UserName: userName, AccessKeyId: oldId }),
      );
    }
    rotated.push({
      userName,
      newAccessKeyId: created?.AccessKeyId ?? '(dry-run)',
      newSecretAccessKey: created?.SecretAccessKey ?? '(dry-run)',
      deletedKeyIds: oldIds,
    });
  }
  return rotated;
}

// ─────────────────────────────────────────────────────────────────────
// Command-owned rotation: the dashboard secret
// ─────────────────────────────────────────────────────────────────────

export interface DashboardSecretValues {
  token: string;
  killPhrase: string;
  /** Shown ONCE to the incoming operator; only its hash is stored. */
  pin: string;
  pinHash: string;
}

const KILL_PHRASE_WORDS = [
  'amber', 'basalt', 'cedar', 'delta', 'ember', 'falcon', 'granite', 'harbor',
  'indigo', 'juniper', 'krypton', 'lantern', 'meridian', 'nimbus', 'onyx', 'pylon',
  'quartz', 'rampart', 'sierra', 'tundra', 'umbra', 'vertex', 'willow', 'zenith',
] as const;

/**
 * Fresh random values for the dashboard secret: bearer token, emergency
 * kill phrase, and a 6-digit PIN stored as a sha256 hex hash (the secret
 * field is `pin_hash`; the raw PIN exists only in the completion output
 * handed to the incoming operator).
 */
export function generateDashboardSecretValues(
  random: (bytes: number) => Buffer = randomBytes,
  pickInt: (maxExclusive: number) => number = (max) => randomInt(max),
): DashboardSecretValues {
  const token = random(32).toString('hex');
  const killPhrase = Array.from({ length: 4 }, () => KILL_PHRASE_WORDS[pickInt(KILL_PHRASE_WORDS.length)]).join('-');
  const pin = String(pickInt(1_000_000)).padStart(6, '0');
  const pinHash = createHash('sha256').update(pin).digest('hex');
  return { token, killPhrase, pin, pinHash };
}

/**
 * COMMAND-OWNED rotation: write the new {token, kill_phrase, pin_hash}
 * object to the dashboard secret. The running tasks keep their injected
 * old values until the forced ECS redeploy — which is exactly why the
 * redeploy is a mandatory later step.
 */
export async function rotateDashboardSecret(
  secrets: SecretsHandoverClientLike,
  secretId: string,
  values: DashboardSecretValues,
  runner: StepRunner,
): Promise<void> {
  await runner.mutate(`secretsmanager:PutSecretValue ${secretId} (new token + kill phrase + PIN hash)`, () =>
    secrets.putSecretValue({
      SecretId: secretId,
      SecretString: JSON.stringify({
        token: values.token,
        kill_phrase: values.killPhrase,
        pin_hash: values.pinHash,
      }),
    }),
  );
}

// ─────────────────────────────────────────────────────────────────────
// External reissues — the verified gate that BLOCKS completion
// ─────────────────────────────────────────────────────────────────────

export interface ExternalVerification {
  ok: boolean;
  /** Human-readable success detail (bot username, workspace, ...). */
  detail?: string;
  error?: string;
}

export interface ExternalCredentialSpec {
  /** Key in the answers file / prompt loop. */
  id: string;
  label: string;
  /**
   * Required specs block completion; optional ones (vendor keys) are
   * checklist-reminded but a deployment without them is still coherent.
   */
  required: boolean;
  /** LIVE verification of the newly issued value (getMe / auth.test / ...). */
  verify: (value: string) => Promise<ExternalVerification>;
}

/** Reissues only a human can perform; printed before the gate runs. */
export const EXTERNAL_REISSUE_CHECKLIST: readonly string[] = [
  'Telegram: issue a NEW bot token via @BotFather (/token) under the incoming operator\'s account.',
  'Slack: reissue the app credentials (or transfer app ownership and reinstall) so the bot token belongs to the incoming operator.',
  'CodeBuild GitHub PAT: the incoming operator creates their own PAT and re-imports it (aws codebuild import-source-credentials).',
  'Domain registrar: transfer the registrar account / domain to the incoming operator (outside AWS entirely).',
  'Vendor API keys (Tavily/Brave/Exa/Serper/Gemini): reissue under the incoming operator\'s vendor accounts and update the vendor-keys secret.',
] as const;

export interface ExternalGateResult {
  /** True only when EVERY required credential was supplied and verified. */
  complete: boolean;
  verified: Array<{ id: string; detail?: string }>;
  missing: string[];
  failed: Array<{ id: string; error: string }>;
}

/**
 * The completion gate: every REQUIRED external credential must be
 * supplied (prompt or --answers file) and verified live. The tool never
 * pretends to rotate what it cannot reach — an unsupplied or unverified
 * value keeps `complete` false, and the orchestrator must refuse to
 * stamp the epoch.
 */
export async function runExternalCredentialGate(
  specs: ExternalCredentialSpec[],
  supplied: Record<string, string | undefined>,
): Promise<ExternalGateResult> {
  const verified: Array<{ id: string; detail?: string }> = [];
  const missing: string[] = [];
  const failed: Array<{ id: string; error: string }> = [];
  for (const spec of specs) {
    const value = (supplied[spec.id] ?? '').trim();
    if (value === '') {
      if (spec.required) missing.push(spec.id);
      continue;
    }
    const result = await spec.verify(value);
    if (result.ok) {
      verified.push({ id: spec.id, ...(result.detail ? { detail: result.detail } : {}) });
    } else {
      failed.push({ id: spec.id, error: result.error ?? 'verification failed' });
    }
  }
  return { complete: missing.length === 0 && failed.length === 0, verified, missing, failed };
}

// ─────────────────────────────────────────────────────────────────────
// Redeploy + owner-path verification
// ─────────────────────────────────────────────────────────────────────

export interface EcsHandoverClientLike {
  updateService(input: {
    cluster: string;
    service: string;
    forceNewDeployment: boolean;
  }): Promise<unknown>;
}

/**
 * Force an ECS redeploy so the rotated secret values are actually
 * injected — secrets resolve at TASK START, so without this the old
 * values keep serving indefinitely.
 */
export async function forceServiceRedeploy(
  ecs: EcsHandoverClientLike,
  cluster: string,
  service: string,
  runner: StepRunner,
): Promise<void> {
  await runner.mutate(
    `ecs:UpdateService ${cluster}/${service} forceNewDeployment (rotated secrets inject at task start)`,
    () => ecs.updateService({ cluster, service, forceNewDeployment: true }),
  );
}

export type TelegramSendFn = (
  token: string,
  chatId: string,
  text: string,
) => Promise<{ ok: boolean; error?: string }>;

export interface OwnerPathVerification {
  ok: boolean;
  lines: string[];
}

/**
 * Verify the owner-only paths reach the INCOMING operator: a real
 * Telegram sendMessage to every new owner chat id with the NEW bot
 * token. SNS e-mail alerts cannot be machine-verified end-to-end
 * (confirmation + delivery land in a human inbox), so that half is an
 * explicit printed manual step, not a fake green check.
 */
export async function verifyOwnerPaths(opts: {
  newTelegramToken?: string;
  newOwnerChatIds: string[];
  send: TelegramSendFn;
  alertTopicArn?: string;
}): Promise<OwnerPathVerification> {
  const lines: string[] = [];
  let ok = true;
  if (opts.newTelegramToken && opts.newOwnerChatIds.length > 0) {
    for (const chatId of opts.newOwnerChatIds) {
      const res = await opts.send(
        opts.newTelegramToken,
        chatId,
        'ClaudeClaw handover: this chat is now registered as an OWNER chat. ' +
          'If you are not the incoming operator, reply STOP and contact your admin.',
      );
      if (res.ok) {
        lines.push(`telegram owner path → chat ${chatId}: delivered`);
      } else {
        ok = false;
        lines.push(`telegram owner path → chat ${chatId}: FAILED (${res.error ?? 'unknown'})`);
      }
    }
  } else if (opts.newOwnerChatIds.length > 0) {
    ok = false;
    lines.push('telegram owner path: owner chat ids supplied but no new bot token — cannot verify');
  } else {
    lines.push('telegram owner path: no owner chat ids configured — skipped (infra-only install?)');
  }
  lines.push(
    'SNS alert path (MANUAL STEP — not machine-verifiable end-to-end): subscribe the incoming ' +
      `operator's email on ${opts.alertTopicArn ?? 'the ops alert topic'}, confirm from THEIR inbox, ` +
      'then send a test publish (aws sns publish --topic-arn <arn> --message "handover test") and ' +
      'confirm receipt before treating alerts as transferred.',
  );
  return { ok, lines };
}

// ─────────────────────────────────────────────────────────────────────
// Owner identity section (env re-pointing + the OIDC trap)
// ─────────────────────────────────────────────────────────────────────

export function ownerIdentityNotes(opts: {
  githubOwner?: string;
  githubRepo?: string;
}): string[] {
  const repo =
    opts.githubOwner && opts.githubRepo ? `${opts.githubOwner}/${opts.githubRepo}` : '<owner>/<repo>';
  return [
    'OWNER IDENTITY (the easiest thing to miss):',
    '  - Re-point CCE_OWNER_TELEGRAM_CHATS and CCE_OWNER_SLACK_USERS to the INCOMING operator\'s ids.',
    '  - Re-point CCE_OPERATOR_TELEGRAM_CHAT_ID (webhook-monitor alerts).',
    '  - Keep CCE_OWNER_LABEL UNCHANGED: the label aliases the owner ROLE, so the memory history',
    '    stays attached to the role rather than the departing person.',
    '  - Update the SNS alert-email subscriptions (see the SNS report above).',
    `  - OIDC TRAP: if the GitHub repo changes org/owner, the IAM trust policy's sub condition`,
    `    still pins the OLD ${repo} — CI deploys break SILENTLY until the trust condition and`,
    '    CCE_GITHUB_OWNER/CCE_GITHUB_REPO are updated TOGETHER.',
  ];
}
