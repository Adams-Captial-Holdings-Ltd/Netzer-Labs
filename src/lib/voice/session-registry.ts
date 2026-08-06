/**
 * Owner-fenced live Jarvis session registry (JARVIS-PLAN.md §1b H15 + 01).
 *
 * Keyed by `ownerId` so a FAILED same-token newcomer can never deregister the
 * live incumbent (same-token arbitration happens at the lease, not here). Each
 * handle carries an `aborted` flag any teardown sets — the race-free pre-open
 * handshake checks it at every await boundary so an invalidation that fires
 * before the Nova stream is attached still stops the session.
 *
 * The teardown fanout is invoked by the config-invalidation listener (panic
 * `all`, the emergency switches, `jarvis_voice_disabled`, `token_revoked`) and
 * by `tryAcquirePanic` locally (it publishes with publish:false, so the
 * initiating task gets no self-callback — H14). Each handle's `teardown`
 * closure (built in the relay) maps the reason to the canonical close code and
 * does the owner-conditioned lease/ledger release + audit, then deregisters.
 */

import type { WebSocket } from 'ws';
import { logger } from '../../observability/logger.js';
import type { KillSwitchName } from '../state/kill-switches-repo.js';

export type JarvisTeardownReason =
  | 'jarvis_disabled'
  | 'jarvis_voice_disabled'
  | 'dashboard_read_disabled'
  | 'bedrock_global'
  | 'token_revoked'
  | 'panic'
  | 'shutdown'
  | 'max_session'
  // Mid-session eviction: the lease was reclaimed after expiry (not an operator
  // kill). The client reconnects.
  | 'lost_lease';

// Kill switches whose ACTIVATION tears down live voice sessions (H13/H8). Shared
// by the fanout listener (peer tasks) AND the kill-switch writer (its own local
// sessions, which never see a self-origin fanout message), so a flip is honoured
// on every task. dashboard_read_disabled / bedrock_global stop reads + the model;
// jarvis_disabled is the emergency kill; jarvis_voice_disabled drops audio (4012).
export const JARVIS_TEARDOWN_SWITCHES: Partial<Record<KillSwitchName, JarvisTeardownReason>> = {
  jarvis_disabled: 'jarvis_disabled',
  jarvis_voice_disabled: 'jarvis_voice_disabled',
  dashboard_read_disabled: 'dashboard_read_disabled',
  bedrock_global: 'bedrock_global',
};

export interface JarvisSessionHandle {
  ws: WebSocket;
  tokenHash: string;
  ownerId: string;
  /** Set by any teardown; the handshake re-checks it before attaching Nova (H15). */
  aborted: boolean;
  /** Idempotent teardown: closes the socket, releases leases/ledger, audits, deregisters. */
  teardown: (reason: JarvisTeardownReason) => Promise<void>;
}

const byOwner = new Map<string, JarvisSessionHandle>();
const byToken = new Map<string, Set<string>>(); // tokenHash -> Set<ownerId>

export function registerSession(h: JarvisSessionHandle): void {
  byOwner.set(h.ownerId, h);
  let owners = byToken.get(h.tokenHash);
  if (!owners) {
    owners = new Set();
    byToken.set(h.tokenHash, owners);
  }
  owners.add(h.ownerId);
}

/** Owner-conditioned: only removes THIS ownerId, never a same-token replacement. */
export function deregisterSession(ownerId: string): void {
  const h = byOwner.get(ownerId);
  if (!h) return;
  byOwner.delete(ownerId);
  const owners = byToken.get(h.tokenHash);
  if (owners) {
    owners.delete(ownerId);
    if (owners.size === 0) byToken.delete(h.tokenHash);
  }
}

export function getSession(ownerId: string): JarvisSessionHandle | undefined {
  return byOwner.get(ownerId);
}

export function getSessionsForToken(tokenHash: string): JarvisSessionHandle[] {
  const owners = byToken.get(tokenHash);
  if (!owners) return [];
  return [...owners].map((o) => byOwner.get(o)).filter((h): h is JarvisSessionHandle => Boolean(h));
}

export function liveSessionCount(): number {
  return byOwner.size;
}

/** Mark a session aborted so the pre-open handshake bails (H15). */
export function markAborted(ownerId: string): void {
  const h = byOwner.get(ownerId);
  if (h) h.aborted = true;
}

async function fanout(handles: JarvisSessionHandle[], reason: JarvisTeardownReason): Promise<void> {
  await Promise.allSettled(
    handles.map(async (h) => {
      h.aborted = true;
      try {
        await h.teardown(reason);
      } catch (err) {
        logger.warn(
          { ownerId: h.ownerId, reason, err: err instanceof Error ? err.message : String(err) },
          'jarvis teardown threw',
        );
      }
    }),
  );
}

/** Tear down every live session (panic `all`, shutdown). */
export async function teardownAllJarvisSessions(reason: JarvisTeardownReason): Promise<void> {
  const handles = [...byOwner.values()];
  if (handles.length === 0) return;
  logger.info({ reason, count: handles.length }, 'tearing down all jarvis sessions');
  await fanout(handles, reason);
}

/** Tear down every session for a revoked token (H4). */
export async function teardownSessionsForToken(
  tokenHash: string,
  reason: JarvisTeardownReason,
): Promise<void> {
  await fanout(getSessionsForToken(tokenHash), reason);
}
