/**
 * Config-invalidation listener (SNS -> ephemeral SQS fanout consumer).
 *
 * The mirror image of invalidation-publisher.ts. When a peer task writes a
 * config change it publishes a tiny invalidation message on the shared
 * config-invalidation SNS topic. This listener gives THIS task an ephemeral,
 * per-process SQS queue subscribed to that topic so it invalidates its own
 * config caches within seconds of a peer's write instead of waiting out the
 * 30s in-process cache TTL.
 *
 * This is purely additive and fail-safe. The 30s cache poll in each repo
 * remains the correctness fallback; this only makes invalidation FASTER:
 *
 *   - start() runs inside its own try/catch and NEVER throws. If queue
 *     creation, the queue policy, or the subscription fails it logs a warning
 *     and returns. Boot proceeds and the 30s poll still covers correctness.
 *   - A missing CCE_CONFIG_TOPIC_ARN is a quiet no-op (local dev, or any
 *     deploy without the topic wired).
 *   - The poll loop swallows per-iteration errors and keeps going. It stops
 *     cleanly when stop() flips the abort flag (wired to SIGTERM in index.ts).
 *   - On stop the task unsubscribes and deletes its own ephemeral queue so we
 *     do not leak per-task queues across deploys.
 *
 * Message contract (must match invalidation-publisher.ts):
 *   { "kind": "kill_switch" | "runtime_config" | "rate_limit" | "all",
 *     "key"?: string,
 *     "origin": "<per-process-id>" }
 *
 * Messages whose `origin` equals this process's ORIGIN_ID are skipped: this
 * task already invalidated locally when it performed the write that published
 * them. "all" clears every config cache (the panic path).
 *
 * The ephemeral queue MUST be named with the `claudeclaw-config-sub-` prefix.
 * The task role's IAM grants (sqs:CreateQueue QueueName condition, lifecycle
 * actions scoped to claudeclaw-config-sub-*) only permit that prefix; any
 * other name is denied.
 */

import { randomUUID } from 'node:crypto';
import {
  SQSClient,
  CreateQueueCommand,
  GetQueueAttributesCommand,
  SetQueueAttributesCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
} from '@aws-sdk/client-sqs';
import { SNSClient, SubscribeCommand, UnsubscribeCommand } from '@aws-sdk/client-sns';
import { logger } from '../../observability/logger.js';
import { captureAwsClient } from '../observability/xray.js';
import {
  ORIGIN_ID,
  type InvalidationMessage,
  type InvalidationKind,
} from './invalidation-publisher.js';
import {
  invalidateKillSwitchCache,
  isKillSwitchActive,
  type KillSwitchName,
} from '../state/kill-switches-repo.js';
import { invalidateRuntimeConfigCache } from '../state/runtime-config-repo.js';
import { invalidateRateLimitCache } from '../state/rate-limits-repo.js';
import { invalidateAgentCache } from './agent-loader.js';
import {
  teardownAllJarvisSessions,
  teardownSessionsForToken,
  JARVIS_TEARDOWN_SWITCHES,
} from '../voice/session-registry.js';
import { invalidateCanaryCache } from '../jarvis/jarvis-flags.js';

const REGION = process.env.AWS_REGION ?? 'us-east-1';

/** Required name prefix for the ephemeral subscriber queue (IAM-scoped). */
const QUEUE_NAME_PREFIX = 'claudeclaw-config-sub-';

/**
 * Long-poll wait. SQS caps WaitTimeSeconds at 20s; the loop chains another
 * receive on completion so an idle task burns no CPU between polls.
 */
const WAIT_TIME_SECONDS = 20;

/**
 * Short message retention. Invalidation messages are only useful for a few
 * seconds; anything older than this is moot because the 30s poll has already
 * caught up. 60s keeps the queue from accreting stale messages if a task
 * pauses (e.g. a long GC) mid-poll.
 */
const MESSAGE_RETENTION_SECONDS = '60';

let _sqs: SQSClient | null = null;
function sqs(): SQSClient {
  if (!_sqs) _sqs = captureAwsClient(new SQSClient({ region: REGION }));
  return _sqs;
}

let _sns: SNSClient | null = null;
function sns(): SNSClient {
  if (!_sns) _sns = captureAwsClient(new SNSClient({ region: REGION }));
  return _sns;
}

