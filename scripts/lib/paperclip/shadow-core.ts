import { CookieJar, makeBoardRequest, type PaperclipRequest } from './bootstrap-core.js';
import { readSignUpProbe } from '../../../src/lib/paperclip/sign-up-probe.js';
import type { ShadowRows, ShadowSlot } from '../../../src/lib/paperclip/shadow-users.js';
import type { AuditEvent } from '../../../src/lib/audit/audit-writer.js';

type Entry = { email: string; password: string; boardKey: string | null };
type Secret = { v: 1; slots: Record<string, Entry> };
type Store = { read(): Promise<string>; write(value: string): Promise<void> };
export type ShadowDependencies = {
  fetchFn: typeof fetch; baseUrl: string; companyId: string; admin: PaperclipRequest;
  secret: Store; paperclipSecret: { read(): Promise<string> }; rows: ShadowRows;
  users: { get(userId: string): Promise<{ status: string } | null> };
  audit: (event: AuditEvent) => Promise<void>; now: () => number;
  randomHex: (bytes: number) => string; out: (line: string) => void;
};

function validSecret(value: unknown): value is Secret {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const root = value as Record<string, unknown>;
  if (Object.keys(root).length !== 2 || root.v !== 1 || !root.slots || typeof root.slots !== 'object' || Array.isArray(root.slots)) return false;
  return Object.entries(root.slots).every(([slot, valueAtSlot]) => {
    if (!/^(0[1-9]|[1-9][0-9])$/.test(slot) || !valueAtSlot || typeof valueAtSlot !== 'object' || Array.isArray(valueAtSlot)) return false;
    const entry = valueAtSlot as Record<string, unknown>;
    return Object.keys(entry).length === 3 && typeof entry.email === 'string' && typeof entry.password === 'string' &&
      (typeof entry.boardKey === 'string' || entry.boardKey === null);
  });
}

async function readSecret(store: Store): Promise<Secret> {
  try { const value: unknown = JSON.parse(await store.read()); if (validSecret(value)) return value; }
  catch { /* refuse unreadable state without showing it */ }
  throw new Error('Shadow approver secret is invalid');
}
async function writeSecret(store: Store, current: Secret, slot: string, entry: Entry): Promise<void> {
  const next: Secret = { v: 1, slots: { ...current.slots, [slot]: entry } };
  if (!validSecret(next)) throw new Error(`Shadow approver secret is invalid at slot ${slot}`);
  await store.write(JSON.stringify(next));
}
async function expectOk(response: Response, slot: string): Promise<Response> {
  if (!response.ok) throw new Error(`Slot ${slot}: HTTP ${response.status}`);
  return response;
}
async function body(response: Response, slot: string): Promise<Record<string, unknown>> {
  await expectOk(response, slot);
  try { const value: unknown = await response.json(); if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>; }
  catch { /* sanitized below */ }
  throw new Error(`Slot ${slot}: invalid Paperclip response`);
}
function bearer(deps: ShadowDependencies, key: string, path: string, init: RequestInit = {}): Promise<Response> {
  return deps.fetchFn(`${deps.baseUrl}${path}`, { ...init, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, redirect: 'error' });
}
async function identity(deps: ShadowDependencies, key: string, slot: string): Promise<Record<string, unknown>> {
  return body(await bearer(deps, key, '/api/cli-auth/me'), slot);
}
function isIdentity(me: Record<string, unknown>, row: ShadowSlot, companyId: string): boolean {
  return me.userId === row.paperclipUserId && Array.isArray(me.companyIds) && me.companyIds.includes(companyId);
}
function activeEntry(secret: Secret, slot: string): Entry & { boardKey: string } {
  const entry = secret.slots[slot];
  if (!entry?.boardKey || entry.boardKey === 'REPLACE_ME') throw new Error(`Slot ${slot}: key missing`);
  return { ...entry, boardKey: entry.boardKey };
}
async function member(deps: ShadowDependencies, userId: string, slot: string): Promise<string> {
  const data = await body(await deps.admin(`/api/companies/${encodeURIComponent(deps.companyId)}/members`), slot);
  const rows = data.members;
  const found = Array.isArray(rows) ? rows.find((row: unknown) => row && typeof row === 'object' && (row as Record<string, unknown>).principalId === userId) as Record<string, unknown> | undefined : undefined;
  if (typeof found?.id !== 'string') throw new Error(`Slot ${slot}: membership missing`);
  return found.id;
}
async function mint(deps: ShadowDependencies, key: string | PaperclipRequest, slot: string): Promise<string> {
  const init = { method: 'POST', body: JSON.stringify({ name: `netzer-shadow-${slot}-${deps.randomHex(4)}`, expiresAt: null }) };
  const response = typeof key === 'string' ? await bearer(deps, key, '/api/board-api-keys', init) : await key('/api/board-api-keys', init);
  const data = await body(response, slot);
  if (typeof data.token !== 'string' || !data.token) throw new Error(`Slot ${slot}: key missing from response`);
  return data.token;
}
async function assigned(deps: ShadowDependencies, netzerUserId: string) {
  const shadow = await deps.rows.getByNetzerUser(netzerUserId);
  if (!shadow || shadow.status !== 'active') throw new Error('Active shadow assignment missing');
  return shadow;
}

