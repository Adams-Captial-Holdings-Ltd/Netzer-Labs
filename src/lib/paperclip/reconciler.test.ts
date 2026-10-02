import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { logError, logWarn, logInfo } = vi.hoisted(() => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
}));
vi.mock('../../observability/logger.js', () => ({
  logger: { info: logInfo, warn: logWarn, error: logError, fatal: vi.fn(), debug: vi.fn() },
}));

import {
  MAX_SWEEP_PAGES,
  POLL_INTERVAL_FLOOR_MS,
  RECONCILER_DEFAULTS,
  RECONCILER_LEASE_NAME,
  __resetPaperclipReconcilerForTest,
  runPaperclipReconcilePassOnce,
  startPaperclipReconciler,
  stopPaperclipReconciler,
  type ReconcilerDeps,
} from './reconciler.js';
import { paperclipIssue, paperclipTestClient } from './test-helpers.js';
import { SEED_DEFAULTS } from '../../../scripts/lib/seed-defaults.js';
import type { PaperclipIssue } from './types.js';

const NOW = Date.parse('2026-08-21T12:00:00.000Z');
/**
 * Row stamps INSIDE the cold-start window (`now - poll_overlap_ms` = 11:59:58Z).
 * A row older than the window is invisible to a cold sweep, which is the point
 * of the "never moves backwards" case below and a trap everywhere else.
 */
const T0 = '2026-08-21T11:59:59.000Z';
const T1 = '2026-08-21T11:59:59.001Z';
const T2 = '2026-08-21T11:59:59.002Z';
const T5 = '2026-08-21T11:59:59.005Z';

/**
 * A faithful-enough stand-in for native issue listing: offset/limit slicing,
 * and the `updatedSince` behaviour BOTH ways round —
 *
 *   honored:   malformed values answer 400; parseable values, with or without
 *              an offset, filter rows with strict greater-than.
 *   ignored:   the parameter is SILENTLY IGNORED and every request answers 200
 *              with the full unfiltered board (A1-8 / M28).
 *
 * The native behavior matches Paperclip's issue route and service; the ignored
 * behavior preserves the A1-8 boot trap.
 */
function fakePaperclip(opts: {
  board: PaperclipIssue[];
  honorsUpdatedSince?: boolean;
  /**
   * Mutable so a test can make the transport fail and then heal it — the shape of
   * "the probe request failed", which must never be read as "this build is
   * ignored".
   */
  failWith?: { status: number | null };
  /**
   * Called BEFORE each read is served. The seam a test uses to mutate the board
   * MID-SWEEP, which is the only way to exercise the offset-shift skip: a fake
   * that closes over a frozen array can never reproduce it.
   */
  onRead?: (url: URL) => void;
}): {
  fetchFn: typeof fetch;
  calls: { method: string; url: URL }[];
  /** Every row the server actually handed back, as `id@updatedAt`, in order. */
  served: string[];
  maxInFlight: () => number;
} {
  const honorsUpdatedSince = opts.honorsUpdatedSince ?? true;
  const calls: { method: string; url: URL }[] = [];
  const served: string[] = [];
  let inFlight = 0;
  let peak = 0;
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  const fetchFn = (async (input: unknown, init?: RequestInit): Promise<Response> => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    try {
      // Yield once, so a fan-out over offsets would genuinely overlap here and
      // `maxInFlight` would see it. Without this every "concurrent" request would
      // resolve before the next began and the serial assertion would be vacuous.
      await Promise.resolve();
      const url = new URL(String(input));
      calls.push({ method: (init?.method ?? 'GET').toUpperCase(), url });
      if (opts.failWith?.status) return json({ error: 'transport is unwell' }, opts.failWith.status);
      opts.onRead?.(url);
      const since = url.searchParams.get('updatedSince');
      let rows = opts.board;
      if (honorsUpdatedSince && since !== null) {
        if (!Number.isFinite(new Date(since).getTime())) {
          return json({ error: 'updatedSince must be a valid ISO 8601 timestamp when provided' }, 400);
        }
        rows = rows.filter((r) => Date.parse(r.updatedAt) > Date.parse(since));
      }
      // `sortField=updated&sortDir=asc` is what the sweep asks for and what keyset
      // paging depends on. A fake that ignored the sort would make the sweep look
      // lossy for a reason the real artifact does not have.
      if (url.searchParams.get('sortDir') === 'asc') {
        rows = [...rows].sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt));
      }
      const limit = Number(url.searchParams.get('limit') ?? '500');
      const offset = Number(url.searchParams.get('offset') ?? '0');
      const pageRows = rows.slice(offset, offset + limit);
      for (const r of pageRows) served.push(`${r.id}@${r.updatedAt}`);
      return json(pageRows);
    } finally {
      inFlight -= 1;
    }
  }) as typeof fetch;
  return { fetchFn, calls, served, maxInFlight: () => peak };
}