/** Test seam. */
export function __setClients(sqsClient: SQSClient | null, snsClient: SNSClient | null): void {
  _sqs = sqsClient;
  _sns = snsClient;
}

function topicArn(): string | undefined {
  const arn = process.env.CCE_CONFIG_TOPIC_ARN;
  return arn && arn.length > 0 ? arn : undefined;
}

/**
 * This process's stable origin id. Reuses the publisher's ORIGIN_ID so a write
 * this task performs (which publishes with that origin) is skipped by this same
 * task's listener instead of pointlessly re-invalidating its already-cleared
 * cache.
 */
export function getListenerOrigin(): string {
  return ORIGIN_ID;
}

let stopped = false;
let loopTimer: NodeJS.Timeout | null = null;
let queueUrl: string | undefined;
let subscriptionArn: string | undefined;

/**
 * Apply one invalidation message to the matching local cache. "all" clears
 * every config cache for the panic path.
 */

/**
 * On a kill-switch invalidation for a Jarvis-relevant switch, read the FRESH
 * value (the cache was just busted above) and tear down live sessions ONLY when
 * the switch is now active — so clearing a switch never drops a healthy session.
 */
function maybeTeardownForSwitch(name: KillSwitchName): void {
  const reason = JARVIS_TEARDOWN_SWITCHES[name];
  if (!reason) return;
  void (async () => {
    try {
      if ((await isKillSwitchActive(name)).active) {
        await teardownAllJarvisSessions(reason);
      }
    } catch (err) {
      logger.warn(
        { switch: name, err: err instanceof Error ? err.message : String(err) },
        'jarvis switch teardown failed',
      );
    }
  })();
}

function applyInvalidation(kind: InvalidationKind, key?: string): void {
  switch (kind) {
    case 'kill_switch':
      // kill switch names are a fixed enum; pass through untyped narrowing is
      // handled inside the repo (a bad key just no-ops on the cache).
      invalidateKillSwitchCache(key as never);
      if (key) maybeTeardownForSwitch(key as KillSwitchName);
      break;
    case 'runtime_config':
      // Peers publish runtime_config without a narrowing key today, so clear
      // the whole runtime-config cache. A future keyed publish still lands on
      // the safe full-clear path. The daily cost cap lives here too, so this
      // covers a cost-cap write.
      invalidateRuntimeConfigCache();
      break;
    case 'rate_limit':
      invalidateRateLimitCache(key);
      break;
    case 'agent':
      // A peer changed an agent's model / knowledgeScope (the fields loadAgent
      // reads). Drop just that agent's cached config; refresh:false because the
      // known-agents list itself didn't change, so we skip the full-table scan.
      // A keyless 'agent' (shouldn't happen) clears every agent's cached config.
      invalidateAgentCache(key, { refresh: false });
      break;
    case 'all':
      invalidateKillSwitchCache();
      invalidateRuntimeConfigCache();
      invalidateRateLimitCache();
      // refresh:false so a panic burst does not trigger one full-table agents
      // DDB scan per receiving task; the known-agents list lazily repopulates.
      invalidateAgentCache(undefined, { refresh: false });
      // H14: panic emits a single `all` (not per-switch). Tear down every live
      // Jarvis session immediately — an observer wired only to `kill_switch`
      // would never fire on panic.
      void teardownAllJarvisSessions('panic');
      invalidateCanaryCache();
      break;
    case 'token_revoked':
      // H4: drop every live voice session for the revoked tokenHash.
      if (key) void teardownSessionsForToken(key, 'token_revoked');
      break;
    case 'canary':
      // The canary allowlist changed — bust the membership cache (Ref. D).
      invalidateCanaryCache(key);
      break;
    default: {
      // Exhaustiveness guard. An unknown kind is ignored, never thrown.
      const _exhaustive: never = kind;
      void _exhaustive;
    }
  }
}

/** The closed set of kinds a real publisher emits. */
const VALID_KINDS: ReadonlySet<string> = new Set<InvalidationKind>([
  'kill_switch',
  'runtime_config',
  'rate_limit',
  'all',
  'agent',
  'token_revoked',
  'canary',
]);

