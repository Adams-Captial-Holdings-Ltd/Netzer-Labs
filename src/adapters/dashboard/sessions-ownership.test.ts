import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { TokenPrincipal } from '../../lib/auth/dashboard-auth.js';

/**
 * WI-1.1 — a conversation belongs to a person, and every route enforces it.
 *
 * Owner decision 1: conversations are author-private with an audited admin
 * override; a token with no user (the env root token, a legacy per-operator
 * token) is bound to one immutable user by an audited link, otherwise it gets
 * no durable chat. Decision 9: fix every route against that owner model, no
 * hotfix.
 *
 * Before WI-1.1 the owner stamped on a conversation was `dashboard:<tokenHash>`,
 * and a member session mints a fresh token on every login, so a second login
 * orphaned every conversation the first one wrote (A133). Nothing on the send
 * path compared the stored owner with the caller, and appendTurns overwrote the
 * owner with whoever sent last, so sending one message into someone else's
 * conversation took it (A131).
 *
 * Driven through the REAL buildDashboardRouter with the sessions repo, the agent
 * loop and the audit writer mocked, so every authorization branch executes. The
 * negative cases assert the model was never called and nothing was written — a
 * route that runs the turn and refuses afterwards would still pass a status check.
 */

const {
  authenticateDashboardToken,
  getSession,
  appendTurns,
  deleteSession,
  runAgentTurn,
  runCommand,
  writeAudit,
  send,
  getUser,
  linkTokenToUser,
  listTokens,
  writeAuditOrThrow,
  exportChatData,
} = vi.hoisted(() => ({
  authenticateDashboardToken: vi.fn(),
  getSession: vi.fn(),
  appendTurns: vi.fn(),
  deleteSession: vi.fn(),
  runAgentTurn: vi.fn(),
  runCommand: vi.fn(),
  writeAudit: vi.fn(),
  send: vi.fn(),
  getUser: vi.fn(),
  linkTokenToUser: vi.fn(),
  listTokens: vi.fn(),
  writeAuditOrThrow: vi.fn(),
  exportChatData: vi.fn(),
}));

/**
 * Principals by bearer string. `operator` and `admin` are tokens with no user
 * (legacy per-operator tokens); the `member-*` ones are magic-link sessions,
 * where `member-a1` and `member-a2` are two logins by the SAME person.
 */
const PRINCIPALS: Record<string, TokenPrincipal> = {
  operator: { tokenHash: 'hash-operator', label: 'operator', hashPrefix16: 'operator', role: 'operator' },
  admin: { tokenHash: 'hash-admin', label: 'admin', hashPrefix16: 'admin', role: 'admin' },
  'member-a1': {
    tokenHash: 'hash-login-1', label: 'member:a', hashPrefix16: 'login1', role: 'operator',
    profileId: 'operator', userId: 'user-a',
  },
  'member-a2': {
    tokenHash: 'hash-login-2', label: 'member:a', hashPrefix16: 'login2', role: 'operator',
    profileId: 'operator', userId: 'user-a',
  },
  'member-b': {
    tokenHash: 'hash-login-3', label: 'member:b', hashPrefix16: 'login3', role: 'operator',
    profileId: 'operator', userId: 'user-b',
  },
  'linked-operator': {
    tokenHash: 'hash-linked', label: 'ops laptop', hashPrefix16: 'linked', role: 'operator',
    linkedUserId: 'user-a',
  },
};

vi.mock('../../lib/auth/dashboard-auth.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/auth/dashboard-auth.js')>();
  return {
    ...actual,
    extractBearerToken: (h?: string) => (h ?? '').replace(/^Bearer\s+/i, ''),
    authenticateDashboardToken: (raw: string) => authenticateDashboardToken(raw),
  };
});

vi.mock('../../lib/state/sessions-repo.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/state/sessions-repo.js')>();
  return {
    ...actual,
    getSession: (...a: unknown[]) => getSession(...a),
    appendTurns: (...a: unknown[]) => appendTurns(...a),
    deleteSession: (...a: unknown[]) => deleteSession(...a),
  };
});

vi.mock('../../agent/agent-loop.js', async (importActual) => {
  const actual = await importActual<typeof import('../../agent/agent-loop.js')>();
  return { ...actual, runAgentTurn: (...a: unknown[]) => runAgentTurn(...a) };
});

