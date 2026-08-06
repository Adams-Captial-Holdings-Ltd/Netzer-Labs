import { describe, it, expect } from 'vitest';
import { renderStatusPage } from './view.js';
import type { StatusData } from './data.js';

const base: StatusData = {
  generatedAt: '2026-05-24T12:00:00.000Z',
  overall: 'ok',
  alarms: [],
  canary: { windowHours: 24, total: 288, ok: 288, errors: 0, uptimePct: 100 },
  deploys: [],
  sourceErrors: [],
};

describe('renderStatusPage', () => {
  it('renders the operational banner when overall is ok', () => {
    const html = renderStatusPage(base);
    expect(html).toContain('All systems operational');
    expect(html).toContain('100.0%');
  });

  it('renders the degraded banner', () => {
    const html = renderStatusPage({ ...base, overall: 'degraded' });
    expect(html).toContain('Degraded performance');
  });

  it('renders the down banner', () => {
    const html = renderStatusPage({ ...base, overall: 'down' });
    expect(html).toContain('Active incident');
  });

  it('escapes alarm names to prevent injection', () => {
    const html = renderStatusPage({
      ...base,
      alarms: [{ name: '<script>alert(1)</script>', state: 'ALARM' }],
      overall: 'down',
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('shows the source-errors warning block when sources fail', () => {
    const html = renderStatusPage({
      ...base,
      sourceErrors: ['canary: ddb-timeout'],
    });
    expect(html).toContain('Page partial');
    expect(html).toContain('canary: ddb-timeout');
  });

  it('shows an empty-state when no alarms tracked', () => {
    const html = renderStatusPage(base);
    expect(html).toContain('No alarms reported');
  });

  it('shows an empty-state when no deploys visible', () => {
    const html = renderStatusPage(base);
    expect(html).toContain('No recent stack updates');
  });

  it('includes the data.json link in the footer', () => {
    expect(renderStatusPage(base)).toContain('/status/data.json');
  });
});
