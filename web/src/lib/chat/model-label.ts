// DOM-free model family and context labels for the chat model picker.

import type { Model } from './types.js';

export function modelTriggerParts(m: Model): { family: string; context: string } {
  const family = m.family ? `${m.family[0].toUpperCase()}${m.family.slice(1)}` : '';
  const context = m.contextWindow >= 1_000_000 && m.contextWindow % 1_000_000 === 0
    ? `${m.contextWindow / 1_000_000}M`
    : `${Math.round(m.contextWindow / 1000)}K`;
  return { family, context };
}
