/**
 * TTL TRIPWIRE handler (onboarding invariant I6).
 *
 * A durable, AWS-side auto-destroy for any install that has NOT reached the
 * 'verified' state within N hours. It runs independent of the operator's
 * terminal and independent of the (possibly half-deployed) main app stacks,
 * because it lives in its OWN stack (see infra/lib/tripwire-stack.ts): its own
 * EventBridge Scheduler schedule fires this Lambda every ~30 min, and the
 * decision is driven entirely by a single DynamoDB state row.
 *
 * The contract, stated plainly:
 *
 *   - status === 'verified'  → NO-OP forever. We never touch a verified
 *     install. Once an operator proves the deploy is healthy, the tripwire is
 *     inert (the verify step also disarms the schedule, but this handler is the
 *     belt to that suspenders: even a still-firing schedule does nothing once
 *     the row says 'verified').
 *
 *   - status === 'destroyed' → NO-OP (idempotent: a prior fire already swept).
 *
 *   - now - armedAt > ttlHours AND status not in {verified, destroyed}
 *       → AUTO-DESTROY every resource THIS install owns, found by the
 *         owner-tag (claudeclaw:install-id == installId) and by the
 *         deterministic, typed names the bootstrap created — INCLUDING the
 *         bootstrap/toolkit primitives (state bucket, lock table, ECR repo,
 *         our own CDK toolkit stack). Then mark status 'destroyed'.
 *
 *   - otherwise (still inside the TTL window) → NO-OP; check again next fire.
 *
 * The destroy is driven by TYPED identifiers (a DestroyTargets struct), never
 * by prose, and the actual AWS deletion calls are INJECTED via a Destroyer
 * interface so the decision + dispatch can be unit-tested with zero AWS calls.
 *
 * Import-safe: no top-level side effects. The default (real-AWS) wiring is
 * constructed lazily inside the exported `handler`, never at module load.
 */

// ─────────────────────────────────────────────────────────────────────
// State row + decision (the pure core)
// ─────────────────────────────────────────────────────────────────────

export type TripwireStatus = 'armed' | 'verified' | 'destroyed';

/**
 * The single state row the tripwire reads. `installId` is the per-install run
 * id (also the value of the `claudeclaw:install-id` owner tag). `armedAt` is an
 * ISO-8601 timestamp; `ttlHours` is the grace window before auto-destroy.
 */
export interface TripwireState {
  installId: string;
  armedAt: string;
  ttlHours: number;
  status: TripwireStatus;
}

export interface TripwireDecision {
  action: 'noop' | 'destroy';
  reason: string;
}

const MS_PER_HOUR = 3_600_000;

/**
 * PURE decision function. Given the state row and the current wall-clock (ms
 * since epoch), decide whether to destroy. No I/O, no Date.now() inside — the
 * caller passes `nowMs` so tests are deterministic.
 *
 * Fail-safe ordering: 'verified' and 'destroyed' short-circuit FIRST, so a
 * verified install can never be destroyed regardless of timestamps. A bad
 * (unparseable) armedAt is treated as NOT-yet-expired (noop), never as
 * expired — we never destroy on a parse error, only on a proven-elapsed TTL.
 */
