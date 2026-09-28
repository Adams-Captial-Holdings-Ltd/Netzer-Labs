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
const DROP_LATE = '/fixture drop-late'; // the same drop, saved 700 ms after it (web/dev/mock-stream-plugin.ts)

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
const searchOf = (page: Page) => page.getByRole('searchbox', { name: 'Search chats' });
/** The one row currently marked as the open conversation, in whichever of the two rendered copies is visible (M96: every new-chat test finds its OWN row this way, never a shared fixture row). */
const activeRowOf = (page: Page) => page.locator('li:visible').filter({ has: page.locator('button[aria-current="true"]') });

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

// The real route saves a dropped reply only after its outbound scan (the AbortError path in
// src/adapters/dashboard/handler.ts), so that save can land after the page has seen the drop. The fresh
// critic's note: the test above only covers a reply saved BEFORE the drop. `drop-late` saves 700 ms after it.
test('P7 a reply saved a moment after its connection dropped is still shown', async ({ page }) => {
  await newChat(page);
  await composerOf(page).fill(DROP_LATE);
  await expect(sendOf(page)).toBeEnabled();
  await sendOf(page).click();

  await expect(transcriptOf(page).getByText(DROP_START).first()).toBeVisible({ timeout: 10_000 });
  await waitForEnd(page);

  // No failure alert and no Try again: the page waited for the save instead of giving up at once.
  await expect(transcriptOf(page).getByRole('alert')).toHaveCount(0);
  await expect(tryAgainOf(page)).toHaveCount(0);
  const reply = replies(page).last();
  await expect(reply).toContainText(/stopped/i, { timeout: 10_000 });
  await expect(reply).toContainText(DROP_TEXT);
  await expect(replies(page)).toHaveCount(1);
  await expect(userBubbles(page).filter({ hasText: DROP_LATE })).toHaveCount(1);
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

// P7 (step 9) — work order D: rename and search hardening (A229, A231, A234,
// A236, A239) and the not-saved regenerate alert (A235). Written BEFORE the
// change, as the bar (netzar-chat-plan/p7-proof.sh rows M-2..M-6, A-1). Each
// test opens a chat of its own (M96) rather than mutating a shared fixture
// row, so ordering and the suite's single worker never matter.

// A234 (council 3-0): pre-filling the rename box collapses whitespace control
// characters (line breaks, tabs) into single spaces, so a chat whose first
// message has a line break renames when saved UNTOUCHED. Today the raw `\n`
// in the first message flows unedited into the rename box and then into the
// PATCH body, which the route (and the dev mock, mock-stream-plugin.ts
// ~:596-599) refuses as `invalid_title` (a control character) — the generic
// failure toast this test proves absent.
test('P7 a chat whose first message has a line break renames without edits', async ({ page }) => {
  const firstLine = 'Weekly incident summary';
  const secondLine = 'keep it concise please';
  const collapsed = `${firstLine} ${secondLine}`;
  await newChat(page);
  await composerOf(page).fill(`${firstLine}\n${secondLine}`);
  await expect(sendOf(page)).toBeEnabled();
  await sendOf(page).click();
  await waitForEnd(page);

  const activeRow = activeRowOf(page);
  await activeRow.hover();
  await activeRow.getByRole('button', { name: /^Rename chat:/ }).click();
  await expect(page.getByRole('textbox', { name: 'Chat title' })).toBeVisible();

  const saved = page.waitForResponse((r) => r.request().method() === 'PATCH' && r.url().endsWith('/api/sessions'));
  await page.getByRole('button', { name: 'Save title' }).click();
  const response = await saved;

  // Saved untouched: the pre-fill already collapsed the line break, so the
  // server never sees a control character and never refuses it.
  expect(response.status(), `PATCH body: ${await response.text()}`).toBe(200);
  await expect(page.getByText('Could not update that chat', { exact: false })).toHaveCount(0);
  await expect(row(page, collapsed), 'the list shows the saved (collapsed) title').toBeVisible();
});

// A234 (council 3-0): a title a person actively types with a tab is refused
// by the server exactly as today (control characters are never accepted),
// but the alert now says WHY in the words the finding pins, instead of
// today's generic "Could not update that chat. Please try again." — this is
// a client-side wording change only: the collapse-on-prefill fix above does
// not touch a value the person edits by hand.
test('P7 a refused title says why', async ({ page }) => {
  await newChat(page);
  await sendAndWait(page, 'Quick question about pricing');

  const activeRow = activeRowOf(page);
  await activeRow.hover();
  await activeRow.getByRole('button', { name: /^Rename chat:/ }).click();
  const field = page.getByRole('textbox', { name: 'Chat title' });
  await expect(field).toBeVisible();
  // Playwright `fill` keeps the tab character (a real keypress would move
  // focus instead of inserting one).
  await field.fill('Bad\ttitle');

  const refused = page.waitForResponse((r) => r.request().method() === 'PATCH' && r.url().endsWith('/api/sessions'));
  await page.getByRole('button', { name: 'Save title' }).click();
  const response = await refused;
  expect(response.status(), await response.text()).toBe(400);

  await expect(page.getByText('A title can be up to 120 characters, with no tabs or line breaks.', { exact: true }))
    .toBeVisible();
  await expect(page.getByText('Could not update that chat', { exact: false })).toHaveCount(0);
});

// A229: the rename box for a long title opens showing the title's START
// (scrollLeft 0) with the whole title selected, so typing replaces it. Today
// `.select()` leaves the native scroll position at the END of an overflowing
// field.
test('P7 a long title opens in the rename box from its start', async ({ page }) => {
  const LONG_TITLE = (
    'The quarterly compliance review covers access management, encryption at ' +
    'rest, logging retention, incident response drills and vendor risk ' +
    'assessments end to end'
  ).slice(0, 118);
  await newChat(page);
  await sendAndWait(page, LONG_TITLE);

  const activeRow = activeRowOf(page);
  await activeRow.hover();
  await activeRow.getByRole('button', { name: /^Rename chat:/ }).click();
  const field = page.getByRole('textbox', { name: 'Chat title' });
  await expect(field).toBeFocused();

  const metrics = await field.evaluate((el: HTMLInputElement) => ({
    scrollLeft: el.scrollLeft,
    selectionStart: el.selectionStart,
    selectionEnd: el.selectionEnd,
    valueLength: el.value.length,
    overflowing: el.scrollWidth > el.clientWidth,
  }));
  expect(metrics.overflowing, `field did not overflow its box: ${JSON.stringify(metrics)}`).toBe(true);
  expect(metrics, `field metrics: ${JSON.stringify(metrics)}`)
    .toMatchObject({ scrollLeft: 0, selectionStart: 0, selectionEnd: metrics.valueLength });
});

// A236 (decided: maxLength={100} on the search field): typing, with the
// keyboard as a person does, a query longer than 100 characters whose first
// 100 characters match a chat still lists it, with no load-failure message.
// Today the field has no maxLength, so the full (>100) value reaches the
// server, which refuses it with 400 invalid_query (mock-stream-plugin.ts
// ~:615) — `fill()` would not prove this (it bypasses the native maxLength
// enforcement a real keypress respects), so this uses `pressSequentially`.
test('P7 a search longer than one hundred characters still lists chats', async ({ page }) => {
  const LONG_TITLE = (
    'Infrastructure review covering network security posture, access control ' +
    'audits, logging retention, backup drills and vendor risk assessments ' +
    'across every region we operate in'
  ).slice(0, 100);
  await newChat(page);
  await sendAndWait(page, LONG_TITLE);
  await expect(row(page, LONG_TITLE)).toBeVisible();

  // The chat this test just created is visible from the moment it is
  // created, unfiltered — so the row alone is not a safe anchor (P135): wait
  // for the search itself to actually answer before judging the outcome.
  const searched = page.waitForResponse((r) =>
    r.request().method() === 'GET' && r.url().includes('/api/sessions?') &&
    (new URL(r.url()).searchParams.get('q')?.length ?? 0) > 0, { timeout: 15_000 });
  await searchOf(page).pressSequentially(`${LONG_TITLE}EXTRAEXTRA`, { delay: 15 });
  const response = await searched;

  expect(response.status(), `search response: ${await response.text()}`).toBe(200);
  await expect(row(page, LONG_TITLE), 'a query whose first 100 characters match must still list the chat')
    .toBeVisible();
  await expect(page.getByText('Could not load your chats', { exact: false })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0);
});

// A239 (owner decision 62: compare trimmed queries, and re-send when the
// answered query differs from the field): a quick edit that leaves the same
// TRIMMED query (a trailing space here) while a search is in flight must
// still end with the list matching the search box. Today the in-flight
// answer is invalidated (correctly, by the request counter) but nothing ever
// re-fires for the field's current content, because `setSearchQuery` bails
// when the trimmed value is unchanged (Chat.tsx ~:230-275) — so the list is
// left stale.
test('P7 the list matches the search box after a quick edit during a search', async ({ page }) => {
  const target = 'Reconcile the August invoice exceptions'; // mock row 8
  const other = 'Wiring the turn stream'; // mock row 0
  let releaseFirst: () => void = () => {};
  const firstHeld = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let firstSeen = false;
  await page.route(/\/api\/sessions\?/, async (route) => {
    const q = new URL(route.request().url()).searchParams.get('q');
    if (q === 'invoice' && !firstSeen) {
      firstSeen = true;
      await firstHeld;
    }
    await route.continue();
  });

  await openChat(page);
  await expect(row(page, other)).toBeVisible();

  await searchOf(page).fill('invoice');
  await page.waitForRequest((r) => r.url().includes('q=invoice'));
  // A quick edit that leaves the same trimmed query, well inside the 250ms
  // debounce and while the first answer is still held.
  await page.waitForTimeout(60);
  await searchOf(page).fill('invoice ');
  // Comfortably longer than the 250ms debounce, so any re-send would have
  // been dispatched by now.
  await page.waitForTimeout(500);
  releaseFirst();

  await expect(row(page, target), 'the list must match the search box ("invoice ")').toBeVisible({ timeout: 10_000 });
  await expect(row(page, other)).toHaveCount(0);

  await page.unroute(/\/api\/sessions\?/);
  await searchOf(page).fill('');
});

// A235 (council fixed_line, web only): a regenerate whose save the server
// refused (`done: not_saved` after a normal reply — not a block or a
// refusal) shows the fixed line above any reply text, and the old reply
// stays. Today the alert is just the raw reply text (Chat.tsx's regenerate()
// catch: `outcome.text || 'The server did not save this reply.'`), never
// this sentence. The P6 test "P6 a regenerate the server did not save leaves
// the old reply in place" (conversation-ux.spec.ts ~:698) is unaffected: it
// only asserts the alert CONTAINS its refusal text, which stays true once
// the fixed line is added above it — this test does not touch it.
test('P7 an unsaved regenerate says the reply was not saved', async ({ page }) => {
  const NOT_SAVED_LINE = "The new reply wasn't saved, so the previous one is kept.";
  await newChat(page);
  await sendAndWait(page, 'a question worth asking twice');
  await expect(replies(page)).toHaveCount(1);

  const freshReply = 'Here is a different answer to the same question.';
  const notSavedBody = [
    `event: chunk\ndata: ${freshReply}\n\n`,
    `event: final\ndata: ${JSON.stringify({ text: freshReply, modelId: 'us.anthropic.claude-sonnet-4-5', latencyMs: 5, costUsd: 0, toolCallCount: 0 })}\n\n`,
    'event: done\ndata: not_saved\n\n',
  ].join('');
  await page.route('**/api/test-turn/stream', (route) =>
    route.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream' }, body: notSavedBody }));

  await regenerateLast(page);

  const alertText = (await page.getByRole('alert').innerText()).trim();
  expect(alertText.startsWith(NOT_SAVED_LINE), `alert text: ${JSON.stringify(alertText)}`).toBe(true);
  await expect(replies(page)).toHaveCount(1);
  await expect(replies(page).last()).toContainText(REPLY);

  await page.unroute('**/api/test-turn/stream');
});

// P7 (step 9) — work order E: the agent page's Chat entry becomes a link
// (AGENTCHAT remove_link; council 3-0). Written BEFORE the change, as the
// bar (netzar-chat-plan/p7-proof.sh row U-2).
//
// The agent page (/agents/<id>, web/src/pages/AgentDetail.tsx) no longer has
// a chat client of its own; its Chat entry is a link to `/chat/<agentId>`
// (App.tsx:240 routes it; Chat.tsx:52-54 reads it). An agent OTHER than the
// default one (Chat.tsx's own default is the first ACTIVE agent, "main") is
// used so the selection is actually proven, not merely consistent with a
// fallback. Today the Chat tab renders AgentDetail's own in-page ChatTab
// (a plain `<input placeholder="Type a message...">` with no accessible
// name) and the URL never changes.
test('P7 the agent page opens this agent in the Chat tab', async ({ page }) => {
  const agentId = 'comms';
  const displayName = 'Communications';
  await page.route(`**/api/agents/${agentId}/detail`, (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      agent: {
        agentId, displayName, description: 'Email, messaging, and stakeholder communication.',
        model: 'us.anthropic.claude-sonnet-4-5', status: 'active',
        telegramConnected: false, slackConnected: false, createdAt: new Date().toISOString(),
      },
    }),
  }));

  await page.goto(`/dashboard/agents/${agentId}`);
  await expect(page.getByRole('heading', { level: 1, name: displayName })).toBeVisible();

  await page.getByRole('tab', { name: 'Chat', exact: true }).click();

  await expect(page, 'the Chat entry must navigate to the Chat tab, not render its own test chat')
    .toHaveURL(new RegExp(`/dashboard/chat/${agentId}$`));
  await expect(page.getByRole('textbox', { name: `Message ${displayName}` })).toBeVisible();

  await page.unroute(`**/api/agents/${agentId}/detail`);
});

