import { readFileSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';

// P6 (step 8) — conversation UX completion as a person meets it, in a real browser against the
// chat mock (CCE_CHAT_MOCK=1, web/dev/mock-stream-plugin.ts). Written BEFORE the change, as the
// bar (netzar-chat-plan/p6-proof.sh rows B-1..B-24).
//
//   - WI-6.1: a failed reply can be tried again (text only; a message that carried files asks
//     for them again), and the last reply can be regenerated in place — both survive a reload.
//   - WI-6.2: one-click new chat; rename and pin a conversation from its row; search the list on
//     the server; opening a conversation shows loading, not the landing; load failures say so.
//   - WI-6.3: one polite announcer; failures are alerts; the phone drawer holds focus and puts
//     the page behind it out of reach; a heading at every width; the drawer buttons report
//     their state; readable contrast in both themes; wide tables scroll inside the reply; the
//     voice orb starts clear of the composer (owner decision 61).
//   - WI-6.4: drafts survive a reload (tab storage) and clear on send; three shortcuts; a code
//     block downloads as a named file; the whole conversation downloads as Markdown; the model
//     picker's trigger splits the family from the context size.
//
// Identity is seeded exactly as chat.spec.ts does; see its comment for why that is not an
// authorization bypass. The conversation rows each test changes are ones no other spec uses,
// and every rename or pin is undone before the test ends: the whole suite shares one mock
// server (npm run e2e:chat), so a change left behind would leak into the next spec.
const CAPS = ['overview:read', 'chat:read', 'agents:read', 'sessions:read'];

const REPLY = 'Here is the summary you asked for'; // web/dev/fixtures.ts, the default reply
const REGEN = 'Here is a fresh answer to the same question.'; // the mock's regen fixture (P6)
const REGEN_CARD = 'Launch notes'; // the file card the regen fixture publishes (an existing mock artifact)
const LANDING = /What can .* do for you\?/;
const FAILURE = 'The model could not answer just now.';
const FAILED_STREAM = `event: error\ndata: ${JSON.stringify({ code: 'model_error', message: FAILURE })}\n\n`;

test.beforeEach(async ({ page }) => {
  await page.addInitScript((caps) => {
    localStorage.setItem('cce_token', 'local-dev-dashboard-token');
    localStorage.setItem('cce_onboarded', 'true');
    localStorage.setItem('cce_role', 'admin');
    localStorage.setItem('cce_capabilities', JSON.stringify(caps));
  }, CAPS);
});

const composerOf = (page: Page) => page.getByRole('textbox', { name: /^Message / });
const composerField = (page: Page) => page.locator('form textarea').first(); // reachable even while inert
const sendOf = (page: Page) => page.getByRole('button', { name: 'Send message' });
const stopOf = (page: Page) => page.getByRole('button', { name: 'Stop generating' });
const userBubbles = (page: Page) => page.getByRole('group', { name: 'Your message' });
const replies = (page: Page) => page.getByRole('group', { name: 'Assistant message' });
const history = (page: Page) => page.locator('aside[aria-label="Conversation history"]');
// `:visible` — the conversation list is rendered twice (the desktop rail and the hidden
// mobile drawer), so a bare title match finds two buttons.
const row = (page: Page, title: string) => page.locator(`button[title="${title}"]:visible`);
const searchOf = (page: Page) => page.getByRole('searchbox', { name: 'Search chats' });

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

/** The mock's conversation rows are dashboard:<1750000000000 + index> (web/dev/mock-stream-plugin.ts). */
const mockChatId = (index: number) => `dashboard:${1_750_000_000_000 + index}`;

/**
 * Undo a rename or pin. A cleanup that throws inside `finally` replaces the test's own error, so
 * it asserts only after the test body passed (`mustSucceed`); before the PATCH route existed the
 * request only timed out, which hid why the test had failed.
 */
async function resetMeta(page: Page, index: number, mustSucceed: boolean) {
  const res = await page.request
    .patch('/api/sessions', { data: { agentId: 'main', chatId: mockChatId(index), title: null, pinned: false }, timeout: 5_000 })
    .catch((e: Error) => e);
  if (mustSucceed) expect(res instanceof Error ? res.message : res.status()).toBe(200);
}

test('P6 new chat starts in one click from a conversation with messages', async ({ page }) => {
  await newChat(page);
  await sendAndWait(page, 'first question in this chat');
  await expect(page.getByText(REPLY).first()).toBeVisible();

  await page.getByRole('button', { name: 'New chat' }).first().click();

  // One click: no dialog and no phrase to type, straight to a fresh conversation.
  await expect(page.getByPlaceholder('NEW CHAT')).toHaveCount(0);
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await expect(page.getByText(LANDING)).toBeVisible();
  // Gone from the transcript; the list rightly keeps the conversation as a row titled with it.
  await expect(userBubbles(page).filter({ hasText: 'first question in this chat' })).toHaveCount(0);
  await expect(composerOf(page)).toHaveValue('');
});

test('P6 a failed reply offers try again and the retry replaces the error', async ({ page }) => {
  const bodies: Array<Record<string, unknown>> = [];
  await page.route('**/api/test-turn/stream', async (route) => {
    bodies.push(route.request().postDataJSON() as Record<string, unknown>);
    if (bodies.length === 1) {
      await route.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream' }, body: FAILED_STREAM });
      return;
    }
    await route.continue();
  });
  await newChat(page);
  await composerOf(page).fill('Tell me the rollout status');
  await sendOf(page).click();

  const failure = page.getByRole('alert').filter({ hasText: FAILURE });
  await expect(failure).toBeVisible();
  await failure.getByRole('button', { name: 'Try again' }).click();

  await expect(page.getByText(REPLY).first()).toBeVisible({ timeout: 30_000 });
  await waitForEnd(page);
  await expect(failure).toHaveCount(0);
  // The message is on screen once, and the retry sent it again with a new id.
  await expect(userBubbles(page).filter({ hasText: 'Tell me the rollout status' })).toHaveCount(1);
  expect(bodies).toHaveLength(2);
  expect(bodies[1]!.text).toBe('Tell me the rollout status');
  expect(bodies[1]!.clientMessageId).toBeTruthy();
  expect(bodies[1]!.clientMessageId).not.toBe(bodies[0]!.clientMessageId);

  // The failed attempt stored nothing, so a reload shows one message and one reply.
  await page.reload();
  await expect(page.getByText(REPLY).first()).toBeVisible();
  await expect(userBubbles(page).filter({ hasText: 'Tell me the rollout status' })).toHaveCount(1);
});

test('P6 regenerate replaces the last reply and the replacement survives a reload', async ({ page }) => {
  const bodies: Array<Record<string, unknown>> = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().endsWith('/api/test-turn/stream')) bodies.push(r.postDataJSON() as Record<string, unknown>);
  });
  await newChat(page);
  await sendAndWait(page, 'first question');
  await sendAndWait(page, 'second question');
  await expect(replies(page)).toHaveCount(2);

  // Only the LAST reply offers Regenerate.
  await replies(page).nth(0).hover();
  await expect(replies(page).nth(0).getByRole('button', { name: 'Regenerate' })).toHaveCount(0);
  await replies(page).nth(1).hover();
  await replies(page).nth(1).getByRole('button', { name: 'Regenerate' }).click();

  await expect(page.getByText(REGEN).first()).toBeVisible({ timeout: 30_000 });
  await waitForEnd(page);
  // Replaced in place: still two messages and two replies, the second one new.
  await expect(userBubbles(page)).toHaveCount(2);
  await expect(replies(page)).toHaveCount(2);
  await expect(replies(page).nth(1)).toContainText(REGEN);
  await expect(replies(page).nth(1)).not.toContainText(REPLY);
  // It asked for a regenerate and sent no text of its own.
  const asked = bodies.at(-1)!;
  expect(asked.regenerate).toBe(true);
  expect(asked.text ?? '').toBe('');

  await page.reload();
  await expect(page.getByText(REGEN).first()).toBeVisible();
  await expect(replies(page)).toHaveCount(2);
  await expect(replies(page).nth(0)).toContainText(REPLY);
  await expect(replies(page).nth(1)).toContainText(REGEN);
});

