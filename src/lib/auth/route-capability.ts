/**
 * Shared route-level capability gate that resolves custom profiles.
 *
 * This is the SAME logic as warroom.ts's hasWarroomRead (the canonical pattern):
 *   - The env break-glass / owner token resolves to all capabilities, so
 *     recovery is never blocked.
 *   - A templated profile id (viewer/analyst/operator/admin/owner) resolves
 *     in-memory with no storage read.
 *   - A custom profile id is resolved through its stored PROFILE_DEF row so a
 *     custom profile that legitimately holds the capability is allowed; a
 *     missing / unreadable def fails closed (no capabilities).
 *
 * Factored here because several dedicated routers (the four posture routers)
 * need the identical "principal holds capability X, resolving custom profiles"
 * check. Routers that already inline this (warroom.ts, handler.ts) keep their
 * local copy; this module only deduplicates the otherwise-identical posture
 * gates rather than reworking existing reviewed code.
 */

import { GetCommand } from '@aws-sdk/lib-dynamodb';
import {
  principalHasCapability,
  profileIdForPrincipal,
  type TokenPrincipal,
} from './dashboard-auth.js';
import {
  isCapability,
  isTemplatedProfileId,
  type Capability,
  type CustomProfile,
} from './permissions.js';
import { ddb } from '../state/ddb.js';

const TABLE_USERS = process.env.TABLE_USERS ?? 'claudeclaw-users';

/**
 * Read a custom profile def row (PROFILE_DEF#<id> / DEF). Mirrors the readers in
 * warroom.ts / handler.ts (same single-table key + defensive capability filter
 * so a garbage stored string can never widen a grant). Returns null when the row
 * is missing / unreadable (fail closed).
 */
async function readCustomProfile(profileId: string): Promise<CustomProfile | null> {
  try {
    const out = await ddb().send(
      new GetCommand({
        TableName: TABLE_USERS,
        Key: { PK: `PROFILE_DEF#${profileId}`, SK: 'DEF' },
      }),
    );
    const item = out.Item;
    if (!item || !Array.isArray(item.capabilities)) return null;
    return {
      profileId,
      label: typeof item.label === 'string' ? item.label : profileId,
      capabilities: (item.capabilities as unknown[]).filter(isCapability),
      createdBy: typeof item.createdBy === 'string' ? item.createdBy : '',
      createdAt: typeof item.createdAt === 'string' ? item.createdAt : '',
      ...(typeof item.updatedAt === 'string' ? { updatedAt: item.updatedAt } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * True when the principal holds `required`, resolving a custom profile through
 * its stored def. Mirrors warroom.ts's hasWarroomRead exactly (only the
 * capability string differs).
 */
export async function principalHasRouteCapability(
  p: TokenPrincipal,
  required: Capability,
): Promise<boolean> {
  const profileId = profileIdForPrincipal(p);
  // Env root (owner) + templated ids resolve with no storage read.
  if (p.label === 'Root token' || profileId === 'owner' || isTemplatedProfileId(profileId)) {
    return principalHasCapability(p, required);
  }
  const custom = await readCustomProfile(profileId);
  return principalHasCapability(p, required, custom);
}
