import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  loadEnv,
  isReadyForTraffic,
  resetEnvCache,
  isDeployedTask,
  missingDeployConfig,
} from './env.js';

describe('env.ts', () => {
  const original = { ...process.env };

  beforeEach(() => {
    resetEnvCache();
    process.env = { ...original };
  });

  afterEach(() => {
    resetEnvCache();
    process.env = { ...original };
  });

  describe('loadEnv', () => {
    it('returns defaults when only minimal env is set', () => {
      delete process.env.NODE_ENV;
      delete process.env.PORT;
      delete process.env.LOG_LEVEL;
      delete process.env.AWS_REGION;
      const env = loadEnv();
      expect(env.NODE_ENV).toBe('development');
      expect(env.PORT).toBe(3000);
      expect(env.LOG_LEVEL).toBe('info');
      expect(env.AWS_REGION).toBe('us-east-1');
      expect(env.CONFIG_CACHE_TTL_SECONDS).toBe(300);
    });

    it('coerces PORT to a number', () => {
      process.env.PORT = '4000';
      const env = loadEnv();
      expect(env.PORT).toBe(4000);
      expect(typeof env.PORT).toBe('number');
    });

    it('rejects invalid PORT values', () => {
      process.env.PORT = '99999999';
      expect(() => loadEnv()).toThrow(/Invalid environment/);
    });

    it('rejects invalid LOG_LEVEL values', () => {
      process.env.LOG_LEVEL = 'verbose';
      expect(() => loadEnv()).toThrow(/Invalid environment/);
    });

    it('caches the parsed env (same reference across calls)', () => {
      const a = loadEnv();
      const b = loadEnv();
      expect(a).toBe(b);
    });

    it('resetEnvCache invalidates the cache', () => {
      process.env.PORT = '5000';
      const a = loadEnv();
      expect(a.PORT).toBe(5000);

      resetEnvCache();
      process.env.PORT = '6000';
      const b = loadEnv();
      expect(b.PORT).toBe(6000);
      expect(a).not.toBe(b);
    });
  });

  describe('isReadyForTraffic', () => {
    const baseEnv = {
      NODE_ENV: 'production' as const,
      PORT: 3000,
      LOG_LEVEL: 'info' as const,
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

    it('returns false when neither Bedrock nor surface is set', () => {
      expect(isReadyForTraffic(baseEnv)).toBe(false);
    });

    it('returns false when Bedrock is set but no surface', () => {
      expect(
        isReadyForTraffic({ ...baseEnv, BEDROCK_SONNET_MODEL: 'us.x.y' }),
      ).toBe(false);
    });

    it('returns false when surface is set but no Bedrock', () => {
      expect(isReadyForTraffic({ ...baseEnv, SLACK_BOT_TOKEN: 'xoxb-x' })).toBe(false);
    });

    it('returns true with Sonnet + Slack', () => {
      expect(
        isReadyForTraffic({
          ...baseEnv,
          BEDROCK_SONNET_MODEL: 'us.anthropic.claude-sonnet-4-6-v1:0',
          SLACK_BOT_TOKEN: 'xoxb-x',
        }),
      ).toBe(true);
    });

    it('returns true with Haiku-only + Telegram (the Haiku-only edge case)', () => {
      expect(
        isReadyForTraffic({
          ...baseEnv,
          BEDROCK_HAIKU_MODEL: 'us.anthropic.claude-haiku-4-5-v1:0',
          TELEGRAM_TOKENS_JSON: '{"main":"x"}',
        }),
      ).toBe(true);
    });

    it('returns true with Opus + Slack', () => {
      expect(
        isReadyForTraffic({
          ...baseEnv,
          BEDROCK_OPUS_MODEL: 'us.x.y',
          SLACK_BOT_TOKEN: 'xoxb-x',
        }),
      ).toBe(true);
    });

    it('rejects placeholder-shaped values everywhere (item 11)', () => {
      expect(
        isReadyForTraffic({
          ...baseEnv,
          BEDROCK_SONNET_MODEL: 'us.x.y',
          SLACK_BOT_TOKEN: 'REPLACE_ME',
        }),
      ).toBe(false);
      expect(
        isReadyForTraffic({
          ...baseEnv,
          BEDROCK_SONNET_MODEL: '<your-model-id>',
          SLACK_BOT_TOKEN: 'xoxb-x',
        }),
      ).toBe(false);
      expect(
        isReadyForTraffic({
          ...baseEnv,
          BEDROCK_SONNET_MODEL: 'us.x.y',
          TELEGRAM_TOKENS_JSON: '{"main":"REPLACE_ME"}',
        }),
      ).toBe(false);
    });

    it('infra-only mode is satisfied by model + dashboard auth, no surface', () => {
      expect(
        isReadyForTraffic({
          ...baseEnv,
          CCE_DEPLOY_MODE: 'infra-only' as const,
          BEDROCK_SONNET_MODEL: 'us.x.y',
          DASHBOARD_TOKEN: 'a-real-token',
        }),
      ).toBe(true);
      // ...but not without dashboard auth
      expect(
        isReadyForTraffic({
          ...baseEnv,
          CCE_DEPLOY_MODE: 'infra-only' as const,
          BEDROCK_SONNET_MODEL: 'us.x.y',
        }),
      ).toBe(false);
      // ...and not with a placeholder token
      expect(
        isReadyForTraffic({
          ...baseEnv,
          CCE_DEPLOY_MODE: 'infra-only' as const,
          BEDROCK_SONNET_MODEL: 'us.x.y',
          DASHBOARD_TOKEN: 'REPLACE_ME',
        }),
      ).toBe(false);
    });

    it('chat mode still requires a real surface even when dashboard auth exists', () => {
      expect(
        isReadyForTraffic({
          ...baseEnv,
          CCE_DEPLOY_MODE: 'chat' as const,
          BEDROCK_SONNET_MODEL: 'us.x.y',
          DASHBOARD_TOKEN: 'a-real-token',
        }),
      ).toBe(false);
    });
  });

  // Codex P2: the prod fail-fast must actually fire on a deployed task. It now
  // triggers on CCE_DEPLOY_MODE (now set on the task def) OR the ECS/Fargate
  // runtime markers, and stays inert in unit tests / local tooling.
  describe('isDeployedTask', () => {
    it('is false with none of the markers (tests / local)', () => {
      expect(isDeployedTask({})).toBe(false);
    });
    it('is false when only the deploy-mode knob is set (local dev exercising a mode)', () => {
      expect(isDeployedTask({ CCE_DEPLOY_MODE: 'chat' })).toBe(false);
      expect(isDeployedTask({ CCE_DEPLOY_MODE: 'infra-only', NODE_ENV: 'development' })).toBe(false);
    });
    it('is true on a real production / ECS-Fargate task', () => {
      expect(isDeployedTask({ NODE_ENV: 'production' })).toBe(true);
      expect(isDeployedTask({ ECS_CONTAINER_METADATA_URI_V4: 'http://169.254.170.2/v4' })).toBe(true);
      expect(isDeployedTask({ AWS_EXECUTION_ENV: 'AWS_ECS_FARGATE' })).toBe(true);
    });
  });

  describe('loadEnv prod fail-fast', () => {
    function stripConfig(): void {
      for (const k of [
        'NODE_ENV',
        'CCE_DEPLOY_MODE',
        'ECS_CONTAINER_METADATA_URI_V4',
        'AWS_EXECUTION_ENV',
        'BEDROCK_DEFAULT_MODEL',
        'BEDROCK_SONNET_MODEL',
        'BEDROCK_OPUS_MODEL',
        'BEDROCK_HAIKU_MODEL',
        'SLACK_BOT_TOKEN',
        'TELEGRAM_TOKENS_JSON',
      ]) {
        delete process.env[k];
      }
    }

    it('does NOT throw locally (dev, no markers) even with missing config', () => {
      stripConfig();
      expect(() => loadEnv()).not.toThrow();
    });

    it('does NOT throw locally even when CCE_DEPLOY_MODE is set in .env', () => {
      stripConfig();
      process.env.CCE_DEPLOY_MODE = 'chat'; // dev exercising chat mode
      expect(() => loadEnv()).not.toThrow();
    });

    it('throws on a deployed (production) chat task missing model + surface', () => {
      stripConfig();
      process.env.NODE_ENV = 'production';
      process.env.CCE_DEPLOY_MODE = 'chat';
      expect(() => loadEnv()).toThrow(/Refusing to start/);
    });

    it('throws when only the ECS runtime marker is present (mode unset)', () => {
      stripConfig();
      process.env.ECS_CONTAINER_METADATA_URI_V4 = 'http://169.254.170.2/v4';
      expect(() => loadEnv()).toThrow(/Refusing to start/);
    });

    it('does NOT throw on a deployed task that is fully configured', () => {
      stripConfig();
      process.env.NODE_ENV = 'production';
      process.env.CCE_DEPLOY_MODE = 'chat';
      process.env.BEDROCK_SONNET_MODEL = 'us.anthropic.claude-sonnet-4-6';
      process.env.SLACK_BOT_TOKEN = 'xoxb-real';
      expect(() => loadEnv()).not.toThrow();
    });

    it('missingDeployConfig reports the specific gaps', () => {
      const gaps = missingDeployConfig({
        NODE_ENV: 'production',
        PORT: 3000,
        LOG_LEVEL: 'info',
        AWS_REGION: 'us-east-1',
        CONFIG_CACHE_TTL_SECONDS: 300,
      } as Parameters<typeof missingDeployConfig>[0]);
      expect(gaps.length).toBe(2); // a Bedrock model + a surface token
    });
  });
});
