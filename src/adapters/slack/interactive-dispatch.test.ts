import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub the purge so we can assert dispatch behavior without touching DDB.
const purgeMock = vi.fn();
vi.mock('../../lib/tools/privacy-tools.js', () => ({
  purgeChatData: (...args: unknown[]) => purgeMock(...args),
}));
vi.mock('../../lib/audit/audit-writer.js', () => ({
  writeAudit: () => Promise.resolve(),
}));
vi.mock('../../observability/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  truncateForLog: (s: string) => s,
}));

import {
  parseInteractivePayload,
  dispatch,
} from './interactive-dispatch.js';

describe('parseInteractivePayload', () => {
  it('returns null when payload field is missing', () => {
    expect(parseInteractivePayload('something=else')).toBeNull();
  });

  it('returns null on malformed JSON', () => {
    expect(parseInteractivePayload('payload=not-json')).toBeNull();
  });

  it('parses a block_actions payload', () => {
    const json = JSON.stringify({
      type: 'block_actions',
      user: { id: 'U_TEST' },
      actions: [{ action_id: 'forget_me_confirm', type: 'button' }],
    });
    const out = parseInteractivePayload(`payload=${encodeURIComponent(json)}`);
    expect(out?.type).toBe('block_actions');
    expect(out?.actions?.[0]?.action_id).toBe('forget_me_confirm');
  });
});

describe('dispatch · block_actions', () => {
  beforeEach(() => {
    purgeMock.mockReset();
  });

  it('returns an empty body when actions[] is missing', async () => {
    const r = await dispatch({ type: 'block_actions' });
    expect(r.body).toEqual({});
  });

  it('runs purgeChatData on forget_me_confirm', async () => {
    purgeMock.mockResolvedValue({
      agentId: 'main',
      chatId: 'slack:C1:U1',
      purgedAt: '2026-05-21T00:00:00Z',
      counts: { memories: 3, scheduledTasks: 1, inboxItems: 0, sessionDeleted: true },
      preDeleteHash: 'abc',
    });
    const r = await dispatch({
      type: 'block_actions',
      user: { id: 'U1' },
      channel: { id: 'C1' },
      actions: [
        { action_id: 'forget_me_confirm', type: 'button', value: 'slack:C1:U1' },
      ],
    });
    expect(purgeMock).toHaveBeenCalledWith(
      'main',
      'slack:C1:U1',
      'slack-interactive:U1',
    );
    expect(JSON.stringify(r.body)).toContain('Purged');
  });

  it('returns a cancelled message on the cancel action', async () => {
    const r = await dispatch({
      type: 'block_actions',
      user: { id: 'U1' },
      channel: { id: 'C1' },
      actions: [{ action_id: 'forget_me_cancel', type: 'button' }],
    });
    expect(purgeMock).not.toHaveBeenCalled();
    expect(JSON.stringify(r.body)).toContain('Cancelled');
  });

  it('logs and ephemeral-responds when no handler matches', async () => {
    const r = await dispatch({
      type: 'block_actions',
      actions: [{ action_id: 'unknown_action', type: 'button' }],
    });
    expect(JSON.stringify(r.body)).toContain('No handler');
  });
});

describe('dispatch · misc', () => {
  it('view_submission with no registered callback returns empty body', async () => {
    const r = await dispatch({
      type: 'view_submission',
      view: { callback_id: 'unhandled' },
    });
    expect(r.body).toEqual({});
  });

  it('view_closed returns empty body', async () => {
    expect((await dispatch({ type: 'view_closed' })).body).toEqual({});
  });

  it('unknown type returns empty body', async () => {
    expect((await dispatch({ type: 'something_else' })).body).toEqual({});
  });
});
