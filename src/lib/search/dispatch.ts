/**
 * Picks the first configured search adapter, in this order:
 *   Tavily → Brave → Exa → Serper
 *
 * The order is opinion, not policy:
 *   - Tavily has a free tier sized for AI usage (1000 q/mo)
 *   - Brave is cheap and respects privacy
 *   - Exa is best for "find me research-quality writing"
 *   - Serper falls back to plain Google results
 *
 * Override with CCE_SEARCH_ADAPTER=tavily|brave|exa|serper.
 */

import { tavilyAdapter } from './adapters/tavily.js';
import { braveAdapter } from './adapters/brave.js';
import { exaAdapter } from './adapters/exa.js';
import { serperAdapter } from './adapters/serper.js';
import type { SearchAdapter } from './adapters/types.js';

const ADAPTERS: SearchAdapter[] = [
  tavilyAdapter,
  braveAdapter,
  exaAdapter,
  serperAdapter,
];

export function pickSearchAdapter(): SearchAdapter | undefined {
  const explicit = process.env.CCE_SEARCH_ADAPTER?.trim().toLowerCase();
  if (explicit) {
    const chosen = ADAPTERS.find((a) => a.name === explicit);
    if (chosen?.configured()) return chosen;
  }
  return ADAPTERS.find((a) => a.configured());
}

export function listSearchAdapters(): Array<{
  name: string;
  envVar: string;
  configured: boolean;
}> {
  return ADAPTERS.map((a) => ({
    name: a.name,
    envVar: a.envVar,
    configured: a.configured(),
  }));
}
