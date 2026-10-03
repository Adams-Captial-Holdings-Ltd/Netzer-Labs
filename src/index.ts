/**
 * Orchestrator entry point.
 *
 * Boot sequence (session 1 scope):
 *   1. Load and validate env via zod
 *   2. Initialize logger
 *   3. Build Hono app
 *   4. Start HTTP server on PORT
 *   5. Wire SIGTERM/SIGINT for graceful shutdown
 *
 * Future sessions add: Secrets Manager fetch, DDB client init, Bedrock
 * client init, S3 config cache warm, SQS invalidation poller, agent
 * picker, Bedrock loop. The boot path stays linear; each new subsystem
 * gets its own initializer called from here.
 */

import { serve } from '@hono/node-server';
import { buildApp, buildPrivateDispatchApp } from './server.js';
import { loadEnv } from './config/env.js';
import { logger } from './observability/logger.js';
import { startScheduler, stopScheduler } from './agent/scheduler.js';
import { startQueueDrain, stopQueueDrain } from './lib/scheduler/queue-drain.js';
import { runScheduleBackfill } from './lib/scheduler/backfill.js';
import { isEbSchedulerEnabled } from './lib/scheduler/eb-scheduler.js';
import { startCanary, stopCanary } from './agent/canary.js';
import { startWebhookMonitor, stopWebhookMonitor } from './agent/webhook-monitor.js';
import { startCostWatch, stopCostWatch } from './workers/cost-watch.js';
import { startDriftWatch, stopDriftWatch } from './workers/drift-watch.js';
import {
  startPaperclipReconciler,
  stopPaperclipReconciler,
} from './lib/paperclip/reconciler.js';
import { startPendingDispatchSweep, stopPendingDispatchSweep } from './lib/paperclip/pending-dispatch-sweep.js';
import { beginDispatchDrain, dispatchesIdle, dispatchesInFlight } from './lib/paperclip/dispatch-drain.js';
import {
  startInvalidationListener,
  stopInvalidationListener,
} from './lib/config/invalidation-listener.js';
import { initXray } from './lib/observability/xray.js';
import { bootPaperclipLock } from './lib/paperclip/lock-boot.js';
import { attachJarvisWebSocket } from './adapters/dashboard/jarvis.js';
import { teardownAllJarvisSessions } from './lib/voice/session-registry.js';
import type { Server as HttpServer } from 'node:http';

// Sanity check: the build target uses NodeNext, every relative import in src/
// must end with `.js`. CI catches missing extensions via `npx tsc --noEmit`.

