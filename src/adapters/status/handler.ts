/**
 * Hono router for the public status page (D5).
 *
 * Routes:
 *   GET /status            HTML page, no auth, 30s cache
 *   GET /status/data.json  JSON shape for tooling, no auth, 30s cache
 *
 * Both endpoints are intentionally public — a status page that
 * requires credentials is useless during an incident. The data shown
 * is account-internal but non-sensitive (alarm names, deploy
 * timestamps, uptime ratio). Anything user-bearing lives behind the
 * existing bearer-auth API.
 *
 * Caching: 30s Cache-Control + a small in-memory memo so a polled
 * status page from a heavily-shared dashboard does not hammer
 * CloudWatch/CFN.
 */

import { Hono } from 'hono';
import { assembleStatusData, type StatusData } from './data.js';
import { renderStatusPage } from './view.js';

const MEMO_MS = 30_000;
let memo: { at: number; data: StatusData } | null = null;

/** Test seam: clear the memo so subsequent calls re-fetch. */
export function __resetStatusMemo(): void {
  memo = null;
}

async function getCached(): Promise<StatusData> {
  if (memo && Date.now() - memo.at < MEMO_MS) return memo.data;
  const data = await assembleStatusData();
  memo = { at: Date.now(), data };
  return data;
}

export function buildStatusRouter(): Hono {
  const app = new Hono();

  app.get('/', async (c) => {
    const data = await getCached();
    c.header('Cache-Control', `public, max-age=${MEMO_MS / 1000}`);
    return c.html(renderStatusPage(data));
  });

  app.get('/data.json', async (c) => {
    const data = await getCached();
    c.header('Cache-Control', `public, max-age=${MEMO_MS / 1000}`);
    return c.json(data);
  });

  return app;
}
