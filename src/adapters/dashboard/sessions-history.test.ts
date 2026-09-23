import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { TokenPrincipal } from '../../lib/auth/dashboard-auth.js';
import { createFakeDynamo } from '../../__test-utils__/fake-dynamo.js';

/**
 * WI-1.3 — reopening a conversation shows ALL of it, and deleting one deletes
 * all of it.
 *
 * Before P1 a conversation was one row whose `turns` held at most 20 turns, so
 * the transcript route could only ever return the replay window. P1 keeps every
 * message as its own record beside the conversation; this drives the REAL
 * router and the REAL sessions repository against an in-memory table
 * (src/__test-utils__/fake-dynamo.ts), so the route, the repository and the key
 * shapes are exercised together.
 */

const { authenticateDashboardToken, send, writeAudit } = vi.hoisted(() => ({
  authenticateDashboardToken: vi.fn(),
  send: vi.fn(),
  writeAudit: vi.fn(),
}));

const OWNER: TokenPrincipal = {
  tokenHash: 'hash-login-1', label: 'member:a', hashPrefix16: 'login1', role: 'operator',
  profileId: 'operator', userId: 'user-a',
};

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
vi.mock('../../lib/audit/audit-writer.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/audit/audit-writer.js')>();
  return { ...actual, writeAudit: (e: unknown) => writeAudit(e) };
});
vi.mock('../../lib/state/kill-switches-repo.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/state/kill-switches-repo.js')>();
  return { ...actual, isKillSwitchActive: () => Promise.resolve({ active: false }) };
});
vi.mock('../../observability/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  truncateForLog: (s: string) => s,
}));

import { buildDashboardRouter } from './handler.js';

const AGENT = 'main';
const CHAT = 'dashboard:1750000000000';
let table: ReturnType<typeof createFakeDynamo>;

function app() {
  const a = new Hono();
  a.route('/api', buildDashboardRouter());
  return a;
}
const call = (path: string, init: RequestInit = {}) =>
  app().request(path, { ...init, headers: { Authorization: 'Bearer owner' } });

/**
 * A conversation 30 turns long, stored the way P1 stores it: every message as
 * its own record, and the newest 20 also in the conversation row's window.
 */
function seedLongConversation() {
  const text = (seq: number) => `${seq % 2 ? 'answer' : 'question'} ${seq}`;
  const role = (seq: number) => (seq % 2 ? 'assistant' : 'user');
  for (let seq = 0; seq < 30; seq++) {
    table.rows.set(`AGENT#${AGENT}|CHAT#${CHAT}#MSG#${String(seq).padStart(10, '0')}`, {
      PK: `AGENT#${AGENT}`,
      SK: `CHAT#${CHAT}#MSG#${String(seq).padStart(10, '0')}`,
      seq, role: role(seq), text: text(seq), ts: seq, userId: 'dashboard:user:user-a',
    });
  }
  table.rows.set(`AGENT#${AGENT}|CHAT#${CHAT}`, {
    PK: `AGENT#${AGENT}`,
    SK: `CHAT#${CHAT}`,
    turns: Array.from({ length: 20 }, (_, i) => ({ role: role(i + 10), text: text(i + 10), ts: i + 10 })),
    turnsTotal: 30,
    userId: 'dashboard:user:user-a',
    version: 15,
  });
}

beforeEach(() => {
  table = createFakeDynamo();
  send.mockReset();
  send.mockImplementation(table.send);
  writeAudit.mockReset();
  authenticateDashboardToken.mockImplementation(async (raw: string) => (raw === 'owner' ? OWNER : null));
});

describe('GET /sessions/transcript — full history (WI-1.3, AC-1.3-1)', () => {
  it('the transcript route returns history beyond the window, oldest first', async () => {
    seedLongConversation();

    const res = await call(`/api/sessions/transcript?agentId=${AGENT}&chatId=${encodeURIComponent(CHAT)}`);
    const body = (await res.json()) as { turns: Array<{ text: string }>; truncated: boolean };

    expect(res.status).toBe(200);
    expect(body.turns).toHaveLength(30);
    expect(body.turns[0]?.text).toBe('question 0');
    expect(body.turns[29]?.text).toBe('answer 29');
    expect(body.truncated).toBe(false);
  });
});

describe('DELETE /sessions — the delete cascades (WI-1.3, AC-1.3-2)', () => {
  it('leaves no record of the conversation behind', async () => {
    seedLongConversation();

    const res = await call(`/api/sessions?agentId=${AGENT}&chatId=${encodeURIComponent(CHAT)}`, { method: 'DELETE' });

    expect(res.status).toBe(200);
    expect([...table.rows.keys()].filter((k) => k.includes(CHAT))).toEqual([]);
  });
});
