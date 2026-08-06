import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  decideTripwire,
  runTripwire,
  resolveTargetsFromEnv,
  TRIPWIRE_OWNER_TAG_KEY,
  type TripwireState,
  type Destroyer,
  type TripwireStore,
  type DestroyTargets,
  type TripwireEnv,
} from './ttl-tripwire.js';

// ─────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────

const HOUR = 3_600_000;
const ARMED_AT = '2026-06-16T00:00:00.000Z';
const ARMED_MS = Date.parse(ARMED_AT);

function state(overrides: Partial<TripwireState> = {}): TripwireState {
  return {
    installId: 'install-abc',
    armedAt: ARMED_AT,
    ttlHours: 6,
    status: 'armed',
    ...overrides,
  };
}

function targets(overrides: Partial<DestroyTargets> = {}): DestroyTargets {
  return {
    installId: 'install-abc',
    region: 'us-east-1',
    stackNames: ['CCE-Compute', 'ClaudeClawToolkit'],
    buckets: ['claudeclaw-deploy-111-us-east-1'],
    tables: ['claudeclaw-deploy-lock'],
    ecrRepos: ['claudeclaw-orchestrator'],
    ownerTagKey: TRIPWIRE_OWNER_TAG_KEY,
    ...overrides,
  };
}

function makeDestroyer(): { destroyer: Destroyer; calls: string[] } {
  const calls: string[] = [];
  const destroyer: Destroyer = {
    deleteStack: vi.fn(async (s: string) => {
      calls.push(`stack:${s}`);
    }),
    emptyAndDeleteBucket: vi.fn(async (b: string) => {
      calls.push(`bucket:${b}`);
    }),
    deleteTable: vi.fn(async (t: string) => {
      calls.push(`table:${t}`);
    }),
    deleteEcrRepo: vi.fn(async (r: string) => {
      calls.push(`ecr:${r}`);
    }),
    sweepByOwnerTag: vi.fn(async (key: string, id: string) => {
      calls.push(`sweep:${key}=${id}`);
      return [];
    }),
  };
  return { destroyer, calls };
}

function makeStore(initial: TripwireState | null): {
  store: TripwireStore;
  setStatusMock: ReturnType<typeof vi.fn>;
} {
  let current = initial;
  const setStatusMock = vi.fn(async (_id: string, s: TripwireState['status']) => {
    if (current) current = { ...current, status: s };
  });
  const store: TripwireStore = {
    getState: vi.fn(async () => current),
    setStatus: setStatusMock,
  };
  return { store, setStatusMock };
}

// ─────────────────────────────────────────────────────────────────────
// decideTripwire — the pure core
// ─────────────────────────────────────────────────────────────────────

describe('decideTripwire', () => {
  it('NO-OPs forever on a verified install, even long past the TTL', () => {
    const d = decideTripwire(
      state({ status: 'verified', ttlHours: 1 }),
      ARMED_MS + 1000 * HOUR,
    );
    expect(d.action).toBe('noop');
    expect(d.reason).toMatch(/verified/i);
  });

  it('NO-OPs on an already-destroyed install (idempotent)', () => {
    const d = decideTripwire(state({ status: 'destroyed' }), ARMED_MS + 1000 * HOUR);
    expect(d.action).toBe('noop');
    expect(d.reason).toMatch(/destroyed/i);
  });

  it('NO-OPs while still inside the TTL window', () => {
    // armed 5h ago, TTL 6h → still inside.
    const d = decideTripwire(state({ ttlHours: 6 }), ARMED_MS + 5 * HOUR);
    expect(d.action).toBe('noop');
    expect(d.reason).toMatch(/within/i);
  });

  it('DESTROYs once now - armedAt strictly exceeds the TTL', () => {
    // armed 6h + 1ms ago, TTL 6h → expired.
    const d = decideTripwire(state({ ttlHours: 6 }), ARMED_MS + 6 * HOUR + 1);
    expect(d.action).toBe('destroy');
    expect(d.reason).toMatch(/install-abc/);
  });

  it('does NOT destroy exactly at the TTL boundary (strict greater-than)', () => {
    const d = decideTripwire(state({ ttlHours: 6 }), ARMED_MS + 6 * HOUR);
    expect(d.action).toBe('noop');
  });

  it('NO-OPs (never destroys) on an unparseable armedAt', () => {
    const d = decideTripwire(state({ armedAt: 'not-a-date' }), ARMED_MS + 1000 * HOUR);
    expect(d.action).toBe('noop');
    expect(d.reason).toMatch(/parseable|bad data/i);
  });

  it('NO-OPs (never destroys) on an invalid negative ttlHours', () => {
    const d = decideTripwire(state({ ttlHours: -1 }), ARMED_MS + 1000 * HOUR);
    expect(d.action).toBe('noop');
    expect(d.reason).toMatch(/ttlHours|bad data/i);
  });

  it('NO-OPs (never destroys) on a NaN ttlHours', () => {
    const d = decideTripwire(state({ ttlHours: Number.NaN }), ARMED_MS + 1000 * HOUR);
    expect(d.action).toBe('noop');
  });
});

