import { test, expect, type BrowserContext, type Frame, type Page } from '@playwright/test';

// P5 (step 7) — the artifact card and panel as a person meets them, in a real browser against the chat
// mock (CCE_CHAT_MOCK=1; web/dev/mock-stream-plugin.ts + web/dev/artifact-fixtures.ts). Written BEFORE the
// change, as the bar (netzar-chat-plan/p5-proof.sh rows B-1..B-13).
//
//   - Decision 58 / ART-02: a streamed, URL-free artifact reference becomes a card that holds no link; the
//     link is minted only when the person clicks Download (ART-06), for the exact version shown.
//   - ART-03: the panel previews each type safely — HTML and Mermaid in an opaque-origin sandbox, SVG as an
//     image, pictures and PDFs from the bytes, markdown, code and CSV as text, a deck as its outline, and a
//     plain fallback for everything else.
//   - WI-5.3 / ART-05 / ART-07: versions switch the preview and the download; copy; the cards come back
//     after a reload; on a phone the panel is a full-screen sheet that Escape closes.
//   - ART-09 / ART-12: the hostile fixtures cannot reach the parent page, its storage or the network, except
//     the two library CDNs owner decision 4 names; SVG and office previews run no script; markdown pulls no
//     remote media. ART-16's export channel is deferred (Jev), so the page accepts NO message from a preview.
//
// Identity is seeded exactly as chat.spec.ts does; see its comment for why that is not an authorization
// bypass. Nothing here reaches the internet: every request to another host is recorded, and aborted or
// answered with a stub.
const CAPS = ['overview:read', 'chat:read', 'agents:read', 'sessions:read'];
const LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//;
const CDN_ALLOWED = /^https:\/\/(cdn\.jsdelivr\.net\/npm\/|cdnjs\.cloudflare\.com\/ajax\/libs\/)/;
const MERMAID_SRC = 'https://cdn.jsdelivr.net/npm/mermaid@11.17.2/dist/mermaid.min.js';

test.beforeEach(async ({ page, context }) => {
  await page.addInitScript((caps) => {
    localStorage.setItem('cce_token', 'local-dev-dashboard-token');
    localStorage.setItem('cce_onboarded', 'true');
    localStorage.setItem('cce_role', 'admin');
    localStorage.setItem('cce_capabilities', JSON.stringify(caps));
  }, CAPS);
  await offline(context);
});

/**
 * What reached the network: every request for another host that got past the browser's own policy checks and
 * arrived at this route. A request Content-Security-Policy refused never arrives here — Playwright still reports
 * it as a `request` event (then fails it with `csp`), which is why the `request` event is NOT the measure.
 * The two library CDNs get a stub; everything else is aborted.
 */
const reached = new WeakMap<BrowserContext, string[]>();
async function offline(context: BrowserContext): Promise<void> {
  const seen: string[] = [];
  reached.set(context, seen);
  await context.route((url) => !LOCAL.test(url.toString()), async (route) => {
    const url = route.request().url();
    seen.push(url);
    if (url.startsWith('https://cdn.jsdelivr.net/npm/p5-probe@')) {
      return route.fulfill({ contentType: 'application/javascript', body: "window.__cdn = (window.__cdn || []).concat('jsdelivr');" });
    }
    if (url.startsWith('https://cdnjs.cloudflare.com/ajax/libs/p5-probe/')) {
      return route.fulfill({ contentType: 'application/javascript', body: "window.__cdn = (window.__cdn || []).concat('cdnjs');" });
    }
    return route.abort();
  });
}

/** The requests that have reached the network so far in this test (read it after the actions under test). */
function outbound(context: BrowserContext): string[] {
  return reached.get(context)!;
}

const composerOf = (page: Page) => page.getByRole('textbox', { name: /^Message / });
const sendOf = (page: Page) => page.getByRole('button', { name: 'Send message' });
const panelOf = (page: Page) => page.locator('[data-artifact-panel]');
const previewOf = (page: Page) => page.locator('[data-artifact-preview]');
const openCard = (page: Page, name: string) => page.getByRole('button', { name: `Open ${name}`, exact: true });

