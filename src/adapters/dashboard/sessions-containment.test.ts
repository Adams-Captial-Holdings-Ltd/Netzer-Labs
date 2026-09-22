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

const AGENT = 'main';
const CHAT = 'dashboard:1750000000000';
const OWNER = 'dashboard:hash-operator';

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

/** Items the mocked sessions Query returns for this test. */
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
});
