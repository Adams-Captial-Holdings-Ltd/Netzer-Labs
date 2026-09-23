import { test, expect, type Page } from '@playwright/test';

// P2 (step 4) — the turn lifecycle as a person meets it, in a real browser against
// the chat mock (CCE_CHAT_MOCK=1, web/dev/mock-stream-plugin.ts). Written BEFORE
// the change, as the bar (netzar-chat-plan/p2-proof.sh rows E-1..E-6).
//
//   - WI-2.4: the composer stays editable while a reply streams (Send waits for
//     the turn), Escape stops the reply, every conversation keeps its own draft,
//     and the cursor comes back to the composer when a reply ends.
//   - Decisions 37 + 41: under a reply, each tool shows what it found; a shortened
//     result says so and a failed one says so; the arguments are visible in the tab
//     that watched the turn and are NOT there after a reload (never stored).
//   - MSG-03: a reply the person stopped is still marked stopped after a reload.
//
// The mock is the only local way to drive a tool call at all — against Floci the
// model stub never asks for a tool (development.md, Known local limitations 2).
// Identity is seeded exactly as chat.spec.ts does; see its comment for why that
// is not an authorization bypass.
const CAPS = ['overview:read', 'chat:read', 'agents:read', 'sessions:read'];

const STOPPED = 'stopped — partial reply, no run recorded';
const REPLY = 'Here is the summary you asked for'; // web/dev/fixtures.ts, the default reply
const TOOLS_REPLY = 'Here is what the failed staging rollout came down to.'; // the tools fixture
const FOUND = 'Found 3 pages about the failed rollout.'; // the tools fixture: call 1's result
const ARGS = '{"query":"failed staging rollout"}'; // the tools fixture: call 1's arguments

test.beforeEach(async ({ page }) => {
  await page.addInitScript((caps) => {
    localStorage.setItem('cce_token', 'local-dev-dashboard-token');
    localStorage.setItem('cce_onboarded', 'true');
    localStorage.setItem('cce_role', 'admin');
    localStorage.setItem('cce_capabilities', JSON.stringify(caps));
  }, CAPS);
});

const composerOf = (page: Page) => page.getByRole('textbox', { name: /^Message / });
const sendOf = (page: Page) => page.getByRole('button', { name: 'Send message' });
const stopOf = (page: Page) => page.getByRole('button', { name: 'Stop generating' });

/** Open the chat and start a fresh conversation, the way a person does (P56). */
async function newChat(page: Page) {
  await page.goto('/dashboard/chat');
  await expect(composerOf(page)).toBeVisible();
  await page.getByRole('button', { name: 'New chat' }).first().click();
}

async function sendText(page: Page, text: string) {
  await composerOf(page).fill(text);
  await expect(sendOf(page)).toBeEnabled();
  await sendOf(page).click();
}

test('keeps the composer editable while a reply streams', async ({ page }) => {
  await newChat(page);
  await sendText(page, '/fixture longstream');
  await expect(stopOf(page)).toBeVisible();

  const composer = composerOf(page);
  await expect(composer).toBeEnabled();
  await composer.fill('a follow-up I am still writing');
  // Still streaming: the control is Stop, so a second turn cannot start.
  await expect(stopOf(page)).toBeVisible();
  await expect(sendOf(page)).toHaveCount(0);

  // When the reply ends, the draft is still there, untouched.
  await expect(sendOf(page)).toBeVisible({ timeout: 30_000 });
  await expect(composer).toHaveValue('a follow-up I am still writing');
});

test('stops the reply with the Escape key', async ({ page }) => {
  await newChat(page);
  await sendText(page, '/fixture longstream');
  await expect(page.getByText('Line 3:').first()).toBeVisible();

  await composerOf(page).press('Escape');

  await expect(sendOf(page)).toBeVisible({ timeout: 5_000 });
  await expect(page.getByText(STOPPED)).toBeVisible();
});

test("keeps each conversation's own draft", async ({ page }) => {
  await page.goto('/dashboard/chat');
  const composer = composerOf(page);
  await expect(composer).toBeVisible();
  const first = page.locator('button[title="Wiring the turn stream"]');
  const second = page.locator('button[title="Which model is the LP update agent on?"]');

  await first.click();
  await composer.fill('draft for the first conversation');
  await second.click();
  await expect(composer).toHaveValue('');
  await composer.fill('draft for the second conversation');

  await first.click();
  await expect(composer).toHaveValue('draft for the first conversation');
  await second.click();
  await expect(composer).toHaveValue('draft for the second conversation');
});

test('puts the cursor back in the composer after a reply', async ({ page }) => {
  await newChat(page);
  await sendText(page, 'where does the cursor go?');
  await expect(page.getByText(REPLY).first()).toBeVisible();
  await expect(sendOf(page)).toBeVisible({ timeout: 30_000 });

  await expect(composerOf(page)).toBeFocused();
});

test('shows what each tool found, and keeps it after a reload', async ({ page }) => {
  await newChat(page);
  await sendText(page, '/fixture tools');
  await expect(page.getByText(TOOLS_REPLY)).toBeVisible({ timeout: 30_000 });
  await expect(sendOf(page)).toBeVisible({ timeout: 30_000 });

  await page.getByRole('button', { name: /Used 5 tools/ }).click();
  await expect(page.getByText(FOUND)).toBeVisible();
  await expect(page.getByText(ARGS)).toBeVisible(); // arguments: this tab watched the turn
  await expect(page.getByText('Output shortened')).toBeVisible(); // call 2 was capped
  await expect(page.getByText('Failed', { exact: true })).toBeVisible(); // call 3 failed

  await page.reload();
  await expect(page.getByText(TOOLS_REPLY)).toBeVisible();
  await page.getByRole('button', { name: /Used 5 tools/ }).click();
  await expect(page.getByText(FOUND)).toBeVisible(); // the result was kept
  await expect(page.getByText(ARGS)).toHaveCount(0); // the arguments never were
});

test('keeps a stopped reply stopped after a reload', async ({ page }) => {
  await newChat(page);
  await sendText(page, '/fixture longstream');
  await expect(page.getByText('Line 3:').first()).toBeVisible();

  await stopOf(page).click();
  await expect(page.getByText(STOPPED)).toBeVisible();

  await page.reload();
  await expect(page.getByText('Line 1: the quick brown fox').first()).toBeVisible();
  await expect(page.getByText(STOPPED)).toBeVisible();
});
