import { describe, expect, it } from 'vitest';
import {
  renderRequiredActionsBlock,
  REQUIRED_ACTIONS_BEGIN,
  REQUIRED_ACTIONS_END,
  runUpdateRunner,
  type RunnerDeps,
  type UpdateLockSession,
} from './runner.js';
import type { Migration } from '../lib/release/migrations.js';
import { requiredActionsHash, type ReleaseMetadata } from '../lib/release/metadata.js';

const COMMIT = 'c'.repeat(40);
const DIGEST = `sha256:${'d'.repeat(64)}`;

function metadataJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    tag: 'v1.1.0',
    commit: COMMIT,
    appSchemaVersion: 1,
    bootstrapPrerequisites: { minNode: '20.0.0', minNpm: '10.0.0' },
    requiredActions: [],
    migrationFlags: { phases: [], maintenanceModePhases: [] },
    rollbackPosture: 'reversible',
    supportWindow: { directFrom: 'v1.0.0' },
    upgradingUrl: 'https://example.com/UPGRADING',
    images: [{ platform: 'linux/arm64', digest: DIGEST, publicRepo: 'public.ecr.aws/cc/orch' }],
    artifactManifestKey: 'artifact-manifest.json',
    ...overrides,
  });
}

interface Harness {
  deps: RunnerDeps;
  calls: string[];
  journal: Array<{ event: string; data: Record<string, unknown> }>;
  logs: string[];
}

function harness(opts: {
  deployedIds?: Array<string | null>;
  doctorCode?: number;
  diffCode?: number;
  deployCode?: number;
  verifyCode?: number;
  migrations?: Migration[];
  confirmAnswer?: boolean;
  copiedDigest?: string;
  maintenanceActive?: boolean;
} = {}): Harness {
  const calls: string[] = [];
  const journal: Harness['journal'] = [];
  const logs: string[] = [];
  const deployedIds = opts.deployedIds ?? ['CCE-1', 'CCE-1'];
  let manifestReadCount = 0;
  const applied = new Set<string>();
  let lockCount = 0;

  const makeLock = (): UpdateLockSession => {
    const n = ++lockCount;
    calls.push(`acquireLock#${n}`);
    return {
      fencingToken: n,
      journal: async (event, data) => {
        journal.push({ event, data });
      },
      assertHeld: () => {},
      release: async () => {
        calls.push(`releaseLock#${n}`);
      },
    };
  };

  return {
    calls,
    journal,
    logs,
    deps: {
      readDeployedManifest: async () => {
        calls.push('readDeployedManifest');
        const id = deployedIds[Math.min(manifestReadCount, deployedIds.length - 1)];
        manifestReadCount++;
        return id === null ? null : { deployId: id };
      },
      runDoctor: async () => {
        calls.push('runDoctor');
        return opts.doctorCode ?? 0;
      },
      runCdkDiff: async () => {
        calls.push('runCdkDiff');
        return opts.diffCode ?? 0;
      },
      acquireLock: async () => makeLock(),
      craneRunner: {
        copy: async () => {
          calls.push('crane.copy');
        },
        digest: async () => {
          calls.push('crane.digest');
          return opts.copiedDigest ?? DIGEST;
        },
      },
      privateRepo: '111111111111.dkr.ecr.us-east-1.amazonaws.com/claudeclaw-orchestrator',
      runDeploy: async () => {
        calls.push('runDeploy');
        return opts.deployCode ?? 0;
      },
      runVerify: async () => {
        calls.push('runVerify');
        return opts.verifyCode ?? 0;
      },
      migrations: opts.migrations ?? [],
      applied: {
        has: async (k) => applied.has(k),
        markApplied: async (k) => {
          applied.add(k);
        },
      },
      maintenance: {
        enter: async () => {
          calls.push('maintenance.enter');
        },
        exit: async () => {
          calls.push('maintenance.exit');
        },
        isActive: () => opts.maintenanceActive ?? false,
      },
      confirm: async () => {
        calls.push('confirm');
        return opts.confirmAnswer ?? true;
      },
      log: (line) => logs.push(line),
    },
  };
}

