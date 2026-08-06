import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  registerSession,
  deregisterSession,
  getSessionsForToken,
  getSession,
  liveSessionCount,
  markAborted,
  teardownAllJarvisSessions,
  teardownSessionsForToken,
  type JarvisSessionHandle,
} from './session-registry.js';

function handle(ownerId: string, tokenHash: string, teardown = vi.fn(async () => {})): JarvisSessionHandle {
  return { ws: {} as never, ownerId, tokenHash, aborted: false, teardown };
}

describe('session-registry (owner-fenced)', () => {
  beforeEach(async () => {
    // Clean slate: tear down anything a prior test left registered.
    await teardownAllJarvisSessions('shutdown');
  });

  it('registers + deregisters by ownerId, indexes by tokenHash', () => {
    const a = handle('o1', 'tokA');
    const b = handle('o2', 'tokA');
    registerSession(a);
    registerSession(b);
    expect(liveSessionCount()).toBe(2);
    expect(getSessionsForToken('tokA').map((h) => h.ownerId).sort()).toEqual(['o1', 'o2']);
    deregisterSession('o1');
    expect(getSession('o1')).toBeUndefined();
    expect(getSessionsForToken('tokA').map((h) => h.ownerId)).toEqual(['o2']);
  });

  it('deregister is owner-conditioned — removing a failed newcomer leaves the incumbent', () => {
    const incumbent = handle('owner-incumbent', 'tokX');
    registerSession(incumbent);
    // A same-token newcomer that lost the lease deregisters ONLY its own ownerId.
    deregisterSession('owner-newcomer-that-never-registered');
    expect(getSession('owner-incumbent')).toBe(incumbent);
    expect(getSessionsForToken('tokX')).toHaveLength(1);
  });

  it('teardownAll sets aborted + invokes every teardown, then is idempotent-safe', async () => {
    const t1 = vi.fn(async () => {});
    const t2 = vi.fn(async () => {});
    const a = handle('o1', 'tokA', t1);
    const b = handle('o2', 'tokB', t2);
    registerSession(a);
    registerSession(b);
    await teardownAllJarvisSessions('panic');
    expect(t1).toHaveBeenCalledWith('panic');
    expect(t2).toHaveBeenCalledWith('panic');
    expect(a.aborted).toBe(true);
    expect(b.aborted).toBe(true);
  });

  it('teardownSessionsForToken only tears down the matching tokenHash (H4)', async () => {
    const revoked = vi.fn(async () => {});
    const other = vi.fn(async () => {});
    registerSession(handle('o1', 'revokedHash', revoked));
    registerSession(handle('o2', 'otherHash', other));
    await teardownSessionsForToken('revokedHash', 'token_revoked');
    expect(revoked).toHaveBeenCalledWith('token_revoked');
    expect(other).not.toHaveBeenCalled();
  });

  it('markAborted sets the pre-open abort flag (H15)', () => {
    const a = handle('o1', 'tokA');
    registerSession(a);
    markAborted('o1');
    expect(a.aborted).toBe(true);
  });
});