// ─────────────────────────────────────────────────────────────────────
// runTripwire — dispatch only when decideTripwire says 'destroy'
// ─────────────────────────────────────────────────────────────────────

describe('runTripwire', () => {
  let destroyerBundle: ReturnType<typeof makeDestroyer>;

  beforeEach(() => {
    destroyerBundle = makeDestroyer();
  });

  it('calls the destroyer for EVERY typed target when the TTL is expired', async () => {
    const s = state({ ttlHours: 6 });
    const { store, setStatusMock } = makeStore(s);
    const t = targets();

    const result = await runTripwire(s, {
      store,
      destroyer: destroyerBundle.destroyer,
      resolveTargets: () => t,
      nowMs: ARMED_MS + 7 * HOUR,
    });

    expect(result.action).toBe('destroy');
    // Every stack, bucket, table, repo was deleted, then the tag sweep ran.
    expect(destroyerBundle.destroyer.deleteStack).toHaveBeenCalledTimes(2);
    expect(destroyerBundle.destroyer.emptyAndDeleteBucket).toHaveBeenCalledTimes(1);
    expect(destroyerBundle.destroyer.deleteTable).toHaveBeenCalledTimes(1);
    expect(destroyerBundle.destroyer.deleteEcrRepo).toHaveBeenCalledTimes(1);
    expect(destroyerBundle.destroyer.sweepByOwnerTag).toHaveBeenCalledWith(
      TRIPWIRE_OWNER_TAG_KEY,
      'install-abc',
    );
    // Status flipped to 'destroyed' exactly once, AFTER the sweep.
    expect(setStatusMock).toHaveBeenCalledWith('install-abc', 'destroyed');
    expect(setStatusMock).toHaveBeenCalledTimes(1);
  });

  it('deletes CloudFormation stacks BEFORE the bootstrap primitives', async () => {
    const s = state({ ttlHours: 6 });
    const { store } = makeStore(s);
    await runTripwire(s, {
      store,
      destroyer: destroyerBundle.destroyer,
      resolveTargets: () => targets(),
      nowMs: ARMED_MS + 7 * HOUR,
    });
    const calls = destroyerBundle.calls;
    const lastStackIdx = calls.lastIndexOf('stack:ClaudeClawToolkit');
    const firstPrimitiveIdx = Math.min(
      calls.indexOf('bucket:claudeclaw-deploy-111-us-east-1'),
      calls.indexOf('table:claudeclaw-deploy-lock'),
      calls.indexOf('ecr:claudeclaw-orchestrator'),
    );
    expect(lastStackIdx).toBeGreaterThanOrEqual(0);
    expect(lastStackIdx).toBeLessThan(firstPrimitiveIdx);
    // The tag sweep is dead last.
    expect(calls[calls.length - 1]).toBe(`sweep:${TRIPWIRE_OWNER_TAG_KEY}=install-abc`);
  });

  it('NEVER calls the destroyer and NEVER mutates status for a verified install', async () => {
    const s = state({ status: 'verified', ttlHours: 1 });
    const { store, setStatusMock } = makeStore(s);

    const result = await runTripwire(s, {
      store,
      destroyer: destroyerBundle.destroyer,
      resolveTargets: () => targets(),
      // Way past any TTL — must STILL be a no-op.
      nowMs: ARMED_MS + 10_000 * HOUR,
    });

    expect(result.action).toBe('noop');
    expect(destroyerBundle.destroyer.deleteStack).not.toHaveBeenCalled();
    expect(destroyerBundle.destroyer.emptyAndDeleteBucket).not.toHaveBeenCalled();
    expect(destroyerBundle.destroyer.deleteTable).not.toHaveBeenCalled();
    expect(destroyerBundle.destroyer.deleteEcrRepo).not.toHaveBeenCalled();
    expect(destroyerBundle.destroyer.sweepByOwnerTag).not.toHaveBeenCalled();
    expect(setStatusMock).not.toHaveBeenCalled();
  });

  it('NEVER calls the destroyer while still inside the TTL window', async () => {
    const s = state({ ttlHours: 6 });
    const { store, setStatusMock } = makeStore(s);

    const result = await runTripwire(s, {
      store,
      destroyer: destroyerBundle.destroyer,
      resolveTargets: () => targets(),
      nowMs: ARMED_MS + 3 * HOUR, // half-way through the window
    });

    expect(result.action).toBe('noop');
    expect(destroyerBundle.destroyer.deleteStack).not.toHaveBeenCalled();
    expect(setStatusMock).not.toHaveBeenCalled();
  });

  it('does NOT mark destroyed if a deletion throws (retry on next fire)', async () => {
    const s = state({ ttlHours: 6 });
    const { store, setStatusMock } = makeStore(s);
    const boom = new Error('DeleteStack failed');
    destroyerBundle.destroyer.deleteStack = vi.fn(async () => {
      throw boom;
    });

    await expect(
      runTripwire(s, {
        store,
        destroyer: destroyerBundle.destroyer,
        resolveTargets: () => targets(),
        nowMs: ARMED_MS + 7 * HOUR,
      }),
    ).rejects.toThrow('DeleteStack failed');

    // The row was never flipped to 'destroyed' — the next scheduled fire retries.
    expect(setStatusMock).not.toHaveBeenCalled();
  });

  it('surfaces extra stragglers the tag sweep removed', async () => {
    const s = state({ ttlHours: 6 });
    const { store } = makeStore(s);
    destroyerBundle.destroyer.sweepByOwnerTag = vi.fn(async () => [
      'log-group:/aws/lambda/orphan',
    ]);
    const result = await runTripwire(s, {
      store,
      destroyer: destroyerBundle.destroyer,
      resolveTargets: () => targets(),
      nowMs: ARMED_MS + 7 * HOUR,
    });
    expect(result.sweptStragglers).toEqual(['log-group:/aws/lambda/orphan']);
  });
});

