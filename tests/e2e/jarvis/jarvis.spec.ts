import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const APP_URL = process.env.CCE_E2E_URL ?? 'https://claudeclaw-enterprise.com/dashboard/';
const TOKEN = process.env.CCE_TOKEN ?? '';
const ORIGIN = new URL(APP_URL).origin;
const ART = 'e2e-jarvis/artifacts';
mkdirSync(ART, { recursive: true });

type Frame = { type?: string; text?: string; rate?: number; b64?: string; [k: string]: unknown };

// Authenticate the dashboard (token in localStorage) and skip the onboarding
// wizard so the floating widget is never covered.
test.beforeEach(async ({ page }) => {
  expect(TOKEN, 'CCE_TOKEN env must be set').not.toBe('');
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
  await page.evaluate(
    ({ t }) => {
      localStorage.setItem('cce_token', t);
      localStorage.setItem('cce_onboarded', 'true');
      localStorage.removeItem('cce_jarvis_widget_pos'); // start from the default anchor
      localStorage.removeItem('cce_jarvis_widget_hidden'); // and with the orb un-dismissed
    },
    { t: TOKEN },
  );
  await page.reload({ waitUntil: 'domcontentloaded' });
});

test('manifest reports Jarvis + voice enabled (the gate, end to end)', async ({ page }) => {
  const res = await page.request.get(`${ORIGIN}/api/jarvis/manifest`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  expect(res.ok(), `manifest HTTP ${res.status()}`).toBeTruthy();
  const m = (await res.json()) as { jarvisEnabled?: boolean; voiceEnabled?: boolean };
  expect(m.jarvisEnabled).toBe(true);
  expect(m.voiceEnabled).toBe(true);
});

test('the orb renders, drags, and remembers its position', async ({ page }) => {
  const widget = page.getByTestId('jarvis-widget');
  await expect(widget).toBeVisible();
  const orb = page.getByTestId('mic-button');
  await expect(orb).toBeVisible();

  const before = (await widget.boundingBox())!;
  const ob = (await orb.boundingBox())!;
  // Press on the orb, move well past the drag threshold, release.
  await page.mouse.move(ob.x + ob.width / 2, ob.y + ob.height / 2);
  await page.mouse.down();
  await page.mouse.move(ob.x + 260, ob.y - 180, { steps: 12 });
  await page.mouse.up();

  const after = (await widget.boundingBox())!;
  const moved = Math.abs(after.x - before.x) + Math.abs(after.y - before.y);
  expect(moved, 'widget should have moved').toBeGreaterThan(80);

  const stored = await page.evaluate(() => localStorage.getItem('cce_jarvis_widget_pos'));
  expect(stored, 'position should persist to localStorage').toBeTruthy();
  await page.screenshot({ path: `${ART}/orb-dragged.png` });

  // Survives a reload.
  await page.reload({ waitUntil: 'domcontentloaded' });
  const afterReload = (await page.getByTestId('jarvis-widget').boundingBox())!;
  expect(Math.abs(afterReload.x - after.x), 'x persists').toBeLessThan(12);
  expect(Math.abs(afterReload.y - after.y), 'y persists').toBeLessThan(12);
});

test('hovering the idle orb reveals contextual suggestion chips', async ({ page }) => {
  const orb = page.getByTestId('mic-button');
  await expect(orb).toBeVisible();
  await orb.hover({ force: true });
  const chips = page.getByTestId('jarvis-suggestions');
  await expect(chips).toBeVisible();
  // Overview (default route) carries the default suggestions, tour included.
  await expect(chips.getByRole('button', { name: /tour of the dashboard/i })).toBeVisible();
  await page.screenshot({ path: `${ART}/suggestion-chips.png` });
});

test('the /jarvis tab offers the guided-tour starter pill', async ({ page }) => {
  await page.goto(`${APP_URL.replace(/\/$/, '')}/jarvis`, { waitUntil: 'domcontentloaded' });
  const pills = page.getByTestId('jarvis-pills');
  await expect(pills).toBeVisible();
  await expect(pills.getByRole('button', { name: /tour of the dashboard/i })).toBeVisible();
});

test('the orb can be closed, stays closed, and comes back from the /jarvis tab', async ({ page }) => {
  const widget = page.getByTestId('jarvis-widget');
  await expect(widget).toBeVisible();

  await page.getByTestId('jarvis-close').click();
  await expect(widget).toBeHidden();
  expect(await page.evaluate(() => localStorage.getItem('cce_jarvis_widget_hidden'))).toBe('true');

  // Dismissal survives a reload — an X that un-does itself is not an X.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('jarvis-widget')).toBeHidden();

  // Opening the Jarvis tab re-arms it, so the X is never a one-way door.
  await page.goto(`${APP_URL.replace(/\/$/, '')}/jarvis`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('jarvis-console')).toBeVisible();
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('jarvis-widget')).toBeVisible();
});

test('clicking the orb opens a voice session and Jarvis greets in audio', async ({ page }) => {
  const frames: Frame[] = [];
  page.on('websocket', (ws) => {
    if (!ws.url().includes('/api/jarvis/voice')) return;
    ws.on('framereceived', (d) => {
      try {
        const raw = typeof d.payload === 'string' ? d.payload : d.payload.toString('utf8');
        frames.push(JSON.parse(raw) as Frame);
      } catch {
        /* binary/non-JSON frame */
      }
    });
  });
  const consoleErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });

  // The orb breathes/glows continuously, so it's never "stable" for the default
  // actionability wait — force the click (this is a harness concern, not a bug).
  await page.getByTestId('mic-button').click({ force: true });

  // The session opens, then Jarvis speaks the greeting (Polly, 16kHz) without
  // the user saying anything.
  await expect
    .poll(() => frames.some((f) => f.type === 'session_ready'), { timeout: 25_000, message: 'session_ready' })
    .toBe(true);
  await expect
    .poll(() => frames.some((f) => f.type === 'audio_out'), { timeout: 25_000, message: 'greeting audio_out' })
    .toBe(true);

  // The persona never says "sir" — just assert Jarvis spoke a real greeting line.
  const greeting = frames.find(
    (f) => f.type === 'transcript' && f.role === 'assistant' && String(f.text ?? '').trim().length > 0,
  );
  expect(greeting, 'a non-empty assistant greeting transcript').toBeTruthy();

  const audio = frames.find((f) => f.type === 'audio_out')!;
  expect(audio.rate, 'audio_out tagged at the Polly 16kHz rate').toBe(16000);
  expect(String(audio.b64 ?? '').length, 'audio_out carries PCM bytes').toBeGreaterThan(100);

  // The widget should reflect that Jarvis is talking.
  await expect(page.getByTestId('mic-button')).toHaveAttribute('aria-label', /speaking|listening|thinking/);
  await page.screenshot({ path: `${ART}/voice-greeting.png` });

  // Surface (don't hard-fail) any further frames so we can see the Nova
  // conversational path behaviour, and assert no fatal client errors.
  const summary = frames.reduce<Record<string, number>>((a, f) => {
    a[f.type ?? '?'] = (a[f.type ?? '?'] ?? 0) + 1;
    return a;
  }, {});
  console.log('JARVIS_FRAME_SUMMARY', JSON.stringify(summary));
  expect(consoleErrors.join('\n')).not.toMatch(/Uncaught|is not a function|TypeError:/);
});
