import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  initRunState,
  readRunState,
  runStateDir,
  runStatePath,
  recordPlannedResource,
  markObserved,
  addOrUpdateHumanGate,
  recordCostAck,
  setPhase,
  setStatus,
  setResumeClass,
  setVerified,
  armTripwire,
  patchBootstrap,
  runStateSchema,
  RUN_STATE_DIR_NAME,
  RUN_STATE_FILE_NAME,
  type InventoryItem,
} from './run-state.js';

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), `cce-runstate-${randomUUID()}-`));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe('init -> read round trip', () => {
  it('creates the dir + file and reads it back', () => {
    expect(readRunState(cwd)).toBeNull();
    const state = initRunState({ region: 'us-east-1', mode: 'chat', cwd });
    expect(state.runId).toMatch(/[0-9a-f-]{36}/);
    expect(state.phase).toBe(0);
    expect(state.status).toBe('in-progress');
    const readBack = readRunState(cwd);
    expect(readBack).toEqual(state);
    expect(runStateDir(cwd).endsWith(RUN_STATE_DIR_NAME)).toBe(true);
    expect(runStatePath(cwd).endsWith(RUN_STATE_FILE_NAME)).toBe(true);
  });

  it('uses an explicit runId when given', () => {
    const state = initRunState({ runId: 'run-abc', cwd });
    expect(state.runId).toBe('run-abc');
  });

  it('never clobbers an existing run-state', () => {
    const first = initRunState({ runId: 'run-1', region: 'us-east-1', cwd });
    const second = initRunState({ runId: 'run-2-should-be-ignored', region: 'eu-west-1', cwd });
    expect(second.runId).toBe('run-1');
    expect(second.region).toBe('us-east-1');
    expect(second.createdAt).toBe(first.createdAt);
  });
});

describe('fail-closed read', () => {
  it('throws on a present-but-malformed file', () => {
    mkdirSync(runStateDir(cwd), { recursive: true });
    writeFileSync(runStatePath(cwd), '{ not json', 'utf-8');
    expect(() => readRunState(cwd)).toThrow(/not valid JSON/i);
  });

  it('throws on a structurally invalid document', () => {
    mkdirSync(runStateDir(cwd), { recursive: true });
    writeFileSync(
      runStatePath(cwd),
      JSON.stringify({ schemaVersion: 1, runId: 'x' }),
      'utf-8',
    );
    expect(() => readRunState(cwd)).toThrow(/failed validation/i);
  });

  it('throws on an out-of-range phase', () => {
    mkdirSync(runStateDir(cwd), { recursive: true });
    const base = initRunState({ cwd });
    const corrupt = { ...base, phase: 9 };
    writeFileSync(runStatePath(cwd), JSON.stringify(corrupt), 'utf-8');
    expect(() => readRunState(cwd)).toThrow(/failed validation/i);
  });
});

describe('write-ahead inventory', () => {
  const item: InventoryItem = {
    id: 'bucket:claudeclaw-deploy',
    type: 's3-bucket',
    phase: 1,
    plannedAt: '2026-06-16T00:00:00.000Z',
    region: 'us-east-1',
  };

  beforeEach(() => {
    initRunState({ cwd });
  });

  it('appends a planned resource then marks it observed', () => {
    recordPlannedResource(item, cwd);
    let state = readRunState(cwd)!;
    expect(state.writeAheadInventory).toHaveLength(1);
    expect(state.writeAheadInventory[0].observedAt).toBeUndefined();

    markObserved(item.id, '2026-06-16T00:05:00.000Z', cwd);
    state = readRunState(cwd)!;
    expect(state.writeAheadInventory[0].observedAt).toBe('2026-06-16T00:05:00.000Z');
  });

  it('updates a planned row in place on re-record (no duplicate)', () => {
    recordPlannedResource(item, cwd);
    recordPlannedResource({ ...item, region: 'us-west-2' }, cwd);
    const state = readRunState(cwd)!;
    expect(state.writeAheadInventory).toHaveLength(1);
    expect(state.writeAheadInventory[0].region).toBe('us-west-2');
  });

  it('markObserved throws when the id was never planned', () => {
    expect(() => markObserved('bucket:never-planned', undefined, cwd)).toThrow(
      /not in the write-ahead inventory/i,
    );
  });
});

describe('human gates / cost ack / status', () => {
  beforeEach(() => {
    initRunState({ cwd });
  });

  it('adds then satisfies a gate in place', () => {
    addOrUpdateHumanGate(
      { gateId: 'cost-ack', kind: 'cost', status: 'open', recordedAt: '2026-06-16T00:00:00.000Z' },
      cwd,
    );
    addOrUpdateHumanGate(
      {
        gateId: 'cost-ack',
        kind: 'cost',
        status: 'satisfied',
        recordedAt: '2026-06-16T00:01:00.000Z',
      },
      cwd,
    );
    const state = readRunState(cwd)!;
    expect(state.humanGates).toHaveLength(1);
    expect(state.humanGates[0].status).toBe('satisfied');
  });

  it('records cost ack', () => {
    recordCostAck(
      {
        acknowledgedAt: '2026-06-16T00:00:00.000Z',
        standingMonthlyUsd: 200,
        dailyCapUsd: 50,
        mode: 'chat',
      },
      cwd,
    );
    expect(readRunState(cwd)!.costAck?.standingMonthlyUsd).toBe(200);
  });

  it('moves through phase / status / resume class / verified', () => {
    setPhase(3, cwd);
    setStatus('failed', cwd);
    setResumeClass('reconcile', cwd);
    let state = readRunState(cwd)!;
    expect(state.phase).toBe(3);
    expect(state.status).toBe('failed');
    expect(state.resumeClass).toBe('reconcile');

    setVerified(cwd);
    state = readRunState(cwd)!;
    expect(state.status).toBe('verified');
  });

  it('arms the tripwire and merges bootstrap fields', () => {
    patchBootstrap({ stateBucket: 'claudeclaw-deploy-x', lockTable: 'claudeclaw-deploy-lock' }, cwd);
    armTripwire('2026-06-16T00:00:00.000Z', cwd);
    const state = readRunState(cwd)!;
    expect(state.bootstrap?.stateBucket).toBe('claudeclaw-deploy-x');
    expect(state.bootstrap?.tripwireArmed).toBe(true);
    expect(state.bootstrap?.tripwireArmedAt).toBe('2026-06-16T00:00:00.000Z');
  });
});

describe('atomic write', () => {
  it('leaves a valid parseable JSON document on disk', () => {
    initRunState({ cwd });
    setPhase(2, cwd);
    const raw = readFileSync(runStatePath(cwd), 'utf-8');
    const parsed = runStateSchema.safeParse(JSON.parse(raw));
    expect(parsed.success).toBe(true);
    expect(raw.endsWith('\n')).toBe(true);
  });

  it('refreshes updatedAt on every write', () => {
    const init = initRunState({ cwd });
    const after = setPhase(1, cwd);
    expect(after.updatedAt >= init.updatedAt).toBe(true);
    expect(after.createdAt).toBe(init.createdAt);
  });
});
