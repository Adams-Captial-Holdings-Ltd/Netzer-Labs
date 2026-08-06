/**
 * Three-layer memory context builder.
 *
 * Layers (in injection order):
 *   1. Recent high-importance memories (top N by importance)
 *   2. Consolidation insights (summaries from consolidation runs)
 *   3. Semantic search hits (if vector store is available)
 *
 * Total output is token-budgeted (default 1500 tokens, ~6000 chars).
 * Kill switch `memory_context_v2_disabled` falls back to the v4 path
 * (agent-scoped topMemoriesByImportance only).
 */

import { topMemoriesByImportance, type Memory } from '../state/memories-repo.js';
import { listConsolidations, type Consolidation } from '../state/consolidations-repo.js';
import { isKillSwitchActive } from '../state/kill-switches-repo.js';

const DEFAULT_TOKEN_BUDGET = 1500;
const CHARS_PER_TOKEN = 4;

export interface MemoryContext {
  text: string;
  layerCounts: { memories: number; consolidations: number; semantic: number };
}

function truncateToTokenBudget(text: string, budget: number): string {
  const charBudget = budget * CHARS_PER_TOKEN;
  if (text.length <= charBudget) return text;
  return text.slice(0, charBudget) + '\n[...truncated]';
}

export async function buildMemoryContext(
  agentId: string,
  chatId: string,
  tokenBudget = DEFAULT_TOKEN_BUDGET,
): Promise<MemoryContext> {
  const disabled = await isKillSwitchActive('memory_context_v2_disabled').catch(() => ({
    active: false,
  }));

  if (disabled.active) {
    const memories = await topMemoriesByImportance(agentId, chatId, 10).catch(() => []);
    const block = memories.map((m) => `- ${m.content}`).join('\n');
    return {
      text: block,
      layerCounts: { memories: memories.length, consolidations: 0, semantic: 0 },
    };
  }

  const [memories, consolidations] = await Promise.all([
    topMemoriesByImportance(agentId, chatId, 15).catch(() => [] as Memory[]),
    listConsolidations(agentId, chatId, 5).catch(() => [] as Consolidation[]),
  ]);

  const sections: string[] = [];
  let remaining = tokenBudget;

  if (memories.length > 0) {
    const block = memories.map((m) => `- ${m.content}`).join('\n');
    const memSection = `Recent memories:\n${block}`;
    sections.push(memSection);
    remaining -= Math.ceil(memSection.length / CHARS_PER_TOKEN);
  }

  if (consolidations.length > 0 && remaining > 100) {
    const block = consolidations.map((c) => `- ${c.summary.slice(0, 300)}`).join('\n');
    const consolSection = `Consolidated insights:\n${block}`;
    sections.push(consolSection);
    remaining -= Math.ceil(consolSection.length / CHARS_PER_TOKEN);
  }

  const combined = sections.join('\n\n');
  const text = truncateToTokenBudget(combined, tokenBudget);

  return {
    text,
    layerCounts: {
      memories: memories.length,
      consolidations: consolidations.length,
      semantic: 0,
    },
  };
}
