import { describe, it, expect } from 'vitest';
import {
  computeSlackSignature,
  validateSlackSurface,
  validateTelegramSurface,
  validateDashboardSurface,
  validateConfiguredSurfaces,
  telegramWebhookPath,
  SLACK_EVENTS_PATH,
  TELEGRAM_ALLOWED_UPDATES,
  type FetchFn,
  type SurfaceCheck,
} from './surface-validate.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

type RecordedCall = { url: string; init?: RequestInit };

/** Recording fake fetch: routes by URL substring, records every call. */
function fakeFetch(
  routes: Array<{ match: (url: string) => boolean; respond: (call: RecordedCall) => Response }>,
): { fetchFn: FetchFn; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchFn: FetchFn = async (input, init) => {
    const call = { url: String(input), init };
    calls.push(call);
    const route = routes.find((r) => r.match(call.url));
    if (!route) throw new Error(`unexpected fetch: ${call.url}`);
    return route.respond(call);
  };
  return { fetchFn, calls };
}

function byId(checks: SurfaceCheck[], id: string): SurfaceCheck {
  const found = checks.find((c) => c.id === id);
  if (!found) throw new Error(`no check with id ${id} in ${JSON.stringify(checks.map((c) => c.id))}`);
  return found;
}

const headerOf = (call: RecordedCall, name: string): string =>
  (call.init?.headers as Record<string, string>)[name];

describe('computeSlackSignature', () => {
  it('matches a precomputed v0= signature for a fixed secret/ts/body', () => {
    // Precomputed independently with node:crypto:
    //   HMAC-SHA256('8f742231b10e8888abcd99yyyzzz85a5',
    //     'v0:1531420618:token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J')
    expect(
      computeSlackSignature(
        '8f742231b10e8888abcd99yyyzzz85a5',
        '1531420618',
        'token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J',
      ),
    ).toBe('v0=bca5eef5dd737ed259b428b18cd24f679baa18c3fc5f1cb2a6ac9f03e717969a');
  });
});

describe('validateSlackSurface', () => {
  const SECRET = 'aaaabbbbccccddddeeeeffff00001111';

  /** Behaves like src/adapters/slack/handler.ts: verify signature FIRST, then echo the challenge. */
  function slackEventsServer(serverSecret: string) {
    return (call: RecordedCall): Response => {
      const body = String(call.init?.body);
      const ts = headerOf(call, 'x-slack-request-timestamp');
      const sig = headerOf(call, 'x-slack-signature');
      if (sig !== computeSlackSignature(serverSecret, ts, body)) {
        return jsonResponse({ error: 'unauthorized', reason: 'bad_signature' }, 401);
      }
      const payload = JSON.parse(body) as { type: string; challenge: string };
      if (payload.type !== 'url_verification') return jsonResponse({ ok: true });
      return jsonResponse({ challenge: payload.challenge });
    };
  }

  it('reports token-valid plus delivery-verified when the signed challenge round-trips', async () => {
    const { fetchFn, calls } = fakeFetch([
      {
        match: (u) => u.includes('slack.com/api/auth.test'),
        respond: () => jsonResponse({ ok: true, team: 'acme', user: 'cce-bot' }),
      },
      { match: (u) => u.includes('/slack/events'), respond: slackEventsServer(SECRET) },
    ]);

    const checks = await validateSlackSurface({
      botToken: 'xoxb-test',
      signingSecret: SECRET,
      baseUrl: 'https://cce.example.com',
      fetchFn,
    });

    expect(byId(checks, 'slack-auth').status).toBe('token-valid');
    expect(byId(checks, 'slack-signed-delivery').status).toBe('delivery-verified');
    // The external app-config gate is always reported honestly as a skip.
    const external = byId(checks, 'slack-event-url');
    expect(external.status).toBe('skip');
    expect(external.detail).toContain('[EXTERNAL]');
    expect(external.detail).toContain(SLACK_EVENTS_PATH);

    // The synthetic request is signed exactly as Slack does.
    const eventsCall = calls.find((c) => c.url === `https://cce.example.com${SLACK_EVENTS_PATH}`);
    expect(eventsCall).toBeDefined();
    const ts = headerOf(eventsCall!, 'x-slack-request-timestamp');
    expect(Math.abs(Number(ts) - Date.now() / 1000)).toBeLessThan(60);
    const body = String(eventsCall!.init?.body);
    expect(JSON.parse(body)).toMatchObject({ type: 'url_verification' });
    expect(JSON.parse(body).challenge).toMatch(/^cce-verify-[0-9a-f]{16}$/);
    expect(headerOf(eventsCall!, 'x-slack-signature')).toBe(
      computeSlackSignature(SECRET, ts, body),
    );
  });

  it('fails the delivery check with Secrets Manager remediation when the deployed secret differs', async () => {
    const { fetchFn } = fakeFetch([
      {
        match: (u) => u.includes('slack.com/api/auth.test'),
        respond: () => jsonResponse({ ok: true, team: 'acme', user: 'cce-bot' }),
      },
      // The "deployed" server holds a DIFFERENT signing secret.
      {
        match: (u) => u.includes('/slack/events'),
        respond: slackEventsServer('99998888777766665555444433332222'),
      },
    ]);

    const checks = await validateSlackSurface({
      botToken: 'xoxb-test',
      signingSecret: SECRET,
      baseUrl: 'https://cce.example.com',
      fetchFn,
    });

    const delivery = byId(checks, 'slack-signed-delivery');
    expect(delivery.status).toBe('fail');
    expect(delivery.detail).toContain('401');
    expect(delivery.remediation).toMatch(/Secrets Manager/);
    // Token validity is reported independently of delivery (two-level honesty).
    expect(byId(checks, 'slack-auth').status).toBe('token-valid');
  });

  it('surfaces the Slack error string when auth.test rejects the token', async () => {
    const { fetchFn } = fakeFetch([
      {
        match: (u) => u.includes('slack.com/api/auth.test'),
        respond: () => jsonResponse({ ok: false, error: 'invalid_auth' }),
      },
    ]);
    const checks = await validateSlackSurface({ botToken: 'xoxb-bad', fetchFn });
    const auth = byId(checks, 'slack-auth');
    expect(auth.status).toBe('fail');
    expect(auth.detail).toContain('invalid_auth');
  });

  it('skips the signed-delivery check when signing secret or base URL is missing', async () => {
    const { fetchFn } = fakeFetch([
      {
        match: (u) => u.includes('slack.com/api/auth.test'),
        respond: () => jsonResponse({ ok: true, team: 't', user: 'u' }),
      },
    ]);
    const checks = await validateSlackSurface({ botToken: 'xoxb-test', fetchFn });
    expect(byId(checks, 'slack-signed-delivery').status).toBe('skip');
  });
});

