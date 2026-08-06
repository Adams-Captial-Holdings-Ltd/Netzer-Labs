// Verifies the stale-while-revalidate cache makes tab revisits instant.
// The /kill-switches mock is deliberately SLOW (600ms). First load must wait
// for it (skeleton); an in-SPA revisit within the cache TTL must render from
// cache far faster (no skeleton wait). Drives the local Vite dev server.
import { chromium } from 'playwright';

const BASE = process.env.CCE_BASE ?? 'http://127.0.0.1:5180/dashboard';
const results = [];
const rec = (name, pass, detail) => { results.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SLOW_MS = 600;

const CAPS = ['overview:read', 'security:write', 'kill-switches:read'];
let ksHits = 0;

async function router(route) {
  const url = new URL(route.request().url());
  const path = url.pathname.replace(/^\/api/, '');
  const json = (obj) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(obj) });
  if (path === '/whoami') return json({ role: 'admin', label: 'Perf', email: 'p@t.local', profileId: 'owner', capabilities: CAPS });
  if (path === '/kill-switches' && route.request().method() === 'GET') {
    ksHits++;
    await sleep(SLOW_MS); // simulate a slow backend
    return json({ switches: [
      { name: 'bedrock_global', active: false, category: 'Cost Controls', description: 'Block all Bedrock.' },
      { name: 'tool_use', active: false, category: 'Safety & Guardrails', description: 'Block tools.' },
    ] });
  }
  if (path === '/panic') return json({ active: false, generation: 1 });
  return json({});
}

const INIT = `try {
  localStorage.setItem('cce_token','perf'); localStorage.setItem('cce_onboarded','1');
  localStorage.setItem('cce_role','admin'); localStorage.setItem('cce_capabilities', JSON.stringify(${JSON.stringify(CAPS)}));
} catch(e){}`;

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1400, height: 1400 } });
await ctx.addInitScript(INIT);
await ctx.route('**/api/**', router);
const page = await ctx.newPage();
page.setDefaultTimeout(20000);

async function timeToSwitches() {
  const t = Date.now();
  await page.getByRole('switch').first().waitFor();
  return Date.now() - t;
}

try {
  // First load (cold cache): must wait on the slow backend.
  await page.goto(`${BASE}/kill-switches`, { waitUntil: 'domcontentloaded' });
  const firstMs = await timeToSwitches();
  rec('First load waits for the (slow) backend', firstMs >= SLOW_MS - 100, `${firstMs}ms`);

  // Navigate away within the SPA (keeps the in-memory cache), then back.
  await page.getByRole('link', { name: 'Panic' }).click();
  await page.getByText('No panic active').waitFor();
  const t = Date.now();
  await page.getByRole('link', { name: 'Kill Switches' }).click();
  await page.getByRole('switch').first().waitFor();
  const revisitMs = Date.now() - t;
  rec('Revisit renders from cache (no skeleton wait)', revisitMs < 300, `${revisitMs}ms vs first ${firstMs}ms`);
  rec('Revisit is dramatically faster than first load', revisitMs < firstMs / 2, `${revisitMs}ms < ${Math.round(firstMs / 2)}ms`);
  console.log(`\n/kill-switches network hits: ${ksHits} (1 cold + background revalidations)`);
} catch (err) {
  rec('script', false, err instanceof Error ? (err.stack || err.message) : String(err));
} finally {
  await browser.close();
  const passed = results.filter((r) => r.pass).length;
  console.log(`\n──────── SUMMARY: ${passed}/${results.length} passed ────────`);
  process.exit(passed === results.length ? 0 : 1);
}
