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

// Since P2 a stopped turn's usage IS recorded, settled from an estimate (the step 4
// review): the footer says so instead of "no run recorded".
const STOPPED = 'stopped — partial reply, cost estimated';
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

  // Editable NOW, while the reply streams. The chat suite's expect timeout is 30 s
  // (playwright.config.ts), long enough to outlast the whole fixture, so a
  // default-timeout check here would simply wait for the reply to end and pass.
  const composer = composerOf(page);
  await expect(composer).toBeEditable({ timeout: 2_000 });
  await composer.fill('a follow-up I am still writing', { timeout: 2_000 });
  // Still streaming: the control is Stop, so a second turn cannot start.
  await expect(stopOf(page)).toBeVisible({ timeout: 2_000 });
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
  // `:visible` — the conversation list is rendered twice (the desktop rail and the
  // hidden mobile drawer), so a bare title match finds two buttons.
  const first = page.locator('button[title="Wiring the turn stream"]:visible');
  const second = page.locator('button[title="Which model is the LP update agent on?"]:visible');

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

// The step 4 review (six read-only reviewers, 2026-09-23), written BEFORE the fix:
//   - a draft typed in a new chat, before anything was sent, vanished on New chat or
//     on a look at another conversation (it was filed under an id nothing reopens);
//   - `done: not_saved` reached the parser and stopped there;
//   - the Escape that closes a Japanese or Chinese input method also stopped the paid
//     reply; Escape did nothing while the Stop button had focus;
//   - the tool panel's output had no label, its capped boxes could not be reached from
//     the keyboard, a shortened input was not marked, and a call the Stop interrupted
//     looked like one that returned nothing;
//   - a typed error came out as "Something went wrong: Something went wrong on our side".
const NOT_SAVED_REPLY = 'This answer arrived, but the server could not store it.'; // the notsaved fixture

test('keeps a draft typed in a new chat', async ({ page }) => {
  await page.goto('/dashboard/chat');
  const composer = composerOf(page);
  await expect(composer).toBeVisible();
  await page.getByRole('button', { name: 'New chat' }).first().click();
  await composer.fill('a question for a brand-new chat');

  // New chat again, from a chat with nothing sent yet: the words stay.
  await page.getByRole('button', { name: 'New chat' }).first().click();
  await expect(composer).toHaveValue('a question for a brand-new chat');

  // A look at an older conversation, then back to a new chat: the words come back.
  await page.locator('button[title="Wiring the turn stream"]:visible').click();
  await expect(composer).toHaveValue('');
  await page.getByRole('button', { name: 'New chat' }).first().click();
  await page.getByPlaceholder('NEW CHAT').fill('NEW CHAT');
  await page.getByRole('button', { name: 'Start new chat' }).click();
  await expect(composer).toHaveValue('a question for a brand-new chat');
});

test('tells the reader when a reply was not saved', async ({ page }) => {
  await newChat(page);
  await sendText(page, '/fixture notsaved');
  await expect(page.getByText(NOT_SAVED_REPLY).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/wasn.t saved/i)).toBeVisible();
});

test('does not stop the reply when Escape only closes the input method', async ({ page }) => {
  await newChat(page);
  await sendText(page, '/fixture longstream');
  await expect(stopOf(page)).toBeVisible();

  // The keydown a Japanese or Chinese input method sends when it closes its candidates.
  await composerOf(page).evaluate((el) => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true, cancelable: true }));
  });

  await page.waitForTimeout(500);
  await expect(stopOf(page)).toBeVisible();
  await expect(page.getByText(STOPPED)).toHaveCount(0);
});

test('stops the reply with Escape while the Stop button has focus', async ({ page }) => {
  await newChat(page);
  await sendText(page, '/fixture longstream');
  await expect(page.getByText('Line 3:').first()).toBeVisible();

  await stopOf(page).focus();
  await page.keyboard.press('Escape');

  await expect(sendOf(page)).toBeVisible({ timeout: 5_000 });
  await expect(page.getByText(STOPPED)).toBeVisible();
});

test("labels each tool's output and lets the keyboard reach it", async ({ page }) => {
  await newChat(page);
  await sendText(page, '/fixture tools');
  await expect(sendOf(page)).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: /Used 5 tools/ }).click();

  await expect(page.getByText('Output', { exact: true }).first()).toBeVisible();
  // The capped boxes scroll on their own, so the keyboard has to be able to reach them.
  const found = page.locator('pre', { hasText: FOUND });
  await expect(found).toHaveAttribute('tabindex', '0');
  await expect(found).toHaveAttribute('aria-label', /output/i);
});

test("says when a tool's input was shortened", async ({ page }) => {
  await newChat(page);
  await sendText(page, '/fixture tool-capped');
  await expect(sendOf(page)).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: /Used 1 tool/ }).click();

  await expect(page.getByText('Input shortened')).toBeVisible();
});

test('marks a tool call the Stop interrupted', async ({ page }) => {
  await newChat(page);
  await sendText(page, '/fixture tools');
  // The status line shows while call 1 runs; its result is a second away.
  await expect(page.getByText('web search…').first()).toBeVisible();
  await composerOf(page).press('Escape');
  await expect(sendOf(page)).toBeVisible({ timeout: 5_000 });

  await page.getByRole('button', { name: /Used 1 tool/ }).click();
  await expect(page.getByText('No result')).toBeVisible();
});

test('sends each message with its own id and asks for protocol 2', async ({ page }) => {
  await newChat(page);
  const sent = page.waitForRequest((r) => r.url().includes('/api/test-turn/stream') && r.method() === 'POST');
  await sendText(page, 'which body does the page send?');

  const body = (await sent).postDataJSON() as { clientMessageId?: string; protocol?: number };
  expect(body.protocol).toBe(2);
  expect(body.clientMessageId).toMatch(/^[A-Za-z0-9._:-]{1,64}$/);
});

test('shows a typed error in the words the server chose', async ({ page }) => {
  await newChat(page);
  await sendText(page, '/fixture typed-error');

  await expect(page.getByText('Something went wrong on our side. Try again.', { exact: true })).toBeVisible();
  await expect(page.getByText(/Something went wrong: Something went wrong/)).toHaveCount(0);
});