describe('validateTelegramSurface', () => {
  const TOKEN = `12345678:${'A'.repeat(40)}`;
  const BASE = 'https://cce.example.com';
  const EXPECTED_URL = `${BASE}${telegramWebhookPath('main')}`;

  it('exposes the path the deployed server actually serves', () => {
    expect(telegramWebhookPath('main')).toBe('/tg/main/webhook');
  });

  it('reports delivery-verified when getWebhookInfo already matches', async () => {
    const { fetchFn } = fakeFetch([
      {
        match: (u) => u.endsWith('/getMe'),
        respond: () => jsonResponse({ ok: true, result: { id: 1, username: 'cce_main_bot' } }),
      },
      {
        match: (u) => u.endsWith('/getWebhookInfo'),
        respond: () => jsonResponse({ ok: true, result: { url: EXPECTED_URL } }),
      },
    ]);
    const checks = await validateTelegramSurface({
      tokensJson: JSON.stringify({ main: TOKEN }),
      expectedBaseUrl: BASE,
      fetchFn,
    });
    expect(byId(checks, 'telegram-main-auth').status).toBe('token-valid');
    expect(byId(checks, 'telegram-main-webhook').status).toBe('delivery-verified');
  });

  it('registers the webhook itself on mismatch when register=true, then re-verifies', async () => {
    let registered = false;
    const { fetchFn, calls } = fakeFetch([
      {
        match: (u) => u.endsWith('/getMe'),
        respond: () => jsonResponse({ ok: true, result: { id: 1, username: 'cce_main_bot' } }),
      },
      {
        match: (u) => u.endsWith('/getWebhookInfo'),
        respond: () => jsonResponse({ ok: true, result: { url: registered ? EXPECTED_URL : '' } }),
      },
      {
        match: (u) => u.endsWith('/setWebhook'),
        respond: () => {
          registered = true;
          return jsonResponse({ ok: true });
        },
      },
    ]);

    const checks = await validateTelegramSurface({
      tokensJson: JSON.stringify({ main: TOKEN }),
      webhookSecret: 'whsec-123',
      expectedBaseUrl: BASE,
      register: true,
      fetchFn,
    });

    expect(byId(checks, 'telegram-main-webhook').status).toBe('delivery-verified');

    const setCall = calls.find((c) => c.url.endsWith('/setWebhook'));
    expect(setCall).toBeDefined();
    const body = JSON.parse(String(setCall!.init?.body)) as Record<string, unknown>;
    expect(body.url).toBe(EXPECTED_URL);
    expect(body.secret_token).toBe('whsec-123');
    expect(body.allowed_updates).toEqual([...TELEGRAM_ALLOWED_UPDATES]);
    expect(body.allowed_updates).toEqual([...TELEGRAM_ALLOWED_UPDATES]);

    // getWebhookInfo is re-checked AFTER setWebhook (verify, don't assume).
    const order = calls.map((c) => c.url.split('/').pop());
    expect(order.indexOf('setWebhook')).toBeGreaterThan(order.indexOf('getWebhookInfo'));
    expect(order.lastIndexOf('getWebhookInfo')).toBeGreaterThan(order.indexOf('setWebhook'));
  });

  it('fails on mismatch with the exact manual setWebhook curl when register=false', async () => {
    const { fetchFn, calls } = fakeFetch([
      {
        match: (u) => u.endsWith('/getMe'),
        respond: () => jsonResponse({ ok: true, result: { id: 1, username: 'cce_main_bot' } }),
      },
      {
        match: (u) => u.endsWith('/getWebhookInfo'),
        respond: () => jsonResponse({ ok: true, result: { url: 'https://old.example.com/hook' } }),
      },
    ]);

    const checks = await validateTelegramSurface({
      tokensJson: JSON.stringify({ main: TOKEN }),
      expectedBaseUrl: BASE,
      register: false,
      fetchFn,
    });

    const webhook = byId(checks, 'telegram-main-webhook');
    expect(webhook.status).toBe('fail');
    expect(webhook.remediation).toContain('setWebhook');
    expect(webhook.remediation).toContain(EXPECTED_URL);
    expect(webhook.remediation).toContain('getWebhookInfo');
    expect(webhook.remediation).toContain(`"allowed_updates":${JSON.stringify([...TELEGRAM_ALLOWED_UPDATES])}`);
    // register=false must never mutate anything.
    expect(calls.some((c) => c.url.endsWith('/setWebhook'))).toBe(false);
  });

  it('fails per-agent on an invalid token without calling the network', async () => {
    const { fetchFn, calls } = fakeFetch([]);
    const checks = await validateTelegramSurface({
      tokensJson: JSON.stringify({ main: 'not-a-token' }),
      fetchFn,
    });
    expect(byId(checks, 'telegram-main-auth').status).toBe('fail');
    expect(calls).toHaveLength(0);
  });

  it('fails fast on malformed TELEGRAM_TOKENS_JSON', async () => {
    const { fetchFn, calls } = fakeFetch([]);
    const checks = await validateTelegramSurface({ tokensJson: '{nope', fetchFn });
    expect(byId(checks, 'telegram-tokens').status).toBe('fail');
    expect(calls).toHaveLength(0);
  });
});

