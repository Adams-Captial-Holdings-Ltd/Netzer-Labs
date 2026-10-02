import { describe, it, expect, vi } from 'vitest';
import { buildApp, buildPrivateDispatchApp } from './server.js';
import type { Env } from './config/env.js';
import { logger } from './observability/logger.js';

const baseEnv: Env = {
  NODE_ENV: 'production',
  PORT: 3000,
  LOG_LEVEL: 'info',
  AWS_REGION: 'us-east-1',
  BEDROCK_EMBED_MODEL: 'amazon.titan-embed-text-v2:0',
  BEDROCK_GUARDRAIL_VERSION: 'DRAFT',
  CONFIG_CACHE_TTL_SECONDS: 300,
  NOVA_SONIC_MODEL: 'amazon.nova-2-sonic-v1:0',
  JARVIS_MAX_SESSION_SECONDS: 420,
  JARVIS_VOICE_ID: 'Tiffany',
  JARVIS_MAX_CONCURRENT_SESSIONS: 5,
  JARVIS_TTS_VOICE_ID: 'Brian',
  JARVIS_TTS_ENGINE: 'neural',
  JARVIS_TTS_LANGUAGE: 'en-GB',
  JARVIS_TTS_RATE: '116%',
  JARVIS_GREETING: 'How are you, sir? What can I do for you?',
  NOVA_HTTP2_TIMEOUT_MS: 470_000,
};

describe('server', () => {
  it('private dispatch logs thrown route errors and returns JSON 500', async () => {
    const error = vi.spyOn(logger, 'error').mockImplementation(() => {});
    try {
      const res = await buildPrivateDispatchApp({ secret: () => { throw new Error('dispatch failed'); } })
        .request('/api/paperclip/dispatch', { method: 'POST' });
      expect(res.status).toBe(500);
      expect(res.headers.get('content-type')).toContain('application/json');
      expect(await res.json()).toEqual({ error: 'internal_error' });
      expect(error).toHaveBeenCalledWith({ err: 'dispatch failed' }, 'unhandled error');
    } finally {
      error.mockRestore();
    }
  });

  it('private dispatch returns JSON 404 for an unknown path', async () => {
    const res = await buildPrivateDispatchApp().request('/unknown');
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toEqual({ error: 'not_found', path: '/unknown' });
  });

  it('GET /health returns 200 with status ok', async () => {
    const app = buildApp(baseEnv);
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; uptime: number };
    expect(body.status).toBe('ok');
    expect(typeof body.uptime).toBe('number');
  });

  it('GET /ready returns 503 when not ready', async () => {
    const app = buildApp(baseEnv);
    const res = await app.request('/ready');
    expect(res.status).toBe(503);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('not_ready');
  });

  it('GET /ready returns 200 when Bedrock + surface are configured', async () => {
    const readyEnv: Env = {
      ...baseEnv,
      BEDROCK_SONNET_MODEL: 'us.x.y',
      SLACK_BOT_TOKEN: 'xoxb-test',
    };
    const app = buildApp(readyEnv);
    const res = await app.request('/ready');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('ready');
  });

  it('GET / redirects to the dashboard', async () => {
    const app = buildApp(baseEnv);
    const res = await app.request('/');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/dashboard');
  });

  it('GET /nonexistent returns 404', async () => {
    const app = buildApp(baseEnv);
    const res = await app.request('/nonexistent');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string; path: string };
    expect(body.error).toBe('not_found');
    expect(body.path).toBe('/nonexistent');
  });

  it('responses include X-Content-Type-Options security header', async () => {
    const app = buildApp(baseEnv);
    const res = await app.request('/health');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });
});