/** Open the chat, start a fresh conversation (P56), send one fixture and wait for the end of the turn (P60). */
async function playFixture(page: Page, name: string): Promise<void> {
  await page.goto('/dashboard/chat');
  await expect(composerOf(page)).toBeVisible();
  await page.getByRole('button', { name: 'New chat' }).first().click();
  await composerOf(page).fill(`/fixture ${name}`);
  await sendOf(page).click();
  await expect(page.getByRole('button', { name: 'Stop generating' })).toHaveCount(0, { timeout: 30_000 });
  await expect(sendOf(page)).toBeVisible();
}

async function open(page: Page, name: string): Promise<void> {
  await openCard(page, name).click();
  await expect(panelOf(page)).toBeVisible();
  // Level 2: the panel's own title. A markdown preview's h1 may repeat the name.
  await expect(panelOf(page).getByRole('heading', { name, level: 2 })).toBeVisible();
}

/** The one sandboxed srcdoc frame the preview renders. */
async function previewFrame(page: Page): Promise<Frame> {
  await expect(previewOf(page).locator('iframe')).toHaveCount(1);
  const handle = await previewOf(page).locator('iframe').elementHandle();
  const frame = await handle!.contentFrame();
  expect(frame, 'the preview frame is live').not.toBeNull();
  return frame!;
}

test('P5 a streamed artifact shows a card that holds no link', async ({ page }) => {
  const minted: string[] = [];
  page.on('request', (r) => { if (/\/api\/artifacts\/(download|content)/.test(r.url())) minted.push(r.url()); });
  await playFixture(page, 'artifacts');

  const card = page.locator('[data-artifact-card]').filter({ has: openCard(page, 'Quarterly report') });
  await expect(card).toHaveCount(1);
  await expect(card.getByRole('button', { name: 'Download Quarterly report', exact: true })).toBeVisible();
  // The card holds no link at all: nothing to leak, nothing to expire.
  await expect(card.locator('a[href], [href], [src]')).toHaveCount(0);
  expect(await card.evaluate((el) => el.outerHTML)).not.toMatch(/https?:|blob:|X-Amz|__mock/);
  // Every file the reply made has its card, and nothing was fetched or minted before a click.
  await expect(page.locator('[data-artifact-card]')).toHaveCount(10);
  expect(minted, 'no link and no bytes before a click').toEqual([]);
});

test('P5 the card download remints that exact version on click', async ({ page }) => {
  await playFixture(page, 'artifacts');
  const minted: string[] = [];
  page.on('request', (r) => { if (r.url().includes('/api/artifacts/download')) minted.push(r.url()); });

  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download Quarterly report', exact: true }).click();
  const file = await downloading;
  expect(file.suggestedFilename(), 'the name carries its type (L1)').toBe('Quarterly report.html');
  expect(minted).toHaveLength(1);
  const q = new URL(minted[0]!).searchParams;
  expect(q.get('artifactId')).toBe('f78d0000-0000-4000-8000-000000000501');
  expect(q.get('version')).toBe('1');
  expect(q.get('chatId')).toMatch(/^dashboard:/);
  // The minted link is used once and not kept anywhere on the page.
  await expect(page.locator('a[href*="__mock-artifacts"]')).toHaveCount(0);
});

