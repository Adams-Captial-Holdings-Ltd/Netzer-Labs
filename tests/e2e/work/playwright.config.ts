import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

// Local Work harness. The Vite plugin answers only /api/work; the specs seed
// dashboard identity in localStorage. The server and browser are owned by
// Playwright. This config is listed here but cannot run in the agent sandbox.
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

export default defineConfig({
  testDir: '.',
  timeout: 120_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  // The mock state is shared by the single Vite dev server process.
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5181',
    headless: true,
    viewport: { width: 1440, height: 900 },
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'npm --prefix web run dev -- --port 5181 --strictPort',
    cwd: repoRoot,
    url: 'http://localhost:5181/dashboard/',
    env: { CCE_WORK_MOCK: '1' },
    // Deliberately never reuse. A dev server already on 5181 was probably
    // started WITHOUT the mock flag, and reusing it fails the suite for a
    // reason that looks like a product defect. With --strictPort a busy port
    // fails loudly instead, which is the answer you can act on.
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
