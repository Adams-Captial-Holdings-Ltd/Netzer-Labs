import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Diagnostics only. `npm test` never collects these: the root config includes
 * `*.test.ts`, and these files are `*.diag.ts`.
 *
 * The environment is the isolation backstop from development.md "AWS safety":
 * a dead endpoint and placeholder credentials, so a request that slipped past a
 * spy fails locally instead of reaching an account.
 */
export default defineConfig({
  test: {
    root: fileURLToPath(new URL('../../..', import.meta.url)),
    environment: 'node',
    globals: false,
    include: ['scripts/diagnostics/**/*.diag.ts'],
    testTimeout: 60_000,
    // Registering every tool module the way server.ts does takes ~15 s on Windows.
    hookTimeout: 120_000,
    env: {
      AWS_ENDPOINT_URL: 'http://127.0.0.1:9',
      AWS_ACCESS_KEY_ID: 'local',
      AWS_SECRET_ACCESS_KEY: 'local',
      AWS_REGION: 'us-east-1',
      AWS_EC2_METADATA_DISABLED: 'true',
    },
  },
});
