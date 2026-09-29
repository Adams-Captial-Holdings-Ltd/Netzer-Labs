import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    // WI-0.3: arms the AWS guard in every worker. See vitest.setup.ts.
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.test.ts', 'infra/**/*.test.ts', 'scripts/**/*.test.ts'],
    // F1: integration tests have their own config + LocalStack dep.
    // They share the `.test.ts` extension only so editors highlight
    // them the same way.
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.integration.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts', 'infra/**/*.ts'],
      exclude: ['**/*.test.ts', '**/*.integration.test.ts', '**/*.d.ts'],
    },
  },
});
