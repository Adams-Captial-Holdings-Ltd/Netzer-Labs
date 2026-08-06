/**
 * EMF metrics for Jarvis (JARVIS-PLAN.md §7). CloudWatch Logs auto-extracts
 * metrics from the `_aws.CloudWatchMetrics` block; namespace `ClaudeClaw`,
 * mirroring src/observability/emf.ts. Phase 0 uses the handshake-rejection,
 * tool-call-latency, and query metrics; the voice/session metrics land in
 * Phase 1.
 */

import { logger } from './logger.js';

export type JarvisMetricName =
  | 'JarvisSessionOpen'
  | 'JarvisSessionClose'
  | 'JarvisSessionDurationMs'
  | 'JarvisHandshakeRejection'
  | 'JarvisNovaSonicStreamError'
  | 'JarvisTtsError'
  | 'JarvisToolCallLatencyMs'
  | 'JarvisQuery'
  | 'JarvisQueryBlocked'
  | 'JarvisVoiceInputSeconds'
  | 'JarvisVoiceOutputSeconds'
  | 'JarvisVoiceSpendUsd';

const UNIT: Partial<Record<JarvisMetricName, string>> = {
  JarvisSessionDurationMs: 'Milliseconds',
  JarvisToolCallLatencyMs: 'Milliseconds',
  JarvisVoiceInputSeconds: 'Seconds',
  JarvisVoiceOutputSeconds: 'Seconds',
  JarvisVoiceSpendUsd: 'None',
};

export interface JarvisMetricOptions {
  /** Optional dimension values (e.g. RejectionReason, ToolName). */
  dimensions?: Record<string, string>;
}

/**
 * Emit one Jarvis metric. `value` defaults to 1 (a Count). Dimensions are
 * attached as both EMF dimension keys and top-level fields.
 */
export function emitJarvisMetric(
  name: JarvisMetricName,
  value = 1,
  opts: JarvisMetricOptions = {},
): void {
  const dims = opts.dimensions ?? {};
  const dimKeys = Object.keys(dims);
  logger.info(
    {
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: 'ClaudeClaw',
            Dimensions: dimKeys.length > 0 ? [dimKeys] : [[]],
            Metrics: [{ Name: name, Unit: UNIT[name] ?? 'Count' }],
          },
        ],
      },
      ...dims,
      [name]: value,
    },
    'jarvis metric',
  );
}
