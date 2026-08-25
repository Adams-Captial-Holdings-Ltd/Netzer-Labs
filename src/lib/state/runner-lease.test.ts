import { describe, it, expect, vi, beforeEach } from 'vitest';

const { send, logWarn } = vi.hoisted(() => ({ send: vi.fn(), logWarn: vi.fn() }));
vi.mock('./ddb.js', () => ({ ddb: () => ({ send }) }));
vi.mock('../../observability/logger.js', () => ({
  logger: { info: vi.fn(), warn: logWarn, error: vi.fn() },
}));

import { tryAcquireRunnerLease, tryClaimOnce, releaseClaimOnce } from './runner-lease.js';

const conditionalFail = () =>
  Object.assign(new Error('conditional'), { name: 'ConditionalCheckFailedException' });

beforeEach(() => {
  send.mockReset();
  logWarn.mockClear();
});

describe('tryAcquireRunnerLease', () => {
  it('acquires with a single conditional put (absent OR expired OR own)', async () => {
    send.mockResolvedValue({});
    const ok = await tryAcquireRunnerLease({
      name: 'canary',
      ttlMs: 600_000,
      holderId: 'me',
      now: 1_000_000,
    });
    expect(ok).toBe(true);
    const input = send.mock.calls[0][0].input;
    expect(input.Item.PK).toBe('RUNNER#canary');
    expect(input.Item.holderId).toBe('me');
    expect(input.Item.expiresAt).toBe(1_600_000);
    expect(input.ConditionExpression).toContain('attribute_not_exists(PK)');
    expect(input.ConditionExpression).toContain('expiresAt <= :now');
    expect(input.ConditionExpression).toContain('holderId = :me');
    expect(input.ExpressionAttributeValues[':now']).toBe(1_000_000);
  });

  it('returns false when another live holder has the lease', async () => {
    send.mockRejectedValue(conditionalFail());
    const ok = await tryAcquireRunnerLease({ name: 'canary', ttlMs: 600_000, holderId: 'me' });
    expect(ok).toBe(false);
    expect(logWarn).not.toHaveBeenCalled();
  });

  it('renewal by the same holder succeeds (holderId = :me arm)', async () => {
    send.mockResolvedValue({});
    const ok = await tryAcquireRunnerLease({ name: 'canary', ttlMs: 600_000, holderId: 'me' });
    expect(ok).toBe(true);
    expect(send.mock.calls[0][0].input.ExpressionAttributeValues[':me']).toBe('me');
  });

  it('fails OPEN on a store error, with a loud warn', async () => {
    send.mockRejectedValue(Object.assign(new Error('down'), { name: 'InternalServerError' }));
    const ok = await tryAcquireRunnerLease({ name: 'webhook-monitor', ttlMs: 240_000, holderId: 'me' });
    expect(ok).toBe(true);
    expect(logWarn).toHaveBeenCalledWith(
      expect.objectContaining({ lease: 'webhook-monitor' }),
      expect.stringContaining('fail-open'),
    );
  });
});

/**
 * The durable half of "a duplicate `(runId, issueId)` dispatch is a NO-OP
 * returning 202, never a 4xx" (Phase 6). The route branch that answers
 * `{deduplicated:true}` is decided entirely by this function's boolean, so the
 * boolean is the thing that has to be pinned — and its most load-bearing
 * property is invisible to `typecheck`: it must NOT carry
 * `tryAcquireRunnerLease`'s `OR holderId = :me` arm.
 */
