/**
 * Migration framework: the expand → backfill → contract ordering contract
 * (IaC readiness plan, item 42).
 *
 * Migrations are not a vibe; they have an explicit ordering contract:
 *
 *   expand    — additive only (new attributes, new tables, new config keys
 *               with defaults). Runs BEFORE the service rollout, so the old
 *               code and the new code can both run against the expanded
 *               schema during the deploy window.
 *   backfill  — populate the expanded shape from existing data. Runs after
 *               the rollout, before contract.
 *   contract  — remove the old shape. Runs ONLY after the new version is
 *               verified stable, because contract is what breaks rollback.
 *
 * Every phase is a JOURNALED LIFECYCLE PHASE under item 14's machinery: the
 * caller holds the lifecycle lock (heartbeat running), the fencing token is
 * stamped on every journal write, and each migration carries an IDEMPOTENCY
 * KEY persisted in an applied-store, so a resumed phase never double-applies
 * — re-running a phase skips already-applied migrations and journals the
 * skip.
 *
 * Maintenance mode is a GATE, not a side effect: a migration that declares
 * `requiresMaintenanceMode` refuses to run unless the caller has already
 * entered maintenance (workers/schedulers stopped, queues paused). The
 * executor never enters maintenance itself — that is a disruptive operation
 * the runner sequences explicitly (item 22's machinery).
 *
 * The per-release registry lives at scripts/migrations/index.ts (empty
 * today); each schema-changing release appends its migrations there and
 * declares the phases + maintenance needs in its release metadata
 * (migrationFlags), which the updater surfaces before anything mutates.
 */

import type { MigrationPhaseName } from './metadata.js';

export type MigrationPhase = MigrationPhaseName;

/** The canonical phase order. Rollout happens between expand and backfill. */
export const MIGRATION_PHASE_ORDER: readonly MigrationPhase[] = [
  'expand',
  'backfill',
  'contract',
];

export interface MigrationContext {
  /** Progress logger. */
  log: (line: string) => void;
  /**
   * Anything the migration needs (DDB client, table names, ...) rides in
   * here; the runner builds it. Typed loosely on purpose: migrations are
   * per-release code and the framework must not need a bump when a release
   * adds a dependency.
   */
  deps: Record<string, unknown>;
}

export interface Migration {
  /** Stable unique id, conventionally <release>-<seq>-<slug>. */
  id: string;
  phase: MigrationPhase;
  /** Must this migration run inside maintenance mode (item 22)? */
  requiresMaintenanceMode: boolean;
  /**
   * Persisted in the applied-store before run() is journaled as applied; a
   * resumed phase skips keys already present. Conventionally equal to `id`,
   * but kept separate so a re-keyed retry can be expressed deliberately.
   */
  idempotencyKey: string;
  run(ctx: MigrationContext): Promise<void>;
}

/** Durable record of applied idempotency keys (DDB-backed in production). */
export interface AppliedMigrationStore {
  has(idempotencyKey: string): Promise<boolean>;
  markApplied(idempotencyKey: string): Promise<void>;
}

export interface MigrationExecutorDeps {
  applied: AppliedMigrationStore;
  /**
   * Journal sink; the runner wires appendJournal with the held lock's
   * fencing token already bound. Every run/skip/failure is journaled.
   */
  journal: (event: string, data: Record<string, unknown>) => Promise<void>;
  /** True when maintenance mode is currently active (item 22 machinery). */
  maintenanceModeActive: () => boolean;
  /**
   * Lock guard: throws if the lifecycle lock is no longer held. Called
   * before every migration so a lost lease stops mutating immediately.
   */
  assertLockHeld: () => void;
  ctx: MigrationContext;
}

export interface MigrationPhaseResult {
  phase: MigrationPhase;
  ran: string[];
  skipped: string[];
}

/** Validate registry shape early: duplicate ids/keys are registry bugs. */
export function validateMigrationRegistry(migrations: readonly Migration[]): void {
  const ids = new Set<string>();
  const keys = new Set<string>();
  for (const m of migrations) {
    if (ids.has(m.id)) throw new Error(`migration registry has duplicate id "${m.id}"`);
    if (keys.has(m.idempotencyKey)) {
      throw new Error(`migration registry has duplicate idempotencyKey "${m.idempotencyKey}"`);
    }
    if (!MIGRATION_PHASE_ORDER.includes(m.phase)) {
      throw new Error(`migration "${m.id}" has unknown phase "${String(m.phase)}"`);
    }
    ids.add(m.id);
    keys.add(m.idempotencyKey);
  }
}

/**
 * Run ONE phase: the registry subset for that phase, in registry order.
 *
 *  - Already-applied idempotency keys are SKIPPED and journaled as skipped
 *    (a resumed phase never double-applies);
 *  - a `requiresMaintenanceMode` migration with maintenance inactive is a
 *    hard failure BEFORE anything in the phase runs (the gate is checked
 *    up front so a phase never half-runs and then discovers the gate);
 *  - each migration is journaled started → applied, with markApplied
 *    persisted AFTER a successful run (a crash between run and mark means
 *    the migration may re-run — migrations must therefore be internally
 *    idempotent too, which the journal entry documents);
 *  - the lock guard runs before every migration.
 */
export async function runMigrationPhase(
  phase: MigrationPhase,
  migrations: readonly Migration[],
  deps: MigrationExecutorDeps,
): Promise<MigrationPhaseResult> {
  validateMigrationRegistry(migrations);
  const phaseMigrations = migrations.filter((m) => m.phase === phase);

  // Gate check up front: never start a phase that cannot finish.
  const needsMaintenance = phaseMigrations.filter((m) => m.requiresMaintenanceMode);
  if (needsMaintenance.length > 0 && !deps.maintenanceModeActive()) {
    throw new Error(
      `migration phase "${phase}" includes migrations that require maintenance mode ` +
        `(${needsMaintenance.map((m) => m.id).join(', ')}) but maintenance mode is not ` +
        'active. Enter maintenance (workers/schedulers stopped, queues paused) first.',
    );
  }

  const ran: string[] = [];
  const skipped: string[] = [];

  await deps.journal(`migration-phase-${phase}-start`, {
    phase,
    total: phaseMigrations.length,
  });

  for (const m of phaseMigrations) {
    deps.assertLockHeld();

    if (await deps.applied.has(m.idempotencyKey)) {
      skipped.push(m.id);
      await deps.journal('migration-skipped', {
        id: m.id,
        phase,
        idempotencyKey: m.idempotencyKey,
        reason: 'idempotency key already applied (resumed phase)',
      });
      continue;
    }

    await deps.journal('migration-start', { id: m.id, phase, idempotencyKey: m.idempotencyKey });
    await m.run(deps.ctx);
    await deps.applied.markApplied(m.idempotencyKey);
    await deps.journal('migration-applied', { id: m.id, phase, idempotencyKey: m.idempotencyKey });
    ran.push(m.id);
  }

  await deps.journal(`migration-phase-${phase}-complete`, { phase, ran, skipped });
  return { phase, ran, skipped };
}
