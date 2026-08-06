/**
 * Shared read-authorization guard (JARVIS-PLAN.md §1b H3).
 *
 * This is THE authorization boundary for Jarvis `query` — NOT the HTTP router
 * middleware (which never runs on a direct repo call) and NOT the manifest
 * (which is defense-in-depth + UX only). The Jarvis query executor calls this
 * unconditionally BEFORE invoking any repo function.
 *
 * It enforces decisions from the canonical `RESOURCE_META` table directly, so
 * it still blocks even if a caller passes a corrupted/forged manifest snapshot
 * (the H3 corrupted-manifest test). Parameter-level scoping lives here too
 * (e.g. `memories` requires a `chatId`).
 */

import {
  RESOURCE_META,
  ROLE_RANK,
  isJarvisResource,
  type JarvisResource,
} from './route-manifest.js';
import type { TokenPrincipal } from '../auth/dashboard-auth.js';

/** Accepted query params (closed; `additionalProperties:false` on the tool schema). */
export interface QueryParams {
  agentId?: string;
  days?: number;
  chatId?: string;
  limit?: number;
  scope?: string;
  owner?: string;
}

export type AuthzResult =
  | { ok: true; resource: JarvisResource }
  | { ok: false; code: 'UNKNOWN_RESOURCE' | 'RESOURCE_FORBIDDEN' | 'PARAM_REQUIRED'; param?: string };

/** Params that a resource cannot run without. */
const REQUIRED_PARAMS: Partial<Record<JarvisResource, Array<keyof QueryParams>>> = {
  memories: ['chatId'],
};

export function authorizeRead(
  principal: TokenPrincipal,
  resource: unknown,
  params: QueryParams = {},
): AuthzResult {
  // 1. Closed-enum membership. An unknown/excluded resource (tokens, config,
  //    *export, …) is never authorized.
  if (!isJarvisResource(resource)) {
    return { ok: false, code: 'UNKNOWN_RESOURCE' };
  }

  // 2. Role wall, read straight from the canonical table (not a manifest arg).
  const meta = RESOURCE_META[resource];
  if (ROLE_RANK[principal.role] < ROLE_RANK[meta.minRole]) {
    return { ok: false, code: 'RESOURCE_FORBIDDEN' };
  }

  // 3. Parameter-level scoping.
  for (const required of REQUIRED_PARAMS[resource] ?? []) {
    const v = params[required];
    if (v === undefined || v === null || v === '') {
      return { ok: false, code: 'PARAM_REQUIRED', param: String(required) };
    }
  }

  return { ok: true, resource };
}
