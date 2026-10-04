import { describe, expect, it } from 'vitest';
import { createShadowCore, type ShadowDependencies } from './shadow-core.js';
import type { ShadowRows, ShadowSlot, ShadowUser } from '../../../src/lib/paperclip/shadow-users.js';
import type { AuditEvent } from '../../../src/lib/audit/audit-writer.js';

const email = 'shadow-01-secret@netzer.invalid';
const password = 'password-secret-abcdefghijklmnopqrstuvwxyz123456';
const oldKey = 'pcp_board_old_secret';
const json = (value: unknown, status = 200, cookie?: string) => new Response(JSON.stringify(value), { status, headers: cookie ? { 'set-cookie': `sid=${cookie}; Path=/` } : undefined });
function fixture() {
  const slots = new Map<string, ShadowSlot>();
  const shadows = new Map<string, ShadowUser>();
  const entries: Record<string, { email: string; password: string; boardKey: string | null }> = {};
  const people = new Map<string, string>();
  const keys = new Map<string, { id: string; name: string; owner: string; revokedAt: string | null }>();
  const memberships = new Map<string, { id: string; role: string }>();
  const lines: string[] = []; const calls: string[] = []; const audits: AuditEvent[] = [];
  let closed = false; let serial = 0; let secret = JSON.stringify({ v: 1, slots: entries });
  const rows: ShadowRows = {
    async getSlot(slot) { return slots.get(slot); }, async listSlots() { return [...slots.values()]; },
    async getByNetzerUser(id) { return shadows.get(id); },
    async getByPaperclipUser(id) { return [...shadows.values()].find((s) => s.paperclipUserId === id); },
    async createSlot({ slot, paperclipUserId }) { if (slots.has(slot)) return false; slots.set(slot, { slot, paperclipUserId, state: 'free' }); return true; },
    async assign({ slot, netzerUserId, decisionClasses, now }) {
      const row = slots.get(slot); if (!row || row.state !== 'free' || shadows.get(netzerUserId)?.status === 'active') return false;
      slots.set(slot, { ...row, state: 'assigned', netzerUserId, assignedAt: now });
      shadows.set(netzerUserId, { slot, netzerUserId, paperclipUserId: row.paperclipUserId, decisionClasses: [...decisionClasses], assignedAt: now, status: 'active' });
      return true;
    },
    async retire({ netzerUserId, now }) {
      const shadow = shadows.get(netzerUserId); if (!shadow || shadow.status !== 'active') return false;
      shadows.set(netzerUserId, { ...shadow, status: 'retired', retiredAt: now });
      slots.set(shadow.slot, { ...slots.get(shadow.slot)!, state: 'retired', retiredAt: now }); return true;
    },
  };
  const fetchFn: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname; const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers); const bearer = headers.get('authorization')?.replace('Bearer ', '');
    const cookie = headers.get('cookie')?.replace('sid=', '');
    const owner = bearer ? keys.get(bearer)?.owner : cookie;
    const data = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    calls.push(`${method} ${path}`);
    if (path === '/api/auth/sign-up/email' && method === 'POST') {
      if (closed) return json({ code: 'EMAIL_PASSWORD_SIGN_UP_DISABLED' }, 400);
      const id = `pc-${++serial}`; people.set(String(data.email), id); return json({ user: { id } }, 200, id);
    }
    if (path === '/api/auth/sign-in/email') { const id = people.get(String(data.email)); return id ? json({ user: { id } }, 200, id) : json({}, 401); }
    if (path === '/api/auth/get-session') return json({ user: { id: owner } });
    if (path === '/api/auth/profile') return json({ name: data.name });
    if (path === '/api/board-api-keys' && method === 'POST') {
      if (!owner) return json({}, 401);
      const token = `pcp_board_new_secret_${++serial}`;
      keys.set(token, { id: `key-${serial}`, name: String(data.name), owner, revokedAt: null });
      return json({ token }, 201);
    }
    if (path === '/api/board-api-keys' && method === 'GET') return owner ? json([...keys.values()].filter((k) => k.owner === owner)) : json({}, 401);
    if (path.startsWith('/api/board-api-keys/') && method === 'DELETE') {
      const found = [...keys.entries()].find(([, k]) => k.id === path.split('/').at(-1) && k.owner === owner);
      if (!found) return json({}, 404); keys.set(found[0], { ...found[1], revokedAt: 'now' }); return json({});
    }
    if (path === '/api/cli-auth/me') {
      const key = keys.get(bearer ?? '');
      if (!key || key.revokedAt) return json({}, 401);
      return json({ userId: key.owner, companyIds: memberships.has(key.owner) ? ['co-1'] : [] });
    }
    const access = /^\/api\/admin\/users\/([^/]+)\/company-access$/.exec(path);
    if (access) { if ((data.companyIds as string[]).length) memberships.set(access[1], { id: `member-${access[1]}`, role: 'viewer' }); else memberships.delete(access[1]); return json({}); }
    if (path === '/api/companies/co-1/members') return json({ members: [...memberships].map(([id, member]) => ({ id: member.id, principalId: id })) });
    const member = /^\/api\/companies\/co-1\/members\/member-(.+)$/.exec(path);
    if (member) { memberships.set(member[1], { id: `member-${member[1]}`, role: String(data.membershipRole) }); return json({ membershipRole: data.membershipRole }); }
    return json({}, 404);
  };
  const deps: ShadowDependencies = {
    fetchFn, baseUrl: 'https://board.invalid', companyId: 'co-1', admin: (path, init) => fetchFn(`https://board.invalid${path}`, init),
    secret: { read: async () => secret, write: async (value) => { secret = value; } },
    paperclipSecret: { read: async () => JSON.stringify({ signup_probe_email: email }) }, rows,
    users: { get: async (id) => peopleStatus.has(id) ? { status: peopleStatus.get(id)! } : null },
    audit: async (event) => { audits.push(event); }, now: () => 100,
    randomHex: (bytes) => bytes === 32 ? password : 'abcd1234', out: (line) => { lines.push(line); },
  };
  const peopleStatus = new Map([['net-1', 'active'], ['net-2', 'active'], ['disabled', 'disabled']]);
  function seed(slot: string, state: ShadowSlot['state'] = 'free', user = 'net-1') {
    const id = `pc-${slot}`; const address = slot === '01' ? email : `shadow-${slot}-secret@netzer.invalid`;
    people.set(address, id); slots.set(slot, { slot, paperclipUserId: id, state, ...(state !== 'free' ? { netzerUserId: user } : {}) });
    entries[slot] = { email: address, password, boardKey: state === 'assigned' ? oldKey : null };
    secret = JSON.stringify({ v: 1, slots: entries });
    if (state !== 'free') shadows.set(user, { slot, netzerUserId: user, paperclipUserId: id, decisionClasses: ['money'], status: state === 'assigned' ? 'active' : 'retired', assignedAt: 1 });
    if (state === 'assigned') { memberships.set(id, { id: `member-${id}`, role: 'operator' }); keys.set(oldKey, { id: `key-old-${slot}`, name: `netzer-shadow-${slot}-old`, owner: id, revokedAt: null }); }
  }
  return { core: createShadowCore(deps), deps, rows, slots, shadows, lines, calls, audits, keys, memberships, seed,
    close: () => { closed = true; }, status: (id: string, value: string) => peopleStatus.set(id, value), read: () => JSON.parse(secret) as { slots: Record<string, { boardKey: string | null }> } };
}

