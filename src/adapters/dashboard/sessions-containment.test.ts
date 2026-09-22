import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { TokenPrincipal } from '../../lib/auth/dashboard-auth.js';

/**
 * WI-1.0 — the containment gate owner decision 11 makes a release gate:
 * "new item types in the existing sessions table, no CDK — ONLY AFTER WI-1.0
 * proves every legacy reader accepts solely AGENT#…/CHAT#…".
 *
 * P1 stores every message as its own record. Decision 11 keeps those records in
 * the EXISTING `claudeclaw-sessions` table, which is PK+SK with no GSI
 * (infra/lib/dynamo-stack.ts:93-99), so a message record has to live in the same
 * partition as its conversation: PK=AGENT#<agentId>, SK=CHAT#<chatId>#MSG#…
 *
 * GET /api/sessions?agentId=… reads that partition with a bare
 * `KeyConditionExpression: 'PK = :pk'` (handler.ts:2048-2055) and maps EVERY
 * returned item into a conversation row by stripping the key prefixes
 * (handler.ts:2073-2083). Nothing selects conversation rows specifically. So the
 * moment P1 writes its first message record, the Chat sidebar and the Sessions
 * tab start listing one phantom conversation per message.
 *
 * The gate is therefore a precondition, not a cleanup: it must hold BEFORE the
 * storage change lands, which is why it is WI-1.0 and not WI-1.4.
 *
 * Driven through the REAL buildDashboardRouter via app.request() with only the
 * DynamoDB client and token authentication stubbed, so the route's own mapping
 * code actually executes. `send` dispatches on the command's input rather than
 * returning one canned answer, so a capability lookup cannot be accidentally fed
 * the sessions fixture.
 */

const { authenticateDashboardToken, send } = vi.hoisted(() => ({
  authenticateDashboardToken: vi.fn(),
  send: vi.fn(),
}));

function principalFor(raw: string): TokenPrincipal | null {
  const role = raw.replace(/^Bearer\s+/i, '');
  if (role !== 'viewer' && role !== 'operator' && role !== 'admin') return null;
  return { tokenHash: `hash-${role}`, label: role, hashPrefix16: role, role };
}

// Keep the REAL capability resolution; stub only token extraction/authentication
// (the approach sessions-delete.test.ts and usage-all-agents.test.ts both use).
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

vi.mock('../../observability/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  truncateForLog: (s: string) => s,
}));

import { buildDashboardRouter } from './handler.js';
import { executeQueryTool } from './jarvis.js';

const AGENT = 'main';
const CHAT = 'dashboard:1750000000000';
const OWNER = 'dashboard:hash-operator';
const SESSIONS_TABLE = process.env.TABLE_SESSIONS ?? 'claudeclaw-sessions';

/** The conversation row as `appendTurns` writes it today. */
const CONVERSATION_ROW = {
  PK: `AGENT#${AGENT}`,
  SK: `CHAT#${CHAT}`,
  updatedAt: 1750000000,
  messageCount: 2,
  firstMessage: 'hello',
  createdAt: 1750000000,
  surface: 'dashboard',
  userId: OWNER,
};

/**
 * One per-message record of the shape P1 introduces. Same partition, sorted
 * after its conversation row, carrying its own owner.
 */
const MESSAGE_ROW = {
  PK: `AGENT#${AGENT}`,
  SK: `CHAT#${CHAT}#MSG#1750000000000#01J0`,
  updatedAt: 1750000000,
  createdAt: 1750000000,
  surface: 'dashboard',
  userId: OWNER,
};

/**
 * A jarvis long-term-memory row, which `jarvis-memory-repo.ts:75-85` ALREADY
 * writes into this same table today — P1 does not introduce the foreign type,
 * it only multiplies it. Carries exactly the attributes the sessions
 * projection would return for it: that row has no `updatedAt`, no
 * `messageCount` and no `userId`, and its `createdAt` is an ISO string rather
 * than the epoch seconds a conversation row carries.
 */
const JARVIS_MEMORY_ROW = {
  PK: 'JARVIS#a1b2c3d4e5f60718',
  SK: 'TURN#2026-09-22T00:00:00.000Z#8f14e45f-ceea-467a-9575-0e1b1c8b1e2d',
  createdAt: '2026-09-22T00:00:00.000Z',
};

/** Items the mocked sessions read returns for this test. */
let partition: Record<string, unknown>[] = [];

function makeApp() {
  const app = new Hono();
  app.route('/api', buildDashboardRouter());
  return app;
}

function listSessions(role = 'operator') {
  return makeApp().request(`/api/sessions?agentId=${AGENT}`, {
    headers: { Authorization: `Bearer ${role}` },
  });
}

/** No agentId — the cross-agent branch, which Scans instead of Querying. */
function listAllSessions(role = 'operator') {
  return makeApp().request('/api/sessions', {
    headers: { Authorization: `Bearer ${role}` },
  });
}

function exportSessions(role = 'operator') {
  return makeApp().request('/api/sessions/export', {
    headers: { Authorization: `Bearer ${role}` },
  });
}

const readJson = async (res: Response): Promise<{ sessions: { chatId: string }[] }> =>
  (await res.json()) as { sessions: { chatId: string }[] };