// ─────────────────────────────────────────────────────────────────────
// resolveTargetsFromEnv — typed identifiers, no prose
// ─────────────────────────────────────────────────────────────────────

describe('resolveTargetsFromEnv', () => {
  function env(overrides: Partial<TripwireEnv> = {}): TripwireEnv {
    return {
      TRIPWIRE_STATE_TABLE: 'claudeclaw-tripwire-install-abc',
      TRIPWIRE_INSTALL_ID: 'install-abc',
      AWS_REGION: 'us-east-1',
      TRIPWIRE_STACK_NAMES: 'CCE-Compute, ClaudeClawToolkit',
      TRIPWIRE_BUCKETS: 'claudeclaw-deploy-111-us-east-1',
      TRIPWIRE_TABLES: 'claudeclaw-deploy-lock',
      TRIPWIRE_ECR_REPOS: 'claudeclaw-orchestrator',
      ...overrides,
    };
  }

  it('parses comma lists, trims whitespace, and stamps the owner tag key', () => {
    const t = resolveTargetsFromEnv(env());
    expect(t.installId).toBe('install-abc');
    expect(t.region).toBe('us-east-1');
    expect(t.stackNames).toEqual(['CCE-Compute', 'ClaudeClawToolkit']);
    expect(t.buckets).toEqual(['claudeclaw-deploy-111-us-east-1']);
    expect(t.tables).toEqual(['claudeclaw-deploy-lock']);
    expect(t.ecrRepos).toEqual(['claudeclaw-orchestrator']);
    expect(t.ownerTagKey).toBe(TRIPWIRE_OWNER_TAG_KEY);
  });

  it('tolerates a partially-bootstrapped install (empty resource lists)', () => {
    const t = resolveTargetsFromEnv(
      env({
        TRIPWIRE_STACK_NAMES: '',
        TRIPWIRE_BUCKETS: undefined,
        TRIPWIRE_TABLES: '',
        TRIPWIRE_ECR_REPOS: undefined,
      }),
    );
    expect(t.stackNames).toEqual([]);
    expect(t.buckets).toEqual([]);
    expect(t.tables).toEqual([]);
    expect(t.ecrRepos).toEqual([]);
  });

  it('throws when the install id is missing (cannot resolve an owner)', () => {
    expect(() => resolveTargetsFromEnv(env({ TRIPWIRE_INSTALL_ID: '' }))).toThrow(/INSTALL_ID/);
  });

  it('throws when the region is missing', () => {
    expect(() => resolveTargetsFromEnv(env({ AWS_REGION: '' }))).toThrow(/AWS_REGION/);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Regression: adversarial review finding — an expired install with EMPTY
// target lists (frozen at arm time) must NOT be marked 'destroyed' having
// deleted nothing; it must stay armed (fail closed against abandoned spend).
// ─────────────────────────────────────────────────────────────────────

describe('regression: empty-targets sweep stays armed, never marks destroyed', () => {
  function emptyTargets(): DestroyTargets {
    return {
      installId: 'install-abc',
      region: 'us-east-1',
      stackNames: [],
      buckets: [],
      tables: [],
      ecrRepos: [],
      ownerTagKey: TRIPWIRE_OWNER_TAG_KEY,
    };
  }

  it('expired install + empty targets + no stragglers => noop, status untouched', async () => {
    const s = state({ ttlHours: 6 });
    const { store, setStatusMock } = makeStore(s);
    const { destroyer, calls } = makeDestroyer();

    const result = await runTripwire(s, {
      store,
      destroyer,
      resolveTargets: () => emptyTargets(),
      nowMs: ARMED_MS + 7 * HOUR,
    });

    expect(result.action).toBe('noop');
    // Nothing was deleted and the row was NOT flipped to 'destroyed'.
    expect(setStatusMock).not.toHaveBeenCalledWith('install-abc', 'destroyed');
    expect(calls.filter((c) => c.startsWith('stack:') || c.startsWith('bucket:') || c.startsWith('table:') || c.startsWith('ecr:'))).toEqual([]);
  });

  it('expired install + empty typed lists but a tag-sweep straggler => still destroys', async () => {
    const s = state({ ttlHours: 6 });
    const { store, setStatusMock } = makeStore(s);
    const { destroyer } = makeDestroyer();
    destroyer.sweepByOwnerTag = vi.fn(async () => ['arn:aws:s3:::straggler']);

    const result = await runTripwire(s, {
      store,
      destroyer,
      resolveTargets: () => emptyTargets(),
      nowMs: ARMED_MS + 7 * HOUR,
    });

    expect(result.action).toBe('destroy');
    expect(setStatusMock).toHaveBeenCalledWith('install-abc', 'destroyed');
  });
});

// ─────────────────────────────────────────────────────────────────────
// Regression: code-review finding — TOCTOU. An install verified BETWEEN the
// initial read and the sweep must NOT be destroyed.
// ─────────────────────────────────────────────────────────────────────

describe('regression: re-read guard prevents destroying an install verified during the window', () => {
  it('runTripwire aborts (noop) and deletes nothing when the row is verified at re-read', async () => {
    const s = state({ ttlHours: 6 }); // passed-in snapshot was 'armed'
    const setStatusMock = vi.fn();
    const store: TripwireStore = {
      // The operator ran verify during the window: the re-read sees 'verified'.
      getState: vi.fn(async () => ({ ...s, status: 'verified' as const })),
      setStatus: setStatusMock,
    };
    const { destroyer, calls } = makeDestroyer();

    const result = await runTripwire(s, {
      store,
      destroyer,
      resolveTargets: () => targets(),
      nowMs: ARMED_MS + 7 * HOUR,
    });

    expect(result.action).toBe('noop');
    expect(calls).toEqual([]); // no stack/bucket/table/ecr deletion happened
    expect(setStatusMock).not.toHaveBeenCalled();
  });
});