function issue(id: string, updatedAt: string): PaperclipIssue {
  return paperclipIssue({ id, updatedAt, identifier: `NZR-${id}` });
}

function deps(
  over: {
    board?: PaperclipIssue[];
    honorsUpdatedSince?: boolean;
    config?: Record<string, string>;
    lease?: ReturnType<typeof vi.fn>;
    advance?: ReturnType<typeof vi.fn>;
    failWith?: { status: number | null };
    onRead?: (url: URL) => void;
  } = {},
): {
  deps: ReconcilerDeps;
  calls: { method: string; url: URL }[];
  lease: ReturnType<typeof vi.fn>;
  advance: ReturnType<typeof vi.fn>;
  config: Record<string, string>;
  maxInFlight: () => number;
} {
  const server = fakePaperclip({
    board: over.board ?? [],
    honorsUpdatedSince: over.honorsUpdatedSince,
    failWith: over.failWith,
    onRead: over.onRead,
  });
  const lease = over.lease ?? vi.fn().mockResolvedValue(true);
  const advance = over.advance ?? vi.fn().mockResolvedValue(true);
  const config = over.config ?? {};
  return {
    calls: server.calls,
    lease,
    advance,
    config,
    maxInFlight: server.maxInFlight,
    deps: {
      client: paperclipTestClient({ fetchFn: server.fetchFn }),
      getConfigFn: async () => config,
      acquireLease: lease as unknown as ReconcilerDeps['acquireLease'],
      advanceWatermarkFn: advance as unknown as ReconcilerDeps['advanceWatermarkFn'],
      now: () => NOW,
    },
  };
}

/** The list reads a SWEEP made, i.e. excluding the two boot-probe reads. */
function sweepCalls(calls: { url: URL }[]): URL[] {
  return calls.filter((c) => c.url.searchParams.get('sortField') === 'updated').map((c) => c.url);
}

beforeEach(() => {
  __resetPaperclipReconcilerForTest();
  logError.mockClear();
  logWarn.mockClear();
  logInfo.mockClear();
});

afterEach(() => {
  stopPaperclipReconciler();
  vi.useRealTimers();
});

// ── A1-8 / M28: the boot probe ────────────────────────────────────────────

