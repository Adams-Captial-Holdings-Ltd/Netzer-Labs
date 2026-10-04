import { CookieJar, makeBoardRequest, type PaperclipRequest } from './bootstrap-core.js';
import { readSignUpProbe } from '../../../src/lib/paperclip/sign-up-probe.js';
import { probeEmailFromSecret } from '../lifecycle/sign-up-deploy-probe.js';
import type { ShadowRows, ShadowSlot, ShadowUser } from '../../../src/lib/paperclip/shadow-users.js';
import type { AuditEvent } from '../../../src/lib/audit/audit-writer.js';

type KeyEntry = { boardKey: string | null };
type SetupEntry = { email: string; password: string };
type MapSecret<T> = { v: 1; slots: Record<string, T> };
type Store = { read(): Promise<string>; write(value: string): Promise<void> };
export type ShadowDependencies = {
  fetchFn: typeof fetch; baseUrl: string; companyId: string; admin: PaperclipRequest;
  keys: Store; setup: Store; paperclipSecret: { read(): Promise<string> }; rows: ShadowRows;
  users: { get(userId: string): Promise<{ status: string } | null> };
  audit: (event: AuditEvent) => Promise<void>; now: () => number;
  randomHex: (bytes: number) => string; out: (line: string) => void;
  tableName?: string;
};

export class ShadowCommandError extends Error { override name = 'ShadowCommandError'; }
export class ShadowAuditError extends Error {
  override name = 'ShadowAuditError';
  constructor(command: string, causeName: string) {
    super(`${command} done; the audit row was NOT written (${causeName})`);
  }
}
const fail = (message: string): never => { throw new ShadowCommandError(message); };
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
function validMap<T>(value: unknown, valid: (entry: Record<string, unknown>) => boolean): value is MapSecret<T> {
  if (!isRecord(value) || value.v !== 1 || !isRecord(value.slots) || Object.keys(value).length !== 2) return false;
  return Object.entries(value.slots).every(([slot, entry]) => /^(0[1-9]|[1-9][0-9])$/.test(slot) && isRecord(entry) && valid(entry));
}
const validKey = (entry: Record<string, unknown>): boolean =>
  Object.keys(entry).length === 1 && (typeof entry.boardKey === 'string' || entry.boardKey === null);
const validSetup = (entry: Record<string, unknown>): boolean =>
  Object.keys(entry).length === 2 && typeof entry.email === 'string' && typeof entry.password === 'string';
async function readMap<T>(store: Store, valid: (entry: Record<string, unknown>) => boolean): Promise<MapSecret<T>> {
  try {
    const parsed: unknown = JSON.parse(await store.read());
    if (validMap<T>(parsed, valid)) return parsed;
  } catch { /* The content may hold secrets. */ }
  return fail('Shadow approver secret is invalid');
}
async function updateSlot<T>(store: Store, slot: string, entry: T, valid: (value: Record<string, unknown>) => boolean) {
  // ponytail: Secrets Manager has no compare-and-set here; one operator at a time; upgrade via a version-stage check.
  const current = await readMap<T>(store, valid);
  const next: MapSecret<T> = { v: 1, slots: { ...current.slots, [slot]: entry } };
  if (!validMap<T>(next, valid)) fail(`Slot ${slot}: secret state invalid`);
  await store.write(JSON.stringify(next));
}
async function expectOk(response: Response, slot: string): Promise<Response> {
  if (!response.ok) fail(`Slot ${slot}: HTTP ${response.status}`);
  return response;
}
async function body(response: Response, slot: string): Promise<Record<string, unknown>> {
  await expectOk(response, slot);
  try {
    const value: unknown = await response.json();
    if (isRecord(value)) return value;
  } catch { /* Sanitized below. */ }
  return fail(`Slot ${slot}: invalid Paperclip response`);
}
const timedFetch = (deps: ShadowDependencies): typeof fetch =>
  (input, init) => deps.fetchFn(input, { ...init, signal: AbortSignal.timeout(20_000) });