export function decideTripwire(state: TripwireState, nowMs: number): TripwireDecision {
  if (state.status === 'verified') {
    return { action: 'noop', reason: 'install is verified; tripwire is inert (never touch a verified install)' };
  }
  if (state.status === 'destroyed') {
    return { action: 'noop', reason: 'install already destroyed by a prior tripwire fire (idempotent no-op)' };
  }
  // status === 'armed' (or any non-terminal value): evaluate the TTL.
  const armedMs = Date.parse(state.armedAt);
  if (!Number.isFinite(armedMs)) {
    // Unparseable armedAt: refuse to destroy on bad data. Fail toward keeping
    // resources; the operator / verify step will correct the row.
    return {
      action: 'noop',
      reason: `armedAt "${state.armedAt}" is not a parseable timestamp; refusing to destroy on bad data`,
    };
  }
  if (!Number.isFinite(state.ttlHours) || state.ttlHours < 0) {
    return {
      action: 'noop',
      reason: `ttlHours "${state.ttlHours}" is not a valid non-negative number; refusing to destroy on bad data`,
    };
  }
  const elapsedMs = nowMs - armedMs;
  const ttlMs = state.ttlHours * MS_PER_HOUR;
  if (elapsedMs > ttlMs) {
    const elapsedH = (elapsedMs / MS_PER_HOUR).toFixed(2);
    return {
      action: 'destroy',
      reason:
        `install "${state.installId}" armed ${elapsedH}h ago has not reached 'verified' within its ` +
        `${state.ttlHours}h TTL; auto-destroying all unverified owned resources`,
    };
  }
  const remainingH = ((ttlMs - elapsedMs) / MS_PER_HOUR).toFixed(2);
  return {
    action: 'noop',
    reason: `install "${state.installId}" still within its ${state.ttlHours}h TTL (~${remainingH}h remaining)`,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Typed destroy targets (NEVER prose)
// ─────────────────────────────────────────────────────────────────────

/**
 * The exact, typed set of things to destroy for one unverified install. Every
 * field is a concrete identifier the destroyer dispatches on; there is no
 * free-text "what to delete" anywhere. The bootstrap primitives are included
 * on purpose — an unverified install must leave NOTHING behind, including the
 * state bucket, lock table, ECR repo, and our own CDK toolkit stack.
 */
export interface DestroyTargets {
  /** The owner-tag value (claudeclaw:install-id) every owned resource carries. */
  installId: string;
  region: string;
  /** CloudFormation stacks this install owns (app stacks + our toolkit stack), deleted first. */
  stackNames: string[];
  /** Versioned S3 buckets to empty-then-delete (state/manifest bucket, etc.). */
  buckets: string[];
  /** DynamoDB tables to delete (the deploy-lock table, etc.). */
  tables: string[];
  /** ECR repositories to delete (force, images included). */
  ecrRepos: string[];
  /** The tag KEY used to scope a tag-driven sweep of any stragglers. */
  ownerTagKey: string;
}

/**
 * Injected AWS-deletion surface. The handler calls these; in production they
 * wrap the SDK, in tests they are fakes. Each method is responsible for being
 * idempotent (a not-found target is a success, not an error) so a retried fire
 * after a partial sweep completes cleanly.
 */
export interface Destroyer {
  /** Delete one CloudFormation stack (idempotent: missing stack is success). */
  deleteStack(stackName: string): Promise<void>;
  /** Empty (all versions + delete markers) then delete one S3 bucket. */
  emptyAndDeleteBucket(bucket: string): Promise<void>;
  /** Delete one DynamoDB table (idempotent). */
  deleteTable(table: string): Promise<void>;
  /** Force-delete one ECR repo including its images (idempotent). */
  deleteEcrRepo(repo: string): Promise<void>;
  /**
   * Best-effort tag-scoped sweep for any owned straggler the typed lists
   * missed (e.g. a resource created between write-ahead and crash). Driven by
   * the owner tag key+value, never by name. Returns the identifiers it removed.
   */
  sweepByOwnerTag(tagKey: string, installId: string): Promise<string[]>;
}

/**
 * Inversion-of-control store the handler reads/writes the state row through.
 * Kept separate from the Destroyer so the state table is updated even when the
 * sweep is a partial success on a later retry.
 */
export interface TripwireStore {
  /** Read the install's state row, or null if absent. */
  getState(installId: string): Promise<TripwireState | null>;
  /** Persist the new status (only ever 'destroyed' from this handler). */
  setStatus(installId: string, status: TripwireStatus): Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────
// The orchestration (pure-ish: clients injected)
// ─────────────────────────────────────────────────────────────────────

export interface RunTripwireDeps {
  store: TripwireStore;
  destroyer: Destroyer;
  /** Builds the typed destroy targets for an install (deterministic names). */
  resolveTargets: (state: TripwireState) => DestroyTargets;
  /** Injectable clock; defaults to Date.now in the real handler. */
  nowMs?: number;
}

export interface RunTripwireResult {
  action: 'noop' | 'destroy';
  reason: string;
  /** When action==='destroy': the typed targets that were swept. */
  destroyed?: DestroyTargets;
  /** Extra owned identifiers the tag-sweep removed beyond the typed lists. */
  sweptStragglers?: string[];
}

/**
 * Read the state row, decide, and (only when the decision is 'destroy') run the
 * full sweep through the injected destroyer, then mark the row 'destroyed'.
 *
 * Deletion order is deliberate: CloudFormation stacks first (so stack-managed
 * resources go through their own teardown), then the bootstrap primitives the
 * stacks do NOT own (buckets, tables, ECR repos), then a tag-scoped straggler
 * sweep, and only after every deletion call resolves do we flip the row to
 * 'destroyed'. If any deletion throws, the status is left unchanged so the next
 * scheduled fire retries — the tripwire never marks an install clean until the
 * sweep actually completed.
 */
export async function runTripwire(
  state: TripwireState,
  deps: RunTripwireDeps,
): Promise<RunTripwireResult> {
  const now = deps.nowMs ?? Date.now();
  const decision = decideTripwire(state, now);
  if (decision.action === 'noop') {
    return { action: 'noop', reason: decision.reason };
  }

  // TOCTOU guard. `state` was read before this fire began; a multi-minute sweep
  // (DeleteStack alone can take minutes) gives the operator a window to run
  // `verify` and flip the row to 'verified'. Re-read and re-decide immediately
  // before the destructive sweep so a freshly-verified install is NOT torn down.
  // This shrinks the race to the sweep itself; setStatus('destroyed') below is
  // also conditional on the row not being 'verified' (belt and suspenders).
  const fresh = await deps.store.getState(state.installId);
  if (fresh) {
    const recheck = decideTripwire(fresh, now);
    if (recheck.action === 'noop') {
      return { action: 'noop', reason: `status changed before sweep: ${recheck.reason}` };
    }
  }

  const targets = deps.resolveTargets(state);

  // 1) CloudFormation stacks (app stacks + our toolkit stack) first.
  for (const stack of targets.stackNames) {
    await deps.destroyer.deleteStack(stack);
  }
  // 2) Bootstrap primitives not owned by any stack.
  for (const bucket of targets.buckets) {
    await deps.destroyer.emptyAndDeleteBucket(bucket);
  }
  for (const table of targets.tables) {
    await deps.destroyer.deleteTable(table);
  }
  for (const repo of targets.ecrRepos) {
    await deps.destroyer.deleteEcrRepo(repo);
  }
  // 3) Tag-scoped straggler sweep for anything the typed lists missed.
  const sweptStragglers = await deps.destroyer.sweepByOwnerTag(
    targets.ownerTagKey,
    targets.installId,
  );

  // Fail CLOSED on a no-op sweep. If the owned-resource lists were frozen empty
  // at arm time (the tripwire is armed BEFORE the primitives exist) and the tag
  // sweep found nothing, marking 'destroyed' here would FALSELY claim a sweep
  // and stop all future fires, abandoning whatever later bootstrap phases
  // created. Leave the row untouched so the schedule keeps firing (and a human/
  // orchestrator is alerted). The durable fix is to drive deletion off live
  // tag-scoped discovery so targets reflect what actually exists at fire time.
  const typedTargetCount =
    targets.stackNames.length +
    targets.buckets.length +
    targets.tables.length +
    targets.ecrRepos.length;
  if (typedTargetCount === 0 && sweptStragglers.length === 0) {
    return {
      action: 'noop',
      reason:
        'TTL expired but no owned targets resolved; refusing to mark destroyed ' +
        'without a proven sweep (tripwire stays armed)',
    };
  }

  // Only now — every deletion call resolved and at least one target was acted
  // on — mark the install destroyed.
  await deps.store.setStatus(state.installId, 'destroyed');

  return { action: 'destroy', reason: decision.reason, destroyed: targets, sweptStragglers };
}

// ─────────────────────────────────────────────────────────────────────
// Deterministic target resolution (typed names, no prose)
// ─────────────────────────────────────────────────────────────────────

/**
 * The owner tag key. Must match scripts/lib/onboarding/naming.ts
 * (OWNER_TAG_KEY). Re-stated here, not imported, so the Lambda bundle stays
 * free of the onboarding script tree (which pulls in CDK constants).
 */
export const TRIPWIRE_OWNER_TAG_KEY = 'claudeclaw:install-id';

/**
 * Environment contract the tripwire-stack injects into this Lambda. Every name
 * the destroy needs is passed explicitly (the bootstrap computed them already)
 * so the handler never re-derives a name and risks drifting from what was
 * actually created.
 */
export interface TripwireEnv {
  /** The DynamoDB table holding the tripwire state rows. */
  TRIPWIRE_STATE_TABLE: string;
  /** This install's id (== owner tag value). */
  TRIPWIRE_INSTALL_ID: string;
  AWS_REGION: string;
  /** Comma-separated CloudFormation stack names this install owns. */
  TRIPWIRE_STACK_NAMES?: string;
  /** Comma-separated versioned S3 buckets (state/manifest bucket, etc.). */
  TRIPWIRE_BUCKETS?: string;
  /** Comma-separated DynamoDB tables (deploy-lock table, etc.). */
  TRIPWIRE_TABLES?: string;
  /** Comma-separated ECR repositories. */
  TRIPWIRE_ECR_REPOS?: string;
}

function splitList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Build the typed DestroyTargets from the Lambda environment. Pure; safe to
 * unit-test. The install id and region are required (the stack always sets
 * them); the resource lists default to empty so a partially-bootstrapped
 * install (only some primitives created) still resolves a valid, smaller set.
 */
export function resolveTargetsFromEnv(env: TripwireEnv): DestroyTargets {
  if (!env.TRIPWIRE_INSTALL_ID) {
    throw new Error('resolveTargetsFromEnv: TRIPWIRE_INSTALL_ID is required');
  }
  if (!env.AWS_REGION) {
    throw new Error('resolveTargetsFromEnv: AWS_REGION is required');
  }
  return {
    installId: env.TRIPWIRE_INSTALL_ID,
    region: env.AWS_REGION,
    stackNames: splitList(env.TRIPWIRE_STACK_NAMES),
    buckets: splitList(env.TRIPWIRE_BUCKETS),
    tables: splitList(env.TRIPWIRE_TABLES),
    ecrRepos: splitList(env.TRIPWIRE_ECR_REPOS),
    ownerTagKey: TRIPWIRE_OWNER_TAG_KEY,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Real-AWS wiring (constructed lazily; never on import)
// ─────────────────────────────────────────────────────────────────────

export interface AwsWiringOptions {
  region: string;
  stateTable: string;
}

/**
 * Build the real-AWS Store + Destroyer. SDK clients are imported and
 * constructed INSIDE this function (dynamic import), so merely importing this
 * module pulls in no SDK and runs no code — the module stays import-safe for
 * tests. The actual production fire path in this repo is the inline-JS mirror
 * in infra/lib/tripwire-stack.ts (the Code.fromInline convention used by the
 * backup stack and the consolidation spawner); this factory is the canonical
 * TypeScript twin, kept in sync, and is what a bundled-Lambda deploy would use.
 *
 * Every deletion is idempotent: a not-found target resolves successfully so a
 * retried fire after a partial sweep completes cleanly.
 */
export async function createAwsWiring(
  opts: AwsWiringOptions,
): Promise<{ store: TripwireStore; destroyer: Destroyer }> {
  const { region, stateTable } = opts;
  const [ddbMod, ddbDocMod, cfnMod, s3Mod] = await Promise.all([
    import('@aws-sdk/client-dynamodb'),
    import('@aws-sdk/lib-dynamodb'),
    import('@aws-sdk/client-cloudformation'),
    import('@aws-sdk/client-s3'),
  ]);
  // @aws-sdk/client-ecr is NOT a project dependency (see bootstrap-state.ts:
  // EcrClientLike exists for the same reason). It IS present in the AWS Lambda
  // Node 20 runtime, so we load it through a VARIABLE specifier — TypeScript
  // does not statically resolve a non-literal import(), so the central
  // typecheck never fails on the absent package, while the deployed Lambda
  // resolves it fine. The minimal structural shape is asserted below.
  const ecrSpecifier = '@aws-sdk/client-ecr';
  const ecrMod = (await import(ecrSpecifier)) as {
    ECRClient: new (cfg: { region: string }) => { send: (cmd: unknown) => Promise<unknown> };
    DeleteRepositoryCommand: new (input: { repositoryName: string; force?: boolean }) => unknown;
  };

  const ddbRaw = new ddbMod.DynamoDBClient({ region });
  const ddb = ddbDocMod.DynamoDBDocumentClient.from(ddbRaw);
  const cfn = new cfnMod.CloudFormationClient({ region });
  const s3 = new s3Mod.S3Client({ region });
  const ecr = new ecrMod.ECRClient({ region });

  const notFound = (err: unknown): boolean => {
    const e = err as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } } | null;
    const name = e?.name ?? '';
    return (
      name === 'ResourceNotFoundException' ||
      name === 'RepositoryNotFoundException' ||
      name === 'NoSuchBucket' ||
      name === 'ValidationError' || // CloudFormation: stack does not exist
      e?.Code === 'NoSuchBucket' ||
      e?.$metadata?.httpStatusCode === 404
    );
  };

  const store: TripwireStore = {
    async getState(installId: string): Promise<TripwireState | null> {
      const out = await ddb.send(
        new ddbDocMod.GetCommand({ TableName: stateTable, Key: { installId } }),
      );
      return (out.Item as TripwireState | undefined) ?? null;
    },
    async setStatus(installId: string, status: TripwireStatus): Promise<void> {
      // Stamping 'destroyed' is conditional on the row not being 'verified', so a
      // verify that landed DURING the sweep is never overwritten (a verified
      // install must never read 'destroyed'). A conditional failure is benign.
      const conditional = status === 'destroyed';
      try {
        await ddb.send(
          new ddbDocMod.UpdateCommand({
            TableName: stateTable,
            Key: { installId },
            UpdateExpression: 'SET #s = :v',
            ExpressionAttributeNames: { '#s': 'status' },
            ExpressionAttributeValues: conditional ? { ':v': status, ':verified': 'verified' } : { ':v': status },
            ...(conditional ? { ConditionExpression: '#s <> :verified' } : {}),
          }),
        );
      } catch (err) {
        if (conditional && (err as { name?: string })?.name === 'ConditionalCheckFailedException') return;
        throw err;
      }
    },
  };

  const destroyer: Destroyer = {
    async deleteStack(stackName: string): Promise<void> {
      try {
        await cfn.send(new cfnMod.DeleteStackCommand({ StackName: stackName }));
      } catch (err) {
        if (!notFound(err)) throw err;
      }
    },
    async emptyAndDeleteBucket(bucket: string): Promise<void> {
      try {
        let keyMarker: string | undefined;
        let versionIdMarker: string | undefined;
        do {
          const page = await s3.send(
            new s3Mod.ListObjectVersionsCommand({
              Bucket: bucket,
              KeyMarker: keyMarker,
              VersionIdMarker: versionIdMarker,
            }),
          );
          const objs = [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])]
            .filter((v) => v.Key)
            .map((v) => ({ Key: v.Key as string, VersionId: v.VersionId }));
          for (let i = 0; i < objs.length; i += 1000) {
            const batch = objs.slice(i, i + 1000);
            if (batch.length === 0) continue;
            await s3.send(
              new s3Mod.DeleteObjectsCommand({
                Bucket: bucket,
                Delete: { Objects: batch, Quiet: true },
              }),
            );
          }
          keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
          versionIdMarker = page.IsTruncated ? page.NextVersionIdMarker : undefined;
        } while (keyMarker !== undefined || versionIdMarker !== undefined);
        await s3.send(new s3Mod.DeleteBucketCommand({ Bucket: bucket }));
      } catch (err) {
        if (!notFound(err)) throw err;
      }
    },
    async deleteTable(table: string): Promise<void> {
      try {
        await ddbRaw.send(new ddbMod.DeleteTableCommand({ TableName: table }));
      } catch (err) {
        if (!notFound(err)) throw err;
      }
    },
    async deleteEcrRepo(repo: string): Promise<void> {
      try {
        await ecr.send(new ecrMod.DeleteRepositoryCommand({ repositoryName: repo, force: true }));
      } catch (err) {
        if (!notFound(err)) throw err;
      }
    },
    async sweepByOwnerTag(): Promise<string[]> {
      // Typed lists already cover every resource the bootstrap created. The
      // tag-scoped sweep is a best-effort backstop for a straggler created
      // between write-ahead and crash; resource-groups-tagging discovery is
      // wired by the orchestrator when it deploys the real bundle. Returning []
      // here keeps the canonical handler honest about what it currently sweeps.
      return [];
    },
  };

  return { store, destroyer };
}

// ─────────────────────────────────────────────────────────────────────
// Lambda entry point (import-safe; clients built lazily inside)
// ─────────────────────────────────────────────────────────────────────

/**
 * EventBridge Scheduler fires this with no meaningful payload. The real-AWS
 * Store/Destroyer are built lazily via createAwsWiring (SDK clients constructed
 * only here, never on import), then runTripwire applies the typed-list destroy
 * exactly when decideTripwire says so. A missing/unset env contract throws
 * loudly (fail-closed): a tripwire that cannot read its state or name its
 * targets must not silently look like a healthy no-op.
 */
export async function handler(): Promise<RunTripwireResult> {
  const env = process.env as unknown as TripwireEnv;
  const installId = env.TRIPWIRE_INSTALL_ID;
  const stateTable = env.TRIPWIRE_STATE_TABLE;
  if (!installId || !stateTable) {
    throw new Error(
      'ttl-tripwire: TRIPWIRE_INSTALL_ID and TRIPWIRE_STATE_TABLE must be set by the tripwire stack',
    );
  }

  const { store, destroyer } = await createAwsWiring({
    region: env.AWS_REGION,
    stateTable,
  });

  const state = await store.getState(installId);
  if (!state) {
    // No row: nothing was ever armed for this install id, or it was already
    // swept and the row TTL'd out of DynamoDB. Either way, nothing to do.
    return { action: 'noop', reason: `no tripwire state row for install "${installId}"` };
  }

  return runTripwire(state, {
    store,
    destroyer,
    resolveTargets: () => resolveTargetsFromEnv(env),
  });
}
