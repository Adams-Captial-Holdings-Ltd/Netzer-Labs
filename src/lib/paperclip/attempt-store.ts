export const ATTEMPT_LEASE_MS = 30_000;
export const ATTEMPT_RUN_IDS_MAX = 20;
export const ATTEMPT_ROW_TTL_SECONDS = 7 * 24 * 3600;

export type AttemptState = 'running' | 'recorded' | 'delivering' | 'delivered' | 'failed';
export interface AttemptOutcome { disposition: 'done' | 'blocked'; comment: string }
export interface AttemptFailure { code: string; status: number; retryable: boolean }
export interface AttemptRow {
  issueId: string;
  attemptNo: number;
  state: AttemptState;
  leaseToken: number;
  holderId: string;
  leaseExpiresAt: number;
  runIds: string[];
  agentId?: string;
  outcome?: AttemptOutcome;
  failure?: AttemptFailure;
  version: number;
  startedAt: number;
  updatedAt: number;
  recordedAt?: number;
}
export interface AttemptRows {
  get(issueId: string): Promise<AttemptRow | undefined>;
  create(row: AttemptRow): Promise<boolean>;
  replace(issueId: string, expectedVersion: number, next: AttemptRow): Promise<boolean>;
}
export interface AttemptDispatch { issueId: string; runId: string; retryOfRunId?: string; agentId?: string }
export interface AttemptHandle { issueId: string; attemptNo: number; leaseToken: number }

export class FencedOutError extends Error {
  constructor() {
    super('Attempt handle is fenced out');
    this.name = 'FencedOutError';
  }
}

type Decision =
  | { action: 'start'; attemptNo: number; leaseToken: number }
  | { action: 'attach' | 'busy' | 'deliver' | 'replay' | 'unknown' }
  | { action: 'replay_failure'; failure: AttemptFailure };

export function decideDispatch(row: AttemptRow | undefined, dispatch: AttemptDispatch, now: number): Decision {
  if (!row) return { action: 'start', attemptNo: 1, leaseToken: 1 };
  const belongs = (!!dispatch.runId && row.runIds.includes(dispatch.runId))
    || (!!dispatch.retryOfRunId && row.runIds.includes(dispatch.retryOfRunId));
  const start = (): Decision => ({ action: 'start', attemptNo: row.attemptNo + 1, leaseToken: row.leaseToken + 1 });
  switch (row.state) {
    case 'running':
      return row.leaseExpiresAt <= now ? start() : { action: belongs ? 'attach' : 'busy' };
    case 'recorded':
      return belongs ? { action: 'deliver' } : start();
    case 'delivering':
      return row.leaseExpiresAt <= now ? { action: 'unknown' } : { action: belongs ? 'attach' : 'busy' };
    case 'delivered':
      return belongs ? { action: 'replay' } : start();
    case 'failed':
      return row.failure?.retryable || !belongs ? start() : { action: 'replay_failure', failure: row.failure! };
    default:
      return { action: 'unknown' };
  }
}

function appendRunId(runIds: string[], runId: string): string[] {
  return runIds.includes(runId) ? runIds : [...runIds, runId].slice(-ATTEMPT_RUN_IDS_MAX);
}

const MAX_ROUNDS = 8;

