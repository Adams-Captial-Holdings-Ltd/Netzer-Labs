/**
 * P7 (step 9) — work order D: rename accepts a title padded with non-ASCII
 * spaces (A231; council 3-0 keep-and-trim, pin it).
 *
 * Written BEFORE the change, as the bar (netzar-chat-plan/p7-proof.sh row M-1).
 * Follows src/adapters/dashboard/sessions-meta.p6.test.ts's harness (the real
 * buildDashboardRouter with the sessions repo's reads/writes mocked).
 *
 * The decided design (the P6 log, docs/features/netzar-chat/handoffs/
 * 2026-09-27-p6-one-shot.md lines 1969-1982; A231): `PATCH /sessions` with a
 * title padded by non-ASCII spaces (U+00A0 no-break space, U+3000 ideographic
 * space, U+2000-U+200A the en/em/thin space family) answers 200 and stores
 * and returns the TRIMMED title.
 *
 * This behaviour ALREADY EXISTS: handler.ts's PATCH /sessions does
 * `title = typeof body.title === 'string' ? body.title.trim() || null : null`
 * (~:2643), and JS's String.prototype.trim() strips every Unicode
 * "White_Space" code point, not only ASCII space — so a title padded with
 * these characters is already trimmed and accepted today. Red is therefore
 * impossible by construction (M41/P54 excepts a pin of behaviour that
 * already exists): this test is proved by a TEMPORARY mutation of
 * handler.ts (dropping the `.trim()`), run alone to record the failure at
 * the assertion below, then handler.ts is restored exactly. The mutation and
 * its failure message are logged in the D commit's log directory (P28).
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
const CHAT = 'dashboard:1750000000900';
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

describe('P7 sessions-meta — a title padded with non-ASCII spaces', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    authenticateDashboardToken.mockImplementation(async (raw: string) => PRINCIPALS[raw] ?? null);
    getSession.mockResolvedValue(stored());
    setConversationMeta.mockResolvedValue(true);
    writeAudit.mockResolvedValue(undefined);
    send.mockResolvedValue({ Items: [] });
  });

  it('P7 a title padded with non ASCII spaces is trimmed and accepted', async () => {
    // U+00A0 (NBSP) and U+3000 (ideographic space) lead; U+2003 (em space, one
    // of the U+2000-U+200A family) and U+2000 (en quad) trail. All are Unicode
    // "White_Space", none is ASCII space.
    const padded = ' 　Budget review  ';
    const res = await patch('member-a1', { title: padded });
    const body = await res.json();
    expect([res.status, body], `response: ${JSON.stringify(body)}`)
      .toEqual([200, { agentId: AGENT, chatId: CHAT, title: 'Budget review', pinned: false }]);
    expect(setConversationMeta).toHaveBeenCalledWith(AGENT, CHAT, OWNER, { title: 'Budget review' });
  });
});