test('P5 the panel previews each artifact type safely', async ({ page }) => {
  await playFixture(page, 'artifacts');

  await open(page, 'Quarterly report');
  await expect(previewOf(page)).toHaveAttribute('data-kind', 'html');
  const pageFrame = previewOf(page).locator('iframe');
  await expect(pageFrame).toHaveAttribute('sandbox', 'allow-scripts');
  expect(await pageFrame.getAttribute('srcdoc')).toContain('<meta http-equiv="Content-Security-Policy"');
  await expect(page.frameLocator('[data-artifact-preview] iframe').getByRole('heading', { name: 'Quarterly report' })).toBeVisible();

  await open(page, 'Revenue chart');
  await expect(previewOf(page)).toHaveAttribute('data-kind', 'svg');
  await expect(previewOf(page).locator('img[src^="data:image/svg+xml"]')).toHaveCount(1);

  await open(page, 'Team photo');
  await expect(previewOf(page)).toHaveAttribute('data-kind', 'image');
  await expect(previewOf(page).locator('img[src^="blob:"]')).toHaveCount(1);

  await open(page, 'Board pack');
  await expect(previewOf(page)).toHaveAttribute('data-kind', 'pdf');
  await expect(previewOf(page).locator('iframe[src^="blob:"], object[data^="blob:"], embed[src^="blob:"]')).toHaveCount(1);

  await open(page, 'Launch notes');
  await expect(previewOf(page)).toHaveAttribute('data-kind', 'markdown');
  await expect(previewOf(page).getByRole('heading', { name: 'Launch notes' })).toBeVisible();

  await open(page, 'fibonacci.py');
  await expect(previewOf(page)).toHaveAttribute('data-kind', 'code');
  await expect(previewOf(page).locator('pre')).toContainText('def fib(n):');

  await open(page, 'Pipeline');
  await expect(previewOf(page)).toHaveAttribute('data-kind', 'csv');
  await expect(previewOf(page).getByRole('cell', { name: 'Qualified, hot' })).toBeVisible();

  await open(page, 'Signup flow');
  await expect(previewOf(page)).toHaveAttribute('data-kind', 'mermaid');
  const flow = previewOf(page).locator('iframe');
  await expect(flow).toHaveAttribute('sandbox', 'allow-scripts');
  expect(await flow.getAttribute('srcdoc')).toContain(MERMAID_SRC);
  // Offline here, so the library never loads: the source stays readable (the fallback).
  await expect(page.frameLocator('[data-artifact-preview] iframe').getByText('A[Visit] --> B[Sign up]')).toBeVisible();

  await open(page, 'Launch deck');
  await expect(previewOf(page)).toHaveAttribute('data-kind', 'outline');
  await expect(previewOf(page).getByRole('listitem')).toHaveText(['Why now', 'Plan Ship it']);

  await open(page, 'Memo');
  await expect(previewOf(page)).toHaveAttribute('data-kind', 'fallback');
  await expect(previewOf(page).getByText(/No preview available/)).toBeVisible();
  await expect(panelOf(page).getByRole('button', { name: 'Download Memo', exact: true })).toBeVisible();
});

test('P5 the version picker switches the preview and the download', async ({ page }) => {
  await playFixture(page, 'versions');
  await open(page, 'plan.md');
  const picker = panelOf(page).getByRole('combobox', { name: 'Version' });
  await expect(picker, 'the card opens the version its turn made').toHaveValue('1');
  await expect(picker.locator('option')).toHaveCount(2);
  await expect(previewOf(page)).toContainText('Version one');

  await picker.selectOption('2');
  await expect(previewOf(page)).toContainText('Version two');
  await expect(previewOf(page)).not.toContainText('Version one');

  const minted: string[] = [];
  page.on('request', (r) => { if (r.url().includes('/api/artifacts/download')) minted.push(r.url()); });
  const downloading = page.waitForEvent('download');
  await panelOf(page).getByRole('button', { name: 'Download plan.md', exact: true }).click();
  await downloading;
  expect(minted).toHaveLength(1);
  expect(new URL(minted[0]!).searchParams.get('version'), 'the download follows the version shown').toBe('2');
});

test('P5 copy puts the shown version source on the clipboard', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await playFixture(page, 'versions');
  await open(page, 'plan.md');
  await panelOf(page).getByRole('combobox', { name: 'Version' }).selectOption('2');
  await expect(previewOf(page)).toContainText('Version two');
  await panelOf(page).getByRole('button', { name: 'Copy source' }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('# Plan\n\nVersion two\n');
});

