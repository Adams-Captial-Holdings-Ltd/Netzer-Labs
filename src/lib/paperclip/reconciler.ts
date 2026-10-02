/**
 * The Paperclip reconciler: the durability layer behind DL-3's "poll for
 * durability, push for latency". One sweep per interval, one sweeper per fleet,
 * one cursor that only ever moves forward.
 *
 * IT SHIPS OBSERVING ONLY. `paperclip/reconciler_mode` seeds to `shadow`, and
 * C-7 makes shadow a READ COMPARATOR: it pages the board, counts what a live
 * reconciler would have looked at, and mutates neither system's domain state.
 * "Zero writes" cannot be read as "zero DynamoDB calls" — leader election is a
 * conditional put and the cursor is a conditional put, and a sweep without
 * either is not a reconciler. What it means, and what the tests assert, is that
 * every Paperclip request a shadow sweep issues is a GET, and nothing Netzar
 * owns changes. The only durable effects are this loop's own lease and cursor.
 *
 * THE TWO PRECONDITIONS THIS LOOP TURNS ON, both proven by live probes:
 *
 *  1. A1-8 / M28 — THE BOOT TRAP. `updatedSince` is native from v2026.916.1,
 *     but a build without it silently ignores the parameter and returns the
 *     full unfiltered board. Before the first sweep, a future stamp must return
 *     `[]` and a malformed value must return 400 (see `runBootProbe`). Either
 *     failure permanently refuses to sweep for the life of the process.
 *
 *  2. C-2 / M30 — THE WATERMARK PREDICATE. Native `updatedSince` filters with
 *     strict `updated_at > since`. See `watermark.ts`: the poll subtracts
 *     `poll_overlap_ms` from the watermark and dedupes on `(id, updatedAt)`.
 *
 * PAGING IS SERIAL AND KEYSET. Serial because A1-10 shape (b) is a per-actor
 * in-flight COALESCER, not a rate limiter, and its polarity is the opposite of the
 * obvious advice: 64 byte-identical concurrent list reads all answer 200 (they
 * coalesce onto one computation), while 24 DISTINCT concurrent reads for one actor
 * draw `429 Too many concurrent issue-list requests for this actor/client`. A
 * sweep that fans out over offsets is precisely the refused shape. Target
 * concurrency is 1 — not "some number under the ceiling", because the ceiling is
 * UNVERIFIED. Keyset because paging a MUTABLE set by offset, sorted ascending on
 * the very column being filtered, silently SKIPS rows whenever a concurrent write
 * re-stamps one already read; the loop below carries the full argument.
 *
 * NO RETRY, NO BACKOFF, AND NO ERROR PARSING LIVES HERE. `client.ts` already
 * owns the kill switch, the breaker, the 3-attempt GET retry, the 429
 * `Retry-After` floor and the twelve typed errors; it passed a harsh critic and
 * a blind head-to-head against Linear's SDK. A failed pass logs and waits for the
 * next fixed interval, which is what all six existing workers in this repo do.
 */

import { logger } from '../../observability/logger.js';
import { getConfigCategory } from '../state/runtime-config-repo.js';
import { tryAcquireRunnerLease } from '../state/runner-lease.js';
import { PaperclipClient, paperclipClientFromEnvironment } from './client.js';
import { PaperclipDisabledError, PaperclipInvalidInputError } from './error.js';
import { PAPERCLIP_CONFIG_CATEGORY } from './config.js';
import { getPaperclipLockState } from './runtime-lock.js';
import {
  advancePaperclipWatermark,
  paperclipPollSinceMs,
  paperclipWatermarkFrom,
} from './watermark.js';
import type {
  IssueChange,
  PaperclipReconcilerMode,
  SweepResult,
} from './types.js';

/** The lease name. One sweeper across the whole Fargate fleet. */
export const RECONCILER_LEASE_NAME = 'paperclip-reconciler';