test('P6 a renamed conversation keeps its title in the list and the header after a reload', async ({ page }) => {
  const old = 'Draft the incident note for the cost-cap trip'; // mock row 1
  const renamed = 'Cost-cap incident note';
  let passed = false;
  try {
    await openChat(page);
    await row(page, old).click();
    await row(page, old).hover();
    await page.getByRole('button', { name: `Rename chat: ${old}` }).filter({ visible: true }).click();
    const field = page.getByRole('textbox', { name: 'Chat title' });
    await field.fill(renamed);
    await field.press('Enter');

    await expect(row(page, renamed)).toBeVisible();
    await expect(row(page, old)).toHaveCount(0);
    // Named: the house navigation carries its own h1 (the company name).
    await expect(page.getByRole('heading', { level: 1, name: renamed, exact: true })).toBeVisible();

    await page.reload();
    await expect(row(page, renamed)).toBeVisible();
    await expect(page.getByRole('heading', { level: 1, name: renamed, exact: true })).toBeVisible();
    passed = true;
  } finally {
    await resetMeta(page, 1, passed);
  }
});

test('P6 a pinned conversation sits in a pinned group at the top', async ({ page }) => {
  const title = 'Quarterly posture review'; // mock row 3
  let passed = false;
  try {
    await openChat(page);
    await row(page, title).hover();
    await page.getByRole('button', { name: `Pin chat: ${title}` }).filter({ visible: true }).click();

    const groups = history(page).getByRole('group');
    await expect(groups.first()).toHaveAccessibleName('Pinned');
    await expect(groups.first().locator(`button[title="${title}"]`)).toHaveCount(1);

    await page.reload();
    await expect(history(page).getByRole('group').first()).toHaveAccessibleName('Pinned');

    await row(page, title).hover();
    await page.getByRole('button', { name: `Unpin chat: ${title}` }).filter({ visible: true }).click();
    await expect(history(page).getByRole('group', { name: 'Pinned' })).toHaveCount(0);
    passed = true;
  } finally {
    await resetMeta(page, 3, passed);
  }
});

test('P6 the sidebar search finds a conversation by a word in its title', async ({ page }) => {
  const asked: string[] = [];
  page.on('request', (r) => {
    const url = new URL(r.url());
    if (r.method() === 'GET' && url.pathname.endsWith('/api/sessions')) asked.push(url.searchParams.get('q') ?? '');
  });
  await openChat(page);
  await expect(row(page, 'Wiring the turn stream')).toBeVisible();

  await searchOf(page).fill('invoice');
  await expect(row(page, 'Reconcile the August invoice exceptions')).toBeVisible();
  await expect(row(page, 'Wiring the turn stream')).toHaveCount(0);
  // The server does the search (it reads every conversation, not only the newest fifty).
  await expect.poll(() => asked).toContain('invoice');

  await searchOf(page).fill('');
  await expect(row(page, 'Wiring the turn stream')).toBeVisible();
});

test('P6 opening a conversation shows a loading state instead of the landing screen', async ({ page }) => {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/sessions/transcript**', async (route) => {
    await held;
    await route.continue();
  });
  await openChat(page);
  await row(page, 'Kill-switch audit rows from yesterday').click();

  await expect(page.getByRole('status').filter({ hasText: /Loading conversation/ })).toBeVisible();
  await expect(page.getByText(LANDING)).toHaveCount(0);

  release();
  await expect(page.getByRole('status').filter({ hasText: /Loading conversation/ })).toHaveCount(0);
});

