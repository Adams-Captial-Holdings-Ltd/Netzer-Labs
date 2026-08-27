// Dev-only mock of the chat turn stream. When the dev server is started with
// CCE_CHAT_MOCK=1, POST /api/test-turn/stream is answered locally with
// scripted SSE fixtures at a realistic cadence instead of being proxied to the
// orchestrator — the only way to see true token-by-token streaming and tool
// events on a developer machine, where the Floci Bedrock stub emits a single
// chunk and can never reach tool dispatch (development.md, known limitations).
//
// It ALSO answers the three chat-page reads that cannot work on a developer
// machine: /agents, /sessions and /sessions/transcript are DynamoDB-backed and
// return `{"error":"internal_error"}` against a local orchestrator with no
// table. Chat.tsx treats an /agents failure as fatal (it sets loadError and
// send() early-returns without an agent), so without these the chat surface
// can never be driven or screenshotted locally — which is exactly how a
// capture run ends up with no pixels of the chat. /whoami and /models are NOT
// mocked: they work locally, and leaving them real keeps the captured surface
// talking to the actual dashboard API for identity and the model picker.
//
// Never part of a production build: `apply: 'serve'` restricts the plugin to
// the dev server, and vite.config.ts additionally only registers it when the
// env var is set. Middleware is registered in the configureServer hook BODY,
// which runs BEFORE Vite's internal middlewares — including the /api proxy —
// so the mock wins the route while the rest of /api still proxies normally.

