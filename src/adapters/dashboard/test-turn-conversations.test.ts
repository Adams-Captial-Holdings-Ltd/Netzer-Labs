import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { TokenPrincipal } from '../../lib/auth/dashboard-auth.js';

// Contract test for conversation-aware POST /test-turn/stream (ADR 0010).
// Drives the REAL router through app.request() (same harness as
// test-turn-attachments.test.ts); agent loop, session repo, conversations
// repo, and runtime config are mocked so no AWS is touched. Pins:
//   - ownership: a conversationId the caller does not own is a pre-stream 404
//   - idempotency: a repeated clientMessageId is a pre-stream 409
//   - agent pinning: a conversation send uses the meta's agentId, not the body's
//   - persistence: persistTurn + the `conversation` SSE event fire only on
//     a successful (non-blocked) turn
//   - the legacy raw-chatId path is byte-for-byte unchanged (no repo calls)

function principalFor(raw: string): TokenPrincipal | null {
  const role = raw.replace(/^Bearer\s+/i, '');
  if (role !== 'viewer' && role !== 'operator' && role !== 'admin') return null;
  return { tokenHash: `hash-${role}`, label: role, hashPrefix16: `prefix-${role}`, role };
}

vi.mock('../../lib/auth/dashboard-auth.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/auth/dashboard-auth.js')>();
  return {
    ...actual,
    extractBearerToken: (authHeader?: string) => (authHeader ?? '').replace(/^Bearer\s+/i, ''),
    authenticateDashboardToken: (raw: string) => Promise.resolve(principalFor(raw)),
  };
});

vi.mock('../../lib/state/kill-switches-repo.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/state/kill-switches-repo.js')>();
  return {
    ...actual,
    isKillSwitchActive: () => Promise.resolve({ active: false }),
  };
});

// The cross-surface peek reads runtime config; resolve instantly so the test
// never falls through to the real AWS credential chain (the jarvis.flow flake).
vi.mock('../../lib/state/runtime-config-repo.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/state/runtime-config-repo.js')>();
  return {
    ...actual,
    getConfig: () => Promise.resolve(undefined),
  };
});

vi.mock('../../lib/audit/audit-writer.js', () => ({
  writeAudit: () => Promise.resolve(),
}));

vi.mock('../../observability/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  truncateForLog: (s: string) => s,
}));

const {
  runAgentTurnMock,
  getSessionMock,
  appendTurnsMock,
  runCommandMock,
  getConversationMock,
  persistTurnMock,
} = vi.hoisted(() => ({
  runAgentTurnMock: vi.fn(),
  getSessionMock: vi.fn(),
  appendTurnsMock: vi.fn(),
  runCommandMock: vi.fn(),
  getConversationMock: vi.fn(),
  persistTurnMock: vi.fn(),
}));

vi.mock('../../agent/agent-loop.js', async (importActual) => {
  const actual = await importActual<typeof import('../../agent/agent-loop.js')>();
  return { ...actual, runAgentTurn: runAgentTurnMock };
});

vi.mock('../../lib/state/sessions-repo.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/state/sessions-repo.js')>();
  return { ...actual, getSession: getSessionMock, appendTurns: appendTurnsMock };
});

vi.mock('../../lib/state/conversations-repo.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/state/conversations-repo.js')>();
  return {
    ...actual, // keep conversationOwnerId + isConversationChatId real
    getConversation: getConversationMock,
    persistTurn: persistTurnMock,
    newConversationId: () => 'dashboard:c_minted-fixed-id',
  };
});

vi.mock('../../agent/commands.js', () => ({
  runCommand: runCommandMock,
}));

import { buildDashboardRouter } from './handler.js';

