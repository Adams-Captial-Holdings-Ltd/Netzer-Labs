import { test, expect, type Page } from '@playwright/test';

// P3 (step 5) — attachments as a person meets them, in a real browser against the
// chat mock (CCE_CHAT_MOCK=1, web/dev/mock-stream-plugin.ts). Written BEFORE the
// change, as the bar (netzar-chat-plan/p3-proof.sh rows E-1..E-8).
//
//   - UPL-01: nothing is dropped or refused in silence. A fourth file and a file
//     over 30 MB (owner decision 29) are named in an alert, and the big one is
//     refused BEFORE anything is uploaded.
//   - WI-3.4: a file uploads the moment it is attached, its chip shows a progress
//     bar until it has, and Send waits for it. Pasting or dropping a file attaches
//     it too (today only the paperclip does).
//   - UPL-04/05/06: a message's files are kept with it, so after a reload a
//     file-only message still shows its chips, and each chip downloads the file.
//   - Decision 3 + 54: each chip carries an "Add to knowledge" switch, OFF by
//     default, which says the shared copy stays if the chat is deleted; only the
//     file it was turned on for is sent opted in.
//
// The mock plays S3 as well: the upload link points back at this dev server, and
// it refuses a PUT whose Content-Type is not the one it signed, as S3 does.
// Identity is seeded exactly as chat.spec.ts does; see its comment for why that is
// not an authorization bypass.
const CAPS = ['overview:read', 'chat:read', 'agents:read', 'sessions:read'];
const MB = 1024 * 1024;

test.beforeEach(async ({ page }) => {
  await page.addInitScript((caps) => {
    localStorage.setItem('cce_token', 'local-dev-dashboard-token');
    localStorage.setItem('cce_onboarded', 'true');
    localStorage.setItem('cce_role', 'admin');
    localStorage.setItem('cce_capabilities', JSON.stringify(caps));
  }, CAPS);
});

const composerOf = (page: Page) => page.getByRole('textbox', { name: /^Message / });
const sendOf = (page: Page) => page.getByRole('button', { name: 'Send message' });
const chipsOf = (page: Page) => page.getByRole('list', { name: 'Attached files' }).getByRole('listitem');
const fileInputOf = (page: Page) => page.locator('input[type="file"]');
const text = (name: string, body = 'hello from a test', mimeType = 'text/plain') =>
  ({ name, mimeType, buffer: Buffer.from(body) });

/** Open the chat and start a fresh conversation, the way a person does (P56). */
async function newChat(page: Page) {
  await page.goto('/dashboard/chat');
  await expect(composerOf(page)).toBeVisible();
  await page.getByRole('button', { name: 'New chat' }).first().click();
}

/** Every chip has finished uploading. */
async function uploadsDone(page: Page) {
  await expect(page.getByRole('progressbar', { name: /^Uploading / })).toHaveCount(0);
}

/** Send, then wait for the product's own end-of-turn signal (P60). */
async function sendAndWait(page: Page) {
  await expect(sendOf(page)).toBeEnabled();
  await sendOf(page).click();
  await expect(page.getByRole('button', { name: 'Stop generating' })).toHaveCount(0, { timeout: 30_000 });
  await expect(sendOf(page)).toBeVisible();
}

test('says which file was left out when a fourth is picked', async ({ page }) => {
  await newChat(page);

  await fileInputOf(page).setInputFiles([text('one.txt'), text('two.txt'), text('three.txt'), text('four.txt')]);

  await expect(chipsOf(page)).toHaveCount(3);
  const alert = page.getByRole('alert');
  await expect(alert).toContainText('four.txt');
  await expect(alert).toContainText('3 files');
});

