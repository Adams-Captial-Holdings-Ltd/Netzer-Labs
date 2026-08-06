/**
 * Consolidation worker entry point. Invoked as a Fargate one-shot task
 * by the consolidation spawner Lambda.
 *
 * Reads AGENT_ID and CHAT_ID from environment, runs consolidation,
 * then exits. The EventBridge ECS task-state-change rule captures the
 * exit and fires the finalizer Lambda.
 */

import { consolidateChat } from '../lib/memory/consolidator.js';
import { logger } from '../observability/logger.js';
import { randomUUID } from 'node:crypto';

const agentId = process.env.CONSOLIDATION_AGENT_ID;
const chatId = process.env.CONSOLIDATION_CHAT_ID;
const workerId = process.env.CONSOLIDATION_WORKER_ID ?? randomUUID();

async function main(): Promise<void> {
  if (!agentId || !chatId) {
    logger.error({}, 'CONSOLIDATION_AGENT_ID and CONSOLIDATION_CHAT_ID required');
    process.exit(1);
  }

  logger.info({ agentId, chatId, workerId }, 'consolidation worker starting');

  try {
    const result = await consolidateChat(agentId, chatId, workerId);
    logger.info({ ...result }, 'consolidation worker finished');
    process.exit(0);
  } catch (err) {
    logger.error({ agentId, chatId, err: err instanceof Error ? err.message : String(err) }, 'consolidation worker failed');
    process.exit(1);
  }
}

main();
