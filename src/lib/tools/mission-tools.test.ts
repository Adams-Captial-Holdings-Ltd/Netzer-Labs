import { describe, it, expect } from 'vitest';
import { parseAssignResponse } from './mission-tools.js';

describe('parseAssignResponse', () => {
  const known = ['main', 'ops', 'research'];

  it('parses well-formed Haiku output', () => {
    const raw = 'AGENT: ops\nREASON: ops handles scheduling and billing tasks.';
    const out = parseAssignResponse(raw, known);
    expect(out.owner).toBe('ops');
    expect(out.reason).toContain('billing');
  });

  it('strips quotes and backticks around agent id', () => {
    const raw = 'AGENT: `research`\nREASON: deep dive';
    expect(parseAssignResponse(raw, known).owner).toBe('research');
  });

  it('case-insensitive agent matching', () => {
    const raw = 'AGENT: OPS\nREASON: x';
    expect(parseAssignResponse(raw, known).owner).toBe('ops');
  });

  it('falls back to first agent on garbage', () => {
    const out = parseAssignResponse('I think ops is best.', known);
    expect(out.owner).toBe('main');
    expect(out.reason).toMatch(/auto-fallback/);
  });

  it('falls back when picked agent unknown', () => {
    const out = parseAssignResponse('AGENT: legal\nREASON: legal stuff', known);
    expect(out.owner).toBe('main');
  });
});
