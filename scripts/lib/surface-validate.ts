/**
 * Post-deploy surface validation (IaC readiness plan, P1 item 13).
 *
 * Validates each configured chat/dashboard surface with HONEST depth
 * reporting: "token-valid" (the credential works against the vendor API)
 * and "delivery-verified" (a real round-trip through OUR deployed endpoint
 * succeeded) are distinct statuses — a valid token says nothing about
 * whether Slack/Telegram can actually reach the deployment.
 *
 * - Slack: auth.test (token) PLUS a synthetic signed url_verification POST
 *   against `${baseUrl}/slack/events`. The deployed handler
 *   (src/adapters/slack/handler.ts) verifies the signature BEFORE echoing
 *   the challenge, so a 200 + challenge echo proves the signing secret we
 *   hold matches the one the deployment loaded from Secrets Manager.
 *   Slack-side event-URL verification (api.slack.com app config) cannot be
 *   completed from AWS and is reported as an [EXTERNAL] skip.
 * - Telegram: getMe per agent (token) PLUS getWebhookInfo URL match against
 *   `${expectedBaseUrl}/tg/<agentId>/webhook` (the route served by
 *   src/adapters/telegram/handler.ts). With `register: true`, deploy
 *   registers the webhook itself (setWebhook with the secret token +
 *   allowed-updates list) and re-verifies; otherwise a mismatch fails with
 *   the exact manual setWebhook command and the expected getWebhookInfo
 *   output as remediation.
 * - Dashboard: bearer-token round-trip over HTTPS against the authenticated
 *   read-only `GET /api/agents` (src/adapters/dashboard/handler.ts gates
 *   the whole /api router on `Authorization: Bearer <DASHBOARD_TOKEN>`).
 *   Plain HTTP for a non-localhost base URL is refused outright — dashboard
 *   auth must never ride plain HTTP.
 *
 * Every function takes an injectable `fetchFn` so unit tests run with zero
 * real network calls.
 */

import { createHmac, randomBytes } from 'node:crypto';

export type SurfaceCheck = {
  id: string;
  status: 'token-valid' | 'delivery-verified' | 'fail' | 'skip';
  detail: string;
  remediation?: string;
};

/** Minimal fetch shape so tests can inject a recording fake. */
export type FetchFn = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** Webhook path the deployed server actually serves (src/server.ts mounts /tg). */
export function telegramWebhookPath(agentId: string): string {
  return `/tg/${agentId}/webhook`;
}

/** Events path the deployed server actually serves (src/server.ts mounts /slack). */
export const SLACK_EVENTS_PATH = '/slack/events';

/**
 * allowed_updates registered by deploy-driven setWebhook. Must stay in
 * sync with the list the original deploy.ts registration used — prod
 * webhooks were registered with exactly this set, and re-registering
 * with a different list would change which updates Telegram delivers.
 */
export const TELEGRAM_ALLOWED_UPDATES = ['message', 'callback_query', 'my_chat_member'] as const;

/**
 * Slack request signature, computed exactly as Slack (and our verifier in
 * src/adapters/slack/verify.ts) does: `v0=` + HMAC-SHA256 over
 * `v0:<timestamp>:<rawBody>` keyed with the signing secret, hex digest.
 */
