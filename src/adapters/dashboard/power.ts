/**
 * Power-switch proxy router. Mounted at /api/power (see src/server.ts).
 *
 * The pause/wake control plane is an ISOLATED Lambda behind a Function URL
 * (infra/lib/power-switch-stack.ts) so it stays reachable while this very app
 * is scaled to zero. The dashboard therefore only PROXIES to it:
 *
 *   GET  /status  (any authenticated user)  live power state, 10s cached.
 *   POST /pause   (security:write)          pause via the Lambda; audited,
 *                                           break-glass-proof (power_pause).
 *
 * There is deliberately NO /wake here — when the stack is paused this app is
 * not running, so wake can only ever come from the external panel. /status
 * returns panelUrl so the UI can link out to it.
 *
 * The power token never reaches the browser: it is read server-side from
 * Secrets Manager (5-min cache) and attached to the outbound request only.
 * The Function URL comes from runtime-config power/url (fallback env
 * CCE_POWER_URL), so wiring it up needs no redeploy.
 *
 * Scope note: the Lambda's IAM role is resource-scoped to the ClaudeClaw
 * cluster/service alone — this cannot touch anything else in the account.
 */

import { Hono } from 'hono';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import {
  authenticateDashboardToken,
  extractBearerToken,
  type TokenPrincipal,
} from '../../lib/auth/dashboard-auth.js';
import { principalHasRouteCapability } from '../../lib/auth/route-capability.js';
import { getConfig } from '../../lib/state/runtime-config-repo.js';
import { writeAuditOrThrow } from '../../lib/audit/audit-writer.js';
import { logger } from '../../observability/logger.js';

type PowerEnv = { Variables: { principal: TokenPrincipal } };

const REGION = process.env.AWS_REGION ?? 'us-east-1';
const TOKEN_SECRET_ID =
  process.env.CCE_POWER_TOKEN_SECRET ?? 'claudeclaw/power-switch-token';

let _sm: SecretsManagerClient | null = null;
function sm(): SecretsManagerClient {
  if (!_sm) _sm = new SecretsManagerClient({ region: REGION });
  return _sm;
}

/** Test seam. */
export function __setSecretsClient(c: SecretsManagerClient | null): void {
  _sm = c;
  _token = null;
  _tokenAt = 0;
  _statusCache = null;
}

let _token: string | null = null;
let _tokenAt = 0;
const TOKEN_TTL_MS = 5 * 60_000;

async function powerToken(): Promise<string | null> {
  if (_token && Date.now() - _tokenAt < TOKEN_TTL_MS) return _token;
  try {
    const out = await sm().send(
      new GetSecretValueCommand({ SecretId: TOKEN_SECRET_ID }),
    );
    let raw = out.SecretString ?? '';
    try {
      const j = JSON.parse(raw) as { token?: string };
      raw = j.token ?? raw;
    } catch {
      /* plain string secret */
    }
    if (!raw) return null;
    _token = raw;
    _tokenAt = Date.now();
    return raw;
  } catch (err) {
    logger.warn(
      { errMessage: err instanceof Error ? err.message : String(err) },
      'power proxy: token read failed (missing IAM grant on the power secret?)',
    );
    return null;
  }
}

async function powerUrl(): Promise<string | null> {
  const cfg = await getConfig('power', 'url');
  const url = (cfg ?? process.env.CCE_POWER_URL ?? '').trim().replace(/\/$/, '');
  return url || null;
}

async function callPower(
  action: 'status' | 'pause',
  timeoutMs: number,
): Promise<{ code: number; body: Record<string, unknown> } | null> {
  const [url, token] = await Promise.all([powerUrl(), powerToken()]);
  if (!url || !token) return null;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const resp = await fetch(`${url}/${action}`, {
      method: 'POST',
      headers: { 'X-Power-Token': token },
      signal: ctl.signal,
    });
    const body = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
    return { code: resp.status, body };
  } finally {
    clearTimeout(timer);
  }
}

// Status is a fan-out of AWS reads inside the Lambda; a short cache keeps a
// busy Overview tab from hammering it.
let _statusCache: { at: number; payload: Record<string, unknown> } | null = null;
const STATUS_TTL_MS = 10_000;

export function buildPowerRouter(): Hono<PowerEnv> {
  const router = new Hono<PowerEnv>();

  router.use('*', async (c, next) => {
    const raw = extractBearerToken(c.req.header('authorization'));
    const principal = await authenticateDashboardToken(raw);
    if (!principal) return c.json({ error: 'unauthorized' }, 401);
    c.set('principal', principal);
    await next();
  });

  router.get('/status', async (c) => {
    const url = await powerUrl();
    if (!url) {
      // Not wired up (fresh install without the power stack, or the runtime
      // config key is unset). The card hides itself on `configured:false`.
      return c.json({ configured: false });
    }
    if (_statusCache && Date.now() - _statusCache.at < STATUS_TTL_MS) {
      return c.json(_statusCache.payload);
    }
    try {
      const out = await callPower('status', 12_000);
      if (!out) return c.json({ configured: true, ok: false, error: 'power token unavailable' }, 502);
      const payload = { configured: true, panelUrl: url, ...out.body };
      if (out.code === 200) _statusCache = { at: Date.now(), payload };
      return c.json(payload, out.code === 200 ? 200 : 502);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ configured: true, ok: false, panelUrl: url, error: msg }, 502);
    }
  });

  router.post('/pause', async (c) => {
    const principal = c.get('principal');
    if (!(await principalHasRouteCapability(principal, 'security:write'))) {
      return c.json({ error: 'forbidden', requiredCapability: 'security:write' }, 403);
    }
    const body = await c.req
      .json<{ confirm?: boolean }>()
      .catch(() => ({}) as { confirm?: boolean });
    if (body.confirm !== true) return c.json({ error: 'confirm:true is required' }, 400);
    try {
      const out = await callPower('pause', 30_000);
      if (!out) return c.json({ error: 'power switch not configured' }, 502);
      _statusCache = null;
      // Same tier as kill_switch_set: this drains prod. Awaited, and its own
      // catch so an audit failure is reported as such, not as a pause failure.
      try {
        await writeAuditOrThrow({
          action: 'power_pause',
          surface: 'dashboard',
          userId: principal.hashPrefix16,
          operatorLabel: principal.label,
          detail: { result: out.body, code: out.code },
          result: out.code === 200 ? 'ok' : 'error',
        });
      } catch {
        return c.json(
          { error: 'pause requested but the audit write failed; investigate' },
          500,
        );
      }
      return c.json(out.body, out.code === 200 ? 200 : 502);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ errMessage: msg }, 'power proxy: pause failed');
      return c.json({ error: `pause failed: ${msg}` }, 502);
    }
  });

  return router;
}
