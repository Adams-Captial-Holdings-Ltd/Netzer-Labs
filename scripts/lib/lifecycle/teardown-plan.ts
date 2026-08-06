/**
 * Teardown planning + execution building blocks (IaC readiness plan,
 * items 23–26). scripts/teardown.ts is the CLI orchestration; everything
 * substantial and testable lives here with INJECTED clients, so unit tests
 * run on fakes with zero AWS calls.
 *
 * The shape of the problem:
 *
 *  - INVENTORY comes from four sources, combined: live CloudFormation
 *    stacks by prefix + tags, the deploy manifest's recorded stack list
 *    (when the state bucket is reachable), the committed out-of-band
 *    resource catalog (docs/out-of-band-catalog.json), and a name-prefix
 *    scan fallback. Stacks to destroy are enumerated from LIVE CFN plus
 *    the manifest — explicitly NOT from a fresh synth, which silently
 *    omits stacks whose opt-in flags have since changed (CodeBuild
 *    enabled at deploy, off today). Stacks absent from the current app
 *    fall back to a direct DeleteStack.
 *  - CLASSIFICATION separates app-owned resources (deletable) from
 *    SHARED ACCOUNT PREREQUISITES (GitHub OIDC provider, CodeBuild source
 *    credential, CDK bootstrap stack), which are report-only by default.
 *  - KMS keys are DEPENDENCIES, not leftovers (item 24): deletion is
 *    blocked until every encrypted dependent is gone AND the operator
 *    explicitly opts into cryptographic erasure.
 *  - BREAK-GLASS (item 25): a missing state bucket degrades the plan to
 *    CFN + tags + prefix + catalog, never blocks it — teardown must not
 *    strand paid resources behind a lost state store.
 *  - WORM (item 26): the audit-lock bucket is an INTENTIONAL RESIDUAL
 *    with bypass-governance instructions, not a failure.
 *
 * Clients are injected as method-shaped structural interfaces matching the
 * SDK's aggregated classes (`new CloudFormation(...)` etc.), the same
 * pattern as EcrClientLike in bootstrap-state.ts.
 */

// ─────────────────────────────────────────────────────────────────────
// Out-of-band catalog (docs/out-of-band-catalog.json)
// ─────────────────────────────────────────────────────────────────────

export type CatalogCreatedBy =
  | 'bootstrap-state'
  | 'cli-runbook'
  | 'deploy-script'
  | 'runtime'
  | 'external';

export type CatalogOwnership = 'app-owned' | 'shared-account-prerequisite';

export type CatalogTeardown = 'delete' | 'report-only';

export interface CatalogEntry {
  id: string;
  kind: string;
  nameOrPattern: string;
  createdBy: CatalogCreatedBy;
  ownership: CatalogOwnership;
  teardown: CatalogTeardown;
  notes: string;
}

const CREATED_BY: ReadonlySet<string> = new Set([
  'bootstrap-state',
  'cli-runbook',
  'deploy-script',
  'runtime',
  'external',
]);
const OWNERSHIP: ReadonlySet<string> = new Set([
  'app-owned',
  'shared-account-prerequisite',
]);
const TEARDOWN: ReadonlySet<string> = new Set(['delete', 'report-only']);

/** Parse + validate the committed catalog. Fails loud on a malformed entry. */
export function parseCatalog(json: string): CatalogEntry[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    throw new Error(
      `out-of-band catalog is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!Array.isArray(raw)) throw new Error('out-of-band catalog must be a JSON array');
  return raw.map((entry, i) => {
    const e = entry as Record<string, unknown>;
    for (const field of ['id', 'kind', 'nameOrPattern', 'createdBy', 'ownership', 'teardown', 'notes']) {
      if (typeof e[field] !== 'string' || e[field] === '') {
        throw new Error(`catalog entry #${i} is missing string field "${field}"`);
      }
    }
    if (!CREATED_BY.has(e.createdBy as string)) {
      throw new Error(`catalog entry "${String(e.id)}": unknown createdBy "${String(e.createdBy)}"`);
    }
    if (!OWNERSHIP.has(e.ownership as string)) {
      throw new Error(`catalog entry "${String(e.id)}": unknown ownership "${String(e.ownership)}"`);
    }
    if (!TEARDOWN.has(e.teardown as string)) {
      throw new Error(`catalog entry "${String(e.id)}": unknown teardown "${String(e.teardown)}"`);
    }
    // Invariant the .md documents: shared prerequisites are never 'delete'.
    if (e.ownership === 'shared-account-prerequisite' && e.teardown !== 'report-only') {
      throw new Error(
        `catalog entry "${String(e.id)}": shared-account-prerequisite entries must be report-only ` +
          '(deletion only ever happens behind --delete-shared-prereqs, never by default)',
      );
    }
    return e as unknown as CatalogEntry;
  });
}

