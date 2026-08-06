// Playwright battle-test for the IAM copilot UI (Security Posture -> IAM).
// Drives the real prod dashboard with the admin token, exercises draft + two
// applies (one happy create-policy, one guardrail own-role block), screenshots
// every step, and prints a JSON result summary. Token via env CCE_TOKEN.
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';

const BASE = process.env.CCE_BASE ?? 'https://claudeclaw-enterprise.com';
const TOKEN = process.env.CCE_TOKEN;
// Account ID for the drafted-policy prompt; never a tracked literal.
const ACCOUNT_ID = process.env.AWS_ACCOUNT_ID ?? process.env.CCE_ACCOUNT_ID ?? '<account-id>';
const TS = Date.now();
const TEST_POLICY = `cce-copilot-pwtest-${TS}`;
const OWN_ROLE = 'CCE-Iam-TaskRole30FC0FBB-w26yzxb1YDor';
const results = [];
// fileURLToPath (not URL().pathname) so a repo path containing a space decodes
// correctly instead of leaving a literal "%20" and writing to a stray dir.
const dir = fileURLToPath(new URL('.', import.meta.url)).replace(/\/$/, '');

function rec(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1400, height: 1600 } });
const page = await ctx.newPage();
page.setDefaultTimeout(45000);

try {
  // ── Auth: inject the token then load the IAM tab ──────────────────
  await page.goto(`${BASE}/dashboard`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((t) => {
    localStorage.setItem('cce_token', t);
    localStorage.setItem('cce_onboarded', '1'); // skip the first-load onboarding modal
  }, TOKEN);
  await page.goto(`${BASE}/dashboard/security-posture`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'Security Posture' }).waitFor();
  await page.screenshot({ path: `${dir}/00-loaded.png`, fullPage: true });
  // Tabs use ARIA role="tab".
  await page.getByRole('tab', { name: 'IAM', exact: true }).click();
  await page.getByText('AI Policy Drafter').waitFor();
  await page.screenshot({ path: `${dir}/01-iam-tab.png`, fullPage: true });
  rec('IAM tab loads with AI Policy Drafter panel', true);

  // ── Test 1: draft a safe read-only policy ─────────────────────────
  await page.locator('textarea').first().fill(
    `Allow read-only access to objects in the S3 bucket claudeclaw-curated and reading items from the DynamoDB table claudeclaw-sessions in us-east-1 account ${ACCOUNT_ID}. Nothing else.`,
  );
  await page.getByRole('button', { name: 'Draft policy' }).click();
  await page.locator('pre').first().waitFor();
  await page.getByText('Access Analyzer').waitFor({ timeout: 45000 }).catch(() => {});
  const policyText = await page.locator('pre').first().innerText();
  const hasStatement = policyText.includes('"Statement"') && policyText.includes('"Version"');
  await page.screenshot({ path: `${dir}/02-draft.png`, fullPage: true });
  rec('Draft returns a valid policy (Statement + Version)', hasStatement, hasStatement ? '' : policyText.slice(0, 120));

  // ── Test 2: APPLY happy path — create a managed policy ────────────
  await page.locator('select').selectOption('create_policy');
  await page.getByPlaceholder('policy name').fill(TEST_POLICY);
  await page.locator('label', { hasText: 'I reviewed this' }).locator('input[type=checkbox]').check();
  await page.getByRole('button', { name: 'Apply to AWS' }).click();
  const createdToast = await page
    .getByText(/Created managed policy/i)
    .first()
    .waitFor({ timeout: 30000 })
    .then(() => true)
    .catch(() => false);
  await page.screenshot({ path: `${dir}/03-apply-create.png`, fullPage: true });
  rec('Apply: create managed policy succeeds', createdToast, TEST_POLICY);

  // ── Test 3: GUARDRAIL — block modifying the orchestrator's own role
  await page.locator('select').selectOption('put_role_policy');
  await page.getByPlaceholder('role name').fill(OWN_ROLE);
  await page.getByPlaceholder('policy name').fill('cce-pwtest-should-be-blocked');
  const cb = page.locator('label', { hasText: 'I reviewed this' }).locator('input[type=checkbox]');
  if (!(await cb.isChecked())) await cb.check();
  await page.getByRole('button', { name: 'Apply to AWS' }).click();
  const blockedToast = await page
    .getByText(/refusing to modify protected|protected principal/i)
    .first()
    .waitFor({ timeout: 30000 })
    .then(() => true)
    .catch(() => false);
  await page.screenshot({ path: `${dir}/04-guardrail-own-role.png`, fullPage: true });
  rec('Guardrail: own-role modification is blocked', blockedToast);
} catch (err) {
  rec('script', false, err instanceof Error ? err.message : String(err));
  await page.screenshot({ path: `${dir}/99-error.png`, fullPage: true }).catch(() => {});
} finally {
  await browser.close();
  const passed = results.filter((r) => r.pass).length;
  console.log(`\nSUMMARY: ${passed}/${results.length} passed`);
  console.log('TEST_POLICY=' + TEST_POLICY);
  process.exit(passed === results.length ? 0 : 1);
}