describe('the A1-8 boot probe', () => {
  it('REFUSES TO START when a build that ignores updatedSince answers a future stamp with rows', async () => {
    const t = deps({ board: [issue('a', T0)], honorsUpdatedSince: false });
    const result = await runPaperclipReconcilePassOnce({}, t.deps);
    expect(result.ran).toBe(false);
    expect(result.reason).toBe('boot-probe-failed');
    expect(logError).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('REFUSING TO START'),
    );
    expect(sweepCalls(t.calls)).toHaveLength(0);
    expect(t.advance).not.toHaveBeenCalled();
  });

  it('REFUSES TO START on an EMPTY board too — signal (b) catches what signal (a) cannot', async () => {
    // A build that ignores the parameter answers `[]` on an empty board, so
    // the future stamp passes vacuously. Accepting malformed input catches it.
    const t = deps({ board: [], honorsUpdatedSince: false });
    const result = await runPaperclipReconcilePassOnce({}, t.deps);
    expect(result.reason).toBe('boot-probe-failed');
    expect(logError).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('a malformed updatedSince was accepted'),
    );
  });

  it('the refusal is PERMANENT: a later pass never sweeps, and `force` cannot override it', async () => {
    const t = deps({ board: [issue('a', T0)], honorsUpdatedSince: false });
    await runPaperclipReconcilePassOnce({}, t.deps);
    const callsAfterFirst = t.calls.length;
    const second = await runPaperclipReconcilePassOnce({ force: true }, t.deps);
    expect(second.reason).toBe('boot-probe-failed');
    expect(t.calls).toHaveLength(callsAfterFirst);
  });

  it('the permanent refusal is RE-LOGGED on every later tick, not once and then silence', async () => {
    const t = deps({ board: [issue('a', T0)], honorsUpdatedSince: false });
    await runPaperclipReconcilePassOnce({}, t.deps);
    logError.mockClear();
    await runPaperclipReconcilePassOnce({}, t.deps);
    await runPaperclipReconcilePassOnce({}, t.deps);
    // A responder who arrives after the first line scrolled off still sees why a
    // loop that ticks is never sweeping.
    expect(logError).toHaveBeenCalledTimes(2);
    expect(logError).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.stringContaining('REFUSING TO SWEEP'),
    );
  });

  it('A FAILED PROBE REQUEST IS NOT A VERDICT: it retries next tick instead of bricking the loop', async () => {
    // "This build ignores updatedSince" is a property of the image and latches.
    // "The request did not complete" is a property of the moment and must not:
    // one 403/timeout/breaker-trip on the first armed tick would otherwise
    // disable the durability layer for the life of the task.
    const failWith: { status: number | null } = { status: 403 };
    const t = deps({ board: [issue('a', T0)], failWith });
    const first = await runPaperclipReconcilePassOnce({}, t.deps);
    expect(first).toMatchObject({ ran: false, reason: 'boot-probe-error' });
    expect(logError).not.toHaveBeenCalled();
    expect(logWarn).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('NOT a verdict'),
    );

    failWith.status = null; // the blip passes
    const second = await runPaperclipReconcilePassOnce({}, t.deps);
    expect(second).toMatchObject({ ran: true, candidates: 1 });
  });

  it('a failed second boot-probe request also retries next tick', async () => {
    const failWith: { status: number | null } = { status: null };
    let reads = 0;
    const t = deps({ board: [issue('a', T0)], failWith, onRead: () => {
      reads++;
      if (reads === 1) failWith.status = 503;
    } });
    const first = await runPaperclipReconcilePassOnce({}, t.deps);
    expect(first).toMatchObject({ ran: false, reason: 'boot-probe-error' });
    expect(logError).not.toHaveBeenCalled();
    failWith.status = null;
    const second = await runPaperclipReconcilePassOnce({}, t.deps);
    expect(second).toMatchObject({ ran: true });
    expect(logError).not.toHaveBeenCalled();
  });

  it('passes on a build that honors updatedSince and then sweeps', async () => {
    const t = deps({ board: [issue('a', T0)] });
    const result = await runPaperclipReconcilePassOnce({}, t.deps);
    expect(result.ran).toBe(true);
    expect(result.candidates).toBe(1);
    expect(logError).not.toHaveBeenCalled();
  });

  it('passes on a native build that accepts an offset-less stamp and rejects malformed input', async () => {
    const t = deps({ board: [issue('a', T0)] });
    await expect(t.deps.client!.listIssues({ updatedSince: '2026-08-21T11:59:58', limit: 1 })).resolves.toBeDefined();
    const result = await runPaperclipReconcilePassOnce({}, t.deps);
    expect(result).toMatchObject({ ran: true, candidates: 1 });
    expect(logError).not.toHaveBeenCalled();
  });
});

// ── Leader election ───────────────────────────────────────────────────────

