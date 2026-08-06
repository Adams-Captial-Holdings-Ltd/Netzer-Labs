/**
 * Memory consolidator. 8-step flow:
 *   1. Fetch unconsolidated memories for agent+chat
 *   2. Claim memories (prevent concurrent workers)
 *   3. Derive deterministic consolidation ID
 *   4. Idempotency pre-check (skip if already exists)
 *   5. Call Bedrock Haiku to summarize
 *   6. Write consolidation record
 *   7. Mark source memories as consolidated
 *   8. Release claims
 */

import { logger } from '../../observability/logger.js';
import { converseTurn } from '../bedrock/client.js';
import { writeAudit } from '../audit/audit-writer.js';
import { isKillSwitchActive } from '../state/kill-switches-repo.js';
import {
  fetchUnconsolidated,
  markConsolidated,
  claimForConsolidation,
  releaseClaim,
} from '../state/memories-repo.js';
import {
  deriveConsolidationId,
  getConsolidation,
  writeConsolidation,
} from '../state/consolidations-repo.js';

const MIN_MEMORIES = 5;
const HAIKU_MODEL = process.env.BEDROCK_HAIKU_MODEL ?? 'us.anthropic.claude-haiku-4-5';

export interface ConsolidationResult {
  consolidationId: string;
  memoriesProcessed: number;
  skipped: boolean;
  reason?: string;
}

export async function consolidateChat(
  agentId: string,
  chatId: string,
  workerId: string,
): Promise<ConsolidationResult> {
  const disabled = await isKillSwitchActive('memory_consolidation_disabled').catch(() => ({
    active: false,
  }));
  if (disabled.active) {
    return { consolidationId: '', memoriesProcessed: 0, skipped: true, reason: 'disabled' };
  }

  const memories = await fetchUnconsolidated(agentId, chatId, 200);
  if (memories.length < MIN_MEMORIES) {
    return {
      consolidationId: '',
      memoriesProcessed: 0,
      skipped: true,
      reason: `only ${memories.length} unconsolidated (need ${MIN_MEMORIES})`,
    };
  }

  const claimed: typeof memories = [];
  for (const m of memories) {
    const ok = await claimForConsolidation(agentId, chatId, m.id, m.createdAt, workerId);
    if (ok) claimed.push(m);
  }

  if (claimed.length < MIN_MEMORIES) {
    for (const m of claimed) {
      await releaseClaim(agentId, chatId, m.id, m.createdAt).catch(() => {});
    }
    return {
      consolidationId: '',
      memoriesProcessed: 0,
      skipped: true,
      reason: 'could not claim enough memories',
    };
  }

  const memoryIds = claimed.map((m) => m.id);
  const consolidationId = deriveConsolidationId(agentId, chatId, memoryIds);

  const existing = await getConsolidation(agentId, consolidationId);
  if (existing) {
    for (const m of claimed) {
      await markConsolidated(agentId, chatId, m.id, m.createdAt).catch(() => {});
    }
    return { consolidationId, memoriesProcessed: claimed.length, skipped: true, reason: 'already exists' };
  }

  const memoryBlock = claimed
    .map((m) => `- [${m.importance}] ${m.content}`)
    .join('\n');

  const prompt = `You are a memory consolidation engine. Given the following memories from a conversation, produce a concise summary that captures the key facts, preferences, and context. Output ONLY the summary, nothing else.\n\nMemories:\n${memoryBlock}`;

  let summary: string;
  try {
    const result = await converseTurn({
      modelId: HAIKU_MODEL,
      systemPrompt: 'You consolidate memories into concise summaries.',
      userText: prompt,
      maxTokens: 512,
      temperature: 0.3,
    });
    summary = result.text;
  } catch (err) {
    logger.error({ agentId, chatId, err: err instanceof Error ? err.message : String(err) }, 'consolidation Haiku call failed');
    for (const m of claimed) {
      await releaseClaim(agentId, chatId, m.id, m.createdAt).catch(() => {});
    }
    void writeAudit({
      action: 'consolidation_task_failed_after_running',
      agentId,
      detail: { chatId, error: err instanceof Error ? err.message : String(err) },
      result: 'error',
    });
    throw err;
  }

  const avgImportance = Math.round(claimed.reduce((s, m) => s + m.importance, 0) / claimed.length);

  await writeConsolidation({
    consolidationId,
    agentId,
    chatId,
    summary,
    sourceMemoryIds: memoryIds,
    importance: avgImportance,
    createdAt: new Date().toISOString(),
  });

  for (const m of claimed) {
    await markConsolidated(agentId, chatId, m.id, m.createdAt).catch(() => {});
  }

  void writeAudit({
    action: 'memory_consolidate',
    agentId,
    detail: { chatId, consolidationId, memoriesProcessed: claimed.length },
    result: 'ok',
  });

  logger.info({ agentId, chatId, consolidationId, count: claimed.length }, 'consolidation complete');

  return { consolidationId, memoriesProcessed: claimed.length, skipped: false };
}
