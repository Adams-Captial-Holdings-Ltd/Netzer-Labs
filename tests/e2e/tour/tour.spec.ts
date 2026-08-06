import { test, expect, type Page } from '@playwright/test';

// Live-deploy smoke for the guided tour (lib/tour). Verifies:
//  1. Settings has the Guided tour card and "Start the full tour" launches it.
//  2. The tour walks tabs in order, navigating between routes.
//  3. Skip tab advances a whole tab; Esc exits.
//  4. An aborted tour (past tab 1) offers "Resume from …" in Settings.
//  5. Single-tab mode finishes after that one tab.
const BASE = (process.env.CCE_E2E_URL ?? 'https://claudeclaw-enterprise.com/dashboard/').replace(/\/$/, '');
const TOKEN = process.env.CCE_TOKEN ?? '';

async function login(page: Page): Promise<void> {
  expect(TOKEN, 'CCE_TOKEN env must be set').not.toBe('');
  await page.goto(BASE + '/');
  await page.evaluate(
    ({ t }) => {
      localStorage.setItem('cce_token', t);
      localStorage.setItem('cce_onboarded', 'true');
      localStorage.removeItem('cce_tour_progress');
    },
    { t: TOKEN },
  );
  await page.goto(BASE + '/settings');
  await expect(page.locator('[data-tour="settings-tour"]')).toBeVisible();
}

test('full tour: launches, walks tabs in order, skip + resume work', async ({ page }) => {
  await login(page);

  await page.getByRole('button', { name: 'Start the full tour' }).click();
  const overlay = page.getByTestId('tour-overlay');
  await expect(overlay).toBeVisible();

  // Tab 1 is Overview; the engine navigates there from /settings.
  const card = page.getByTestId('tour-card');
  await expect(card).toContainText('Overview', { timeout: 30_000 });
  await expect(page).toHaveURL(new RegExp('/dashboard/?$'));
  await page.screenshot({ path: 'tests/e2e/tour/shot-1-overview-step1.png' });

  // Walk forward a few steps; the card always shows progress "n of N".
  const next = card.getByRole('button', { name: /^(Next|Finish)/ });
  for (let i = 0; i < 4; i++) {
    await next.click();
    await expect(card).toBeVisible();
  }
  // By step 5 we must have crossed into the Agents tab (Overview has 4 steps).
  await expect(card).toContainText('Agents');
  await expect(page).toHaveURL(/\/agents/);
  await page.screenshot({ path: 'tests/e2e/tour/shot-2-agents.png' });

  // Skip tab jumps to the next tab (Chat).
  await page.getByTestId('tour-skip-tab').click();
  await expect(card).toContainText('Chat');
  await expect(page).toHaveURL(/\/chat/);

  // Esc aborts; we are past tab 1, so Settings offers a resume.
  await page.keyboard.press('Escape');
  await expect(overlay).not.toBeVisible();
  await page.goto(BASE + '/settings');
  await expect(page.getByRole('button', { name: /Resume from Chat/ })).toBeVisible();

  // Resume puts us back on the Chat tab of the tour.
  await page.getByRole('button', { name: /Resume from Chat/ }).click();
  await expect(page.getByTestId('tour-card')).toContainText('Chat', { timeout: 30_000 });
  await page.keyboard.press('Escape');
});

test('single-tab tour finishes after one tab', async ({ page }) => {
  await login(page);

  // Pick "Audit Log" from the single-page select (custom Select component).
  await page.getByText('Tour a single page…').click();
  await page.getByRole('option', { name: 'Audit Log' }).click().catch(async () => {
    // The shared Select renders plain buttons, not listbox options.
    await page.locator('[data-tour="settings-tour"] button', { hasText: 'Audit Log' }).click();
  });

  const card = page.getByTestId('tour-card');
  await expect(card).toContainText('Audit Log', { timeout: 30_000 });
  await expect(page).toHaveURL(/\/audit/);
  // No "Skip tab" in single mode, and the last step's button says Finish.
  await expect(page.getByTestId('tour-skip-tab')).toHaveCount(0);
  const next = card.getByRole('button', { name: /^(Next|Finish)/ });
  for (let i = 0; i < 6; i++) {
    const label = (await next.textContent()) ?? '';
    await next.click();
    if (label.includes('Finish')) break;
  }
  await expect(page.getByTestId('tour-overlay')).not.toBeVisible();
  await page.screenshot({ path: 'tests/e2e/tour/shot-3-after-single.png' });
});