function parseMessage(body: string | undefined): InvalidationMessage | null {
  if (!body) return null;
  try {
    const j = JSON.parse(body) as Partial<InvalidationMessage>;
    if (typeof j.kind !== 'string' || typeof j.origin !== 'string') return null;
    // Membership check before the cast: a typo'd or foreign kind (e.g. an S3
    // EventBridge body that shares this topic) is dropped here rather than
    // silently no-opping past the exhaustiveness guard as if it succeeded.
    if (!VALID_KINDS.has(j.kind)) return null;
    const msg: InvalidationMessage = { kind: j.kind as InvalidationKind, origin: j.origin };
    if (typeof j.key === 'string') msg.key = j.key;
    return msg;
  } catch {
    return null;
  }
}

/**
 * Receive up to a small batch of messages, apply each, and delete it. One
 * iteration of the poll loop. Swallows its own errors so a transient SQS blip
 * never breaks the loop; the next iteration just tries again.
 */
async function pollOnce(): Promise<void> {
  const url = queueUrl;
  if (!url) return;
  let messages;
  try {
    const resp = await sqs().send(
      new ReceiveMessageCommand({
        QueueUrl: url,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: WAIT_TIME_SECONDS,
        VisibilityTimeout: 30,
      }),
    );
    messages = resp.Messages ?? [];
  } catch (err) {
    logger.warn(
      { errMessage: err instanceof Error ? err.message : String(err) },
      'config-invalidation receive failed, peers fall back to 30s cache poll',
    );
    return;
  }
  for (const msg of messages) {
    const parsed = parseMessage(msg.Body);
    if (parsed && parsed.origin !== getListenerOrigin()) {
      try {
        applyInvalidation(parsed.kind, parsed.key);
        logger.debug(
          { kind: parsed.kind, key: parsed.key, origin: parsed.origin },
          'config-invalidation applied from peer',
        );
      } catch (err) {
        logger.warn(
          { errMessage: err instanceof Error ? err.message : String(err) },
          'config-invalidation apply threw',
        );
      }
    }
    // Always delete: a self-origin message, a malformed body, or a handled
    // message all have nothing left to do. The 30s poll is the safety net if
    // a delete fails (the message just redelivers and we skip/apply again).
    if (msg.ReceiptHandle) {
      await sqs()
        .send(new DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: msg.ReceiptHandle }))
        .catch((err) => {
          logger.warn(
            { errMessage: err instanceof Error ? err.message : String(err) },
            'config-invalidation delete failed',
          );
        });
    }
  }
}

/**
 * Build the SQS queue policy that lets the config-invalidation SNS topic
 * deliver to this ephemeral queue. SNS (not this task) is the message sender,
 * so the queue itself must grant sqs:SendMessage to the SNS service principal,
 * scoped by aws:SourceArn to the one topic.
 */
function queuePolicy(qArn: string, tArn: string): string {
  return JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'AllowConfigTopicSendMessage',
        Effect: 'Allow',
        Principal: { Service: 'sns.amazonaws.com' },
        Action: 'sqs:SendMessage',
        Resource: qArn,
        Condition: { ArnEquals: { 'aws:SourceArn': tArn } },
      },
    ],
  });
}

/**
 * Provision the ephemeral queue, attach the topic-send policy, and subscribe it
 * to the config-invalidation topic with raw message delivery. Returns false (a
 * no-op start) when no topic ARN is configured.
 *
 * NEVER throws: any failure is logged at warn and turned into a false return so
 * start() can fall back to the 30s cache poll.
 */
