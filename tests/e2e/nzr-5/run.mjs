// NZR-5 G4 E2E: drives the real knowledge routes of a locally started
// orchestrator (emulator, fake data only). The owner token mints a short-lived
// viewer and operator token, which are revoked at the end.
// Happy path: viewer lists default/shared; owner lists a private scope.
// Failure path: viewer/operator are refused other scopes with one uniform 403,
// before any store or model call; each refusal is audited with a hash only.
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
  console.log(`  ${method} ${path} -> ${res.status}`);
  return { status: res.status, json, text, type: res.headers.get('content-type') ?? '' };
}

const FORBIDDEN = JSON.stringify({ error: 'forbidden_scope' });
const minted = [];

async function mint(role) {
  const r = await call(OWNER, 'POST', '/api/tokens', { label: `nzr5-e2e-${role}`, role, expiresInDays: 1 });
  if (r.status !== 201 || !r.json?.token) throw new Error(`mint ${role} failed: ${r.status}`);
  minted.push(r.json.hashPrefix);
  return r.json.token;
}

try {
  rec('health', (await call(null, 'GET', '/health')).status === 200);
  const viewer = await mint('viewer');
  const operator = await mint('operator');

  // Happy path.
  const vd = await call(viewer, 'GET', '/api/vectors');
  rec('viewer lists default (no scope)', vd.status === 200 && vd.json?.scope === 'default', String(vd.status));
  const vs = await call(viewer, 'GET', '/api/vectors?scope=shared');
  rec('viewer lists shared', vs.status === 200 && vs.json?.scope === 'shared', String(vs.status));
  const op = await call(OWNER, 'GET', '/api/vectors?scope=finance_private');
  rec('owner lists a private scope', op.status === 200 && op.json?.scope === 'finance_private', String(op.status));

  // Failure path: viewer on the read routes, including folded spellings.
  const refused = [
    ['GET', '/api/vectors?scope=finance_private'],
    ['GET', '/api/vectors?scope=finance.private'],
    ['GET', '/api/vectors?scope=DEFAULT'],
    ['GET', '/api/vectors?scope=no_such_scope'],
    ['POST', '/api/vectors/search', { query: 'q', scope: 'finance_private' }],
    ['POST', '/api/vectors/answer', { query: 'q', scope: 'finance_private', modelId: 'openai.gpt-oss-120b-1:0' }],
  ];
  for (const [method, path, body] of refused) {
    const r = await call(viewer, method, path, body);
    rec(`viewer ${method} ${path.split('?')[0]} private is 403 forbidden_scope`, r.status === 403 && r.text === FORBIDDEN, String(r.status));
  }
  const bad = await call(viewer, 'POST', '/api/vectors/search', { query: 'q', scope: '' });
  rec('empty scope is 400 invalid_scope', bad.status === 400 && bad.json?.error === 'invalid_scope', String(bad.status));
  const up = await call(viewer, 'POST', '/api/vectors/upload-url', { filename: 'a.txt' });
  rec('viewer upload-url is 403 agents:write', up.status === 403 && up.json?.requiredCapability === 'agents:write', String(up.status));

  // Failure path: operator writes into a scope they cannot read.
  const del = await call(operator, 'DELETE', '/api/vectors/finance_private/nzr5-e2e-doc');
  rec('operator DELETE private is 403 forbidden_scope', del.status === 403 && del.text === FORBIDDEN, String(del.status));
  const ing = await call(operator, 'POST', '/api/ingest', { content: 'x', scope: 'finance_private' });
  rec('operator ingest private is 403 forbidden_scope', ing.status === 403 && ing.text === FORBIDDEN, String(ing.status));
  const st = await call(operator, 'POST', '/api/ingest/stream', { content: 'x', scope: 'finance_private' });
  rec('operator ingest/stream private is a JSON 403 before SSE', st.status === 403 && st.type.includes('application/json') && st.text === FORBIDDEN, String(st.status));

  // Audit: refusals are recorded with a scope hash, never the name.
  const audit = await call(OWNER, 'GET', '/api/audit?days=1');
  const rows = (audit.json?.rows ?? []).filter((r) => r.action === 'knowledge_scope_denied');
  rec('knowledge_scope_denied rows written', rows.length >= refused.length, `${rows.length} rows`);
  rec(
    'audit rows carry a 12-hex scopeHash and no scope name',
    rows.length > 0 && rows.every((r) => /^[0-9a-f]{12}$/.test(String(r.detail?.scopeHash ?? ''))) && !JSON.stringify(rows).includes('finance'),
  );
} catch (err) {
  rec('script', false, err instanceof Error ? err.message : String(err));
} finally {
  for (const prefix of minted) await call(OWNER, 'DELETE', `/api/tokens/${prefix}`).catch(() => {});
}

const passed = results.filter((x) => x.pass).length;
console.log(`SUMMARY: ${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
