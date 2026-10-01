/**
 * The reconciler's poll cursor: where the last sweep got to, and the arithmetic
 * that turns it into the next `updatedSince`.
 *
 * WHERE IT LIVES, and why it is not its own table. `scripts/lib/seed-defaults.ts`
 * already declares `paperclip/reconciler_watermark` as a deliberately UNSEEDED
 * member of the `paperclip` runtime-config category — "it is runtime STATE, and
 * its default is absence semantics". Homing it there means the sweep reads its
 * config and its cursor in the ONE `getConfigCategory('paperclip')` round-trip
 * it was already making, and an operator can see the cursor next to the knobs
 * that drive it. Nothing else about it is a runtime-config value: the write goes
 * through `setConfigIfGreater`, not `setConfig`, because `setConfig` has no
 * condition and a cursor that can move backwards is not a cursor.
 *
 * THE MONOTONIC GUARD is `setConfigIfGreater` in `runtime-config-repo.ts`: the
 * `panic-state-repo.ts` idiom with a string instead of a generation counter —
 * one conditional `PutCommand`, no read, `ConditionalCheckFailedException`
 * caught BY NAME and turned into a boolean. It lives THERE and not here because
 * A2-21 holds this directory to zero bare import specifiers, so the DynamoDB
 * call belongs to the module that already owns this table, its cache and its
 * invalidation. It is also the thing that makes `tryAcquireRunnerLease`'s
 * documented FAIL-OPEN safe: on a lease-store blip every task is told to sweep,
 * and N concurrent sweeps then race that one conditional write. The loser
 * observes `false` and advances nothing; the cursor only ever moves forward.
 *
 * TIMESTAMPS ARE NORMALIZED THROUGH `new Date(...).toISOString()` BEFORE THEY ARE
 * STORED. DynamoDB's `<` on a string is a byte comparison, so it only agrees with
 * chronological order while every stored value uses the same ISO form. Round-
 * tripping through `toISOString()` pins the canonical `…THH:MM:SS.sssZ` shape at
 * exactly the millisecond resolution the API exposes, so the guard cannot be
 * defeated by a row whose stamp arrives spelled `+00:00`.
 */

import { setConfigIfGreater } from '../state/runtime-config-repo.js';
import { logger } from '../../observability/logger.js';
import { PAPERCLIP_CONFIG_CATEGORY } from './config.js';
import type { ReconcilerWatermark } from './types.js';

/** The runtime-config key. Deliberately absent from `seed-defaults.ts`. */
export const PAPERCLIP_WATERMARK_KEY = 'reconciler_watermark';

const WATERMARK_ACTOR = 'paperclip-reconciler';

/**
 * Canonical ISO form, or `undefined` when the input is absent or unparseable.
 * Callers that need to tell those two apart must use `paperclipWatermarkFrom`,
 * which does — see the `corrupt` flag below for why the distinction is not
 * cosmetic.
 */
export function normalizeWatermark(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

/**
 * Lift the cursor out of an already-fetched `paperclip` category record, so the
 * sweep spends no extra DDB round-trip on it.
 *
 * A CORRUPT CURSOR IS NOT AN ABSENT ONE, and folding the two together is a
 * silent data-loss bug rather than a tidy default. Absence means "never swept",
 * and cold-starting at `now - overlap` is exactly right. A stored value that
 * does not parse means "swept to somewhere we can no longer read", and cold-
 * starting there would resume two seconds ago and SKIP everything between the
 * real cursor and now — the unsafe direction, and invisible, because the sweep
 * that skipped it looks like a perfectly ordinary empty poll. So it is reported
 * as `corrupt` and the reconciler refuses to sweep until an operator repairs or
 * deletes `paperclip/reconciler_watermark`. The refusal is re-evaluated every
 * tick from the live config read, so the repair needs no restart.
 */
export function paperclipWatermarkFrom(
  config: Record<string, string>,
): ReconcilerWatermark {
  const raw = config[PAPERCLIP_WATERMARK_KEY];
  const updatedAt = normalizeWatermark(raw);
  if (updatedAt === undefined && raw) return { corrupt: true };
  return { updatedAt };
}

/**
 * The `updatedSince` value for the next poll, in ms since epoch.
 *
 * Native `updatedSince` is strict `updated_at > since` against a microsecond
 * column. The removed `>= watermark + 1ms` patch caused a 1 ms loss when API
 * stamps were millisecond-truncated. ADR 0019 keeps overlap-and-dedupe on
 * purpose: poll from `maxUpdatedAt - poll_overlap_ms` and dedupe client-side on
 * `(id, updatedAt)` so the cursor tolerates the two-clock skew described below.
 *
 * COLD START IS `now - overlap`, NEVER EPOCH. An epoch cold start asks for the
 * entire board through a route with no totals endpoint, which is a page-storm on
 * the first tick of every fresh deploy.
 *
 * A8: Paperclip stamps `updated_at` from two clocks — the database's `now()` on
 * insert and Node's `new Date()` on update — so the cursor is never exact. The
 * overlap is load-bearing rather than defensive, and nothing here treats the
 * watermark as an equality.
 *
 * A8 IS UNVERIFIED IN THE ONE DIMENSION THAT WOULD MAKE 2000 ms A GUARANTEE. No
 * probe measures the SIZE of that two-clock skew, so nothing establishes that
 * `poll_overlap_ms` bounds it. If the two clocks ever disagree by more than the
 * overlap in the direction that matters — a row stamped by the slower clock
 * BELOW a cursor the faster clock already advanced past — that row is not
 * recovered by this arithmetic and is lost. The overlap was proven against the
 * old C-2/M30 patch truncation hazard, a fixed 1 ms window that native filtering
 * removes; its protection against skew is unmeasured. Bounding it needs a probe that
 * inserts and updates under load and records the observed disagreement, and that
 * probe does not exist. `poll_overlap_ms` is a runtime-config value precisely so
 * an operator can raise it without a deploy when one does.
 */
export function paperclipPollSinceMs(args: {
  watermark: ReconcilerWatermark;
  overlapMs: number;
  now: number;
}): number {
  const anchor = args.watermark.updatedAt;
  const anchorMs = anchor === undefined ? args.now : Date.parse(anchor);
  return (Number.isNaN(anchorMs) ? args.now : anchorMs) - args.overlapMs;
}

/**
 * Move the cursor forward. Returns `true` when this write won, `false` when the
 * stored value was already at or ahead of `to` (either because a peer task moved
 * it, or because the caller asked to move backwards). Never throws on a
 * conditional failure; a store error is logged and reported as `false`, which
 * costs a re-swept overlap window, not a lost row.
 *
 * The caller — not this function — owns the OTHER half of the rule: the cursor
 * is offered only after pagination has run to an empty page. A partial page must
 * never reach here.
 */
export async function advancePaperclipWatermark(to: string): Promise<boolean> {
  const next = normalizeWatermark(to);
  if (next === undefined) return false;
  try {
    // Wins only when the stored cursor is absent or strictly older. The write
    // also drops this task's runtime-config cache, so the next tick reads its
    // own cursor; peers converge on the 30 s TTL, and a peer that reads a stale
    // cursor simply re-sweeps a window the dedupe already handles.
    return await setConfigIfGreater(
      PAPERCLIP_CONFIG_CATEGORY,
      PAPERCLIP_WATERMARK_KEY,
      next,
      { updatedBy: WATERMARK_ACTOR },
    );
  } catch (err) {
    logger.warn(
      { errMessage: err instanceof Error ? err.message : String(err), to: next },
      'paperclip watermark write failed; cursor unchanged',
    );
    return false;
  }
}
