/**
 * Panic state machine. A panic freeze is an emergency all-stop that
 * snapshots current kill-switch state before flipping everything on,
 * then allows controlled restore/repair/force-release.
 *
 * The `generation` counter is monotonically increasing: seed 0,
 * first acquire = 1. This prevents stale restore operations from
 * clobbering a newer panic cycle.
 */

import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from './ddb.js';
import { logger } from '../../observability/logger.js';
import { ALL_KILL_SWITCHES, setKillSwitch, isKillSwitchActive, type KillSwitchName } from './kill-switches-repo.js';
import { writeAudit } from '../audit/audit-writer.js';
import { publishInvalidation } from '../config/invalidation-publisher.js';
import { teardownAllJarvisSessions } from '../voice/session-registry.js';

const TABLE = process.env.TABLE_KILL_SWITCHES ?? 'claudeclaw-kill-switches';
const PANIC_KEY = { PK: 'PANIC#GLOBAL', SK: 'STATE' };

export interface PanicState {
  active: boolean;
  generation: number;
  triggeredAt?: string;
  triggeredBy?: string;
  reason?: string;
  snapshot?: Record<string, boolean>;
  /**
   * Switches that failed to flip during the most recent fan-out, so callers
   * and the UI can see the trip was incomplete instead of assuming success.
   */
  partialFailures?: string[];
}

/**
 * Apply a target value to every kill switch, collecting per-switch failures
 * instead of swallowing them. Returns the names of switches that failed so the
 * caller can surface a partial-failure summary.
 */
async function fanOutSwitches(
  target: boolean | ((name: KillSwitchName, snapshot?: Record<string, boolean>) => boolean),
  note: string,
  actor: string,
  snapshot?: Record<string, boolean>,
): Promise<string[]> {
  // Trip every switch in parallel. The panic fan-out touches ~33 switches; a
  // sequential await chain serializes ~33 DDB round-trips and stretches the
  // freeze latency. allSettled keeps the resilient per-switch failure
  // collection intact (one rejected switch does not abort the rest).
  const results = await Promise.allSettled(
    ALL_KILL_SWITCHES.map((name) => {
      const value = typeof target === 'function' ? target(name, snapshot) : target;
      // publish:false: skip the 35 per-switch SNS publishes; broadcastFullInvalidation
      // sends one 'all' message that clears every peer's caches in a single round-trip.
      return setKillSwitch(name, value, note, actor, { publish: false });
    }),
  );

  const failures: string[] = [];
  results.forEach((result, i) => {
    if (result.status === 'rejected') {
      const name = ALL_KILL_SWITCHES[i];
      failures.push(name);
      const err = result.reason;
      logger.warn(
        { switch: name, err: err instanceof Error ? err.message : String(err) },
        'panic: failed to set switch during fan-out',
      );
    }
  });
  return failures;
}

/**
 * Best-effort SNS fan-out telling every peer task to drop its entire config
 * cache now instead of waiting up to 30s for the in-process poll. Wrapped so a
 * publish failure can never throw out of or delay a panic engage/restore; the
 * 30s cache poll remains the correctness fallback.
 */
function broadcastFullInvalidation(context: string): void {
  void Promise.resolve()
    .then(() => publishInvalidation('all'))
    .catch((err) => {
      logger.warn(
        { context, err: err instanceof Error ? err.message : String(err) },
        'panic: config invalidation broadcast failed (peers fall back to 30s poll)',
      );
    });
}

export async function getCurrentPanicState(): Promise<PanicState> {
  const out = await ddb().send(new GetCommand({ TableName: TABLE, Key: PANIC_KEY }));
  if (!out.Item) return { active: false, generation: 0 };
  return out.Item as PanicState;
}

