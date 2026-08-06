/**
 * Fail-closed Jarvis admission gate (JARVIS-PLAN.md §1b H7/H11).
 *
 * `isJarvisEnabled(principal)` resolves the H11 rollout precedence, first
 * denial wins:
 *   (1) JARVIS_LAUNCH_ENABLED env flag false  → deny (a fresh deploy is OFF
 *       regardless of DDB state).
 *   (2) panic active                          → deny.
 *   (3) jarvis_disabled emergency kill        → deny ALL incl. canary
 *       (checked BEFORE the allowlist so it is always an effective rollback).
 *   (4) jarvis_canary_mode active             → admit only allowlisted tokens.
 *   (5) otherwise (GA)                        → admit.
 *
 * CRITICAL: this is fail-closed on EVERY DDB read. The generic
 * `isKillSwitchActive` is fail-OPEN — it returns `{active:false}` on both a
 * missing item AND a DDB error — so it CANNOT be used here. We do our own read
 * that distinguishes "present & inactive" (proceed) from "missing or error"
 * (deny). That is why a CDK custom resource seeds `jarvis_disabled = inactive`:
 * without that row the fail-closed reader denies forever on a fresh table.
 *
 * The consistency check (H12) bans the fail-open catch-to-inactive shortcut on
 * a Jarvis gate — this module fails closed via try/catch → deny instead.
 */

import { GetCommand, PutCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../state/ddb.js';
import { logger } from '../../observability/logger.js';
import { getCurrentPanicState } from '../state/panic-state-repo.js';
import type { TokenPrincipal } from '../auth/dashboard-auth.js';
import type { KillSwitchName } from '../state/kill-switches-repo.js';

const KILL_SWITCH_TABLE = process.env.TABLE_KILL_SWITCHES ?? 'claudeclaw-kill-switches';
const CANARY_TABLE = process.env.TABLE_JARVIS_CANARY ?? 'claudeclaw-jarvis-canary';

/** The launch gate. Read from process.env directly so tests stay deterministic. */
export function isJarvisLaunchEnabled(): boolean {
  return process.env.JARVIS_LAUNCH_ENABLED === 'true';
}

interface RawSwitch {
  present: boolean;
  active: boolean;
}

/**
 * Fail-closed kill-switch read. Returns `{present:false}` ONLY when the table
 * is reachable and the item genuinely does not exist; THROWS on any DDB error
 * so the caller can deny. This is deliberately not the fail-open
 * `isKillSwitchActive`.
 */
export async function readSwitchFailClosed(name: KillSwitchName): Promise<RawSwitch> {
  const out = await ddb().send(
    new GetCommand({
      TableName: KILL_SWITCH_TABLE,
      Key: { PK: `SWITCH#${name}`, SK: 'STATUS' },
    }),
  );
  if (!out.Item) return { present: false, active: false };
  return { present: true, active: Boolean((out.Item as { active?: boolean }).active) };
}

// Membership cache, busted by a `canary`/`all` config-invalidation (Reference
// Contracts D). A short TTL is the correctness fallback if a fanout is missed.
const CANARY_CACHE_TTL_MS = 30_000;
const canaryCache = new Map<string, { member: boolean; expiresAt: number }>();

export function invalidateCanaryCache(tokenHash?: string): void {
  if (tokenHash) canaryCache.delete(tokenHash);
  else canaryCache.clear();
}

/**
 * Canary allowlist membership. Fail-closed: a missing item is NOT allowed, and
 * any DDB error (e.g. the table does not exist yet) THROWS so the caller denies.
 */
export async function canaryAllowlistHas(tokenHash: string): Promise<boolean> {
  const cached = canaryCache.get(tokenHash);
  if (cached && cached.expiresAt > Date.now()) return cached.member;
  const out = await ddb().send(new GetCommand({ TableName: CANARY_TABLE, Key: { PK: tokenHash } }));
  const member = Boolean(out.Item);
  canaryCache.set(tokenHash, { member, expiresAt: Date.now() + CANARY_CACHE_TTL_MS });
  return member;
}

/** Admin: add a token to the canary allowlist (Reference Contracts D). */
export async function addCanaryToken(tokenHash: string, label: string, addedBy: string): Promise<void> {
  await ddb().send(
    new PutCommand({
      TableName: CANARY_TABLE,
      Item: { PK: tokenHash, label, addedBy, addedAt: new Date().toISOString() },
    }),
  );
  canaryCache.set(tokenHash, { member: true, expiresAt: Date.now() + CANARY_CACHE_TTL_MS });
}

/** Admin: remove a token from the canary allowlist. */
export async function removeCanaryToken(tokenHash: string): Promise<void> {
  await ddb().send(new DeleteCommand({ TableName: CANARY_TABLE, Key: { PK: tokenHash } }));
  canaryCache.set(tokenHash, { member: false, expiresAt: Date.now() + CANARY_CACHE_TTL_MS });
}

/**
 * The fail-closed admission decision. Any unknown read resolves to DENY.
 */
export async function isJarvisEnabled(principal: TokenPrincipal): Promise<boolean> {
  // (1) launch gate — env, default off.
  if (!isJarvisLaunchEnabled()) return false;

  // (2) panic — unknown → deny.
  try {
    const panic = await getCurrentPanicState();
    if (panic.active) return false;
  } catch (err) {
    logger.warn({ err: msg(err) }, 'jarvis gate: panic read failed — denying');
    return false;
  }

  // (3) jarvis_disabled emergency kill — missing OR error OR active → deny.
  try {
    const killed = await readSwitchFailClosed('jarvis_disabled');
    if (!killed.present || killed.active) return false;
  } catch (err) {
    logger.warn({ err: msg(err) }, 'jarvis gate: jarvis_disabled read failed — denying');
    return false;
  }

  // (4) canary mode — when active, admit only allowlisted tokens.
  let canaryActive = false;
  try {
    const canary = await readSwitchFailClosed('jarvis_canary_mode');
    canaryActive = canary.present && canary.active;
  } catch (err) {
    logger.warn({ err: msg(err) }, 'jarvis gate: jarvis_canary_mode read failed — denying');
    return false;
  }
  if (canaryActive) {
    try {
      return await canaryAllowlistHas(principal.tokenHash);
    } catch (err) {
      logger.warn({ err: msg(err) }, 'jarvis gate: canary allowlist read failed — denying');
      return false;
    }
  }

  // (5) GA.
  return true;
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
