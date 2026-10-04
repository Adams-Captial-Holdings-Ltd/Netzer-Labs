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
  await expect(page.getByRole('heading', { name: /Payment release for/ })).toBeVisible();
}

test('approve through confirm shows result and leaves Inbox', async ({ page }) => {
  await page.goto('/dashboard/work');
  await expect(page.getByRole('heading', { name: 'Waiting for your decision' })).toBeVisible();
  await page
    .getByRole('link', { name: /Payment release for Invoice INV-1001 from Sample Vendor A/ })
    .first()
    .click();
  await expect(page.getByText('Release payment')).toBeVisible();
  await page.getByRole('button', { name: 'Approve' }).click();
  const dialog = page.getByRole('dialog', { name: /Approve Payment release/ });
  await expect(dialog).toContainText('Payment release');
  await expect(dialog.getByText(/INV-1001.*This cannot be undone/)).toBeVisible();
  await expect(dialog.getByRole('textbox')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await dialog.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByText(/You approved this/)).toBeVisible();
  await page.getByRole('link', { name: 'Back to Inbox' }).click();
  await expect(page.getByRole('heading', { name: 'Waiting for your decision' })).toBeVisible();
  await expect(page.getByRole('link', { name: /Payment release for Invoice INV-1001 from Sample Vendor A/ })).toHaveCount(0);
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
  await expect(pageApprove).toBeVisible();
  await page.waitForTimeout(100);
  expect(posts).toBe(0);
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
  const row = page.getByRole('link', { name: /Payment release for Invoice INV-1005 from Sample Vendor E/ });
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
  await expect(page.getByText(/approver.a@example.test approved this/)).toBeVisible();
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
    .fill('Please check the invoice coding.');
  await page.getByRole('button', { name: 'Request changes' }).click();
  await expect(page.getByText(/You requested changes to this/)).toBeVisible();
  await expect(page.getByText('Please check the invoice coding.')).toBeVisible();
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
  await page.route('**/api/work/status?**', (route) =>
    route.continue({ url: `${route.request().url()}&mock=disabled` }),
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
      if (path === '/work' || path === '/work/cases' || path === '/work/approvals') {
        await expect(page.getByRole('main').getByRole('link').first()).toBeVisible();
      } else {
        await expect(page.getByRole('heading', { level: 2 }).first()).toBeVisible();
      }
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        `${path} at ${width}`,
      ).toBe(true);
    }
  }
});

test('toast and document title omit case title', async ({ page }) => {
  await detail(page, 'approval-7');
  const caseTitle = 'Invoice INV-1007 from Sample Vendor G';
  await page.getByRole('textbox', { name: 'Comment (optional to approve)' }).fill('Sample reason');
  await page.getByRole('button', { name: 'Reject' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'You rejected this' })).toBeVisible();
  await expect(page.locator('[aria-live="polite"]').getByText('Rejected', { exact: true })).toBeVisible();
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


test('a viewer keeps Missions with Work enabled', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('cce_role', 'viewer');
    localStorage.setItem('cce_capabilities', JSON.stringify(['overview:read', 'missions:read']));
  });
  await page.goto('/dashboard/missions');
  await expect(page).toHaveURL(/\/dashboard\/missions$/);
  await expect(page.getByRole('link', { name: 'Missions', exact: true })).toBeVisible();
});

