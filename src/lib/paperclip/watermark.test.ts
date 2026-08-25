import { describe, it, expect, vi, beforeEach } from 'vitest';

const { setIfGreater, logWarn } = vi.hoisted(() => ({
  setIfGreater: vi.fn(),
  logWarn: vi.fn(),
}));
vi.mock('../state/runtime-config-repo.js', () => ({ setConfigIfGreater: setIfGreater }));
vi.mock('../../observability/logger.js', () => ({
  logger: { info: vi.fn(), warn: logWarn, error: vi.fn() },
}));

import {
  PAPERCLIP_WATERMARK_KEY,
  advancePaperclipWatermark,
  normalizeWatermark,
  paperclipPollSinceMs,
  paperclipWatermarkFrom,
} from './watermark.js';

beforeEach(() => {
  setIfGreater.mockReset();
  logWarn.mockClear();
});

describe('paperclipWatermarkFrom', () => {
  it('reads the cursor out of the paperclip category record with no extra round-trip', () => {
    expect(
      paperclipWatermarkFrom({
        poll_interval_ms: '15000',
        [PAPERCLIP_WATERMARK_KEY]: '2026-08-21T10:00:00.000Z',
      }),
    ).toEqual({ updatedAt: '2026-08-21T10:00:00.000Z' });
    expect(setIfGreater).not.toHaveBeenCalled();
  });

  it('an absent cursor is absence, not epoch', () => {
    expect(paperclipWatermarkFrom({}).updatedAt).toBeUndefined();
  });

  it('A CORRUPT CURSOR IS FLAGGED, NOT FOLDED INTO ABSENCE — the two mean opposite things', () => {
    // Absence is "never swept" and cold-starting at `now - overlap` is correct.
    // A value that will not parse is "swept to somewhere unreadable", and cold-
    // starting there SKIPS everything between the real cursor and now. Collapsing
    // them would make the unsafe case look like the safe one.
    expect(paperclipWatermarkFrom({ [PAPERCLIP_WATERMARK_KEY]: 'not-a-date' })).toEqual({
      corrupt: true,
    });
    expect(paperclipWatermarkFrom({})).toEqual({ updatedAt: undefined });
  });
});

describe('normalizeWatermark', () => {
  it('canonicalizes an offset spelling so the DDB byte comparison stays chronological', () => {
    expect(normalizeWatermark('2026-08-21T10:00:00.500+00:00')).toBe('2026-08-21T10:00:00.500Z');
  });
});

describe('paperclipPollSinceMs — C-2 overlap, and cold start', () => {
  it('cold start begins at now - poll_overlap_ms, NOT epoch', () => {
    const now = Date.parse('2026-08-21T10:00:00.000Z');
    const since = paperclipPollSinceMs({ watermark: {}, overlapMs: 2000, now });
    expect(since).toBe(now - 2000);
    expect(new Date(since).toISOString()).toBe('2026-08-21T09:59:58.000Z');
  });

  it('a warm poll subtracts the overlap from the watermark (C-2/M30, not the ADR +1ms)', () => {
    const since = paperclipPollSinceMs({
      watermark: { updatedAt: '2026-08-21T10:00:00.000Z' },
      overlapMs: 2000,
      now: Date.parse('2026-08-21T10:00:30.000Z'),
    });
    expect(new Date(since).toISOString()).toBe('2026-08-21T09:59:58.000Z');
  });

  it('an unparseable ANCHOR still resolves to a number, but reaching it means SKIPPING, not re-reading', () => {
    // The arithmetic is total so nothing here can throw or emit NaN. It is NOT a
    // safe fallback, and the earlier version of this test said it was: resuming at
    // `now - overlap` from a lost cursor skips the backlog. `paperclipWatermarkFrom`
    // flags the corruption and the reconciler refuses the sweep, so no production
    // path reaches this branch — it exists only so a malformed value cannot crash
    // the loop before that refusal runs.
    const now = Date.parse('2026-08-21T10:00:00.000Z');
    expect(paperclipPollSinceMs({ watermark: { updatedAt: 'nope' }, overlapMs: 2000, now })).toBe(
      now - 2000,
    );
  });
});

describe('advancePaperclipWatermark', () => {
  it('goes through the monotonic conditional write, keyed on the paperclip category', async () => {
    setIfGreater.mockResolvedValue(true);
    await expect(advancePaperclipWatermark('2026-08-21T10:00:00.000Z')).resolves.toBe(true);
    expect(setIfGreater).toHaveBeenCalledWith(
      'paperclip',
      'reconciler_watermark',
      '2026-08-21T10:00:00.000Z',
      { updatedBy: 'paperclip-reconciler' },
    );
  });

  it('NEVER MOVES BACKWARDS: a losing conditional write is false, not a throw', async () => {
    setIfGreater.mockResolvedValue(false);
    await expect(advancePaperclipWatermark('2026-08-20T00:00:00.000Z')).resolves.toBe(false);
    expect(logWarn).not.toHaveBeenCalled();
  });

  it('normalizes before storing, so a mixed ISO spelling cannot defeat the byte guard', async () => {
    setIfGreater.mockResolvedValue(true);
    await advancePaperclipWatermark('2026-08-21T10:00:00.500+00:00');
    expect(setIfGreater.mock.calls[0][2]).toBe('2026-08-21T10:00:00.500Z');
  });

  it('a store error is false with a loud warn — a re-swept overlap, never a lost row', async () => {
    setIfGreater.mockRejectedValue(new Error('down'));
    await expect(advancePaperclipWatermark('2026-08-21T10:00:00.000Z')).resolves.toBe(false);
    expect(logWarn).toHaveBeenCalledWith(
      expect.objectContaining({ errMessage: 'down' }),
      expect.stringContaining('cursor unchanged'),
    );
  });

  it('refuses an unparseable value without touching the store', async () => {
    await expect(advancePaperclipWatermark('nope')).resolves.toBe(false);
    expect(setIfGreater).not.toHaveBeenCalled();
  });
});
