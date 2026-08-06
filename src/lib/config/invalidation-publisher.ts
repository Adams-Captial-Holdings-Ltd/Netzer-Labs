/**
 * Config-invalidation publisher (SNS fanout).
 *
 * When a task writes a config change (a kill switch, a runtime-config key, the
 * daily cost cap, a rate-limit policy), it already deletes its OWN local cache
 * so the writer sees the change immediately. Peer tasks would otherwise wait up
 * to the 30s in-process cache TTL to notice. This publisher fans a tiny
 * invalidation message out on the existing config-invalidation SNS topic so
 * those peers invalidate their caches within seconds instead.
 *
 * This is purely additive and fail-safe. The 30s cache poll remains the
 * correctness fallback; this only makes peers FASTER. Every publish is
 * best-effort: a missing topic ARN is a quiet no-op, and any SNS error is
 * logged at warn and swallowed so a write never fails or stalls on it.
 *
 * Message contract (publisher and the SQS listener must agree, tiny JSON):
 *   { "kind": "kill_switch" | "runtime_config" | "rate_limit" | "agent" | "all",
 *     "key"?: string,
 *     "origin": "<per-process-id>" }
 *
 * The listener ignores any message whose `origin` equals its own process id
 * (it already invalidated locally on write). "all" clears every config cache
 * and is used by the panic path. "agent" busts the agent-loader config cache for
 * one agent (key = agentId) so a dashboard or /model model change lands on every
 * task in seconds instead of waiting out that loader's 5-minute TTL.
 */

import { randomUUID } from 'node:crypto';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import { logger } from '../../observability/logger.js';
import { captureAwsClient } from '../observability/xray.js';

const REGION = process.env.AWS_REGION ?? 'us-east-1';

/**
 * Stable per-process origin id, generated ONCE at module load. The listener
 * compares incoming `origin` against this to skip messages this process sent
 * (so a writer never re-invalidates its own already-cleared cache).
 */
export const ORIGIN_ID: string = randomUUID();

/**
 * Kinds of config cache a write can invalidate. "all" clears everything.
 * Only kinds an actual writer publishes are listed: the daily cost cap rides
 * the 'runtime_config' clear (it lives in the runtime-config table).
 */
export type InvalidationKind =
  | 'kill_switch'
  | 'runtime_config'
  | 'rate_limit'
  | 'all'
  // A per-agent config change (model, knowledgeScope) the runtime reads through
  // loadAgent. key = agentId; peers bust just that agent's loader-cache entry so
  // the change propagates fleet-wide in seconds, not the loader's 5-minute TTL.
  | 'agent'
  // Jarvis H4: a revoked token's live voice sessions are torn down by tokenHash.
  | 'token_revoked'
  // Jarvis: the canary allowlist changed — peers bust their membership cache.
  | 'canary';

export interface InvalidationMessage {
  kind: InvalidationKind;
  key?: string;
  origin: string;
}

let _sns: SNSClient | null = null;
function sns(): SNSClient {
  // captureAwsClient so the SNS Publish leg shows up as an X-Ray subsegment at
  // Tier 2+ (no-op when X-Ray is off), matching the listener's wrapped clients.
  if (!_sns) _sns = captureAwsClient(new SNSClient({ region: REGION }));
  return _sns;
}

function topicArn(): string | undefined {
  const arn = process.env.CCE_CONFIG_TOPIC_ARN;
  return arn && arn.length > 0 ? arn : undefined;
}

/**
 * Publish a config-invalidation message to the config-invalidation SNS topic
 * so peer tasks invalidate the matching cache fast. Best-effort by design:
 *
 *   - No-op (quietly) when CCE_CONFIG_TOPIC_ARN is unset, so local dev and any
 *     deploy without the topic wired keep working on the 30s cache poll alone.
 *   - Never throws. A publish error is logged at warn and swallowed so the
 *     caller's DDB write is never failed or delayed by SNS.
 *
 * @param kind which config cache peers should invalidate.
 * @param key  optional narrowing key (switch name, config key, policy scope).
 */
export async function publishInvalidation(
  kind: InvalidationKind,
  key?: string,
): Promise<void> {
  const arn = topicArn();
  if (!arn) return;
  const message: InvalidationMessage = { kind, origin: ORIGIN_ID };
  if (key !== undefined) message.key = key;
  try {
    await sns().send(
      new PublishCommand({
        TopicArn: arn,
        Message: JSON.stringify(message),
      }),
    );
  } catch (err) {
    logger.warn(
      { kind, key, err: err instanceof Error ? err.message : String(err) },
      'config-invalidation publish failed; peers fall back to 30s cache poll',
    );
  }
}
