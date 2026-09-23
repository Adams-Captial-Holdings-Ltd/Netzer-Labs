import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { TokenPrincipal } from '../../lib/auth/dashboard-auth.js';

/**
 * WI-1.2 — the conversation listings once every message is a row too.
 *
 * The WI-1.0 review found two things the containment gate left open, both
 * carried here: a reader that stops after a fixed number of ITEMS undercounts
 * conversations as soon as a partition fills with message rows, and nothing
 * said so when it happened. The per-agent list stopped at 1,000 items; the
 * cross-agent list, the CSV export's ceiling and the jarvis action counted
 * items too. A153 is also closed here: nothing pinned the PK half of
 * isConversationRow.
 */

const { authenticateDashboardToken, send } = vi.hoisted(() => ({
  authenticateDashboardToken: vi.fn(),
  send: vi.fn(),
}));

const OPERATOR: TokenPrincipal = { tokenHash: 'hash-operator', label: 'operator', hashPrefix16: 'operator', role: 'operator' };

vi.mock('../../lib/auth/dashboard-auth.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/auth/dashboard-auth.js')>();
  return {
    ...actual,
    extractBearerToken: (h?: string) => (h ?? '').replace(/^Bearer\s+/i, ''),
    authenticateDashboardToken: (raw: string) => authenticateDashboardToken(raw),
  };
});
vi.mock('../../lib/state/ddb.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/state/ddb.js')>();
  return { ...actual, ddb: () => ({ send }) };
});
vi.mock('../../lib/state/kill-switches-repo.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/state/kill-switches-repo.js')>();
  return { ...actual, isKillSwitchActive: () => Promise.resolve({ active: false }) };
});
vi.mock('../../observability/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  truncateForLog: (s: string) => s,
}));

import { buildDashboardRouter, isConversationRow, readConversationRows } from './handler.js';
import { executeQueryTool } from './jarvis.js';

const AGENT = 'main';
const SESSIONS_TABLE = process.env.TABLE_SESSIONS ?? 'claudeclaw-sessions';
const MINE = 'dashboard:hash-operator';

const conversationRow = (n: number) => ({
  PK: `AGENT#${AGENT}`, SK: `CHAT#dashboard:${n}`, updatedAt: n, userId: MINE, firstMessage: `chat ${n}`,
});
const messageRow = (n: number) => ({
  PK: `AGENT#${AGENT}`, SK: `CHAT#dashboard:0#MSG#${String(n).padStart(10, '0')}`, userId: MINE,
});

/**
 * Pages of the sessions table: a FULL first page of message rows (a busy
 * conversation), then a page holding the conversations. A reader that counts
 * items stops after page one and lists nothing.
 */
const PAGES = [
  { Items: Array.from({ length: 1000 }, (_, i) => messageRow(i)), LastEvaluatedKey: { PK: 'p', SK: '1' } },
  { Items: Array.from({ length: 10 }, (_, i) => conversationRow(i + 1)) },
];

function answerFromPages(pages: typeof PAGES) {
  send.mockImplementation(async (cmd: { input?: Record<string, unknown> }) => {
    const input = cmd.input ?? {};
    if (input.TableName !== SESSIONS_TABLE) return {};
    return input.ExclusiveStartKey ? pages[1] : pages[0];
  });
}

const app = () => {
  const a = new Hono();
  a.route('/api', buildDashboardRouter());
  return a;
};
const get = (path: string) => app().request(path, { headers: { Authorization: 'Bearer operator' } });

beforeEach(() => {
  send.mockReset();
  authenticateDashboardToken.mockImplementation(async (raw: string) => (raw === 'operator' ? OPERATOR : null));
  answerFromPages(PAGES);
});

describe('the listings read past message rows (WI-1.2, the WI-1.0 review finding)', () => {
  it('per-agent GET /sessions lists every conversation even behind a full page of message rows', async () => {
    const body = (await (await get(`/api/sessions?agentId=${AGENT}`)).json()) as { sessions: unknown[]; truncated: boolean };

    expect(body.sessions).toHaveLength(10);
    expect(body.truncated).toBe(false);
  });

  it('cross-agent GET /sessions lists every conversation even behind a full page of message rows', async () => {
    const body = (await (await get('/api/sessions')).json()) as { sessions: unknown[] };

    expect(body.sessions).toHaveLength(10);
  });

  it('the CSV export carries every conversation even behind 10,000+ message rows', async () => {
    // The export's old ceiling was 10,000 ITEMS, so one PAGE of messages could
    // not trip it — eleven can: every conversation sat beyond the ceiling and
    // the file came out with none of them.
    send.mockImplementation(async (cmd: { input?: Record<string, unknown> }) => {
      const input = cmd.input ?? {};
      if (input.TableName !== SESSIONS_TABLE) return {};
      const page = Number((input.ExclusiveStartKey as { page?: number } | undefined)?.page ?? 0);
      if (page < 11) {
        return {
          Items: Array.from({ length: 1000 }, (_, i) => messageRow(page * 1000 + i)),
          LastEvaluatedKey: { page: page + 1 },
        };
      }
      return { Items: Array.from({ length: 10 }, (_, i) => conversationRow(i + 1)) };
    });

    const res = await get('/api/sessions/export');

    expect(res.headers.get('X-Export-Row-Count')).toBe('10');
    expect(res.headers.get('X-Export-Truncated')).toBe('false');
  });

  it('the jarvis sessions action counts every conversation even behind a full page of message rows', async () => {
    const out = await executeQueryTool(OPERATOR, 'sessions', {});

    expect((out as { ok: true; result: { count: number } }).result.count).toBe(10);
  });
});

describe('readConversationRows — a dropped row is never silent', () => {
  it('says truncated when it stops at its ceiling instead of ending quietly', async () => {
    // A table that never runs out: every page is full and points at another.
    send.mockImplementation(async () => ({
      Items: Array.from({ length: 1000 }, (_, i) => messageRow(i)),
      LastEvaluatedKey: { PK: 'p', SK: 'next' },
    }));

    const out = await readConversationRows('PK, SK');

    expect(out.truncated).toBe(true);
    expect(send.mock.calls.length).toBeGreaterThan(1);
  });

  it('says not truncated when it reads to the end', async () => {
    const out = await readConversationRows('PK, SK', AGENT);

    expect(out.rows).toHaveLength(10);
    expect(out.truncated).toBe(false);
  });
});

describe('isConversationRow — both halves pinned (A153)', () => {
  it('rejects a CHAT# sort key outside an AGENT# partition', () => {
    // The SK half already rejects every fixture the containment suite has, so
    // replacing the PK half with `true` used to keep the gate green (A153).
    expect(isConversationRow({ PK: 'JARVIS#a1b2c3d4e5f60718', SK: 'CHAT#dashboard:1' })).toBe(false);
    expect(isConversationRow({ PK: 'AGENT#main', SK: 'CHAT#dashboard:1' })).toBe(true);
  });
});