export function computeSlackSignature(
  signingSecret: string,
  timestamp: string,
  rawBody: string,
): string {
  return 'v0=' + createHmac('sha256', signingSecret).update(`v0:${timestamp}:${rawBody}`).digest('hex');
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

function errMessage(err: unknown): string {
  const e = err as { message?: string };
  return e?.message ?? String(err);
}

export async function validateSlackSurface(opts: {
  botToken?: string;
  signingSecret?: string;
  baseUrl?: string;
  fetchFn?: FetchFn;
}): Promise<SurfaceCheck[]> {
  const { botToken, signingSecret, baseUrl } = opts;
  const fetchFn = opts.fetchFn ?? fetch;
  const checks: SurfaceCheck[] = [];

  // 1. Token validity via auth.test (mirrors scripts/lib/slack-check.ts).
  if (!botToken) {
    checks.push({ id: 'slack-auth', status: 'skip', detail: 'SLACK_BOT_TOKEN not set' });
  } else {
    try {
      const resp = await fetchFn('https://slack.com/api/auth.test', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${botToken}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: '',
      });
      const data = (await resp.json()) as {
        ok: boolean;
        team?: string;
        user?: string;
        error?: string;
      };
      if (data.ok) {
        checks.push({
          id: 'slack-auth',
          status: 'token-valid',
          detail: `auth.test ok (team ${data.team ?? '?'}, bot ${data.user ?? '?'}) — token valid; delivery not yet proven`,
        });
      } else {
        checks.push({
          id: 'slack-auth',
          status: 'fail',
          detail: `auth.test failed: ${data.error ?? 'unknown error from slack'}`,
          remediation:
            'Check SLACK_BOT_TOKEN — use the Bot User OAuth Token (xoxb-…) from api.slack.com > your app > OAuth & Permissions, then update the surface secret and force a new ECS deployment.',
        });
      }
    } catch (err) {
      checks.push({
        id: 'slack-auth',
        status: 'fail',
        detail: `auth.test request failed: ${errMessage(err)}`,
        remediation: 'Verify outbound network access to slack.com and retry.',
      });
    }
  }

  // 2. Synthetic signed delivery check against OUR deployed /slack/events.
  if (signingSecret && baseUrl) {
    const challenge = `cce-verify-${randomBytes(8).toString('hex')}`;
    const rawBody = JSON.stringify({ type: 'url_verification', challenge });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = computeSlackSignature(signingSecret, timestamp, rawBody);
    const url = `${trimTrailingSlash(baseUrl)}${SLACK_EVENTS_PATH}`;
    try {
      const resp = await fetchFn(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-slack-request-timestamp': timestamp,
          'x-slack-signature': signature,
        },
        body: rawBody,
      });
      const text = await resp.text();
      if (resp.status === 200 && text.includes(challenge)) {
        checks.push({
          id: 'slack-signed-delivery',
          status: 'delivery-verified',
          detail: `signed url_verification round-trip via ${url} succeeded — the deployed signing secret matches the one we hold`,
        });
      } else {
        checks.push({
          id: 'slack-signed-delivery',
          status: 'fail',
          detail: `signed url_verification against ${url} returned HTTP ${resp.status}${text ? ` (${text.slice(0, 200)})` : ''} instead of echoing the challenge`,
          remediation:
            'The signing secret in Secrets Manager differs from the Slack app\'s signing secret. Copy the value from api.slack.com > your app > Basic Information > App Credentials > Signing Secret into the surface secret (SLACK_SIGNING_SECRET), then force a new ECS deployment so tasks pick it up. Also confirm the WAF excludes /slack/* from body inspection rules.',
        });
      }
    } catch (err) {
      checks.push({
        id: 'slack-signed-delivery',
        status: 'fail',
        detail: `signed url_verification against ${url} failed: ${errMessage(err)}`,
        remediation:
          'Confirm DNS resolves to the ALB and HTTPS is serving — the endpoint must be reachable before Slack delivery can work.',
      });
    }
  } else {
    checks.push({
      id: 'slack-signed-delivery',
      status: 'skip',
      detail: `signed delivery check skipped: ${!signingSecret ? 'SLACK_SIGNING_SECRET not set' : 'no HTTPS base URL (DOMAIN_NAME) configured'}`,
    });
  }

  // 3. Slack-side event-URL verification is an external manual gate. We can
  //    prove OUR endpoint answers a signed challenge, but only a human can
  //    make Slack itself verify and save the Request URL in the app config.
  checks.push({
    id: 'slack-event-url',
    status: 'skip',
    detail:
      `[EXTERNAL] manual gate — Slack-side event-URL verification cannot be completed from AWS. Paste ${baseUrl ? `${trimTrailingSlash(baseUrl)}${SLACK_EVENTS_PATH}` : `https://<DOMAIN_NAME>${SLACK_EVENTS_PATH}`} into api.slack.com > your app > Event Subscriptions > Request URL and let Slack verify it. See the post-deploy instructions printed by scripts/deploy.ts and the Slack setup section of the README.`,
  });

  return checks;
}

