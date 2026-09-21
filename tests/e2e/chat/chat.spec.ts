import { test, expect } from '@playwright/test';

// The two behaviours F1 has to prove locally, in one journey because the second
// depends on the first: a message streams an assistant reply, and RELOADING the
// page brings the stored turns back. Every other row of the F1 gate reads the
// repository and proves shape; this file is the only one that runs the product.
//
// Identity is SEEDED, not typed. web/src/lib/auth.ts hydrates `currentRole` and
// `currentCapabilities` from localStorage before /whoami resolves, and the chat
// route is capability-gated on `chat:read` (web/src/app.tsx). Seeding them is
// what lets this suite run with no orchestrator and no emulator. It decides
// only what the SPA renders — in a deployed environment the backend re-checks
// every capability on every route and is the sole authority.
const CAPS = ['overview:read', 'chat:read', 'agents:read', 'sessions:read'];

// Distinct enough that it cannot collide with the mock's sidebar row titles.
const PROMPT = 'f1 harness: does a reload replay the turns?';

// A phrase from the default fixture's reply and from nowhere else on the page.
// The sidebar's row titles are a separate list, so this text can only be here
// because the assistant turn is rendered (web/dev/fixtures.ts).
const REPLY = 'Here is the summary you asked for';

// The LAST line of that same reply (web/dev/fixtures.ts). REPLY opens the text,
// so a truncated stream still carries it; this phrase only appears if the WHOLE
// reply was streamed, stored and replayed. It is the row that would catch the
// mid-stream race returning — see the end-of-turn wait below.
const REPLY_END = 'pull the underlying audit events';

test.beforeEach(async ({ page }) => {
  await page.addInitScript((caps) => {
    localStorage.setItem('cce_token', 'local-dev-dashboard-token');
    localStorage.setItem('cce_onboarded', 'true');
    localStorage.setItem('cce_role', 'admin');
    localStorage.setItem('cce_capabilities', JSON.stringify(caps));
  }, CAPS);
});

test('streams a reply, then replays the stored turns after a reload', async ({ page }) => {
  await page.goto('/dashboard/chat');

  const composer = page.getByRole('textbox', { name: /^Message / });
  await expect(composer).toBeVisible();

  // Start the conversation the way a user does. This is load-bearing, not
  // decoration: `rememberChatId` is called ONLY from `startNewChat` and
  // `openConversation` (web/src/pages/Chat.tsx), never from `send`, so the
  // chatId a fresh mount mints is not written to sessionStorage and a reload
  // cannot resume it. `.first()` because the sidebar and the header each offer
  // the button.
  await page.getByRole('button', { name: 'New chat' }).first().click();

  // Send. The button is gated on a non-empty draft AND on an agent to route to,
  // so waiting for it to enable is the real readiness signal — it means the
  // mocked /agents roster has loaded, not merely that the page painted.
  await composer.fill(PROMPT);
  const send = page.getByRole('button', { name: 'Send message' });
  await expect(send).toBeEnabled();
  await send.click();

  // The reply streams in over mock SSE, whose chunk events carry the text
  // cumulatively. The prompt assertion is scoped to the message row, not to the
  // page: the prompt is ALSO the conversation's title, and that title is derived
  // from Chat.tsx's own state, so a page-wide match could be satisfied by the
  // header alone while the transcript itself rendered nothing. `role="group"` +
  // `aria-label` is the row's own markup (the ported MessageRow under
  // web/src/components/chat/lc/), so this can only pass on the rendered bubble.
  const sentMessage = page.getByRole('group', { name: 'Your message' }).getByText(PROMPT);
  await expect(sentMessage).toBeVisible();
  await expect(page.getByText(REPLY).first()).toBeVisible();

  // WAIT FOR THE TURN TO END, not for its first output. A cumulative SSE reply
  // becomes VISIBLE long before it is COMPLETE, so reloading on the assertion
  // above raced the stream: the mock recorded whatever fraction had been sent
  // (~7-11% of the fixture, varying per run) and said so — `stream cut mid-turn`
  // printed on an otherwise GREEN run. The end-of-turn signal is the product's
  // own: the composer's control reads "Stop generating" while a turn streams and
  // returns to "Send message" when it ends (web/src/components/chat/Composer.tsx).
  // A sleep would only have slowed the race down.
  //
  // This must stay AFTER the REPLY assertion. Before any output arrives the Send
  // button has not been swapped out yet, so the wait would be satisfied by the
  // pre-send state and prove nothing.
  await expect(send).toBeVisible();

  // THE ROW THAT MATTERS. The active conversation id lives in sessionStorage
  // (`cce_chat_active`, web/src/lib/chat/helpers.ts), which survives a reload,
  // so Chat.tsx reopens the same chat and GETs /sessions/transcript for it.
  // Until the mock replayed that route this failed: the transcript answered a
  // hard-coded `{"turns":[]}` and the page fell back to its empty landing
  // state, which is why a local reload could not be driven at all.
  await page.reload();
  await expect(sentMessage).toBeVisible();
  await expect(page.getByText(REPLY).first()).toBeVisible();
  // The tail, not just the head. REPLY alone passed even when only a tenth of
  // the reply had been stored, so it could not tell a complete replay from a
  // truncated one. This phrase can.
  await expect(page.getByText(REPLY_END)).toBeVisible();
});