export interface NameContext {
  /** CCE_NAME_SUFFIX, WITHOUT a leading hyphen ('' for prod). */
  suffix: string;
  account: string;
  region: string;
}

/**
 * Resolve `<suffix>` / `<account>` / `<region>` placeholders. `<suffix>`
 * renders to `-{suffix}` (the leading hyphen is part of the placeholder),
 * or to '' when no suffix is set — matching bootstrap-state's naming.
 */
export function resolveCatalogName(pattern: string, ctx: NameContext): string {
  return pattern
    .replaceAll('<suffix>', ctx.suffix === '' ? '' : `-${ctx.suffix}`)
    .replaceAll('<account>', ctx.account)
    .replaceAll('<region>', ctx.region);
}

export function classifyCatalog(entries: CatalogEntry[]): {
  appOwned: CatalogEntry[];
  sharedPrereqs: CatalogEntry[];
} {
  return {
    appOwned: entries.filter((e) => e.ownership === 'app-owned'),
    sharedPrereqs: entries.filter((e) => e.ownership === 'shared-account-prerequisite'),
  };
}

// ─────────────────────────────────────────────────────────────────────
// Stack inventory + destroy plan
// ─────────────────────────────────────────────────────────────────────

/**
 * Stack suffixes the CURRENT app would synthesize, mirroring
 * infra/bin/app.ts (CodeBuild is the one opt-in stack today). Used ONLY
 * to choose cdk-destroy vs direct DeleteStack — never to decide WHAT to
 * destroy. The destroy set comes from live CFN + the manifest.
 */
export const ALWAYS_ON_STACK_SUFFIXES: readonly string[] = [
  'Network',
  'Storage',
  'Guardrails',
  'Secrets',
  'Dynamo',
  'Messaging',
  'Iam',
  'Compute',
  'Observability',
  'Security',
  'Backup',
  'Chaos',
  'Extensions',
  'CostGuardrails',
] as const;

export function currentAppStackNames(
  stackPrefix: string,
  env: Record<string, string | undefined>,
): string[] {
  const names = ALWAYS_ON_STACK_SUFFIXES.map((s) => `${stackPrefix}-${s}`);
  if (env.CCE_CODEBUILD_ENABLED === '1') names.push(`${stackPrefix}-CodeBuild`);
  return names;
}

/** Stack statuses that mean "this stack still exists / still costs money". */
const GONE_STATUSES: ReadonlySet<string> = new Set(['DELETE_COMPLETE', 'REVIEW_IN_PROGRESS']);

export interface CfnStackSummary {
  StackName?: string;
  StackStatus?: string;
  Tags?: Array<{ Key?: string; Value?: string }>;
  /** Nested stacks are deleted with their parent, never directly. */
  RootId?: string;
  ParentId?: string;
}

/** Aggregated-client shape (`new CloudFormation({region})` satisfies it). */
export interface CfnClientLike {
  describeStacks(input: { NextToken?: string }): Promise<{
    Stacks?: CfnStackSummary[];
    NextToken?: string;
  }>;
  deleteStack(input: { StackName: string }): Promise<unknown>;
}

/**
 * Live CCE stacks: every non-deleted, non-nested stack whose name starts
 * with `<stackPrefix>-` OR that carries our Application tag. DescribeStacks
 * (not ListStacks) because only DescribeStacks returns tags.
 */