function telegramSetWebhookCurl(agentId: string, expectedUrl: string): string {
  const body = JSON.stringify({
    url: expectedUrl,
    secret_token: '$TELEGRAM_WEBHOOK_SECRET',
    allowed_updates: [...TELEGRAM_ALLOWED_UPDATES],
  });
  return (
    `curl -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" ` +
    `-H "Content-Type: application/json" -d '${body}' ` +
    `# token for agent "${agentId}" from TELEGRAM_TOKENS_JSON`
  );
}

export async function validateTelegramSurface(opts: {
  tokensJson?: string;
  webhookSecret?: string;
  expectedBaseUrl?: string;
  register?: boolean;
  fetchFn?: FetchFn;
}): Promise<SurfaceCheck[]> {
  const { tokensJson, webhookSecret, expectedBaseUrl, register = false } = opts;
  const fetchFn = opts.fetchFn ?? fetch;
  const checks: SurfaceCheck[] = [];

  if (!tokensJson) {
    return [{ id: 'telegram-tokens', status: 'skip', detail: 'TELEGRAM_TOKENS_JSON not set' }];
  }

  let tokens: Record<string, string>;
  try {
    tokens = JSON.parse(tokensJson) as Record<string, string>;
  } catch (err) {
    return [
      {
        id: 'telegram-tokens',
        status: 'fail',
        detail: `TELEGRAM_TOKENS_JSON is not valid JSON: ${errMessage(err)}`,
        remediation: 'Fix TELEGRAM_TOKENS_JSON to a {"agentId":"token"} JSON map.',
      },
    ];
  }

  for (const [agentId, token] of Object.entries(tokens)) {
    // 1. Token validity via getMe (mirrors scripts/lib/telegram-check.ts).
    if (!/^\d{8,12}:[A-Za-z0-9_-]{30,}$/.test(token)) {
      checks.push({
        id: `telegram-${agentId}-auth`,
        status: 'fail',
        detail: 'token format does not match the expected Telegram bot token pattern',
        remediation: `Re-issue the bot token for agent "${agentId}" via @BotFather and update TELEGRAM_TOKENS_JSON.`,
      });
      continue;
    }
    let tokenOk = false;
    try {
      const resp = await fetchFn(`https://api.telegram.org/bot${token}/getMe`);
      const data = (await resp.json()) as {
        ok: boolean;
        result?: { username?: string };
        description?: string;
      };
      if (data.ok && data.result) {
        tokenOk = true;
        checks.push({
          id: `telegram-${agentId}-auth`,
          status: 'token-valid',
          detail: `getMe ok (@${data.result.username ?? '?'}) — token valid; delivery not yet proven`,
        });
      } else {
        checks.push({
          id: `telegram-${agentId}-auth`,
          status: 'fail',
          detail: `getMe failed: ${data.description ?? 'unknown error from telegram'}`,
          remediation: `Re-issue the bot token for agent "${agentId}" via @BotFather and update TELEGRAM_TOKENS_JSON.`,
        });
      }
    } catch (err) {
      checks.push({
        id: `telegram-${agentId}-auth`,
        status: 'fail',
        detail: `getMe request failed: ${errMessage(err)}`,
        remediation: 'Verify outbound network access to api.telegram.org and retry.',
      });
    }
    if (!tokenOk) continue;

    // 2. Delivery verification: the registered webhook URL must match what
    //    the deployment actually serves.
    if (!expectedBaseUrl) {
      checks.push({
        id: `telegram-${agentId}-webhook`,
        status: 'skip',
        detail: 'no HTTPS base URL (DOMAIN_NAME) configured; webhook URL match not checked',
      });
      continue;
    }
    const expectedUrl = `${trimTrailingSlash(expectedBaseUrl)}${telegramWebhookPath(agentId)}`;
    const checkId = `telegram-${agentId}-webhook`;
    try {
      const readWebhookUrl = async (): Promise<string> => {
        const resp = await fetchFn(`https://api.telegram.org/bot${token}/getWebhookInfo`);
        const data = (await resp.json()) as {
          ok: boolean;
          result?: { url?: string };
          description?: string;
        };
        if (!data.ok) throw new Error(data.description ?? 'getWebhookInfo failed');
        return data.result?.url ?? '';
      };

      let currentUrl = await readWebhookUrl();
      if (currentUrl === expectedUrl) {
        checks.push({
          id: checkId,
          status: 'delivery-verified',
          detail: `getWebhookInfo URL matches ${expectedUrl}`,
        });
        continue;
      }

      if (register) {
        // Deploy registers the webhook itself once DNS resolves (plan item 13).
        const setResp = await fetchFn(`https://api.telegram.org/bot${token}/setWebhook`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: expectedUrl,
            secret_token: webhookSecret ?? '',
            allowed_updates: [...TELEGRAM_ALLOWED_UPDATES],
          }),
        });
        const setData = (await setResp.json()) as { ok: boolean; description?: string };
        if (!setData.ok) {
          checks.push({
            id: checkId,
            status: 'fail',
            detail: `setWebhook failed: ${setData.description ?? 'unknown error from telegram'}`,
            remediation: telegramSetWebhookCurl(agentId, expectedUrl),
          });
          continue;
        }
        currentUrl = await readWebhookUrl();
        if (currentUrl === expectedUrl) {
          checks.push({
            id: checkId,
            status: 'delivery-verified',
            detail: `webhook registered by deploy and re-verified: getWebhookInfo URL matches ${expectedUrl}`,
          });
        } else {
          checks.push({
            id: checkId,
            status: 'fail',
            detail: `setWebhook succeeded but getWebhookInfo still reports "${currentUrl || '(none)'}" instead of ${expectedUrl}`,
            remediation: telegramSetWebhookCurl(agentId, expectedUrl),
          });
        }
      } else {
        checks.push({
          id: checkId,
          status: 'fail',
          detail: `getWebhookInfo URL is "${currentUrl || '(none)'}" but the deployment serves ${expectedUrl}`,
          remediation:
            `Register the webhook manually:\n  ${telegramSetWebhookCurl(agentId, expectedUrl)}\n` +
            `Then confirm with:\n  curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getWebhookInfo"\n` +
            `Expected output: {"ok":true,"result":{"url":"${expectedUrl}","has_custom_certificate":false,"pending_update_count":0,...}}`,
        });
      }
    } catch (err) {
      checks.push({
        id: checkId,
        status: 'fail',
        detail: `webhook verification failed: ${errMessage(err)}`,
        remediation: telegramSetWebhookCurl(agentId, expectedUrl),
      });
    }
  }

  return checks;
}