test('P6 a conversation that fails to load says so and can be retried', async ({ page }) => {
  let failed = false;
  await page.route('**/api/sessions/transcript**', async (route) => {
    if (!failed) {
      failed = true;
      await route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"internal"}' });
      return;
    }
    await route.continue();
  });
  await openChat(page);
  await row(page, 'Why did the deploy fail?').click();

  const failure = page.getByRole('alert').filter({ hasText: /could not load this conversation/i });
  await expect(failure).toBeVisible();
  await failure.getByRole('button', { name: 'Try again' }).click();
  await expect(failure).toHaveCount(0);
});

test('P6 a conversation list that fails to load says so instead of looking empty', async ({ page }) => {
  let failing = true;
  await page.route(/\/api\/sessions(\?|$)/, async (route) => {
    if (failing && route.request().method() === 'GET') {
      await route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"internal"}' });
      return;
    }
    await route.continue();
  });
  await openChat(page);

  await expect(history(page).getByText(/could not load your chats/i)).toBeVisible();
  await expect(history(page).getByText(/No past conversations yet/)).toHaveCount(0);

  failing = false;
  await history(page).getByRole('button', { name: 'Try again' }).click();
  await expect(row(page, 'Wiring the turn stream')).toBeVisible();
});

test('P6 one polite announcer reports when a reply finishes or stops', async ({ page }) => {
  await newChat(page);
  const announcer = page.locator('[data-chat-announcer]');
  // Mounted before anything happens, so the first announcement is not lost.
  await expect(announcer).toHaveCount(1);
  await expect(announcer).toHaveAttribute('role', 'status');
  await expect(announcer).toHaveAttribute('aria-live', 'polite');

  await sendAndWait(page, 'a quick one');
  await expect(announcer).toHaveText(/finished/i);

  await composerOf(page).fill('/fixture longstream');
  await sendOf(page).click();
  await expect(page.getByText('Line 3:').first()).toBeVisible();
  await stopOf(page).click();
  await expect(announcer).toHaveText(/stopped/i);
  await expect(announcer).toHaveCount(1);
});

test('P6 a failed reply is announced as an alert', async ({ page }) => {
  await newChat(page);
  await composerOf(page).fill('/fixture error-mid');
  await sendOf(page).click();
  const failure = page.getByRole('alert');
  await expect(failure).toHaveCount(1);
  await expect(failure).toBeVisible();
  await expect(failure).not.toHaveText('');
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test('P6 the phone drawer keeps keyboard focus inside and hides the page behind it', async ({ page }) => {
    await openChat(page);
    await page.getByRole('button', { name: 'Show conversation history' }).click();
    const drawer = page.getByRole('dialog', { name: 'Conversation history' });
    await expect(drawer).toBeVisible();

    for (let i = 0; i < 25; i++) {
      await page.keyboard.press('Tab');
      expect(await drawer.evaluate((d) => d.contains(document.activeElement))).toBe(true);
    }
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press('Shift+Tab');
      expect(await drawer.evaluate((d) => d.contains(document.activeElement))).toBe(true);
    }
    // The page behind it is out of reach while it is open.
    expect(await composerField(page).evaluate((el) => el.closest('[inert]') !== null)).toBe(true);

    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();
    await expect(page.locator('button[aria-label="Show conversation history"]')).toBeFocused();
    expect(await composerField(page).evaluate((el) => el.closest('[inert]') === null)).toBe(true);
  });

  // P129: a listener or focus move that must exist when a surface opens belongs in a layout effect.
  // Opening re-renders in a microtask; a plain effect waits for the next frame, and a key pressed
  // before it (the page behind already inert) lands nowhere.
  test('P6 the phone drawer takes focus and answers Escape before its first paint', async ({ page }) => {
    await openChat(page);
    const result = await page.evaluate(async () => {
      document.querySelector<HTMLButtonElement>('button[aria-label="Show conversation history"]')!.click();
      for (let i = 0; i < 10; i++) await Promise.resolve(); // the render's microtasks: no frame, no new task
      const drawer = document.querySelector('[role="dialog"][aria-label="Conversation history"]')!;
      const focusInside = drawer.contains(document.activeElement);
      const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      document.dispatchEvent(escape);
      return { focusInside, escapeHandled: escape.defaultPrevented };
    });
    expect(result).toEqual({ focusInside: true, escapeHandled: true });
  });

  test('P6 the drawer buttons say whether their drawer is open', async ({ page }) => {
    await openChat(page);
    const historyButton = page.locator('button[aria-label="Show conversation history"]');
    await expect(historyButton).toHaveAttribute('aria-expanded', 'false');
    await historyButton.click();
    await expect(historyButton).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Escape');
    await expect(historyButton).toHaveAttribute('aria-expanded', 'false');

    const navButton = page.locator('button[aria-label="Open main navigation"]');
    await expect(navButton).toHaveAttribute('aria-expanded', 'false');
    await navButton.click();
    await expect(navButton).toHaveAttribute('aria-expanded', 'true');
  });

  test('P6 a wide table scrolls sideways inside the reply on a phone', async ({ page }) => {
    await newChat(page);
    await sendAndWait(page, '/fixture wide-table');
    const table = page.locator('.chat-md table').first();
    await expect(table).toBeVisible();
    const scrollsInside = await table.evaluate((t) => {
      for (let el: HTMLElement | null = t as HTMLElement; el && !el.classList.contains('chat-md'); el = el.parentElement) {
        const s = getComputedStyle(el);
        if ((s.overflowX === 'auto' || s.overflowX === 'scroll') && el.scrollWidth > el.clientWidth) return true;
      }
      return false;
    });
    expect(scrollsInside).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  });
});

test('P6 the conversation title is a heading at every width', async ({ page }) => {
  for (const width of [375, 1440]) {
    await page.setViewportSize({ width, height: 812 });
    await openChat(page);
    // Named: at desktop widths the house navigation shows its own h1 (the company name).
    await expect(page.getByRole('heading', { level: 1, name: 'New chat', exact: true })).toHaveCount(1);
  }
});