import type { ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { fixtures } from './fixtures';

/**
 * 30-80ms between events: fast enough to feel live, slow enough to watch. An
 * event may override it with `delayMs` — tool dispatch on the real backend
 * costs hundreds of milliseconds per call, and a fixture that fires tool events
 * at token cadence makes the live status line unobservable (see fixtures.ts).
 */
function cadence(delayMs?: number): Promise<void> {
  const ms = delayMs ?? 30 + Math.random() * 50;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Frame one SSE event; multi-line data becomes repeated `data:` lines. */
function sseWrite(res: ServerResponse, event: string, data: string): void {
  const lines = data.split('\n').map((l) => `data: ${l}`).join('\n');
  res.write(`event: ${event}\n${lines}\n\n`);
}

async function play(rawBody: string, res: ServerResponse): Promise<void> {
  // Fixture selection: "/fixture <name>" picks one by name, anything else
  // (including an unknown name or an unparseable body) plays "default".
  let text = '';
  try {
    text = String((JSON.parse(rawBody) as { text?: unknown }).text ?? '');
  } catch { /* no body or not JSON — play the default fixture */ }
  const name = text.startsWith('/fixture ') ? text.slice('/fixture '.length).trim() : 'default';
  const fixture = fixtures[name] ?? fixtures.default;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  for (const ev of fixture) {
    await cadence(ev.delayMs);
    if (res.destroyed || res.writableEnded) return; // client went away mid-stream
    sseWrite(res, ev.event, ev.data);
  }
  res.end();
}

/** Send a JSON body with the shape the real route returns. */
function json(res: ServerResponse, body: unknown): void {
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

// The roster the chat page reads on mount. `status` matters: Chat.tsx filters
// to active only, so the inactive row here is a live check that the filter
// still holds (it must never appear in the picker).
//
// The roster is DELIBERATELY long. It is the platform's own seventeen agent
// templates (verbatim from GET /agents/templates — same ids, display names and
// descriptions) standing in as deployed agents, plus the house agent and one
// retired row. A four-row fixture cannot tell you whether the agent picker is
// usable, because at four rows every picker is: the search field, the
// scrolling list and the descriptor line only start earning their place at the
// length a real deployment actually reaches. `description` is a field /agents
// has always returned; the old fixture just omitted it, so the picker had
// nothing to render and no second search axis to match on.
const mockAgents = {
  agents: [
    { id: 'main', displayName: 'Netzar Prime', status: 'active', description: 'The house agent — general work, full tool access, every kill switch honoured.' },
    { id: 'blank', displayName: 'Blank Agent', status: 'active', description: 'Minimal agent with no specialized behavior.' },
    { id: 'comms', displayName: 'Communications', status: 'active', description: 'Email, messaging, and stakeholder communication.' },
    { id: 'content', displayName: 'Content Creator', status: 'active', description: 'Writing, editing, and content strategy.' },
    { id: 'ops', displayName: 'Operations', status: 'active', description: 'Scheduling, billing, and operational tasks.' },
    { id: 'research', displayName: 'Research', status: 'active', description: 'Deep research, analysis, and synthesis.' },
    { id: 'due-diligence', displayName: 'Due Diligence Analyst', status: 'active', description: 'Deal screening, document review, and risk surfacing for investment teams.' },
    { id: 'lp-update', displayName: 'LP Update Drafter', status: 'active', description: 'Investor letters, quarterly updates, and capital-call notices in your voice.' },
    { id: 'deal-memo', displayName: 'Deal Memo Summarizer', status: 'active', description: 'Turn meeting notes, transcripts, and data rooms into tight IC-ready memos.' },
    { id: 'grant-writer', displayName: 'Grant Writer', status: 'active', description: 'Proposals, LOIs, and funder reports for nonprofits, grounded in your documents.' },
    { id: 'compliance-reviewer', displayName: 'Compliance Reviewer', status: 'active', description: 'Policy checks, document review, and audit-prep against your indexed policies.' },
    { id: 'exec-assistant', displayName: 'Executive Assistant', status: 'active', description: 'Inbox triage, briefings, scheduling, and follow-up tracking for a busy principal.' },
    { id: 'support', displayName: 'Customer Support', status: 'active', description: 'Front-line customer support grounded in your help docs, with clean human handoff.' },
    { id: 'sdr', displayName: 'Sales Development Rep', status: 'active', description: 'Qualify inbound leads, draft outreach, and book the calls worth taking.' },
    { id: 'social', displayName: 'Social Media Manager', status: 'active', description: 'Plan the calendar and repurpose one idea across every platform.' },
    { id: 'marketing-strategist', displayName: 'Marketing Strategist', status: 'active', description: 'Positioning, offers, and launch plans that brief the rest of the fleet.' },
    { id: 'community-manager', displayName: 'Community Manager', status: 'active', description: 'Welcome members, answer recurring questions, and surface who is at risk of churning.' },
    { id: 'bookkeeper', displayName: 'Bookkeeper', status: 'active', description: 'Categorize transactions, chase invoices, and explain the numbers in plain English.' },
    { id: 'legacy', displayName: 'Retired Assistant', status: 'inactive', description: 'Decommissioned. Must never appear in the picker.' },
  ],
};

// Sidebar rows. Only `dashboard:`-prefixed chats are browsable (Chat.tsx
// filters on the prefix), so one non-dashboard row is included to prove the
// filter.
//
// UNITS: `updatedAt` is EPOCH SECONDS. That is what the real route returns —
// `src/lib/state/sessions-repo.ts` documents the field as "epoch seconds" and
// writes it that way — and it is what `relativeAge()` reads. This fixture used
// to emit `Date.now()` milliseconds, which made every row's age arithmetic go
// negative and clamp to "now": three rows an hour, a day and four days apart
// all rendered identically, and the date grouping this phase adds would have
// filed every one of them under a year ~55,000 years hence. The `chatId`
// suffix stays in MILLISECONDS, because that is what `freshChatId()` mints
// (`dashboard:${Date.now()}`) and the two fields genuinely differ.
//
// The spread is deliberate: enough rows on both sides of every boundary the
// grouping ladder tests — today, yesterday, inside seven days, inside thirty,
// and earlier than that — so a screenshot of the sidebar shows real groups
// rather than one heading with everything under it.
//
// IDENTITY: `chatId` is a FIXED string per row, not derived from `Date.now()`.
// It used to be `dashboard:${now - hoursAgo * hour}`, which minted a different
// id on every request — so the row you had open stopped existing the moment
// anything called GET /sessions again (send() and the delete path both do,
// right after `clearApiCache()`), the sidebar's active marker went out, and
// reopening it 404'd. `updatedAt` stays relative to the live clock, because
// that is what has to keep moving for the date groups to mean anything.
const SESSION_ID_BASE = 1_750_000_000_000;

function mockSessions(): unknown {
  const hourMs = 3_600_000;
  const nowMs = Date.now();
  // hours ago, messageCount, opening line
  const rows: Array<[number, number, string]> = [
    [1, 6, 'Wiring the turn stream'],
    [4, 18, 'Draft the incident note for the cost-cap trip'],
    [9, 2, 'Which model is the LP update agent on?'],
    [26, 4, 'Quarterly posture review'],
    [30, 7, 'Kill-switch audit rows from yesterday'],
    [72, 11, 'Why did the deploy fail?'],
    [96, 12, 'Compare Opus 1M and Sonnet 1M on the diligence pack'],
    [24 * 12, 5, 'Grant narrative for the Q3 renewal'],
    [24 * 21, 9, 'Reconcile the August invoice exceptions'],
    [24 * 64, 3, 'First pass at the compliance control catalogue'],
  ];
  return {
    sessions: [
      ...rows.map(([hoursAgo, messageCount, firstMessage], i) => ({
        agentId: 'main',
        chatId: `dashboard:${SESSION_ID_BASE + i}`,
        updatedAt: Math.floor((nowMs - hoursAgo * hourMs) / 1000),
        messageCount,
        firstMessage,
      })),
      {
        agentId: 'main',
        chatId: 'telegram:2201',
        updatedAt: Math.floor((nowMs - 2 * hourMs) / 1000),
        messageCount: 3,
        firstMessage: 'not browsable here',
      },
    ],
  };
}

export function mockStreamPlugin(): Plugin {
  return {
    name: 'cce-chat-mock-stream',
    apply: 'serve', // dev server only — this plugin cannot enter a build
    configureServer(server) {
      server.middlewares.use('/api/test-turn/stream', (req, res, next) => {
        if (req.method !== 'POST') return next();
        let raw = '';
        req.on('data', (c: Buffer) => { raw += c; });
        req.on('end', () => { void play(raw, res); });
      });

      // Mounted BEFORE '/api/sessions' — connect matches on prefix, so the
      // longer path has to be registered first or the list route swallows it.
      server.middlewares.use('/api/sessions/transcript', (req, res, next) => {
        if (req.method !== 'GET') return next();
        // Reopening a stored conversation replays turns; an empty array is the
        // honest answer for a chat this process never persisted.
        json(res, { turns: [] });
      });

      server.middlewares.use('/api/sessions', (req, res, next) => {
        // Only the list GET is mocked. DELETE keeps proxying, so the delete
        // flow is still exercised against the real route.
        if (req.method !== 'GET') return next();
        json(res, mockSessions());
      });

      server.middlewares.use('/api/agents', (req, res, next) => {
        // connect strips the mount path, so the roster read arrives as '/'.
        // Anything deeper is an agent-detail route — let it proxy through.
        const path = (req.url ?? '/').split('?')[0];
        if (req.method !== 'GET' || path !== '/') return next();
        json(res, mockAgents);
      });
    },
  };
}
