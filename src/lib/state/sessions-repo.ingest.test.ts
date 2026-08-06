import { describe, it, expect } from 'vitest';
import { decideIngest, clampIngestEveryN } from './sessions-repo.js';

describe('clampIngestEveryN', () => {
  it('defaults to 8 when unset or non-numeric', () => {
    expect(clampIngestEveryN(undefined)).toBe(8);
    expect(clampIngestEveryN('abc')).toBe(8);
  });
  it('clamps to [2, 20] and floors', () => {
    expect(clampIngestEveryN('0')).toBe(2);
    expect(clampIngestEveryN('1')).toBe(2);
    expect(clampIngestEveryN('100')).toBe(20);
    expect(clampIngestEveryN('10')).toBe(10);
    expect(clampIngestEveryN('8.9')).toBe(8);
  });
});

describe('decideIngest', () => {
  it('does not ingest with fewer than 2 pending turns', () => {
    expect(decideIngest({ turnsTotal: 1, turnsIngested: 0, evictedCount: 0, everyN: 8, windowLen: 1 }))
      .toEqual({ ingest: false, pendingCount: 1 });
  });
  it('ingests once the cadence threshold is reached', () => {
    expect(decideIngest({ turnsTotal: 8, turnsIngested: 0, evictedCount: 0, everyN: 8, windowLen: 8 }))
      .toEqual({ ingest: true, pendingCount: 8 });
    expect(decideIngest({ turnsTotal: 7, turnsIngested: 0, evictedCount: 0, everyN: 8, windowLen: 7 }))
      .toEqual({ ingest: false, pendingCount: 7 });
  });
  it('ingests as a backstop when turns evict, even below cadence', () => {
    expect(decideIngest({ turnsTotal: 21, turnsIngested: 19, evictedCount: 1, everyN: 8, windowLen: 20 }))
      .toEqual({ ingest: true, pendingCount: 2 });
  });
  it('caps pendingCount to the live window length', () => {
    expect(decideIngest({ turnsTotal: 50, turnsIngested: 0, evictedCount: 30, everyN: 8, windowLen: 20 }).pendingCount)
      .toBe(20);
  });
});
