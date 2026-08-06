/**
 * Integration test config — exercises real AWS SDK calls against a
 * LocalStack endpoint instead of mocks. Run with:
 *
 *   docker compose -f docker-compose.test.yml up -d
 *   npm run test:integration
 *   docker compose -f docker-compose.test.yml down
 *
 * The wrapper script `scripts/test-integration.sh` does the lifecycle
 * automatically for CI.
 *
 * Unit tests live in vitest.config.ts; this config picks up files
 * ending in `.integration.test.ts` only.
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['src/**/*.integration.test.ts', 'scripts/**/*.integration.test.ts'],
    // LocalStack cold start + DDB table create per test file is slow;
    // bump from vitest's default 5s.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Run sequentially so the shared LocalStack endpoint doesn't get
    // hammered by parallel test files creating tables of the same name.
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/*.integration.test.ts', '**/*.d.ts'],
    },
  },
});
