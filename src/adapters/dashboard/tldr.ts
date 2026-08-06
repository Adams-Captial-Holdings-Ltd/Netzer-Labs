/**
 * TLDR router — one-line AI summaries of a dashboard tab's current data, for
 * the "at a glance" toolbar at the top of each page. Mounted at /api/tldr.
 *
 *   POST /  { tab: string, data: unknown } -> { summary: string, cached?: bool }
 *
 * The frontend sends the data it already loaded for the tab (no server-side
 * re-fetch) and gets back a short plain-sentence summary. Operator+ read.
 *
 * Cost-conscious by construction (this is, after all, the cost dashboard):
 *   - Defaults to Haiku 4.5 (≈12x cheaper than Sonnet) — plenty for a 1-line
 *     TLDR. Override with BEDROCK_TLDR_MODEL (e.g. a Sonnet id) if desired.
 *   - Caps maxTokens and the inbound data payload.
 *   - Caches by (tab + data hash) for 10 min, so reloading a tab whose data
 *     hasn't changed costs nothing.
 *   - Fail-soft: any Bedrock error returns an empty summary (200) so the bar
 *     simply hides rather than erroring the page.
 */

import { Hono } from 'hono';
import { createHash } from 'node:crypto';
import {
  authenticateDashboardToken,
  extractBearerToken,
  type TokenPrincipal,
} from '../../lib/auth/dashboard-auth.js';
import { converseTurn } from '../../lib/bedrock/client.js';
import { logger } from '../../observability/logger.js';

type TldrEnv = { Variables: { principal: TokenPrincipal } };
const ROLE_RANK: Record<TokenPrincipal['role'], number> = { viewer: 0, operator: 1, admin: 2 };

const MODEL =
  process.env.BEDROCK_TLDR_MODEL ??
  process.env.BEDROCK_HAIKU_MODEL ??
  'us.anthropic.claude-haiku-4-5-20251001-v1:0';
const MAX_DATA_CHARS = 6000;
const CACHE_TTL_MS = 10 * 60 * 1000;

const SYSTEM = `You write the one-line TLDR shown at the top of a section of an ops dashboard. You are given the section name and its current data as JSON. Reply with a SINGLE plain sentence (max 24 words) capturing what the data shows: the headline number/status and anything notable (a spike, an error, something over a limit, idle waste). No preamble, no markdown, no bullets, no quotes. If nothing is notable, state the key metric plainly.`;

const cache = new Map<string, { at: number; summary: string }>();
// Distinct payloads mint distinct keys and nothing ever deleted them, so a
// long-lived task (days between deploys) grew this map without bound. Sweep
// expired entries on write and cap the survivors (drop oldest first).
const CACHE_MAX_ENTRIES = 500;
function pruneCache(now: number): void {
  for (const [k, v] of cache) {
    if (now - v.at >= CACHE_TTL_MS) cache.delete(k);
  }
  while (cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

export function buildTldrRouter(): Hono<TldrEnv> {
  const router = new Hono<TldrEnv>();

  router.use('*', async (c, next) => {
    const raw = extractBearerToken(c.req.header('authorization'));
    const principal = await authenticateDashboardToken(raw);
    if (!principal) return c.json({ error: 'unauthorized' }, 401);
    if (ROLE_RANK[principal.role] < ROLE_RANK.operator) {
      return c.json({ error: 'forbidden', requiredRole: 'operator', yourRole: principal.role }, 403);
    }
    c.set('principal', principal);
    await next();
  });

  router.post('/', async (c) => {
    const body = await c.req
      .json<{ tab?: string; data?: unknown }>()
      .catch(() => ({} as { tab?: string; data?: unknown }));
    const tab = String(body.tab ?? 'section').slice(0, 40);
    const dataStr = JSON.stringify(body.data ?? {}).slice(0, MAX_DATA_CHARS);

    const key = createHash('sha1').update(`${tab}|${dataStr}`).digest('hex');
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
      return c.json({ summary: hit.summary, cached: true });
    }

    try {
      const out = await converseTurn({
        modelId: MODEL,
        systemPrompt: SYSTEM,
        userText: `Section: ${tab}\nData:\n${dataStr}`,
        maxTokens: 80,
        temperature: 0,
      });
      const summary = (out.text ?? '').trim().replace(/\s+/g, ' ').slice(0, 240);
      if (summary) {
        pruneCache(Date.now());
        cache.set(key, { at: Date.now(), summary });
      }
      return c.json({ summary });
    } catch (err) {
      logger.warn(
        { errMessage: err instanceof Error ? err.message : String(err), tab },
        'tldr generation failed',
      );
      // Fail soft: empty summary, 200, so the bar just hides.
      return c.json({ summary: '' });
    }
  });

  return router;
}