/**
 * WCAG AA over the chat's own text: 4.5:1 for body text, 3:1 for large text (24px, or 18.66px
 * bold). The model's reply content (`.chat-md`) is the model's, not the chat's, and is out of
 * scope; hidden, transparent and aria-hidden text is skipped. Colours are composited over
 * their real stacked backgrounds up to the page's own opaque background.
 */
function chatContrastFailures(): Array<{ text: string; ratio: number }> {
  type RGBA = [number, number, number, number];
  const parse = (c: string): RGBA => {
    const m = c.match(/rgba?\(([^)]+)\)/);
    if (!m) return [0, 0, 0, 0];
    const p = m[1]!.split(/[ ,/]+/).filter(Boolean).map(Number);
    return [p[0]!, p[1]!, p[2]!, p.length > 3 ? p[3]! : 1];
  };
  const over = (top: RGBA, under: RGBA): RGBA => {
    const a = top[3] + under[3] * (1 - top[3]);
    if (a === 0) return [0, 0, 0, 0];
    const mix = (i: number) => (top[i]! * top[3] + under[i]! * under[3] * (1 - top[3])) / a;
    return [mix(0), mix(1), mix(2), a];
  };
  const lum = (c: RGBA) => {
    const ch = [c[0], c[1], c[2]].map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
  };
  const backdrop = (el: Element): RGBA => {
    const layers: RGBA[] = [];
    for (let e: Element | null = el; e; e = e.parentElement) {
      const bg = parse(getComputedStyle(e).backgroundColor);
      if (bg[3] > 0) layers.push(bg);
      if (bg[3] >= 1) break;
    }
    const base = parse(getComputedStyle(document.body).backgroundColor);
    let out: RGBA = base[3] > 0 ? [base[0], base[1], base[2], 1] : [255, 255, 255, 1];
    for (let i = layers.length - 1; i >= 0; i--) out = over(layers[i]!, out);
    return out;
  };
  const visible = (el: Element) => {
    for (let e: Element | null = el; e; e = e.parentElement) {
      const s = getComputedStyle(e);
      if (s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) === 0 || e.getAttribute('aria-hidden') === 'true') return false;
    }
    return el.getClientRects().length > 0;
  };
  const roots = [
    ...document.querySelectorAll('aside[aria-label="Conversation history"], [data-tour="chat-messages"]'),
    document.querySelector('h1')?.closest('header') ?? null,
    document.querySelector('form textarea')?.closest('form') ?? null,
  ].filter((r): r is Element => r !== null);
  const failures: Array<{ text: string; ratio: number }> = [];
  for (const root of roots) {
    for (const el of root.querySelectorAll('*')) {
      if (el.closest('.chat-md, [data-chat-announcer], .sr-only')) continue;
      const own = [...el.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent ?? '').join('').trim();
      if (!own || !visible(el)) continue;
      const s = getComputedStyle(el);
      const bg = backdrop(el);
      const fg = over(parse(s.color), bg);
      const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a) as [number, number];
      const ratio = (hi + 0.05) / (lo + 0.05);
      const size = parseFloat(s.fontSize);
      const large = size >= 24 || (size >= 18.66 && Number(s.fontWeight) >= 700);
      if (ratio < (large ? 3 : 4.5)) failures.push({ text: own.slice(0, 60), ratio: Math.round(ratio * 100) / 100 });
    }
  }
  return failures;
}

test('P6 chat text meets the contrast floor in light and dark', async ({ page }) => {
  for (const theme of ['light', 'dark']) {
    await page.addInitScript((t) => localStorage.setItem('cce_theme', t), theme);
    await newChat(page);
    await sendAndWait(page, `contrast check in ${theme}`);
    await composerOf(page).fill('/fixture error-mid');
    await sendOf(page).click();
    await expect(page.getByRole('alert')).toBeVisible();
    const failures = await page.evaluate(chatContrastFailures);
    expect(failures, `${theme}: text under the contrast floor`).toEqual([]);
  }
});

