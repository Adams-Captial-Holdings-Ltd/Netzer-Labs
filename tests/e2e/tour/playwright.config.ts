import { defineConfig } from '@playwright/test';

// End-to-end smoke for the guided tour against a LIVE deploy.
// Run: CCE_TOKEN=... npx playwright test --config tests/e2e/tour/playwright.config.ts
export default defineConfig({
  testDir: '.',
  timeout: 180_000,
  expect: { timeout: 25_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    headless: true,
    viewport: { width: 1440, height: 900 },
    ignoreHTTPSErrors: true,
    screenshot: 'only-on-failure',
  },
});
