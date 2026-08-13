import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { TokenPrincipal } from '../../lib/auth/dashboard-auth.js';

// Contract test for the owner-scoped conversation routes. Drives the REAL
// router through app.request() (same harness as seat-admin.test.ts); auth is
// driven by a role string, capability resolution stays real (templated
// profiles resolve in-memory), and only the repo is mocked.

function principalFor(raw: string): TokenPrincipal | null {
  const id = raw.replace(/^Bearer\s+/i, '');
  if (id === 'viewer' || id === 'operator' || id === 'admin') {
    return { tokenHash: `hash-${id}`, label: id, hashPrefix16: `prefix-${id}`, role: id };
  }
  if (id === 'user-token') {
    // A magic-link session principal: carries the stable users-table id.
    return {
      tokenHash: 'hash-user',
      label: 'Session token',
      hashPrefix16: 'prefix-user',
      role: 'operator',
      userId: 'u-123',
      profileId: 'operator',
    };
  }
  if (id === 'owner') {
    return {
      tokenHash: 'hash-owner',
      label: 'Root token',
      hashPrefix16: 'owner',
      role: 'admin',
      profileId: 'owner',
    };
  }
  return null;
}

vi.mock('../../lib/auth/dashboard-auth.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/auth/dashboard-auth.js')>();
  return {
    ...actual,
    extractBearerToken: (authHeader?: string) => (authHeader ?? '').replace(/^Bearer\s+/i, ''),
    authenticateDashboardToken: (raw: string) => Promise.resolve(principalFor(raw)),
  };
});

vi.mock('../../observability/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

const { getConversationMock, listConversationsMock, listMessagesMock } = vi.hoisted(() => ({
  getConversationMock: vi.fn(),
  listConversationsMock: vi.fn(),
  listMessagesMock: vi.fn(),
}));

vi.mock('../../lib/state/conversations-repo.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/state/conversations-repo.js')>();
  return {
    ...actual, // keep the real conversationOwnerId - it is part of the contract
    getConversation: getConversationMock,
    listConversations: listConversationsMock,
    listMessages: listMessagesMock,
  };
});

import { buildConversationsRouter } from './conversations.js';

function req(path: string, bearer?: string) {
  const app = new Hono();
  app.route('/api/conversations', buildConversationsRouter());
  return app.request(`/api/conversations${path}`, {
    headers: bearer ? { Authorization: `Bearer ${bearer}` } : {},
  });
}

const META = {
  conversationId: 'dashboard:c_abc',
  ownerId: 'u-123',
  agentId: 'main',
  title: 'hello world',
  messageCount: 4,
  createdAt: 100,
  updatedAt: 200,
  lastClientMessageId: 'cm-9',
};

beforeEach(() => {
  vi.clearAllMocks();
  listConversationsMock.mockResolvedValue([META]);
  getConversationMock.mockResolvedValue(META);
  listMessagesMock.mockResolvedValue([
    { role: 'user', text: 'hello world', ts: 100 },
    { role: 'assistant', text: 'hi', ts: 100 },
  ]);
});

describe('GET /api/conversations', () => {
  it('401s without a token', async () => {
    const res = await req('/');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
  });

  it('lists the CALLER\'S conversations, scoped by the stable users-table id', async () => {
    const res = await req('', 'user-token');
    expect(res.status).toBe(200);
    expect(listConversationsMock).toHaveBeenCalledWith('u-123');
    const body = (await res.json()) as { conversations: Array<Record<string, unknown>> };
    expect(body.conversations).toHaveLength(1);
    // Internal bookkeeping fields never reach the client.
    expect(body.conversations[0]).toEqual({
      conversationId: 'dashboard:c_abc',
      title: 'hello world',
      agentId: 'main',
      messageCount: 4,
      createdAt: 100,
      updatedAt: 200,
    });
  });

  it('scopes the env break-glass token to the stable root owner', async () => {
    const res = await req('', 'owner');
    expect(res.status).toBe(200);
    expect(listConversationsMock).toHaveBeenCalledWith('root');
  });

  it('scopes legacy minted tokens (no user binding) to their token hash prefix', async () => {
    const res = await req('', 'operator');
    expect(res.status).toBe(200);
    expect(listConversationsMock).toHaveBeenCalledWith('token:prefix-operator');
  });

  it('allows viewers - chat:read is a read capability', async () => {
    const res = await req('', 'viewer');
    expect(res.status).toBe(200);
  });
});

describe('GET /api/conversations/:conversationId', () => {
  it('returns the meta view and the full transcript oldest-first', async () => {
    const res = await req(`/${encodeURIComponent('dashboard:c_abc')}`, 'user-token');
    expect(res.status).toBe(200);
    expect(getConversationMock).toHaveBeenCalledWith('u-123', 'dashboard:c_abc');
    expect(listMessagesMock).toHaveBeenCalledWith('dashboard:c_abc', 200);
    const body = (await res.json()) as {
      conversation: Record<string, unknown>;
      messages: Array<{ role: string }>;
    };
    expect(body.conversation.conversationId).toBe('dashboard:c_abc');
    expect(body.conversation.lastClientMessageId).toBeUndefined();
    expect(body.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('404s uniformly when the conversation is not the caller\'s (no existence leak)', async () => {
    getConversationMock.mockResolvedValue(null);
    const res = await req(`/${encodeURIComponent('dashboard:c_abc')}`, 'user-token');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
    // The repo was asked under the CALLER'S partition only.
    expect(getConversationMock).toHaveBeenCalledWith('u-123', 'dashboard:c_abc');
    expect(listMessagesMock).not.toHaveBeenCalled();
  });
});
