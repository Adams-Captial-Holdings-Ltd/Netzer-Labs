/**
 * Hook dispatcher. Two-layer dedupe:
 *   1. Pre-invoke: idempotency table check (eventId -> invoking/enqueued/released)
 *   2. Handler-side: runtime layer gate (handling/handled/failed)
 *
 * Fire-and-forget from the hot path. Failures go to the hook DLQ.
 */

import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../state/ddb.js';
import { isKillSwitchActive } from '../state/kill-switches-repo.js';
import { writeAudit } from '../audit/audit-writer.js';
import { logger } from '../../observability/logger.js';
import { deriveEventId } from './event-id.js';
import { listHooksForEvent } from './registry-repo.js';
import { captureAwsClient } from '../observability/xray.js';

const region = process.env.AWS_REGION ?? 'us-east-1';
const IDEMPOTENCY_TABLE = process.env.TABLE_HOOK_IDEMPOTENCY ?? 'claudeclaw-hook-idempotency';

let _lambda: LambdaClient | null = null;
function lambda(): LambdaClient {
  if (!_lambda) _lambda = captureAwsClient(new LambdaClient({ region }));
  return _lambda;
}

type InvokeState = 'invoking' | 'enqueued' | 'released-on-failure';

async function getIdempotencyState(eventId: string): Promise<InvokeState | null> {
  const out = await ddb().send(
    new GetCommand({
      TableName: IDEMPOTENCY_TABLE,
      Key: { PK: `EVENT#${eventId}`, SK: 'STATE' },
    }),
  );
  return out.Item ? (out.Item as { state: InvokeState }).state : null;
}

async function setIdempotencyState(eventId: string, state: InvokeState): Promise<void> {
  await ddb().send(
    new PutCommand({
      TableName: IDEMPOTENCY_TABLE,
      Item: {
        PK: `EVENT#${eventId}`,
        SK: 'STATE',
        state,
        updatedAt: new Date().toISOString(),
        ttl: Math.floor(Date.now() / 1000) + 7 * 86400,
      },
    }),
  );
}

export interface DispatchPayload {
  event: string;
  agentId: string;
  chatId: string;
  turnSeq: number;
  data: Record<string, unknown>;
}

export async function dispatch(payload: DispatchPayload): Promise<{ dispatched: number; deduped: number }> {
  const disabled = await isKillSwitchActive('hooks_disabled').catch(() => ({ active: false }));
  if (disabled.active) return { dispatched: 0, deduped: 0 };

  const hooks = await listHooksForEvent(payload.event);
  let dispatched = 0;
  let deduped = 0;

  for (const hook of hooks) {
    const eventId = deriveEventId(hook.hookId, payload.agentId, payload.chatId, payload.turnSeq);

    const existingState = await getIdempotencyState(eventId);
    if (existingState === 'invoking' || existingState === 'enqueued') {
      deduped++;
      void writeAudit({
        action: 'hook_dispatch_deduped',
        agentId: payload.agentId,
        detail: { hookId: hook.hookId, eventId, existingState },
        result: 'ok',
      });
      continue;
    }

    await setIdempotencyState(eventId, 'invoking');

    try {
      await lambda().send(
        new InvokeCommand({
          FunctionName: hook.lambdaArn,
          InvocationType: 'Event',
          Payload: Buffer.from(JSON.stringify({ eventId, ...payload })),
        }),
      );
      await setIdempotencyState(eventId, 'enqueued');
      dispatched++;

      void writeAudit({
        action: 'hook_invoke_enqueued',
        agentId: payload.agentId,
        detail: { hookId: hook.hookId, eventId },
        result: 'ok',
      });
    } catch (err) {
      await setIdempotencyState(eventId, 'released-on-failure');
      logger.error({ hookId: hook.hookId, eventId, err: err instanceof Error ? err.message : String(err) }, 'hook invoke failed');

      void writeAudit({
        action: 'hook_invoke_failed_retryable',
        agentId: payload.agentId,
        detail: { hookId: hook.hookId, eventId, error: err instanceof Error ? err.message : String(err) },
        result: 'error',
      });
    }
  }

  return { dispatched, deduped };
}