describe('validateDashboardSurface', () => {
  it('refuses plain HTTP for a non-localhost base URL without any network call', async () => {
    const { fetchFn, calls } = fakeFetch([]);
    const checks = await validateDashboardSurface({
      baseUrl: 'http://cce.example.com',
      token: 'tok',
      fetchFn,
    });
    expect(checks).toHaveLength(1);
    expect(checks[0].id).toBe('dashboard-https');
    expect(checks[0].status).toBe('fail');
    expect(checks[0].detail).toContain('dashboard auth must never ride plain HTTP');
    expect(calls).toHaveLength(0);
  });

  it('allows http://localhost (private tunnel) and verifies the bearer round-trip', async () => {
    const { fetchFn, calls } = fakeFetch([
      {
        match: (u) => u.endsWith('/api/agents'),
        respond: (call) =>
          headerOf(call, 'Authorization') === 'Bearer good-token'
            ? jsonResponse({ agents: [] })
            : jsonResponse({ error: 'unauthorized' }, 401),
      },
    ]);
    const checks = await validateDashboardSurface({
      baseUrl: 'http://localhost:3000',
      token: 'good-token',
      fetchFn,
    });
    expect(byId(checks, 'dashboard-auth').status).toBe('delivery-verified');
    expect(calls[0].url).toBe('http://localhost:3000/api/agents');
  });

  it('fails with remediation when the deployed dashboard returns 401', async () => {
    const { fetchFn } = fakeFetch([
      {
        match: (u) => u.endsWith('/api/agents'),
        respond: () => jsonResponse({ error: 'unauthorized' }, 401),
      },
    ]);
    const checks = await validateDashboardSurface({
      baseUrl: 'https://cce.example.com',
      token: 'stale-token',
      fetchFn,
    });
    const auth = byId(checks, 'dashboard-auth');
    expect(auth.status).toBe('fail');
    expect(auth.detail).toContain('401');
    expect(auth.remediation).toMatch(/DASHBOARD_TOKEN/);
  });
});