/**
 * FALLBACKS BYTE-MATCH `scripts/lib/seed-defaults.ts`, which is a rule and not a
 * coincidence: those five rows ship unseeded-by-default reasoning ("its fallback
 * defaults must equal these exact values so seeding stays behavior-neutral"), so
 * an install that has never been seeded and one that has must behave identically.
 * A test pins the four this file reads against the seeded strings.
 */
export const RECONCILER_DEFAULTS = {
  pollIntervalMs: 15_000,
  pollOverlapMs: 2_000,
  pollPageLimit: 500,
  mode: 'shadow' as PaperclipReconcilerMode,
  enabledAgents: '[]',
} as const;

/**
 * THE FLOOR IS A COST GUARD, NOT A STYLE CHOICE. Every agent-key request issues
 * an UNDEBOUNCED `UPDATE agent_api_keys SET last_used_at`, so the poll cadence is
 * a write rate against Paperclip's database, not just a read rate. A misconfigured
 * `poll_interval_ms=100` would turn the reconciler into a write storm on a table
 * nobody is watching. Clamped, never rejected — an operator's typo must not stop
 * the sweep.
 */
export const POLL_INTERVAL_FLOOR_MS = 15_000;

/**
 * A hard stop on one sweep, matching `PaperclipPage.paginateAll`'s default. This
 * artifact has no totals endpoint (`issues/count` answers 400 without
 * `attention=blocked`), so paging to an empty page is the only way to size a
 * board and a sweep needs a bound. Hitting it is a PARTIAL page: the cursor does
 * not move, and the next sweep re-reads the same window.
 */
export const MAX_SWEEP_PAGES = 100;

// ── Module state (house pattern: a `let`, not a class) ────────────────────

let timer: NodeJS.Timeout | null = null;
/**
 * Queue-drain's precedent. The loop self-chains rather than using `setInterval`,
 * because the interval is a live runtime-config value and a fixed interval would
 * pin `poll_interval_ms` for the life of the task. Clearing a chained timeout
 * alone cannot stop an in-flight iteration, so the flag is checked at both ends.
 */
let stopped = false;
let running = false;
/** Memoized so the client's circuit breaker survives across ticks. */
let cachedClient: PaperclipClient | null = null;
/** `unknown` until the first armed tick; `failed` is permanent (see A1-8 above). */
let bootProbe: 'unknown' | 'passed' | 'failed' = 'unknown';

// ── Config parsing ────────────────────────────────────────────────────────

