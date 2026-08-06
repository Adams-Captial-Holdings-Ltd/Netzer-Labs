import { describe, it, expect } from 'vitest';
import { buildApp } from './server.js';
import type { Env } from './config/env.js';

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

  it('GET / returns plain text banner', async () => {
    const app = buildApp(baseEnv);
    const res = await app.request('/');
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('ClaudeClaw Enterprise');
    expect(text).toContain('us-east-1');
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
