import { describe, it, expect, vi, beforeEach } from 'vitest';

const { send, scanForExfil, getEffectivePatterns, redactMatches } = vi.hoisted(() => ({
  send: vi.fn(),
  scanForExfil: vi.fn(),
  getEffectivePatterns: vi.fn(),
  redactMatches: vi.fn(),
}));

vi.mock('../state/ddb.js', () => ({ ddb: () => ({ send }) }));
vi.mock('../safety/exfil-guard.js', () => ({ scanForExfil, getEffectivePatterns, redactMatches }));

import { redactForModel, WITHHELD_PLACEHOLDER } from './safe-egress.js';

const SECRET = 'token AKIAIOSFODNN7EXAMPLE here';

/** Drive the fail-closed exfil_guard_disabled read. */
function guard(spec: { active: boolean } | 'throw'): void {
  if (spec === 'throw') send.mockRejectedValue(new Error('ddb down'));
  else send.mockResolvedValue({ Item: { active: spec.active } });
}

describe('redactForModel — fail-closed model-input boundary (H1)', () => {
  beforeEach(() => {
    send.mockReset();
    scanForExfil.mockReset();
    getEffectivePatterns.mockReset();
    redactMatches.mockReset();
    getEffectivePatterns.mockResolvedValue([]);
    redactMatches.mockReturnValue('[REDACTED]');
  });

  it('WITHHOLDS entirely when the exfil guard is disabled (does not even scan)', async () => {
    guard({ active: true });
    const r = await redactForModel(SECRET);
    expect(r.withheld).toBe(true);
    expect(r.text).toBe(WITHHELD_PLACEHOLDER);
    expect(scanForExfil).not.toHaveBeenCalled();
  });

  it('WITHHOLDS when the guard read errors (unknown → fail closed)', async () => {
    guard('throw');
    const r = await redactForModel(SECRET);
    expect(r.withheld).toBe(true);
    expect(scanForExfil).not.toHaveBeenCalled();
  });

  it('redacts on a warning-only match (warn AND block severities)', async () => {
    guard({ active: false });
    scanForExfil.mockResolvedValue({
      blocked: false, // warning-only — the generic guard would NOT block, but we still redact
      matches: [{ patternId: 'aws', patternName: 'AWS key', severity: 'warn', snippet: 'AKIA…' }],
      scannedBytes: 10,
      truncated: false,
    });
    const r = await redactForModel(SECRET);
    expect(r.withheld).toBe(false);
    expect(r.text).toBe('[REDACTED]');
    expect(r.matchCount).toBe(1);
  });

  it('passes clean text through unchanged', async () => {
    guard({ active: false });
    scanForExfil.mockResolvedValue({ blocked: false, matches: [], scannedBytes: 5, truncated: false });
    const r = await redactForModel('two agents healthy');
    expect(r.withheld).toBe(false);
    expect(r.text).toBe('two agents healthy');
    expect(r.matchCount).toBe(0);
  });

  it('WITHHOLDS when the scan itself errors', async () => {
    guard({ active: false });
    scanForExfil.mockRejectedValue(new Error('scan boom'));
    const r = await redactForModel(SECRET);
    expect(r.withheld).toBe(true);
  });

  it('stringifies non-string input before scanning', async () => {
    guard({ active: false });
    scanForExfil.mockResolvedValue({ blocked: false, matches: [], scannedBytes: 5, truncated: false });
    const r = await redactForModel({ costUsd: 41 });
    expect(r.withheld).toBe(false);
    expect(r.text).toBe('{"costUsd":41}');
  });
});