test('P6 the voice orb starts clear of the composer on the chat page', async ({ page }) => {
  await page.route('**/api/jarvis/manifest', (route) => route.fulfill({
    json: { generatedAt: '2026-09-27T00:00:00.000Z', routes: [], resources: [], jarvisEnabled: true, voiceEnabled: false },
  }));
  await page.addInitScript(() => localStorage.removeItem('cce_jarvis_widget_pos'));
  // Where the composer reaches the house sidebar: on the base the orb sat on it at both sizes
  // (measured: x 324-376 against the form's 324 and 362); from 1366 up it already cleared it.
  for (const size of [{ width: 1024, height: 768 }, { width: 1280, height: 800 }]) {
    await page.setViewportSize(size);
    await openChat(page);
    const orb = page.getByRole('button', { name: /^Jarvis \(/ });
    await expect(orb).toBeVisible(); // still offered on the chat page (lifted, not hidden)
    const o = (await orb.boundingBox())!;
    const form = (await page.locator('form').filter({ has: composerOf(page) }).boundingBox())!;
    const overlaps = o.x < form.x + form.width && form.x < o.x + o.width && o.y < form.y + form.height && form.y < o.y + o.height;
    expect(overlaps, `the orb overlaps the composer at ${size.width}x${size.height}`).toBe(false);
  }
});

test('P6 a draft survives a page reload and is cleared by sending', async ({ page }) => {
  await newChat(page);
  await composerOf(page).fill('a draft about the invoice exceptions');
  await expect.poll(() => page.evaluate(() => JSON.stringify(sessionStorage))).toContain('invoice exceptions');
  await page.reload();
  await expect(composerOf(page)).toHaveValue('a draft about the invoice exceptions');

  await expect(sendOf(page)).toBeEnabled();
  await sendOf(page).click();
  await waitForEnd(page);
  await page.reload();
  await expect(composerOf(page)).toHaveValue('');
});

test('P6 shortcuts start a new chat and focus the message box and the search', async ({ page }) => {
  await newChat(page);
  await sendAndWait(page, 'something to leave behind');

  await page.keyboard.press('ControlOrMeta+Shift+O');
  await expect(page.getByText(LANDING)).toBeVisible();
  await expect(userBubbles(page).filter({ hasText: 'something to leave behind' })).toHaveCount(0);
  await expect(page.getByPlaceholder('NEW CHAT')).toHaveCount(0);

  await page.keyboard.press('ControlOrMeta+Slash');
  await expect(searchOf(page)).toBeFocused();

  await page.keyboard.press('Shift+Escape');
  await expect(composerOf(page)).toBeFocused();
});

test('P6 a code block downloads its code as a named file', async ({ page }) => {
  await newChat(page);
  await sendAndWait(page, '/fixture code');
  const block = page.locator('.chat-code').first();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    block.getByRole('button', { name: /Download/ }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('snippet.ts');
  const code = readFileSync((await download.path())!, 'utf8');
  expect(code).toContain('export class TurnStream');
  expect(code).toContain('// Cumulative chunks: assign, never append');
});

test('P6 the whole conversation downloads as a Markdown file', async ({ page }) => {
  await newChat(page);
  await sendAndWait(page, 'first question for the export');
  await sendAndWait(page, 'second question for the export');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Export chat' }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.md$/);
  const md = readFileSync((await download.path())!, 'utf8');
  const first = md.indexOf('first question for the export');
  const second = md.indexOf('second question for the export');
  expect(first).toBeGreaterThan(-1);
  expect(second).toBeGreaterThan(first);
  expect(md.split(REPLY).length - 1).toBe(2);
});

test('P6 the model picker trigger shows the family and the context size', async ({ page }) => {
  await page.route('**/api/models', (route) => route.fulfill({
    json: {
      models: [
        { label: 'sonnet-1m', id: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0', contextWindow: 1_000_000, family: 'sonnet', isDefault: false },
        { label: 'opus', id: 'us.anthropic.claude-opus-4-1-20250805-v1:0', contextWindow: 200_000, family: 'opus', isDefault: true },
      ],
    },
  }));
  await openChat(page);
  await page.getByRole('button', { name: /^Model:/ }).click();
  await page.keyboard.type('sonnet');
  await page.keyboard.press('Enter');

  const trigger = page.getByRole('button', { name: /^Model: pinned to/ });
  await expect(trigger).toBeVisible();
  await expect(trigger.locator('[data-model-family]')).toHaveText('Sonnet');
  await expect(trigger.locator('[data-model-context]')).toHaveText('1M');
});

test('P6 a regenerated reply that made a file keeps its card after a reload', async ({ page }) => {
  const card = () => page.getByRole('button', { name: `Open ${REGEN_CARD}`, exact: true });
  await newChat(page);
  await sendAndWait(page, 'make me the launch notes');
  await expect(card()).toHaveCount(0);

  await replies(page).last().hover();
  await replies(page).last().getByRole('button', { name: 'Regenerate' }).click();
  await expect(page.getByText(REGEN).first()).toBeVisible({ timeout: 30_000 });
  await waitForEnd(page);
  await expect(card()).toBeVisible();

  await page.reload();
  await expect(card()).toBeVisible();
});

test('P6 a failed message that carried files asks for them again instead of retrying', async ({ page }) => {
  await page.route('**/api/test-turn/stream', (route) =>
    route.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream' }, body: FAILED_STREAM }));
  await newChat(page);
  await page.locator('input[type="file"]').setInputFiles({ name: 'rollout-notes.txt', mimeType: 'text/plain', buffer: Buffer.from('rollout notes') });
  await expect(page.getByRole('progressbar', { name: /^Uploading / })).toHaveCount(0);
  await composerOf(page).fill('Summarise the notes');
  await sendOf(page).click();

  const failure = page.getByRole('alert').filter({ hasText: FAILURE });
  await expect(failure).toBeVisible();
  await expect(failure).toContainText(/attach/i);
  await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0);
});

// ── Found reading slice C1 (P6 hunk review): the page must agree with what the server stores. ──

test('P6 only the last failed reply offers try again', async ({ page }) => {
  let calls = 0;
  await page.route('**/api/test-turn/stream', async (route) => {
    calls += 1;
    if (calls === 1) {
      await route.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream' }, body: FAILED_STREAM });
      return;
    }
    await route.continue();
  });
  await newChat(page);
  await composerOf(page).fill('the question that failed');
  await sendOf(page).click();
  await expect(page.getByRole('alert').filter({ hasText: FAILURE })).toBeVisible();
  await sendAndWait(page, 'a later question');

  // Re-sending the older message now would file its answer at the end, away from its question.
  await expect(page.getByRole('alert').filter({ hasText: FAILURE })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0);
});

test('P6 a failed regenerate keeps the reply it was replacing and offers no resend', async ({ page }) => {
  await newChat(page);
  await sendAndWait(page, 'a question worth asking twice');
  await expect(replies(page)).toHaveCount(1);
  await page.route('**/api/test-turn/stream', (route) =>
    route.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream' }, body: FAILED_STREAM }));

  await replies(page).last().hover();
  await replies(page).last().getByRole('button', { name: 'Regenerate' }).click();
  await expect(page.getByRole('alert').filter({ hasText: FAILURE })).toBeVisible();
  // A failed regenerate stores nothing, so the server still holds the old reply: so must the page.
  await expect(replies(page).filter({ hasText: REPLY })).toHaveCount(1);
  // Try again would re-send the question as a new turn: the server would hold it twice.
  await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0);

  await page.unroute('**/api/test-turn/stream');
  await page.reload();
  await expect(userBubbles(page)).toHaveCount(1);
  await expect(replies(page)).toHaveCount(1);
  await expect(replies(page).first()).toContainText(REPLY);
});

test('P6 a stopped regenerate keeps the text it reached, as the server saves it', async ({ page }) => {
  await newChat(page);
  await sendAndWait(page, '/fixture longstream');
  await expect(replies(page).last()).toContainText('Line 200:');

  // The mock answers a regenerate of a "/fixture" message with that fixture again (a long one here).
  await replies(page).last().hover();
  await replies(page).last().getByRole('button', { name: 'Regenerate' }).click();
  await expect(page.getByText('Line 3:').first()).toBeVisible();
  await stopOf(page).click();
  await waitForEnd(page);

  // The server saves what the reader saw, marked stopped (the stopped-text rule), in place of the old reply.
  await expect(replies(page)).toHaveCount(1);
  await expect(replies(page).last()).not.toContainText('Line 200:');
  await expect(replies(page).last()).toContainText(/stopped/i);
  await page.reload();
  await expect(replies(page)).toHaveCount(1);
  await expect(replies(page).last()).not.toContainText('Line 200:');
  await expect(replies(page).last()).toContainText(/stopped/i);
});

test('P6 a regenerate the server did not save leaves the old reply in place', async ({ page }) => {
  await newChat(page);
  await sendAndWait(page, 'a question worth asking twice');
  const refusal = 'I cannot help with that request.';
  const notSaved = [
    `event: chunk\ndata: ${refusal}\n\n`,
    `event: final\ndata: ${JSON.stringify({ text: refusal, modelId: 'us.anthropic.claude-sonnet-4-5', latencyMs: 5, costUsd: 0, toolCallCount: 0 })}\n\n`,
    'event: done\ndata: not_saved\n\n',
  ].join('');
  await page.route('**/api/test-turn/stream', (route) =>
    route.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream' }, body: notSaved }));

  await replies(page).last().hover();
  await replies(page).last().getByRole('button', { name: 'Regenerate' }).click();
  // The server kept the old reply (a blocked turn is never stored): so does the page, and it says why.
  await expect(page.getByRole('alert').filter({ hasText: refusal })).toBeVisible();
  await expect(replies(page)).toHaveCount(1);
  await expect(replies(page).last()).toContainText(REPLY);

  await page.unroute('**/api/test-turn/stream');
  await page.reload();
  await expect(replies(page)).toHaveCount(1);
  await expect(replies(page).last()).toContainText(REPLY);
});

// Review routing (Codex correctness MEDIUM and LOW, M139): the dev mock answers a regenerate the
// way the real route does, so the browser proves what production does.
test('P6 the mock refuses a regenerate the way the route does', async ({ page }) => {
  await openChat(page);
  const ask = (data: Record<string, unknown>) =>
    page.request.post('/api/test-turn/stream', { data: { agentId: 'main', protocol: 2, regenerate: true, clientMessageId: `m-${Math.random()}`, ...data } });
  const missing = await ask({ chatId: 'dashboard:4040404040404' });
  expect([missing.status(), await missing.json()]).toEqual([404, { error: 'not_found' }]);
  const withText = await ask({ chatId: mockChatId(0), text: 'and this too' });
  expect([withText.status(), await withText.json()]).toEqual([400, { error: 'invalid_regenerate' }]);
});

test('P6 a regenerated reply keeps its tool results after a reload', async ({ page }) => {
  await newChat(page);
  await sendAndWait(page, '/fixture tools');
  await replies(page).last().hover();
  await replies(page).last().getByRole('button', { name: 'Regenerate' }).click();
  await waitForEnd(page);
  await expect(page.getByRole('button', { name: /Used 5 tools/ })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: /Used 5 tools/ })).toBeVisible();
});

// Found reading slice C2: the page behind the phone drawer is inert while it is open, and the drawer
// only exists below lg. Widening the window past lg (a tablet turned sideways) must not leave the
// page inert behind a drawer nobody can see.
test('P6 widening the window past the drawer breakpoint gives the page back', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 900 });
  await openChat(page);
  await page.getByRole('button', { name: 'Show conversation history' }).click();
  await expect(page.getByRole('dialog', { name: 'Conversation history' })).toBeVisible();
  expect(await composerField(page).evaluate((el) => el.closest('[inert]') !== null)).toBe(true);

  await page.setViewportSize({ width: 1280, height: 800 });
  await expect.poll(() => composerField(page).evaluate((el) => el.closest('[inert]') === null)).toBe(true);
  await composerOf(page).fill('still typing here');
  await expect(composerOf(page)).toHaveValue('still typing here');
});

