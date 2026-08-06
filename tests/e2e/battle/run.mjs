// Local battle-test for the new toggle UI + War Room streaming.
//
// SAFETY: this drives the LOCAL Vite dev server (http://127.0.0.1:5180) with a
// fully MOCKED /api backend and a controllable fake EventSource. It never
// touches AWS, never hits production, and the kill-switch / panic "writes" only
// mutate in-memory mock state. The real backend logic is covered by the unit
// suite; this verifies the frontend behaviour that only runtime can prove:
// the toggles, the kill-confirm gate, the inverted switch, and the War Room
// streaming render.
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';

const BASE = process.env.CCE_BASE ?? 'http://127.0.0.1:5180/dashboard';
const dir = fileURLToPath(new URL('.', import.meta.url)).replace(/\/$/, '');
const results = [];
const consoleErrors = [];
const pageErrors = [];
function rec(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CAPS = [
  'overview:read','agents:read','agents:write','chat:read','sessions:read','usage:read',
  'cost:read','cost:write','config:read','config:write','audit:read','security:read','security:write','posture:read','posture:write',
  'integrations:read','vectors:read','vectors:write','missions:read','memories:read','hive:read',
  'scheduled:read','scheduled:write','warroom:read','warroom:write','members:read','members:write',
  'alerts:read','kill-switches:read',
];

// ── Stateful mock backend ──────────────────────────────────────────────
function ks(name, active, category, description, reason) {
  return { name, active, category, description, ...(reason ? { reason } : {}), setBy: active ? 'battle-test' : undefined };
}
const ksState = Object.fromEntries([
  ks('bedrock_global', false, 'Cost Controls', 'Block ALL Bedrock calls (full AI shutdown).'),
  ks('cost_cap_per_day', false, 'Cost Controls', 'Block Bedrock once daily spend exceeds the cap.'),
  ks('tool_use', false, 'Safety & Guardrails', 'Block all tool dispatch.'),
  ks('pii_redaction_enabled', true, 'Safety & Guardrails', 'Redact PII in audit detail.'), // INVERTED: active=true is healthy
  ks('guardrail_disabled', false, 'Safety & Guardrails', 'Bypass the Bedrock guardrail.'),
  ks('memory_writes', false, 'Agent Behavior', 'Block add_memory + memory ingest.'),
  ks('sessions_frozen', true, 'Agent Behavior', 'Block new agent turns.', 'maintenance window'), // starts tripped
  ks('jarvis_disabled', false, 'Agent Behavior', 'Jarvis emergency kill.'),
  ks('telegram_posting', false, 'Integrations', 'Block outbound Telegram sends.'),
  ks('warroom_disabled', false, 'Integrations', 'Reject all War Room calls.'),
  ks('audit_log_disabled', false, 'System', 'Drop audit writes to stdout only.'),
  ks('chaos_bedrock_throttle_opus', false, 'System', 'Inject synthetic throttle on Opus.'),
].map((s) => [s.name, s]));

let panicState = { active: false, generation: 3, releasedBy: 'battle-test', releasedAt: new Date(Date.now() - 86400000).toISOString() };
const configState = { 'cost/watch_enabled': 'false', 'iam/apply_enabled': 'false' };
const warroomMeetings = [];
const warroomHistory = {}; // meetingId -> turns[]
let seqCounter = {};
const agentsState = [
  { id: 'main', displayName: 'Main', status: 'active', model: '', telegramConnected: true, slackConnected: false },
  { id: 'ops', displayName: 'Ops', status: 'active', model: '', telegramConnected: false, slackConnected: false },
  { id: 'research', displayName: 'Research', status: 'inactive', model: '', telegramConnected: false, slackConnected: false },
];
const recorded = [];
function lastPost(suffix) {
  return [...recorded].reverse().find((r) => r.path.endsWith(suffix) && r.method === 'POST');
}

async function apiRouter(route) {
  const req = route.request();
  const url = new URL(req.url());
  const path = url.pathname.replace(/^\/api/, '');
  const method = req.method();
  let body = null;
  try { body = req.postData() ? JSON.parse(req.postData()) : null; } catch {}
  if (method !== 'GET') recorded.push({ path, method, body });
  const json = (obj, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(obj) });

  // identity
  if (path === '/whoami') return json({ role: 'admin', label: 'Battle Test', email: 'battle@test.local', profileId: 'owner', capabilities: CAPS });

  // kill switches
  if (path === '/kill-switches' && method === 'GET') return json({ switches: Object.values(ksState) });
  if (path === '/kill-switches' && method === 'POST') {
    if (body?.name && ksState[body.name]) { ksState[body.name].active = !!body.active; ksState[body.name].reason = body.reason; }
    return json({ ok: true, name: body?.name, active: body?.active });
  }

  // panic
  if (path === '/panic' && method === 'GET') return json(panicState);
  if (path === '/panic' && method === 'POST') {
    panicState = { active: true, generation: panicState.generation + 1, triggeredBy: 'battle-test', triggeredAt: new Date().toISOString(), reason: body?.reason ?? 'manual trigger', snapshot: { bedrock_global: false, tool_use: false, telegram_posting: false } };
    return json(panicState);
  }
  if (path === '/panic/restore' && method === 'POST') {
    panicState = { active: false, generation: panicState.generation, releasedBy: 'battle-test', releasedAt: new Date().toISOString() };
    return json(panicState);
  }
  if (path === '/panic/force-release' && method === 'POST') {
    panicState = { active: false, generation: panicState.generation, releasedBy: 'battle-test', releasedAt: new Date().toISOString(), forceReleased: true };
    return json(panicState);
  }

  // agents
  if (path === '/agents' && method === 'GET') return json({ agents: agentsState });
  const mAct = path.match(/^\/agents\/([^/]+)\/(activate|deactivate)$/);
  if (mAct && method === 'POST') {
    const a = agentsState.find((x) => x.id === mAct[1]);
    if (a) a.status = mAct[2] === 'activate' ? 'active' : 'inactive';
    return json({ ok: true });
  }

  // runtime config (drives the Cost daily-watch toggle)
  const mCfg = path.match(/^\/config\/([^/]+)\/([^/]+)$/);
  if (mCfg) {
    const key = `${mCfg[1]}/${mCfg[2]}`;
    if (method === 'GET') return json({ category: mCfg[1], key: mCfg[2], value: configState[key] ?? null });
    if (method === 'POST') { configState[key] = String(body?.value); return json({ ok: true }); }
  }

  // cost dashboard data (so the page renders and the watch toggle is reachable)
  if (path === '/cost-cap' && method === 'GET') return json({ dailyCapUsd: 50, source: 'runtime-config' });
  if (path === '/cost/summary' && method === 'GET') return json({ generatedAt: new Date().toISOString(), currency: 'USD', available: true, monthToDateUsd: 123.45, lastMonthUsd: 210.0, projectedMonthUsd: 180.0, daysElapsed: 3, daysInMonth: 30, byService: [{ service: 'Bedrock', amountUsd: 80 }, { service: 'DynamoDB', amountUsd: 20 }], daily: [{ date: '2026-06-01', amountUsd: 40 }, { date: '2026-06-02', amountUsd: 45 }, { date: '2026-06-03', amountUsd: 38 }] });
  if (path === '/cost/risks' && method === 'GET') return json({ generatedAt: new Date().toISOString(), available: true, regionsScanned: ['us-east-1'], risks: [], totalMonthlySavingsUsd: 0 });
  if (path === '/cost/evaluate' && method === 'POST') return json({ ran: true, alerted: false });

  // war room
  if (path === '/warroom' && method === 'GET') return json({ meetings: warroomMeetings });
  if (path === '/warroom' && method === 'POST') {
    const meetingId = 'mtg-' + (warroomMeetings.length + 1) + '-' + Date.now();
    const meeting = { meetingId, title: (body?.title || '').trim() || 'War Room', participants: body?.participants ?? [], status: 'active', createdAt: new Date().toISOString() };
    warroomMeetings.push(meeting);
    warroomHistory[meetingId] = [];
    seqCounter[meetingId] = 0;
    return json(meeting, 201);
  }
  const mTurn = path.match(/^\/warroom\/([^/]+)\/turn$/);
  if (mTurn && method === 'POST') {
    const meetingId = mTurn[1];
    const seq = (seqCounter[meetingId] = (seqCounter[meetingId] ?? 0) + 1);
    const turn = { meetingId, seq, speaker: body?.speaker ?? 'dashboard', type: 'user', content: body?.content ?? '', ts: new Date().toISOString() };
    (warroomHistory[meetingId] ??= []).push(turn);
    return json(turn);
  }
  const mHist = path.match(/^\/warroom\/([^/]+)\/history$/);
  if (mHist && method === 'GET') return json({ turns: warroomHistory[mHist[1]] ?? [] });
  const mGet = path.match(/^\/warroom\/([^/]+)$/);
  if (mGet && method === 'GET') return json(warroomMeetings.find((m) => m.meetingId === mGet[1]) ?? {});

  // catch-all: empty so unrelated widgets (notifications, jarvis manifest, etc.) don't error
  return json({});
}

