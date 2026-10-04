import { test, expect, type Page } from '@playwright/test';

const CAPS = ['overview:read', 'work:read', 'work:approve', 'missions:read'];
test.beforeEach(async ({ page }) => {
  await page.request.post('/api/work/__reset');
  await page.addInitScript((caps) => {
    localStorage.setItem('cce_token', 'local-dev-dashboard-token');
    localStorage.setItem('cce_onboarded', 'true');
    localStorage.setItem('cce_role', 'admin');
    localStorage.setItem('cce_capabilities', JSON.stringify(caps));
  }, CAPS);
});
async function detail(page: Page, id = 'approval-1') {
  await page.goto(`/dashboard/work/approvals/${id}`);
  await expect(page.getByRole('heading', { name: /Clinical disposition for/ })).toBeVisible();
}

test('approve through confirm shows result and leaves Inbox', async ({ page }) => {
  await page.goto('/dashboard/work');
  await expect(page.getByRole('heading', { name: 'Waiting for your decision' })).toBeVisible();
  await page
    .getByRole('link', { name: /Clinical disposition for Sample Patient A/ })
    .first()
    .click();
  await expect(page.getByText('Record sample outcome')).toBeVisible();
  await page.getByRole('button', { name: 'Approve' }).click();
  const dialog = page.getByRole('dialog', { name: /Approve Clinical disposition/ });
  await expect(dialog).toContainText('Clinical disposition');
  await expect(dialog.getByText(/SAMPLE-001.*This cannot be undone/)).toBeVisible();
  await expect(dialog.getByRole('textbox')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await dialog.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByText(/You approved this/)).toBeVisible();
  await page.getByRole('link', { name: 'Back to Inbox' }).click();
  await expect(page.getByRole('link', { name: /Clinical disposition for Sample Patient A/ })).toHaveCount(0);
});

test('cancelling the approve confirm sends nothing', async ({ page }) => {
  let posts = 0;
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().includes('/decision')) posts++;
  });
  await detail(page);
  const pageApprove = page.locator('form').getByRole('button', { name: 'Approve' });
  await pageApprove.click();
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Cancel' })).toBeFocused();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await pageApprove.click();
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Cancel' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await pageApprove.click();
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Cancel' })).toBeFocused();
  await page.getByRole('dialog').click({ position: { x: 0, y: 0 } });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(posts).toBe(0);
  await expect(pageApprove).toBeVisible();
});

test('reject needs a comment and records it', async ({ page }) => {
  let posts = 0;
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().includes('/decision')) posts++;
  });
  await detail(page, 'approval-8');
  const reject = page.getByRole('button', { name: 'Reject' });
  await expect(reject).toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByText('Add a comment to reject or request changes')).toBeVisible();
  await reject.focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Space');
  expect(posts).toBe(0);
  await page.getByRole('textbox', { name: 'Comment (optional to approve)' }).fill('Sample rejection reason');
  await expect(reject).toHaveAttribute('aria-disabled', 'false');
  await reject.click();
  await expect(page.getByText(/You rejected this/)).toBeVisible();
  await expect(page.getByText('Sample rejection reason')).toBeVisible();
});

test('not-set-up Inbox explains approval access', async ({ page }) => {
  await page.route('**/api/work/inbox?**', (route) =>
    route.continue({ url: `${route.request().url()}&mock=not-set-up` }),
  );
  await page.goto('/dashboard/work');
  await expect(page.getByText('You are not set up to approve. Ask an admin.')).toBeVisible();
});

test('pending approval without access is View only', async ({ page }) => {
  await page.goto('/dashboard/work/approvals');
  const row = page.getByRole('link', { name: /Clinical disposition for Sample Patient E/ });
  await expect(row).toContainText('View only');
});

test('empty Inbox keeps each section quiet', async ({ page }) => {
  await page.route('**/api/work/inbox?**', (route) =>
    route.continue({ url: `${route.request().url()}&mock=empty` }),
  );
  await page.goto('/dashboard/work');
  await expect(page.getByText('Nothing needs you')).toBeVisible();
  await expect(page.getByText('Nothing waiting for your decision.')).toBeVisible();
  await expect(page.getByText('No blocked cases.')).toBeVisible();
  await expect(page.getByText('No cases assigned to you.')).toBeVisible();
});