function isLocalhost(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '[::1]'
  );
}

export async function validateDashboardSurface(opts: {
  baseUrl?: string;
  token?: string;
  fetchFn?: FetchFn;
}): Promise<SurfaceCheck[]> {
  const { baseUrl, token } = opts;
  const fetchFn = opts.fetchFn ?? fetch;

  if (!baseUrl || !token) {
    return [
      {
        id: 'dashboard-auth',
        status: 'skip',
        detail: !token
          ? 'DASHBOARD_TOKEN not set'
          : 'no base URL (DOMAIN_NAME) configured for the dashboard',
      },
    ];
  }

  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return [
      {
        id: 'dashboard-auth',
        status: 'fail',
        detail: `dashboard base URL is not a valid URL: ${baseUrl}`,
        remediation: 'Set DOMAIN_NAME to the deployed dashboard hostname.',
      },
    ];
  }

  // Bearer tokens over plain HTTP are interceptable; refuse before any
  // network call. Localhost is the only exception (dev/tunnel loopback).
  if (parsed.protocol === 'http:' && !isLocalhost(parsed.hostname)) {
    return [
      {
        id: 'dashboard-https',
        status: 'fail',
        detail: `dashboard auth must never ride plain HTTP (base URL is ${baseUrl})`,
        remediation:
          'Serve the dashboard over HTTPS (domain + ACM cert on the ALB) or use the private SSM tunnel (localhost) — never send the bearer token over plain HTTP.',
      },
    ];
  }

  const url = `${trimTrailingSlash(baseUrl)}/api/agents`;
  try {
    const resp = await fetchFn(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (resp.status === 200) {
      return [
        {
          id: 'dashboard-auth',
          status: 'delivery-verified',
          detail: `authenticated GET ${url} returned 200 — dashboard token round-trip succeeded`,
        },
      ];
    }
    if (resp.status === 401) {
      return [
        {
          id: 'dashboard-auth',
          status: 'fail',
          detail: `authenticated GET ${url} returned 401 — the deployed dashboard rejected the token we hold`,
          remediation:
            'DASHBOARD_TOKEN differs from the value the deployment loaded. Update the dashboard secret in Secrets Manager (or .env for local), then force a new ECS deployment so tasks re-read it.',
        },
      ];
    }
    return [
      {
        id: 'dashboard-auth',
        status: 'fail',
        detail: `authenticated GET ${url} returned unexpected HTTP ${resp.status}`,
        remediation:
          'Confirm the dashboard service is healthy (/ready) and that the ALB/CloudFront routes /api/* to it.',
      },
    ];
  } catch (err) {
    return [
      {
        id: 'dashboard-auth',
        status: 'fail',
        detail: `authenticated GET ${url} failed: ${errMessage(err)}`,
        remediation: 'Confirm DNS resolves to the ALB and HTTPS is serving on the dashboard domain.',
      },
    ];
  }
}