async function main(): Promise<void> {
  const env = loadEnv();
  // Init X-Ray before any AWS SDK client is created; the SDK wrappers
  // are no-ops when CCE_XRAY_ENABLED is unset.
  initXray();
  // CCE_PAPERCLIP_ENABLED switches Paperclip routing; it does not arm agents.
  // Off closes the Paperclip surface (unknown:paperclip_routing_off): the client,
  // reconciler and private dispatch route refuse; no live read runs and startup
  // is never blocked. On, the live lock check runs at start and every 60 s.
  const lock = await bootPaperclipLock();
  logger.info(
    {
      region: env.AWS_REGION,
      port: env.PORT,
      logLevel: env.LOG_LEVEL,
    },
    'starting orchestrator',
  );

  const app = buildApp(env);
  const dispatchPort = env.PAPERCLIP_DISPATCH_PORT ?? 3001;
  if (dispatchPort === env.PORT) {
    throw new Error(`PAPERCLIP_DISPATCH_PORT ${dispatchPort} must differ from PORT ${env.PORT}`);
  }
  const server = serve({
    fetch: app.fetch,
    port: env.PORT,
    hostname: '0.0.0.0',
  });
  logger.info({ port: env.PORT }, 'listening');
  const privateServer = serve({ fetch: buildPrivateDispatchApp().fetch, port: dispatchPort, hostname: '0.0.0.0' });
  logger.info({ port: dispatchPort }, 'private dispatch listener up');

  // Jarvis voice relay: intercept the WS upgrade on the raw http.Server. The
  // upgrade event fires before Hono's fetch handler, so the two coexist.
  attachJarvisWebSocket(server as unknown as HttpServer);

  // A1: scheduler backend selection.
  //   default              → EventBridge Scheduler + SQS queue drain
  //   CCE_USE_IN_PROCESS_SCHEDULER=1 → legacy in-process DDB-poll tick
  // The two modes are mutually exclusive. Flipping the env var is the
  // one-config rollback when something goes sideways with EB Scheduler.
  if (isEbSchedulerEnabled()) {
    startQueueDrain();
    // Idempotent boot-time backfill: every active scheduled_tasks row
    // gets a paired EB schedule. Fire-and-forget so a slow DDB scan
    // can't block /health from coming up.
    void runScheduleBackfill().catch((err) => {
      logger.warn(
        { errMessage: err instanceof Error ? err.message : String(err) },
        'scheduler backfill threw',
      );
    });
  } else {
    startScheduler();
  }
  // Synthetic canary fires /api/test-turn against ourselves every 5 min
  // when CCE_CANARY_ENABLED=1. Records canary_fired audit row.
  startCanary();
  startWebhookMonitor();
  // Paperclip durability sweep (ADR 0010 DL-3). Inert until runtime-config
  // paperclip/reconciler_mode leaves 'off' and a base URL is configured, and it
  // refuses to sweep unless the A1-8 boot probe proves the running Paperclip
  // image honors native updatedSince.
  startPaperclipReconciler();
  startPendingDispatchSweep();
  // Daily cost evaluator. No-ops until runtime-config cost/watch_enabled='true',
  // so this is inert until explicitly turned on.
  startCostWatch();
  // Daily CDK drift detector. No-ops until runtime-config drift/watch_enabled='true'.
  startDriftWatch();

  // Config-invalidation SNS fanout: subscribe an ephemeral SQS queue to the
  // config topic so this task invalidates its caches within seconds of a
  // peer's write instead of waiting out the 30s in-process poll. Purely an
  // accelerator and fully fail-safe: any failure to provision the queue or
  // subscription is swallowed here so it can never block boot, and the 30s
  // cache poll still keeps every config read correct. serve() is already
  // listening above, so a slow or failed start never delays /health.
  void startInvalidationListener().catch((err) => {
    logger.warn(
      { errMessage: err instanceof Error ? err.message : String(err) },
      'config-invalidation listener start threw, falling back to 30s cache poll',
    );
  });

  // Graceful shutdown
  const shutdown = async (signal: string): Promise<void> => {
    beginDispatchDrain();
    logger.info({ signal }, 'shutdown requested, draining');
    // Hard backstop first so nothing below can prevent exit. Fargate gives 30s
    // between SIGTERM and SIGKILL by default.
    setTimeout(() => {
      if (dispatchesInFlight() > 0) logger.error({ inFlight: dispatchesInFlight() }, 'dispatches still in flight at shutdown backstop');
      logger.warn('graceful drain timed out, forcing exit');
      process.exit(1);
    }, 28_000).unref();
    stopScheduler();
    stopQueueDrain();
    stopCanary();
    stopCostWatch();
    stopDriftWatch();
    stopWebhookMonitor();
    stopPaperclipReconciler();
    stopPendingDispatchSweep();
    lock.stop();
    // Close any live Jarvis voice sessions cleanly before the socket closes.
    await teardownAllJarvisSessions('shutdown').catch(() => {});
    // Await the listener teardown (unsubscribe + delete the ephemeral queue) so
    // those two AWS round-trips are not abandoned on the next-tick process.exit
    // below, which would leak a queue + subscription on every clean shutdown.
    // Bounded so a slow teardown cannot hold the drain open.
    await Promise.race([
      stopInvalidationListener(),
      new Promise<void>((resolve) => setTimeout(resolve, 5_000).unref()),
    ]).catch(() => {});
    await dispatchesIdle();
    await Promise.all([
      new Promise<Error | undefined>((resolve) => privateServer.close(resolve)),
      new Promise<Error | undefined>((resolve) => server.close(resolve)),
    ]).then((errors) => {
      const err = errors.find(Boolean);
      if (err) {
        logger.error({ err: err.message }, 'shutdown error');
        process.exit(1);
      }
      logger.info('shutdown complete');
      process.exit(0);
    });
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  process.on('uncaughtException', (err) => {
    logger.fatal({ err: err.message, stack: err.stack }, 'uncaught exception');
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ reason: String(reason) }, 'unhandled promise rejection');
    process.exit(1);
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('fatal during boot:', err);
  process.exit(1);
});
