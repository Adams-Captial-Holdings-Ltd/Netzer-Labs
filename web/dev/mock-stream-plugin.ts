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
const mockAgents = {
  agents: [
    { id: 'main', displayName: 'Netzar Prime', status: 'active' },
    { id: 'analyst', displayName: 'Research Analyst', status: 'active' },
    { id: 'ops', displayName: 'Ops Engineer', status: 'active' },
    { id: 'legacy', displayName: 'Retired Assistant', status: 'inactive' },
  ],
};

// Sidebar rows. Only `dashboard:`-prefixed chats are browsable (Chat.tsx
// filters on the prefix), so one non-dashboard row is included to prove the
// filter, and the timestamps are relative so the date grouping in a later
// phase has something real to group.
function mockSessions(): unknown {
  const hour = 3_600_000;
  const now = Date.now();
  return {
    sessions: [
      { agentId: 'main', chatId: `dashboard:${now - hour}`, updatedAt: now - hour, messageCount: 6, firstMessage: 'Wiring the turn stream' },
      { agentId: 'main', chatId: `dashboard:${now - 26 * hour}`, updatedAt: now - 26 * hour, messageCount: 4, firstMessage: 'Quarterly posture review' },
      { agentId: 'main', chatId: `dashboard:${now - 96 * hour}`, updatedAt: now - 96 * hour, messageCount: 12, firstMessage: 'Why did the deploy fail?' },
      { agentId: 'main', chatId: `telegram:2201`, updatedAt: now - 2 * hour, messageCount: 3, firstMessage: 'not browsable here' },
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