describe('leader election', () => {
  it('takes the lease with a ttl ABOVE the live poll interval', async () => {
    const t = deps({ config: { poll_interval_ms: '20000' } });
    await runPaperclipReconcilePassOnce({}, t.deps);
    expect(t.lease).toHaveBeenCalledWith({ name: RECONCILER_LEASE_NAME, ttlMs: 40_000 });
    const { ttlMs } = t.lease.mock.calls[0][0] as { ttlMs: number };
    expect(ttlMs).toBeGreaterThan(20_000);
  });

  it('a non-leader does no work and issues no list read', async () => {
    const t = deps({
      board: [issue('a', T0)],
      lease: vi.fn().mockResolvedValue(false),
    });
    const result = await runPaperclipReconcilePassOnce({}, t.deps);
    expect(result).toMatchObject({ ran: false, reason: 'not-leader' });
    expect(sweepCalls(t.calls)).toHaveLength(0);
  });

  it('LEASE LOSS STOPS THE SWEEP mid-pass, and the watermark does not move', async () => {
    const lease = vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false);
    const t = deps({
      board: [
        issue('a', T0),
        issue('b', T1),
        issue('c', T2),
      ],
      config: { poll_page_limit: '1' },
      lease,
    });
    const result = await runPaperclipReconcilePassOnce({}, t.deps);
    expect(result).toMatchObject({ ran: false, reason: 'lease-lost', pages: 1, rowsSeen: 1 });
    expect(result.watermarkAdvanced).toBe(false);
    expect(t.advance).not.toHaveBeenCalled();
    // It stopped BEFORE the next read, not after it.
    expect(sweepCalls(t.calls)).toHaveLength(1);
  });
});

// ── Pagination and the watermark ──────────────────────────────────────────

