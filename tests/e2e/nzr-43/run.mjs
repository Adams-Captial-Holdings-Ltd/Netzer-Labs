// NZR-43 G4 E2E: drives the real /api/config routes of a locally started
// orchestrator (Floci emulator, fake values only). Happy path: allowed
// categories read/write as before and secret-shaped values come back masked.
// Failure path: secret and unknown categories are refused with one uniform 403.
// Env: E2E_BASE (e.g. http://127.0.0.1:3900), E2E_TOKEN (owner root token).
const BASE = process.env.E2E_BASE ?? 'http://127.0.0.1:3900';
const TOKEN = process.env.E2E_TOKEN ?? process.env.DASHBOARD_TOKEN;
if (!TOKEN) {
  console.error('E2E_TOKEN is required');
  process.exit(2);
}

const results = [];
function rec(name, pass, detail = '') {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
}

async function call(method, path, body, auth = true) {
  const headers = auth ? { Authorization: `Bearer ${TOKEN}` } : {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  // Method, path, status only: bodies can carry config values.
  console.log(`  ${method} ${path} -> ${res.status}`);
  return { status: res.status, json, text };
}

const FORBIDDEN = JSON.stringify({ error: 'forbidden_category' });

try {
  rec('health', (await call('GET', '/health', undefined, false)).status === 200);

  const anon = await call('GET', '/api/config/profile', undefined, false);
  rec('no token is 401', anon.status === 401, String(anon.status));

  // Happy path: allowed category round-trips byte-identical.
  const w = await call('POST', '/api/config/profile/first_name', { value: 'Ada' });
  rec('owner writes profile/first_name', w.status === 200 && w.json?.value === 'Ada', String(w.status));
  const r = await call('GET', '/api/config/profile/first_name');
  rec('profile/first_name reads back unchanged', r.status === 200 && r.json?.value === 'Ada');
  const agg = await call('GET', '/api/config');
  rec(
    'GET /api/config keeps the {categories:{cost,sessions,rate_limits}} shape',
    agg.status === 200 && ['cost', 'sessions', 'rate_limits'].every((k) => k in (agg.json?.categories ?? {})),
  );

  // Masking: stored for real, never echoed in full.
  const fake = 'sk-e2e-fake-0000000000zzzz';
  const pw = await call('POST', '/api/config/paperclip/api_key', { value: fake, reason: `rotate to ${fake}` });
  rec('POST paperclip/api_key echoes ****zzzz', pw.status === 200 && pw.json?.value === '****zzzz' && !pw.text.includes(fake));
  const pr = await call('GET', '/api/config/paperclip/api_key');
  rec('GET paperclip/api_key is masked', pr.status === 200 && pr.json?.value === '****zzzz');
  const pc = await call('GET', '/api/config/paperclip');
  rec('GET paperclip category masks api_key', pc.status === 200 && pc.json?.values?.api_key === '****zzzz' && !pc.text.includes(fake));
  if (process.env.E2E_SERVER_LOG) {
    // The server's own log line for the write: value and free-text reason masked.
    const { readFileSync } = await import('node:fs');
    const log = readFileSync(process.env.E2E_SERVER_LOG, 'utf8');
    rec('server log masks value and reason', !log.includes(fake) && log.includes('"reason":"rotate to ****zzzz"'));
  }

  // Failure path: secret and unknown categories, every route, owner included.
  for (const [method, path, body] of [
    ['GET', '/api/config/oauth'],
    ['GET', '/api/config?category=oauth'],
    ['GET', '/api/config/oauth/slack_app_ops'],
    ['GET', '/api/config/mcp/servers'],
    ['GET', '/api/config/oauth_state/abc'],
    ['GET', '/api/config/OAUTH'],
    ['GET', '/api/config/oau%74h/x'],
    ['GET', '/api/config/no_such_category'],
    ['POST', '/api/config/oauth/slack_client_secret', { value: 'x' }],
    ['POST', '/api/config/no_such_category/k', { value: 'x' }],
  ]) {
    const res = await call(method, path, body);
    rec(`${method} ${path} is 403 forbidden_category`, res.status === 403 && res.text === FORBIDDEN, String(res.status));
  }

  // A masked value read back and posted again must not overwrite the secret.
  const mb = await call('POST', '/api/config/paperclip/api_key', { value: '****zzzz' });
  rec('POST of a masked value is 400 masked_value_rejected', mb.status === 400 && mb.json?.error === 'masked_value_rejected', String(mb.status));
  const still = await call('GET', '/api/config/paperclip/api_key');
  rec('paperclip/api_key still holds the real value', still.json?.value === '****zzzz');
  const big = await call('GET', `/api/config/${'a'.repeat(129)}`);
  rec('oversized category is 400 invalid_config_param', big.status === 400 && big.json?.error === 'invalid_config_param', String(big.status));
} catch (err) {
  rec('script', false, err instanceof Error ? err.message : String(err));
}

const passed = results.filter((x) => x.pass).length;
console.log(`SUMMARY: ${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