test('decided approval shows who, when and comment', async ({ page }) => {
  await detail(page, 'approval-4');
  await expect(page.getByText(/Sample Decider A approved this/)).toBeVisible();
  await expect(page.getByText('Sample decision recorded.')).toBeVisible();
  await expect(page.getByRole('status').locator('time')).toHaveAttribute('datetime');
});

test('Cases shows the truncated sentence', async ({ page }) => {
  await page.route('**/api/work/cases?**', (route) =>
    route.continue({ url: `${route.request().url()}&mock=truncated` }),
  );
  await page.goto('/dashboard/work/cases');
  await expect(page.getByText('Showing the first 200. Narrow the filters to find others.')).toBeVisible();
});

test('request changes sends the comment', async ({ page }) => {
  await detail(page, 'approval-6');
  await page
    .getByRole('textbox', { name: 'Comment (optional to approve)' })
    .fill('Please update the sample.');
  await page.getByRole('button', { name: 'Request changes' }).click();
  await expect(page.getByText(/You requested changes to this/)).toBeVisible();
  await expect(page.getByText('Please update the sample.')).toBeVisible();
});

test('unverified payload cannot be decided', async ({ page }) => {
  await detail(page, 'approval-3');
  await expect(
    page.getByText('We cannot show what would be approved, so it cannot be decided.'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0);
});

test('permission state appears without work read', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('cce_capabilities', JSON.stringify(['overview:read'])));
  await page.goto('/dashboard/work');
  await expect(page.getByText(/Work access required/)).toBeVisible();
});

test('missions redirects when Work is enabled', async ({ page }) => {
  await page.goto('/dashboard/missions');
  await expect(page).toHaveURL(/\/dashboard\/work$/);
  await expect(page.getByRole('link', { name: 'Missions', exact: true })).toHaveCount(0);
});

test('missions stays when Work is disabled', async ({ page }) => {
  await page.route('**/api/work/status', (route) =>
    route.continue({ url: `${route.request().url()}?mock=disabled` }),
  );
  await page.goto('/dashboard/missions');
  await expect(page).toHaveURL(/\/dashboard\/missions$/);
  await expect(page.getByRole('link', { name: 'Missions', exact: true })).toBeVisible();
});

test('keyboard reaches approve and focus is visible', async ({ page }) => {
  await detail(page);
  const approve = page.getByRole('button', { name: 'Approve' });
  await page.getByRole('textbox', { name: 'Comment (optional to approve)' }).focus();
  await page.keyboard.press('Tab');
  await expect(approve).toBeFocused();
  expect(
    await approve.evaluate(
      (e) => getComputedStyle(e).outlineStyle !== 'none' || getComputedStyle(e).boxShadow !== 'none',
    ),
  ).toBe(true);
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Request changes' })).toBeFocused();
});

test('overflow is absent at 375, 768 and 1280', async ({ page }) => {
  for (const width of [375, 768, 1280]) {
    await page.setViewportSize({ width, height: 720 });
    for (const path of [
      '/work',
      '/work/cases',
      '/work/cases/case-1',
      '/work/approvals',
      '/work/approvals/approval-2',
    ]) {
      await page.goto(`/dashboard${path}`);
      await expect(page.getByRole('main').getByRole('heading', { level: 1 })).toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        `${path} at ${width}`,
      ).toBe(true);
    }
  }
});

test('toast and document title omit case title', async ({ page }) => {
  await detail(page, 'approval-7');
  const caseTitle = 'Sample Patient G intake';
  await page.getByRole('textbox', { name: 'Comment (optional to approve)' }).fill('Sample reason');
  await page.getByRole('button', { name: 'Reject' }).click();
  await expect(page.getByText('Rejected', { exact: true }).last()).toBeVisible();
  expect(await page.title()).not.toContain(caseTitle);
  expect(await page.locator('[aria-live="polite"]').first().innerText()).not.toContain(caseTitle);
});

test('403 permission error shows a sentence', async ({ page }) => {
  await page.route('**/api/work/cases?**', (route) =>
    route.continue({ url: `${route.request().url()}&mock=forbidden` }),
  );
  await page.goto('/dashboard/work/cases');
  await expect(page.getByText('You do not have access to this. Ask an admin.')).toBeVisible();
});

test('work engine error shows a sentence and retry', async ({ page }) => {
  await page.route('**/api/work/approvals?**', (route) =>
    route.continue({ url: `${route.request().url()}&mock=error:paperclip_unavailable` }),
  );
  await page.goto('/dashboard/work/approvals');
  await expect(
    page.getByText('The work engine is not available right now. Try again in a minute.'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
});