export async function tryAcquirePanic(
  reason: string,
  triggeredBy: string,
): Promise<{ acquired: boolean; state: PanicState }> {
  const current = await getCurrentPanicState();
  if (current.active) {
    return { acquired: false, state: current };
  }

  const snapshot: Record<string, boolean> = {};
  for (const name of ALL_KILL_SWITCHES) {
    const s = await isKillSwitchActive(name).catch(() => ({ active: false }));
    snapshot[name] = s.active;
  }

  const nextGen = current.generation + 1;
  const newState: PanicState & typeof PANIC_KEY = {
    ...PANIC_KEY,
    active: true,
    generation: nextGen,
    triggeredAt: new Date().toISOString(),
    triggeredBy,
    reason,
    snapshot,
  };

  await ddb().send(
    new PutCommand({
      TableName: TABLE,
      Item: newState,
      ConditionExpression: 'attribute_not_exists(PK) OR generation = :gen',
      ExpressionAttributeValues: { ':gen': current.generation },
    }),
  );

  const failures = await fanOutSwitches(true, `panic gen=${nextGen}: ${reason}`, triggeredBy);
  if (failures.length > 0) {
    newState.partialFailures = failures;
  }

  void writeAudit({
    action: 'panic_triggered',
    detail: { generation: nextGen, reason, partialFailures: failures },
    userId: triggeredBy,
    operatorLabel: triggeredBy,
    surface: 'dashboard',
    result: failures.length > 0 ? 'error' : 'ok',
  });

  // Engage flipped switches via setKillSwitch (which deletes the local cache and
  // publishes per-switch). Broadcast one 'all' so peers also drop runtime-config,
  // cost-cap, rate-limit, and agent caches immediately.
  broadcastFullInvalidation('panic_triggered');

  // H14: the `all` broadcast uses publish:false, so THIS task never receives a
  // self-callback. Tear down our own live Jarvis sessions synchronously here so
  // panic kills an idle live stream without waiting for a later turn.
  void teardownAllJarvisSessions('panic');

  return { acquired: true, state: newState };
}

export async function releasePanic(
  generation: number,
  releasedBy: string,
): Promise<PanicState> {
  const current = await getCurrentPanicState();
  if (!current.active || current.generation !== generation) {
    throw new Error(`generation mismatch: expected ${generation}, got ${current.generation}`);
  }

  const nextGen = current.generation + 1;
  const snapshot = current.snapshot;
  const failures = snapshot
    ? await fanOutSwitches(
        (name) => snapshot[name] ?? false,
        `restored from panic gen=${generation}`,
        releasedBy,
        snapshot,
      )
    : [];

  await ddb().send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        ...PANIC_KEY,
        active: false,
        generation: nextGen,
        releasedAt: new Date().toISOString(),
        releasedBy,
        ...(failures.length > 0 ? { partialFailures: failures } : {}),
      },
    }),
  );

  void writeAudit({
    action: 'panic_restored',
    detail: { generation: nextGen, partialFailures: failures },
    userId: releasedBy,
    operatorLabel: releasedBy,
    surface: 'dashboard',
    result: failures.length > 0 ? 'error' : 'ok',
  });

  broadcastFullInvalidation('panic_restored');

  return {
    active: false,
    generation: nextGen,
    ...(failures.length > 0 ? { partialFailures: failures } : {}),
  };
}

export async function forceReleasePanic(
  releasedBy: string,
): Promise<{ released: boolean; state: PanicState }> {
  const current = await getCurrentPanicState();
  // Force-release is destructive (it clears every switch regardless of the
  // pre-panic snapshot). Refuse to run when there is no active panic so a
  // stray call cannot mutate state out from under a clean system.
  if (!current.active) {
    return { released: false, state: current };
  }

  const nextGen = current.generation + 1;
  const failures = await fanOutSwitches(false, `force-release gen=${nextGen}`, releasedBy);

  await ddb().send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        ...PANIC_KEY,
        active: false,
        generation: nextGen,
        releasedAt: new Date().toISOString(),
        releasedBy,
        forceReleased: true,
        ...(failures.length > 0 ? { partialFailures: failures } : {}),
      },
    }),
  );

  void writeAudit({
    action: 'panic_force_released',
    detail: { generation: nextGen, partialFailures: failures },
    userId: releasedBy,
    operatorLabel: releasedBy,
    surface: 'dashboard',
    result: failures.length > 0 ? 'error' : 'ok',
  });

  broadcastFullInvalidation('panic_force_released');

  return {
    released: true,
    state: {
      active: false,
      generation: nextGen,
      ...(failures.length > 0 ? { partialFailures: failures } : {}),
    },
  };
}
