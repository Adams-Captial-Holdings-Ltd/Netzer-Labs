// Playwright end-to-end test for the Cost dashboard (/dashboard/cost).
// Verifies the page renders live Cost Explorer data (cross-checked against the
// API), the AI TLDR bar, by-service breakdown, cost risks, the admin cards, and
// the safe "Run check now" evaluator action. Does NOT mutate the cost cap /
// budget (that propagation is verified separately with restore). Token via
// env CCE_TOKEN; base via CCE_BASE.
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';

const BASE = process.env.CCE_BASE ?? 'https://claudeclaw-enterprise.com';
const TOKEN = process.env.CCE_TOKEN;
const dir = fileURLToPath(new URL('.', import.meta.url)).replace(/\/$/, '');
const results = [];
function rec(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}
const usd = (n) => '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1400, height: 1800 } });
const page = await ctx.newPage();
page.setDefaultTimeout(45000);

try {
  // Pull the API truth first so we can cross-check the rendered numbers.
  const sumResp = await page.request.get(`${BASE}/api/cost/summary`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  const summary = await sumResp.json();
  const mtdStr = usd(summary.monthToDateUsd);
  const lastStr = usd(summary.lastMonthUsd);

  await page.goto(`${BASE}/dashboard`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((t) => {
    localStorage.setItem('cce_token', t);
    localStorage.setItem('cce_onboarded', '1');
  }, TOKEN);
  await page.goto(`${BASE}/dashboard/cost`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'Cost & Spend' }).waitFor();
  rec('Cost page loads', true);

  // Stats reflect the live API (proves real data is wired, not stubbed).
  const mtdSeen = await page.getByText(mtdStr, { exact: false }).first().waitFor({ timeout: 45000 }).then(() => true).catch(() => false);
  rec('Month-to-date matches API', mtdSeen, `${mtdStr} (available=${summary.available})`);
  const lastSeen = await page.getByText(lastStr, { exact: false }).first().isVisible().catch(() => false);
  rec('Last-month value rendered', lastSeen, lastStr);
  await page.screenshot({ path: `${dir}/01-cost-top.png`, fullPage: true });

  // AI TLDR bar (renders only when a summary came back).
  const tldr = await page.getByText('TLDR', { exact: false }).first().waitFor({ timeout: 45000 }).then(() => true).catch(() => false);
  rec('AI TLDR bar present', tldr);

  // By-service breakdown + cost risks sections.
  rec('By-service breakdown renders', await page.getByText('Where the money goes').isVisible().catch(() => false));
  rec('Cost risks section renders', await page.getByRole('heading', { name: 'Cost risks' }).isVisible().catch(() => false));

  // Admin cards.
  rec('Spending cap card present (admin)', await page.getByRole('heading', { name: 'Spending cap' }).isVisible().catch(() => false));
  rec('Proactive alerts card present (admin)', await page.getByRole('heading', { name: 'Proactive alerts' }).isVisible().catch(() => false));

  // Safe admin action: Run check now -> evaluator runs, toast appears.
  await page.getByRole('button', { name: 'Run check now' }).click();
  const toast = await page.getByText(/Checked|Alert sent|recoverable|budget/i).first().waitFor({ timeout: 30000 }).then(() => true).catch(() => false);
  rec('Run check now triggers evaluator (toast)', toast);
  await page.screenshot({ path: `${dir}/02-after-runcheck.png`, fullPage: true });
} catch (err) {
  rec('script', false, err instanceof Error ? err.message : String(err));
  await page.screenshot({ path: `${dir}/99-error.png`, fullPage: true }).catch(() => {});
} finally {
  await browser.close();
  const passed = results.filter((r) => r.pass).length;
  console.log(`\nSUMMARY: ${passed}/${results.length} passed`);
  process.exit(passed === results.length ? 0 : 1);
}
