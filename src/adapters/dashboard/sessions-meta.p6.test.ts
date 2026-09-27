/**
 * P6 (step 8) — rename, pin and title search at the dashboard's conversation routes.
 *
 * Written BEFORE the change, as the bar (netzar-chat-plan/p6-proof.sh rows M-1..M-6).
 * Driven through the REAL buildDashboardRouter with the sessions repo's reads and writes
 * mocked — the sessions-ownership.test.ts harness — so every branch of the routes executes.
 *
 * What it pins (the P6 design council, p6-runs/council-design/chairman.md):
 *   - `PATCH /sessions` renames or pins a conversation for its OWNER only; anyone else —
 *     an admin included — gets the 404 a missing conversation gets, and nothing is written.
 *     The write goes through `setConversationMeta`, which never creates a row.
 *   - A title is trimmed, at most 120 characters (the list's first-message cap) and free of
 *     control characters; an empty title clears it, so the list falls back to the first
 *     message.
 *   - `GET /sessions` returns each row's `title` and `pinned`; pinned conversations are
 *     always listed, beside the newest fifty others; `q` filters by title or first message
 *     BEFORE that cut (the route already reads every row), matched as plain text, bounded.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { TokenPrincipal } from '../../lib/auth/dashboard-auth.js';

const {
  authenticateDashboardToken,
  getSession,
  setConversationMeta,
  writeAudit,
  send,
} = vi.hoisted(() => ({
  authenticateDashboardToken: vi.fn(),
  getSession: vi.fn(),
  setConversationMeta: vi.fn(),
  writeAudit: vi.fn(),
  send: vi.fn(),
}));

const PRINCIPALS: Record<string, TokenPrincipal> = {
  'member-a1': {
    tokenHash: 'hash-login-1', label: 'member:a', hashPrefix16: 'login1', role: 'operator',
    profileId: 'operator', userId: 'user-a',
  },
  'member-b': {
    tokenHash: 'hash-login-3', label: 'member:b', hashPrefix16: 'login3', role: 'operator',
    profileId: 'operator', userId: 'user-b',
  },
  admin: { tokenHash: 'hash-admin', label: 'admin', hashPrefix16: 'admin', role: 'admin', userId: 'user-admin' },
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
    setConversationMeta: (...a: unknown[]) => setConversationMeta(...a),
  };
});

vi.mock('../../lib/audit/audit-writer.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/audit/audit-writer.js')>();
  return { ...actual, writeAudit: (event: unknown) => writeAudit(event), writeAuditOrThrow: vi.fn(async () => {}) };
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
const CHAT = 'dashboard:1750000000700';
const OWNER = 'dashboard:user:user-a';

function app() {
  const a = new Hono();
  a.route('/api', buildDashboardRouter());
  return a;
}

function call(who: string, method: string, path: string, body?: Record<string, unknown>) {
  return app().request(path, {
    method,
    headers: { Authorization: `Bearer ${who}`, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

const patch = (who: string, body: Record<string, unknown>) =>
  call(who, 'PATCH', '/api/sessions', { agentId: AGENT, chatId: CHAT, ...body });

function stored(extra: Record<string, unknown> = {}) {
  return {
    turns: [{ role: 'user', text: 'Q3 numbers?', ts: 1 }, { role: 'assistant', text: 'Here.', ts: 2 }],
    userId: OWNER, surface: 'dashboard', messageCount: 1, turnsTotal: 2, version: 4,
    updatedAt: 2, createdAt: 1, firstMessage: 'Q3 numbers?', ...extra,
  };
}

/** One conversation row as DynamoDB returns it (the list route reads every row itself). */
function row(i: number, extra: Record<string, unknown> = {}) {
  return {
    PK: `AGENT#${AGENT}`, SK: `CHAT#dashboard:${1750000001000 + i}`,
    updatedAt: 1000 + i, messageCount: 1, firstMessage: `conversation ${i}`, createdAt: 1000 + i,
    surface: 'dashboard', userId: OWNER, ...extra,
  };
}

interface ListRow { chatId: string; title: string | null; pinned: boolean; firstMessage: string | null }
async function list(query = ''): Promise<{ status: number; sessions: ListRow[] }> {
  const res = await call('member-a1', 'GET', `/api/sessions?agentId=${AGENT}${query}`);
  const body = res.status === 200 ? ((await res.json()) as { sessions: ListRow[] }) : { sessions: [] };
  return { status: res.status, sessions: body.sessions };
}

