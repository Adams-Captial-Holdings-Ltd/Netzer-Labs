import { test, expect, type Page } from '@playwright/test';

const CAPS = ['overview:read', 'work:read', 'work:approve', 'missions:read'];
const COMMENT = 'Comment';
// Mock switches ride on the request: `mock=empty`, `mock=empty-not-set-up`, `mock=not-set-up`,
// `mock=truncated`, `mock=decide:<code>` and `mock=slow` (a delayed decision reply).
const withMock = (url: string, mock: string) => `${url}${url.includes('?') ? '&' : '?'}mock=${mock}`;
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
  await expect(page.getByText('You approved this. It will go ahead.')).toBeVisible();
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
  await expect(page.getByText('Optional to approve. Needed to reject or request changes.')).toBeVisible();
  await reject.focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Space');
  expect(posts).toBe(0);
  await page.getByRole('textbox', { name: COMMENT }).fill('Sample rejection reason');
  await expect(reject).toHaveAttribute('aria-disabled', 'false');
  await reject.click();
  await expect(page.getByText('You rejected this. It will not happen.')).toBeVisible();
  await expect(page.getByText('Sample rejection reason')).toBeVisible();
});

test('not-set-up Inbox explains approval access', async ({ page }) => {
  await page.route('**/api/work/inbox?**', (route) =>
    route.continue({ url: `${route.request().url()}&mock=not-set-up` }),
  );
  await page.goto('/dashboard/work');
  await expect(page.getByText('You are not set up to approve. Ask an admin.')).toBeVisible();
});

test('pending approval without access says it waits on someone else', async ({ page }) => {
  await page.goto('/dashboard/work/approvals');
  const row = page.getByRole('link', { name: /Payment release for Invoice INV-1005 from Sample Vendor E/ });
  await expect(row).toContainText('Waiting on someone else');
  await expect(row).not.toContainText('View only');
});