const ARGS = { targetTag: 'v1.1.0', installedTag: 'v1.0.0', verifiedMetadataJson: metadataJson() };

function migration(id: string, phase: Migration['phase'], calls: string[]): Migration {
  return {
    id,
    phase,
    requiresMaintenanceMode: false,
    idempotencyKey: id,
    run: async () => {
      calls.push(`migration:${id}`);
    },
  };
}

describe('runUpdateRunner — stage separation', () => {
  it('read-only preview (doctor, diff, manifest) runs BEFORE the lock; mutations after', async () => {
    const h = harness();
    await runUpdateRunner(ARGS, h.deps);
    const lockIdx = h.calls.indexOf('acquireLock#1');
    expect(lockIdx).toBeGreaterThan(-1);
    for (const readonlyCall of ['runDoctor', 'runCdkDiff', 'readDeployedManifest']) {
      expect(h.calls.indexOf(readonlyCall)).toBeLessThan(lockIdx);
    }
    // Image import (the first mutation) happens after the lock.
    expect(h.calls.indexOf('crane.copy')).toBeGreaterThan(lockIdx);
  });

  it('full happy-path order: lock -> import -> expand -> release -> deploy -> verify -> lock -> backfill/contract', async () => {
    const h = harness({
      migrations: [] as Migration[],
    });
    const migCalls = h.calls;
    h.deps = {
      ...h.deps,
      migrations: [
        migration('m-expand', 'expand', migCalls),
        migration('m-backfill', 'backfill', migCalls),
        migration('m-contract', 'contract', migCalls),
      ],
    };
    await runUpdateRunner(ARGS, h.deps);
    const order = h.calls;
    const idx = (c: string): number => order.indexOf(c);
    expect(idx('crane.copy')).toBeGreaterThan(idx('acquireLock#1'));
    expect(idx('migration:m-expand')).toBeGreaterThan(idx('crane.digest'));
    // Expand runs BEFORE the rollout; the lock is released before deploy.
    expect(idx('migration:m-expand')).toBeLessThan(idx('runDeploy'));
    expect(idx('releaseLock#1')).toBeLessThan(idx('runDeploy'));
    // Backfill/contract only after verify-stable, under a fresh lock.
    expect(idx('runVerify')).toBeGreaterThan(idx('runDeploy'));
    expect(idx('migration:m-backfill')).toBeGreaterThan(idx('runVerify'));
    expect(idx('migration:m-contract')).toBeGreaterThan(idx('migration:m-backfill'));
    expect(idx('acquireLock#2')).toBeGreaterThan(idx('runVerify'));
    expect(order.indexOf('releaseLock#2')).toBeGreaterThan(idx('migration:m-contract'));
  });

  it('prints the machine-readable required-actions block in the read-only stage', async () => {
    const h = harness();
    await runUpdateRunner(ARGS, h.deps);
    const blob = h.logs.join('\n');
    expect(blob).toContain(REQUIRED_ACTIONS_BEGIN);
    expect(blob).toContain(REQUIRED_ACTIONS_END);
  });
});