describe('validateConfiguredSurfaces', () => {
  const TOKEN = `12345678:${'A'.repeat(40)}`;

  it('skips unconfigured surfaces entirely (no checks, no fetches)', async () => {
    const { fetchFn, calls } = fakeFetch([
      {
        match: (u) => u.endsWith('/getMe'),
        respond: () => jsonResponse({ ok: true, result: { id: 1, username: 'bot' } }),
      },
    ]);
    const result = await validateConfiguredSurfaces(
      { TELEGRAM_TOKENS_JSON: JSON.stringify({ main: TOKEN }) },
      { register: false, fetchFn },
    );
    // Telegram only: no slack-* or dashboard-* checks appear.
    expect(result.checks.every((c) => c.id.startsWith('telegram-'))).toBe(true);
    // No DOMAIN_NAME → webhook URL match is an honest skip, not a failure.
    expect(byId(result.checks, 'telegram-main-webhook').status).toBe('skip');
    expect(result.anyConfiguredFailed).toBe(false);
    expect(calls.every((c) => c.url.includes('api.telegram.org'))).toBe(true);
  });

  it('treats placeholder-shaped values as unconfigured', async () => {
    const { fetchFn, calls } = fakeFetch([]);
    const result = await validateConfiguredSurfaces(
      {
        SLACK_BOT_TOKEN: 'REPLACE_ME',
        TELEGRAM_TOKENS_JSON: '',
        DASHBOARD_TOKEN: 'REPLACE_ME',
        DOMAIN_NAME: 'cce.example.com',
      },
      { register: false, fetchFn },
    );
    expect(result.checks).toHaveLength(0);
    expect(result.anyConfiguredFailed).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('flags a configured-surface failure so the caller can exit nonzero', async () => {
    const { fetchFn } = fakeFetch([
      {
        match: (u) => u.includes('slack.com/api/auth.test'),
        respond: () => jsonResponse({ ok: false, error: 'account_inactive' }),
      },
    ]);
    const result = await validateConfiguredSurfaces(
      { SLACK_BOT_TOKEN: 'xoxb-dead' },
      { register: false, fetchFn },
    );
    expect(byId(result.checks, 'slack-auth').status).toBe('fail');
    expect(result.anyConfiguredFailed).toBe(true);
  });

  it('does not let skip statuses flip anyConfiguredFailed', async () => {
    const { fetchFn } = fakeFetch([
      {
        match: (u) => u.includes('slack.com/api/auth.test'),
        respond: () => jsonResponse({ ok: true, team: 't', user: 'u' }),
      },
    ]);
    const result = await validateConfiguredSurfaces(
      { SLACK_BOT_TOKEN: 'xoxb-ok' }, // no signing secret, no domain → skips
      { register: false, fetchFn },
    );
    expect(result.checks.some((c) => c.status === 'skip')).toBe(true);
    expect(result.anyConfiguredFailed).toBe(false);
  });

  it('derives the base URL from DOMAIN_NAME and runs the dashboard round-trip', async () => {
    const { fetchFn, calls } = fakeFetch([
      {
        match: (u) => u.endsWith('/api/agents'),
        respond: () => jsonResponse({ agents: [] }),
      },
    ]);
    const result = await validateConfiguredSurfaces(
      { DASHBOARD_TOKEN: 'tok', DOMAIN_NAME: 'cce.example.com' },
      { register: false, fetchFn },
    );
    expect(byId(result.checks, 'dashboard-auth').status).toBe('delivery-verified');
    expect(calls[0].url).toBe('https://cce.example.com/api/agents');
    expect(headerOf(calls[0], 'Authorization')).toBe('Bearer tok');
  });
});