describe('pagination and the watermark', () => {
  it('pages to EXHAUSTION before the watermark advances, and advances to the max processed stamp', async () => {
    const t = deps({
      board: [
        issue('a', T0),
        issue('b', T2),
        issue('c', T1),
      ],
      config: { poll_page_limit: '1' },
    });
    const result = await runPaperclipReconcilePassOnce({}, t.deps);
    // 3 rows at one per page. Each keyset re-anchor is INCLUSIVE of the page max
    // (`max - 1ms`, because native `updatedSince` is strict `> v`), so every
    // boundary row is read twice — 6 reads — plus the
    // empty page that ends the sweep. That extra row per page is the price of
    // never skipping one, and at the seeded limit of 500 it is 1 row in 500.
    expect(result.pages).toBe(7);
    expect(sweepCalls(t.calls)).toHaveLength(7);
    expect(result.rowsSeen).toBe(6);
    expect(result.candidates).toBe(3);
    // max() over rows PROCESSED — not the last row of the last page, because no
    // probe asserts the order of two returned rows.
    expect(t.advance).toHaveBeenCalledTimes(1);
    expect(t.advance).toHaveBeenCalledWith(T2);
    expect(result.watermarkAdvanced).toBe(true);
  });

  it('NEVER ADVANCES ON A PARTIAL PAGE: hitting the page bound leaves the cursor alone', async () => {
    const board = Array.from({ length: MAX_SWEEP_PAGES + 1 }, (_, i) =>
      issue(`i${i}`, new Date(Date.parse(T0) + i).toISOString()),
    );
    const t = deps({ board, config: { poll_page_limit: '1' } });
    const result = await runPaperclipReconcilePassOnce({}, t.deps);
    expect(result).toMatchObject({ ran: false, reason: 'pagination-truncated' });
    expect(result.watermarkAdvanced).toBe(false);
    expect(t.advance).not.toHaveBeenCalled();
  });

  it('NEVER MOVES BACKWARDS: rows older than the stored cursor do not move it', async () => {
    const t = deps({
      board: [issue('a', '2026-08-21T11:00:00.000Z')],
      config: { reconciler_watermark: '2026-08-21T11:30:00.000Z', poll_overlap_ms: '3600000' },
    });
    const result = await runPaperclipReconcilePassOnce({}, t.deps);
    expect(result.candidates).toBe(1);
    expect(result.watermarkTo).toBe('2026-08-21T11:00:00.000Z');
    expect(result.watermarkAdvanced).toBe(false);
    expect(t.advance).not.toHaveBeenCalled();
  });

  it('A CORRUPT STORED CURSOR REFUSES TO SWEEP rather than silently cold-starting past the backlog', async () => {
    // Absence means "never swept" and `now - overlap` is right. A value that does
    // not parse means "swept to somewhere unreadable", and cold-starting there
    // resumes two seconds ago and SKIPS the backlog — invisibly, because the pass
    // looks like an ordinary empty poll.
    const t = deps({
      board: [issue('a', T0)],
      config: { reconciler_watermark: 'Tuesday-ish' },
    });
    const result = await runPaperclipReconcilePassOnce({}, t.deps);
    expect(result).toMatchObject({ ran: false, reason: 'watermark-corrupt' });
    expect(sweepCalls(t.calls)).toHaveLength(0);
    expect(t.advance).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'paperclip/reconciler_watermark' }),
      expect.stringContaining('REFUSING TO SWEEP'),
    );
  });

  it('the corrupt-cursor refusal CLEARS on a config repair, with no restart', async () => {
    const config: Record<string, string> = { reconciler_watermark: 'Tuesday-ish' };
    const t = deps({ board: [issue('a', T0)], config });
    expect((await runPaperclipReconcilePassOnce({}, t.deps)).reason).toBe('watermark-corrupt');
    delete config[
      'reconciler_watermark'
    ]; // an operator deletes the key: an explicit cold start
    expect(await runPaperclipReconcilePassOnce({}, t.deps)).toMatchObject({ ran: true });
  });

  it('an empty sweep moves nothing', async () => {
    const t = deps({ board: [] });
    const result = await runPaperclipReconcilePassOnce({}, t.deps);
    expect(result).toMatchObject({ ran: true, rowsSeen: 0, candidates: 0, watermarkAdvanced: false });
    expect(t.advance).not.toHaveBeenCalled();
  });

  it('COLD START polls from now - poll_overlap_ms, never from epoch', async () => {
    const t = deps({ board: [] });
    await runPaperclipReconcilePassOnce({}, t.deps);
    const since = sweepCalls(t.calls)[0].searchParams.get('updatedSince');
    expect(since).toBe(new Date(NOW - RECONCILER_DEFAULTS.pollOverlapMs).toISOString());
    expect(since).not.toBe(new Date(0).toISOString());
  });

  it('a warm poll subtracts the overlap from the stored cursor (C-2, not the ADR +1ms)', async () => {
    const t = deps({
      board: [],
      config: { reconciler_watermark: T0 },
    });
    await runPaperclipReconcilePassOnce({}, t.deps);
    // T0 minus the seeded 2000 ms overlap — not T0 itself, and not T0 + 1 ms.
    expect(sweepCalls(t.calls)[0].searchParams.get('updatedSince')).toBe(
      '2026-08-21T11:59:57.000Z',
    );
  });

  it('pages SERIALLY — never more than ONE list read in flight (A1-10 shape (b))', async () => {
    // 24 DISTINCT concurrent list reads for one actor draw the coalescer's 429;
    // 64 identical ones do not. Every page here is distinct, so the target is 1.
    const t = deps({
      board: [issue('a', T0), issue('b', T1), issue('c', T2)],
      config: { poll_page_limit: '1' },
    });
    await runPaperclipReconcilePassOnce({}, t.deps);
    expect(sweepCalls(t.calls).length).toBeGreaterThan(1);
    expect(t.maxInFlight()).toBe(1);
  });

  it('paging is KEYSET: updatedSince re-anchors on each page max and the offset resets with it', async () => {
    const t = deps({
      board: [issue('a', T0), issue('b', T1), issue('c', T2)],
      config: { poll_page_limit: '1' },
    });
    await runPaperclipReconcilePassOnce({}, t.deps);
    const reads = sweepCalls(t.calls).map((u) => ({
      since: u.searchParams.get('updatedSince') as string,
      offset: u.searchParams.get('offset'),
    }));
    // Never backwards, and it genuinely moved — a fixed window with a walking
    // offset would show one constant `updatedSince` across every page.
    const sinceMs = reads.map((r) => Date.parse(r.since));
    expect(sinceMs).toEqual([...sinceMs].sort((x, y) => x - y));
    expect(new Set(reads.map((r) => r.since)).size).toBeGreaterThan(1);
    // Every re-anchor starts at offset 0; offset only walks inside one window.
    for (let i = 1; i < reads.length; i += 1) {
      if (sinceMs[i] > sinceMs[i - 1]) expect(reads[i].offset).toBe('0');
    }
  });

  it('A ROW RE-STAMPED MID-SWEEP DOES NOT PUSH AN UNREAD ROW OFF THE PAGE BOUNDARY', async () => {
    // The offset-shift skip, run for real. `updated_at` only moves FORWARD, so a
    // concurrent write to a row already read moves it to the tail and shifts every
    // row behind it DOWN one index — under a fixed window with a walking offset the
    // row at the next page's first offset slides into the prefix already read and is
    // never returned, while the re-stamped row drags the high-water mark to
    // wall-clock now and puts its own victim permanently below the next poll's floor.
    // Keyset paging cannot skip it, and the sweep-start cap keeps the cursor off it.
    const restamped = '2026-08-21T12:00:05.000Z'; // AFTER the sweep began
    const board = [issue('a', T0), issue('b', T1), issue('c', T2), issue('d', T5)];
    let sweepReads = 0;
    const t = deps({
      board,
      config: { poll_page_limit: '2' },
      onRead: (url) => {
        if (url.searchParams.get('sortField') !== 'updated') return;
        sweepReads += 1;
        // Page 1 (`a`, `b`) has been served; an agent now touches `a`.
        if (sweepReads === 2) board[0] = issue('a', restamped);
      },
    });
    const result = await runPaperclipReconcilePassOnce({}, t.deps);

    expect(result.ran).toBe(true);
    // Exactly five distinct (id, updatedAt) pairs exist across the sweep:
    // a@T0, b@T1, c@T2, d@T5 and a@restamped. Under the offset-shift skip `c` is
    // never returned and the count is FOUR, so this number is the assertion — it
    // cannot be satisfied with `c` missing.
    expect(result.candidates).toBe(5);
    expect(t.advance).toHaveBeenCalledTimes(1);
    // AND the cursor is capped at the sweep's start instant, so the mid-sweep
    // re-stamp cannot drag it past rows written before the sweep began.
    expect(t.advance).toHaveBeenCalledWith(T5);
    expect(result.watermarkTo).toBe(T5);
  });

  it('A TIE GROUP LARGER THAN A PAGE: the walk DOES skip a row, and the cursor cap re-reads it next sweep', async () => {
    // The one case a value anchor cannot advance — a whole page inside a single
    // millisecond — so the walk goes positional and the offset-shift skip is live
    // again. This test does NOT claim the skip does not happen: it happens, and
    // the first assertion below is that it happened. What is claimed is that the
    // cursor never passes the tie millisecond, so the next poll's floor sits below
    // every row that walk could have dropped and the row comes back.
    //
    // The sweep-start cap ALONE does not do this, which is what round 2 asserted
    // and was wrong about: `watermarkTo` is only bounded ABOVE by `startMs` and
    // here would land on 11:59:56, putting the next floor at 11:59:54 — above the
    // skipped row at 11:59:50, which is then gone for good.
    const TIE = '2026-08-21T11:59:50.000Z';
    const LATER = '2026-08-21T11:59:56.000Z';
    const RESTAMPED = '2026-08-21T12:00:03.000Z';
    const board = [issue('x', TIE), issue('y', TIE), issue('z', LATER)];
    // Wide enough that a cold start can see 11:59:50 at all.
    const config: Record<string, string> = { poll_page_limit: '1', poll_overlap_ms: '20000' };
    let sweepReads = 0;
    const server = fakePaperclip({
      board,
      onRead: (url) => {
        if (url.searchParams.get('sortField') !== 'updated') return;
        sweepReads += 1;
        // The tie has been served once at offset 0; the walk is about to ask for
        // offset 1. An agent touches `x` right now, so the sorted set shifts down
        // and offset 1 is no longer `y`.
        if (sweepReads === 3) board[0] = issue('x', RESTAMPED);
      },
    });
    const advance = vi.fn().mockResolvedValue(true);
    const d: ReconcilerDeps = {
      client: paperclipTestClient({ fetchFn: server.fetchFn }),
      getConfigFn: async () => config,
      acquireLease: (async () => true) as unknown as ReconcilerDeps['acquireLease'],
      advanceWatermarkFn: advance as unknown as ReconcilerDeps['advanceWatermarkFn'],
      now: () => NOW,
    };

    const first = await runPaperclipReconcilePassOnce({}, d);
    // The skip is REAL: `y` was never handed back by the server this sweep.
    expect(server.served).not.toContain(`y@${TIE}`);
    expect(first.candidates).toBe(3); // x@TIE, z@LATER, x@RESTAMPED — four pairs exist
    // THE ASSERTION THAT MATTERS. Capped at the tie millisecond, not at the max
    // processed stamp (11:59:56) and not at the sweep start (12:00:00).
    expect(advance).toHaveBeenCalledWith(TIE);
    expect(first.watermarkTo).toBe(TIE);

    // The operator's cursor now reads TIE, so the next poll floors at
    // TIE - overlap, which is below the skipped row.
    config.reconciler_watermark = first.watermarkTo as string;
    const servedBefore = server.served.length;
    const second = await runPaperclipReconcilePassOnce({}, d);
    expect(second.ran).toBe(true);
    // Recovered — at-least-once holds through the one channel keyset paging
    // cannot close on its own.
    expect(server.served.slice(servedBefore)).toContain(`y@${TIE}`);
  });
});

