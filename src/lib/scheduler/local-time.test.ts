import { describe, it, expect } from 'vitest';
import { nextOccurrenceUtc } from './local-time.js';

// Toronto is UTC-5 (EST) in winter, UTC-4 (EDT) in summer. The DST cases pin
// the exact conversion across the 2026-03-08 spring-forward boundary.
describe('nextOccurrenceUtc', () => {
  it('computes the same-day occurrence when the time is still ahead', () => {
    // 2026-01-15 10:00 UTC = 05:00 in Toronto. 08:00 Toronto = 13:00 UTC.
    const now = new Date('2026-01-15T10:00:00Z');
    const next = nextOccurrenceUtc('08:00', 'America/Toronto', now);
    expect(new Date(next * 1000).toISOString()).toBe('2026-01-15T13:00:00.000Z');
  });

  it('rolls to tomorrow when today is already past', () => {
    // 2026-01-15 18:00 UTC = 13:00 Toronto — 08:00 already passed.
    const now = new Date('2026-01-15T18:00:00Z');
    const next = nextOccurrenceUtc('08:00', 'America/Toronto', now);
    expect(new Date(next * 1000).toISOString()).toBe('2026-01-16T13:00:00.000Z');
  });

  it('handles EDT (summer) offset', () => {
    // July: Toronto is UTC-4, so 08:00 local = 12:00 UTC.
    const now = new Date('2026-07-10T02:00:00Z');
    const next = nextOccurrenceUtc('08:00', 'America/Toronto', now);
    expect(new Date(next * 1000).toISOString()).toBe('2026-07-10T12:00:00.000Z');
  });

  it('crosses the spring-forward boundary correctly', () => {
    // 2026-03-08: clocks jump 02:00 -> 03:00 in Toronto. At 06:00 UTC on
    // Mar 8 (01:00 EST, pre-jump), the next 08:00 local is the SAME day but
    // already in EDT: 08:00 EDT = 12:00 UTC.
    const now = new Date('2026-03-08T06:00:00Z');
    const next = nextOccurrenceUtc('08:00', 'America/Toronto', now);
    expect(new Date(next * 1000).toISOString()).toBe('2026-03-08T12:00:00.000Z');
  });

  it('works for UTC and eastward zones', () => {
    const now = new Date('2026-01-15T10:00:00Z');
    expect(
      new Date(nextOccurrenceUtc('12:00', 'UTC', now) * 1000).toISOString(),
    ).toBe('2026-01-15T12:00:00.000Z');
    // Tokyo is UTC+9: 08:00 Tokyo on Jan 16 = 23:00 UTC on Jan 15.
    const tokyo = nextOccurrenceUtc('08:00', 'Asia/Tokyo', now);
    expect(new Date(tokyo * 1000).toISOString()).toBe('2026-01-15T23:00:00.000Z');
  });

  it('rejects malformed times and unknown zones', () => {
    expect(() => nextOccurrenceUtc('25:00', 'UTC')).toThrow();
    expect(() => nextOccurrenceUtc('8am', 'UTC')).toThrow();
    expect(() => nextOccurrenceUtc('08:00', 'Not/AZone')).toThrow();
  });
});
