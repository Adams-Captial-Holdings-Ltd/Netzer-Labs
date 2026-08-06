/**
 * Per-release migration registry (IaC readiness plan, item 42).
 *
 * EMPTY TODAY by design: no release has shipped a schema change yet. When a
 * release changes DynamoDB item shapes, runtime-config keys, or
 * queue/scheduler payload formats, its migrations land here AND the release
 * metadata declares them (migrationFlags.phases + maintenanceModePhases,
 * plus a bumped appSchemaVersion and an honest rollbackPosture).
 *
 * The contract (enforced by scripts/lib/release/migrations.ts):
 *
 *  - phase 'expand'   = additive only; runs BEFORE the service rollout.
 *  - phase 'backfill' = populate the expanded shape; runs after rollout.
 *  - phase 'contract' = remove the old shape; runs ONLY after the new
 *    version is verified stable — contract is what breaks rollback, so a
 *    release with a contract migration is at best 'forward-only'.
 *  - `requiresMaintenanceMode: true` migrations refuse to run unless the
 *    runner has entered maintenance (workers stopped, queues paused).
 *  - `idempotencyKey` must be globally unique forever (convention:
 *    `<release>-<seq>-<slug>`, e.g. `v1.4.0-001-add-session-ttl`); it is
 *    persisted in the applied-store so a resumed phase never double-applies.
 *  - run() itself must ALSO be internally idempotent: a crash between run()
 *    and markApplied() re-runs the migration on resume.
 *
 * Registry order within a phase is execution order. Never delete or reorder
 * shipped entries — old installs chain-upgrade through every release
 * (item 49), so a shipped migration is permanent history.
 */

import type { Migration } from '../lib/release/migrations.js';

export const MIGRATIONS: readonly Migration[] = [];