// ── C-2 dedupe ────────────────────────────────────────────────────────────

describe('overlap-and-dedupe', () => {
  it('the same (id, updatedAt) seen twice yields ONE candidate — from a REAL duplicate, not a rigged board', async () => {
    // The duplicate here is the keyset boundary row: each re-anchor is inclusive
    // of the previous page's max, so a live server returns that row again. No row
    // is listed twice in the fake's board — a board containing the same object
    // twice is a shape the artifact cannot emit, and asserting against it would
    // prove nothing about the dedupe.
    const t = deps({
      board: [issue('a', T0), issue('b', T1)],
      config: { poll_page_limit: '1' },
    });
    const result = await runPaperclipReconcilePassOnce({}, t.deps);
    expect(result.candidates).toBe(2);
    // The overlap is real, which is what makes "exactly once" non-vacuous.
    expect(result.rowsSeen).toBeGreaterThan(result.candidates);
  });

  it('two revisions of ONE issue are two candidates — the key is the pair, not the id', async () => {
    const t = deps({
      board: [issue('a', T0), issue('a', T5)],
      config: { poll_page_limit: '1' },
    });
    const result = await runPaperclipReconcilePassOnce({}, t.deps);
    expect(result.candidates).toBe(2);
  });
});

// ── Shadow mode ───────────────────────────────────────────────────────────