test('empty Inbox says only Nothing needs you', async ({ page }) => {
  await page.route('**/api/work/inbox?**', (route) => route.continue({ url: withMock(route.request().url(), 'empty') }));
  await page.goto('/dashboard/work');
  await expect(page.getByText('Nothing needs you')).toBeVisible();
  await expect(page.getByText('You are not set up to approve. Ask an admin.')).toHaveCount(0);
  await expect(page.getByText('Nothing waiting for your decision.')).toHaveCount(0);
  await expect(page.getByText('No blocked cases.')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Waiting for your decision' })).toHaveCount(0);
});

test('empty Inbox that is not set up never says Nothing needs you', async ({ page }) => {
  await page.route('**/api/work/inbox?**', (route) =>
    route.continue({ url: withMock(route.request().url(), 'empty-not-set-up') }),
  );
  await page.goto('/dashboard/work');
  await expect(page.getByText('You are not set up to approve. Ask an admin.')).toBeVisible();
  await expect(page.getByText('Nothing needs you')).toHaveCount(0);
});

test('decided approval shows who, when and comment', async ({ page }) => {
  await detail(page, 'approval-4');
  await expect(page.getByText(/approver.a@example.test approved this/)).toBeVisible();
  await expect(page.getByText('Sample decision recorded.')).toBeVisible();
  const decision = page.getByRole('region', { name: 'Decision' });
  await expect(decision).toContainText('It will go ahead.');
  await expect(decision.locator('time').first()).toHaveAttribute('datetime');
  await expect(decision.getByText(COMMENT, { exact: true })).toBeVisible();
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
    .getByRole('textbox', { name: COMMENT })
    .fill('Please check the invoice coding.');
  await page.getByRole('button', { name: 'Request changes' }).click();
  await expect(page.getByText('You asked for changes. It goes back to be revised.')).toBeVisible();
  await expect(page.getByText('Please check the invoice coding.')).toBeVisible();
});

test('unverified payload cannot be decided', async ({ page }) => {
  await detail(page, 'approval-3');
  await expect(
    page.getByText('We cannot show what would be approved, so it cannot be decided.'),
  ).toBeVisible();
  await expect(page.getByText('Tell your admin. Nothing will happen until this is fixed.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: /If you approve|What was/ })).toHaveCount(0);
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
  await page.getByRole('textbox', { name: COMMENT }).focus();
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
  await page.getByRole('textbox', { name: COMMENT }).fill('Sample reason');
  await page.getByRole('button', { name: 'Reject' }).click();
  await expect(page.getByRole('region', { name: 'Decision' })).toContainText('You rejected this');
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
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByRole('status').getByText('Loading')).toBeVisible();
    release();
    await expect(page.getByText('This could not be found. It may have been removed.')).toBeVisible();
    await expect(page.getByRole('heading', { name: kind === 'cases' ? 'Case not found' : 'Approval not found' })).toBeVisible();
    await expect(page.getByRole('link', { name: kind === 'cases' ? 'Back to Cases' : 'Back to Approvals' })).toBeVisible();
    await page.unroute(`**/api/work/${kind}/missing?**`);
  }
});

test('Cases filters change the URL and rows', async ({ page }) => {
  await page.goto('/dashboard/work/cases');
  await expect(page.getByRole('link', { name: /Invoice INV-1001/ })).toBeVisible();
  const stage = page.getByRole('button', { name: 'Stage', exact: true });
  await expect(stage).toBeDisabled();
  await expect(stage).toContainText('Choose a pipeline first');
  await page.getByRole('button', { name: 'Pipeline', exact: true }).click();
  await page.getByRole('option', { name: 'Vendor invoices' }).click();
  await expect(page).toHaveURL(/pipeline=pipeline-vendor-invoices/);
  await stage.click();
  await page.getByRole('option', { name: 'Coding' }).click();
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
    await page.getByRole('textbox', { name: COMMENT }).fill('Keep this comment');
    await page.getByRole('button', { name: 'Reject' }).click();
    await expect(page.getByText(failure.sentence)).toBeVisible();
    await expect(page.getByRole('textbox', { name: COMMENT })).toHaveValue('Keep this comment');
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
    await page.getByRole('textbox', { name: COMMENT }).fill('Keep this comment');
    await page.getByRole('button', { name: 'Reject' }).click();
    await expect(page.getByText('We could not confirm the decision was recorded. Reload to check.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Check again' })).toBeVisible();
    await expect.poll(() => reads).toBeGreaterThan(1);
    await expect(page.getByRole('textbox', { name: COMMENT })).toHaveValue('Keep this comment');
    await expect(page.getByText('Nothing was decided by you here')).toHaveCount(0);
  });
}

test('empty decision comment focuses the box, turns the helper red and moves nothing', async ({ page }) => {
  let posts = 0;
  page.on('request', request => {
    if (request.method() === 'POST' && request.url().includes('/decision')) posts++;
  });
  await detail(page, 'approval-8');
  const comment = page.getByRole('textbox', { name: COMMENT });
  const hint = page.locator('#comment-hint');
  const requestChanges = page.getByRole('button', { name: 'Request changes' });
  await expect(hint).not.toHaveClass(/text-danger-text/);
  await expect(comment).not.toHaveAttribute('aria-invalid', 'true');
  const before = await requestChanges.boundingBox();
  await requestChanges.focus();
  await page.keyboard.press('Enter');
  await expect(comment).toBeFocused();
  await expect(comment).toHaveAttribute('aria-describedby', 'comment-hint');
  await expect(comment).toHaveAttribute('aria-invalid', 'true');
  await expect(hint).toHaveClass(/text-danger-text/);
  await expect(hint).toHaveText('Optional to approve. Needed to reject or request changes.');
  expect(await requestChanges.boundingBox()).toEqual(before);
  await comment.fill('A reason');
  await expect(comment).not.toHaveAttribute('aria-invalid', 'true');
  expect(posts).toBe(0);
});

