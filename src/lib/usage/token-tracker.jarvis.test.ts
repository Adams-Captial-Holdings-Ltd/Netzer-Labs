import { describe, it, expect, vi, beforeEach } from 'vitest';

const { send, listKnownAgents } = vi.hoisted(() => ({
  send: vi.fn(),
  listKnownAgents: vi.fn(() => ['main']),
}));

vi.mock('../state/ddb.js', () => ({ ddb: () => ({ send }) }));
vi.mock('../config/agent-loader.js', () => ({ listKnownAgents }));

import { getDailyCostUsd, invalidateDailyCostCache, JARVIS_USAGE_AGENT } from './token-tracker.js';

describe('getDailyCostUsd — jarvis surface (H5)', () => {
  beforeEach(() => {
    send.mockReset();
    invalidateDailyCostCache();
  });

  it('aggregates the synthetic jarvis PK alongside registered agents', async () => {
    const seenPks: string[] = [];
    send.mockImplementation(async (cmd: { input: { ExpressionAttributeValues: { ':pk': string } } }) => {
      const pk = cmd.input.ExpressionAttributeValues[':pk'];
      seenPks.push(pk);
      if (pk.startsWith('AGENT#jarvis#DAY#')) return { Items: [{ costUsd: 0.5 }] };
      if (pk.startsWith('AGENT#main#DAY#')) return { Items: [{ costUsd: 1.0 }] };
      return { Items: [] };
    });

    const total = await getDailyCostUsd({ day: '2026-05-31' });
    expect(total).toBeCloseTo(1.5, 6);
    expect(seenPks).toContain('AGENT#main#DAY#2026-05-31');
    expect(seenPks).toContain(`AGENT#${JARVIS_USAGE_AGENT}#DAY#2026-05-31`);
  });

  it('JARVIS_USAGE_AGENT is the literal jarvis partition', () => {
    expect(JARVIS_USAGE_AGENT).toBe('jarvis');
  });
});