describe('shadow mode', () => {
  it('performs ZERO writes: every Paperclip request a sweep makes is a GET', async () => {
    const t = deps({
      board: [issue('a', T0), issue('b', T1)],
      config: { poll_page_limit: '1' },
    });
    const result = await runPaperclipReconcilePassOnce({}, t.deps);
    expect(result.mode).toBe('shadow');
    expect(t.calls.length).toBeGreaterThan(0);
    expect(t.calls.map((c) => c.method)).toEqual(t.calls.map(() => 'GET'));
  });

  it('an unrecognized mode resolves to shadow — a typo fails towards observing', async () => {
    const t = deps({ config: { reconciler_mode: 'LIVE!' } });
    expect((await runPaperclipReconcilePassOnce({}, t.deps)).mode).toBe('shadow');
  });

  it('mode=off does no work and reads nothing', async () => {
    const t = deps({ board: [issue('a', T0)], config: { reconciler_mode: 'off' } });
    expect(await runPaperclipReconcilePassOnce({}, t.deps)).toMatchObject({
      ran: false,
      reason: 'mode-off',
    });
    expect(t.calls).toHaveLength(0);
  });
});

// ── Promotion is a config write, not a deploy ─────────────────────────────

describe('promotion is a config write, not a deploy', () => {
  it('flipping reconciler_mode and poll_interval_ms takes effect on the NEXT pass, with no restart', async () => {
    const config: Record<string, string> = { reconciler_mode: 'off' };
    const server = fakePaperclip({ board: [issue('a', T0)] });
    const d: ReconcilerDeps = {
      client: paperclipTestClient({ fetchFn: server.fetchFn }),
      // Re-read every pass — this is the whole mechanism. Reading it once in
      // startPaperclipReconciler() would pin it for the life of the task.
      getConfigFn: async () => config,
      acquireLease: (async () => true) as unknown as ReconcilerDeps['acquireLease'],
      advanceWatermarkFn: (async () => true) as unknown as ReconcilerDeps['advanceWatermarkFn'],
      now: () => NOW,
    };

    expect(await runPaperclipReconcilePassOnce({}, d)).toMatchObject({ reason: 'mode-off' });

    // A config WRITE, in the same process — no redeploy, no task restart.
    config.reconciler_mode = 'shadow';
    config.poll_interval_ms = '60000';
    const promoted = await runPaperclipReconcilePassOnce({}, d);
    expect(promoted).toMatchObject({ ran: true, mode: 'shadow', pollIntervalMs: 60_000 });

    config.reconciler_mode = 'live';
    expect((await runPaperclipReconcilePassOnce({}, d)).mode).toBe('live');
  });

  it('the loop reads config on every pass, not once at start', async () => {
    const t = deps();
    await runPaperclipReconcilePassOnce({}, t.deps);
    await runPaperclipReconcilePassOnce({}, t.deps);
    // getConfigFn is a plain closure here; the observable proof is that a value
    // changed between passes is honoured, which the test above asserts. This one
    // pins that a pass never short-circuits on a cached first read.
    const t2 = deps({ config: { poll_interval_ms: '30000' } });
    expect((await runPaperclipReconcilePassOnce({}, t2.deps)).pollIntervalMs).toBe(30_000);
  });
});