describe('P6 conversation title, pin and search — dashboard routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    authenticateDashboardToken.mockImplementation(async (raw: string) => PRINCIPALS[raw] ?? null);
    getSession.mockResolvedValue(stored());
    setConversationMeta.mockResolvedValue(true);
    writeAudit.mockResolvedValue(undefined);
    send.mockResolvedValue({ Items: [] });
  });

  it('P6 the owner renames a conversation and the list shows its title', async () => {
    const res = await patch('member-a1', { title: 'Budget review' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ agentId: AGENT, chatId: CHAT, title: 'Budget review', pinned: false });
    expect(setConversationMeta).toHaveBeenCalledTimes(1);
    expect(setConversationMeta).toHaveBeenCalledWith(AGENT, CHAT, OWNER, { title: 'Budget review' });

    // The list carries each row's title and pin, and a row with neither says so plainly.
    send.mockResolvedValue({ Items: [row(1, { title: 'Budget review', pinned: true }), row(2)] });
    const { status, sessions } = await list();
    expect(status).toBe(200);
    const byId = new Map(sessions.map((s) => [s.chatId, s]));
    expect(byId.get('dashboard:1750000001001')).toMatchObject({ title: 'Budget review', pinned: true });
    expect(byId.get('dashboard:1750000001002')).toMatchObject({ title: null, pinned: false, firstMessage: 'conversation 2' });
  });

  it('P6 rename and pin give anyone but the owner the missing conversation refusal', async () => {
    const answers: Response[] = [];
    getSession.mockResolvedValue(undefined); // missing
    answers.push(await patch('member-a1', { title: 'Mine now' }));
    getSession.mockResolvedValue(stored()); // someone else's: another person, then an admin
    answers.push(await patch('member-b', { title: 'Mine now' }));
    answers.push(await patch('member-b', { pinned: true }));
    answers.push(await patch('admin', { title: 'Admin rename' }));
    answers.push(await patch('admin', { pinned: true }));
    // The body as text: Hono's own 404 for a route that does not exist is not this JSON (P113).
    for (const res of answers) {
      expect(res.status).toBe(404);
      expect(await res.text()).toBe(JSON.stringify({ error: 'not_found' }));
    }
    expect(setConversationMeta).not.toHaveBeenCalled();

    // The row vanished (or changed hands) between the read and the write: the same refusal.
    setConversationMeta.mockResolvedValue(false);
    const raced = await patch('member-a1', { title: 'Too late' });
    expect(raced.status).toBe(404);
    expect(await raced.text()).toBe(JSON.stringify({ error: 'not_found' }));
  });

  it('P6 a title is trimmed and capped and an empty title clears it', async () => {
    expect((await patch('member-a1', { title: '   Budget review   ' })).status).toBe(200);
    expect(setConversationMeta).toHaveBeenLastCalledWith(AGENT, CHAT, OWNER, { title: 'Budget review' });

    expect((await patch('member-a1', { title: 'x'.repeat(120) })).status).toBe(200);
    for (const bad of ['x'.repeat(121), 'bell\u0007inside', 'line\nbreak']) {
      const res = await patch('member-a1', { title: bad });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid_title' });
    }
    const invalidPin = await patch('member-a1', { pinned: 'yes' });
    expect(invalidPin.status).toBe(400);
    expect(await invalidPin.json()).toEqual({ error: 'invalid_pinned' });
    const nothing = await patch('member-a1', {});
    expect(nothing.status).toBe(400);
    expect(await nothing.json()).toEqual({ error: 'nothing_to_update' });

    setConversationMeta.mockClear();
    for (const empty of ['   ', null]) {
      const res = await patch('member-a1', { title: empty });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ title: null });
    }
    expect(setConversationMeta.mock.calls.map((c) => c[3])).toEqual([{ title: null }, { title: null }]);
  });

  it('P6 pinned conversations are listed even past the newest fifty', async () => {
    const pinned = await patch('member-a1', { pinned: true });
    expect(pinned.status).toBe(200);
    expect(await pinned.json()).toMatchObject({ pinned: true });
    expect(setConversationMeta).toHaveBeenCalledWith(AGENT, CHAT, OWNER, { pinned: true });

    // Sixty conversations; the OLDEST is pinned, so the newest fifty alone would drop it.
    send.mockResolvedValue({
      Items: Array.from({ length: 60 }, (_, i) => row(i, i === 0 ? { pinned: true, title: 'Pinned budget' } : {})),
    });
    const { status, sessions } = await list();
    expect(status).toBe(200);
    expect(sessions).toHaveLength(51);
    const kept = sessions.find((s) => s.chatId === 'dashboard:1750000001000');
    expect(kept).toMatchObject({ pinned: true, title: 'Pinned budget' });
    expect(sessions.filter((s) => !s.pinned)).toHaveLength(50);
  });

  it('P6 the list search matches a title word before the newest fifty', async () => {
    // Sixty conversations: two old ones match "budget" — one by its title, one by its first
    // message — and both are older than the newest fifty.
    send.mockResolvedValue({
      Items: Array.from({ length: 60 }, (_, i) =>
        row(i, i === 3 ? { title: 'Budget review' } : i === 5 ? { firstMessage: 'What about the BUDGET?' } : {})),
    });
    const { status, sessions } = await list('&q=budget');
    expect(status).toBe(200);
    expect(sessions.map((s) => s.chatId).sort()).toEqual(['dashboard:1750000001003', 'dashboard:1750000001005']);
  });

  it('P6 the list search is bounded and matched as plain text', async () => {
    const tooLong = await list(`&q=${'a'.repeat(101)}`);
    expect(tooLong.status).toBe(400);

    send.mockResolvedValue({ Items: [row(1, { title: 'Costs (Q3)' }), row(2, { title: 'Anything at all' })] });
    const literal = await list(`&q=${encodeURIComponent('(Q3)')}`);
    expect(literal.sessions.map((s) => s.chatId)).toEqual(['dashboard:1750000001001']);
    const pattern = await list(`&q=${encodeURIComponent('.*')}`);
    expect(pattern.status).toBe(200);
    expect(pattern.sessions).toEqual([]);
  });
});