vi.mock('../../agent/commands.js', () => ({
  runCommand: (...a: unknown[]) => runCommand(...a),
}));

vi.mock('../../lib/audit/audit-writer.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/audit/audit-writer.js')>();
  return {
    ...actual,
    writeAudit: (event: unknown) => writeAudit(event),
    writeAuditOrThrow: (event: unknown) => writeAuditOrThrow(event),
  };
});

vi.mock('../../lib/tools/privacy-tools.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/tools/privacy-tools.js')>();
  return { ...actual, exportChatData: (...a: unknown[]) => exportChatData(...a) };
});

vi.mock('../../lib/state/users-repo.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/state/users-repo.js')>();
  return { ...actual, getUser: (...a: unknown[]) => getUser(...a) };
});

vi.mock('../../lib/state/tokens-repo.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/state/tokens-repo.js')>();
  return {
    ...actual,
    linkTokenToUser: (...a: unknown[]) => linkTokenToUser(...a),
    listTokens: (...a: unknown[]) => listTokens(...a),
  };
});

vi.mock('../../lib/state/kill-switches-repo.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/state/kill-switches-repo.js')>();
  return { ...actual, isKillSwitchActive: () => Promise.resolve({ active: false }) };
});

vi.mock('../../lib/state/ddb.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/state/ddb.js')>();
  return { ...actual, ddb: () => ({ send }) };
});

vi.mock('../../observability/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  truncateForLog: (s: string) => s,
}));

import { buildDashboardRouter } from './handler.js';

const AGENT = 'main';
const CHAT = 'dashboard:1750000000000';
const SESSIONS_TABLE = process.env.TABLE_SESSIONS ?? 'claudeclaw-sessions';

function app() {
  const a = new Hono();
  a.route('/api', buildDashboardRouter());
  return a;
}