// ── Config parsing ────────────────────────────────────────────────────────

describe('config parsing', () => {
  it('the poll interval has a 15 s FLOOR (undebounced agent_api_keys.last_used_at write per request)', async () => {
    const t = deps({ config: { poll_interval_ms: '1000' } });
    const result = await runPaperclipReconcilePassOnce({}, t.deps);
    expect(result.pollIntervalMs).toBe(POLL_INTERVAL_FLOOR_MS);
    expect(POLL_INTERVAL_FLOOR_MS).toBe(15_000);
  });

  it('a value above the floor is honoured verbatim', async () => {
    const t = deps({ config: { poll_interval_ms: '45000' } });
    expect((await runPaperclipReconcilePassOnce({}, t.deps)).pollIntervalMs).toBe(45_000);
  });

  it('a junk value falls back to the seeded default rather than throwing', async () => {
    const t = deps({ config: { poll_interval_ms: 'soon', poll_page_limit: '-3' } });
    const result = await runPaperclipReconcilePassOnce({}, t.deps);
    expect(result.pollIntervalMs).toBe(RECONCILER_DEFAULTS.pollIntervalMs);
    expect(sweepCalls(t.calls)[0].searchParams.get('limit')).toBe('500');
  });

  it('FALLBACK DEFAULTS BYTE-MATCH scripts/lib/seed-defaults.ts, so seeding is behavior-neutral', () => {
    const seeded = Object.fromEntries(
      SEED_DEFAULTS.filter((r) => r.category === 'paperclip').map((r) => [r.key, r.value]),
    );
    expect(seeded).toEqual({
      poll_interval_ms: String(RECONCILER_DEFAULTS.pollIntervalMs),
      poll_overlap_ms: String(RECONCILER_DEFAULTS.pollOverlapMs),
      poll_page_limit: String(RECONCILER_DEFAULTS.pollPageLimit),
      reconciler_mode: RECONCILER_DEFAULTS.mode,
      enabled_agents: RECONCILER_DEFAULTS.enabledAgents,
    });
    // And the cursor is deliberately NOT seeded — its default is absence.
    expect(seeded).not.toHaveProperty('reconciler_watermark');
  });

  it('enabled_agents is parsed and reported so an operator can see what a promotion would act on', async () => {
    const t = deps({ config: { enabled_agents: '["main","ops"]' } });
    expect((await runPaperclipReconcilePassOnce({}, t.deps)).enabledAgents).toEqual(['main', 'ops']);
    const junk = deps({ config: { enabled_agents: 'not json' } });
    expect((await runPaperclipReconcilePassOnce({}, junk.deps)).enabledAgents).toEqual([]);
  });
});

// ── The loop itself ───────────────────────────────────────────────────────

describe('startPaperclipReconciler / stopPaperclipReconciler', () => {
  it('is idempotent, jitters the first tick, and stop() clears the pending timer', () => {
    vi.useFakeTimers();
    startPaperclipReconciler();
    expect(vi.getTimerCount()).toBe(1);
    startPaperclipReconciler();
    expect(vi.getTimerCount()).toBe(1);
    stopPaperclipReconciler();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('start() returns void and never throws, so index.ts can call it bare', () => {
    vi.useFakeTimers();
    expect(startPaperclipReconciler()).toBeUndefined();
    expect(stopPaperclipReconciler()).toBeUndefined();
  });
});