// Review routing (Claude React MEDIUM): Shift+Escape in the rename field cancels the rename and still
// reaches the page's "focus the message box" shortcut.
test('P6 Shift+Escape in the rename field cancels it and moves to the message box', async ({ page }) => {
  const title = 'Grant narrative for the Q3 renewal'; // mock row 7
  await openChat(page);
  await row(page, title).hover();
  await page.getByRole('button', { name: `Rename chat: ${title}` }).filter({ visible: true }).click();
  const field = page.getByRole('textbox', { name: 'Chat title' });
  await expect(field).toBeFocused();
  await field.press('Shift+Escape');
  await expect(field).toHaveCount(0);
  await expect(row(page, title)).toBeVisible();
  await expect(composerOf(page)).toBeFocused();
});

// Review routing (Claude React MEDIUM, unconfirmed; P129's focus rule): on a phone the artifact panel is
// a modal sheet, and the page's shortcuts must not pull focus out from under it.
test.describe('with an artifact open on a phone', () => {
  test.use({ viewport: { width: 375, height: 812 } });
  test('P6 the shortcuts leave an open artifact sheet alone', async ({ page }) => {
    await newChat(page);
    await sendAndWait(page, '/fixture artifacts');
    await page.getByRole('button', { name: 'Open Launch notes', exact: true }).click();
    const sheet = page.locator('[data-artifact-panel]');
    await expect(sheet).toBeVisible();
    for (const key of ['ControlOrMeta+Slash', 'Shift+Escape']) {
      await page.keyboard.press(key);
      await expect(sheet).toBeVisible();
      expect(await sheet.evaluate((el) => el.contains(document.activeElement)), key).toBe(true);
    }
  });
});

