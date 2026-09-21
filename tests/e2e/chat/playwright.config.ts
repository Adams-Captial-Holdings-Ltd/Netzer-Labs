import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

// Local chat harness (F1, step 2 of the roadmap). Drives the dashboard Chat tab
// against the LOCAL Vite dev server with the dev-only chat mock
// (`CCE_CHAT_MOCK=1`) — never a deployed URL. This suite runs on every pull
// request, and a gate that quietly dialled a deployment would spend real money
// each time. The deployed-URL suites are separate (tests/e2e/tour, jarvis).
//
// Run: npm run e2e:chat
//
// It needs NO emulator and NO orchestrator. The Chat tab's three
// DynamoDB-backed reads (/agents, /sessions, /sessions/transcript) are answered
// by web/dev/mock-stream-plugin.ts, and identity is seeded into localStorage by
// the spec, which web/src/lib/auth.ts hydrates from before /whoami resolves.
//
// `webServer` owns the dev server's whole lifecycle, so the spec holds no
// spawn, no port polling and no teardown.
//
// PORT 5180, matching tests/e2e/battle. Vite binds `localhost`, which resolves
// to IPv6 ::1 on macOS, so the base URL must say `localhost` and not the IPv4
// literal (development.md, Troubleshooting).
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

export default defineConfig({
  testDir: '.',
  timeout: 120_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5180',
    headless: true,
    viewport: { width: 1440, height: 900 },
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'npm --prefix web run dev -- --port 5180 --strictPort',
    cwd: repoRoot,
    url: 'http://localhost:5180/dashboard/',
    env: { CCE_CHAT_MOCK: '1' },
    // Deliberately never reuse. A dev server already on 5180 was probably
    // started WITHOUT the mock flag, and reusing it fails the suite for a
    // reason that looks like a product defect. With --strictPort a busy port
    // fails loudly instead, which is the answer you can act on.
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
