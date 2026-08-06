import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture pino calls without spinning up real logger transports.
const infoCalls: Array<unknown[]> = [];
vi.mock('./logger.js', () => ({
  logger: {
    info: (...args: unknown[]) => {
      infoCalls.push(args);
    },
  },
}));

import { emitToolMetric } from './emf.js';

describe('emitToolMetric', () => {
  beforeEach(() => {
    infoCalls.length = 0;
  });

  it('writes one EMF-shaped log line per call', () => {
    emitToolMetric({
      toolName: 'web_search',
      agentId: 'main',
      latencyMs: 1234,
      isError: false,
    });
    expect(infoCalls).toHaveLength(1);
    const [payload, message] = infoCalls[0]! as [Record<string, unknown>, string];
    expect(message).toBe('tool metric');
    expect(payload.ToolName).toBe('web_search');
    expect(payload.AgentId).toBe('main');
    expect(payload.ToolInvocation).toBe(1);
    expect(payload.ToolLatency).toBe(1234);
    expect(payload.ToolError).toBe(0);
  });

  it('rounds fractional latencies', () => {
    emitToolMetric({
      toolName: 'fast_tool',
      agentId: 'main',
      latencyMs: 12.7,
      isError: false,
    });
    expect((infoCalls[0]![0] as { ToolLatency: number }).ToolLatency).toBe(13);
  });

  it('marks errors with ToolError=1', () => {
    emitToolMetric({
      toolName: 'broken',
      agentId: 'main',
      latencyMs: 50,
      isError: true,
    });
    expect((infoCalls[0]![0] as { ToolError: number }).ToolError).toBe(1);
  });

  it('embeds the _aws block with the expected namespace + dimensions + metrics', () => {
    emitToolMetric({
      toolName: 't',
      agentId: 'a',
      latencyMs: 1,
      isError: false,
    });
    const aws = (infoCalls[0]![0] as Record<string, unknown>)._aws as {
      CloudWatchMetrics: Array<{
        Namespace: string;
        Dimensions: string[][];
        Metrics: Array<{ Name: string; Unit: string }>;
      }>;
    };
    expect(aws.CloudWatchMetrics).toHaveLength(1);
    expect(aws.CloudWatchMetrics[0]?.Namespace).toBe('ClaudeClaw');
    expect(aws.CloudWatchMetrics[0]?.Dimensions).toEqual([['ToolName', 'AgentId']]);
    const metricNames = aws.CloudWatchMetrics[0]?.Metrics.map((m) => m.Name);
    expect(metricNames).toEqual(
      expect.arrayContaining(['ToolInvocation', 'ToolLatency', 'ToolError']),
    );
  });
});
