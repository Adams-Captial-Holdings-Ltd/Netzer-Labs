/**
 * OAuth provider flows for the in-app Connect buttons.
 *
 * Three flows:
 *   slack (bot)   — per-agent chat app install: oauth/v2/authorize ->
 *                   oauth.v2.access -> xoxb- bot token (replaces the manual
 *                   token paste; the manifest+credentials paste stays
 *                   out-of-band, once per app)
 *   slack (user)  — shared MCP-bridge app: oauth/v2_user/authorize + PKCE ->
 *                   oauth.v2.user.access -> xoxp- user token for the vendor
 *                   Slack MCP server (fully replaces the manual PKCE
 *                   walkthrough in docs/mcp/README.md)
 *   salesforce    — Connected App web-server flow + PKCE -> access +
 *                   refresh tokens for the built-in salesforce tools
 *
 * Client credentials live in runtime-config (category oauth), pasted once by
 * an admin — same storage posture as the live Slack MCP bearer. Reads of
 * these keys NEVER leave the backend.
 *
 * The redirect URI is built from SERVER CONFIG only (CCE_DASHBOARD_URL /
 * DASHBOARD_URL) — never from the Host header — matching buildMagicLink's
 * security rule.
 */

import { createHash, randomBytes } from 'node:crypto';
import { getConfig } from '../state/runtime-config-repo.js';

/** Bot scopes for per-agent chat apps. Superset of the manifest scopes so an
 * OAuth re-install also picks up file upload/download (features shipped in
 * this series). */
export const SLACK_BOT_SCOPES = [
  'app_mentions:read',
  'channels:history',
  'groups:history',
  'im:history',
  'chat:write',
  'chat:write.customize',
  'files:read',
  'files:write',
].join(',');

export function oauthRedirectUri(): string {
  const base = process.env.CCE_DASHBOARD_URL ?? process.env.DASHBOARD_URL;
  if (!base) {
    throw new Error('CCE_DASHBOARD_URL / DASHBOARD_URL must be set for OAuth connect');
  }
  return `${base.replace(/\/+$/, '')}/api/oauth/callback`;
}

export function buildPkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

async function requireConfig(category: string, key: string): Promise<string> {
  const v = await getConfig(category, key);
  if (!v) throw new MissingOAuthConfigError(`${category}/${key}`);
  return v;
}

export class MissingOAuthConfigError extends Error {
  constructor(public configKey: string) {
    super(`missing oauth config: ${configKey}`);
    this.name = 'MissingOAuthConfigError';
  }
}

interface SlackAppCreds {
  clientId: string;
  clientSecret: string;
  signingSecret?: string;
}

/** Per-agent Slack chat-app credentials (pasted once via the credentials form). */
export async function slackAppCreds(agentId: string): Promise<SlackAppCreds> {
  const raw = await requireConfig('oauth', `slack_app_${agentId}`);
  const parsed = JSON.parse(raw) as SlackAppCreds;
  if (!parsed.clientId || !parsed.clientSecret) {
    throw new MissingOAuthConfigError(`oauth/slack_app_${agentId}`);
  }
  return parsed;
}

export async function slackBotAuthorizeUrl(agentId: string, state: string): Promise<string> {
  const creds = await slackAppCreds(agentId);
  const u = new URL('https://slack.com/oauth/v2/authorize');
  u.searchParams.set('client_id', creds.clientId);
  u.searchParams.set('scope', SLACK_BOT_SCOPES);
  u.searchParams.set('state', state);
  u.searchParams.set('redirect_uri', oauthRedirectUri());
  return u.toString();
}

export async function slackBotExchange(
  agentId: string,
  code: string,
): Promise<{ botToken: string; teamName?: string }> {
  const creds = await slackAppCreds(agentId);
  const resp = await fetch('https://slack.com/api/oauth.v2.access', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      code,
      redirect_uri: oauthRedirectUri(),
    }),
  });
  const json = (await resp.json()) as {
    ok: boolean;
    access_token?: string;
    team?: { name?: string };
    error?: string;
  };
  if (!json.ok || !json.access_token) {
    throw new Error(`slack oauth.v2.access failed: ${json.error ?? 'unknown'}`);
  }
  return { botToken: json.access_token, teamName: json.team?.name };
}

