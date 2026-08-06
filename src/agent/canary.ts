/**
 * Synthetic canary — runs /api/test-turn against the local orchestrator
 * every 5 minutes when CCE_CANARY_ENABLED=1. Records a `canary_fired`
 * audit row with the wall-clock latency. Failure emits a separate
 * audit row + warn log so the alarm filter trips.
 *
 * Why in-process (not Lambda-driven from EB):
 *  - the orchestrator already runs 24/7
 *  - dedicated Lambda + IAM + cross-stack wiring isn't worth the cost
 *    of a synthetic check
 *  - the EB CanaryHeartbeat rule in observability-stack is still
 *    provisioned as a future hook, but it has no target; this is the
 *    actual implementation
 */

import { logger } from '../observability/logger.js';
import { runAgentTurn, KillSwitchActiveError } from './agent-loop.js';
import { writeAudit } from '../lib/audit/audit-writer.js';
import { tryAcquireRunnerLease } from '../lib/state/runner-lease.js';

const CANARY_INTERVAL_MS = 5 * 60 * 1000;
// Phrasing matters: the imperative "reply with the exact word X" pattern trips
// the Bedrock guardrail's PROMPT_ATTACK filter (HIGH input strength) as a
// low-confidence prompt-injection, blocking every canary and faking an outage.
// This softer phrasing passes the guardrail while still eliciting "alive".
const CANARY_PROMPT = 'Reply with alive to confirm you are up.';
const CANARY_CHAT_ID = 'system:canary';

let timer: NodeJS.Timeout | null = null;
let running = false;

export function isCanaryEnabled(): boolean {
  return process.env.CCE_CANARY_ENABLED === '1';
}

export function startCanary(): void {
  if (!isCanaryEnabled()) {
    logger.info({}, 'canary disabled (CCE_CANARY_ENABLED != 1)');
    return;
  }
  if (timer) return;
  // Stagger so two Fargate tasks don't fire on the same wall-clock minute.
  const initialDelayMs =
    Math.floor(Math.random() * CANARY_INTERVAL_MS) + 30_000;
  logger.info(
    { intervalMs: CANARY_INTERVAL_MS, initialDelayMs },
    'canary armed',
  );
  timer = setTimeout(() => {
    void tick();
    timer = setInterval(() => void tick(), CANARY_INTERVAL_MS);
  }, initialDelayMs);
}

export function stopCanary(): void {
  if (timer) {
    clearTimeout(timer);
    clearInterval(timer);
    timer = null;
  }
}

async function tick(): Promise<void> {
  if (running) return;
  // H6: one canary across the whole fleet. Every task keeps its timer; only
  // the lease holder fires the paid turn. Lease TTL is 2x the interval so a
  // healthy holder renews each tick and a dead one frees the canary within
  // one period. Fail-open on a lease-store error (see runner-lease.ts).
  if (!(await tryAcquireRunnerLease({ name: 'canary', ttlMs: CANARY_INTERVAL_MS * 2 }))) {
    return;
  }
  running = true;
  const startedAt = Date.now();
  try {
    const result = await runAgentTurn({
      agentId: 'main',
      chatId: CANARY_CHAT_ID,
      userText: CANARY_PROMPT,
      history: [],
      surface: 'system',
    });
    const latencyMs = Date.now() - startedAt;
    const aliveSeen = /\balive\b/i.test(result.text);
    void writeAudit({
      action: 'canary_fired',
      agentId: 'main',
      chatId: CANARY_CHAT_ID,
      surface: 'system',
      latencyMs,
      costUsd: result.costUsd,
      detail: {
        textLen: result.text.length,
        aliveSeen,
      },
      result: aliveSeen ? 'ok' : 'error',
    });
    if (!aliveSeen) {
      logger.warn(
        { textPreview: result.text.slice(0, 120) },
        'canary turn did not contain "alive"',
      );
    }
  } catch (err) {
    const errMessage = err instanceof Error ? err.message : String(err);
    if (err instanceof KillSwitchActiveError) {
      // Don't page on a deliberate kill switch — it's a known state.
      logger.info({ errMessage }, 'canary skipped (kill switch active)');
    } else {
      logger.error({ errMessage }, 'canary failed');
      void writeAudit({
        action: 'canary_fired',
        agentId: 'main',
        chatId: CANARY_CHAT_ID,
        surface: 'system',
        latencyMs: Date.now() - startedAt,
        result: 'error',
        errMessage,
      });
    }
  } finally {
    running = false;
  }
}
