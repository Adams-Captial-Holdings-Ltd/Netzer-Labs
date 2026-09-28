import { test, expect, type Page, type Request } from '@playwright/test';

// P7 (step 9) — hardening as a person meets it, in a real browser against the chat mock (CCE_CHAT_MOCK=1,
// web/dev/mock-stream-plugin.ts). Written BEFORE the change, as the bar (netzar-chat-plan/p7-proof.sh rows T-7
// and T-8, work order A).
//
//   - A233 (owner decision 65; Jev a233_fallback null_as_id): the page keeps each reply's requestId, from the
//     transcript or from the clientMessageId it sent for a live reply, and names it on Regenerate (`replyTo`).
//     The server refuses a tab that is behind with 409 reply_changed; the page reloads the conversation from
//     the server and tells the person, in one sentence, that the chat changed in another tab. The mock mirrors
//     that rule as part of the build (M139); nothing implements the tie today, which is why T-7 is red.
//   - A240: a connection that drops mid-reply is already saved by the server as a stopped reply. The page
//     re-reads the conversation and shows what the server saved, with no failure alert and no Try again (after
//     a send, that would store the question twice). "/fixture drop" makes the mock record the partial reply as
//     stopped, as the route's abort path does, and then drop the connection with the body unfinished.
//
// Identity is seeded as chat.spec.ts does (see its comment for why that is not an authorization bypass), on the
// browser context so a second tab has it too. Each test works in a conversation of its own (M96): the whole
// suite shares one mock server.
const CAPS = ['overview:read', 'chat:read', 'agents:read', 'sessions:read'];

const REPLY = 'Here is the summary you asked for'; // web/dev/fixtures.ts, the default reply
const REGEN = 'Here is a fresh answer to the same question.'; // the mock's regen fixture (P6)
const DROP = '/fixture drop';
const DROP_START = 'The rollout reached'; // the drop fixture's first chunk begins with this
const DROP_TEXT = 'The rollout reached the first two regions before the third one'; // all it streams before the drop

test.beforeEach(async ({ context }) => {
  await context.addInitScript((caps) => {
    localStorage.setItem('cce_token', 'local-dev-dashboard-token');
    localStorage.setItem('cce_onboarded', 'true');
    localStorage.setItem('cce_role', 'admin');
    localStorage.setItem('cce_capabilities', JSON.stringify(caps));
  }, CAPS);
});

const composerOf = (page: Page) => page.getByRole('textbox', { name: /^Message / });
const sendOf = (page: Page) => page.getByRole('button', { name: 'Send message' });
const stopOf = (page: Page) => page.getByRole('button', { name: 'Stop generating' });
const tryAgainOf = (page: Page) => page.getByRole('button', { name: 'Try again', exact: true });
const userBubbles = (page: Page) => page.getByRole('group', { name: 'Your message' });
const replies = (page: Page) => page.getByRole('group', { name: 'Assistant message' });
const fileInputOf = (page: Page) => page.locator('input[type="file"]');
// The scrolling column the conversation lives in (ChatCanvas); the screen-reader announcer is outside it.
const transcriptOf = (page: Page) => page.locator('[data-tour="chat-messages"]');
// `:visible` — the conversation list is rendered twice (the desktop rail and the hidden mobile drawer).
const row = (page: Page, title: string) => page.locator(`button[title="${title}"]:visible`);
const isTurnPost = (r: Request) => r.method() === 'POST' && r.url().endsWith('/api/test-turn/stream');

/** Open the chat and start a fresh conversation, the way a person does (P56). */
async function newChat(page: Page) {
  await page.goto('/dashboard/chat');
  await expect(composerOf(page)).toBeVisible();
  await page.getByRole('button', { name: 'New chat' }).first().click();
}

async function openChat(page: Page) {
  await page.goto('/dashboard/chat');
  await expect(composerOf(page)).toBeVisible();
}

/** Send, then wait for the product's own end-of-turn signal (P60). */
async function sendAndWait(page: Page, text: string) {
  await composerOf(page).fill(text);
  await expect(sendOf(page)).toBeEnabled();
  await sendOf(page).click();
  await waitForEnd(page);
}

async function waitForEnd(page: Page) {
  await expect(stopOf(page)).toHaveCount(0, { timeout: 30_000 });
  await expect(sendOf(page)).toBeVisible();
}

/** Click the last reply's Regenerate; resolve once the whole answer has arrived (P135). */
async function regenerateLast(page: Page) {
  const asked = page.waitForRequest(isTurnPost);
  const answered = page.waitForResponse((r) => isTurnPost(r.request()));
  await replies(page).last().hover();
  await replies(page).last().getByRole('button', { name: 'Regenerate' }).click();
  const sent = (await asked).postDataJSON() as Record<string, unknown>;
  const response = await answered;
  const body = await response.text();
  return { sent, status: response.status(), body };
}

/** A JSON body, or the start of whatever else came back (today a regenerate answers with a stream). */
function jsonOrText(text: string): unknown {
  try { return JSON.parse(text); } catch { return text.slice(0, 120); }
}

/** The text of an element matching `pattern` that a person can see: not the announcer's 1x1 box (P116). */
async function seenText(page: Page, pattern: RegExp): Promise<string> {
  for (const el of await page.getByText(pattern).all()) {
    const box = await el.boundingBox();
    if (box && box.width > 1 && box.height > 1) return (await el.innerText()).trim();
  }
  return '';
}