describe('tryClaimOnce (the dispatch dedupe primitive)', () => {
  it('claims on attribute_not_exists(PK) ALONE — no holderId arm, no expiry arm', async () => {
    // This is the whole reason it is a separate export rather than a call to
    // its neighbour. `tryAcquireRunnerLease`'s condition ends `OR holderId =
    // :me`, which is exactly right for renewing a monitoring lease and exactly
    // wrong here: the SECOND delivery of the same dispatch to the SAME Fargate
    // task would match its own holder id, renew, and be told to run — the turn
    // would execute twice against a live cost cap. A refactor that "unified the
    // duplication" by delegating to the sibling reopens that hole silently, so
    // the absence of those arms is asserted, not just their presence.
    send.mockResolvedValue({});
    const ok = await tryClaimOnce('PAPERCLIP_DISPATCH#run-1#issue-1', 86_400);
    expect(ok).toBe(true);
    const input = send.mock.calls[0][0].input;
    expect(input.ConditionExpression).toBe('attribute_not_exists(PK)');
    expect(input.ConditionExpression).not.toContain('holderId');
    expect(input.ConditionExpression).not.toContain('expiresAt');
    expect(input.ExpressionAttributeValues).toBeUndefined();
  });

  it('writes a CLAIM#-prefixed item with a real ttl, on the already-provisioned lease table', async () => {
    // No new table: TABLE_QUEUE_LEASE is already injected by compute-stack, and
    // adding an idempotency table would make this phase a full `npm run deploy`
    // rather than an image-only `deploy:cloud`. The CLAIM# prefix is what keeps
    // it from colliding with RUNNER# lease rows in that same table.
    send.mockResolvedValue({});
    const before = Math.floor(Date.now() / 1000);
    await tryClaimOnce('run-1#issue-1', 86_400);
    const input = send.mock.calls[0][0].input;
    expect(input.Item.PK).toBe('CLAIM#run-1#issue-1');
    expect(input.Item.PK.startsWith('RUNNER#')).toBe(false);
    expect(input.Item.ttl).toBeGreaterThanOrEqual(before + 86_400);
    expect(input.Item.ttl).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 86_400);
  });

  it('returns FALSE on a repeat of the same key — the production {deduplicated:true} path', async () => {
    // The store, not the process, is what remembers: the second call below is
    // the same key from the same process, which is precisely the case a
    // module-level Set gets right and a holderId-renewal condition gets wrong.
    send.mockResolvedValueOnce({}).mockRejectedValueOnce(conditionalFail());
    expect(await tryClaimOnce('run-1#issue-1', 86_400)).toBe(true);
    expect(await tryClaimOnce('run-1#issue-1', 86_400)).toBe(false);
    expect(logWarn, 'a duplicate is an expected outcome, not an error').not.toHaveBeenCalled();
  });

  it('distinct keys are distinct claims', async () => {
    send.mockResolvedValue({});
    await tryClaimOnce('run-1#issue-1', 60);
    await tryClaimOnce('run-2#issue-1', 60);
    expect(send.mock.calls.map((call) => call[0].input.Item.PK)).toEqual([
      'CLAIM#run-1#issue-1',
      'CLAIM#run-2#issue-1',
    ]);
  });

  it('fails OPEN on a store error, with a loud warn (the polarity this module states)', async () => {
    // A lease-store blip degrades to "briefly duplicated work" — bounded by the
    // spend ledger's daily cap — never to "inbound work is silently dropped".
    send.mockRejectedValue(Object.assign(new Error('down'), { name: 'InternalServerError' }));
    expect(await tryClaimOnce('run-1#issue-1', 86_400)).toBe(true);
    expect(logWarn).toHaveBeenCalledWith(
      expect.objectContaining({ claim: 'run-1#issue-1' }),
      expect.stringContaining('fail-open'),
    );
  });
});

/**
 * The other half of the dispatch claim. `tryClaimOnce` is taken BEFORE the work
 * runs, so without a release a transient failure suppresses every redelivery of
 * that key for the full ttl while having produced nothing — the claim stops
 * being dedupe and becomes silent loss.
 */
describe('releaseClaimOnce (what makes the claim mean "in flight or done")', () => {
  it('deletes the SAME CLAIM# item tryClaimOnce wrote, on the same table', async () => {
    // The round trip is the assertion: a release that targeted a different key
    // would delete nothing, report nothing, and leave the dispatch lost while
    // every other test still passed.
    send.mockResolvedValue({});
    await tryClaimOnce('run-1#issue-1', 86_400);
    await releaseClaimOnce('run-1#issue-1');
    const put = send.mock.calls[0][0].input;
    const del = send.mock.calls[1][0].input;
    expect(del.Key).toEqual({ PK: put.Item.PK });
    expect(del.Key.PK).toBe('CLAIM#run-1#issue-1');
    expect(del.TableName).toBe(put.TableName);
  });

  it('makes the key claimable again — the released dispatch is retryable', async () => {
    // The store, not the process, is what remembers, so this is the property a
    // redelivery actually depends on.
    const held = new Set<string>();
    send.mockImplementation((command: { input: { Item?: { PK: string }; Key?: { PK: string } } }) => {
      const item = command.input.Item;
      if (item) {
        if (held.has(item.PK)) return Promise.reject(conditionalFail());
        held.add(item.PK);
        return Promise.resolve({});
      }
      held.delete(command.input.Key!.PK);
      return Promise.resolve({});
    });
    expect(await tryClaimOnce('run-1#issue-1', 86_400)).toBe(true);
    expect(await tryClaimOnce('run-1#issue-1', 86_400), 'a duplicate must still lose').toBe(false);
    await releaseClaimOnce('run-1#issue-1');
    expect(await tryClaimOnce('run-1#issue-1', 86_400), 'the released key was not retryable').toBe(true);
  });

  it('deletes UNCONDITIONALLY — tryClaimOnce writes no holder to condition on', async () => {
    send.mockResolvedValue({});
    await releaseClaimOnce('run-1#issue-1');
    const input = send.mock.calls[0][0].input;
    expect(input.ConditionExpression).toBeUndefined();
    expect(input.ExpressionAttributeValues).toBeUndefined();
  });

  it('never throws on a store error, and warns — it runs on a path that is already failing', async () => {
    // A failed release degrades to exactly the behaviour that existed before it:
    // the key stays claimed until its ttl. Throwing here would turn the worker's
    // "never rejects" contract into an unhandled rejection off a void call.
    send.mockRejectedValue(Object.assign(new Error('down'), { name: 'InternalServerError' }));
    await expect(releaseClaimOnce('run-1#issue-1')).resolves.toBeUndefined();
    expect(logWarn).toHaveBeenCalledWith(
      expect.objectContaining({ claim: 'run-1#issue-1' }),
      expect.stringContaining('stays claimed'),
    );
  });
});
