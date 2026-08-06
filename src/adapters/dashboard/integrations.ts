/**
 * Integrations router (Tier B).
 *
 * GET  /api/integrations                 -> per-agent connected-surface inventory
 * GET  /api/integrations/secrets-posture -> secrets metadata posture (NO values)
 * GET  /api/integrations/mcp             -> configured MCP servers (redacted)
 * PUT  /api/integrations/mcp             -> replace the MCP server list (write)
 * POST /api/integrations/mcp/:id/probe   -> live probe an MCP server
 *
 * The GET routes are operator+ reads; no secret VALUE ever leaves the router
 * (bearer tokens are redacted to a hasBearerToken flag). PUT /mcp is the one
 * write path: admin-rank AND the config:write capability (MCP servers live in
 * runtime-config). Every underlying read fails soft, so a denied AWS permission
 * or a DDB blip degrades the response rather than 500-ing.
 *
 * The router is NOT mounted here; src/server.ts (owned elsewhere) mounts it.
 */

import { Hono } from 'hono';
import {
  authenticateDashboardToken,
  extractBearerToken,
  type TokenPrincipal,
} from '../../lib/auth/dashboard-auth.js';
import { principalHasRouteCapability } from '../../lib/auth/route-capability.js';
import { getIntegrationsInventory } from '../../lib/state/integrations-inventory.js';
import { getSecurityPosture, type PostureCard } from '../../lib/security/posture-repo.js';
import { listMcpServers, saveMcpServers } from '../../lib/mcp/servers-repo.js';
import { probeMcpServer } from '../../lib/mcp/mcp-tools.js';
import type { McpServerConfig } from '../../lib/mcp/types.js';
import { writeAudit } from '../../lib/audit/audit-writer.js';

type IntegrationsEnv = { Variables: { principal: TokenPrincipal } };

// viewer < operator < admin. Both reads here require operator+.
const ROLE_RANK: Record<TokenPrincipal['role'], number> = { viewer: 0, operator: 1, admin: 2 };

/** A single secret's posture, metadata only — never the value. */
interface SecretPosture {
  id: string;
  name: string;
  /** YYYY-MM-DD of last rotation/change if known, else null. */
  lastRotated: string | null;
  hasRotationSchedule: boolean;
  status: PostureCard['status'];
  detail: string;
}

/**
 * Map a posture-repo secret card to the secrets-posture shape. The card's
 * detail string already encodes rotation state ('rotation schedule on' /
 * 'no rotation schedule' and an optional 'last rotated <date>' / 'last changed
 * <date>'); we parse those flags back out. DescribeSecret returns metadata
 * ONLY, so nothing here can leak a secret value.
 */
function cardToSecretPosture(card: PostureCard): SecretPosture {
  const detail = card.detail ?? '';
  const hasRotationSchedule = /rotation schedule on/i.test(detail);
  const dateMatch = detail.match(/last (?:rotated|changed) (\d{4}-\d{2}-\d{2})/i);
  return {
    id: card.id,
    name: card.label,
    lastRotated: dateMatch ? dateMatch[1] : null,
    hasRotationSchedule,
    status: card.status,
    detail,
  };
}