function request(who: string, path: string, init: RequestInit = {}) {
  return app().request(path, {
    ...init,
    headers: { Authorization: `Bearer ${who}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

const postStream = (who: string, body: Record<string, unknown> = {}) =>
  request(who, '/api/test-turn/stream', {
    method: 'POST',
    body: JSON.stringify({ text: 'hello again', agentId: AGENT, chatId: CHAT, ...body }),
  });

const postTurn = (who: string, body: Record<string, unknown> = {}) =>
  request(who, '/api/test-turn', {
    method: 'POST',
    body: JSON.stringify({ text: 'hello again', agentId: AGENT, chatId: CHAT, ...body }),
  });

const transcript = (who: string) =>
  request(who, `/api/sessions/transcript?agentId=${AGENT}&chatId=${encodeURIComponent(CHAT)}`);

/** A stored conversation owned by `userId`. */
function ownedBy(userId: string | undefined) {
  return {
    agentId: AGENT,
    chatId: CHAT,
    turns: [
      { role: 'user', text: 'a private question', ts: 1 },
      { role: 'assistant', text: 'a private answer', ts: 2 },
    ],
    updatedAt: 2,
    ...(userId === undefined ? {} : { userId }),
  };
}

/** The owner appendTurns was asked to stamp on its most recent call. */
function stampedOwner(): unknown {
  const call = appendTurns.mock.calls.at(-1);
  return (call?.[4] as { userId?: unknown } | undefined)?.userId;
}

/** Rows the mocked sessions Query/Scan returns. */
let rows: Record<string, unknown>[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  rows = [];
  authenticateDashboardToken.mockImplementation(async (raw: string) => PRINCIPALS[raw] ?? null);
  getSession.mockResolvedValue(null);
  appendTurns.mockResolvedValue(undefined);
  deleteSession.mockResolvedValue(undefined);
  runCommand.mockResolvedValue(null);
  writeAudit.mockResolvedValue(undefined);
  getUser.mockResolvedValue(null);
  linkTokenToUser.mockResolvedValue('linked');
  listTokens.mockResolvedValue([]);
  writeAuditOrThrow.mockResolvedValue(undefined);
  exportChatData.mockResolvedValue({ agentId: AGENT, chatId: CHAT, sessionTurns: 2 });
  runAgentTurn.mockResolvedValue({
    text: 'the answer',
    costUsd: 0,
    toolCallCount: 0,
    blocked: false,
    inputTokens: 1,
    outputTokens: 1,
    latencyMs: 1,
    modelId: 'test-model',
  });
  send.mockImplementation(async (cmd: { input?: Record<string, unknown> }) => {
    const input = cmd?.input ?? {};
    if (input.TableName === SESSIONS_TABLE) return { Items: rows };
    return {};
  });
});

describe('send routes — a conversation the caller does not own (WI-1.1, AC-1.1-2)', () => {
  it('POST /test-turn/stream refuses a conversation the caller does not own, before any model call', async () => {
    getSession.mockResolvedValue(ownedBy('dashboard:user:user-b'));

    const res = await postStream('member-a1');

    expect(res.status).toBe(404);
    expect(runAgentTurn).not.toHaveBeenCalled();
    expect(appendTurns).not.toHaveBeenCalled();
  });

  it('POST /test-turn/stream refuses a slash command in a conversation the caller does not own', async () => {
    // /newchat wipes a history and /model re-points it, so the command path is a
    // write path too: the check has to run before runCommand, not only before
    // the model call.
    getSession.mockResolvedValue(ownedBy('dashboard:user:user-b'));

    const res = await postStream('member-a1', { text: '/newchat' });

    expect(res.status).toBe(404);
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('POST /test-turn refuses a conversation the caller does not own', async () => {
    getSession.mockResolvedValue(ownedBy('dashboard:user:user-b'));

    const res = await postTurn('member-a1');

    expect(res.status).toBe(404);
    expect(runAgentTurn).not.toHaveBeenCalled();
    expect(appendTurns).not.toHaveBeenCalled();
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('refuses a stored conversation that carries no owner at all, which it does not own either', async () => {
    getSession.mockResolvedValue(ownedBy(undefined));

    const res = await postStream('member-a1');

    expect(res.status).toBe(404);
    expect(runAgentTurn).not.toHaveBeenCalled();
  });

  it('refuses a conversation it does not own with the same 404 the delete route gives a missing one', async () => {
    getSession.mockResolvedValue(ownedBy('dashboard:user:user-b'));
    const notMine = await postTurn('member-a1');
    const notMineBody = await notMine.text();

    // A chat id that is not stored at all starts a NEW conversation, so a send
    // CAN tell a stored chat from a missing one; what it must not do is answer
    // someone else's differently from a plain not-found. Compared against the
    // delete route's not-found — the same bytes.
    getSession.mockResolvedValue(null);
    const gone = await request('member-a1', `/api/sessions?agentId=${AGENT}&chatId=${encodeURIComponent(CHAT)}`, { method: 'DELETE' });

    expect(notMine.status).toBe(gone.status);
    expect(notMineBody).toBe(await gone.text());
  });

  it('lets the owner continue their own conversation', async () => {
    getSession.mockResolvedValue(ownedBy('dashboard:user:user-a'));

    const res = await postStream('member-a1');
    await res.text();

    expect(res.status).toBe(200);
    expect(runAgentTurn).toHaveBeenCalledTimes(1);
    expect(appendTurns).toHaveBeenCalledTimes(1);
  });
});

describe('a slash command acts for its caller (decision 9, the first critic\'s F2)', () => {
  it('hands the caller to the command, so a conversation the command creates is theirs', async () => {
    // /warroom as the first thing typed into a new chat creates the conversation.
    // Created with no owner, the owner check then refused it to its own author.
    runCommand.mockResolvedValue({ reply: 'War Room started' });

    await (await postStream('member-a1', { text: '/warroom' })).text();
    await postTurn('operator', { text: '/warroom' });

    expect(runCommand).toHaveBeenNthCalledWith(1, AGENT, CHAT, '/warroom', {
      owner: { surface: 'dashboard', userId: 'dashboard:user:user-a', ephemeral: false },
    });
    expect(runCommand).toHaveBeenNthCalledWith(2, AGENT, CHAT, '/warroom', {
      owner: { surface: 'dashboard', userId: 'dashboard:hash-operator', ephemeral: true },
    });
  });
});

describe('ownership survives token rotation (WI-1.1, AC-1.1-1/-3)', () => {
  it('rotating a token does not orphan the conversations it owns', async () => {
    // Login 1 starts a conversation.
    const first = await postStream('member-a1');
    await first.text();
    const ownerAtLogin1 = stampedOwner();

    // The same person logs in again — a fresh token — and starts another.
    const second = await postStream('member-a2', { chatId: 'dashboard:1750000000001' });
    await second.text();
    const ownerAtLogin2 = stampedOwner();

    // One person, one owner, whichever token they signed in with.
    expect(ownerAtLogin2).toBe(ownerAtLogin1);

    // And the second login can act on what the first one wrote: the delete
    // route, which already checked ownership before WI-1.1, accepts it.
    getSession.mockResolvedValue(ownedBy(ownerAtLogin1 as string));
    const del = await request('member-a2', `/api/sessions?agentId=${AGENT}&chatId=${encodeURIComponent(CHAT)}`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    expect(deleteSession).toHaveBeenCalledWith(AGENT, CHAT);
  });

  it('after rotating, the conversation list still holds the person\'s conversations', async () => {
    rows = [
      { PK: `AGENT#${AGENT}`, SK: `CHAT#${CHAT}`, updatedAt: 2, userId: 'dashboard:user:user-a', firstMessage: 'mine' },
      { PK: `AGENT#${AGENT}`, SK: 'CHAT#dashboard:9', updatedAt: 3, userId: 'dashboard:user:user-b', firstMessage: 'theirs' },
    ];

    const res = await request('member-a2', `/api/sessions?agentId=${AGENT}`);
    const body = (await res.json()) as { sessions: { chatId: string }[] };

    expect(res.status).toBe(200);
    expect(body.sessions.map((s) => s.chatId)).toEqual([CHAT]);
  });

  it('a token linked to a person still reaches what it wrote before it was linked', async () => {
    // The owner's master token wrote five production conversations as
    // dashboard:<its hash> (decision 46). Linked, its identity becomes the
    // person, and those rows must stay reachable until WI-1.4 re-keys them —
    // the only case the tokenHash half of ownsConversation exists for.
    getSession.mockResolvedValue(ownedBy('dashboard:hash-linked'));

    const res = await postStream('linked-operator');
    await res.text();

    expect(res.status).toBe(200);
    expect(runAgentTurn).toHaveBeenCalledTimes(1);
  });

  it('a token linked to a person owns what that person owns (decision 1)', async () => {
    getSession.mockResolvedValue(ownedBy('dashboard:user:user-a'));

    const res = await postStream('linked-operator');
    await res.text();

    expect(res.status).toBe(200);
    expect(runAgentTurn).toHaveBeenCalledTimes(1);
  });
});