/** Placeholder-shaped values count as NOT configured (plan item 11). */
function configured(value: string | undefined): value is string {
  return Boolean(value && value.trim() !== '' && value !== 'REPLACE_ME');
}

/**
 * Orchestrates the per-surface validators based on which env values are
 * present. Any configured-surface failure flips `anyConfiguredFailed` so
 * the caller (deploy.ts / verify) can exit nonzero with the remediations.
 */
export async function validateConfiguredSurfaces(
  env: Record<string, string | undefined>,
  opts: { register: boolean; fetchFn?: FetchFn },
): Promise<{ checks: SurfaceCheck[]; anyConfiguredFailed: boolean }> {
  const fetchFn = opts.fetchFn ?? fetch;
  const baseUrl = configured(env.DOMAIN_NAME) ? `https://${env.DOMAIN_NAME}` : undefined;
  const checks: SurfaceCheck[] = [];

  if (configured(env.SLACK_BOT_TOKEN)) {
    checks.push(
      ...(await validateSlackSurface({
        botToken: env.SLACK_BOT_TOKEN,
        signingSecret: configured(env.SLACK_SIGNING_SECRET) ? env.SLACK_SIGNING_SECRET : undefined,
        baseUrl,
        fetchFn,
      })),
    );
  }

  if (configured(env.TELEGRAM_TOKENS_JSON)) {
    checks.push(
      ...(await validateTelegramSurface({
        tokensJson: env.TELEGRAM_TOKENS_JSON,
        webhookSecret: configured(env.TELEGRAM_WEBHOOK_SECRET)
          ? env.TELEGRAM_WEBHOOK_SECRET
          : undefined,
        expectedBaseUrl: baseUrl,
        register: opts.register,
        fetchFn,
      })),
    );
  }

  if (configured(env.DASHBOARD_TOKEN) && baseUrl) {
    checks.push(
      ...(await validateDashboardSurface({
        baseUrl,
        token: env.DASHBOARD_TOKEN,
        fetchFn,
      })),
    );
  }

  return { checks, anyConfiguredFailed: checks.some((c) => c.status === 'fail') };
}
