import { defineConfig } from '@playwright/test';

// End-to-end smoke for the Jarvis voice widget against a LIVE deploy.
// Run: CCE_TOKEN=... CCE_E2E_URL=https://claudeclaw-enterprise.com/dashboard/ \
//        npx playwright test --config tests/e2e/jarvis/playwright.config.ts
export default defineConfig({
  testDir: '.',
  timeout: 90_000,
  expect: { timeout: 25_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    headless: true,
    permissions: ['microphone'],
    ignoreHTTPSErrors: true,
    screenshot: 'only-on-failure',
    launchOptions: {
      args: [
        // Auto-grant + fake the mic so getUserMedia resolves headless, and let
        // the AudioContext/playback run without a real audio device.
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
      ],
    },
  },
});