export async function slackUserAuthorizeUrl(
  state: string,
  codeChallenge: string,
): Promise<string> {
  const clientId = await requireConfig('oauth', 'slack_client_id');
  const u = new URL('https://slack.com/oauth/v2_user/authorize');
  u.searchParams.set('client_id', clientId);
  // Scopes the vendor Slack MCP server needs (docs/mcp/README.md Path B).
  u.searchParams.set(
    'user_scope',
    'channels:history,channels:read,chat:write,groups:history,groups:read,im:history,im:read,mpim:history,mpim:read,search:read,users:read',
  );
  u.searchParams.set('state', state);
  u.searchParams.set('redirect_uri', oauthRedirectUri());
  u.searchParams.set('code_challenge', codeChallenge);
  u.searchParams.set('code_challenge_method', 'S256');
  return u.toString();
}

export async function slackUserExchange(
  code: string,
  codeVerifier: string,
): Promise<{ userToken: string }> {
  const clientId = await requireConfig('oauth', 'slack_client_id');
  const clientSecret = await requireConfig('oauth', 'slack_client_secret');
  const resp = await fetch('https://slack.com/api/oauth.v2.user.access', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: oauthRedirectUri(),
      code_verifier: codeVerifier,
    }),
  });
  const json = (await resp.json()) as {
    ok: boolean;
    authed_user?: { access_token?: string };
    error?: string;
  };
  const token = json.authed_user?.access_token;
  if (!json.ok || !token) {
    throw new Error(`slack oauth.v2.user.access failed: ${json.error ?? 'unknown'}`);
  }
  return { userToken: token };
}

async function salesforceLoginUrl(): Promise<string> {
  return (await getConfig('oauth', 'salesforce_login_url')) ?? 'https://login.salesforce.com';
}

export async function salesforceAuthorizeUrl(
  state: string,
  codeChallenge: string,
): Promise<string> {
  const clientId = await requireConfig('oauth', 'salesforce_client_id');
  const login = await salesforceLoginUrl();
  const u = new URL(`${login.replace(/\/+$/, '')}/services/oauth2/authorize`);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', clientId);
  u.searchParams.set('redirect_uri', oauthRedirectUri());
  u.searchParams.set('scope', 'api refresh_token');
  u.searchParams.set('state', state);
  u.searchParams.set('code_challenge', codeChallenge);
  u.searchParams.set('code_challenge_method', 'S256');
  return u.toString();
}

export interface SalesforceTokens {
  accessToken: string;
  refreshToken: string;
  instanceUrl: string;
  issuedAt: string;
}

export async function salesforceExchange(
  code: string,
  codeVerifier: string,
): Promise<SalesforceTokens> {
  const clientId = await requireConfig('oauth', 'salesforce_client_id');
  const clientSecret = await requireConfig('oauth', 'salesforce_client_secret');
  const login = await salesforceLoginUrl();
  const resp = await fetch(`${login.replace(/\/+$/, '')}/services/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: oauthRedirectUri(),
      code_verifier: codeVerifier,
    }),
  });
  const json = (await resp.json()) as {
    access_token?: string;
    refresh_token?: string;
    instance_url?: string;
    error?: string;
    error_description?: string;
  };
  if (!json.access_token || !json.instance_url) {
    throw new Error(`salesforce token exchange failed: ${json.error_description ?? json.error ?? 'unknown'}`);
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? '',
    instanceUrl: json.instance_url,
    issuedAt: new Date().toISOString(),
  };
}

export async function salesforceRefresh(
  refreshToken: string,
): Promise<{ accessToken: string; instanceUrl: string }> {
  const clientId = await requireConfig('oauth', 'salesforce_client_id');
  const clientSecret = await requireConfig('oauth', 'salesforce_client_secret');
  const login = await salesforceLoginUrl();
  const resp = await fetch(`${login.replace(/\/+$/, '')}/services/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
    }),
  });
  const json = (await resp.json()) as {
    access_token?: string;
    instance_url?: string;
    error_description?: string;
    error?: string;
  };
  if (!json.access_token || !json.instance_url) {
    throw new Error(`salesforce refresh failed: ${json.error_description ?? json.error ?? 'unknown'}`);
  }
  return { accessToken: json.access_token, instanceUrl: json.instance_url };
}