export function buildIntegrationsRouter(): Hono<IntegrationsEnv> {
  const router = new Hono<IntegrationsEnv>();

  // Authenticate every request; per-route role gating happens below.
  router.use('*', async (c, next) => {
    const raw = extractBearerToken(c.req.header('authorization'));
    const principal = await authenticateDashboardToken(raw);
    if (!principal) return c.json({ error: 'unauthorized' }, 401);
    c.set('principal', principal);
    await next();
  });

  // Per-agent connected-surface inventory. Operator-readable.
  router.get('/', async (c) => {
    const principal = c.get('principal');
    if (ROLE_RANK[principal.role] < ROLE_RANK.operator) {
      return c.json({ error: 'forbidden', requiredRole: 'operator', yourRole: principal.role }, 403);
    }
    // getIntegrationsInventory is internally fail-soft (empty entries on a
    // scan failure, 'unknown' health on a probe failure), but guard the whole
    // call too so this endpoint never 500s.
    const inventory = await getIntegrationsInventory().catch(() => ({
      generatedAt: new Date().toISOString(),
      entries: [],
    }));
    return c.json(inventory);
  });

  // Secrets metadata posture (name, lastRotated, hasRotationSchedule). NO
  // values. Operator-readable. Reuses the Inc-3 posture reader and filters to
  // the secret cards.
  router.get('/secrets-posture', async (c) => {
    const principal = c.get('principal');
    if (ROLE_RANK[principal.role] < ROLE_RANK.operator) {
      return c.json({ error: 'forbidden', requiredRole: 'operator', yourRole: principal.role }, 403);
    }
    const cards = await getSecurityPosture().catch(() => [] as PostureCard[]);
    const secrets = cards
      .filter((card) => card.id.startsWith('secret-'))
      .map(cardToSecretPosture);
    return c.json({ generatedAt: new Date().toISOString(), secrets });
  });

  // ── MCP servers (AgentCore gateways / remote MCP endpoints) ────────────
  // Agents call tools on these servers; the registry lives in runtime-config
  // so edits reach every task within seconds, no redeploy.

  /** bearerToken never leaves the API — the UI only learns whether one is set. */
  function redact(s: McpServerConfig): Omit<McpServerConfig, 'bearerToken'> & { hasBearerToken: boolean } {
    const { bearerToken, ...rest } = s;
    return { ...rest, hasBearerToken: Boolean(bearerToken) };
  }

  // List configured MCP servers. Operator-readable.
  router.get('/mcp', async (c) => {
    const principal = c.get('principal');
    if (ROLE_RANK[principal.role] < ROLE_RANK.operator) {
      return c.json({ error: 'forbidden', requiredRole: 'operator', yourRole: principal.role }, 403);
    }
    const servers = await listMcpServers().catch(() => [] as McpServerConfig[]);
    return c.json({ servers: servers.map(redact) });
  });

  // Replace the server list. Admin-rank AND config:write; audited. MCP servers
  // live in runtime-config, so config:write is the capability that governs them
  // (there is no mcp:write; this mirrors how the cost cap uses cost:write). The
  // capability check is defense in depth over the legacy admin-rank gate: it
  // additionally denies a custom admin-rank profile with config:write stripped.
  router.put('/mcp', async (c) => {
    const principal = c.get('principal');
    if (ROLE_RANK[principal.role] < ROLE_RANK.admin) {
      return c.json({ error: 'forbidden', requiredRole: 'admin', yourRole: principal.role }, 403);
    }
    if (!(await principalHasRouteCapability(principal, 'config:write'))) {
      return c.json({ error: 'forbidden', requiredCapability: 'config:write' }, 403);
    }
    let body: { servers?: unknown };
    try {
      body = (await c.req.json()) as { servers?: unknown };
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    if (!Array.isArray(body.servers)) {
      return c.json({ error: 'body must be { servers: McpServerConfig[] }' }, 400);
    }
    // A PUT without a bearerToken keeps the stored one (so the UI can edit a
    // server without re-entering the secret it can never read back).
    const existing = await listMcpServers();
    const merged = (body.servers as McpServerConfig[]).map((s) => {
      if (s?.auth === 'bearer' && !s.bearerToken) {
        const prev = existing.find((e) => e.id === s.id);
        if (prev?.bearerToken) return { ...s, bearerToken: prev.bearerToken };
      }
      return s;
    });
    try {
      const saved = await saveMcpServers(merged, principal.label ?? principal.role);
      void writeAudit({
        action: 'mcp_servers_updated',
        surface: 'dashboard',
        operatorLabel: principal.label,
        detail: { count: saved.length, ids: saved.map((s) => s.id) },
        result: 'ok',
      });
      return c.json({ servers: saved.map(redact) });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'save failed' }, 400);
    }
  });

  // Live probe: tools/list against the real endpoint, no cache. Surfaces the
  // exact transport/auth error when a gateway is misconfigured. Operator+.
  router.post('/mcp/:id/probe', async (c) => {
    const principal = c.get('principal');
    if (ROLE_RANK[principal.role] < ROLE_RANK.operator) {
      return c.json({ error: 'forbidden', requiredRole: 'operator', yourRole: principal.role }, 403);
    }
    const result = await probeMcpServer(c.req.param('id'));
    return c.json(result, result.ok ? 200 : 502);
  });

  return router;
}
