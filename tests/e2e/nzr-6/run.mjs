// NZR-6 G4 E2E: drives the real knowledge routes of a locally started
// orchestrator (emulator, fake data only). The owner token mints two
// short-lived viewers and an operator, which are revoked at the end.
// Happy path: a viewer lists their own chat files by agentId+chatId (a derived
// chat_ scope); two viewers of the same chat get different scopes; the owner
// lists the quarantine and reads chat_quarantine through an audited override.
// Failure path: raw chat_* scopes, chat_* ingest targets, uploads/chat/ staging
// keys and the quarantine list are refused to non-admins; reassigning a doc
// that is not quarantined is a 404.
// Env: E2E_BASE (e.g. http://127.0.0.1:3900), E2E_TOKEN (owner root token).
// Prints method, path and status only: never a body, token or secret.
const BASE = process.env.E2E_BASE ?? 'http://127.0.0.1:3900';
const OWNER = process.env.E2E_TOKEN ?? process.env.DASHBOARD_TOKEN;
if (!OWNER) {
  console.error('E2E_TOKEN is required');
  process.exit(2);
}

const results = [];
function rec(name, pass, detail = '') {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
}

async function call(token, method, path, body) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  console.log(`  ${method} ${path.split('?')[0]} -> ${res.status}`);
  return { status: res.status, json, text };
}

const FORBIDDEN = JSON.stringify({ error: 'forbidden_scope' });
const CHAT_SCOPE = /^chat_[0-9a-f]{24}$/;
const minted = [];

async function mint(role, n) {
  const r = await call(OWNER, 'POST', '/api/tokens', { label: `nzr6-e2e-${role}-${n}`, role, expiresInDays: 1 });
  if (r.status !== 201 || !r.json?.token) throw new Error(`mint ${role} failed: ${r.status}`);
  minted.push(r.json.hashPrefix);
  return r.json.token;
}

try {
  rec('health', (await call(null, 'GET', '/health')).status === 200);
  const viewerA = await mint('viewer', 'a');
  const viewerB = await mint('viewer', 'b');
  const operator = await mint('operator', '1');
  const own = '/api/vectors?agentId=main&chatId=dashboard%3Anzr6-e2e';

  // Happy path.
  const a = await call(viewerA, 'GET', own);
  rec('viewer lists own chat files by agentId+chatId', a.status === 200 && CHAT_SCOPE.test(a.json?.scope ?? ''), String(a.status));
  const b = await call(viewerB, 'GET', own);
  rec('a second viewer of the same chat id derives a different scope', b.status === 200 && CHAT_SCOPE.test(b.json?.scope ?? '') && b.json?.scope !== a.json?.scope, String(b.status));
  const s = await call(viewerA, 'POST', '/api/vectors/search', { query: 'q', agentId: 'main', chatId: 'dashboard:nzr6-e2e' });
  // search_failed is raised by the embedding call AFTER the scope gate admitted the
  // chat scope; a local emulator has no Titan, so that still proves the gate.
  const noEmbed = s.status === 400 && s.json?.error === 'search_failed';
  rec('viewer searches own chat scope', (s.status === 200 && s.json?.scope === a.json?.scope) || noEmbed,
    noEmbed ? '400 search_failed after the gate: no embeddings locally' : String(s.status));
  const q = await call(OWNER, 'GET', '/api/knowledge/quarantine');
  rec('owner lists the quarantine', q.status === 200 && Array.isArray(q.json?.docs) && typeof q.json?.count === 'number', String(q.status));
  const oq = await call(OWNER, 'GET', '/api/vectors?scope=chat_quarantine');
  rec('owner reads chat_quarantine through the override', oq.status === 200 && oq.json?.scope === 'chat_quarantine', String(oq.status));

  // Failure path.
  for (const [who, token] of [['viewer', viewerA], ['operator', operator]]) {
    for (const [method, path, body] of [
      ['GET', `/api/vectors?scope=${b.json?.scope ?? 'chat_x'}`],
      ['GET', '/api/vectors?scope=chat_quarantine'],
      ['POST', '/api/vectors/search', { query: 'q', scope: 'chat_quarantine' }],
    ]) {
      const r = await call(token, method, path, body);
      rec(`${who} ${method} ${path.split('?')[0]} raw chat scope is 403 forbidden_scope`, r.status === 403 && r.text === FORBIDDEN, String(r.status));
    }
  }
  const half = await call(viewerA, 'GET', '/api/vectors?agentId=main');
  rec('agentId without chatId is 400 invalid_scope', half.status === 400 && half.json?.error === 'invalid_scope', String(half.status));
  const vq = await call(viewerA, 'GET', '/api/knowledge/quarantine');
  rec('viewer quarantine list is 403 knowledge:private:read', vq.status === 403 && vq.json?.requiredCapability === 'knowledge:private:read', String(vq.status));
  const ing = await call(OWNER, 'POST', '/api/ingest', { content: 'x', scope: 'chat_quarantine' });
  rec('even the owner cannot ingest into a chat_ scope', ing.status === 403 && ing.text === FORBIDDEN, String(ing.status));
  const st = await call(operator, 'POST', '/api/ingest/stream', { s3Key: 'uploads/chat/0123456789abcdef/nzr6-e2e/a.pdf', docTitle: 'a.pdf' });
  rec('ingest/stream refuses an uploads/chat/ key', st.text.includes('"stage":"error"') && st.text.includes('invalid upload key'), String(st.status));
  const ra = await call(OWNER, 'POST', '/api/knowledge/quarantine/default__nzr6-e2e-none/reassign', { agentId: 'main', chatId: 'dashboard:nzr6-e2e' });
  rec('reassigning a doc not in quarantine is 404', ra.status === 404 && ra.json?.error === 'not_found', String(ra.status));

  // Audit: the owner's look at a chat scope is recorded as an override.
  const audit = await call(OWNER, 'GET', '/api/audit?days=1');
  const rows = (audit.json?.rows ?? []).filter((r) => r.action === 'session_read_override' && r.detail?.scope === 'knowledge');
  rec('session_read_override(knowledge) row written', rows.length >= 1, `${rows.length} rows`);
} catch (err) {
  rec('script', false, err instanceof Error ? err.message : String(err));
} finally {
  for (const prefix of minted) await call(OWNER, 'DELETE', `/api/tokens/${prefix}`).catch(() => {});
}

const passed = results.filter((x) => x.pass).length;
console.log(`SUMMARY: ${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