test('a comment over 4 000 characters is marked invalid with the too-long sentence', async ({ page }) => {
  await detail(page, 'approval-8');
  const comment = page.getByRole('textbox', { name: COMMENT });
  await comment.fill('x'.repeat(4001));
  await expect(comment).toHaveAttribute('aria-invalid', 'true');
  const hint = page.locator('#comment-hint');
  await expect(hint).toHaveText('The comment is too long (4 000 characters at most).');
  await expect(hint).toHaveClass(/text-danger-text/);
  await expect(page.getByRole('button', { name: 'Approve' })).toHaveAttribute('aria-disabled', 'true');
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

for (const outcome of [
  { id: 'approval-6', decision: 'Reject', sentence: 'You rejected this. It will not happen.' },
  { id: 'approval-7', decision: 'Request changes', sentence: 'You asked for changes. It goes back to be revised.' },
  { id: 'approval-8', decision: 'Approve', sentence: 'You approved this. It will go ahead.' },
]) {
  test(`${outcome.decision} says what happens next`, async ({ page }) => {
    await detail(page, outcome.id);
    if (outcome.decision !== 'Approve') await page.getByRole('textbox', { name: COMMENT }).fill('Sample reason');
    await page.locator('form').getByRole('button', { name: outcome.decision, exact: true }).click();
    if (outcome.decision === 'Approve') await page.getByRole('dialog').getByRole('button', { name: 'Approve' }).click();
    const decision = page.getByRole('region', { name: 'Decision' });
    await expect(decision.getByText(outcome.sentence)).toBeVisible();
    await expect(decision).toBeFocused();
    await expect(page.getByRole('heading', { name: 'What was approved' }).or(page.getByRole('heading', { name: 'What was proposed' }))).toBeVisible();
  });
}

test('the decide form explains each decision and the payload heading follows the status', async ({ page }) => {
  await detail(page, 'approval-1');
  await expect(page.getByRole('heading', { name: 'If you approve, this will be done' })).toBeVisible();
  await expect(
    page.getByText('Approve: it goes ahead. Request changes: it goes back to be revised. Reject: it will not happen.'),
  ).toBeVisible();
  await expect(page.getByText('A fingerprint of exactly what is shown above, kept for audit.')).toBeVisible();
  await expect(page.locator('details')).toHaveCount(0);
  await detail(page, 'approval-4');
  await expect(page.getByRole('heading', { name: 'What was approved' })).toBeVisible();
  await detail(page, 'approval-15');
  await expect(page.getByRole('heading', { name: 'What was proposed' })).toBeVisible();
  await expect(page.getByText(/Requested .* ago/)).toBeVisible();
});

test('Check again reads the approval again and keeps the typed comment', async ({ page }) => {
  let reads = 0;
  await page.route('**/api/work/approvals/approval-8?**', async route => { reads++; await route.continue(); });
  await page.route('**/api/work/approvals/approval-8/decision', route =>
    route.continue({ url: withMock(route.request().url(), 'decide:decision_outcome_unknown') }));
  await detail(page, 'approval-8');
  await page.getByRole('textbox', { name: COMMENT }).fill('Keep this comment');
  await page.getByRole('button', { name: 'Reject' }).click();
  const check = page.getByRole('button', { name: 'Check again' });
  await expect(check).toBeVisible();
  await expect.poll(() => reads).toBeGreaterThan(1);
  await expect(page.getByRole('button', { name: 'Reject' })).toHaveAttribute('aria-disabled', 'false');
  const before = reads;
  await check.click();
  await expect.poll(() => reads).toBeGreaterThan(before);
  await expect(page.getByText('Checked. Nothing was recorded and this is still waiting for a decision.')).toBeVisible();
  await expect(check).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: COMMENT })).toHaveValue('Keep this comment');
});

test('a refused decision from the mock shows its sentence', async ({ page }) => {
  await page.route('**/api/work/approvals/approval-8/decision', route =>
    route.continue({ url: withMock(route.request().url(), 'decide:not_pending') }));
  await detail(page, 'approval-8');
  await page.getByRole('textbox', { name: COMMENT }).fill('Sample reason');
  await page.getByRole('button', { name: 'Reject' }).click();
  await expect(page.getByText('This has already been decided.')).toBeVisible();
});