export async function listLiveStacks(
  cfn: CfnClientLike,
  opts: { stackPrefix: string; appTagValue: string },
): Promise<string[]> {
  const names: string[] = [];
  let nextToken: string | undefined;
  do {
    const page = await cfn.describeStacks({ NextToken: nextToken });
    for (const stack of page.Stacks ?? []) {
      const name = stack.StackName ?? '';
      if (!name || GONE_STATUSES.has(stack.StackStatus ?? '')) continue;
      if (stack.ParentId || stack.RootId) continue; // nested: parent owns it
      const tagged = (stack.Tags ?? []).some(
        (t) => t.Key === 'Application' && t.Value === opts.appTagValue,
      );
      if (name.startsWith(`${opts.stackPrefix}-`) || tagged) names.push(name);
    }
    nextToken = page.NextToken;
  } while (nextToken);
  return names;
}

export type StackDeleteMethod = 'cdk-destroy' | 'direct-delete' | 'skip-already-deleted';

export interface StackPlanItem {
  name: string;
  live: boolean;
  inManifest: boolean;
  inCurrentApp: boolean;
  method: StackDeleteMethod;
}

/**
 * The destroy set = live CFN ∪ manifest's recorded list. A stack the
 * current app no longer synthesizes (e.g. CodeBuild enabled at deploy,
 * flag off today) still appears here — that is the whole point — and is
 * deleted via direct DeleteStack because `cdk destroy` cannot name a
 * stack the app no longer produces.
 */