// P7, the security review's second MEDIUM (A233): a stopped reply keeps its request id on the page, so
// Regenerate names it. Without it the page sent `replyTo: null` and the server refused every Stop-then-Regenerate
// as "this chat changed in another tab".
test('P7 Regenerate right after Stop answers the stopped reply', async ({ page }) => {
  await newChat(page);
  await composerOf(page).fill('/fixture longstream');
  await sendOf(page).click();
  await expect(page.getByText('Line 3:').first()).toBeVisible();
  await stopOf(page).click();
  await waitForEnd(page);
  await expect(replies(page).last()).toContainText(/stopped/i);

  const { sent, status } = await regenerateLast(page);
  expect(sent.replyTo, 'Regenerate names the stopped reply the page shows').toEqual(expect.any(String));
  expect(status, 'the server answers the stopped reply instead of refusing it as changed').toBe(200);
  await waitForEnd(page);
  await expect(page.getByText('This chat changed in another tab')).toHaveCount(0);
});

// The owner, 2026-09-28 (a staging screenshot): hovering the (?) beside the chat's ID in the header showed only
// a sliver of odd help text. The box opened upward, past the chat page's top edge, which the page clips
// (overflow hidden), and its glossary text described audit actions, not this chat.
test('P7 the chat ID help opens where it can be read and says what the ID is', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await newChat(page);
  await page.locator('[data-tour="chat-new-chat"]').getByRole('button', { name: 'More information' }).hover();
  const tip = page.getByRole('tooltip');
  await expect(tip).toContainText("This chat's ID");
  const hidden = await tip.evaluate((el) => {
    const r = el.getBoundingClientRect();
    if (r.top < 0 || r.left < 0 || r.bottom > innerHeight || r.right > innerWidth) return 'off screen';
    for (let a = el.parentElement; a; a = a.parentElement) {
      const s = getComputedStyle(a);
      if (s.overflowX === 'visible' && s.overflowY === 'visible') continue;
      const b = a.getBoundingClientRect();
      if (r.top < b.top || r.left < b.left || r.bottom > b.bottom || r.right > b.right) return `clipped by <${a.tagName.toLowerCase()} class="${a.className}">`;
    }
    return '';
  });
  expect(hidden, 'the whole help box is on screen').toBe('');
  // It sits inside the monospace ID chip; help prose must not inherit the code font.
  expect(await tip.evaluate((el) => getComputedStyle(el).fontFamily), 'help text in the page font').not.toMatch(/mono/i);
});
