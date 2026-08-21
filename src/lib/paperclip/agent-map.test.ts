import { describe, expect, it } from 'vitest';
import { buildAgentIdMap, createAgentIdMapCache } from './agent-map.js';
import type { PaperclipAgent } from './types.js';

// Fakes only, built from object literals: no network, no mocking library.
function agent(overrides: Partial<PaperclipAgent> & Pick<PaperclipAgent, 'id'>): PaperclipAgent {
  return {
    name: 'Main',
    role: 'ceo',
    status: 'active',
    reportsTo: null,
    adapterType: 'http',
    adapterConfig: null,
    metadata: null,
    ...overrides,
  };
}

const MAIN = agent({ id: 'a0000000-0000-4000-8000-000000000001', metadata: { netzarAgentId: 'main' } });
const ANALYST = agent({ id: 'a0000000-0000-4000-8000-000000000002', metadata: { netzarAgentId: 'analyst' } });
const UNJOINED = agent({ id: 'a0000000-0000-4000-8000-000000000003', metadata: { other: 'thing' } });

describe('buildAgentIdMap', () => {
  it('joins slug to uuid on metadata.netzarAgentId in both directions', () => {
    const map = buildAgentIdMap([MAIN, ANALYST]);
    expect(map.toUuid('main')).toBe(MAIN.id);
    expect(map.toSlug(ANALYST.id)).toBe('analyst');
    expect(map.knownSlugs()).toEqual(['analyst', 'main']);
  });

  it('an agent with no netzarAgentId simply has no Netzar identity - it is skipped, never fabricated', () => {
    const map = buildAgentIdMap([MAIN, UNJOINED]);
    expect(map.toSlug(UNJOINED.id)).toBeUndefined();
    expect(map.knownSlugs()).toEqual(['main']);
  });

  it('an unknown slug or uuid answers undefined, which is what makes UnknownAgentError reachable', () => {
    const map = buildAgentIdMap([]);
    expect(map.toUuid('ghost')).toBeUndefined();
    expect(map.toSlug('nope')).toBeUndefined();
  });
});

describe('createAgentIdMapCache', () => {
  it('reads the agent list once per TTL and once more after it expires', async () => {
    let calls = 0;
    let clock = 0;
    const cache = createAgentIdMapCache(
      async () => {
        calls += 1;
        return [MAIN];
      },
      { ttlMs: 100, now: () => clock },
    );

    expect((await cache()).toUuid('main')).toBe(MAIN.id);
    await cache();
    expect(calls).toBe(1);

    clock = 101;
    await cache();
    expect(calls).toBe(2);
  });

  it('N concurrent projections cause ONE agent-list read, because distinct concurrent reads are what Paperclip refuses', async () => {
    let calls = 0;
    const cache = createAgentIdMapCache(async () => {
      calls += 1;
      await Promise.resolve();
      return [MAIN, ANALYST];
    });

    const maps = await Promise.all([cache(), cache(), cache(), cache()]);
    expect(calls).toBe(1);
    for (const map of maps) expect(map.toUuid('analyst')).toBe(ANALYST.id);
  });

  it('a failed load is not cached, so the next call reads again', async () => {
    let calls = 0;
    const cache = createAgentIdMapCache(async () => {
      calls += 1;
      if (calls === 1) throw new Error('paperclip down');
      return [MAIN];
    });

    await expect(cache()).rejects.toThrow('paperclip down');
    expect((await cache()).toUuid('main')).toBe(MAIN.id);
    expect(calls).toBe(2);
  });
});
