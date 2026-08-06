import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Fail-closed daily cost total (Codex review).
 *
 * getDailyCostUsd() feeds pre-Bedrock cost-cap enforcement. It used to be
 * fail-soft: a listAgents() failure fell back to the known-agent cache (an
 * incomplete partition set) and a per-partition query failure was caught and
 * skipped, so a DDB/IAM/throttle blip produced a PARTIAL total that was then
 * cached for 60s and used to admit paid calls past the cap (fail OPEN).
 *
 * These tests lock the new contract:
 *   - strict mode throws SpendIndeterminateError when the total is incomplete
 *     (partition set could not be enumerated, OR a partition query threw);
 *   - an incomplete total is NEVER cached, so the next call re-queries instead
 *     of serving a stale partial for 60s;
 *   - a COMPLETE total is still returned (and cached) normally.
 *
 * The fake DDB dispatches by command shape: listAgents() issues a Scan
 * (FilterExpression), getDailyCostUsd() issues per-partition Queries
 * (KeyConditionExpression).
 */

const { send, listKnownAgents } = vi.hoisted(() => ({
  send: vi.fn(),
  listKnownAgents: vi.fn(() => ['main']),
}));

vi.mock('../state/ddb.js', () => ({ ddb: () => ({ send }) }));
vi.mock('../config/agent-loader.js', () => ({ listKnownAgents }));
vi.mock('../../observability/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {} },
}));

import {
  getDailyCostUsd,
  invalidateDailyCostCache,
  SpendIndeterminateError,
} from './token-tracker.js';

interface FakeCmd {
  input: {
    FilterExpression?: string;
    KeyConditionExpression?: string;
    ExpressionAttributeValues?: Record<string, unknown>;
  };
}

const DAY = '2026-05-31';
const isScan = (cmd: FakeCmd) => cmd.input.FilterExpression !== undefined;
const pkOf = (cmd: FakeCmd) => String(cmd.input.ExpressionAttributeValues?.[':pk'] ?? '');

beforeEach(() => {
  send.mockReset();
  invalidateDailyCostCache();
});

describe('getDailyCostUsd, fail closed on an indeterminate total', () => {
  it('strict throws SpendIndeterminateError when listAgents (partition discovery) fails', async () => {
    // Scan (listAgents) throws -> partition set is incomplete. Queries succeed
    // with some spend, so a non-strict read would return a PARTIAL total.
    send.mockImplementation(async (cmd: FakeCmd) => {
      if (isScan(cmd)) throw Object.assign(new Error('throttled'), { name: 'ThrottlingException' });
      return { Items: [{ costUsd: 1.0 }] };
    });

    await expect(getDailyCostUsd({ day: DAY, strict: true })).rejects.toBeInstanceOf(
      SpendIndeterminateError,
    );
  });

  it('strict throws SpendIndeterminateError when a partition query fails', async () => {
    // listAgents succeeds (one stored agent), but the query for that partition
    // throws -> the total skips real spend and is incomplete.
    send.mockImplementation(async (cmd: FakeCmd) => {
      if (isScan(cmd)) return { Items: [{ PK: 'AGENT#main', SK: 'META', agentId: 'main' }] };
      if (pkOf(cmd).startsWith('AGENT#main#DAY#')) {
        throw Object.assign(new Error('denied'), { name: 'AccessDeniedException' });
      }
      return { Items: [] };
    });

    await expect(getDailyCostUsd({ day: DAY, strict: true })).rejects.toBeInstanceOf(
      SpendIndeterminateError,
    );
  });

  it('does NOT cache an incomplete total, a second call re-queries', async () => {
    // First pass: listAgents fails (incomplete). Non-strict, so it returns the
    // partial total instead of throwing. Because it is incomplete it must NOT be
    // cached, so a second (now-healthy) call re-walks the partitions and returns
    // the corrected, larger total rather than the stale partial.
    let listAgentsHealthy = false;
    send.mockImplementation(async (cmd: FakeCmd) => {
      if (isScan(cmd)) {
        if (!listAgentsHealthy) throw Object.assign(new Error('blip'), { name: 'ThrottlingException' });
        return { Items: [{ PK: 'AGENT#extra', SK: 'META', agentId: 'extra' }] };
      }
      const pk = pkOf(cmd);
      if (pk.startsWith('AGENT#main#DAY#')) return { Items: [{ costUsd: 1.0 }] };
      if (pk.startsWith('AGENT#extra#DAY#')) return { Items: [{ costUsd: 4.0 }] };
      return { Items: [] };
    });

    // Incomplete first read: only the cached known agent 'main' is walked.
    const first = await getDailyCostUsd({ day: DAY });
    expect(first).toBeCloseTo(1.0, 6);

    // Heal listAgents; a cached partial would still report 1.0. Because the
    // incomplete total was NOT cached, this re-queries and now includes 'extra'.
    listAgentsHealthy = true;
    const second = await getDailyCostUsd({ day: DAY });
    expect(second).toBeCloseTo(5.0, 6); // main(1.0) + extra(4.0)
  });

  it('returns and caches a COMPLETE total (no re-query on the second call)', async () => {
    let queryCalls = 0;
    send.mockImplementation(async (cmd: FakeCmd) => {
      if (isScan(cmd)) return { Items: [] }; // listAgents succeeds, empty fleet
      queryCalls += 1;
      if (pkOf(cmd).startsWith('AGENT#main#DAY#')) return { Items: [{ costUsd: 2.0 }] };
      return { Items: [] };
    });

    const first = await getDailyCostUsd({ day: DAY, strict: true });
    expect(first).toBeCloseTo(2.0, 6);
    const callsAfterFirst = queryCalls;

    // Second call is served from the 60s cache: no new partition queries.
    const second = await getDailyCostUsd({ day: DAY, strict: true });
    expect(second).toBeCloseTo(2.0, 6);
    expect(queryCalls).toBe(callsAfterFirst);
  });
});
