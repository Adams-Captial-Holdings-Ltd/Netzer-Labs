// Dev-only mock of the chat turn stream. When the dev server is started with
// CCE_CHAT_MOCK=1, POST /api/test-turn/stream is answered locally with
// scripted SSE fixtures at a realistic cadence instead of being proxied to the
// orchestrator — the only way to see true token-by-token streaming and tool
// events on a developer machine, where the Floci Bedrock stub emits a single
// chunk and can never reach tool dispatch (development.md, known limitations).
//
// Never part of a production build: `apply: 'serve'` restricts the plugin to
// the dev server, and vite.config.ts additionally only registers it when the
// env var is set. Middleware is registered in the configureServer hook BODY,
// which runs BEFORE Vite's internal middlewares — including the /api proxy —
// so the mock wins the route while the rest of /api still proxies normally.

import type { ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { fixtures } from './fixtures';

/** 30-80ms between events: fast enough to feel live, slow enough to watch. */
function cadence(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 30 + Math.random() * 50));
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
    await cadence();
    if (res.destroyed || res.writableEnded) return; // client went away mid-stream
    sseWrite(res, ev.event, ev.data);
  }
  res.end();
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
    },
  };
}