// Review routing (Claude React HIGH and MEDIUM): a slower answer for a conversation or a search the
// reader has already left must never replace what is on screen now.
test('P6 a slower conversation load never replaces the one opened after it', async ({ page }) => {
  await newChat(page);
  await sendAndWait(page, 'the first conversation');
  const firstId = await page.evaluate(() => (JSON.parse(sessionStorage.getItem('cce_chat_active')!) as { chatId: string }).chatId);
  await page.getByRole('button', { name: 'New chat' }).first().click();
  await sendAndWait(page, 'the second conversation');
  await page.getByRole('button', { name: 'New chat' }).first().click();

  await page.route('**/api/sessions/transcript**', async (route) => {
    if (new URL(route.request().url()).searchParams.get('chatId') === firstId) await new Promise((r) => setTimeout(r, 2_000));
    await route.continue();
  });
  await row(page, 'the first conversation').click();
  await row(page, 'the second conversation').click();
  await page.waitForTimeout(2_500);
  await expect(userBubbles(page).filter({ hasText: 'the second conversation' })).toHaveCount(1);
  await expect(userBubbles(page).filter({ hasText: 'the first conversation' })).toHaveCount(0);
});

test('P6 a slower search never replaces the search typed after it', async ({ page }) => {
  await page.route(/\/api\/sessions\?/, async (route) => {
    if (new URL(route.request().url()).searchParams.get('q') === 'deploy') await new Promise((r) => setTimeout(r, 2_000));
    await route.continue();
  });
  await openChat(page);
  await searchOf(page).fill('deploy');
  await page.waitForTimeout(400); // past the debounce: the slow request is out
  await searchOf(page).fill('invoice');
  await page.waitForTimeout(2_600);
  await expect(row(page, 'Reconcile the August invoice exceptions')).toBeVisible();
  await expect(row(page, 'Why did the deploy fail?')).toHaveCount(0);
});

// Look critic (S02, S08 at 1280): a reply that has finished, or been stopped, is left fully in view
// above the composer, not under it behind the scroll-to-latest control. Found present on the base too.
test('P6 a finished or stopped reply is left in view above the composer', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  // Measured in the capture: with reduced motion the end-of-turn scroll lands short (smooth scrolling hid it).
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const clear = async () => {
    const reply = (await replies(page).last().boundingBox())!;
    const form = (await page.locator('form').filter({ has: composerOf(page) }).boundingBox())!;
    return reply.y + reply.height <= form.y + 1;
  };
  await newChat(page);
  await sendAndWait(page, 'Summarise the last 90 days of audit data');
  await expect.poll(clear).toBe(true);

  await composerOf(page).fill('/fixture longstream');
  await sendOf(page).click();
  await expect(page.getByText('Line 30:').first()).toBeVisible();
  await stopOf(page).click();
  await waitForEnd(page);
  await expect.poll(clear).toBe(true);
});

// Review routing (Codex security HIGH, Claude security F5; council R3: key by identity, and wipe the
// not-yet-known identity's slot at every sign-in and sign-out): a draft and the remembered conversation
// belong to the person who wrote them. The next person in the same tab never sees them; the same person
// signing out and back in keeps them.
test('P6 a draft never reaches the next person in the same tab', async ({ page }) => {
  // The page restores a remembered conversation (and its draft) once the agents have loaded, so a check
  // that nothing leaked must wait for that moment, or it passes before the leak happens.
  const as = async (who: string) => {
    await page.evaluate((w) => localStorage.setItem('cce_dashboard_user', w), who);
    await page.goto('/dashboard/chat');
    await expect(composerOf(page)).toBeVisible();
    await expect(page.locator('[data-tour="chat-agent-picker"]')).toContainText('Netzar Prime');
    await page.waitForTimeout(500);
  };
  await openChat(page);
  await as('dashboard:user:user-a');
  await page.getByRole('button', { name: 'New chat' }).first().click();
  await composerOf(page).fill('a private draft from A');
  await expect.poll(() => page.evaluate(() => JSON.stringify(sessionStorage))).toContain('a private draft from A');

  await page.getByRole('button', { name: 'Sign out' }).first().click();
  await as('dashboard:user:user-b');
  expect(await composerOf(page).inputValue()).toBe('');

  await as('dashboard:user:user-a');
  await expect(composerOf(page)).toHaveValue('a private draft from A');
});

// Found reading build R2: the end-of-turn fix scrolled a settled turn instantly, which silently dropped the
// documented design (useChatScroll's header: a committed turn scrolls smoothly unless motion is reduced).
test('P6 a settled reply still scrolls smoothly when motion is allowed', async ({ page }) => {
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { __scrolls: string[] }).__scrolls = seen;
    const original = Element.prototype.scrollTo;
    Element.prototype.scrollTo = function (this: Element, ...args: unknown[]) {
      const options = args[0];
      if (options && typeof options === 'object') seen.push(String((options as ScrollToOptions).behavior ?? 'auto'));
      return (original as (...a: unknown[]) => void).apply(this, args);
    } as typeof Element.prototype.scrollTo;
  });
  await newChat(page);
  await sendAndWait(page, 'Summarise the last 90 days of audit data');
  await expect.poll(() => page.evaluate(() => (window as unknown as { __scrolls: string[] }).__scrolls)).toContain('smooth');
});

// Look critic round 2 (must-fix 1 and 2): the rename field opens with the whole title selected (the donor's
// RenameForm selects it, so the start is visible and typing replaces it), and shows its own Save and Cancel.
test('P6 the rename field opens with the whole title selected and its own save and cancel', async ({ page }) => {
  const title = 'First pass at the compliance control catalogue'; // mock row 9
  const renamed = 'Compliance control catalogue';
  let passed = false;
  try {
    await openChat(page);
    await row(page, title).hover();
    await page.getByRole('button', { name: `Rename chat: ${title}` }).filter({ visible: true }).click();
    const field = page.getByRole('textbox', { name: 'Chat title' });
    await expect(field).toBeFocused();
    expect(await field.evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd, el.value.length]))
      .toEqual([0, title.length, title.length]);

    await page.getByRole('button', { name: 'Cancel rename' }).click();
    await expect(field).toHaveCount(0);
    await expect(row(page, title)).toBeVisible();

    await row(page, title).hover();
    await page.getByRole('button', { name: `Rename chat: ${title}` }).filter({ visible: true }).click();
    await field.fill(renamed);
    await page.getByRole('button', { name: 'Save title' }).click();
    await expect(row(page, renamed)).toBeVisible();
    passed = true;
  } finally {
    await resetMeta(page, 9, passed);
  }
});