test('refuses a file over 30 MB before uploading it', async ({ page }) => {
  await newChat(page);
  const signed: string[] = [];
  page.on('request', (r) => { if (r.url().includes('/api/chat/uploads')) signed.push(r.url()); });

  await fileInputOf(page).setInputFiles({ name: 'huge.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(30 * MB + 1) });

  const alert = page.getByRole('alert');
  await expect(alert).toContainText('huge.pdf');
  await expect(alert).toContainText('30 MB');
  await expect(chipsOf(page)).toHaveCount(0);
  expect(signed).toEqual([]);
});

test('shows a progress bar on the chip until the upload finishes', async ({ page }) => {
  await newChat(page);
  await composerOf(page).fill('read this when it is up');

  // "slow" in the name makes the mock answer the PUT after 1.5 s.
  await fileInputOf(page).setInputFiles(text('slow-notes.txt'));

  await expect(page.getByRole('progressbar', { name: 'Uploading slow-notes.txt' })).toBeVisible({ timeout: 2_000 });
  // Send waits for the file.
  await expect(sendOf(page)).toBeDisabled({ timeout: 1_000 });
  await uploadsDone(page);
  await expect(sendOf(page)).toBeEnabled();
  await expect(chipsOf(page)).toHaveCount(1);
});

test('attaches a pasted file', async ({ page }) => {
  await newChat(page);
  await composerOf(page).focus();

  await page.evaluate(() => {
    const data = new DataTransfer();
    data.items.add(new File(['pasted words'], 'pasted.txt', { type: 'text/plain' }));
    document.activeElement!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });

  await expect(chipsOf(page)).toHaveCount(1);
  await expect(chipsOf(page).first()).toContainText('pasted.txt');
});

test('attaches a dropped file', async ({ page }) => {
  await newChat(page);
  const data = await page.evaluateHandle(() => {
    const d = new DataTransfer();
    d.items.add(new File(['a,b\n1,2'], 'dropped.csv', { type: 'text/csv' }));
    return d;
  });

  const form = composerOf(page).locator('xpath=ancestor::form');
  await form.dispatchEvent('dragenter', { dataTransfer: data });
  await form.dispatchEvent('dragover', { dataTransfer: data });
  await form.dispatchEvent('drop', { dataTransfer: data });

  await expect(chipsOf(page)).toHaveCount(1);
  await expect(chipsOf(page).first()).toContainText('dropped.csv');
});

test('shows a file-only message\'s chips after a reload', async ({ page }) => {
  await newChat(page);
  await fileInputOf(page).setInputFiles(text('plan.txt', 'the plan'));
  await uploadsDone(page);
  await sendAndWait(page);
  const sent = page.getByRole('group', { name: 'Your message' }).last();
  await expect(sent).toContainText('plan.txt');

  await page.reload();

  const reloaded = page.getByRole('group', { name: 'Your message' });
  await expect(reloaded).toHaveCount(1);
  await expect(reloaded.first()).toContainText('plan.txt');
  await expect(reloaded.first().getByRole('button', { name: 'Download plan.txt' })).toBeVisible();
});

test('downloads a sent file from its chip', async ({ page }) => {
  await newChat(page);
  await fileInputOf(page).setInputFiles(text('minutes.txt', 'the minutes'));
  await uploadsDone(page);
  await composerOf(page).fill('keep this');
  await sendAndWait(page);
  await page.reload();

  const download = page.waitForEvent('download');
  await page.getByRole('group', { name: 'Your message' }).first()
    .getByRole('button', { name: 'Download minutes.txt' }).click();

  expect((await download).suggestedFilename()).toBe('minutes.txt');
});

test('sends the knowledge opt-in only for the file it was turned on for', async ({ page }) => {
  await newChat(page);
  await fileInputOf(page).setInputFiles([text('share.txt'), text('private.txt')]);
  await uploadsDone(page);

  const share = page.getByRole('checkbox', { name: 'Add share.txt to knowledge' });
  const keep = page.getByRole('checkbox', { name: 'Add private.txt to knowledge' });
  // Off by default (decision 3), and it says the shared copy outlives the chat (decision 54).
  await expect(share).not.toBeChecked();
  await expect(keep).not.toBeChecked();
  await expect(share).toHaveAccessibleDescription(/stays if you delete this chat/i);
  await share.check();

  await composerOf(page).fill('two files');
  const request = page.waitForRequest((r) => r.url().includes('/api/test-turn/stream') && r.method() === 'POST');
  await sendOf(page).click();
  const body = (await request).postDataJSON() as { attachments: Array<{ fileName: string; addToKnowledge?: boolean }> };

  expect(body.attachments.map((a) => [a.fileName, a.addToKnowledge === true])).toEqual([
    ['share.txt', true],
    ['private.txt', false],
  ]);
});

test('shows on screen what adding a file to knowledge means', async ({ page }) => {
  // Review finding (coordinator C10, council 3-0): the sentence was screen-reader-only, so a
  // sighted reader ticked a shared, chat-outliving copy (decisions 3 and 54) without seeing it.
  await newChat(page);
  await fileInputOf(page).setInputFiles([text('share.txt')]);
  await uploadsDone(page);

  const note = chipsOf(page).first().getByText(/stays if you delete this chat/i);
  await expect(note).toBeVisible();
  // A screen-reader-only element is 1x1 pixel and still counts as "visible": measure it.
  const box = await note.boundingBox();
  expect(box!.width).toBeGreaterThan(20);
  expect(box!.height).toBeGreaterThan(5);
});