export function createAttemptStore({ rows, holderId, now }: { rows: AttemptRows; holderId: string; now: () => number }) {
  const handleFor = (row: AttemptRow): AttemptHandle => ({
    issueId: row.issueId, attemptNo: row.attemptNo, leaseToken: row.leaseToken,
  });
  const owns = (row: AttemptRow | undefined, handle: AttemptHandle): row is AttemptRow =>
    !!row && row.attemptNo === handle.attemptNo && row.leaseToken === handle.leaseToken && row.holderId === holderId;

  // Fail closed: store errors propagate instead of granting work, unlike runner leases.
  async function begin(dispatch: AttemptDispatch) {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const row = await rows.get(dispatch.issueId);
      const time = now();
      const decision = decideDispatch(row, dispatch, time);
      if (decision.action === 'start') {
        const next: AttemptRow = {
          issueId: dispatch.issueId, attemptNo: decision.attemptNo, state: 'running',
          leaseToken: decision.leaseToken, holderId, leaseExpiresAt: time + ATTEMPT_LEASE_MS,
          runIds: [dispatch.runId], version: (row?.version ?? 0) + 1,
          agentId: dispatch.agentId,
          startedAt: time, updatedAt: time,
        };
        const won = row
          ? await rows.replace(dispatch.issueId, row.version, next)
          : await rows.create(next);
        if (won) return { action: 'start' as const, handle: handleFor(next), row: next,
          superseded: row && (row.state === 'recorded' || (row.state === 'running' && row.leaseExpiresAt <= time))
            ? { attemptNo: row.attemptNo, state: row.state } : undefined };
      } else if (decision.action === 'busy' || decision.action === 'replay') {
        return { action: decision.action, row: row! };
      } else if (decision.action === 'replay_failure') {
        if (row!.runIds.includes(dispatch.runId)) return { action: 'replay_failure' as const, failure: decision.failure, row: row! };
        const next = { ...row!, runIds: appendRunId(row!.runIds, dispatch.runId), version: row!.version + 1, updatedAt: time };
        if (await rows.replace(dispatch.issueId, row!.version, next)) {
          return { action: 'replay_failure' as const, failure: decision.failure, row: next };
        }
      } else {
        const current = row!;
        if (decision.action === 'attach' && current.runIds.includes(dispatch.runId)) {
          return { action: 'attach' as const, row: current };
        }
        const next: AttemptRow = { ...current, runIds: appendRunId(current.runIds, dispatch.runId),
          version: current.version + 1, updatedAt: time,
          ...(decision.action === 'deliver' ? { state: 'delivering' as const, holderId,
            leaseToken: current.leaseToken + 1, leaseExpiresAt: time + ATTEMPT_LEASE_MS } : {}),
          ...(decision.action === 'unknown' ? { state: 'failed' as const, leaseToken: current.leaseToken + 1,
            failure: { code: 'delivery_unknown', status: 500, retryable: false } } : {}) };
        if (await rows.replace(dispatch.issueId, current.version, next)) {
          if (decision.action === 'attach') return { action: 'attach' as const, row: next };
          if (decision.action === 'unknown') return { action: 'unknown' as const, row: next };
          return { action: 'deliver' as const, handle: handleFor(next), outcome: next.outcome!, row: next };
        }
      }
    }
    throw new Error('Attempt row changed too many times');
  }

  async function transition(
    handle: AttemptHandle,
    allowed: AttemptState[],
    change: (row: AttemptRow, time: number) => AttemptRow,
  ): Promise<AttemptRow> {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const row = await rows.get(handle.issueId);
      if (!owns(row, handle) || !allowed.includes(row.state)) throw new FencedOutError();
      const time = now();
      const next = { ...change(row, time), version: row.version + 1, updatedAt: time };
      if (await rows.replace(handle.issueId, row.version, next)) return next;
    }
    throw new Error('Attempt row changed too many times');
  }

  return {
    begin,
    get: (issueId: string) => rows.get(issueId),
    claimDelivery: async (issueId: string): Promise<{ handle: AttemptHandle; outcome: AttemptOutcome; runId: string } | undefined> => {
      const row = await rows.get(issueId);
      if (row?.state !== 'recorded' || !row.outcome) return undefined;
      const time = now();
      const next: AttemptRow = { ...row, state: 'delivering', holderId, leaseToken: row.leaseToken + 1,
        leaseExpiresAt: time + ATTEMPT_LEASE_MS, version: row.version + 1, updatedAt: time };
      if (!await rows.replace(issueId, row.version, next)) return undefined;
      return { handle: handleFor(next), outcome: next.outcome!, runId: next.runIds.at(-1)! };
    },
    failExpiredDelivery: async (issueId: string): Promise<boolean> => {
      const row = await rows.get(issueId);
      const time = now();
      if (row?.state !== 'delivering' || row.leaseExpiresAt > time) return false;
      const next: AttemptRow = { ...row, state: 'failed', leaseToken: row.leaseToken + 1,
        failure: { code: 'delivery_unknown', status: 500, retryable: false },
        version: row.version + 1, updatedAt: time };
      return rows.replace(issueId, row.version, next);
    },
    assertFence: async (handle: AttemptHandle): Promise<void> => {
      if (!owns(await rows.get(handle.issueId), handle)) throw new FencedOutError();
    },
    renew: (handle: AttemptHandle) => transition(handle, ['running', 'delivering'],
      (row, time) => ({ ...row, leaseExpiresAt: time + ATTEMPT_LEASE_MS })),
    record: (handle: AttemptHandle, outcome: AttemptOutcome) => transition(handle, ['running'],
      (row, time) => ({ ...row, state: 'recorded', outcome, recordedAt: time })),
    fail: (handle: AttemptHandle, failure: AttemptFailure) => transition(handle, ['running', 'delivering'],
      (row) => ({ ...row, state: 'failed', failure })),
    markDelivered: (handle: AttemptHandle) => transition(handle, ['delivering'],
      (row) => ({ ...row, state: 'delivered', outcome: row.outcome && { ...row.outcome, comment: '' } })),
    releaseDelivery: (handle: AttemptHandle) => transition(handle, ['delivering'],
      (row) => ({ ...row, state: 'recorded' })),
  };
}
