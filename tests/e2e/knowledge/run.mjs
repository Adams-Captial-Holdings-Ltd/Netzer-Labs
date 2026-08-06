// Battle-test the redesigned Knowledge tab: drag/drop upload -> streamed
// pipeline -> done, retrieval test panel, doc list + filter. Mocks /api
// (including an SSE /ingest/stream body) and drives the local Vite dev server.
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';

const BASE = process.env.CCE_BASE ?? 'http://127.0.0.1:5180/dashboard';
const dir = fileURLToPath(new URL('.', import.meta.url)).replace(/\/$/, '');
const results = [];
const consoleErrors = [];
const rec = (n, p, d) => { results.push({ n, p, d }); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`); };

const CAPS = ['overview:read', 'vectors:read', 'vectors:write', 'agents:read'];
const docsByScope = { default: [] };

async function router(route) {
  const req = route.request();
  const url = new URL(req.url());
  const path = url.pathname.replace(/^\/api/, '');
  const method = req.method();
  const json = (obj) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(obj) });

  if (path === '/whoami') return json({ role: 'admin', label: 'KB', email: 'kb@t.local', profileId: 'owner', capabilities: CAPS });
  if (path === '/agents') return json({ agents: [{ id: 'main', displayName: 'Main' }, { id: 'ops', displayName: 'Ops' }] });

  if (path === '/vectors' && method === 'GET') {
    const scope = url.searchParams.get('scope') ?? 'default';
    const docs = docsByScope[scope] ?? [];
    return json({ scope, count: docs.length, docs });
  }
  if (path === '/ingest/stream' && method === 'POST') {
    // Record the upload as a doc, then stream the pipeline stages as SSE.
    (docsByScope.default ??= []).push({ docId: 'd1', title: 'policy.txt', source: 'dashboard-upload', chunkCount: 5, createdAt: new Date().toISOString() });
    const body = [
      'data: {"stage":"extract"}',
      'data: {"stage":"chunk","chunks":5}',
      'data: {"stage":"embed","done":2,"total":5}',
      'data: {"stage":"embed","done":5,"total":5}',
      'data: {"stage":"index","chunks":5}',
      'data: {"stage":"done","docId":"d1","chunks":5}',
    ].map((l) => l + '\n\n').join('');
    return route.fulfill({ status: 200, contentType: 'text/event-stream', body });
  }
  if (path === '/vectors/search' && method === 'POST') {
    return json({ hits: [
      { score: 0.923, text: 'Refunds are processed within 14 business days of the request.', docId: 'd1', docTitle: 'policy.txt', source: 'dashboard-upload', chunkIndex: 0 },
      { score: 0.611, text: 'Contact support to initiate a return.', docId: 'd1', docTitle: 'policy.txt', source: 'dashboard-upload', chunkIndex: 2 },
    ] });
  }
  return json({});
}

const INIT = `try {
  localStorage.setItem('cce_token','kb'); localStorage.setItem('cce_onboarded','1');
  localStorage.setItem('cce_role','admin'); localStorage.setItem('cce_capabilities', JSON.stringify(${JSON.stringify(CAPS)}));
} catch(e){}`;

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1400, height: 1700 } });
await ctx.addInitScript(INIT);
await ctx.route('**/api/**', router);
const page = await ctx.newPage();
page.setDefaultTimeout(20000);
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push('PAGEERROR ' + String(e)));

try {
  await page.goto(`${BASE}/vectors`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'Knowledge Base' }).waitFor();
  rec('Knowledge tab loads', true);
  rec('Drag-and-drop zone present', await page.getByText('Drag & drop files here').isVisible().catch(() => false));
  rec('Retrieval test panel present', await page.getByRole('heading', { name: 'Test retrieval' }).isVisible().catch(() => false));
  await page.screenshot({ path: `${dir}/01-empty.png`, fullPage: true });

  // Upload a file via the hidden input -> streamed pipeline -> done.
  await page.locator('input[type=file]').setInputFiles({ name: 'policy.txt', mimeType: 'text/plain', buffer: Buffer.from('Refunds are processed within 14 business days.') });
  await page.getByText(/Indexed 5 chunks/).waitFor();
  rec('Upload pipeline runs to "Indexed 5 chunks"', true);
  rec('Pipeline stepper shows stages (Embed)', await page.getByText('Embed').first().isVisible().catch(() => false));
  await page.screenshot({ path: `${dir}/02-pipeline-done.png`, fullPage: true });

  // The new doc appears in the list + summary updates.
  await page.getByText('policy.txt').first().waitFor();
  rec('Uploaded doc appears in the list', true);
  rec('Summary line counts the document', await page.getByText(/1 document/).isVisible().catch(() => false));

  // Retrieval test.
  await page.getByPlaceholder('e.g. what is our refund policy?').fill('refund policy');
  await page.getByRole('button', { name: 'Test', exact: true }).click();
  await page.getByText(/Refunds are processed within 14/).waitFor();
  rec('Retrieval test returns scored passages', await page.getByText('92.3%').isVisible().catch(() => false));
  await page.screenshot({ path: `${dir}/03-retrieval.png`, fullPage: true });

  // Filter.
  await page.getByPlaceholder('Filter documents…').fill('nope');
  await page.getByText(/No documents match/).waitFor();
  rec('Doc filter works', true);
  await page.getByPlaceholder('Filter documents…').fill('');

  rec('No console/page errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
} catch (err) {
  rec('script', false, err instanceof Error ? (err.stack || err.message) : String(err));
  await page.screenshot({ path: `${dir}/99-error.png`, fullPage: true }).catch(() => {});
} finally {
  await browser.close();
  const passed = results.filter((r) => r.p).length;
  console.log(`\n──────── SUMMARY: ${passed}/${results.length} passed ────────`);
  if (consoleErrors.length) consoleErrors.slice(0, 5).forEach((e) => console.log('  ~ ' + e.slice(0, 160)));
  process.exit(passed === results.length ? 0 : 1);
}
