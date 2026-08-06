/**
 * Jarvis routines — named, user-authored prompts surfaced as one-click chips on
 * the orb's hover popup ("Morning brief" → tour Overview, break down cost,
 * summarize recent sessions).
 *
 * A routine is ONLY a saved prompt. Execution rides the existing sanitized
 * text-turn path (`POST /api/jarvis/text-turn`) exactly as if the user typed
 * it, so the RBAC manifest, read-only tool loop, audit rows, and kill switch
 * all apply unchanged — there is no separate execution surface to secure.
 *
 * Storage: one runtime-config item per routine (category `jarvis`, key
 * `routine#<id>`, value = JSON). Per-item writes keep each save far under the
 * CloudFront WAF 8KB body cap and let edits to one routine never clobber
 * another; the 30s config cache + SNS fanout propagate changes to all tasks
 * without a redeploy.
 */

import { getConfigCategory, setConfig, deleteConfig } from '../state/runtime-config-repo.js';
import { logger } from '../../observability/logger.js';

const CATEGORY = 'jarvis';
const KEY_PREFIX = 'routine#';

// Caps keep a full save comfortably under the WAF 8KB POST body limit and the
// prompt within what a single 8-tool-turn Jarvis run can act on.
export const ROUTINE_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const ROUTINE_NAME_MAX = 60;
export const ROUTINE_PROMPT_MAX = 2000;

export interface JarvisRoutine {
  id: string;
  name: string;
  prompt: string;
  /** Surface this routine as a chip on the orb's hover popup. */
  showOnHover: boolean;
  updatedAt: string;
  updatedBy: string;
}

export interface RoutineInput {
  name?: unknown;
  prompt?: unknown;
  showOnHover?: unknown;
}

/**
 * Validate a routine payload. Returns an error code (stable, machine-readable —
 * the dashboard maps it to copy) or null when valid.
 */
export function validateRoutine(id: string, input: RoutineInput): string | null {
  if (!ROUTINE_ID_RE.test(id)) return 'invalid_id';
  if (typeof input.name !== 'string' || input.name.trim().length === 0) return 'missing_name';
  if (input.name.trim().length > ROUTINE_NAME_MAX) return 'name_too_long';
  if (typeof input.prompt !== 'string' || input.prompt.trim().length === 0) return 'missing_prompt';
  if (input.prompt.trim().length > ROUTINE_PROMPT_MAX) return 'prompt_too_long';
  if (input.showOnHover !== undefined && typeof input.showOnHover !== 'boolean') {
    return 'invalid_show_on_hover';
  }
  return null;
}

/** List every routine, name-sorted. Malformed rows are skipped (and logged), never thrown. */
export async function listRoutines(): Promise<JarvisRoutine[]> {
  const values = await getConfigCategory(CATEGORY);
  const routines: JarvisRoutine[] = [];
  for (const [key, raw] of Object.entries(values)) {
    if (!key.startsWith(KEY_PREFIX)) continue;
    const id = key.slice(KEY_PREFIX.length);
    try {
      const p = JSON.parse(raw) as Partial<JarvisRoutine>;
      if (typeof p.name !== 'string' || typeof p.prompt !== 'string') throw new Error('bad shape');
      routines.push({
        id,
        name: p.name,
        prompt: p.prompt,
        showOnHover: p.showOnHover !== false,
        updatedAt: typeof p.updatedAt === 'string' ? p.updatedAt : '',
        updatedBy: typeof p.updatedBy === 'string' ? p.updatedBy : '',
      });
    } catch (err) {
      logger.warn(
        { key, err: err instanceof Error ? err.message : String(err) },
        'jarvis routine row malformed — skipping',
      );
    }
  }
  return routines.sort((a, b) => a.name.localeCompare(b.name));
}

/** Upsert a routine. Caller validates first (validateRoutine). */
export async function saveRoutine(
  id: string,
  input: { name: string; prompt: string; showOnHover: boolean },
  updatedBy: string,
): Promise<JarvisRoutine> {
  const routine: JarvisRoutine = {
    id,
    name: input.name.trim(),
    prompt: input.prompt.trim(),
    showOnHover: input.showOnHover,
    updatedAt: new Date().toISOString(),
    updatedBy,
  };
  const { id: _id, ...value } = routine;
  await setConfig(CATEGORY, `${KEY_PREFIX}${id}`, JSON.stringify(value), { updatedBy });
  return routine;
}

/** Delete a routine (idempotent). */
export async function deleteRoutine(id: string): Promise<void> {
  await deleteConfig(CATEGORY, `${KEY_PREFIX}${id}`);
}