function postStream(body: unknown) {
  const app = new Hono();
  app.route('/api', buildDashboardRouter());
  return app.request('/api/test-turn/stream', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer operator',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

const OWNED_META = {
  conversationId: 'dashboard:c_abc',
  ownerId: 'token:prefix-operator',
  agentId: 'ops',
  title: 'earlier question',
  messageCount: 2,
  createdAt: 100,
  updatedAt: 200,
  lastClientMessageId: 'cm-prev',
};

beforeEach(() => {
  vi.clearAllMocks();
  getSessionMock.mockResolvedValue(null);
  appendTurnsMock.mockResolvedValue(undefined);
  runCommandMock.mockResolvedValue(null);
  getConversationMock.mockResolvedValue(OWNED_META);
  persistTurnMock.mockResolvedValue(undefined);
  runAgentTurnMock.mockResolvedValue({
    text: 'the answer',
    costUsd: 0.01,
    toolCallCount: 0,
    blocked: false,
    inputTokens: 10,
    outputTokens: 10,
    latencyMs: 100,
    modelId: 'anthropic.claude-3-5-sonnet',
  });
});

describe('POST /test-turn/stream with conversationId', () => {
  it('404s BEFORE streaming when the conversation is not the caller\'s', async () => {
    getConversationMock.mockResolvedValue(null);
    const res = await postStream({ text: 'hi', conversationId: 'dashboard:c_abc' });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
    // Resolved under the CALLER'S owner id (operator principal, no userId).
    expect(getConversationMock).toHaveBeenCalledWith('token:prefix-operator', 'dashboard:c_abc');
    expect(runAgentTurnMock).not.toHaveBeenCalled();
    expect(persistTurnMock).not.toHaveBeenCalled();
  });

  it('409s BEFORE any model call when the clientMessageId repeats the last message', async () => {
    const res = await postStream({
      text: 'hi again',
      conversationId: 'dashboard:c_abc',
      clientMessageId: 'cm-prev',
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'duplicate_message',
      conversationId: 'dashboard:c_abc',
    });
    expect(runAgentTurnMock).not.toHaveBeenCalled();
    expect(persistTurnMock).not.toHaveBeenCalled();
  });

  it('runs the turn on the conversation\'s pinned agent and chatId, then persists + announces', async () => {
    const res = await postStream({
      text: 'follow-up',
      agentId: 'main', // body says main; the conversation is pinned to ops
      conversationId: 'dashboard:c_abc',
      clientMessageId: 'cm-new',
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') ?? '').toContain('text/event-stream');
    // Drain the stream FIRST: with streamSSE the handler body executes as the
    // response is consumed, so mock assertions before this line see nothing.
    const sse = await res.text();

    const turn = runAgentTurnMock.mock.calls[0][0];
    expect(turn.chatId).toBe('dashboard:c_abc');
    expect(turn.agentId).toBe('ops');

    // Session machinery untouched: history still comes from the session row.
    expect(getSessionMock).toHaveBeenCalledWith('ops', 'dashboard:c_abc');
    expect(appendTurnsMock).toHaveBeenCalledTimes(1);

    expect(persistTurnMock).toHaveBeenCalledWith({
      ownerId: 'token:prefix-operator',
      conversationId: 'dashboard:c_abc',
      agentId: 'ops',
      userText: 'follow-up',
      assistantText: 'the answer',
      clientMessageId: 'cm-new',
    });

    expect(sse).toContain('event: conversation');
    expect(sse).toContain('dashboard:c_abc');
    expect(sse).toContain('event: done');
  });

  it('mints a server-side id for startConversation and announces it', async () => {
    const res = await postStream({ text: 'first message', startConversation: true });
    expect(res.status).toBe(200);
    const sse = await res.text();

    const turn = runAgentTurnMock.mock.calls[0][0];
    expect(turn.chatId).toBe('dashboard:c_minted-fixed-id');

    expect(persistTurnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: 'token:prefix-operator',
        conversationId: 'dashboard:c_minted-fixed-id',
        userText: 'first message',
        assistantText: 'the answer',
      }),
    );
    // No ownership read needed to START a conversation.
    expect(getConversationMock).not.toHaveBeenCalled();

    expect(sse).toContain('event: conversation');
    expect(sse).toContain('dashboard:c_minted-fixed-id');
  });

  it('persists nothing and announces nothing when the guardrail blocks the turn', async () => {
    runAgentTurnMock.mockResolvedValue({
      text: 'blocked notice',
      costUsd: 0,
      toolCallCount: 0,
      blocked: true,
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: 10,
      modelId: 'guardrail',
    });
    const res = await postStream({ text: 'bad input', conversationId: 'dashboard:c_abc' });
    expect(res.status).toBe(200);
    const sse = await res.text();
    expect(persistTurnMock).not.toHaveBeenCalled();
    expect(appendTurnsMock).not.toHaveBeenCalled();
    expect(sse).not.toContain('event: conversation');
  });

  it('leaves the legacy raw-chatId path byte-for-byte unchanged', async () => {
    const res = await postStream({ text: 'legacy send', chatId: 'dashboard:1755100000000' });
    expect(res.status).toBe(200);
    const sse = await res.text();

    expect(getConversationMock).not.toHaveBeenCalled();
    expect(persistTurnMock).not.toHaveBeenCalled();
    const turn = runAgentTurnMock.mock.calls[0][0];
    expect(turn.chatId).toBe('dashboard:1755100000000');
    expect(appendTurnsMock).toHaveBeenCalledTimes(1);
    expect(sse).not.toContain('event: conversation');
    expect(sse).toContain('event: done');
  });
});