test('P7 regenerate in a second tab that is behind is refused and the page reloads the chat', async ({ page, context }) => {
  const question = `Which region failed first in run ${Date.now()}?`;
  const followUp = 'And which one failed second?';
  const sentByA: Array<Record<string, unknown>> = [];
  page.on('request', (r) => { if (isTurnPost(r)) sentByA.push(r.postDataJSON() as Record<string, unknown>); });

  // Tab A: a conversation with one reply.
  await newChat(page);
  await sendAndWait(page, question);
  const first = sentByA.at(-1)!;
  const chatId = String(first.chatId);

  // Tab B opens the same conversation from the list, and shows that reply.
  const behind = await context.newPage();
  await openChat(behind);
  await row(behind, question).click();
  await expect(replies(behind)).toHaveCount(1);
  await expect(replies(behind).first()).toContainText(REPLY);

  // Tab A moves the conversation on: a second question and its reply.
  await page.bringToFront();
  await sendAndWait(page, followUp);
  const second = sentByA.at(-1)!;
  await expect(replies(page)).toHaveCount(2);

  // Tab B still shows only the first reply, and asks to regenerate it.
  await behind.bringToFront();
  const refused = await regenerateLast(behind);
  // It names the reply it shows: the one the first send produced...
  expect(refused.sent.replyTo, 'Regenerate names the reply this tab shows').toBe(first.clientMessageId);
  // ...which is no longer the conversation's last reply, so the server refuses.
  expect([refused.status, jsonOrText(refused.body)]).toEqual([409, { error: 'reply_changed' }]);

  // The page reloads the conversation from the server...
  await expect(userBubbles(behind).filter({ hasText: followUp })).toHaveCount(1);
  await expect(userBubbles(behind)).toHaveCount(2);
  await expect(replies(behind)).toHaveCount(2);
  await expect(replies(behind).filter({ hasText: REGEN })).toHaveCount(0);
  // ...and says, in one sentence the person can see, that the chat changed in another tab.
  await expect.poll(() => seenText(behind, /another tab/i), { timeout: 10_000 })
    .toMatch(/^[^.!?]*another tab[^.!?]*[.!?]?$/i);
  // A refusal, not a failure: nothing to try again.
  await expect(tryAgainOf(behind)).toHaveCount(0);

  // Nothing was answered again: the server holds the conversation exactly as tab A left it.
  const stored = await behind.request.get(`/api/sessions/transcript?agentId=main&chatId=${encodeURIComponent(chatId)}`);
  const turns = ((await stored.json()) as { turns: Array<{ role: string; text: string }> }).turns;
  expect(turns.map((t) => (t.role === 'user' ? t.text : t.text.includes(REPLY) ? 'the default reply' : t.text)))
    .toEqual([question, 'the default reply', followUp, 'the default reply']);

  // Tab A is not behind: its Regenerate names the live reply it received, and goes ahead.
  await page.bringToFront();
  const accepted = await regenerateLast(page);
  expect(accepted.sent.replyTo, 'a live reply is named by the id its send carried').toBe(second.clientMessageId);
  expect(accepted.status).toBe(200);
  await expect(replies(page).last()).toContainText(REGEN);
  await waitForEnd(page);
});

test('P7 a reply cut off by a dropped connection shows what the server saved', async ({ page }) => {
  await newChat(page);
  await composerOf(page).fill(DROP);
  await expect(sendOf(page)).toBeEnabled();
  await sendOf(page).click();

  // The reply streams (a positive anchor with a short timeout, P103) until the connection drops.
  await expect(transcriptOf(page).getByText(DROP_START).first()).toBeVisible({ timeout: 10_000 });
  await waitForEnd(page);

  // The page shows what the server saved: the partial reply, marked stopped...
  const reply = replies(page).last();
  await expect(reply).toContainText(/stopped/i, { timeout: 10_000 });
  await expect(reply).toContainText(DROP_TEXT);
  // ...once, after the question once.
  await expect(replies(page)).toHaveCount(1);
  await expect(userBubbles(page).filter({ hasText: DROP })).toHaveCount(1);
  // No failure alert, and no Try again that would store the question a second time.
  await expect(transcriptOf(page).getByRole('alert')).toHaveCount(0);
  await expect(tryAgainOf(page)).toHaveCount(0);

  // It is what the server holds: a reload shows the same.
  await page.reload();
  await expect(replies(page)).toHaveCount(1);
  await expect(replies(page).last()).toContainText(DROP_TEXT);
  await expect(replies(page).last()).toContainText(/stopped/i);
  await expect(userBubbles(page).filter({ hasText: DROP })).toHaveCount(1);
});

// P7 (step 9) — work order B: the file note is a notice (A241). A file-only
// send with nothing the model can see is saved as a notice (C-1/C-2, unit and
// route level); here, as a person meets it: the note offers no Regenerate,
// including after a reload. The mock's file-only trigger (mock-stream-plugin.ts)
// mirrors today's plain-reply shape; it does NOT mark the note `status:
// 'notice'` server-side (the builder's job), which is why this is red: on
// reload, transcriptToMessages does not know the reply was a notice, and
// Regenerate reappears.
test('P7 after a reload the file note offers no Regenerate', async ({ page }) => {
  await newChat(page);
  await fileInputOf(page).setInputFiles({ name: 'plan.txt', mimeType: 'text/plain', buffer: Buffer.from('the plan') });
  await expect(page.getByRole('progressbar', { name: /^Uploading /})).toHaveCount(0);
  await expect(sendOf(page)).toBeEnabled();
  await sendOf(page).click();
  await waitForEnd(page);

  const live = replies(page).last();
  await expect(live).toContainText(/stored/i);
  await live.hover();
  await expect(live.getByRole('button', { name: 'Regenerate' })).toHaveCount(0);

  await page.reload();
  await expect(replies(page)).toHaveCount(1);
  const reloaded = replies(page).last();
  await expect(reloaded).toContainText(/stored/i);
  await reloaded.hover();
  await expect(reloaded.getByRole('button', { name: 'Regenerate' })).toHaveCount(0);
});