export function createShadowCore(deps: ShadowDependencies) {
  return {
    async pool(size = 25): Promise<void> {
      if (!Number.isInteger(size) || size < 1 || size > 99) throw new Error('Pool size must be 1..99');
      let created = 0;
      for (let n = 1; n <= size; n++) {
        const slot = String(n).padStart(2, '0');
        if (await deps.rows.getSlot(slot)) continue;
        const secret = await readSecret(deps.secret);
        if (Object.hasOwn(secret.slots, slot)) throw new Error(`Slot ${slot}: secret exists without a row`);
        const email = `shadow-${slot}-${deps.randomHex(4)}@netzer.invalid`;
        const password = deps.randomHex(32);
        if (password.length < 32) throw new Error(`Slot ${slot}: password source too short`);
        const request = makeBoardRequest(deps.baseUrl, new CookieJar(), deps.fetchFn);
        const signup = await request('/api/auth/sign-up/email', { method: 'POST', body: JSON.stringify({ email, password, name: `Unassigned approver ${slot}` }) });
        if (signup.status === 400 && (await signup.json().catch(() => null) as { code?: unknown } | null)?.code === 'EMAIL_PASSWORD_SIGN_UP_DISABLED') throw new Error('Pool can only be made inside the sign-up window');
        await expectOk(signup, slot);
        const me = await body(await request('/api/auth/get-session'), slot);
        const userId = me.user && typeof me.user === 'object' ? (me.user as Record<string, unknown>).id : me.userId;
        if (typeof userId !== 'string' || !userId) throw new Error(`Slot ${slot}: user id missing`);
        if (!await deps.rows.createSlot({ slot, paperclipUserId: userId })) throw new Error(`Slot ${slot}: create race`);
        await writeSecret(deps.secret, secret, slot, { email, password, boardKey: null });
        created++;
      }
      deps.out(`pool created ${created}`);
    },
    async assign(netzerUserId: string, name: string, decisionClasses: readonly string[]): Promise<void> {
      if (!netzerUserId || !name.trim() || !decisionClasses.length || decisionClasses.some((id) => !/^[a-z][a-z0-9_]*$/.test(id))) throw new Error('assign requires user, name and valid classes');
      if ((await deps.users.get(netzerUserId))?.status !== 'active') throw new Error('Netzer user is not active');
      if ((await deps.rows.getByNetzerUser(netzerUserId))?.status === 'active') throw new Error('Netzer user already has an active shadow');
      const row = (await deps.rows.listSlots()).filter((item) => item.state === 'free').sort((a, b) => a.slot.localeCompare(b.slot))[0];
      if (!row) throw new Error('No free shadow slot');
      const slot = row.slot; const secret = await readSecret(deps.secret); const entry = secret.slots[slot];
      if (!entry || entry.boardKey) throw new Error(`Slot ${slot}: secret state invalid`);
      const request = makeBoardRequest(deps.baseUrl, new CookieJar(), deps.fetchFn);
      await expectOk(await request('/api/auth/sign-in/email', { method: 'POST', body: JSON.stringify({ email: entry.email, password: entry.password }) }), slot);
      await expectOk(await request('/api/auth/profile', { method: 'PATCH', body: JSON.stringify({ name }) }), slot);
      const key = await mint(deps, request, slot);
      await expectOk(await deps.admin(`/api/admin/users/${encodeURIComponent(row.paperclipUserId)}/company-access`, { method: 'PUT', body: JSON.stringify({ companyIds: [deps.companyId] }) }), slot);
      const id = await member(deps, row.paperclipUserId, slot);
      const role = await body(await deps.admin(`/api/companies/${encodeURIComponent(deps.companyId)}/members/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ membershipRole: 'operator' }) }), slot);
      if (role.membershipRole !== 'operator' || !isIdentity(await identity(deps, key, slot), row, deps.companyId)) throw new Error(`Slot ${slot}: identity or role verification failed`);
      await writeSecret(deps.secret, secret, slot, { ...entry, boardKey: key });
      if (!await deps.rows.assign({ slot, netzerUserId, decisionClasses, now: deps.now() })) throw new Error(`Slot ${slot}: assignment lost a race`);
      await deps.audit({ action: 'shadow_assigned', userId: netzerUserId, result: 'ok', detail: { slot, shadowUserId: row.paperclipUserId, decisionClasses: [...decisionClasses] } });
      deps.out(`assign ${slot}`);
    },
    async rotate(netzerUserId: string): Promise<void> {
      const shadow = await assigned(deps, netzerUserId); const slot = shadow.slot;
      const secret = await readSecret(deps.secret); const entry = activeEntry(secret, slot);
      const response = await expectOk(await bearer(deps, entry.boardKey, '/api/board-api-keys'), slot);
      const listed: unknown = await response.json().catch(() => null);
      const nested = listed && typeof listed === 'object' ? (listed as Record<string, unknown>).keys : null;
      const keys = Array.isArray(listed) ? listed : Array.isArray(nested) ? nested : null;
      if (!keys) throw new Error(`Slot ${slot}: key list invalid`);
      const current = keys.filter((item: unknown) => item && typeof item === 'object' && typeof (item as Record<string, unknown>).name === 'string' && ((item as Record<string, unknown>).name as string).startsWith(`netzer-shadow-${slot}-`) && !(item as Record<string, unknown>).revokedAt);
      if (current.length !== 1 || typeof (current[0] as Record<string, unknown>).id !== 'string') throw new Error(`Slot ${slot}: current key not unique`);
      const oldId = (current[0] as Record<string, unknown>).id as string;
      const next = await mint(deps, entry.boardKey, slot);
      await writeSecret(deps.secret, secret, slot, { ...entry, boardKey: next });
      await expectOk(await bearer(deps, next, `/api/board-api-keys/${encodeURIComponent(oldId)}`, { method: 'DELETE' }), slot);
      if ((await bearer(deps, entry.boardKey, '/api/cli-auth/me')).status !== 401) throw new Error(`Slot ${slot}: old key still works`);
      await deps.audit({ action: 'shadow_rotated', userId: netzerUserId, result: 'ok', detail: { slot, shadowUserId: shadow.paperclipUserId } });
      deps.out(`rotate ${slot}`);
    },
    async retire(netzerUserId: string): Promise<void> {
      const shadow = await assigned(deps, netzerUserId); const slot = shadow.slot;
      const secret = await readSecret(deps.secret); const entry = activeEntry(secret, slot);
      await expectOk(await deps.admin(`/api/admin/users/${encodeURIComponent(shadow.paperclipUserId)}/company-access`, { method: 'PUT', body: JSON.stringify({ companyIds: [] }) }), slot);
      await writeSecret(deps.secret, secret, slot, { ...entry, boardKey: null });
      if (!await deps.rows.retire({ netzerUserId, now: deps.now() })) throw new Error(`Slot ${slot}: retirement lost a race`);
      await deps.audit({ action: 'shadow_retired', userId: netzerUserId, result: 'ok', detail: { slot, shadowUserId: shadow.paperclipUserId } });
      deps.out(`retire ${slot}`);
    },
    async check(): Promise<boolean> {
      let count = 0; let bad = 0;
      for (const row of await deps.rows.listSlots()) {
        if (row.state !== 'assigned') continue;
        count++;
        let key: string | null | undefined; let reason: string | undefined;
        try { key = (await readSecret(deps.secret)).slots[row.slot]?.boardKey; }
        catch { reason = 'secret_invalid'; }
        reason ??= !key ? 'key_missing' : !row.netzerUserId ? 'user_missing' : undefined;
        if (!reason && (await deps.users.get(row.netzerUserId!))?.status !== 'active') reason = 'user_inactive';
        if (!reason) { try { if (!isIdentity(await identity(deps, key!, row.slot), row, deps.companyId)) reason = 'identity_mismatch'; } catch { reason = 'key_invalid'; } }
        if (reason) { bad++; deps.out(`${row.slot} ${reason}`); }
      }
      if (!bad) deps.out(`check ${count} assigned slots healthy`);
      return bad === 0;
    },
    async probe(): Promise<boolean> {
      let email: string | undefined;
      try { const fields: unknown = JSON.parse(await deps.paperclipSecret.read()); if (fields && typeof fields === 'object' && !Array.isArray(fields)) { const value = (fields as Record<string, unknown>).signup_probe_email; if (typeof value === 'string') email = value; } }
      catch { /* probe reports unknown */ }
      const verdict = await readSignUpProbe({ fetchFn: deps.fetchFn, baseUrl: deps.baseUrl, probeEmail: email, windowOpen: false });
      deps.out(verdict.verdict === 'clean' ? 'clean' : verdict.verdict === 'unknown' ? verdict.reason : verdict.violations[0]?.code ?? 'violated');
      return verdict.verdict === 'clean';
    },
    async list(): Promise<void> {
      for (const row of await deps.rows.listSlots()) {
        const shadow = row.netzerUserId ? await deps.rows.getByNetzerUser(row.netzerUserId) : undefined;
        deps.out(`${row.slot} ${row.state} ${row.netzerUserId ?? '-'} ${shadow?.decisionClasses.join(',') ?? '-'}`);
      }
    },
  };
}