function session(deps: ShadowDependencies): PaperclipRequest {
  return makeBoardRequest(deps.baseUrl, new CookieJar(), timedFetch(deps));
}
function bearer(deps: ShadowDependencies, key: string, path: string, init: RequestInit = {}): Promise<Response> {
  return timedFetch(deps)(`${deps.baseUrl}${path}`, {
    ...init, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, redirect: 'error',
  });
}
async function identity(deps: ShadowDependencies, key: string, slot: string): Promise<Record<string, unknown>> {
  return body(await bearer(deps, key, '/api/cli-auth/me'), slot);
}
async function keyValid(deps: ShadowDependencies, key: string, userId: string, slot: string): Promise<boolean> {
  const response = await bearer(deps, key, '/api/cli-auth/me');
  if (response.status === 401 || response.status === 403) return false;
  return (await body(response, slot)).userId === userId;
}
function isIdentity(me: Record<string, unknown>, row: ShadowSlot, companyId: string): boolean {
  return me.userId === row.paperclipUserId && Array.isArray(me.companyIds) && me.companyIds.includes(companyId);
}
async function signIn(deps: ShadowDependencies, slot: string): Promise<PaperclipRequest> {
  const setup = (await readMap<SetupEntry>(deps.setup, validSetup)).slots[slot];
  if (!setup) return fail(`Slot ${slot}: setup missing`);
  const request = session(deps);
  await expectOk(await request('/api/auth/sign-in/email', {
    method: 'POST', body: JSON.stringify({ email: setup.email, password: setup.password }),
  }), slot);
  return request;
}
async function member(deps: ShadowDependencies, userId: string, slot: string): Promise<string> {
  const data = await body(await deps.admin(`/api/companies/${encodeURIComponent(deps.companyId)}/members`), slot);
  const rows = data.members;
  const found = Array.isArray(rows) ? rows.find((row: unknown) => isRecord(row) && row.principalId === userId) : undefined;
  if (!isRecord(found) || typeof found.id !== 'string') return fail(`Slot ${slot}: membership missing`);
  return found.id;
}
async function mint(deps: ShadowDependencies, access: string | PaperclipRequest, slot: string): Promise<string> {
  const init = { method: 'POST', body: JSON.stringify({ name: `netzer-shadow-${slot}-${deps.randomHex(4)}`, expiresAt: null }) };
  const response = typeof access === 'string'
    ? await bearer(deps, access, '/api/board-api-keys', init)
    : await access('/api/board-api-keys', init);
  const data = await body(response, slot);
  if (typeof data.token !== 'string' || !data.token) return fail(`Slot ${slot}: key missing from response`);
  return data.token;
}
async function audit(deps: ShadowDependencies, command: string, event: AuditEvent): Promise<void> {
  try { await deps.audit(event); }
  catch (error) { throw new ShadowAuditError(command, error instanceof Error ? error.name : 'UnknownError'); }
}
async function poolSlot(deps: ShadowDependencies, slot: string): Promise<boolean> {
  const existing = await deps.rows.getSlot(slot);
  const setup = (await readMap<SetupEntry>(deps.setup, validSetup)).slots[slot];
  if (existing) {
    if (!(await readMap<KeyEntry>(deps.keys, validKey)).slots[slot]) await updateSlot(deps.keys, slot, { boardKey: null }, validKey);
    return false;
  }
  const credentials = setup ?? {
    email: `shadow-${slot}-${deps.randomHex(4)}@netzer.invalid`, password: deps.randomHex(32),
  };
  if (!setup) await updateSlot(deps.setup, slot, credentials, validSetup);
  const request = session(deps);
  let response: Response;
  if (setup) {
    response = await request('/api/auth/sign-in/email', {
      method: 'POST', body: JSON.stringify({ email: credentials.email, password: credentials.password }),
    });
  } else {
    response = new Response(null, { status: 401 });
  }
  if (response.status === 401 || response.status === 404) {
    response = await request('/api/auth/sign-up/email', {
      method: 'POST', body: JSON.stringify({ ...credentials, name: `Unassigned approver ${slot}` }),
    });
    const error = await response.clone().json().catch(() => null) as unknown;
    if (response.status === 400 && isRecord(error) && error.code === 'EMAIL_PASSWORD_SIGN_UP_DISABLED') {
      return fail('Pool can only be made inside the sign-up window');
    }
  }
  await expectOk(response, slot);
  const me = await body(await request('/api/auth/get-session'), slot);
  const userId = isRecord(me.user) ? me.user.id : undefined;
  if (typeof userId !== 'string' || !userId) return fail(`Slot ${slot}: user id missing`);
  if (!await deps.rows.createSlot({ slot, paperclipUserId: userId })) return fail(`Slot ${slot}: create race`);
  if (!(await readMap<KeyEntry>(deps.keys, validKey)).slots[slot]) await updateSlot(deps.keys, slot, { boardKey: null }, validKey);
  return true;
}
async function chooseKey(deps: ShadowDependencies, row: ShadowSlot): Promise<{ key: string; fresh: boolean }> {
  const current = (await readMap<KeyEntry>(deps.keys, validKey)).slots[row.slot]?.boardKey;
  if (current && await keyValid(deps, current, row.paperclipUserId, row.slot)) {
    if ((await listedKeys(deps, current, row.slot)).length === 1) return { key: current, fresh: false };
  }
  const request = await signIn(deps, row.slot);
  const older = await listedKeys(deps, request, row.slot);
  const key = await mint(deps, request, row.slot);
  await updateSlot(deps.keys, row.slot, { boardKey: key }, validKey);
  for (const id of older) {
    await expectOk(await bearer(deps, key, `/api/board-api-keys/${encodeURIComponent(id)}`, { method: 'DELETE' }), row.slot);
  }
  return { key, fresh: true };
}
async function assignSlot(deps: ShadowDependencies, row: ShadowSlot, name: string): Promise<string> {
  const { key, fresh } = await chooseKey(deps, row);
  if (fresh) {
    const request = await signIn(deps, row.slot);
    await expectOk(await request('/api/auth/profile', { method: 'PATCH', body: JSON.stringify({ name }) }), row.slot);
  }
  await expectOk(await deps.admin(`/api/admin/users/${encodeURIComponent(row.paperclipUserId)}/company-access`, {
    method: 'PUT', body: JSON.stringify({ companyIds: [deps.companyId] }),
  }), row.slot);
  const id = await member(deps, row.paperclipUserId, row.slot);
  const role = await body(await deps.admin(`/api/companies/${encodeURIComponent(deps.companyId)}/members/${encodeURIComponent(id)}`, {
    method: 'PATCH', body: JSON.stringify({ membershipRole: 'operator' }),
  }), row.slot);
  if (role.membershipRole !== 'operator' || !isIdentity(await identity(deps, key, row.slot), row, deps.companyId)) {
    return fail(`Slot ${row.slot}: identity or role verification failed`);
  }
  return key;
}
async function listedKeys(deps: ShadowDependencies, access: string | PaperclipRequest, slot: string): Promise<string[]> {
  const response = typeof access === 'string'
    ? await bearer(deps, access, '/api/board-api-keys')
    : await access('/api/board-api-keys');
  await expectOk(response, slot);
  const listed: unknown = await response.json().catch(() => null);
  const nested = isRecord(listed) ? listed.keys : undefined;
  const keys = Array.isArray(listed) ? listed : Array.isArray(nested) ? nested : undefined;
  if (!keys) return fail(`Slot ${slot}: key list invalid`);
  return keys.filter((item: unknown) => isRecord(item) && typeof item.name === 'string' &&
    item.name.startsWith(`netzer-shadow-${slot}-`) && !item.revokedAt)
    .map((item: Record<string, unknown>) => item.id)
    .filter((id: unknown): id is string => typeof id === 'string');
}
async function rotateSlot(deps: ShadowDependencies, shadow: ShadowUser): Promise<void> {
  const slot = shadow.slot;
  const current = (await readMap<KeyEntry>(deps.keys, validKey)).slots[slot]?.boardKey;
  const access: string | PaperclipRequest = current && await keyValid(deps, current, shadow.paperclipUserId, slot)
    ? current : await signIn(deps, slot);
  const older = await listedKeys(deps, access, slot);
  const next = await mint(deps, access, slot);
  await updateSlot(deps.keys, slot, { boardKey: next }, validKey);
  for (const id of older) {
    await expectOk(await bearer(deps, next, `/api/board-api-keys/${encodeURIComponent(id)}`, { method: 'DELETE' }), slot);
  }
  if (current && current !== next) {
    const status = (await bearer(deps, current, '/api/cli-auth/me')).status;
    if (status !== 401 && status !== 403) fail(`Slot ${slot}: old key still works`);
  }
}
async function retireSlot(deps: ShadowDependencies, shadow: ShadowUser): Promise<void> {
  const slot = shadow.slot;
  const key = (await readMap<KeyEntry>(deps.keys, validKey)).slots[slot]?.boardKey;
  await expectOk(await deps.admin(`/api/admin/users/${encodeURIComponent(shadow.paperclipUserId)}/company-access`, {
    method: 'PUT', body: JSON.stringify({ companyIds: [] }),
  }), slot);
  if (key) {
    const response = await bearer(deps, key, '/api/cli-auth/me');
    if (response.ok) {
      const me = await body(response, slot);
      if (Array.isArray(me.companyIds) && me.companyIds.includes(deps.companyId)) fail(`Slot ${slot}: company access remains`);
    } else if (response.status !== 401 && response.status !== 403) {
      fail(`Slot ${slot}: HTTP ${response.status}`);
    }
  }
  if (shadow.status === 'active' && !await deps.rows.retire({ netzerUserId: shadow.netzerUserId, now: deps.now() })) {
    fail(`Slot ${slot}: retirement lost a race`);
  }
  if (key) await updateSlot(deps.keys, slot, { boardKey: null }, validKey);
}
async function pool(deps: ShadowDependencies, size = 25): Promise<void> {
  if (!Number.isInteger(size) || size < 1 || size > 99) fail('Pool size must be 1..99');
  let created = 0;
  for (let n = 1; n <= size; n++) {
    if (await poolSlot(deps, String(n).padStart(2, '0'))) created++;
  }
  deps.out(`pool created ${created}`);
}
async function assign(deps: ShadowDependencies, netzerUserId: string, name: string,
  decisionClasses: readonly string[]): Promise<void> {
  if (!netzerUserId || !name.trim() || !decisionClasses.length ||
    decisionClasses.some((id) => !/^[a-z][a-z0-9_]*$/.test(id))) fail('assign requires user, name and valid classes');
  if ((await deps.users.get(netzerUserId))?.status !== 'active') fail('Netzer user is not active');
  const existing = await deps.rows.getByNetzerUser(netzerUserId);
  if (existing?.status === 'active') {
    await audit(deps, 'assign', { action: 'shadow_assigned', userId: netzerUserId, result: 'ok',
      detail: { slot: existing.slot, shadowUserId: existing.paperclipUserId, decisionClasses: existing.decisionClasses } });
    deps.out(`assign ${existing.slot}`);
    return;
  }
  const row = (await deps.rows.listSlots()).filter((item) => item.state === 'free')
    .sort((a, b) => a.slot.localeCompare(b.slot))[0];
  if (!row) fail('No free shadow slot');
  await assignSlot(deps, row, name);
  if (!await deps.rows.assign({ slot: row.slot, netzerUserId, decisionClasses, now: deps.now() })) {
    fail(`Slot ${row.slot}: assignment lost a race`);
  }
  await audit(deps, 'assign', { action: 'shadow_assigned', userId: netzerUserId, result: 'ok',
    detail: { slot: row.slot, shadowUserId: row.paperclipUserId, decisionClasses: [...decisionClasses] } });
  deps.out(`assign ${row.slot}`);
}
async function rotate(deps: ShadowDependencies, netzerUserId: string): Promise<void> {
  const shadow = await deps.rows.getByNetzerUser(netzerUserId);
  if (!shadow || shadow.status !== 'active') return fail('Active shadow assignment missing');
  await rotateSlot(deps, shadow);
  await audit(deps, 'rotate', { action: 'shadow_rotated', userId: netzerUserId, result: 'ok',
    detail: { slot: shadow.slot, shadowUserId: shadow.paperclipUserId } });
  deps.out(`rotate ${shadow.slot}`);
}
async function retire(deps: ShadowDependencies, netzerUserId: string): Promise<void> {
  const shadow = await deps.rows.getByNetzerUser(netzerUserId);
  if (!shadow) return fail('Active shadow assignment missing');
  const key = (await readMap<KeyEntry>(deps.keys, validKey)).slots[shadow.slot]?.boardKey;
  if (shadow.status === 'retired' && !key) {
    await audit(deps, 'retire', { action: 'shadow_retired', userId: netzerUserId, result: 'ok',
      detail: { slot: shadow.slot, shadowUserId: shadow.paperclipUserId } });
    deps.out(`retire ${shadow.slot} already retired`);
    return;
  }
  await retireSlot(deps, shadow);
  await audit(deps, 'retire', { action: 'shadow_retired', userId: netzerUserId, result: 'ok',
    detail: { slot: shadow.slot, shadowUserId: shadow.paperclipUserId } });
  deps.out(`retire ${shadow.slot}`);
}
async function check(deps: ShadowDependencies): Promise<boolean> {
  const rows = await deps.rows.listSlots();
  if (!rows.length) {
    deps.out(`no slot rows found in table ${deps.tableName ?? 'unknown'}`);
    return false;
  }
  let secret: MapSecret<KeyEntry>;
  try { secret = await readMap<KeyEntry>(deps.keys, validKey); }
  catch {
    deps.out('secret_invalid');
    return false;
  }
  let bad = 0;
  for (const row of rows.filter((item) => item.state === 'assigned')) {
    const key = secret.slots[row.slot]?.boardKey;
    let reason = !key ? 'key_missing' : !row.netzerUserId ? 'user_missing' : undefined;
    if (!reason && row.netzerUserId && (await deps.users.get(row.netzerUserId))?.status !== 'active') reason = 'user_inactive';
    if (!reason && key) {
      try {
        const response = await bearer(deps, key, '/api/cli-auth/me');
        if (response.status === 401 || response.status === 403) reason = 'key_invalid';
        else if (!response.ok) reason = 'paperclip_unreachable';
        else if (!isIdentity(await body(response, row.slot), row, deps.companyId)) reason = 'identity_mismatch';
      } catch { reason = 'paperclip_unreachable'; }
    }
    if (reason) {
      bad++;
      deps.out(`${row.slot} ${reason}`);
    }
  }
  if (!bad) deps.out(`check ${rows.filter((row) => row.state === 'assigned').length} assigned slots healthy`);
  return bad === 0;
}
async function probe(deps: ShadowDependencies): Promise<boolean> {
  let email: string | undefined;
  try { email = probeEmailFromSecret(await deps.paperclipSecret.read()); }
  catch {
    deps.out('paperclip_secret_unreadable');
    return false;
  }
  const verdict = await readSignUpProbe({ fetchFn: timedFetch(deps), baseUrl: deps.baseUrl, probeEmail: email, windowOpen: false });
  deps.out(verdict.verdict === 'clean' ? 'clean' : verdict.verdict === 'unknown' ? verdict.reason :
    verdict.violations[0]?.code ?? 'violated');
  return verdict.verdict === 'clean';
}
async function list(deps: ShadowDependencies): Promise<void> {
  for (const row of await deps.rows.listSlots()) {
    const shadow = row.state === 'assigned' && row.netzerUserId
      ? await deps.rows.getByNetzerUser(row.netzerUserId) : undefined;
    deps.out(`${row.slot} ${row.state} ${row.netzerUserId ?? '-'} ${shadow?.decisionClasses.join(',') ?? '-'}`);
  }
}
export function createShadowCore(deps: ShadowDependencies) {
  return {
    pool: (size?: number) => pool(deps, size),
    assign: (userId: string, name: string, classes: readonly string[]) => assign(deps, userId, name, classes),
    rotate: (userId: string) => rotate(deps, userId),
    retire: (userId: string) => retire(deps, userId),
    check: () => check(deps),
    probe: () => probe(deps),
    list: () => list(deps),
  };
}