describe('runUpdateRunner — abort points', () => {
  it('aborts when the deployed version CHANGED between preview and lock', async () => {
    const h = harness({ deployedIds: ['CCE-1', 'CCE-2'] });
    await expect(runUpdateRunner(ARGS, h.deps)).rejects.toThrow(
      /deployed version changed.*Re-run the update/s,
    );
    // No mutation happened; the lock was released on the way out.
    expect(h.calls).not.toContain('crane.copy');
    expect(h.calls).toContain('releaseLock#1');
  });

  it('doctor failure aborts before the lock (nothing changed)', async () => {
    const h = harness({ doctorCode: 3 });
    await expect(runUpdateRunner(ARGS, h.deps)).rejects.toThrow(/doctor .*failed/i);
    expect(h.calls).not.toContain('acquireLock#1');
  });

  it('cdk diff failure aborts before the lock', async () => {
    const h = harness({ diffCode: 1 });
    await expect(runUpdateRunner(ARGS, h.deps)).rejects.toThrow(/cdk diff/);
    expect(h.calls).not.toContain('acquireLock#1');
  });

  it('deploy failure aborts before verify and before backfill/contract', async () => {
    const h = harness({ deployCode: 1, migrations: [] });
    await expect(runUpdateRunner(ARGS, h.deps)).rejects.toThrow(/phased deploy exited 1/);
    expect(h.calls).not.toContain('runVerify');
    expect(h.calls).not.toContain('acquireLock#2');
  });

  it('verify failure blocks backfill/contract (never migrate an unverified rollout)', async () => {
    const h = harness({ verifyCode: 1 });
    h.deps = {
      ...h.deps,
      migrations: [migration('m-contract', 'contract', h.calls)],
    };
    await expect(runUpdateRunner(ARGS, h.deps)).rejects.toThrow(/NOT running backfill\/contract/);
    expect(h.calls).not.toContain('migration:m-contract');
  });

  it('unconfirmed manual required actions abort before anything mutates', async () => {
    const h = harness({ confirmAnswer: false });
    const args = {
      ...ARGS,
      verifiedMetadataJson: metadataJson({
        requiredActions: [
          { id: 'grant-nova', classification: 'manual-preflight', description: 'console grant' },
        ],
      }),
    };
    await expect(runUpdateRunner(args, h.deps)).rejects.toThrow(/not confirmed/);
    expect(h.calls).not.toContain('acquireLock#1');
    expect(h.calls).not.toContain('crane.copy');
  });

  it('a missing platform image is a hard failure under the lock', async () => {
    const h = harness();
    const args = {
      ...ARGS,
      verifiedMetadataJson: metadataJson({
        images: [{ platform: 'linux/amd64', digest: DIGEST, publicRepo: 'public.ecr.aws/cc/orch' }],
      }),
    };
    await expect(runUpdateRunner(args, h.deps)).rejects.toThrow(/no linux\/arm64 image/);
    expect(h.calls).toContain('releaseLock#1');
  });

  it('an image-import digest mismatch aborts the update (journaled start, no deploy)', async () => {
    const h = harness({ copiedDigest: `sha256:${'9'.repeat(64)}` });
    await expect(runUpdateRunner(ARGS, h.deps)).rejects.toThrow(/FAILED verification/);
    expect(h.journal.some((j) => j.event === 'update-image-import-start')).toBe(true);
    expect(h.journal.some((j) => j.event === 'update-image-imported')).toBe(false);
    expect(h.calls).not.toContain('runDeploy');
  });
});

describe('runUpdateRunner — maintenance gate', () => {
  it('enters maintenance for phases the metadata declares, and exits after', async () => {
    const h = harness();
    h.deps = {
      ...h.deps,
      migrations: [migration('m-expand', 'expand', h.calls)],
    };
    const args = {
      ...ARGS,
      verifiedMetadataJson: metadataJson({
        migrationFlags: { phases: ['expand'], maintenanceModePhases: ['expand'] },
      }),
    };
    await runUpdateRunner(args, h.deps);
    const enterIdx = h.calls.indexOf('maintenance.enter');
    const exitIdx = h.calls.indexOf('maintenance.exit');
    expect(enterIdx).toBeGreaterThan(-1);
    expect(h.calls.indexOf('migration:m-expand')).toBeGreaterThan(enterIdx);
    expect(exitIdx).toBeGreaterThan(h.calls.indexOf('migration:m-expand'));
  });
});

describe('renderRequiredActionsBlock', () => {
  it('emits the hash the approval artifact binds to (item 47)', () => {
    const metadata = JSON.parse(metadataJson()) as ReleaseMetadata;
    const block = renderRequiredActionsBlock(metadata);
    const inner = block
      .replace(`${REQUIRED_ACTIONS_BEGIN}\n`, '')
      .replace(`\n${REQUIRED_ACTIONS_END}`, '');
    const parsed = JSON.parse(inner) as { requiredActionsHash: string };
    expect(parsed.requiredActionsHash).toBe(requiredActionsHash(metadata));
  });
});