test('the confirm buttons are 44 px tall and 24 px apart at 375', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await detail(page);
  await page.locator('form').getByRole('button', { name: 'Approve' }).click();
  const dialog = page.getByRole('dialog');
  const approve = await dialog.getByRole('button', { name: 'Approve' }).boundingBox();
  const cancel = await dialog.getByRole('button', { name: 'Cancel' }).boundingBox();
  expect(approve!.height).toBeGreaterThanOrEqual(44);
  expect(cancel!.height).toBeGreaterThanOrEqual(44);
  // Stacked: Approve above Cancel, each full width.
  expect(cancel!.y - (approve!.y + approve!.height)).toBeGreaterThanOrEqual(24);
  expect(approve!.width).toBeGreaterThan(250);
  const scrim = await dialog.evaluate((e) => getComputedStyle(e).backdropFilter);
  expect(scrim).toBe('none');
  expect(await dialog.getByText('INV-1001').evaluate((e) => getComputedStyle(e).fontFamily)).toMatch(/mono/i);
});

test('the payload is a keyboard region at 1280 and uncapped at 375', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await detail(page, 'approval-18');
  const region = page.getByRole('region', { name: 'Approval content' });
  await region.focus();
  await expect(region).toBeFocused();
  const capped = await region.evaluate((e) => ({ box: e.clientHeight, content: e.scrollHeight }));
  expect(capped.box).toBeLessThanOrEqual(480);
  expect(capped.content).toBeGreaterThan(capped.box);
  await page.setViewportSize({ width: 375, height: 800 });
  const open = await region.evaluate((e) => ({ box: e.clientHeight, content: e.scrollHeight }));
  expect(open.box).toBeGreaterThan(480);
  expect(open.content).toBeLessThanOrEqual(open.box);
});

test('a title is never truncated while its metadata is whole at 768', async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 900 });
  for (const path of ['/work/cases', '/work/approvals']) {
    await page.goto(`/dashboard${path}`);
    const rows = page.getByRole('main').getByRole('listitem');
    await expect(rows.first()).toBeVisible();
    for (const row of await rows.all()) {
      const title = await row.locator('[data-work="title"]').evaluate((e) => e.scrollHeight <= e.clientHeight + 1);
      const meta = await row.locator('[data-work="meta"]').evaluate((e) => e.scrollWidth <= e.clientWidth + 1);
      expect(title && meta, `${path} row`).toBe(true);
    }
  }
});

test('the Cases list shows 10 rows at 1280 by 720 and aligns its columns', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/dashboard/work/cases');
  const rows = page.getByRole('main').getByRole('listitem');
  await expect(rows.first()).toBeVisible();
  let visible = 0;
  for (const row of await rows.all()) {
    const box = await row.boundingBox();
    if (box && box.y + box.height <= 720) visible++;
  }
  expect(visible).toBeGreaterThanOrEqual(10);
  const lefts = await rows.evaluateAll((items) =>
    items.slice(0, 5).map((li) => Math.round(li.querySelector('[data-work="meta"] > span')!.getBoundingClientRect().left)),
  );
  expect(new Set(lefts).size).toBe(1);
});

test('the filters are 44 px tall with 16 px text at 375', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto('/dashboard/work/cases');
  const pipeline = page.getByRole('button', { name: 'Pipeline', exact: true });
  await expect(pipeline).toBeVisible();
  const box = await pipeline.boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(44);
  expect(await pipeline.evaluate((e) => getComputedStyle(e).fontSize)).toBe('16px');
});