async function provision(): Promise<boolean> {
  const tArn = topicArn();
  if (!tArn) {
    logger.info({}, 'config-invalidation listener disabled: CCE_CONFIG_TOPIC_ARN unset');
    return false;
  }

  const name = `${QUEUE_NAME_PREFIX}${randomUUID().slice(0, 8)}`;
  const created = await sqs().send(
    new CreateQueueCommand({
      QueueName: name,
      Attributes: { MessageRetentionPeriod: MESSAGE_RETENTION_SECONDS },
    }),
  );
  queueUrl = created.QueueUrl;
  if (!queueUrl) {
    logger.warn({ name }, 'config-invalidation create-queue returned no URL');
    return false;
  }

  const attrs = await sqs().send(
    new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ['QueueArn'] }),
  );
  const qArn = attrs.Attributes?.QueueArn;
  if (!qArn) {
    logger.warn({ queueUrl }, 'config-invalidation queue has no ARN; cannot subscribe');
    return false;
  }

  await sqs().send(
    new SetQueueAttributesCommand({
      QueueUrl: queueUrl,
      Attributes: { Policy: queuePolicy(qArn, tArn) },
    }),
  );

  const sub = await sns().send(
    new SubscribeCommand({
      TopicArn: tArn,
      Protocol: 'sqs',
      Endpoint: qArn,
      Attributes: { RawMessageDelivery: 'true' },
      ReturnSubscriptionArn: true,
    }),
  );
  subscriptionArn = sub.SubscriptionArn;
  logger.info(
    { queueName: name, subscriptionArn },
    'config-invalidation listener subscribed to topic',
  );
  return true;
}

/**
 * Start the listener. Fail-safe by contract: any error during provisioning is
 * caught and logged, and the function returns without starting the loop, so the
 * caller's boot proceeds and correctness still rides on the 30s cache poll.
 */
export async function startInvalidationListener(): Promise<void> {
  if (loopTimer || queueUrl) return; // already started
  stopped = false;
  let ready = false;
  try {
    ready = await provision();
  } catch (err) {
    logger.warn(
      { errMessage: err instanceof Error ? err.message : String(err) },
      'config-invalidation listener start failed, falling back to 30s cache poll',
    );
    // Best-effort cleanup of a half-provisioned queue, then give up quietly.
    await teardown().catch(() => {});
    return;
  }
  if (!ready || stopped) {
    // Tear down on ANY non-ready outcome, not only when stop() fired: provision()
    // can return false AFTER CreateQueue succeeded (e.g. GetQueueAttributes
    // returns no ARN), which would otherwise orphan the just-created queue.
    // teardown() is a no-op when nothing was created.
    await teardown().catch(() => {});
    return;
  }
  const loop = async (): Promise<void> => {
    if (stopped) return;
    try {
      await pollOnce();
    } catch (err) {
      logger.warn(
        { errMessage: err instanceof Error ? err.message : String(err) },
        'config-invalidation poll iteration threw',
      );
    }
    if (!stopped) {
      // ReceiveMessage already long-polls for WAIT_TIME_SECONDS, so chain the
      // next poll immediately on completion. unref so it never holds the
      // process open on shutdown.
      loopTimer = setTimeout(() => void loop(), 0);
      loopTimer.unref();
    }
  };
  loopTimer = setTimeout(() => void loop(), 0);
  loopTimer.unref();
}

/** Unsubscribe and delete this task's ephemeral queue. Best-effort, never throws. */
async function teardown(): Promise<void> {
  if (subscriptionArn) {
    try {
      await sns().send(new UnsubscribeCommand({ SubscriptionArn: subscriptionArn }));
      // Only drop the handle once the unsubscribe is confirmed. If it failed we
      // keep subscriptionArn so a later teardown attempt can retry rather than
      // orphaning a subscription that points at a soon-to-be-deleted queue.
      subscriptionArn = undefined;
    } catch (err) {
      logger.warn(
        { errMessage: err instanceof Error ? err.message : String(err) },
        'config-invalidation unsubscribe failed; keeping handle for retry',
      );
    }
  }
  if (queueUrl) {
    const url = queueUrl;
    await sqs()
      .send(new DeleteQueueCommand({ QueueUrl: url }))
      .catch((err) => {
        logger.warn(
          { errMessage: err instanceof Error ? err.message : String(err) },
          'config-invalidation delete-queue failed',
        );
      });
    queueUrl = undefined;
  }
}

/**
 * Stop the listener: break the poll loop, then unsubscribe and delete the
 * ephemeral queue. Returns the teardown promise so the shutdown path can AWAIT
 * it before the process exits, otherwise the two teardown round-trips are
 * abandoned on the next-tick process.exit and the queue + subscription leak on
 * every clean shutdown. Wired to SIGTERM/SIGINT. Never throws.
 */
export function stopInvalidationListener(): Promise<void> {
  stopped = true;
  if (loopTimer) {
    clearTimeout(loopTimer);
    loopTimer = null;
  }
  return teardown().catch(() => {});
}