describe('a token with no person behind it gets no durable chat (decision 1)', () => {
  it('writes its conversation as ephemeral', async () => {
    const res = await postStream('operator');
    await res.text();

    expect(appendTurns).toHaveBeenCalledTimes(1);
    expect(appendTurns.mock.calls[0]?.[4]).toMatchObject({ ephemeral: true });
  });

  it('writes a person\'s conversation as durable', async () => {
    const res = await postStream('member-a1');
    await res.text();

    expect(appendTurns.mock.calls[0]?.[4]).toMatchObject({ ephemeral: false });
  });

  it('can still continue a conversation its own token wrote before WI-1.1', async () => {
    // Rows written before WI-1.1 carry `dashboard:<tokenHash>`. For a token with
    // no user that hash is stable, so its own history stays reachable.
    getSession.mockResolvedValue(ownedBy('dashboard:hash-operator'));

    const res = await postStream('operator');
    await res.text();

    expect(res.status).toBe(200);
    expect(runAgentTurn).toHaveBeenCalledTimes(1);
  });
});

describe('GET /sessions/transcript — author-private with an audited admin override', () => {
  it('returns the owner\'s own transcript', async () => {
    getSession.mockResolvedValue(ownedBy('dashboard:user:user-a'));

    const res = await transcript('member-a1');
    const body = (await res.json()) as { turns: unknown[] };

    expect(res.status).toBe(200);
    expect(body.turns).toHaveLength(2);
    expect(writeAudit).not.toHaveBeenCalled();
    expect(writeAuditOrThrow).not.toHaveBeenCalled();
  });

  it('shows a conversation the caller does not own as empty, exactly like one that does not exist', async () => {
    getSession.mockResolvedValue(ownedBy('dashboard:user:user-b'));
    const notMine = await transcript('member-a1');
    const notMineBody = await notMine.text();

    getSession.mockResolvedValue(null);
    const missing = await transcript('member-a1');

    expect(notMine.status).toBe(missing.status);
    expect(notMineBody).toBe(await missing.text());
    expect(notMineBody).not.toContain('a private');
  });

  it('lets an admin read another person\'s transcript and records it in the audit', async () => {
    getSession.mockResolvedValue(ownedBy('dashboard:user:user-b'));

    const res = await transcript('admin');
    const body = (await res.json()) as { turns: unknown[] };

    expect(body.turns).toHaveLength(2);
    // Awaited and never suppressible (the first critic's F4): a read nobody can
    // see recorded is exactly what a hostile admin wants.
    expect(writeAuditOrThrow).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'session_read_override',
        agentId: AGENT,
        chatId: CHAT,
        detail: expect.objectContaining({ scope: 'transcript', requestedBy: 'dashboard:hash-admin' }),
      }),
    );
  });

  it('hands an admin none of another person\'s transcript when that read cannot be audited', async () => {
    getSession.mockResolvedValue(ownedBy('dashboard:user:user-b'));
    writeAuditOrThrow.mockRejectedValue(new Error('both audit stores are down'));

    const res = await transcript('admin');

    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain('a private');
  });
});

