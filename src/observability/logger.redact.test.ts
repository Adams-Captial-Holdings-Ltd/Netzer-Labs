import { Writable } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createLogger } from './logger.js';

vi.mock('pino', async (importActual) => {
  const actual = await importActual<typeof import('pino')>();
  return { ...actual, pino: Object.assign(vi.fn(actual.pino), actual.pino) };
});

beforeEach(() => vi.stubEnv('LOG_LEVEL', 'info'));
afterEach(() => vi.unstubAllEnvs());

it('redacts credentials while keeping ordinary fields', () => {
  let output = '';
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString();
      callback();
    },
  });
  createLogger(stream).info({
    authorization: 'top-auth-value',
    headers: { authorization: 'header-auth-value' },
    req: { headers: { authorization: 'req-auth-value' } },
    request: { authorization: 'request-auth-value' },
    password: 'password-value',
    token: 'token-value',
    secret: 'secret-value',
    apiKey: 'apikey-value',
    nested: {
      password: 'nested-password-value',
      token: 'nested-token-value',
      secret: 'nested-secret-value',
      apiKey: 'nested-apikey-value',
    },
    agentId: 'main',
  }, 'dispatch');

  const line = JSON.parse(output);
  expect(line.authorization).toBe('[redacted]');
  expect(line.headers.authorization).toBe('[redacted]');
  expect(line.req.headers.authorization).toBe('[redacted]');
  expect(line.request.authorization).toBe('[redacted]');
  for (const key of ['password', 'token', 'secret', 'apiKey']) {
    expect(line[key]).toBe('[redacted]');
    expect(line.nested[key]).toBe('[redacted]');
  }
  expect(line.agentId).toBe('main');
  expect(output).not.toMatch(/(?:top|header|req|request)-auth-value|(?:nested-)?(?:password|token|secret|apikey)-value/);
});

it('redacts Paperclip secret spellings and nested authorization headers', () => {
  let output = '';
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString();
      callback();
    },
  });
  const names = [
    'lock_auditor_key', 'lockAuditorKey', 'PAPERCLIP_LOCK_AUDITOR_KEY',
    'agent_keys', 'agentKeys', 'PAPERCLIP_AGENT_KEYS_JSON',
    'reconciler_key', 'reconcilerKey', 'PAPERCLIP_RECONCILER_KEY',
    'dispatch_secret', 'dispatchSecret', 'PAPERCLIP_DISPATCH_SECRET',
  ];
  const fields = Object.fromEntries(names.map((name) => [name, 'raw-value']));
  createLogger(stream).info({
    Authorization: 'raw-value',
    headers: { Authorization: 'raw-value' },
    req: { headers: { Authorization: 'raw-value' } },
    request: { headers: { authorization: 'raw-value', Authorization: 'raw-value' } },
    ...fields,
    nested: fields,
  });

  const line = JSON.parse(output);
  expect(line.Authorization).toBe('[redacted]');
  expect(line.headers.Authorization).toBe('[redacted]');
  expect(line.req.headers.Authorization).toBe('[redacted]');
  expect(line.request.headers.authorization).toBe('[redacted]');
  expect(line.request.headers.Authorization).toBe('[redacted]');
  for (const name of names) {
    expect(line[name]).toBe('[redacted]');
    expect(line.nested[name]).toBe('[redacted]');
  }
  expect(output).not.toContain('raw-value');
});

it.each([undefined, '1'])('passes redaction to pino without a destination (LOG_PRETTY=%s)', async (pretty) => {
  vi.stubEnv('LOG_PRETTY', pretty);
  vi.resetModules();
  const { createLogger: freshCreateLogger } = await import('./logger.js');
  const { pino: freshPino } = await import('pino');
  vi.mocked(freshPino).mockClear();
  freshCreateLogger();
  const options = vi.mocked(freshPino).mock.lastCall?.[0];
  expect(Boolean(options?.transport)).toBe(Boolean(pretty));
  expect(options?.redact).toEqual(expect.objectContaining({
    paths: expect.arrayContaining(['authorization', 'lock_auditor_key', '*.headers.authorization']),
    censor: '[redacted]',
  }));
});