test('the sending state shows on the one button, announces and keeps the Tab order', async ({ page }) => {
  await page.route('**/api/work/approvals/approval-8/decision', route =>
    route.continue({ url: withMock(route.request().url(), 'slow') }));
  await detail(page, 'approval-8');
  await page.getByRole('textbox', { name: COMMENT }).fill('Sample reason');
  const reject = page.getByRole('button', { name: 'Reject' });
  const approve = page.getByRole('button', { name: 'Approve' });
  const changes = page.getByRole('button', { name: 'Request changes' });
  await reject.click();
  await expect(page.getByRole('status').filter({ hasText: 'Sending' })).toHaveCount(1);
  for (const button of [approve, changes, reject]) {
    await expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(await button.evaluate((e) => (e as HTMLButtonElement).disabled)).toBe(false);
  }
  await expect(reject.locator('svg.animate-spin')).toHaveCount(1);
  await expect(approve.locator('svg.animate-spin')).toHaveCount(0);
  await expect(changes.locator('svg.animate-spin')).toHaveCount(0);
  await expect(page.getByText('Sending your decision.')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Decision' })).toContainText('You rejected this', { timeout: 15_000 });
});

test('Approve through the confirm moves focus to the status region while sending', async ({ page }) => {
  await page.route('**/api/work/approvals/approval-8/decision', route =>
    route.continue({ url: withMock(route.request().url(), 'slow') }));
  await detail(page, 'approval-8');
  await page.locator('form').getByRole('button', { name: 'Approve' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Approve' }).click();
  const status = page.getByRole('status').filter({ hasText: 'Sending' });
  await expect(status).toBeFocused();
  await expect(page.locator('form').getByRole('button', { name: 'Approve' }).locator('svg.animate-spin')).toHaveCount(1);
  await expect(page.getByRole('region', { name: 'Decision' })).toContainText('You approved this', { timeout: 15_000 });
});

test('the confirm pulls focus back when it leaves the dialog', async ({ page }) => {
  await detail(page);
  await page.locator('form').getByRole('button', { name: 'Approve' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await page.evaluate(() => (document.getElementById('work-comment') as HTMLElement).focus());
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
});

test('a waiting approval with no reason says the person is not set up to decide it', async ({ page }) => {
  await detail(page, 'approval-17');
  await expect(page.getByText('You are not set up to decide this one. Ask an admin.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0);
});

test('a blocked case page reads in order and puts the facts on the right at 1280', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto('/dashboard/work/cases/case-6');
  await expect(page.getByText('Waiting for invoice coding')).toBeVisible();
  const order = await page.getByRole('main').getByRole('heading', { level: 2 }).allTextContents();
  expect(order).toEqual(['Blockers', 'Approvals', 'Timeline', 'Facts']);
  await page.setViewportSize({ width: 1280, height: 800 });
  const facts = await page.getByRole('heading', { name: 'Facts' }).boundingBox();
  const blockers = await page.getByRole('heading', { name: 'Blockers' }).boundingBox();
  expect(facts!.x).toBeGreaterThan(blockers!.x + 300);
  expect(Math.abs(facts!.y - blockers!.y)).toBeLessThan(300);
});

test('Inbox rows say how long and do not repeat the section status', async ({ page }) => {
  await page.goto('/dashboard/work');
  const row = page.getByRole('link', { name: /Payment release for Invoice INV-1001 from Sample Vendor A/ });
  await expect(row).toContainText(/Waiting \d+ days?/);
  await expect(row).not.toContainText(/Waiting\s*Waiting/);
  await expect(page.getByRole('heading', { name: 'Blocked cases' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Cases assigned to you' })).toBeVisible();
  await expect(page.getByText('Blocked at Coding').or(page.getByText('Blocked at Payment approval'))).toBeVisible();
});

test('the page titles explain themselves and the breadcrumb never shows a raw id', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  for (const [path, title, subtitle] of [
    ['/work', 'Work Inbox', 'What is waiting for you.'],
    ['/work/cases', 'Cases', 'Each case is one piece of work an agent is handling, such as an invoice.'],
    ['/work/approvals', 'Approvals', "Actions an agent has prepared that need a person's yes or no before they happen."],
  ]) {
    await page.goto(`/dashboard${path}`);
    await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
    await expect(page.getByText(subtitle)).toBeVisible();
  }
  await page.goto('/dashboard/work/approvals/approval-1');
  const crumbs = page.getByRole('navigation', { name: 'Breadcrumb' });
  await expect(crumbs).toContainText('Work');
  await expect(crumbs).toContainText('Approvals');
  await expect(crumbs).toContainText('Approval');
  await expect(crumbs).not.toContainText('approval-1');
});

test('the Work navigation uses the same icon size as the other items and the brand is not an h1', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/dashboard/work');
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  const sizes = await page.getByRole('navigation', { name: 'Main' }).locator('a svg').evaluateAll((svgs) =>
    svgs.map((s) => Math.round(s.getBoundingClientRect().width)),
  );
  expect(new Set(sizes).size).toBe(1);
});