describe('GET /sessions and the CSV export — each person sees their own', () => {
  beforeEach(() => {
    rows = [
      { PK: `AGENT#${AGENT}`, SK: `CHAT#${CHAT}`, updatedAt: 2, userId: 'dashboard:hash-operator', firstMessage: 'mine' },
      { PK: `AGENT#${AGENT}`, SK: 'CHAT#dashboard:9', updatedAt: 3, userId: 'dashboard:user:user-b', firstMessage: 'theirs' },
    ];
  });

  it('lists only the caller\'s conversations', async () => {
    const res = await request('operator', '/api/sessions');
    const body = (await res.json()) as { sessions: { chatId: string; firstMessage: string }[] };

    expect(body.sessions.map((s) => s.chatId)).toEqual([CHAT]);
    expect(JSON.stringify(body)).not.toContain('theirs');
  });

  it('lets an admin list every conversation, audited', async () => {
    const res = await request('admin', '/api/sessions');
    const body = (await res.json()) as { sessions: { chatId: string }[] };

    expect(body.sessions).toHaveLength(2);
    expect(writeAuditOrThrow).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'session_read_override', detail: expect.objectContaining({ scope: 'list' }) }),
    );
  });

  it('lists nothing to an admin when the override cannot be audited', async () => {
    writeAuditOrThrow.mockRejectedValue(new Error('both audit stores are down'));

    const res = await request('admin', '/api/sessions');

    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain('theirs');
  });

  it('lets an admin export every conversation, audited, and exports nothing when it cannot be', async () => {
    const res = await request('admin', '/api/sessions/export');
    expect(res.headers.get('X-Export-Row-Count')).toBe('2');
    expect(writeAuditOrThrow).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'session_read_override', detail: expect.objectContaining({ scope: 'export' }) }),
    );

    writeAuditOrThrow.mockRejectedValue(new Error('both audit stores are down'));
    const refused = await request('admin', '/api/sessions/export');
    expect(refused.status).toBe(500);
    expect(await refused.text()).not.toContain('theirs');
  });

  it('exports only the caller\'s conversations', async () => {
    const res = await request('operator', '/api/sessions/export');
    const csv = await res.text();

    expect(csv).toContain(CHAT);
    expect(csv).not.toContain('theirs');
    expect(res.headers.get('X-Export-Row-Count')).toBe('1');
  });
});