export function planStacks(opts: {
  liveStackNames: string[];
  manifestStacks: string[];
  currentAppStacks: string[];
}): StackPlanItem[] {
  const live = new Set(opts.liveStackNames);
  const inManifest = new Set(opts.manifestStacks);
  const inApp = new Set(opts.currentAppStacks);
  const all = [...new Set([...opts.liveStackNames, ...opts.manifestStacks])].sort();
  return all.map((name) => {
    const isLive = live.has(name);
    const method: StackDeleteMethod = !isLive
      ? 'skip-already-deleted'
      : inApp.has(name)
        ? 'cdk-destroy'
        : 'direct-delete';
    return {
      name,
      live: isLive,
      inManifest: inManifest.has(name),
      inCurrentApp: inApp.has(name),
      method,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────
// Wrong-account protection + typed confirmation
// ─────────────────────────────────────────────────────────────────────

export function confirmationString(accountId: string): string {
  return `destroy ${accountId}`;
}

/** Exact-match (after trim) against the live STS account id. */
export function checkTypedConfirmation(input: string, liveAccountId: string): boolean {
  return input.trim() === confirmationString(liveAccountId);
}

/**
 * Warning when the manifest was recorded for a DIFFERENT account than the
 * one the current credentials resolve to. Returns null when they agree
 * (or no manifest account is known — break-glass mode warns separately).
 */
export function accountMismatchWarning(
  liveAccount: string,
  manifestAccount: string | undefined,
): string | null {
  if (!manifestAccount || manifestAccount === liveAccount) return null;
  return (
    `WRONG-ACCOUNT WARNING: the deploy manifest records account ${manifestAccount}, but your ` +
    `current credentials resolve to ${liveAccount}. You may be about to tear down the wrong ` +
    'account, or your credentials may be stale. The typed confirmation requires the LIVE ' +
    `account id ("${confirmationString(liveAccount)}") on purpose — re-read it before typing.`
  );
}

// ─────────────────────────────────────────────────────────────────────
// Break-glass (item 25)
// ─────────────────────────────────────────────────────────────────────

export function breakGlassBanner(stateBucket: string): string {
  return [
    '╔══════════════════════════════════════════════════════════════════════╗',
    '║  BREAK-GLASS TEARDOWN — state bucket missing or inaccessible          ║',
    '╚══════════════════════════════════════════════════════════════════════╝',
    `State bucket "${stateBucket}" could not be read. Manifest-backed precision is`,
    'UNAVAILABLE: the recorded stack list, recorded account, and feature flags are',
    'unknown, so this plan is built from live CloudFormation + tags + name prefix +',
    'the committed catalog ALONE. Resources only the manifest knew about (none are',
    'expected, but that is the point of the manifest) will not appear here.',
    'The lifecycle lock is SKIPPED (its table may be gone too) — make sure no other',
    'operator is mutating this deployment right now.',
    'An extra account confirmation is required before anything is destroyed.',
  ].join('\n');
}

// ─────────────────────────────────────────────────────────────────────
// The assembled plan
// ─────────────────────────────────────────────────────────────────────

export interface TeardownPlan {
  account: string;
  region: string;
  /** Break-glass mode: state bucket unreadable. */
  degraded: boolean;
  banner: string | null;
  /** True when the lock is skipped (break-glass / table missing) — loudly. */
  lockSkipped: boolean;
  /** Degraded mode demands one extra typed account confirmation. */
  requireExtraAccountConfirmation: boolean;
  stacks: StackPlanItem[];
  catalogAppOwned: CatalogEntry[];
  catalogShared: CatalogEntry[];
  manifestAccount?: string;
  accountWarning: string | null;
}

export function buildTeardownPlan(opts: {
  account: string;
  region: string;
  stateBucket: string;
  stateBucketAccessible: boolean;
  /** Parsed manifest fields, or null (none promoted yet / break-glass). */
  manifest: { account?: string; stacks?: string[] } | null;
  liveStackNames: string[];
  currentAppStacks: string[];
  catalog: CatalogEntry[];
  /** True when the lock table exists and the lock was acquired. */
  lockHeld: boolean;
}): TeardownPlan {
  const degraded = !opts.stateBucketAccessible;
  const { appOwned, sharedPrereqs } = classifyCatalog(opts.catalog);
  return {
    account: opts.account,
    region: opts.region,
    degraded,
    banner: degraded ? breakGlassBanner(opts.stateBucket) : null,
    lockSkipped: !opts.lockHeld,
    requireExtraAccountConfirmation: degraded,
    stacks: planStacks({
      liveStackNames: opts.liveStackNames,
      manifestStacks: opts.manifest?.stacks ?? [],
      currentAppStacks: opts.currentAppStacks,
    }),
    catalogAppOwned: appOwned,
    catalogShared: sharedPrereqs,
    manifestAccount: opts.manifest?.account,
    accountWarning: accountMismatchWarning(opts.account, opts.manifest?.account),
  };
}

// ─────────────────────────────────────────────────────────────────────
// Step runner — the dry-run boundary
// ─────────────────────────────────────────────────────────────────────

/**
 * Every mutating step goes through a StepRunner: it records what WOULD
 * happen, and only calls the client when `execute` is true. `--dry-run`
 * therefore produces the complete action list with zero mutations.
 */
export interface StepRunner {
  readonly execute: boolean;
  readonly actions: string[];
  /** Record a would-be mutation; run the thunk only when executing. */
  mutate(action: string, thunk: () => Promise<unknown>): Promise<void>;
  /** Record an informational line (no mutation behind it). */
  note(line: string): void;
}

export function createRunner(execute: boolean): StepRunner {
  const actions: string[] = [];
  return {
    execute,
    actions,
    async mutate(action: string, thunk: () => Promise<unknown>): Promise<void> {
      actions.push(action);
      if (execute) await thunk();
    },
    note(line: string): void {
      actions.push(`(info) ${line}`);
    },
  };
}

// ─────────────────────────────────────────────────────────────────────
// DDB export offer (printed always; run only with --export-first)
// ─────────────────────────────────────────────────────────────────────

/**
 * Exact export commands for the operator (or for --export-first to run).
 * export-table-to-point-in-time needs PITR enabled on the table; tables
 * without PITR fall back to the slower scan-based restore tooling.
 */
export function ddbExportCommands(opts: {
  tables: string[];
  account: string;
  region: string;
  bucket: string;
}): string[] {
  return opts.tables.map(
    (t) =>
      `aws dynamodb export-table-to-point-in-time ` +
      `--table-arn arn:aws:dynamodb:${opts.region}:${opts.account}:table/${t} ` +
      `--s3-bucket ${opts.bucket} --s3-prefix final-export/${t} --region ${opts.region}`,
  );
}

// ─────────────────────────────────────────────────────────────────────
// Versioned-bucket empty + delete
// ─────────────────────────────────────────────────────────────────────

export interface S3TeardownClientLike {
  listObjectVersions(input: {
    Bucket: string;
    KeyMarker?: string;
    VersionIdMarker?: string;
  }): Promise<{
    Versions?: Array<{ Key?: string; VersionId?: string }>;
    DeleteMarkers?: Array<{ Key?: string; VersionId?: string }>;
    IsTruncated?: boolean;
    NextKeyMarker?: string;
    NextVersionIdMarker?: string;
  }>;
  deleteObjects(input: {
    Bucket: string;
    Delete: { Objects: Array<{ Key: string; VersionId?: string }>; Quiet?: boolean };
  }): Promise<unknown>;
  deleteBucket(input: { Bucket: string }): Promise<unknown>;
}

/**
 * Empty a VERSIONED bucket (every version + every delete marker), then
 * delete it. S3 has no bulk "empty bucket" API; this is the documented
 * list + batch-delete loop.
 *
 * SCALE LIMITS, stated plainly: DeleteObjects accepts at most 1000 keys
 * per call, and this loop is single-threaded — fine up to roughly a few
 * million versions (minutes), painful beyond that. For a truly huge
 * bucket, prefer adding a lifecycle rule that expires all versions and
 * deleting the bucket a day later; teardown prints that alternative when
 * it sees a large listing.
 *
 * In dry-run mode only the FIRST page is listed (enough to report "this
 * bucket is non-empty, ~N+ versions") so a dry run stays fast.
 */
export async function emptyAndDeleteVersionedBucket(
  s3: S3TeardownClientLike,
  bucket: string,
  runner: StepRunner,
): Promise<{ versionsDeleted: number }> {
  let versionsDeleted = 0;
  let keyMarker: string | undefined;
  let versionIdMarker: string | undefined;
  do {
    const page = await s3.listObjectVersions({
      Bucket: bucket,
      KeyMarker: keyMarker,
      VersionIdMarker: versionIdMarker,
    });
    const objects = [
      ...(page.Versions ?? []),
      ...(page.DeleteMarkers ?? []),
    ]
      .filter((v) => v.Key)
      .map((v) => ({ Key: v.Key as string, VersionId: v.VersionId }));
    // DeleteObjects hard cap: 1000 keys per request.
    for (let i = 0; i < objects.length; i += 1000) {
      const batch = objects.slice(i, i + 1000);
      await runner.mutate(
        `s3:DeleteObjects ${bucket} (${batch.length} versions/markers)`,
        () => s3.deleteObjects({ Bucket: bucket, Delete: { Objects: batch, Quiet: true } }),
      );
      versionsDeleted += batch.length;
    }
    if (!runner.execute) {
      // Dry run: one page is enough to size the work; never paginate a
      // multi-million-version bucket just to print a plan.
      if (page.IsTruncated) runner.note(`${bucket}: more versions beyond the first page (truncated listing)`);
      break;
    }
    keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
    versionIdMarker = page.IsTruncated ? page.NextVersionIdMarker : undefined;
  } while (keyMarker !== undefined || versionIdMarker !== undefined);
  await runner.mutate(`s3:DeleteBucket ${bucket}`, () => s3.deleteBucket({ Bucket: bucket }));
  return { versionsDeleted };
}

// ─────────────────────────────────────────────────────────────────────
// Secrets — schedule-delete with the 7-day recovery window
// ─────────────────────────────────────────────────────────────────────

/**
 * 7 days is the MINIMUM Secrets Manager recovery window; we use it so a
 * mistaken teardown is recoverable for a week (`restore-secret`), while
 * preflight (plan item 7) knows to detect pending-deletion secrets that
 * would block a same-name redeploy during that window.
 */
export const SECRET_RECOVERY_WINDOW_DAYS = 7;

export interface SecretsTeardownClientLike {
  deleteSecret(input: { SecretId: string; RecoveryWindowInDays: number }): Promise<unknown>;
}

export async function scheduleDeleteSecrets(
  client: SecretsTeardownClientLike,
  secretIds: string[],
  runner: StepRunner,
): Promise<void> {
  for (const id of secretIds) {
    await runner.mutate(
      `secretsmanager:DeleteSecret ${id} (recovery window ${SECRET_RECOVERY_WINDOW_DAYS} days — ` +
        `restorable until then, blocks same-name recreation until the window lapses)`,
      () => client.deleteSecret({ SecretId: id, RecoveryWindowInDays: SECRET_RECOVERY_WINDOW_DAYS }),
    );
  }
}

// ─────────────────────────────────────────────────────────────────────
// Runtime EventBridge schedules (deleted BEFORE the Messaging stack)
// ─────────────────────────────────────────────────────────────────────

export interface SchedulerClientLike {
  listSchedules(input: { GroupName: string; NextToken?: string }): Promise<{
    Schedules?: Array<{ Name?: string }>;
    NextToken?: string;
  }>;
  deleteSchedule(input: { Name: string; GroupName: string }): Promise<unknown>;
}

/**
 * The schedule GROUP is CDK-owned (Messaging stack); the schedules inside
 * it are app data the orchestrator created at runtime. They are inventoried
 * and deleted here, BEFORE the Messaging stack is destroyed, so group
 * deletion can never wedge on live schedules.
 */
export async function deleteRuntimeSchedules(
  scheduler: SchedulerClientLike,
  groupName: string,
  runner: StepRunner,
): Promise<string[]> {
  const names: string[] = [];
  let nextToken: string | undefined;
  do {
    const page = await scheduler.listSchedules({ GroupName: groupName, NextToken: nextToken });
    for (const s of page.Schedules ?? []) if (s.Name) names.push(s.Name);
    nextToken = page.NextToken;
  } while (nextToken);
  for (const name of names) {
    await runner.mutate(`scheduler:DeleteSchedule ${groupName}/${name}`, () =>
      scheduler.deleteSchedule({ Name: name, GroupName: groupName }),
    );
  }
  return names;
}

// ─────────────────────────────────────────────────────────────────────
// KMS — dependencies, not leftovers (item 24)
// ─────────────────────────────────────────────────────────────────────

/** Minimum/maximum ScheduleKeyDeletion windows, stated wherever printed. */
export const KMS_DELETION_WINDOW_MIN_DAYS = 7;
export const KMS_DELETION_WINDOW_MAX_DAYS = 30;

export interface EncryptedResourceInventory {
  /** S3 buckets with SSE-KMS, each carrying its key ARN/id. */
  buckets: Array<{ name: string; kmsKeyRef?: string }>;
  /** DynamoDB tables with a CMK (SSEDescription.KMSMasterKeyArn). */
  tables: Array<{ name: string; kmsKeyRef?: string }>;
  /** CloudWatch log groups with kmsKeyId set. */
  logGroups: Array<{ name: string; kmsKeyRef?: string }>;
  /** Secrets Manager secrets with a CMK (KmsKeyId). */
  secrets: Array<{ name: string; kmsKeyRef?: string }>;
}

function refsMatch(a: string | undefined, b: string): boolean {
  if (!a) return false;
  // Key ARNs, bare key ids, and alias forms all appear in the wild;
  // containment either way covers "arn ends with the id" and "id is the
  // last arn segment" without a parser.
  return a === b || a.includes(b) || b.includes(a);
}

/**
 * Exact LIVE encrypted dependents of one key. Anything listed here means
 * deleting the key would make that data unreadable — which is why key
 * deletion is blocked until this list is empty.
 */
export function findKmsDependents(
  keyRef: string,
  inventory: EncryptedResourceInventory,
): string[] {
  return [
    ...inventory.buckets.filter((r) => refsMatch(r.kmsKeyRef, keyRef)).map((r) => `s3 bucket ${r.name}`),
    ...inventory.tables.filter((r) => refsMatch(r.kmsKeyRef, keyRef)).map((r) => `dynamodb table ${r.name}`),
    ...inventory.logGroups.filter((r) => refsMatch(r.kmsKeyRef, keyRef)).map((r) => `log group ${r.name}`),
    ...inventory.secrets.filter((r) => refsMatch(r.kmsKeyRef, keyRef)).map((r) => `secret ${r.name}`),
  ];
}

export interface KmsDeletionDecision {
  allowed: boolean;
  reason: string;
}

/**
 * Key deletion is BLOCKED by default. Only when the operator passed
 * --cryptographic-erasure AND zero live encrypted dependents remain may a
 * key be disabled + scheduled for deletion.
 */
export function kmsDeletionDecision(opts: {
  keyRef: string;
  cryptographicErasure: boolean;
  dependents: string[];
}): KmsDeletionDecision {
  if (opts.dependents.length > 0) {
    return {
      allowed: false,
      reason:
        `KMS key ${opts.keyRef} still has ${opts.dependents.length} live encrypted dependent(s):\n` +
        opts.dependents.map((d) => `  - ${d}`).join('\n') +
        '\nDeleting the key would make this data permanently unreadable. Delete or export the ' +
        'dependents first; the key stays.',
    };
  }
  if (!opts.cryptographicErasure) {
    return {
      allowed: false,
      reason:
        `KMS key ${opts.keyRef} has zero live dependents, but key deletion is blocked by default. ` +
        'Re-run with --cryptographic-erasure to disable it and schedule deletion ' +
        `(${KMS_DELETION_WINDOW_MIN_DAYS}–${KMS_DELETION_WINDOW_MAX_DAYS} day window, cancellable until it lapses).`,
    };
  }
  return {
    allowed: true,
    reason:
      `KMS key ${opts.keyRef}: zero dependents + --cryptographic-erasure → disable, then ` +
      `ScheduleKeyDeletion with a ${KMS_DELETION_WINDOW_MIN_DAYS}-day window ` +
      `(minimum AWS allows; max ${KMS_DELETION_WINDOW_MAX_DAYS}; cancellable until it lapses).`,
  };
}

export interface KmsClientLike {
  disableKey(input: { KeyId: string }): Promise<unknown>;
  scheduleKeyDeletion(input: { KeyId: string; PendingWindowInDays: number }): Promise<unknown>;
}

/** Apply an ALLOWED decision: disable, then schedule deletion (7 days). */
export async function eraseKmsKey(
  kms: KmsClientLike,
  keyId: string,
  decision: KmsDeletionDecision,
  runner: StepRunner,
): Promise<void> {
  if (!decision.allowed) {
    throw new Error(`refusing to erase KMS key ${keyId}: ${decision.reason}`);
  }
  await runner.mutate(`kms:DisableKey ${keyId}`, () => kms.disableKey({ KeyId: keyId }));
  await runner.mutate(
    `kms:ScheduleKeyDeletion ${keyId} (PendingWindowInDays=${KMS_DELETION_WINDOW_MIN_DAYS})`,
    () => kms.scheduleKeyDeletion({ KeyId: keyId, PendingWindowInDays: KMS_DELETION_WINDOW_MIN_DAYS }),
  );
}

// ─────────────────────────────────────────────────────────────────────
// Stack deletion steps
// ─────────────────────────────────────────────────────────────────────

/** Direct DeleteStack for orphans the current app no longer synthesizes. */
export async function deleteOrphanStacks(
  cfn: CfnClientLike,
  plan: StackPlanItem[],
  runner: StepRunner,
): Promise<void> {
  for (const stack of plan) {
    if (stack.method !== 'direct-delete') continue;
    await runner.mutate(
      `cloudformation:DeleteStack ${stack.name} (absent from the current app — direct delete)`,
      () => cfn.deleteStack({ StackName: stack.name }),
    );
  }
}

// ─────────────────────────────────────────────────────────────────────
// Shared-prerequisite dependents (blast radius for --delete-shared-prereqs)
// ─────────────────────────────────────────────────────────────────────

/**
 * IAM roles whose trust policy references the OIDC provider ARN. IAM
 * returns AssumeRolePolicyDocument URL-encoded; both encoded and decoded
 * forms are searched so callers don't have to care.
 */
export function oidcDependentRoles(
  roles: Array<{ roleName: string; assumeRolePolicyDocument?: string }>,
  providerArn: string,
): string[] {
  return roles
    .filter((r) => {
      const doc = r.assumeRolePolicyDocument ?? '';
      let decoded = doc;
      try {
        decoded = decodeURIComponent(doc);
      } catch {
        // Not URL-encoded; search the raw form.
      }
      return doc.includes(providerArn) || decoded.includes(providerArn);
    })
    .map((r) => r.roleName);
}

/**
 * CodeBuild projects whose source rides the account-level GitHub source
 * credential (one credential per provider per account/region — deleting
 * it disconnects every one of these, ours or not).
 */
export function codebuildGithubProjects(
  projects: Array<{ name: string; sourceType?: string }>,
): string[] {
  return projects
    .filter((p) => p.sourceType === 'GITHUB' || p.sourceType === 'GITHUB_ENTERPRISE')
    .map((p) => p.name);
}

// ─────────────────────────────────────────────────────────────────────
// WORM / Object Lock (item 26) — the intentional residual
// ─────────────────────────────────────────────────────────────────────

/**
 * The audit-lock bucket (tier ≥ 2) carries GOVERNANCE-mode default
 * retention of 2555 days. Teardown classifies it as an INTENTIONAL
 * RESIDUAL — emptying it requires bypass-governance, which we will not do
 * implicitly — and tells the operator exactly how, and what it costs to
 * keep.
 */
export function wormResidualNotice(bucket: string): string {
  return [
    `INTENTIONAL RESIDUAL: s3://${bucket} (WORM audit bucket, S3 Object Lock,`,
    'GOVERNANCE retention, 2555-day default). Object Lock governance retention means',
    'normal deletes are refused until each object\'s retain-until date; in a trial or',
    'restricted account this bucket may be effectively undeletable. Teardown leaves it.',
    '',
    'To remove it anyway (governance mode allows an explicit bypass):',
    '  1. Your principal needs the s3:BypassGovernanceRetention permission on the bucket.',
    '  2. Delete every object VERSION with the bypass header, e.g. per version:',
    `       aws s3api delete-object --bucket ${bucket} \\`,
    '         --key <key> --version-id <versionId> --bypass-governance-retention',
    '     (script the loop over list-object-versions; there is no bulk bypass flag on',
    '      delete-objects in the CLI, so large buckets take a while).',
    `  3. Then: aws s3api delete-bucket --bucket ${bucket}`,
    '',
    'ONGOING COST if you keep it: standard S3 storage on the locked audit objects',
    '(small JSON events — typically cents/month per million events) until their',
    'retention lapses in ~7 years. No request traffic after teardown.',
  ].join('\n');
}

/**
 * What teardown CANNOT remove, ever — printed last, every run. AWS has no
 * API into any of these.
 */
export const MANUAL_TEARDOWN_CHECKLIST: readonly string[] = [
  'Slack app: delete it at https://api.slack.com/apps (the workspace-side app, its tokens, and the event subscription).',
  'Telegram bot: revoke or delete via @BotFather, and clear the webhook first if the bot lives on: curl "https://api.telegram.org/bot<TOKEN>/deleteWebhook".',
  'Bedrock model-access grants: console-only account state (Bedrock → Model access). Harmless to keep, but revoke there if you want a clean slate.',
] as const;

// ─────────────────────────────────────────────────────────────────────
// Costed retained summary
// ─────────────────────────────────────────────────────────────────────

export type RetainedKind =
  | 's3-bucket'
  | 'dynamodb-table'
  | 'secret'
  | 'log-group'
  | 'ecr-image'
  | 'kms-key';

export interface RetainedItem {
  kind: RetainedKind;
  name: string;
  /** Object versions / item count / image count, where cheaply knowable. */
  quantity?: number;
  /** Honest, rough cost framing for keeping it. */
  costNote: string;
}

export function renderRetainedSummary(items: RetainedItem[]): string[] {
  if (items.length === 0) return ['(no RETAINed resources found)'];
  return items.map(
    (i) =>
      `${i.kind.padEnd(15)} ${i.name}${i.quantity !== undefined ? ` (${i.quantity})` : ''} — ${i.costNote}`,
  );
}
