/**
 * D2 · Embedded Metric Format (EMF) emitter.
 *
 * CloudWatch Logs auto-extracts metrics from log lines whose JSON
 * contains an `_aws.CloudWatchMetrics` block. We get per-tool
 * invocation counts + latency without paying for synchronous
 * PutMetricData calls.
 *
 * Namespace: `ClaudeClaw`
 * Dimensions: ToolName, AgentId
 * Metrics:
 *   ToolInvocation (Count)        — emitted once per invocation
 *   ToolLatency    (Milliseconds) — wall-clock time of handler.invoke
 *   ToolError      (Count)        — 1 when result.isError or handler threw
 *
 * Reference: https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch_Embedded_Metric_Format_Specification.html
 */

import { logger } from './logger.js';

export interface ToolMetricEvent {
  toolName: string;
  agentId: string;
  latencyMs: number;
  isError: boolean;
}

export function emitToolMetric(m: ToolMetricEvent): void {
  logger.info(
    {
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: 'ClaudeClaw',
            Dimensions: [['ToolName', 'AgentId']],
            Metrics: [
              { Name: 'ToolInvocation', Unit: 'Count' },
              { Name: 'ToolLatency', Unit: 'Milliseconds' },
              { Name: 'ToolError', Unit: 'Count' },
            ],
          },
        ],
      },
      ToolName: m.toolName,
      AgentId: m.agentId,
      ToolInvocation: 1,
      ToolLatency: Math.round(m.latencyMs),
      ToolError: m.isError ? 1 : 0,
    },
    'tool metric',
  );
}