describe('GET /export — one chat\'s full export is its author\'s, or an audited admin\'s', () => {
  // Untested until the first critic's A7.
  const exportChat = (who: string) =>
    request(who, `/api/export?agentId=${AGENT}&chatId=${encodeURIComponent(CHAT)}`);

  it('refuses someone else\'s chat, before reading any of it', async () => {
    getSession.mockResolvedValue(ownedBy('dashboard:user:user-b'));

    const res = await exportChat('member-a1');

    expect(res.status).toBe(404);
    expect(exportChatData).not.toHaveBeenCalled();
  });

  it('refuses a chat that has no conversation to own, so its leftovers are nobody\'s to take', async () => {
    const res = await exportChat('member-a1');

    expect(res.status).toBe(404);
    expect(exportChatData).not.toHaveBeenCalled();
  });

  it('exports the caller\'s own chat without an override', async () => {
    getSession.mockResolvedValue(ownedBy('dashboard:user:user-a'));

    const res = await exportChat('member-a1');

    expect(res.status).toBe(200);
    expect(exportChatData).toHaveBeenCalledWith(AGENT, CHAT);
    expect(writeAuditOrThrow).not.toHaveBeenCalled();
  });

  it('lets an admin export another person\'s chat, audited first, and nothing when it cannot be', async () => {
    getSession.mockResolvedValue(ownedBy('dashboard:user:user-b'));

    const res = await exportChat('admin');
    expect(res.status).toBe(200);
    expect(writeAuditOrThrow).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'session_read_override', chatId: CHAT, detail: expect.objectContaining({ scope: 'chat-export' }) }),
    );

    exportChatData.mockClear();
    writeAuditOrThrow.mockRejectedValue(new Error('both audit stores are down'));
    const refused = await exportChat('admin');
    expect(refused.status).toBe(500);
    expect(exportChatData).not.toHaveBeenCalled();
  });
});

describe('POST /tokens/:hashPrefix/link — the audited, one-time link of a token to a person (decision 1)', () => {
  // Addressed by the 16-hex prefix GET /tokens hands out, like DELETE /tokens/:hashPrefix.
  const ROOT_HASH = 'a'.repeat(64);
  const PREFIX = ROOT_HASH.slice(0, 16);
  const link = (who: string, userId: string, prefix = PREFIX) =>
    request(who, `/api/tokens/${prefix}/link`, { method: 'POST', body: JSON.stringify({ userId }) });

  beforeEach(() => {
    listTokens.mockResolvedValue([{ tokenHash: ROOT_HASH, label: 'Root token', role: 'admin', active: true }]);
  });

  it('links a token to an existing user and audits it', async () => {
    getUser.mockResolvedValue({ userId: 'user-a', status: 'active' });

    const res = await link('admin', 'user-a');

    expect(res.status).toBe(200);
    expect(linkTokenToUser).toHaveBeenCalledWith(ROOT_HASH, 'user-a', 'dashboard:hash-admin');
    expect(writeAuditOrThrow).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'token_linked',
        detail: expect.objectContaining({ userId: 'user-a', hashPrefix: PREFIX }),
      }),
    );
  });

  it('refuses a caller without tokens:write', async () => {
    const res = await link('operator', 'user-a');

    expect(res.status).toBe(403);
    expect(linkTokenToUser).not.toHaveBeenCalled();
  });

  it('refuses a user that does not exist', async () => {
    getUser.mockResolvedValue(null);

    const res = await link('admin', 'nobody');

    expect(res.status).toBe(400);
    expect(linkTokenToUser).not.toHaveBeenCalled();
  });

  it('refuses a prefix that does not name exactly one token', async () => {
    getUser.mockResolvedValue({ userId: 'user-a', status: 'active' });
    listTokens.mockResolvedValue([
      { tokenHash: `${PREFIX}${'b'.repeat(48)}`, label: 'one', role: 'admin', active: true },
      { tokenHash: `${PREFIX}${'c'.repeat(48)}`, label: 'two', role: 'admin', active: true },
    ]);

    const res = await link('admin', 'user-a');

    expect(res.status).toBe(404);
    expect(linkTokenToUser).not.toHaveBeenCalled();
  });

  it('refuses to move a link once it is made — the owner is immutable', async () => {
    getUser.mockResolvedValue({ userId: 'user-b', status: 'active' });
    linkTokenToUser.mockResolvedValue('already_linked');

    const res = await link('admin', 'user-b');

    expect(res.status).toBe(409);
    expect(writeAuditOrThrow).not.toHaveBeenCalled();
  });
});
