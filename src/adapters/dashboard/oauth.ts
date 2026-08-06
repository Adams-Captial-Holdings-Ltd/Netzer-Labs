/**
 * In-app OAuth Connect router. Mounted at /api/oauth (server.ts, BEFORE the
 * /api catch-all).
 *
 *   POST /api/oauth/:provider/start        admin    -> { authorizeUrl }
 *   GET  /api/oauth/callback               PUBLIC   browser redirect target
 *   GET  /api/oauth/status                 operator -> redacted connection state
 *   PUT  /api/oauth/:provider/credentials  admin    one-time client-creds paste
 *
 * The callback is unauthenticated by necessity (the provider redirect carries
 * no bearer); its protection is the single-use, 10-minute, sha256-stored
 * state row. It never echoes tokens or raw provider errors into the redirect
 * URL — only coarse machine-readable reason codes.
 */

import { Hono } from 'hono';
import {
  authenticateDashboardToken,
  extractBearerToken,
  type TokenPrincipal,
} from '../../lib/auth/dashboard-auth.js';
import { isKillSwitchActive } from '../../lib/state/kill-switches-repo.js';
import { getConfig, setConfig } from '../../lib/state/runtime-config-repo.js';
import { mintOAuthState, consumeOAuthState } from '../../lib/oauth/state-repo.js';
import {
  buildPkcePair,
  slackBotAuthorizeUrl,
  slackBotExchange,
  slackUserAuthorizeUrl,
  slackUserExchange,
  salesforceAuthorizeUrl,
  salesforceExchange,
  slackAppCreds,
  MissingOAuthConfigError,
  oauthRedirectUri,
} from '../../lib/oauth/providers.js';
import { connectSlack } from '../../lib/agents/agent-manager.js';
import { listMcpServers, saveMcpServers } from '../../lib/mcp/servers-repo.js';
import { writeAudit } from '../../lib/audit/audit-writer.js';
import { logger } from '../../observability/logger.js';
import { listKnownAgents } from '../../lib/config/agent-loader.js';

type OAuthEnv = { Variables: { principal: TokenPrincipal } };

const ROLE_RANK: Record<TokenPrincipal['role'], number> = { viewer: 0, operator: 1, admin: 2 };

/** Where the browser lands after a connect attempt. Reason codes only. */
function redirectToIntegrations(c: { redirect: (url: string, code?: 302) => Response }, params: Record<string, string>): Response {
  const q = new URLSearchParams(params).toString();
  return c.redirect(`/dashboard/integrations?${q}`, 302);
}

