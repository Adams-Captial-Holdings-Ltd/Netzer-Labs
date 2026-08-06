import { describe, it, expect } from 'vitest';
import { pickOverall, type AlarmRow, type CanarySummary } from './data.js';

function alarm(state: AlarmRow['state'], name = 'x'): AlarmRow {
  return { name, state };
}

function canary(uptimePct: number | null, total = 100): CanarySummary {
  return {
    windowHours: 24,
    total,
    ok: uptimePct === null ? 0 : Math.round((uptimePct / 100) * total),
    errors: uptimePct === null ? 0 : total - Math.round((uptimePct / 100) * total),
    uptimePct,
  };
}

describe('pickOverall', () => {
  it('returns down when any alarm is in ALARM state', () => {
    expect(
      pickOverall({
        alarms: [alarm('OK'), alarm('ALARM', 'bedrock-errors'), alarm('OK')],
        canary: canary(100),
      }),
    ).toBe('down');
  });

  it('returns degraded when uptime is below 95%', () => {
    expect(
      pickOverall({ alarms: [alarm('OK')], canary: canary(94.9) }),
    ).toBe('degraded');
  });

  it('returns ok when alarms are clean and uptime is above 95%', () => {
    expect(
      pickOverall({ alarms: [alarm('OK')], canary: canary(99.9) }),
    ).toBe('ok');
  });

  it('returns ok when uptime is null (no canary data yet) and alarms are clean', () => {
    expect(
      pickOverall({ alarms: [alarm('OK')], canary: canary(null, 0) }),
    ).toBe('ok');
  });

  it('alarm takes precedence over uptime', () => {
    expect(
      pickOverall({
        alarms: [alarm('ALARM', 'something')],
        canary: canary(100),
      }),
    ).toBe('down');
  });

  it('INSUFFICIENT_DATA alarms do not push to down', () => {
    expect(
      pickOverall({
        alarms: [alarm('INSUFFICIENT_DATA', 'cold-start')],
        canary: canary(100),
      }),
    ).toBe('ok');
  });
});