// ── Fake EventSource + WebSocket stub, injected before app boot ─────────
const INIT = `
  try {
    localStorage.setItem('cce_token','battle-token');
    localStorage.setItem('cce_onboarded','1');
    localStorage.setItem('cce_role','admin');
    localStorage.setItem('cce_label','Battle Test');
    localStorage.setItem('cce_email','battle@test.local');
    localStorage.setItem('cce_profile_id','owner');
    localStorage.setItem('cce_capabilities', JSON.stringify(${JSON.stringify(CAPS)}));
  } catch (e) {}
  window.__esList = [];
  class FakeES {
    constructor(url){ this.url=url; this.readyState=0; this.onmessage=null; this.onerror=null; this.onopen=null; window.__esList.push(this); setTimeout(()=>{ this.readyState=1; this.onopen && this.onopen({}); },0); }
    close(){ this.readyState=2; }
    addEventListener(t,cb){ if(t==='message') this.onmessage=cb; if(t==='open') this.onopen=cb; if(t==='error') this.onerror=cb; }
    removeEventListener(){}
  }
  window.EventSource = FakeES;
  window.__esEmit = (obj) => { const es = window.__esList[window.__esList.length-1]; if(es && es.onmessage){ es.onmessage({ data: JSON.stringify(obj) }); } };
  // Neutralise the Jarvis widget websocket so it can't throw during the run.
  try { window.WebSocket = class { constructor(){ this.readyState=3; } send(){} close(){} addEventListener(){} removeEventListener(){} }; } catch(e){}
`;

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1400, height: 1700 } });
await ctx.addInitScript(INIT);
await ctx.route('**/api/**', apiRouter);
const page = await ctx.newPage();
page.setDefaultTimeout(20000);
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => pageErrors.push(String(e)));