function parseMode(raw: string | undefined): PaperclipReconcilerMode {
  // An unrecognized value resolves to `shadow`, the read-only mode: a typo in a
  // promotion must fail towards observing, never towards acting.
  return raw === 'off' || raw === 'live' ? raw : RECONCILER_DEFAULTS.mode;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

/**
 * Exported since Phase 6: the dispatch route is the second reader of
 * `paperclip/enabled_agents` and must not fork a second parser for it. Fails
 * towards acting for NOBODY on anything unparseable or non-array.
 */
export function parseEnabledAgents(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

// ── Test seams ────────────────────────────────────────────────────────────

export interface ReconcilerDeps {
  client?: PaperclipClient;
  getConfigFn?: typeof getConfigCategory;
  acquireLease?: typeof tryAcquireRunnerLease;
  advanceWatermarkFn?: typeof advancePaperclipWatermark;
  now?: () => number;
}

/** Drops the memoized client and the boot-probe verdict. Tests only. */
export function __resetPaperclipReconcilerForTest(): void {
  cachedClient = null;
  bootProbe = 'unknown';
  running = false;
  stopped = false;
}

async function resolveClient(deps: ReconcilerDeps): Promise<PaperclipClient | null> {
  if (deps.client) return deps.client;
  if (cachedClient) return cachedClient;
  try {
    cachedClient = await paperclipClientFromEnvironment();
    return cachedClient;
  } catch (err) {
    if (err instanceof PaperclipDisabledError) {
      // "Not configured" is not "broken" — and it is not cached either, because
      // `paperclip/base_url` can arrive by config write at any time.
      logger.info(
        { errMessage: err.message },
        'paperclip reconciler idle (not configured)',
      );
      return null;
    }
    throw err;
  }
}

// ── The A1-8 boot probe ───────────────────────────────────────────────────

/**
 * Proves the running image honors `updatedSince` on two independent signals.
 * A build without the parameter silently ignores it, including after a downgrade:
 *
 *  (a) `updatedSince = now + 1h` must answer `[]`. An ignored parameter returns
 *      the whole board, but an empty board also returns `[]` without filtering.
 *
 *  (b) A malformed `updatedSince` must answer 400. This proves parsing on an
 *      empty board, but a server that rejects bad input yet ignores valid values
 *      could pass it alone. Native support since v2026.916.1 accepts parseable
 *      stamps with or without a UTC offset.
 *
 * THE VERDICT IS THREE-VALUED, AND THAT IS THE POINT. "This build provably
 * ignores the parameter" is a property of the IMAGE: it cannot change without a
 * deploy, so `ignored` is permanent and refusing forever is correct. "The probe
 * request did not complete" is a property of the MOMENT — a timeout, a 5xx, an
 * open breaker, a 429 from a fleet booting together — and it is evidence of
 * nothing at all. Collapsing the two would let one blip on one tick brick the
 * durability layer for the life of the task, so `error` leaves the verdict
 * `unknown` and the next tick asks again.
 */
type BootProbeVerdict = 'passed' | 'ignored' | 'error';

async function runBootProbe(client: PaperclipClient, now: number): Promise<BootProbeVerdict> {
  const future = new Date(now + 3_600_000).toISOString();
  try {
    const page = await client.listIssues({ updatedSince: future, limit: 1 });
    if (page.nodes.length > 0) {
      logger.error(
        { updatedSince: future, rows: page.nodes.length },
        'paperclip reconciler REFUSING TO START: updatedSince returned rows for a future watermark — this build silently ignores updatedSince, so every poll would return the full unfiltered board',
      );
      return 'ignored';
    }
  } catch (err) {
    logger.warn(
      { errMessage: err instanceof Error ? err.message : String(err) },
      'paperclip reconciler boot probe could not be completed; NOT a verdict — retrying next tick',
    );
    return 'error';
  }
  try {
    await client.listIssues({ updatedSince: 'not-a-date', limit: 1 });
  } catch (err) {
    if (err instanceof PaperclipInvalidInputError) return 'passed';
    logger.warn(
      { errMessage: err instanceof Error ? err.message : String(err) },
      'paperclip reconciler boot probe could not be completed: a malformed updatedSince failed with something other than a 400; NOT a verdict — retrying next tick',
    );
    return 'error';
  }
  logger.error(
    {},
    'paperclip reconciler REFUSING TO START: a malformed updatedSince was accepted, so this build is not parsing the parameter at all',
  );
  return 'ignored';
}

// ── One pass ──────────────────────────────────────────────────────────────

function emptyResult(
  reason: NonNullable<SweepResult['reason']>,
  mode: PaperclipReconcilerMode,
  pollIntervalMs: number,
  enabledAgents: readonly string[],
  extra: Partial<SweepResult> = {},
): SweepResult {
  return {
    ran: false,
    reason,
    mode,
    pollIntervalMs,
    rowsSeen: 0,
    candidates: 0,
    pages: 0,
    watermarkAdvanced: false,
    enabledAgents,
    ...extra,
  };
}

/**
 * ONE sweep, callable without a timer — the `runCostWatchOnce`/`runDriftCheckOnce`
 * shape. `force` bypasses the mode gate and the lease so a test or an admin route
 * can drive a pass; it does NOT bypass the boot probe, which is the one gate that
 * exists because its failure is invisible.
 *
 * CONFIG IS READ HERE, NOT IN `startPaperclipReconciler`. That is the whole
 * mechanism behind "promotion is a config write, not a deploy": one
 * `getConfigCategory('paperclip')` per tick (one DDB query for all five keys plus
 * the cursor), so a `reconciler_mode` or `poll_interval_ms` write lands within the
 * 30 s runtime-config cache window — sooner via the SNS invalidation listener —
 * with no `cdk deploy` and no task restart. Reading the mode once at start would
 * pin it for the life of the task, which is the bug cost-watch and drift-watch
 * avoid by putting their gate read as the first statement of their pass function.
 */
export async function runPaperclipReconcilePassOnce(
  opts: { force?: boolean } = {},
  deps: ReconcilerDeps = {},
): Promise<SweepResult> {
  const now = deps.now ?? Date.now;
  const readConfig = deps.getConfigFn ?? getConfigCategory;
  const acquireLease = deps.acquireLease ?? tryAcquireRunnerLease;
  const advance = deps.advanceWatermarkFn ?? advancePaperclipWatermark;

  const config = await readConfig(PAPERCLIP_CONFIG_CATEGORY);
  const mode = parseMode(config.reconciler_mode);
  const pollIntervalMs = Math.max(
    POLL_INTERVAL_FLOOR_MS,
    parsePositiveInt(config.poll_interval_ms, RECONCILER_DEFAULTS.pollIntervalMs),
  );
  const overlapMs = parsePositiveInt(config.poll_overlap_ms, RECONCILER_DEFAULTS.pollOverlapMs);
  const pageLimit = parsePositiveInt(config.poll_page_limit, RECONCILER_DEFAULTS.pollPageLimit);
  const enabledAgents = parseEnabledAgents(config.enabled_agents);

  if (mode === 'off' && !opts.force) {
    return emptyResult('mode-off', mode, pollIntervalMs, enabledAgents);
  }
  if (getPaperclipLockState().closed) {
    return emptyResult('lock-closed', mode, pollIntervalMs, enabledAgents);
  }
  if (bootProbe === 'failed') {
    // RE-LOGGED EVERY TICK, deliberately. A single line at the moment of failure
    // scrolls off, and what an operator then sees is a loop that ticks forever and
    // never sweeps, with no explanation anywhere in the window they are looking at.
    // The durability layer being off is worth one line per interval.
    logger.error(
      {},
      'paperclip reconciler is REFUSING TO SWEEP: this build provably ignores updatedSince (see the boot probe). Deploy a build that honors it; this will not clear by itself.',
    );
    return emptyResult('boot-probe-failed', mode, pollIntervalMs, enabledAgents);
  }

  const client = await resolveClient(deps);
  if (!client) {
    return emptyResult('not-configured', mode, pollIntervalMs, enabledAgents);
  }

  if (bootProbe === 'unknown') {
    const verdict = await runBootProbe(client, now());
    // Only a PROVEN ignored parameter latches. A failed request leaves the verdict
    // unknown so the next tick asks again.
    if (verdict === 'ignored') {
      bootProbe = 'failed';
      return emptyResult('boot-probe-failed', mode, pollIntervalMs, enabledAgents);
    }
    if (verdict === 'error') {
      return emptyResult('boot-probe-error', mode, pollIntervalMs, enabledAgents);
    }
    bootProbe = 'passed';
    logger.info({}, 'paperclip reconciler boot probe passed (updatedSince is honored)');
  }

  // LEADER ELECTION, after the boot probe so a refusing build never takes the
  // lease from a healthy peer. `ttlMs` is derived from the LIVE interval, not a
  // constant, and is twice it — the value both existing callers use, and
  // comfortably ABOVE the poll interval so a healthy holder renews each tick
  // while a dead one frees the loop within one lease period.
  //
  // `tryAcquireRunnerLease` FAILS OPEN on a store error, by documented design:
  // a DDB blip tells every task to run rather than silently stopping all
  // monitoring. So N tasks can sweep at once, and the lease is NOT what makes
  // that safe — the watermark's conditional write is. Concurrent sweeps read the
  // same window, dedupe the same rows, and exactly one of them wins the cursor
  // advance; the others observe `false` and move nothing.
  const leaseArgs = { name: RECONCILER_LEASE_NAME, ttlMs: pollIntervalMs * 2 };
  if (!opts.force && !(await acquireLease(leaseArgs))) {
    // Logged, unlike the bare early return canary and webhook-monitor use: a loop
    // that ticks and never sweeps must never be indistinguishable from a broken
    // one, and "another task holds the lease" is the benign explanation.
    logger.debug({ lease: RECONCILER_LEASE_NAME }, 'paperclip reconciler is not the leader this tick');
    return emptyResult('not-leader', mode, pollIntervalMs, enabledAgents);
  }

  const watermark = paperclipWatermarkFrom(config);
  if (watermark.corrupt) {
    logger.error(
      { key: `${PAPERCLIP_CONFIG_CATEGORY}/reconciler_watermark` },
      'paperclip reconciler REFUSING TO SWEEP: the stored cursor does not parse. Cold-starting would resume at now-overlap and SKIP everything between the real cursor and now, so the sweep stops instead. Repair or DELETE the key; deleting it is an explicit cold start.',
    );
    return emptyResult('watermark-corrupt', mode, pollIntervalMs, enabledAgents);
  }
  const startMs = now();
  let sinceMs = paperclipPollSinceMs({ watermark, overlapMs, now: startMs });

  const seen = new Map<string, IssueChange>();
  let rowsSeen = 0;
  let pages = 0;
  let offset = 0;

  // PAGING IS KEYSET, NOT A FIXED WINDOW WITH A WALKING OFFSET, and the reason is
  // a loss channel rather than taste.
  //
  // The sort key IS the filter column, and `updated_at` only ever moves FORWARD.
  // Under `sortDir=asc`, any write that re-stamps a row already read moves that
  // row to the TAIL and shifts every row behind it DOWN one index. So the row
  // sitting at the next page's first offset slides into the prefix that was
  // already read and is never returned — while the re-stamped row IS returned, at
  // wall-clock now, dragging the high-water mark past its own victim. The skipped
  // row's stamp is then below the next poll's `max - overlap` floor and it is gone
  // permanently. (The shift direction is always SKIP, never duplicate: an
  // append-only key cannot move a row backwards into a page already read.) That is
  // not an unlucky interleaving; it is what an active board does.
  //
  // Anchoring each page on a VALUE closes it. A page returns the `limit` smallest
  // rows after `since`, so every row it did not return is at or above that
  // page's max — re-anchoring `since` there can skip nothing, whatever moved
  // meanwhile. A re-stamped row simply reappears later in the same sweep as a new
  // `(id, updatedAt)` pair, which is a duplicate candidate and not a lost one.
  //
  // `- 1` because native `updatedSince` is strict `updated_at > since`, so
  // passing `max - 1ms` makes the next window INCLUSIVE of `max` and the rows
  // sharing its millisecond. That costs one re-read page-boundary row per page —
  // and it is what gives the `(id, updatedAt)` dedupe below something real to
  // collapse.
  //
  // `offset` is the fallback for the one case a value anchor cannot advance: a
  // whole page whose rows all share a single millisecond. Then and only then the
  // walk is positional, and the skip channel above is LIVE AGAIN — a re-stamp
  // during that walk shifts the tail down and drops a row exactly as it would
  // under offset paging generally.
  //
  // THE CURSOR CAP BELOW IS WHAT CLOSES IT, and it is a bound rather than a hope.
  //
  //  WHERE a skipped row can be. Native filtering is strict `updated_at > since`
  //  against microseconds, and the API shows stamps cut to the millisecond, so
  //  every row a page returns shows a stamp of `since` or later. The fallback
  //  condition is `pageMax - 1 <= since`, so the page's stamps all lie within
  //  `since` and `since + 1ms`. Call its latest stamp S, so `S - 1ms <= since`.
  //  The positional walk that follows keeps the same `since`, so every row it can
  //  return — and therefore every row a shift can drop — shows a stamp at or above
  //  `S - 1ms`. Refusing to move the cursor past S leaves the next poll's floor at
  //  `S - overlap`, below all of them.
  //
  //  WHEN a skip is possible at all, exactly. A shift drops a row only if the row
  //  that moved to the tail was ALREADY READ in this sweep: if its old index was
  //  still ahead of the walk, the rows behind it merely compact into positions the
  //  walk has not reached yet and nothing is missed. And a row that was already
  //  read and then re-stamped is necessarily read AGAIN at its new stamp, because
  //  `updated_at` only moves forward and the sweep pages to exhaustion — so it
  //  appears in this sweep under two different `updatedAt` values. That makes
  //  "some id was seen at two stamps" a NECESSARY condition for a skip, and it is
  //  observable here for free. A quiet sweep therefore pays nothing.
  //
  // This is also why `poll_page_limit` needs no floor: the cap holds at any page
  // size, including the small values that make a tie group exceed a page in the
  // first place. The cost is a re-read, never a skip.
  let tieCapMs = Number.POSITIVE_INFINITY;
  const firstStampById = new Map<string, string>();
  let restampSeen = false;
  for (;;) {
    if (pages >= MAX_SWEEP_PAGES) {
      logger.error(
        { pages, rowsSeen, since: new Date(sinceMs).toISOString() },
        'paperclip reconciler stopped at the page bound with rows still on the board; watermark NOT advanced',
      );
      return emptyResult('pagination-truncated', mode, pollIntervalMs, enabledAgents, {
        rowsSeen,
        candidates: seen.size,
        pages,
        watermarkFrom: watermark.updatedAt,
      });
    }
    // LEASE LOSS STOPS THE SWEEP, mid-pass, before the next read. A task that
    // lost the lease must not keep paging and must not advance a cursor a new
    // holder is already moving. The pass is abandoned with the cursor untouched.
    if (pages > 0 && !opts.force && !(await acquireLease(leaseArgs))) {
      logger.info({ pages, rowsSeen }, 'paperclip reconciler lost its lease mid-sweep; stopping');
      return emptyResult('lease-lost', mode, pollIntervalMs, enabledAgents, {
        rowsSeen,
        candidates: seen.size,
        pages,
        watermarkFrom: watermark.updatedAt,
      });
    }

    // ONE list read in flight at a time, by construction — this is a serial await
    // chain, never a `Promise.all` over offsets. A1-10 shape (b) refuses DISTINCT
    // concurrent list reads for one actor, and every page here is distinct.
    const page = await client.listIssues({
      updatedSince: new Date(sinceMs).toISOString(),
      sortField: 'updated',
      sortDir: 'asc',
      limit: pageLimit,
      offset,
    });
    pages += 1;

    let pageMaxMs = Number.NEGATIVE_INFINITY;
    for (const issue of page.nodes) {
      rowsSeen += 1;
      // The dedupe key is the RAW pair, compared as the server spelled it. It
      // collapses the boundary row each keyset re-anchor re-reads, and the
      // genuine same-millisecond overlap across sweeps.
      //
      // AND IT IS DELIBERATELY PER-SWEEP. The tempting cross-sweep filter is
      // "drop anything at or below the previous watermark, since the overlap is
      // the only reason it is here" — and that filter IS THE M30 BUG, rebuilt
      // client-side. The row the overlap exists to recover sits at exactly the
      // previous watermark's millisecond, so any comparison against it discards
      // precisely the row that was never processed. Re-seeing a row across
      // sweeps is the cost of not losing one; suppressing the duplicate belongs
      // to the dispatcher, which HAS now shipped (Phase 6) — but not in the
      // shape this line used to promise. It dedupes on a durable one-shot claim
      // over `(runId, issueId)`, not on a deterministic `idempotencyKey`
      // (A1-13), and its guarantee is AT-LEAST-once, not at-most-once: the
      // worker releases that claim on a transient failure so a redelivery
      // retries, while a concurrent duplicate is still refused. This phase
      // itself still writes nothing, so re-seeing costs nothing today.
      const key = `${issue.id}@${issue.updatedAt}`;
      if (!seen.has(key)) {
        seen.set(key, { key, id: issue.id, updatedAt: issue.updatedAt, issue });
      }
      // One id at two stamps = a row was re-stamped WHILE this sweep ran. See the
      // cap argument above: this is the necessary condition for a positional skip.
      const firstStamp = firstStampById.get(issue.id);
      if (firstStamp === undefined) firstStampById.set(issue.id, issue.updatedAt);
      else if (firstStamp !== issue.updatedAt) restampSeen = true;
      const ms = Date.parse(issue.updatedAt);
      if (!Number.isNaN(ms) && ms > pageMaxMs) pageMaxMs = ms;
    }

    // TERMINATE ON AN EMPTY PAGE, NOT A SHORT ONE — an oversized `limit` is
    // silently clamped, so a clamped full page looks short. `hasMore` is the
    // client's `nodes.length > 0`.
    if (!page.hasMore) break;

    const nextSinceMs = pageMaxMs - 1;
    if (nextSinceMs > sinceMs) {
      sinceMs = nextSinceMs;
      offset = 0;
    } else {
      // The value anchor cannot advance: this whole page is one millisecond.
      // Record it as the cursor ceiling BEFORE walking positionally, so a row the
      // walk skips stays above the next poll's floor. Guarded on `isFinite` only
      // so a page of unparseable stamps cannot pin the cursor at -Infinity.
      if (Number.isFinite(pageMaxMs)) tieCapMs = Math.min(tieCapMs, pageMaxMs);
      offset += page.nodes.length;
    }
  }

  // PAGINATION IS EXHAUSTED HERE, and only here may the cursor move.
  //
  // `max()` over rows ACTUALLY PROCESSED, never "the last row of the last page":
  // `sortDir` is accepted but no probe asserts the ORDER of two returned rows, so
  // a sweep may not assume monotonically increasing `updatedAt` across a page.
  // Compared numerically so a mixed ISO spelling cannot mis-order the pair, while
  // the raw string is what is carried forward.
  //
  // TWO CEILINGS, AND THEY ARE DIFFERENT CLAIMS. The cursor is the sweep's
  // assertion "everything at or below this has been looked at", so it may not
  // exceed either bound on what this sweep actually covered.
  //
  //  `startMs` — THE COVERAGE BOUND. The sweep read the board as of the instant it
  //  began. A row re-stamped WHILE it ran carries a stamp from after that instant,
  //  and letting it set the cursor would claim coverage of a window the sweep
  //  never queried: rows written between `startMs` and that stamp were never asked
  //  for. In the ordinary case this costs nothing, because every row written
  //  before the sweep began is already at or below `startMs`.
  //
  //  `tieCapMs` — THE POSITIONAL-WALK BOUND, and the one that closes a real loss
  //  channel rather than tightening a claim. See the cap argument inside the loop.
  //  It applies only when `restampSeen`, which is the necessary condition for a
  //  positional skip, so a sweep over a quiet board advances exactly as before.
  //
  // WHAT `startMs` ALONE DOES **NOT** DO — corrected here, having been asserted:
  // it does not bound the tie-group skip. The next poll's floor is
  // `watermarkTo - overlap`, and `watermarkTo` is only bounded ABOVE by `startMs`;
  // it can sit far above a row skipped inside a tie group while still below
  // `startMs`. Concretely, with a two-row tie at `11:59:50.000Z` and a third row
  // at `11:59:56.000Z`, a re-stamp mid-walk skips the tie's second member, the
  // cursor advances to `11:59:56.000Z`, the next floor becomes `11:59:54.000Z`,
  // and the skipped row is permanently beneath it. That is a lost row, and it is
  // reproduced as a named test. `tieCapMs` — not `startMs` — is what makes it a
  // re-read.
  const advanceCapMs = Math.min(startMs, restampSeen ? tieCapMs : Number.POSITIVE_INFINITY);
  let watermarkTo: string | undefined;
  let watermarkToMs = Number.NEGATIVE_INFINITY;
  for (const change of seen.values()) {
    const ms = Date.parse(change.updatedAt);
    if (!Number.isNaN(ms) && ms > watermarkToMs && ms <= advanceCapMs) {
      watermarkToMs = ms;
      watermarkTo = change.updatedAt;
    }
  }

  // NEVER BACKWARDS, on two independent guards: this comparison, and the
  // conditional write inside `advancePaperclipWatermark`. An empty sweep has no
  // `watermarkTo` and therefore moves nothing.
  const fromMs = watermark.updatedAt === undefined ? Number.NEGATIVE_INFINITY : Date.parse(watermark.updatedAt);
  const watermarkAdvanced =
    watermarkTo !== undefined && !(watermarkToMs <= fromMs) ? await advance(watermarkTo) : false;

  const result: SweepResult = {
    ran: true,
    mode,
    pollIntervalMs,
    rowsSeen,
    candidates: seen.size,
    pages,
    watermarkFrom: watermark.updatedAt,
    watermarkTo,
    watermarkAdvanced,
    enabledAgents,
  };

  // The shadow comparator's entire output is this log line. No audit row: a
  // 15-second loop that never acts would write ~5,760 `writeAudit` rows a day to
  // DDB and S3 describing nothing that happened, and the trail an observing-only
  // phase needs is exactly what a structured log already carries. The audit row
  // lands with the first RECONCILER action — which Phase 6 did not ship: Phase 6
  // shipped the inbound dispatch route, and this loop still decides no action on
  // any row.
  logger.info(result, 'paperclip reconciler sweep');
  if (mode === 'live') {
    logger.warn(
      { candidates: result.candidates },
      'paperclip reconciler_mode=live, but this sweep still wrote nothing: the reconciler decides no action on any row, and Phase 6 shipped only the inbound dispatch route',
    );
  }
  return result;
}

// ── The loop ──────────────────────────────────────────────────────────────

async function tick(): Promise<void> {
  if (stopped) return;
  // Belt and braces: the self-chaining timer cannot overlap itself, but
  // `runPaperclipReconcilePassOnce` is exported and an admin call could land on
  // top of a tick. Every worker in this repo carries this guard.
  if (running) return;
  running = true;
  let nextDelayMs: number = RECONCILER_DEFAULTS.pollIntervalMs;
  try {
    nextDelayMs = (await runPaperclipReconcilePassOnce()).pollIntervalMs;
  } catch (err) {
    // A tick may never reject: an escaped rejection reaches the process-level
    // `unhandledRejection` handler in `src/index.ts` and KILLS THE TASK.
    logger.error(
      { errMessage: err instanceof Error ? err.message : String(err) },
      'paperclip reconciler tick failed',
    );
  } finally {
    running = false;
    if (!stopped) arm(nextDelayMs);
  }
}

function arm(delayMs: number): void {
  timer = setTimeout(() => void tick(), delayMs);
  // A pending first tick must never hold the process open (cost-watch precedent).
  timer.unref();
}

/**
 * Idempotent, synchronous, never throws — so `src/index.ts` can call it bare and
 * a slow or broken Paperclip can never delay `/health`. There is NO env gate:
 * the loop is gated by runtime-config `paperclip/reconciler_mode`, read every
 * tick, so arming it costs one DDB query per 15 s until someone turns it on.
 */
export function startPaperclipReconciler(): void {
  if (timer) return;
  stopped = false;
  // Jittered so N Fargate tasks do not all hit the lease and the issue list on
  // the same wall-clock second — and, here, so their first sweeps are not the
  // DISTINCT concurrent list reads the A1-10 coalescer refuses.
  const initialDelayMs = 30_000 + Math.floor(Math.random() * 60_000);
  logger.info(
    { initialDelayMs, floorMs: POLL_INTERVAL_FLOOR_MS },
    'paperclip reconciler armed (gated by runtime-config paperclip/reconciler_mode)',
  );
  arm(initialDelayMs);
}

export function stopPaperclipReconciler(): void {
  stopped = true;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}
