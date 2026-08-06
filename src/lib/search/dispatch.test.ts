import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { pickSearchAdapter, listSearchAdapters } from './dispatch.js';

const KEYS = ['TAVILY_API_KEY', 'BRAVE_SEARCH_API_KEY', 'EXA_API_KEY', 'SERPER_API_KEY', 'CCE_SEARCH_ADAPTER'];

describe('pickSearchAdapter', () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('returns undefined when no vendor configured', () => {
    expect(pickSearchAdapter()).toBeUndefined();
  });

  it('prefers Tavily when only Tavily is set', () => {
    process.env.TAVILY_API_KEY = 'x';
    expect(pickSearchAdapter()?.name).toBe('tavily');
  });

  it('honors CCE_SEARCH_ADAPTER override', () => {
    process.env.TAVILY_API_KEY = 'x';
    process.env.BRAVE_SEARCH_API_KEY = 'y';
    process.env.CCE_SEARCH_ADAPTER = 'brave';
    expect(pickSearchAdapter()?.name).toBe('brave');
  });

  it('falls back if override isn\'t configured', () => {
    process.env.TAVILY_API_KEY = 'x';
    process.env.CCE_SEARCH_ADAPTER = 'exa'; // EXA_API_KEY not set
    expect(pickSearchAdapter()?.name).toBe('tavily');
  });

  it('listSearchAdapters reports configured flags', () => {
    process.env.BRAVE_SEARCH_API_KEY = 'y';
    const list = listSearchAdapters();
    expect(list.find((a) => a.name === 'brave')?.configured).toBe(true);
    expect(list.find((a) => a.name === 'tavily')?.configured).toBe(false);
  });
});