const sw = (name) => page.getByRole('switch', { name });

try {
  // ════════════════ A. KILL SWITCHES ════════════════
  await page.goto(`${BASE}/kill-switches`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'Kill Switches' }).waitFor();
  await page.screenshot({ path: `${dir}/A1-killswitches.png`, fullPage: true });
  rec('Kill Switches page loads', true);

  // Inverted switch: pii_redaction_enabled active=true should read as ON (green).
  const piiOn = await sw('pii_redaction_enabled on, running').isVisible().catch(() => false);
  rec('Inverted switch (pii_redaction_enabled) shows ON when active=true', piiOn);

  // A normal tripped switch (sessions_frozen active=true) should read as OFF.
  const frozenOff = await sw('sessions_frozen off, blocked').isVisible().catch(() => false);
  rec('Tripped normal switch (sessions_frozen) shows OFF/blocked', frozenOff);
  const aria = await sw('sessions_frozen off, blocked').getAttribute('aria-checked').catch(() => null);
  rec('OFF switch exposes aria-checked=false (a11y)', aria === 'false', `aria-checked=${aria}`);

  // Kill the dangerous direction: bedrock_global ON -> confirm gate.
  await sw('bedrock_global on, running').click();
  await page.getByText('Switch off: bedrock global').waitFor();
  const offBtn = page.getByRole('button', { name: 'Switch off', exact: true });
  const disabledBefore = await offBtn.isDisabled();
  rec('Kill confirm: Switch off disabled before typing the name', disabledBefore);
  await page.getByPlaceholder('bedrock_global').fill('wrong');
  rec('Kill confirm: still disabled on wrong phrase', await offBtn.isDisabled());
  await page.getByPlaceholder('bedrock_global').fill('bedrock_global');
  rec('Kill confirm: enabled after exact name typed', !(await offBtn.isDisabled()));
  await page.getByPlaceholder('Why are you switching this off?').fill('battle test reason');
  await page.screenshot({ path: `${dir}/A2-kill-confirm.png` });
  await offBtn.click();
  await sw('bedrock_global off, blocked').waitFor();
  const bedrockPost = lastPost('/kill-switches');
  rec('Kill bedrock_global -> POST active:true', bedrockPost?.body?.active === true && bedrockPost?.body?.name === 'bedrock_global', JSON.stringify(bedrockPost?.body));
  rec('Kill reason carried into POST', bedrockPost?.body?.reason === 'battle test reason');

  // Inverted disable: pii_redaction_enabled ON -> OFF must POST active:FALSE.
  await sw('pii_redaction_enabled on, running').click();
  await page.getByPlaceholder('pii_redaction_enabled').fill('pii_redaction_enabled');
  await page.getByRole('button', { name: 'Switch off', exact: true }).click();
  await sw('pii_redaction_enabled off, blocked').waitFor();
  const piiPost = lastPost('/kill-switches');
  rec('Inverted disable -> POST active:false (not true)', piiPost?.body?.active === false && piiPost?.body?.name === 'pii_redaction_enabled', JSON.stringify(piiPost?.body));

  // Restore (safe direction) applies directly, no confirm.
  const beforeRestore = recorded.length;
  await sw('sessions_frozen off, blocked').click();
  await sw('sessions_frozen on, running').waitFor();
  const frozenPost = lastPost('/kill-switches');
  rec('Restore (off->on) applies with NO confirm modal', recorded.length === beforeRestore + 1 && frozenPost?.body?.name === 'sessions_frozen' && frozenPost?.body?.active === false, JSON.stringify(frozenPost?.body));

  // Cancel path: open a confirm and cancel -> no POST.
  const beforeCancel = recorded.length;
  await sw('tool_use on, running').click();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await sleep(200);
  rec('Cancel in kill-confirm fires no POST', recorded.length === beforeCancel);

  // Search filter.
  await page.getByPlaceholder('Search switches by name or description...').fill('telegram');
  await sleep(250);
  const telegramVisible = await sw('telegram_posting on, running').isVisible().catch(() => false);
  const bedrockHidden = !(await sw('bedrock_global off, blocked').isVisible().catch(() => false));
  rec('Search filters to matching switches only', telegramVisible && bedrockHidden);
  await page.getByPlaceholder('Search switches by name or description...').fill('');

  // ════════════════ B. WAR ROOM ════════════════
  await page.goto(`${BASE}/warroom`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'War Room' }).waitFor();
  rec('War Room page loads', true);
  // agent chips present
  const opsChip = await page.getByRole('button', { name: 'Ops' }).isVisible().catch(() => false);
  rec('War Room shows available agent chips', opsChip);

  await page.getByPlaceholder('Room topic...').fill('Incident: API latency');
  await page.getByRole('button', { name: 'Create Room' }).click();
  // header should show the topic, not a UUID
  await page.getByText('Incident: API latency').first().waitFor();
  rec('War Room header shows topic, not UUID', true);
  await page.screenshot({ path: `${dir}/B1-warroom-created.png`, fullPage: true });

  const meetingId = warroomMeetings[warroomMeetings.length - 1].meetingId;
  await sleep(300); // let SSE "open"
  const connected = await page.locator('.bg-success').first().isVisible().catch(() => false);
  rec('War Room SSE connects (status dot green)', connected);

  // Send a message + drive the stream like the orchestrator would.
  const composer = page.getByPlaceholder('Message the room, or @tag an agent...');
  await composer.fill('What is causing the latency?');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const turnPost = lastPost(`/warroom/${meetingId}/turn`);
  rec('Sending a message POSTs the turn', !!turnPost && turnPost.body?.content === 'What is causing the latency?');

  // user turn echo
  await page.evaluate((mid) => window.__esEmit({ type: 'turn_start', turnId: '1', speaker: 'dashboard', content: 'What is causing the latency?', ts: new Date().toISOString() }), meetingId);
  // agent main: typing -> chunks -> done
  await page.evaluate(() => window.__esEmit({ type: 'agent_typing', agentId: 'main' }));
  const typingSeen = await page.getByText('typing…').first().isVisible().catch(() => false);
  rec('Agent typing indicator renders', typingSeen);
  await page.evaluate(() => window.__esEmit({ type: 'agent_chunk', agentId: 'main', delta: 'Looking at the traces, ' }));
  await page.evaluate(() => window.__esEmit({ type: 'agent_chunk', agentId: 'main', delta: 'the DB pool is saturated.' }));
  await sleep(150);
  const streamed = await page.getByText('Looking at the traces, the DB pool is saturated.').isVisible().catch(() => false);
  rec('Agent reply streams in via chunks', streamed);
  warroomHistory[meetingId].push({ meetingId, seq: 2, speaker: 'main', agentId: 'main', type: 'agent', content: 'Looking at the traces, the DB pool is saturated.', ts: new Date().toISOString() });
  await page.evaluate(() => window.__esEmit({ type: 'agent_done', agentId: 'main', text: 'Looking at the traces, the DB pool is saturated.', seq: 2 }));
  // second agent ops
  await page.evaluate(() => window.__esEmit({ type: 'agent_typing', agentId: 'ops' }));
  await page.evaluate(() => window.__esEmit({ type: 'agent_done', agentId: 'ops', text: 'Agreed. I will bump the pool size and add a circuit breaker.', seq: 3 }));
  warroomHistory[meetingId].push({ meetingId, seq: 3, speaker: 'ops', agentId: 'ops', type: 'agent', content: 'Agreed. I will bump the pool size and add a circuit breaker.', ts: new Date().toISOString() });
  await page.evaluate(() => window.__esEmit({ type: 'turn_complete', turnId: '1' }));
  await sleep(200);

  const mainReply = await page.getByText('Looking at the traces, the DB pool is saturated.').isVisible().catch(() => false);
  const opsReply = await page.getByText('Agreed. I will bump the pool size and add a circuit breaker.').isVisible().catch(() => false);
  rec('Multiple agents respond in the room', mainReply && opsReply);
  const bodyText = await page.locator('body').innerText();
  rec('No NaN leaks into the transcript', !bodyText.includes('NaN'));
  const typingGone = !(await page.getByText('typing…').first().isVisible().catch(() => false));
  rec('turn_complete clears the typing bubble', typingGone);
  await page.screenshot({ path: `${dir}/B2-warroom-conversation.png`, fullPage: true });

  // Directed @mention round: a chip inserts the tag, and only the tagged agent
  // answers. (The server-side targeting decision itself is unit-tested in
  // src/lib/warroom/orchestrator.test.ts — parseMentions; here we verify the UX.)
  // Keep the mock seq counter monotonic across user+agent turns (as the real
  // publishTurn does) so the next user POST lands at seq 4, not colliding with
  // the hand-written agent seqs 2/3 above.
  seqCounter[meetingId] = 3;
  await page.getByRole('button', { name: '@ops' }).click();
  const composedVal = await composer.inputValue();
  rec('@mention chip inserts the tag into the composer', composedVal.includes('@ops'), JSON.stringify(composedVal));
  await composer.fill('@ops what is the rollback plan?');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const tagPost = lastPost(`/warroom/${meetingId}/turn`);
  rec('Tagged message is sent verbatim for the server to parse', tagPost?.body?.content === '@ops what is the rollback plan?');
  await page.evaluate(() => window.__esEmit({ type: 'turn_start', turnId: '4', speaker: 'dashboard', content: '@ops what is the rollback plan?', ts: new Date().toISOString() }));
  await page.evaluate(() => window.__esEmit({ type: 'agent_typing', agentId: 'ops' }));
  await page.evaluate(() => window.__esEmit({ type: 'agent_done', agentId: 'ops', text: 'Roll back by re-pointing the ALB to the previous task set; about 2 minutes.', seq: 5 }));
  await page.evaluate(() => window.__esEmit({ type: 'turn_complete', turnId: '4' }));
  // (the /turn POST handler already pushed the user turn at seq 4; only add the reply)
  warroomHistory[meetingId].push({ meetingId, seq: 5, speaker: 'ops', agentId: 'ops', type: 'agent', content: 'Roll back by re-pointing the ALB to the previous task set; about 2 minutes.', ts: new Date().toISOString() });
  await sleep(150);
  const opsAnswered = await page.getByText('Roll back by re-pointing the ALB to the previous task set; about 2 minutes.').isVisible().catch(() => false);
  rec('Tagged agent answers the directed question', opsAnswered);
  await page.screenshot({ path: `${dir}/B2b-warroom-mention.png`, fullPage: true });

  // History-on-connect: re-open the room, prior turns should reload.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'War Room' }).waitFor();
  await page.getByText('Incident: API latency').first().click();
  await page.getByText('Agreed. I will bump the pool size and add a circuit breaker.').waitFor();
  rec('Re-opening a room loads its history', true);
  await page.screenshot({ path: `${dir}/B3-warroom-history.png`, fullPage: true });

  // ════════════════ C. PANIC ════════════════
  await page.goto(`${BASE}/panic`, { waitUntil: 'domcontentloaded' });
  await page.getByText('No panic active').waitFor();
  await page.screenshot({ path: `${dir}/C1-panic-idle.png`, fullPage: true });
  rec('Panic page loads in released state', true);

  await sw('Panic disengaged, switch on to engage panic').click();
  await page.getByText('Engage panic').first().waitFor();
  await sleep(250); // let ConfirmDialog's open-reset effect settle before typing
  const panicInput = page.getByPlaceholder('PANIC');
  const engageBtn = page.getByRole('button', { name: 'Engage panic' });
  await panicInput.fill('PANIC');
  for (let i = 0; i < 6 && (await engageBtn.isDisabled().catch(() => true)); i++) { await panicInput.fill('PANIC'); await sleep(150); }
  await engageBtn.click();
  await page.getByRole('heading', { name: 'Panic active' }).waitFor();
  const panicPost = lastPost('/panic');
  rec('Panic engage requires PANIC confirm then POSTs', !!panicPost && panicState.active === true);
  await page.screenshot({ path: `${dir}/C2-panic-active.png`, fullPage: true });

  // Reload (clears the 30s propagation lock), then release via the toggle.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'Panic active' }).waitFor();
  await sw('Panic active, switch off to restore from snapshot').click();
  await page.getByText('Restore from snapshot').first().waitFor();
  await page.getByRole('button', { name: 'Restore', exact: true }).click();
  await page.getByText('No panic active').waitFor();
  const restorePost = lastPost('/panic/restore');
  rec('Panic release via toggle -> restore POST', !!restorePost && panicState.active === false);
  await page.screenshot({ path: `${dir}/C3-panic-released.png`, fullPage: true });

  // ════════════════ D. REMAINING ROLLOUT TOGGLES ════════════════
  // D1 — Cost daily-watch toggle (config-backed).
  await page.goto(`${BASE}/cost`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'Cost & Spend' }).waitFor();
  const watch = sw('Daily cost watch off');
  await watch.waitFor();
  await watch.click();
  await sw('Daily cost watch on').waitFor();
  const cfgPost = lastPost('/config/cost/watch_enabled');
  rec('Cost daily-watch toggle -> POST value:"true"', cfgPost?.body?.value === 'true', JSON.stringify(cfgPost?.body));
  await page.screenshot({ path: `${dir}/D1-cost-watch.png`, fullPage: true });

  // D2 — Agent activate toggle (research starts inactive).
  await page.goto(`${BASE}/agents`, { waitUntil: 'domcontentloaded' });
  await page.getByText('Research').first().waitFor();
  const researchToggle = sw('Deactivated, switch on to activate').first();
  await researchToggle.click();
  await sleep(400);
  const actPost = lastPost('/agents/research/activate');
  rec('Agent activate toggle -> POST /agents/research/activate', !!actPost);
  await page.screenshot({ path: `${dir}/D2-agents.png`, fullPage: true });

  // D3 — Jarvis push-to-talk toggle (signal + localStorage).
  await page.goto(`${BASE}/jarvis`, { waitUntil: 'domcontentloaded' });
  const ptt = sw('Push-to-talk');
  const pttThere = await ptt.first().waitFor({ timeout: 8000 }).then(() => true).catch(() => false);
  if (pttThere) {
    await ptt.first().click();
    await sleep(150);
    const v = await page.evaluate(() => localStorage.getItem('cce_jarvis_ptm'));
    rec('Jarvis push-to-talk toggle flips + persists', v === 'true', `cce_jarvis_ptm=${v}`);
  } else {
    rec('Jarvis push-to-talk toggle reachable', false, 'PTT switch not found on the Jarvis route');
  }
  await page.screenshot({ path: `${dir}/D3-jarvis.png`, fullPage: true });
} catch (err) {
  rec('script', false, err instanceof Error ? (err.stack || err.message) : String(err));
  await page.screenshot({ path: `${dir}/99-error.png`, fullPage: true }).catch(() => {});
} finally {
  await browser.close();
  const passed = results.filter((r) => r.pass).length;
  console.log(`\n──────── SUMMARY: ${passed}/${results.length} checks passed ────────`);
  if (pageErrors.length) { console.log(`\nPAGE ERRORS (${pageErrors.length}):`); pageErrors.slice(0, 10).forEach((e) => console.log('  ! ' + e)); }
  if (consoleErrors.length) { console.log(`\nCONSOLE ERRORS (${consoleErrors.length}):`); consoleErrors.slice(0, 10).forEach((e) => console.log('  ~ ' + e.slice(0, 200))); }
  process.exit(passed === results.length && pageErrors.length === 0 ? 0 : 1);
}