// Look critic round 2 (must-fix 3; Jev 1.0 on owner decision 61's placement): on the chat page the voice orb's
// default sits in the house navigation's empty lower band, so it covers no part of the chat — not the composer
// (B-17), not the landing's starters, not the conversation rail — and not the navigation's own footer controls.
test('P6 the voice orb default covers no part of the chat', async ({ page }) => {
  await page.route('**/api/jarvis/manifest', (route) => route.fulfill({
    json: { generatedAt: '2026-09-27T00:00:00.000Z', routes: [], resources: [], jarvisEnabled: true, voiceEnabled: false },
  }));
  await page.addInitScript(() => localStorage.removeItem('cce_jarvis_widget_pos'));
  const hit = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) =>
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
  for (const size of [{ width: 1024, height: 768 }, { width: 1280, height: 800 }, { width: 1440, height: 900 }]) {
    await page.setViewportSize(size);
    await newChat(page);
    const orb = (await page.getByRole('button', { name: /^Jarvis \(/ }).boundingBox())!;
    const canvas = (await page.locator('[data-tour="chat-messages"]').boundingBox())!;
    expect(hit(orb, canvas), `the orb covers the chat at ${size.width}`).toBe(false);
    const rail = await page.locator('aside[aria-label="Conversation history"]').boundingBox();
    if (rail) expect(hit(orb, rail), `the orb covers the conversation rail at ${size.width}`).toBe(false);
    for (const name of ['Sign out', 'Collapse sidebar']) {
      const control = await page.getByRole('button', { name }).first().boundingBox();
      if (control) expect(hit(orb, control), `the orb covers ${name} at ${size.width}`).toBe(false);
    }
  }
});

// Look critic round 3 (S26): the delete confirmation names the conversation it will delete (the donor bolds
// it); the list can hold several near-identical titles.
test('P6 the delete confirmation names the conversation it deletes', async ({ page }) => {
  const title = 'Kill-switch audit rows from yesterday'; // mock row 4
  await openChat(page);
  await row(page, title).hover();
  await page.getByRole('button', { name: `Delete chat: ${title}` }).filter({ visible: true }).click();
  const dialog = page.getByRole('dialog').filter({ hasText: /Delete chat\?/ });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(title);
  await page.keyboard.press('Escape');
});

// Look critic round 3 (S10): a staged image shows a thumbnail, so a person can see which picture they attached.
test('P6 a staged image shows its thumbnail', async ({ page }) => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR4nGNkYPj/n4GBgYGJgYGBgQEAHgQCAWkK3lUAAAAASUVORK5CYII=', 'base64');
  await newChat(page);
  await page.locator('input[type="file"]').setInputFiles({ name: 'chart.png', mimeType: 'image/png', buffer: png });
  const thumbnail = page.getByRole('list', { name: 'Attached files' }).getByRole('img', { name: /chart\.png/ });
  await expect(thumbnail).toBeVisible();
  expect(await thumbnail.getAttribute('src')).toMatch(/^blob:/);
});

// Look critic round 3 (S07): a reply that fails after some text keeps that text as the reply; the alert
// carries only the failure (and Try again), so a reader can tell the answer from the error.
test('P6 a reply that fails after some text keeps the text apart from the error', async ({ page }) => {
  await newChat(page);
  await composerOf(page).fill('/fixture error-partial');
  await sendOf(page).click();
  const alert = page.getByRole('alert');
  await expect(alert).toHaveCount(1);
  await expect(alert).not.toContainText('The report covers three regions');
  await expect(replies(page).last()).toContainText('The report covers three regions');
});

// Look critic round 3 (must-fix): in the navigation's lower band the orb's hint must not cover the navigation,
// shown or hovered.
test('P6 the voice orb hint never covers the navigation', async ({ page }) => {
  await page.route('**/api/jarvis/manifest', (route) => route.fulfill({
    json: { generatedAt: '2026-09-27T00:00:00.000Z', routes: [], resources: [], jarvisEnabled: true, voiceEnabled: false },
  }));
  await page.addInitScript(() => localStorage.removeItem('cce_jarvis_widget_pos'));
  await page.setViewportSize({ width: 1280, height: 800 });
  await newChat(page);
  const orb = page.getByRole('button', { name: /^Jarvis \(/ });
  await expect(orb).toBeVisible();
  const hit = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) =>
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
  const covered = async () => {
    const hints = page.locator('.jarvis-caption');
    const links = page.locator('nav[aria-label="Main"] a');
    for (let i = 0; i < await hints.count(); i++) {
      const h = await hints.nth(i).boundingBox();
      if (!h) continue;
      for (let j = 0; j < await links.count(); j++) {
        const l = await links.nth(j).boundingBox();
        if (l && hit(h, l)) return `${await hints.nth(i).innerText()} covers ${await links.nth(j).innerText()}`;
      }
    }
    return '';
  };
  expect(await covered()).toBe('');
  // The idle orb breathes (jarvis-breath scales it about its centre), so it is never "stable":
  // force skips only that wait; the pointer still lands on the orb's centre.
  await orb.hover({ force: true });
  // Hovered, the hint is still offered (voice is off here), just never over the navigation.
  await expect(page.locator('.jarvis-caption')).toBeVisible();
  await page.waitForTimeout(300);
  expect(await covered()).toBe('');
});