test('a failed Work status check keeps the Work error and retry', async ({ page }) => {
  await page.route('**/api/work/status?**', route => route.fulfill({ status: 503, body: '{"error":"unavailable"}' }));
  await page.goto('/dashboard/work');
  await expect(page.getByText('Could not check Work availability. Try again.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
});

test('Case and approval detail show loading then not found', async ({ page }) => {
  for (const kind of ['cases', 'approvals']) {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    await page.route(`**/api/work/${kind}/missing?**`, async route => {
      await held;
      await route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"not_found"}' });
    });
    await page.goto(`/dashboard/work/${kind}/missing`);
    await expect(page.getByRole('status').getByText('Loading')).toBeVisible();
    release();
    await expect(page.getByText('This could not be found. It may have been removed.')).toBeVisible();
    await page.unroute(`**/api/work/${kind}/missing?**`);
  }
});

test('Cases filters change the URL and rows', async ({ page }) => {
  await page.goto('/dashboard/work/cases');
  await expect(page.getByRole('link', { name: /Invoice INV-1001/ })).toBeVisible();
  await page.getByRole('combobox', { name: 'Pipeline' }).selectOption('pipeline-vendor-invoices');
  await expect(page).toHaveURL(/pipeline=pipeline-vendor-invoices/);
  await page.getByRole('combobox', { name: 'Stage' }).selectOption('coding');
  await expect(page).toHaveURL(/stage=coding/);
  await expect(page.getByRole('link', { name: /Invoice INV-1001/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /Invoice INV-1002/ })).toHaveCount(0);
});

test('cancelled approval says cancelled', async ({ page }) => {
  await detail(page, 'approval-16');
  await expect(page.getByText('This approval was cancelled')).toBeVisible();
});

for (const failure of [
  { code: 'stale_payload', sentence: 'This changed after you opened it. Review the new version before deciding.' },
  { code: 'attribution_mismatch', sentence: 'Your decision may have been recorded, but we could not confirm it under your name. Do not decide again. Contact your admin.' },
  { code: 'no_user_session', sentence: 'Sign in with your own account to decide.' },
]) {
  test(`decision ${failure.code} keeps the comment and shows the right sentence`, async ({ page }) => {
    let reads = 0;
    await page.route('**/api/work/approvals/approval-8?**', async route => { reads++; await route.continue(); });
    await page.route('**/api/work/approvals/approval-8/decision', route =>
      route.fulfill({ status: failure.code === 'attribution_mismatch' ? 500 :
        failure.code === 'no_user_session' ? 403 : 409,
      contentType: 'application/json', body: JSON.stringify({ error: failure.code }) }));
    await detail(page, 'approval-8');
    await page.getByRole('textbox', { name: 'Comment (optional to approve)' }).fill('Keep this comment');
    await page.getByRole('button', { name: 'Reject' }).click();
    await expect(page.getByText(failure.sentence)).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Comment (optional to approve)' })).toHaveValue('Keep this comment');
    if (failure.code !== 'no_user_session') await expect.poll(() => reads).toBeGreaterThan(1);
    await expect(page.getByText('Nothing was decided by you here')).toHaveCount(0);
  });
}

for (const failure of ['gateway', 'abort']) {
  test(`decision ${failure} has an unknown outcome`, async ({ page }) => {
    let reads = 0;
    await page.route('**/api/work/approvals/approval-8?**', async route => { reads++; await route.continue(); });
    await page.route('**/api/work/approvals/approval-8/decision', route =>
      failure === 'abort' ? route.abort() : route.fulfill({ status: 504, body: 'Gateway timeout' }));
    await detail(page, 'approval-8');
    await page.getByRole('textbox', { name: 'Comment (optional to approve)' }).fill('Keep this comment');
    await page.getByRole('button', { name: 'Reject' }).click();
    await expect(page.getByText('We could not confirm the decision was recorded. Reload to check.')).toBeVisible();
    await expect.poll(() => reads).toBeGreaterThan(1);
    await expect(page.getByRole('textbox', { name: 'Comment (optional to approve)' })).toHaveValue('Keep this comment');
    await expect(page.getByText('Nothing was decided by you here')).toHaveCount(0);
  });
}

test('empty decision comment focuses its hint and sends no POST', async ({ page }) => {
  let posts = 0;
  page.on('request', request => {
    if (request.method() === 'POST' && request.url().includes('/decision')) posts++;
  });
  await detail(page, 'approval-8');
  const comment = page.getByRole('textbox', { name: 'Comment (optional to approve)' });
  const requestChanges = page.getByRole('button', { name: 'Request changes' });
  await requestChanges.focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Space');
  await expect(comment).toBeFocused();
  await expect(comment).toHaveAttribute('aria-describedby', 'comment-hint');
  await expect(page.getByText('Add a comment to reject or request changes')).toBeVisible();
  expect(posts).toBe(0);
});

test('approve dialog traps Tab in both directions', async ({ page }) => {
  await detail(page);
  await page.getByRole('button', { name: 'Approve' }).click();
  const dialog = page.getByRole('dialog');
  const cancel = dialog.getByRole('button', { name: 'Cancel' });
  const approve = dialog.getByRole('button', { name: 'Approve' });
  await expect(cancel).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(approve).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(cancel).toBeFocused();
});