test('P5 artifact cards come back after a reload and still open', async ({ page }) => {
  await playFixture(page, 'artifacts');
  await expect(page.locator('[data-artifact-card]')).toHaveCount(10);
  await page.reload();
  await expect(openCard(page, 'Launch notes'), 'the reloaded turn keeps its cards (ART-07)').toBeVisible();
  await expect(page.locator('[data-artifact-card]')).toHaveCount(10);
  await open(page, 'Launch notes');
  await expect(previewOf(page).getByRole('heading', { name: 'Launch notes' })).toBeVisible();
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test('P5 on a phone the panel is a full screen sheet that Escape closes', async ({ page }) => {
    await playFixture(page, 'artifacts');
    const opener = openCard(page, 'Launch notes');
    await opener.click();
    const sheet = page.getByRole('dialog', { name: /Launch notes/ });
    await expect(sheet).toBeVisible();
    await expect(sheet).toHaveAttribute('aria-modal', 'true');
    const box = await sheet.boundingBox();
    expect(box, 'the sheet covers the screen').not.toBeNull();
    expect(box!.x).toBeLessThanOrEqual(1);
    expect(box!.y).toBeLessThanOrEqual(1);
    expect(box!.width).toBeGreaterThanOrEqual(374);
    expect(box!.height).toBeGreaterThanOrEqual(811);
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
    await expect(opener, 'focus returns to the card that opened it').toBeFocused();

    // Escape works the instant the sheet mounts, not only once the browser has painted: a key pressed in that
    // window must not be lost (it was, once, in a full run). Open and press Escape in the same task as the render.
    const mounted = await opener.evaluate(async (button) => {
      (button as HTMLElement).click();
      for (let i = 0; i < 5; i++) await Promise.resolve();
      const present = document.querySelector('[data-artifact-panel]') !== null;
      (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return present;
    });
    expect(mounted, 'the sheet was in the page when Escape was pressed').toBe(true);
    await expect(sheet).toHaveCount(0);
  });
});

test('P5 a hostile page preview cannot reach the parent or the network', async ({ page, context }) => {
  const leaks = outbound(context);
  const sockets: string[] = [];
  const popups: string[] = [];
  page.on('websocket', (ws) => sockets.push(ws.url()));
  page.on('popup', (p) => popups.push(p.url()));
  await playFixture(page, 'hostile');
  const parentUrl = page.url();
  // The dev server's own HMR socket opens with the page; count only the sockets opened after the preview is.
  const devSockets = sockets.length;
  await open(page, 'hostile page');
  await expect(previewOf(page)).toHaveAttribute('data-kind', 'html');
  await expect(previewOf(page).locator('iframe')).toHaveAttribute('sandbox', 'allow-scripts');

  const frame = await previewFrame(page);
  await expect.poll(() => frame.evaluate(() => (window as unknown as { __p5?: { done?: string } }).__p5?.done),
    { timeout: 10_000 }).toBe('yes');
  const r = await frame.evaluate(() => (window as unknown as { __p5: Record<string, string> }).__p5);

  // An opaque origin: no parent page, no storage, no cookie, no token.
  expect(r.origin).toBe('null');
  expect(r.parentDoc).toMatch(/^blocked:/);
  expect(r.topWrite).toMatch(/^blocked:/);
  expect(r.storage).toMatch(/^blocked:/);
  expect(r.session).toMatch(/^blocked:/);
  expect(r.cookie === '' || r.cookie!.startsWith('blocked:'), `cookie: ${r.cookie}`).toBe(true);
  expect(JSON.stringify(r)).not.toContain('local-dev-dashboard-token');
  // WebRTC is removed (connect-src cannot govern it).
  expect(r.rtc).toBe('undefined');
  // No popup and no top-level navigation.
  expect(r.popup).toBe('null');
  expect(popups).toEqual([]);

  // Then the page tries to navigate its own frame off-site. A frame's navigation is judged by its PARENT's
  // policy, so the dashboard page's own frame-src must refuse it before any request leaves (measured: without
  // that, this request left the machine although the frame's own policy held), and the panel replaces a
  // preview that tried to leave with the fallback.
  await expect(previewOf(page)).toHaveAttribute('data-kind', 'fallback', { timeout: 10_000 });
  await expect(previewOf(page).getByText(/No preview available/)).toBeVisible();
  await expect(previewOf(page).locator('iframe')).toHaveCount(0);
  expect(page.url()).toBe(parentUrl);
  await expect(page.locator('body')).not.toContainText('PWNED');
  // The export channel is deferred: the page ignores the preview's message and the panel stays as it was.
  await expect(panelOf(page).getByRole('heading', { name: 'hostile page', level: 2 })).toBeVisible();

  // A page that swaps itself for a blob document of its own: that document inherits the preview's policy, so its
  // fetch and image are refused too.
  await open(page, 'blob hop');
  await expect(previewOf(page)).toHaveAttribute('data-kind', 'fallback', { timeout: 10_000 });
  await page.waitForTimeout(500);

  // Nothing reached the network: fetch, XHR, WebSocket, beacon, images, CSS, prefetch, form, either navigation.
  expect(leaks).toEqual([]);
  expect(sockets.slice(devSockets)).toEqual([]);
});

test('P5 a hostile drawing preview runs no script', async ({ page, context }) => {
  const leaks = outbound(context);
  await playFixture(page, 'hostile');
  await open(page, 'hostile drawing');
  await expect(previewOf(page)).toHaveAttribute('data-kind', 'svg');
  // Rendered as an image: the browser runs no script and loads nothing an <img> SVG points at.
  await expect(previewOf(page).locator('img[src^="data:image/svg+xml"]')).toHaveCount(1);
  await expect(previewOf(page).locator('iframe, object, embed, svg script')).toHaveCount(0);
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => (window as unknown as { __svgPwned?: number }).__svgPwned)).toBeUndefined();
  expect(leaks).toEqual([]);
});