export function buildOAuthRouter(): Hono<OAuthEnv> {
  const router = new Hono<OAuthEnv>();

  // ── Public callback — registered BEFORE the auth middleware so the
  //    provider redirect (which carries no bearer) can reach it. ──────────
  router.get('/callback', async (c) => {
    const killed = await isKillSwitchActive('oauth_connect_disabled');
    if (killed.active) return redirectToIntegrations(c, { oauth: 'error', reason: 'disabled' });
    const err = c.req.query('error');
    if (err) {
      logger.warn({ providerError: err }, 'oauth callback returned provider error');
      return redirectToIntegrations(c, { oauth: 'error', reason: 'provider_denied' });
    }
    const code = c.req.query('code') ?? '';
    const state = c.req.query('state') ?? '';
    if (!code || !state) return redirectToIntegrations(c, { oauth: 'error', reason: 'missing_params' });
    const row = await consumeOAuthState(state);
    if (!row) return redirectToIntegrations(c, { oauth: 'error', reason: 'state' });
    try {
      if (row.provider === 'slack' && row.mode === 'chat' && row.agentId) {
        const { botToken } = await slackBotExchange(row.agentId, code);
        const creds = await slackAppCreds(row.agentId);
        if (!creds.signingSecret) {
          return redirectToIntegrations(c, { oauth: 'error', reason: 'missing_signing_secret' });
        }
        // Reuses validation (auth.test) + activation from agent-manager.
        await connectSlack(row.agentId, botToken, creds.signingSecret);
      } else if (row.provider === 'slack-user' && row.mode === 'mcp') {
        const { userToken } = await slackUserExchange(code, row.codeVerifier ?? '');
        // Upsert the vendor Slack MCP server entry; the MCP client picks the
        // bearer up automatically within its cache window.
        const servers = await listMcpServers();
        const existing = servers.find((s) => s.id === 'slack');
        const next = existing
          ? servers.map((s) => (s.id === 'slack' ? { ...s, bearerToken: userToken, enabled: true } : s))
          : [
              ...servers,
              {
                id: 'slack',
                name: 'Slack (vendor MCP)',
                url: 'https://mcp.slack.com/mcp',
                auth: 'bearer' as const,
                bearerToken: userToken,
                enabled: true,
                agents: ['main'],
              },
            ];
        await saveMcpServers(next, `oauth:${row.principalLabel}`);
      } else if (row.provider === 'salesforce' && row.mode === 'api') {
        const tokens = await salesforceExchange(code, row.codeVerifier ?? '');
        await setConfig('oauth', 'salesforce_tokens', JSON.stringify(tokens), {
          updatedBy: `oauth:${row.principalLabel}`,
        });
      } else {
        return redirectToIntegrations(c, { oauth: 'error', reason: 'mode' });
      }
      void writeAudit({
        action: 'oauth_connected',
        surface: 'dashboard',
        operatorLabel: row.principalLabel,
        detail: { provider: row.provider, mode: row.mode, agentId: row.agentId ?? null },
        result: 'ok',
      });
      return redirectToIntegrations(c, { oauth: row.provider, status: 'ok' });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.warn({ provider: row.provider, errMessage: msg }, 'oauth token landing failed');
      void writeAudit({
        action: 'oauth_connected',
        surface: 'dashboard',
        operatorLabel: row.principalLabel,
        detail: { provider: row.provider, mode: row.mode, errMessage: msg.slice(0, 200) },
        result: 'error',
      });
      return redirectToIntegrations(c, { oauth: row.provider, status: 'error', reason: 'exchange' });
    }
  });

  // ── Everything below requires a bearer. ─────────────────────────────────
  router.use('*', async (c, next) => {
    const raw = extractBearerToken(c.req.header('authorization'));
    const principal = await authenticateDashboardToken(raw);
    if (!principal) return c.json({ error: 'unauthorized' }, 401);
    c.set('principal', principal);
    await next();
  });

  router.get('/status', async (c) => {
    const principal = c.get('principal');
    if (ROLE_RANK[principal.role] < ROLE_RANK.operator) {
      return c.json({ error: 'forbidden', requiredRole: 'operator' }, 403);
    }
    // Redacted: booleans + metadata only, never values.
    const [sfTokens, sfClientId, slackClientId, mcpServers] = await Promise.all([
      getConfig('oauth', 'salesforce_tokens'),
      getConfig('oauth', 'salesforce_client_id'),
      getConfig('oauth', 'slack_client_id'),
      listMcpServers().catch(() => []),
    ]);
    const appsConfigured: string[] = [];
    for (const agentId of listKnownAgents()) {
      if (await getConfig('oauth', `slack_app_${agentId}`)) appsConfigured.push(agentId);
    }
    let sfInstanceUrl: string | null = null;
    if (sfTokens) {
      try {
        sfInstanceUrl = (JSON.parse(sfTokens) as { instanceUrl?: string }).instanceUrl ?? null;
      } catch { /* corrupt row reads as connected:false below */ }
    }
    const slackMcp = mcpServers.find((s) => s.id === 'slack');
    return c.json({
      redirectUri: (() => { try { return oauthRedirectUri(); } catch { return null; } })(),
      providers: {
        slack: {
          mcpConnected: Boolean(slackMcp?.enabled && slackMcp.bearerToken),
          mcpClientConfigured: Boolean(slackClientId),
          appsConfigured,
        },
        salesforce: {
          connected: Boolean(sfTokens && sfInstanceUrl),
          instanceUrl: sfInstanceUrl,
          clientConfigured: Boolean(sfClientId),
        },
      },
    });
  });

  router.post('/:provider/start', async (c) => {
    const principal = c.get('principal');
    if (ROLE_RANK[principal.role] < ROLE_RANK.admin) {
      return c.json({ error: 'forbidden', requiredRole: 'admin' }, 403);
    }
    const killed = await isKillSwitchActive('oauth_connect_disabled');
    if (killed.active) return c.json({ error: 'oauth_connect_disabled' }, 503);
    const provider = c.req.param('provider');
    const body = await c.req.json<{ agentId?: string; mode?: string }>().catch(() => ({} as { agentId?: string; mode?: string }));
    try {
      if (provider === 'slack' && body.mode === 'chat') {
        const agentId = (body.agentId ?? '').trim();
        if (!agentId) return c.json({ error: 'agentId_required' }, 400);
        const state = await mintOAuthState({
          provider: 'slack',
          mode: 'chat',
          agentId,
          principalLabel: principal.label,
        });
        return c.json({ authorizeUrl: await slackBotAuthorizeUrl(agentId, state) });
      }
      if (provider === 'slack' && body.mode === 'mcp') {
        const pkce = buildPkcePair();
        const state = await mintOAuthState({
          provider: 'slack-user',
          mode: 'mcp',
          principalLabel: principal.label,
          codeVerifier: pkce.verifier,
        });
        return c.json({ authorizeUrl: await slackUserAuthorizeUrl(state, pkce.challenge) });
      }
      if (provider === 'salesforce') {
        const pkce = buildPkcePair();
        const state = await mintOAuthState({
          provider: 'salesforce',
          mode: 'api',
          principalLabel: principal.label,
          codeVerifier: pkce.verifier,
        });
        return c.json({ authorizeUrl: await salesforceAuthorizeUrl(state, pkce.challenge) });
      }
      return c.json({ error: 'unknown_provider_or_mode' }, 400);
    } catch (e) {
      if (e instanceof MissingOAuthConfigError) {
        // Precise hint so the UI can show "enter app credentials first".
        return c.json({ error: 'credentials_needed', missing: [e.configKey] }, 409);
      }
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('DASHBOARD_URL')) return c.json({ error: 'dashboard_url_unset' }, 500);
      throw e;
    }
  });

  router.put('/:provider/credentials', async (c) => {
    const principal = c.get('principal');
    if (ROLE_RANK[principal.role] < ROLE_RANK.admin) {
      return c.json({ error: 'forbidden', requiredRole: 'admin' }, 403);
    }
    const provider = c.req.param('provider');
    const body = await c.req
      .json<{ agentId?: string; clientId?: string; clientSecret?: string; signingSecret?: string; loginUrl?: string }>()
      .catch(() => null);
    if (!body?.clientId || !body.clientSecret) {
      return c.json({ error: 'clientId_and_clientSecret_required' }, 400);
    }
    const updatedBy = `oauth:${principal.label}`;
    const written: string[] = [];
    if (provider === 'slack' && body.agentId) {
      const key = `slack_app_${body.agentId.trim()}`;
      await setConfig(
        'oauth',
        key,
        JSON.stringify({
          clientId: body.clientId,
          clientSecret: body.clientSecret,
          ...(body.signingSecret ? { signingSecret: body.signingSecret } : {}),
        }),
        { updatedBy },
      );
      written.push(`oauth/${key}`);
    } else if (provider === 'slack') {
      await setConfig('oauth', 'slack_client_id', body.clientId, { updatedBy });
      await setConfig('oauth', 'slack_client_secret', body.clientSecret, { updatedBy });
      written.push('oauth/slack_client_id', 'oauth/slack_client_secret');
    } else if (provider === 'salesforce') {
      await setConfig('oauth', 'salesforce_client_id', body.clientId, { updatedBy });
      await setConfig('oauth', 'salesforce_client_secret', body.clientSecret, { updatedBy });
      if (body.loginUrl) {
        await setConfig('oauth', 'salesforce_login_url', body.loginUrl, { updatedBy });
        written.push('oauth/salesforce_login_url');
      }
      written.push('oauth/salesforce_client_id', 'oauth/salesforce_client_secret');
    } else {
      return c.json({ error: 'unknown_provider' }, 400);
    }
    // Audit key NAMES only — never values.
    void writeAudit({
      action: 'oauth_credentials_set',
      surface: 'dashboard',
      operatorLabel: principal.label,
      detail: { provider, keys: written },
      result: 'ok',
    });
    return c.json({ ok: true, written });
  });

  return router;
}
