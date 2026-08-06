/**
 * Serves the dashboard SPA.
 *
 * Two modes:
 *   1. Vite-built Preact SPA from `dist/web/` (production).
 *   2. Legacy vanilla JS from `src/adapters/dashboard/public/` (fallback).
 *
 * Vite assets are hashed (index-BKVagi7F.css) so we serve them with
 * immutable cache headers. The SPA shell (index.html) is not cached.
 *
 * Auth is NOT enforced here. The SPA is just static HTML/JS; all real
 * data flows through /api/* which enforces the bearer-token check.
 */

import { Hono } from 'hono';
import { readFile } from 'node:fs/promises';
import { dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

const VITE_DIRS = [
  join(here, '..', '..', '..', 'dist', 'web'),
  join(here, '..', '..', 'web'),
];

const LEGACY_DIRS = [
  join(here, 'public'),
  join(here, '..', '..', '..', 'src', 'adapters', 'dashboard', 'public'),
];

const cache = new Map<string, { body: Uint8Array<ArrayBuffer>; contentType: string }>();

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

async function tryLoad(dirs: string[], name: string): Promise<string | null> {
  for (const dir of dirs) {
    try {
      return await readFile(join(dir, name), 'utf8');
    } catch {
      // try next
    }
  }
  return null;
}

/**
 * Byte-preserving variant for /assets/*: the MIME table includes binary
 * types (png/ico, fonts next), and a utf8 read corrupts those irreversibly
 * (invalid sequences become U+FFFD) while still serving a 200.
 */
async function tryLoadBytes(dirs: string[], name: string): Promise<Uint8Array<ArrayBuffer> | null> {
  for (const dir of dirs) {
    try {
      return new Uint8Array(await readFile(join(dir, name)));
    } catch {
      // try next
    }
  }
  return null;
}

export function buildDashboardSpaRouter(): Hono {
  const router = new Hono();

  const serveViteIndex = async (c: { body: (body: string, status: number, headers: Record<string, string>) => Response }) => {
    const body = await tryLoad(VITE_DIRS, 'index.html');
    if (body) {
      return c.body(body, 200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache',
      });
    }
    const legacy = await tryLoad(LEGACY_DIRS, 'index.html');
    if (legacy) {
      return c.body(legacy, 200, { 'Content-Type': 'text/html; charset=utf-8' });
    }
    return c.body('dashboard not found', 404, { 'Content-Type': 'text/plain' });
  };

  router.get('/', serveViteIndex);
  router.get('', serveViteIndex);

  router.get('/assets/*', async (c) => {
    const path = c.req.path.replace('/dashboard', '');
    const cached = cache.get(path);
    if (cached) {
      return c.body(cached.body, 200, {
        'Content-Type': cached.contentType,
        'Cache-Control': 'public, max-age=31536000, immutable',
      });
    }
    const body = await tryLoadBytes(VITE_DIRS, path);
    if (!body) return c.body('not found', 404, { 'Content-Type': 'text/plain' });
    const ct = MIME[extname(path)] ?? 'application/octet-stream';
    cache.set(path, { body, contentType: ct });
    return c.body(body, 200, {
      'Content-Type': ct,
      'Cache-Control': 'public, max-age=31536000, immutable',
    });
  });

  // Legacy vanilla JS SPA assets (backward compatible)
  router.get('/app.js', async (c) => {
    const body = await tryLoad(LEGACY_DIRS, 'app.js');
    if (!body) return c.body('not found', 404, { 'Content-Type': 'text/plain' });
    return c.body(body, 200, { 'Content-Type': 'application/javascript; charset=utf-8' });
  });
  router.get('/style.css', async (c) => {
    const body = await tryLoad(LEGACY_DIRS, 'style.css');
    if (!body) return c.body('not found', 404, { 'Content-Type': 'text/plain' });
    return c.body(body, 200, { 'Content-Type': 'text/css; charset=utf-8' });
  });

  router.get('/healthz', (c) => c.text('ok'));

  // SPA catch-all: any unmatched GET under /dashboard serves index.html
  // so client-side routing (wouter) works on refresh.
  router.get('/*', serveViteIndex);

  return router;
}
