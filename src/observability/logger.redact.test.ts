import { Writable } from 'node:stream';
import { expect, it } from 'vitest';
import { createLogger } from './logger.js';

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
