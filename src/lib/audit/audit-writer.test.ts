import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditEvent } from './audit-writer.js';

// ── Mocks for the writeAudit runtime tests (hoisted by vitest) ──────────
const s3Send = vi.fn(async () => ({}));
const ddbSend = vi.fn(async () => ({}));
const logDebug = vi.fn();
const logWarn = vi.fn();

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class {
    send = s3Send;
  },
  PutObjectCommand: class {
    constructor(public readonly input: unknown) {}
  },
}));
vi.mock('../state/ddb.js', () => ({ ddb: () => ({ send: ddbSend }) }));
const killSwitchState = { active: false };
vi.mock('../state/kill-switches-repo.js', () => ({
  isKillSwitchActive: async () => ({ active: killSwitchState.active }),
}));
vi.mock('../pii/redact.js', () => ({
  redactSync: (s: string) => s,
  refreshPiiCache: async () => undefined,
}));
vi.mock('../observability/xray.js', () => ({ captureAwsClient: <T>(c: T): T => c }));
vi.mock('../../observability/logger.js', () => ({
  logger: { debug: logDebug, warn: logWarn, info: vi.fn(), error: vi.fn() },
}));

const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

// Compile-time + shape tests on the AuditEvent discriminator. These
// catch type regressions when someone adds a new action without
// extending the union.

describe('AuditEvent action union', () => {
  it('accepts every shipped action variant', () => {
    const events: AuditEvent[] = [
      { action: 'agent_turn', agentId: 'main' },
      { action: 'tool_invoke', toolName: 'x' },
      { action: 'memory_add' },
      { action: 'memory_forget' },
      { action: 'kill_switch_set' },
      { action: 'kill_switch_blocked' },
      { action: 'media_upload', surface: 'telegram' },
      { action: 'data_purged', chatId: 'a' },
      { action: 'canary_fired', latencyMs: 100 },
      { action: 'agent_file_edited', agentId: 'main' },
    ];
    expect(events.length).toBe(10);
  });

  it('accepts the v5.7 auth/token/guardrail/suppression actions', () => {
    const events: AuditEvent[] = [
      { action: 'token_created' },
      { action: 'token_revoked' },
      { action: 'auth_failure', result: 'blocked' },
      { action: 'guardrail_intervention' },
      { action: 'audit_suppressed', detail: { suppressedAction: 'agent_turn' } },
    ];
    expect(events.length).toBe(5);
  });

  it('carries userId as top-level field', () => {
    const e: AuditEvent = {
      action: 'agent_turn',
      agentId: 'main',
      userId: 'U12345',
    };
    expect(e.userId).toBe('U12345');
  });
});

// ─────────────────────────────────────────────────────────────────────
// Tier-gated WORM bucket: clean no-op when AUDIT_LOCK_BUCKET is unset
// (IaC readiness plan, item 26 — T0/T1 deploys have no audit-lock bucket)
// ─────────────────────────────────────────────────────────────────────

describe('writeAudit when AUDIT_LOCK_BUCKET is unset (tier < 2)', () => {
  const ORIGINAL = process.env.AUDIT_LOCK_BUCKET;

  beforeEach(() => {
    s3Send.mockClear();
    ddbSend.mockClear();
    logDebug.mockClear();
    logWarn.mockClear();
  });

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.AUDIT_LOCK_BUCKET;
    else process.env.AUDIT_LOCK_BUCKET = ORIGINAL;
  });

  it('no-ops the S3 mirror cleanly: no throw, no S3 call, no warn spam, ONE debug line', async () => {
    delete process.env.AUDIT_LOCK_BUCKET;
    const { writeAudit, _resetAuditLockBucketLogForTests } = await import('./audit-writer.js');
    _resetAuditLockBucketLogForTests();

    await expect(writeAudit({ action: 'agent_turn', agentId: 'main' })).resolves.toBeUndefined();
    await writeAudit({ action: 'tool_invoke', toolName: 'x' });
    await writeAudit({ action: 'memory_add' });
    await flush();

    // S3 mirror is OFF; the DDB hot path keeps writing.
    expect(s3Send).not.toHaveBeenCalled();
    expect(ddbSend).toHaveBeenCalledTimes(3);
    // Exactly ONE debug-level line per process, never a warning per event.
    expect(logDebug).toHaveBeenCalledTimes(1);
    expect(String(logDebug.mock.calls[0][0])).toContain('AUDIT_LOCK_BUCKET');
    expect(logWarn).not.toHaveBeenCalled();
  });

  it('treats the empty string (compute-stack passes "" below tier 2) the same as unset', async () => {
    process.env.AUDIT_LOCK_BUCKET = '';
    const { writeAudit, _resetAuditLockBucketLogForTests } = await import('./audit-writer.js');
    _resetAuditLockBucketLogForTests();

    await writeAudit({ action: 'agent_turn' });
    await flush();

    expect(s3Send).not.toHaveBeenCalled();
    expect(ddbSend).toHaveBeenCalledTimes(1);
    expect(logDebug).toHaveBeenCalledTimes(1);
    expect(logWarn).not.toHaveBeenCalled();
  });

  it('mirrors to S3 when the bucket IS configured (tier >= 2)', async () => {
    process.env.AUDIT_LOCK_BUCKET = 'claudeclaw-audit-lock-1-us-east-1';
    const { writeAudit } = await import('./audit-writer.js');

    await writeAudit({ action: 'agent_turn', agentId: 'main' });
    await flush();

    expect(ddbSend).toHaveBeenCalledTimes(1);
    expect(s3Send).toHaveBeenCalledTimes(1);
    expect(logWarn).not.toHaveBeenCalled();
  });
});

