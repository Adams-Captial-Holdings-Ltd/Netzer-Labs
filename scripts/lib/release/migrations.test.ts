import { describe, expect, it } from 'vitest';
import {
  MIGRATION_PHASE_ORDER,
  runMigrationPhase,
  validateMigrationRegistry,
  type AppliedMigrationStore,
  type Migration,
  type MigrationExecutorDeps,
} from './migrations.js';

function memStore(initial: string[] = []): AppliedMigrationStore & { keys: Set<string> } {
  const keys = new Set(initial);
  return {
    keys,
    has: async (k) => keys.has(k),
    markApplied: async (k) => {
      keys.add(k);
    },
  };
}

interface Harness {
  deps: MigrationExecutorDeps;
  store: ReturnType<typeof memStore>;
  events: Array<{ event: string; data: Record<string, unknown> }>;
  runOrder: string[];
}

function harness(opts: { applied?: string[]; maintenanceActive?: boolean } = {}): Harness {
  const store = memStore(opts.applied ?? []);
  const events: Harness['events'] = [];
  const runOrder: string[] = [];
  return {
    store,
    events,
    runOrder,
    deps: {
      applied: store,
      journal: async (event, data) => {
        events.push({ event, data });
      },
      maintenanceModeActive: () => opts.maintenanceActive ?? false,
      assertLockHeld: () => {},
      ctx: { log: () => {}, deps: {} },
    },
  };
}

function mig(id: string, phase: Migration['phase'], runOrder: string[], extra: Partial<Migration> = {}): Migration {
  return {
    id,
    phase,
    requiresMaintenanceMode: false,
    idempotencyKey: id,
    run: async () => {
      runOrder.push(id);
    },
    ...extra,
  };
}

describe('phase ordering contract', () => {
  it('the canonical order is expand, backfill, contract', () => {
    expect(MIGRATION_PHASE_ORDER).toEqual(['expand', 'backfill', 'contract']);
  });

  it('runs only the requested phase, in registry order', async () => {
    const h = harness();
    const registry = [
      mig('v2-001-add-attr', 'expand', h.runOrder),
      mig('v2-002-backfill-attr', 'backfill', h.runOrder),
      mig('v2-003-add-table', 'expand', h.runOrder),
      mig('v2-004-drop-old', 'contract', h.runOrder),
    ];
    const res = await runMigrationPhase('expand', registry, h.deps);
    expect(h.runOrder).toEqual(['v2-001-add-attr', 'v2-003-add-table']);
    expect(res.ran).toEqual(['v2-001-add-attr', 'v2-003-add-table']);
    expect(res.skipped).toEqual([]);
  });

  it('executing phases in canonical order runs expand before backfill before contract', async () => {
    const h = harness();
    const registry = [
      mig('m-contract', 'contract', h.runOrder),
      mig('m-backfill', 'backfill', h.runOrder),
      mig('m-expand', 'expand', h.runOrder),
    ];
    for (const phase of MIGRATION_PHASE_ORDER) {
      await runMigrationPhase(phase, registry, h.deps);
    }
    expect(h.runOrder).toEqual(['m-expand', 'm-backfill', 'm-contract']);
  });
});

describe('idempotency', () => {
  it('a re-run skips already-applied migrations and journals the skip', async () => {
    const h = harness();
    const registry = [mig('a', 'expand', h.runOrder), mig('b', 'expand', h.runOrder)];
    await runMigrationPhase('expand', registry, h.deps);
    expect(h.runOrder).toEqual(['a', 'b']);

    // Resume: same phase again (interrupt between deploy phases).
    const res = await runMigrationPhase('expand', registry, h.deps);
    expect(h.runOrder).toEqual(['a', 'b']); // never double-applied
    expect(res.ran).toEqual([]);
    expect(res.skipped).toEqual(['a', 'b']);
    expect(h.events.filter((e) => e.event === 'migration-skipped')).toHaveLength(2);
  });

  it('a PARTIALLY applied phase resumes from the unapplied migration', async () => {
    const h = harness({ applied: ['a'] });
    const registry = [mig('a', 'expand', h.runOrder), mig('b', 'expand', h.runOrder)];
    const res = await runMigrationPhase('expand', registry, h.deps);
    expect(h.runOrder).toEqual(['b']);
    expect(res.skipped).toEqual(['a']);
    expect(res.ran).toEqual(['b']);
  });
});

describe('maintenance-mode gate', () => {
  it('refuses the phase UP FRONT when maintenance is required but inactive', async () => {
    const h = harness({ maintenanceActive: false });
    const registry = [
      mig('safe', 'contract', h.runOrder),
      mig('disruptive', 'contract', h.runOrder, { requiresMaintenanceMode: true }),
    ];
    await expect(runMigrationPhase('contract', registry, h.deps)).rejects.toThrow(
      /maintenance mode/,
    );
    // The gate is checked before anything runs: even the safe one did not run.
    expect(h.runOrder).toEqual([]);
  });

  it('runs when maintenance is active', async () => {
    const h = harness({ maintenanceActive: true });
    const registry = [mig('disruptive', 'contract', h.runOrder, { requiresMaintenanceMode: true })];
    const res = await runMigrationPhase('contract', registry, h.deps);
    expect(res.ran).toEqual(['disruptive']);
  });
});

describe('journaling + lock guard', () => {
  it('journals phase start/complete and per-migration start/applied', async () => {
    const h = harness();
    await runMigrationPhase('expand', [mig('a', 'expand', h.runOrder)], h.deps);
    expect(h.events.map((e) => e.event)).toEqual([
      'migration-phase-expand-start',
      'migration-start',
      'migration-applied',
      'migration-phase-expand-complete',
    ]);
  });

  it('a lost lock aborts before the migration runs', async () => {
    const h = harness();
    h.deps.assertLockHeld = () => {
      throw new Error('lock lost');
    };
    await expect(
      runMigrationPhase('expand', [mig('a', 'expand', h.runOrder)], h.deps),
    ).rejects.toThrow(/lock lost/);
    expect(h.runOrder).toEqual([]);
  });

  it('markApplied happens AFTER a successful run (a crash re-runs, never skips-unapplied)', async () => {
    const h = harness();
    const failing: Migration = {
      id: 'boom',
      phase: 'expand',
      requiresMaintenanceMode: false,
      idempotencyKey: 'boom',
      run: async () => {
        throw new Error('migration blew up');
      },
    };
    await expect(runMigrationPhase('expand', [failing], h.deps)).rejects.toThrow(/blew up/);
    expect(h.store.keys.has('boom')).toBe(false); // resume will retry it
  });
});

describe('validateMigrationRegistry', () => {
  it('rejects duplicate ids and idempotency keys', () => {
    const r: string[] = [];
    expect(() =>
      validateMigrationRegistry([mig('a', 'expand', r), mig('a', 'contract', r)]),
    ).toThrow(/duplicate id/);
    expect(() =>
      validateMigrationRegistry([
        mig('a', 'expand', r),
        mig('b', 'expand', r, { idempotencyKey: 'a' }),
      ]),
    ).toThrow(/duplicate idempotencyKey/);
  });
});