beforeEach(() => {
  authenticateDashboardToken.mockReset();
  send.mockReset();
  authenticateDashboardToken.mockImplementation(async (raw: string) => principalFor(raw));
  // Answer ONLY the sessions partition query with the planted items; anything
  // else (a capability/profile lookup) gets an empty result, so this fixture can
  // never stand in for a different read.
  send.mockImplementation(async (cmd: { input?: Record<string, unknown> }) => {
    const input = cmd?.input ?? {};
    if (input.KeyConditionExpression === 'PK = :pk') return { Items: partition };
    // The cross-agent list, the CSV export and the jarvis `sessions` action all
    // SCAN this table rather than querying one partition. Still discriminated on
    // the table name, so the fixture cannot stand in for a Scan of any other
    // table either.
    if (input.TableName === SESSIONS_TABLE && !input.KeyConditionExpression) {
      return { Items: partition };
    }
    return {};
  });
});

describe('GET /sessions — containment (WI-1.0)', () => {
  it('lists the conversation when its partition holds only the conversation row', async () => {
    // Control. Not the red: it passes today, and it is what shows the red below
    // is about containment rather than about auth, routing or the fixture.
    partition = [CONVERSATION_ROW];

    const res = await listSessions();

    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0]?.chatId).toBe(CHAT);
  });

  it('lists ONLY the conversation when the same partition also holds per-message rows', async () => {
    partition = [CONVERSATION_ROW, MESSAGE_ROW];

    const res = await listSessions();

    expect(res.status).toBe(200);
    const body = await readJson(res);
    // Stated as the positive claim — exactly one conversation, and it is THIS
    // one — rather than as "no MSG row appears". An absence assertion would pass
    // by construction against a reader that returned nothing at all (M48/M41).
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0]?.chatId).toBe(CHAT);
  });

  it('still lists a conversation from every surface that mints a chatId today', async () => {
    // Containment must not over-reject. A filter fails SILENTLY in this
    // direction — a conversation wrongly dropped looks exactly like one that
    // never existed — so the legitimate shapes are pinned here rather than
    // assumed. Each was read off its producer: `dashboard:<epochMs>`
    // (handler.ts safeDashboardChatId), `slack:<channel>:<user>` and
    // `user:<canonical>` (slack/handler.ts:162,352), and
    // `paperclip:<issueId>` (paperclip/dispatch-worker.ts:485). Telegram's is
    // deliberately absent: its producer was not located this session, so
    // asserting a shape for it would be a guess.
    //
    // KNOWN LIMIT, deliberately NOT asserted here because asserting it would
    // enshrine it: a chatId containing '#' is rejected by this rule. Two
    // producers can emit one — safeDashboardChatId returns an
    // already-prefixed id verbatim, and the Paperclip issueId is never
    // character-filtered. That is an open question for the owner, recorded in
    // the session log; it is not settled by this test.
    const shapes = [
      'dashboard:1750000000000',
      'slack:C01234ABCD:U09876ZYXW',
      'user:alice@example.com',
      'paperclip:ISSUE-123',
    ];
    partition = shapes.map((chatId) => ({ ...CONVERSATION_ROW, SK: `CHAT#${chatId}` }));

    const res = await listSessions();

    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.sessions.map((s) => s.chatId).sort()).toEqual([...shapes].sort());
  });

  it('lists ONLY conversations when the table also holds a foreign item type', async () => {
    // The cross-agent branch Scans the WHOLE table, so it sees every partition
    // — including jarvis memory. This is the rendering consequence the
    // specification could only INFER (A130); here it is measured.
    partition = [CONVERSATION_ROW, MESSAGE_ROW, JARVIS_MEMORY_ROW];

    const res = await listAllSessions();

    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0]?.chatId).toBe(CHAT);
    // Supporting evidence, never the proof: names what it used to render as, so
    // a future regression is recognisable rather than just a count being wrong.
    expect(body.sessions.map((s) => s.chatId)).not.toContain(JARVIS_MEMORY_ROW.SK);
  });
});

describe('GET /sessions/export — containment (WI-1.0)', () => {
  it('carries no row that is not a conversation', async () => {
    partition = [CONVERSATION_ROW, MESSAGE_ROW, JARVIS_MEMORY_ROW];

    const res = await exportSessions();

    expect(res.status).toBe(200);
    const lines = (await res.text()).split('\n').filter((l) => l !== '');
    // Header plus exactly one data row, and that row is the conversation.
    expect(lines).toHaveLength(2);
    expect(lines[1]?.startsWith(`${AGENT},${CHAT},`)).toBe(true);
    expect(res.headers.get('X-Export-Row-Count')).toBe('1');
  });
});

describe('jarvis sessions action — containment (WI-1.0)', () => {
  it('lists only conversations', async () => {
    partition = [CONVERSATION_ROW, MESSAGE_ROW, JARVIS_MEMORY_ROW];
    const principal = principalFor('viewer');
    expect(principal).not.toBeNull();

    const out = await executeQueryTool(principal!, 'sessions', {});

    expect(out.ok).toBe(true);
    const result = (out as { ok: true; result: { count: number; sessions: { chatId: string }[] } })
      .result;
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]?.chatId).toBe(CHAT);
    expect(result.count).toBe(1);
  });
});
