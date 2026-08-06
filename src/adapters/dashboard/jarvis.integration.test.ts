/**
 * Integration test: Jarvis Phase 0 against LocalStack.
 *
 * Verifies the REAL DDB paths that the unit/flow tests stub:
 *   1. a navigate turn dual-writes a `jarvis_navigate` audit row to DynamoDB
 *      tagged detail.origin:'jarvis' (Bedrock is mocked; the audit write is real);
 *   2. the query executor reads a real repo (cost_today) through the
 *      authorizeRead guard and returns DDB-backed data.
 *
 * Bedrock and the admission gate are mocked (the gate's own DDB reads —
 * panic/kill tables — are covered by jarvis-flags.test.ts); everything else
 * runs against LocalStack so the audit + repo wiring is exercised end-to-end.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import {
  ensureLocalStack,
  configureLocalAwsEnv,
  createDdbTable,
} from '../../__test-utils__/localstack.js';

const AUDIT_TABLE = 'claudeclaw-integ-jarvis-audit';
const USAGE_TABLE = 'claudeclaw-integ-jarvis-usage';

const { send, isJarvisEnabled } = vi.hoisted(() => ({
  send: vi.fn(),
  isJarvisEnabled: vi.fn(async () => true),
}));

vi.mock('../../lib/bedrock/client.js', () => ({ bedrockClient: () => ({ send }) }));
vi.mock('../../lib/jarvis/jarvis-flags.js', () => ({
  isJarvisEnabled,
  isJarvisLaunchEnabled: () => true,
}));
vi.mock('../../lib/auth/dashboard-auth.js', () => ({
  authenticateDashboardToken: vi.fn(async () => ({
    tokenHash: 'h',
    label: 'Root token',
    hashPrefix16: 'h',
    role: 'admin' as const,
  })),
  extractBearerToken: (h?: string) => (h ? h.replace(/^Bearer\s+/i, '') : ''),
}));

beforeAll(async () => {
  configureLocalAwsEnv();
  process.env.TABLE_AUDIT_LOG = AUDIT_TABLE;
  process.env.TABLE_TOKEN_USAGE = USAGE_TABLE;
  process.env.BEDROCK_DEFAULT_MODEL = 'us.anthropic.claude-sonnet-4-6-v1:0';
  await ensureLocalStack();
  await createDdbTable({
    name: AUDIT_TABLE,
    partitionKey: { name: 'PK', type: 'S' },
    sortKey: { name: 'SK', type: 'S' },
  });
  await createDdbTable({
    name: USAGE_TABLE,
    partitionKey: { name: 'PK', type: 'S' },
    sortKey: { name: 'SK', type: 'S' },
  });
});

// Mock ConverseStream response ({ stream }) from a Converse-style content array.
type Block = { text: string } | { toolUse: { toolUseId: string; name: string; input?: unknown } };
function streamOf(content: Block[], stopReason: string) {
  async function* gen() {
    for (let i = 0; i < content.length; i++) {
      const b = content[i];
      if ('toolUse' in b) {
        yield { contentBlockStart: { contentBlockIndex: i, start: { toolUse: { toolUseId: b.toolUse.toolUseId, name: b.toolUse.name } } } };
        yield { contentBlockDelta: { contentBlockIndex: i, delta: { toolUse: { input: JSON.stringify(b.toolUse.input ?? {}) } } } };
        yield { contentBlockStop: { contentBlockIndex: i } };
      } else {
        yield { contentBlockDelta: { contentBlockIndex: i, delta: { text: b.text } } };
        yield { contentBlockStop: { contentBlockIndex: i } };
      }
    }
    yield { messageStop: { stopReason } };
    yield { metadata: { usage: { inputTokens: 10, outputTokens: 5 } } };
  }
  return { stream: gen() };
}

function textTurn(text: string): Request {
  return new Request('http://local/text-turn', {
    method: 'POST',
    headers: { authorization: 'Bearer test', 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  });
}

describe('Jarvis Phase 0 (LocalStack)', () => {
  it('writes a real jarvis_navigate audit row tagged origin:jarvis', async () => {
    send
      .mockResolvedValueOnce(streamOf([{ toolUse: { toolUseId: 't1', name: 'navigate', input: { route: '/agents' } } }], 'tool_use'))
      .mockResolvedValueOnce(streamOf([{ text: 'Showing agents.' }], 'end_turn'));

    const { buildJarvisRouter } = await import('./jarvis.js');
    const res = await buildJarvisRouter().request(textTurn('go to agents'));
    expect(res.status).toBe(200);
    await res.text(); // drain the SSE stream so the fire-and-forget audit writes settle
    await new Promise((r) => setTimeout(r, 250));

    const { ddb } = await import('../../lib/state/ddb.js');
    const out = await ddb().send(new ScanCommand({ TableName: AUDIT_TABLE }));
    const rows = (out.Items ?? []) as Array<{ action?: string; detail?: Record<string, unknown> }>;
    const nav = rows.filter((r) => r.action === 'jarvis_navigate');
    expect(nav.length).toBeGreaterThanOrEqual(1);
    expect(nav[0].detail?.origin).toBe('jarvis');
    expect(nav[0].detail?.route).toBe('/agents');
  });

  it('runs a real query through authorizeRead (cost_today → DDB-backed)', async () => {
    const { executeQueryTool } = await import('./jarvis.js');
    const principal = { tokenHash: 'h', label: 'Root token', hashPrefix16: 'h', role: 'admin' as const };
    const r = await executeQueryTool(principal, 'cost_today', {});
    expect(r.ok).toBe(true);
    if (r.ok) expect(typeof (r.result as { costUsd: number }).costUsd).toBe('number');
  });

  it('blocks a viewer from the operator-only audit resource against real infra', async () => {
    const { executeQueryTool } = await import('./jarvis.js');
    const viewer = { tokenHash: 'v', label: 'V', hashPrefix16: 'v', role: 'viewer' as const };
    const r = await executeQueryTool(viewer, 'audit', {});
    expect(r).toMatchObject({ ok: false, code: 'RESOURCE_FORBIDDEN' });
  });
});