describe('shadow operator core', () => {
  it('pool creates missing slots', async () => { const f = fixture(); f.seed('01'); await f.core.pool(3); expect([...f.slots.keys()]).toEqual(['01', '02', '03']); expect(f.read().slots['02'].boardKey).toBeNull(); });
  it('pool second run creates none', async () => { const f = fixture(); await f.core.pool(2); const count = f.calls.filter((c) => c.includes('sign-up')).length; await f.core.pool(2); expect(f.calls.filter((c) => c.includes('sign-up'))).toHaveLength(count); });
  it('pool refuses closed sign-up', async () => { const f = fixture(); f.close(); await expect(f.core.pool(1)).rejects.toThrow('sign-up window'); });
  it('assign takes lowest free slot and grants operator', async () => { const f = fixture(); f.seed('02'); f.seed('01'); await f.core.assign('net-1', 'Emmanuel', ['money']); expect(f.shadows.get('net-1')?.slot).toBe('01'); expect(f.memberships.get('pc-01')?.role).toBe('operator'); expect(f.read().slots['01'].boardKey).toContain('pcp_board_new'); expect(f.audits[0].action).toBe('shadow_assigned'); });
  it('assign refuses disabled Netzer user', async () => { const f = fixture(); f.seed('01'); await expect(f.core.assign('disabled', 'Name', ['money'])).rejects.toThrow('not active'); });
  it('assign refuses unknown Netzer user', async () => { const f = fixture(); f.seed('01'); await expect(f.core.assign('unknown', 'Name', ['money'])).rejects.toThrow('not active'); });
  it('assign refuses empty classes', async () => { const f = fixture(); f.seed('01'); await expect(f.core.assign('net-1', 'Name', [])).rejects.toThrow('valid classes'); });
  it('assign refuses a second active shadow', async () => { const f = fixture(); f.seed('01', 'assigned'); f.seed('02'); await expect(f.core.assign('net-1', 'Name', ['money'])).rejects.toThrow('already'); });
  it('assign never reuses retired slot', async () => { const f = fixture(); f.seed('01', 'retired'); f.seed('02'); await f.core.assign('net-2', 'Name', ['money']); expect(f.shadows.get('net-2')?.slot).toBe('02'); });
  it('rotate deletes the old key and stores the new one', async () => { const f = fixture(); f.seed('01', 'assigned'); await f.core.rotate('net-1'); expect(f.keys.get(oldKey)?.revokedAt).toBe('now'); expect(f.read().slots['01'].boardKey).not.toBe(oldKey); });
  it('retire archives membership and nulls the key', async () => { const f = fixture(); f.seed('01', 'assigned'); await f.core.retire('net-1'); expect(f.memberships.has('pc-01')).toBe(false); expect(f.read().slots['01'].boardKey).toBeNull(); expect(f.slots.get('01')?.state).toBe('retired'); });
  it('check passes on a healthy pool', async () => { const f = fixture(); f.seed('01', 'assigned'); expect(await f.core.check()).toBe(true); expect(f.lines).toEqual(['check 1 assigned slots healthy']); });
  it('check fails on a mismatched user id', async () => { const f = fixture(); f.seed('01', 'assigned'); f.slots.set('01', { ...f.slots.get('01')!, paperclipUserId: 'wrong' }); expect(await f.core.check()).toBe(false); expect(f.lines).toEqual(['01 identity_mismatch']); });
  it('never prints a key, a password or an email', async () => {
    const f = fixture(); f.seed('01'); const thrown: string[] = [];
    const capture = async (run: () => Promise<unknown>) => { try { await run(); } catch (error) { thrown.push(error instanceof Error ? error.message : String(error)); } };
    await capture(() => f.core.pool(1)); await capture(() => f.core.assign('net-1', 'Name', ['money']));
    await capture(() => f.core.check()); await capture(() => f.core.list()); await capture(() => f.core.rotate('net-1'));
    await capture(() => f.core.retire('net-1')); await capture(() => f.core.probe());
    await capture(() => f.core.rotate('net-1')); f.close(); await capture(() => f.core.pool(2));
    const output = [...f.lines, ...thrown].join('\n');
    expect(thrown).toEqual(expect.arrayContaining(['Active shadow assignment missing', 'Pool can only be made inside the sign-up window']));
    for (const value of [email, password, oldKey, 'pcp_board_new_secret']) expect(output).not.toContain(value);
  });
});