// ── C5c: awaited, non-suppressible critical audit writes ────────────────

describe('writeAuditOrThrow (C5c)', () => {
  beforeEach(() => {
    ddbSend.mockReset();
    ddbSend.mockResolvedValue({});
    killSwitchState.active = false;
  });

  it('resolves when the DDB store accepts the event', async () => {
    const { writeAuditOrThrow } = await import('./audit-writer.js');
    await expect(
      writeAuditOrThrow({ action: 'token_created', result: 'ok' }),
    ).resolves.toBeUndefined();
    expect(ddbSend).toHaveBeenCalledTimes(1);
  });

  it('throws AuditWriteFailedError when no store accepts the event', async () => {
    const { writeAuditOrThrow, AuditWriteFailedError } = await import('./audit-writer.js');
    ddbSend.mockRejectedValue(new Error('ddb down'));
    await expect(
      writeAuditOrThrow({ action: 'iam_apply', result: 'ok' }),
    ).rejects.toBeInstanceOf(AuditWriteFailedError);
  });

  it('ignores audit_log_disabled entirely (defense in depth)', async () => {
    const { writeAuditOrThrow } = await import('./audit-writer.js');
    killSwitchState.active = true;
    await expect(
      writeAuditOrThrow({ action: 'token_revoked', result: 'ok' }),
    ).resolves.toBeUndefined();
    expect(ddbSend).toHaveBeenCalledTimes(1);
  });
});

describe('expanded always-audited set (C5c)', () => {
  beforeEach(() => {
    ddbSend.mockReset();
    ddbSend.mockResolvedValue({});
  });

  it('kill_switch_set / token_created / token_revoked / iam_apply write even under audit_log_disabled', async () => {
    const { writeAudit } = await import('./audit-writer.js');
    killSwitchState.active = true;
    for (const action of ['kill_switch_set', 'token_created', 'token_revoked', 'iam_apply'] as const) {
      await writeAudit({ action, result: 'ok' });
    }
    await flush();
    expect(ddbSend).toHaveBeenCalledTimes(4);
    killSwitchState.active = false;
  });

  it('effect actions write even under audit_log_disabled', async () => {
    const { writeAudit } = await import('./audit-writer.js');
    ddbSend.mockReset();
    ddbSend.mockResolvedValue({});
    killSwitchState.active = true;
    try {
      for (const action of ['effect_applied', 'effect_unknown', 'effect_resolved'] as const)
        await writeAudit({ action, result: 'ok' });
      await flush();
      expect(ddbSend).toHaveBeenCalledTimes(3);
    } finally { killSwitchState.active = false; }
  });

  it('all six step 6 actions write even under audit_log_disabled', async () => {
    const { writeAudit } = await import('./audit-writer.js');
    killSwitchState.active = true;
    try {
      for (const action of ['approval_requested', 'approval_decided', 'approval_refused',
        'shadow_assigned', 'shadow_rotated', 'shadow_retired'] as const) {
        await writeAudit({ action, result: 'ok' });
      }
      await flush();
      expect(ddbSend).toHaveBeenCalledTimes(6);
    } finally { killSwitchState.active = false; }
  });

  it('config_access_denied survives audit_log_disabled', async () => {
    const { writeAudit } = await import('./audit-writer.js');
    ddbSend.mockReset();
    ddbSend.mockResolvedValue({});
    killSwitchState.active = true;
    try {
      await writeAudit({
        action: 'config_access_denied',
        result: 'blocked',
        detail: { category: 'oauth', key: 'slack_app_ops', method: 'GET', reason: 'secret_category' },
      });
      await flush();
      // The row itself, not an audit_suppressed marker standing in for it.
      const actions = (ddbSend.mock.calls as unknown as Array<[{ input: { Item: { action: string } } }]>)
        .map(([cmd]) => cmd.input.Item.action);
      expect(actions).toEqual(['config_access_denied']);
    } finally { killSwitchState.active = false; }
  });

  it('knowledge_scope_denied survives audit_log_disabled', async () => {
    const { writeAudit } = await import('./audit-writer.js');
    ddbSend.mockReset();
    ddbSend.mockResolvedValue({});
    killSwitchState.active = true;
    try {
      await writeAudit({
        action: 'knowledge_scope_denied' as Parameters<typeof writeAudit>[0]['action'],
        result: 'blocked',
        detail: { route: 'GET /vectors', scopeHash: '0123456789ab', reason: 'private_scope' },
      });
      await flush();
      const actions = (ddbSend.mock.calls as unknown as Array<[{ input: { Item: { action: string } } }]>)
        .map(([cmd]) => cmd.input.Item.action);
      expect(actions).toEqual(['knowledge_scope_denied']);
    } finally { killSwitchState.active = false; }
  });
});
