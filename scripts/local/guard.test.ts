/**
 * The local AWS isolation guard is the one thing standing between a developer
 * machine and a real AWS account, so its refusal cases are worth locking down.
 * Every case below was also verified by hand against a running emulator.
 */

import { describe, it, expect } from 'vitest';
import { staticChecks } from './guard.js';

const LOCAL = {
  AWS_ENDPOINT_URL: 'http://127.0.0.1:4566',
  AWS_REGION: 'us-east-1',
  AWS_ACCESS_KEY_ID: 'local',
  AWS_SECRET_ACCESS_KEY: 'local',
} as NodeJS.ProcessEnv;

const allOk = (env: NodeJS.ProcessEnv) => staticChecks(env).every((c) => c.ok);
const failed = (env: NodeJS.ProcessEnv) => staticChecks(env).filter((c) => !c.ok).map((c) => c.id);

describe('local AWS isolation guard', () => {
  it('passes on a correct local configuration', () => {
    expect(allOk(LOCAL)).toBe(true);
  });

  it('refuses when AWS_ENDPOINT_URL is unset, which would reach real AWS', () => {
    const { AWS_ENDPOINT_URL: _drop, ...env } = LOCAL;
    expect(failed(env)).toContain('endpoint-set');
  });

  it('refuses a remote endpoint', () => {
    const env = { ...LOCAL, AWS_ENDPOINT_URL: 'https://dynamodb.us-east-1.amazonaws.com' };
    expect(failed(env)).toContain('endpoint-loopback');
  });

  it('refuses a malformed endpoint rather than assuming it is safe', () => {
    expect(failed({ ...LOCAL, AWS_ENDPOINT_URL: 'not-a-url' })).toContain('endpoint-loopback');
  });

  it.each(['http://localhost:4566', 'http://127.0.0.1:4566', 'http://[::1]:4566'])(
    'accepts loopback host %s',
    (url) => {
      expect(allOk({ ...LOCAL, AWS_ENDPOINT_URL: url })).toBe(true);
    },
  );

  it.each(['AKIAIOSFODNN7EXAMPLE', 'ASIAIOSFODNN7EXAMPLE'])(
    'refuses real-looking access key %s',
    (key) => {
      expect(failed({ ...LOCAL, AWS_ACCESS_KEY_ID: key })).toContain('fake-credentials');
    },
  );

  it.each(['AWS_PROFILE', 'AWS_SESSION_TOKEN'])('refuses inherited %s', (name) => {
    expect(failed({ ...LOCAL, [name]: 'something' })).toContain('no-inherited-identity');
  });
});