test('P5 a hostile office file previews as inert text or a fallback', async ({ page, context }) => {
  const leaks = outbound(context);
  await playFixture(page, 'hostile');

  // An archive bomb: the server refuses to open it, and the panel says so plainly.
  await open(page, 'bomb deck');
  await expect(previewOf(page)).toHaveAttribute('data-kind', 'fallback');
  await expect(previewOf(page).getByText(/No preview available/)).toBeVisible();

  // Slide text that looks like markup stays text.
  await open(page, 'script deck');
  await expect(previewOf(page)).toHaveAttribute('data-kind', 'outline');
  await expect(previewOf(page).getByRole('listitem').first()).toContainText('<script>window.__officePwned=1</script>');
  await expect(previewOf(page).locator('script, img, iframe')).toHaveCount(0);

  // A macro-bearing document is never opened at all.
  await open(page, 'macro memo');
  await expect(previewOf(page)).toHaveAttribute('data-kind', 'fallback');
  await expect(previewOf(page).locator('script, img, iframe, object, embed')).toHaveCount(0);

  await page.waitForTimeout(300);
  expect(await page.evaluate(() => (window as unknown as { __officePwned?: number }).__officePwned)).toBeUndefined();
  expect(leaks).toEqual([]);
});

test('P5 an older link card still downloads', async ({ page }) => {
  await playFixture(page, 'media');
  const legacy = page.locator('a[download="q3-summary.pdf"]');
  await expect(legacy, 'a pre-P5 URL card keeps its download fallback').toBeVisible();
  const downloading = page.waitForEvent('download');
  await legacy.click();
  expect((await downloading).suggestedFilename()).toBe('q3-summary.pdf');
});

test('P5 a markdown preview loads no remote media', async ({ page, context }) => {
  const leaks = outbound(context);
  await playFixture(page, 'hostile');
  await open(page, 'remote notes');
  await expect(previewOf(page)).toHaveAttribute('data-kind', 'markdown');
  await expect(previewOf(page)).toContainText('Plain words stay.');
  await expect(previewOf(page).locator('img[src^="http"], video[src^="http"], source[src^="http"]')).toHaveCount(0);
  await page.waitForTimeout(500);
  expect(leaks).toEqual([]);
});

test('P5 page previews may load libraries from the two CDNs only', async ({ page, context }) => {
  const leaks = outbound(context);
  await playFixture(page, 'cdn');
  await open(page, 'cdn page');
  const frame = await previewFrame(page);
  await expect.poll(() => frame.evaluate(() => (window as unknown as { __cdnDone?: string }).__cdnDone),
    { timeout: 10_000 }).toBe('yes');
  expect(await frame.evaluate(() => (window as unknown as { __cdn?: string[] }).__cdn)).toEqual(['jsdelivr', 'cdnjs']);
  expect(leaks.filter((u) => !CDN_ALLOWED.test(u)), 'nothing but the two library paths').toEqual([]);
  expect(leaks.filter((u) => CDN_ALLOWED.test(u))).toHaveLength(2);
});
