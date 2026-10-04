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
  const entries: Record<string, { boardKey: string | null }> = {};
  const setups: Record<string, { email: string; password: string }> = {};
  const people = new Map<string, string>();
  const keys = new Map<string, { id: string; name: string; owner: string; revokedAt: string | null }>();
  const memberships = new Map<string, { id: string; role: string }>();
  const lines: string[] = []; const calls: string[] = []; const audits: AuditEvent[] = [];
  let closed = false; let serial = 0;
  let failPoint = '';
  const crash = (point: string) => {
    if (failPoint === point) { failPoint = ''; throw new Error('crash'); }
  };
  let secret = JSON.stringify({ v: 1, slots: entries });
  let setupSecret = JSON.stringify({ v: 1, slots: setups });
  const rows: ShadowRows = {
    async getSlot(slot) { return slots.get(slot); }, async listSlots() { return [...slots.values()]; },
    async getByNetzerUser(id) { return shadows.get(id); },
    async getByPaperclipUser(id) { return [...shadows.values()].find((s) => s.paperclipUserId === id); },
    async createSlot({ slot, paperclipUserId }) { crash('row create'); if (slots.has(slot)) return false; slots.set(slot, { slot, paperclipUserId, state: 'free' }); return true; },
    async assign({ slot, netzerUserId, decisionClasses, now }) {
      crash('row assign');
      if (failPoint === 'lost race') { failPoint = ''; return false; }
      const row = slots.get(slot); if (!row || row.state !== 'free' || shadows.get(netzerUserId)?.status === 'active') return false;
      slots.set(slot, { ...row, state: 'assigned', netzerUserId, assignedAt: now });
      shadows.set(netzerUserId, { slot, netzerUserId, paperclipUserId: row.paperclipUserId, decisionClasses: [...decisionClasses], assignedAt: now, status: 'active' });
      return true;
    },
    async retire({ netzerUserId, now }) {
      crash('row retire');
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
    if (path === '/api/auth/sign-up/email') crash('sign up');
    if (path === '/api/auth/sign-in/email') crash('sign in');
    if (path === '/api/auth/get-session') crash('session');
    if (path === '/api/auth/profile') crash('profile');
    if (path === '/api/board-api-keys' && method === 'POST') crash('mint');
    if (path === '/api/board-api-keys' && method === 'GET') crash('list keys');
    if (path.includes('/company-access')) crash('archive' === failPoint ? 'archive' : 'grant');
    if (path.includes('/members/member-')) crash('role');
    if (path.startsWith('/api/board-api-keys/') && method === 'DELETE') crash('delete');
    if (path === '/api/cli-auth/me' && memberships.has(owner ?? '')) crash('assign verify');
    if (path === '/api/cli-auth/me' && !memberships.has(owner ?? '')) crash('retire verify');
    if (path === '/api/cli-auth/me' && calls.some((call) => call.startsWith('DELETE /api/board-api-keys/'))) crash('rotate verify');
    if (path === '/api/auth/sign-up/email' && method === 'POST') {
      if (failPoint === 'signup 500') { failPoint = ''; return json({}, 500); }
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
    keys: { read: async () => secret, write: async (value) => { crash('runtime write'); crash('key write'); crash('store'); crash('key clear'); secret = value; } },
    setup: { read: async () => setupSecret, write: async (value) => { crash('setup write'); setupSecret = value; } },
    paperclipSecret: { read: async () => JSON.stringify({ signup_probe_email: email }) }, rows,
    users: { get: async (id) => peopleStatus.has(id) ? { status: peopleStatus.get(id)! } : null },
    audit: async (event) => { crash('audit'); audits.push(event); }, now: () => 100,
    randomHex: (bytes) => bytes === 32 ? password : 'abcd1234', out: (line) => { lines.push(line); },
  };
  const peopleStatus = new Map([['net-1', 'active'], ['net-2', 'active'], ['disabled', 'disabled']]);
  function seed(slot: string, state: ShadowSlot['state'] = 'free', user = 'net-1') {
    const id = `pc-${slot}`; const address = slot === '01' ? email : `shadow-${slot}-secret@netzer.invalid`;
    people.set(address, id); slots.set(slot, { slot, paperclipUserId: id, state, ...(state !== 'free' ? { netzerUserId: user } : {}) });
    entries[slot] = { boardKey: state === 'assigned' ? oldKey : null };
    setups[slot] = { email: address, password };
    secret = JSON.stringify({ v: 1, slots: entries });
    setupSecret = JSON.stringify({ v: 1, slots: setups });
    if (state !== 'free') shadows.set(user, { slot, netzerUserId: user, paperclipUserId: id, decisionClasses: ['money'], status: state === 'assigned' ? 'active' : 'retired', assignedAt: 1 });
    if (state === 'assigned') { memberships.set(id, { id: `member-${id}`, role: 'operator' }); keys.set(oldKey, { id: `key-old-${slot}`, name: `netzer-shadow-${slot}-old`, owner: id, revokedAt: null }); }
  }
  return { core: createShadowCore(deps), deps, rows, slots, shadows, lines, calls, audits, keys, memberships, seed,
    close: () => { closed = true; }, crashAt: (point: string) => { failPoint = point; },
    status: (id: string, value: string) => peopleStatus.set(id, value),
    read: () => JSON.parse(secret) as { slots: Record<string, { boardKey: string | null }> },
    setupRead: () => JSON.parse(setupSecret) as { slots: Record<string, { email: string; password: string }> },
  };
}

describe('shadow operator core', () => {
  it('pool creates missing slots', async () => { const f = fixture(); f.seed('01'); await f.core.pool(3); expect([...f.slots.keys()]).toEqual(['01', '02', '03']); expect(f.read().slots['02'].boardKey).toBeNull(); });
  it('pool second run creates none', async () => { const f = fixture(); await f.core.pool(2); const count = f.calls.filter((c) => c.includes('sign-up')).length; await f.core.pool(2); expect(f.calls.filter((c) => c.includes('sign-up'))).toHaveLength(count); });
  it('pool refuses closed sign-up', async () => { const f = fixture(); f.close(); await expect(f.core.pool(1)).rejects.toThrow('sign-up window'); });
  it.each([0, 100, 1.5])('pool refuses size %s', async (size) => {
    await expect(fixture().core.pool(size)).rejects.toThrow('1..99');
  });
  it('pool exposes a non-400 sign-up error by status only', async () => {
    const f = fixture(); f.crashAt('signup 500');
    await expect(f.core.pool(1)).rejects.toThrow('HTTP 500');
    await f.core.pool(1);
    expect(f.slots.get('01')?.state).toBe('free');
  });
  it('assign takes lowest free slot and grants operator', async () => { const f = fixture(); f.seed('02'); f.seed('01'); await f.core.assign('net-1', 'Emmanuel', ['money']); expect(f.shadows.get('net-1')?.slot).toBe('01'); expect(f.memberships.get('pc-01')?.role).toBe('operator'); expect(f.read().slots['01'].boardKey).toContain('pcp_board_new'); expect(f.audits[0].action).toBe('shadow_assigned'); });
  it('assign refuses disabled Netzer user', async () => { const f = fixture(); f.seed('01'); await expect(f.core.assign('disabled', 'Name', ['money'])).rejects.toThrow('not active'); });
  it('assign refuses unknown Netzer user', async () => { const f = fixture(); f.seed('01'); await expect(f.core.assign('unknown', 'Name', ['money'])).rejects.toThrow('not active'); });
  it('assign refuses empty classes', async () => { const f = fixture(); f.seed('01'); await expect(f.core.assign('net-1', 'Name', [])).rejects.toThrow('valid classes'); });
  it('assign resumes an active shadow after an audit failure', async () => { const f = fixture(); f.seed('01', 'assigned'); await f.core.assign('net-1', 'Name', ['money']); expect(f.audits[0].action).toBe('shadow_assigned'); });
  it('assign never reuses retired slot', async () => { const f = fixture(); f.seed('01', 'retired'); f.seed('02'); await f.core.assign('net-2', 'Name', ['money']); expect(f.shadows.get('net-2')?.slot).toBe('02'); });
  it('assign works after a lost row race', async () => {
    const f = fixture(); f.seed('01'); f.crashAt('lost race');
    await expect(f.core.assign('net-1', 'Name', ['money'])).rejects.toThrow('lost a race');
    await f.core.assign('net-1', 'Name', ['money']);
    expect(f.shadows.get('net-1')?.status).toBe('active');
    expect([...f.keys.values()].filter((key) => !key.revokedAt)).toHaveLength(1);
  });
  it('rotate deletes the old key and stores the new one', async () => { const f = fixture(); f.seed('01', 'assigned'); await f.core.rotate('net-1'); expect(f.keys.get(oldKey)?.revokedAt).toBe('now'); expect(f.read().slots['01'].boardKey).not.toBe(oldKey); });
  it('rotate revokes an orphan key as well', async () => {
    const f = fixture(); f.seed('01', 'assigned');
    f.keys.set('orphan-secret', { id: 'orphan-id', name: 'netzer-shadow-01-orphan', owner: 'pc-01', revokedAt: null });
    await f.core.rotate('net-1');
    expect(f.keys.get('orphan-secret')?.revokedAt).toBe('now');
    expect([...f.keys.values()].filter((key) => !key.revokedAt)).toHaveLength(1);
  });
  it('retire archives membership and nulls the key', async () => { const f = fixture(); f.seed('01', 'assigned'); await f.core.retire('net-1'); expect(f.memberships.has('pc-01')).toBe(false); expect(f.read().slots['01'].boardKey).toBeNull(); expect(f.slots.get('01')?.state).toBe('retired'); });
  it('check passes on a healthy pool', async () => { const f = fixture(); f.seed('01', 'assigned'); expect(await f.core.check()).toBe(true); expect(f.lines).toEqual(['check 1 assigned slots healthy']); });
  it('check fails on a mismatched user id', async () => { const f = fixture(); f.seed('01', 'assigned'); f.slots.set('01', { ...f.slots.get('01')!, paperclipUserId: 'wrong' }); expect(await f.core.check()).toBe(false); expect(f.lines).toEqual(['01 identity_mismatch']); });
  it('check refuses an empty table', async () => {
    const f = fixture();
    expect(await f.core.check()).toBe(false);
    expect(f.lines).toEqual(['no slot rows found in table unknown']);
  });
  it('check names an unreachable Paperclip separately from a rejected key', async () => {
    const f = fixture(); f.seed('01', 'assigned');
    const normal = f.deps.fetchFn;
    f.deps.fetchFn = async (input, init) => {
      if (String(input).endsWith('/api/cli-auth/me')) throw new TypeError('offline');
      return normal(input, init);
    };
    expect(await f.core.check()).toBe(false);
    expect(f.lines.at(-1)).toBe('01 paperclip_unreachable');
    f.deps.fetchFn = normal;
    f.keys.set(oldKey, { ...f.keys.get(oldKey)!, revokedAt: 'now' });
    expect(await f.core.check()).toBe(false);
    expect(f.lines.at(-1)).toBe('01 key_invalid');
  });
  it('check reads the key secret once for multiple rows', async () => {
    const f = fixture(); f.seed('01', 'assigned'); f.seed('02', 'assigned', 'net-2');
    const read = f.deps.keys.read; let count = 0;
    f.deps.keys.read = async () => { count++; return read(); };
    await f.core.check();
    expect(count).toBe(1);
  });
  it('probe names an unreadable Paperclip secret', async () => {
    const f = fixture(); f.deps.paperclipSecret.read = async () => '{broken';
    expect(await f.core.probe()).toBe(false);
    expect(f.lines).toEqual(['paperclip_secret_unreadable']);
  });
  it('list prints no classes for a retired slot', async () => {
    const f = fixture(); f.seed('01', 'retired');
    await f.core.list();
    expect(f.lines).toEqual(['01 retired net-1 -']);
  });
  it.each(['setup write', 'sign up', 'session', 'row create', 'runtime write'])('pool resumes after %s fails', async (step) => {
    const f = fixture(); f.crashAt(step);
    await expect(f.core.pool(1)).rejects.toThrow();
    await f.core.pool(1);
    expect(f.slots.get('01')?.state).toBe('free');
    expect(f.setupRead().slots['01'].password).toBe(password);
    expect(f.read().slots['01'].boardKey).toBeNull();
  });
  it.each(['sign in', 'profile', 'list keys', 'mint', 'grant', 'role', 'assign verify', 'key write', 'row assign', 'audit'])(
    'assign resumes after %s fails', async (step) => {
    const f = fixture(); f.seed('01'); f.crashAt(step);
    await expect(f.core.assign('net-1', 'Name', ['money'])).rejects.toThrow();
    await f.core.assign('net-1', 'Name', ['money']);
    expect(f.shadows.get('net-1')?.status).toBe('active');
    expect([...f.keys.entries()].filter(([, key]) => key.owner === 'pc-01' && !key.revokedAt)).toHaveLength(1);
    expect(f.keys.get(f.read().slots['01'].boardKey ?? '')?.owner).toBe('pc-01');
    expect(f.keys.get(f.read().slots['01'].boardKey ?? '')?.revokedAt).toBeNull();
  });
  it.each(['list keys', 'mint', 'store', 'delete', 'rotate verify', 'audit'])('rotate resumes after %s fails', async (step) => {
    const f = fixture(); f.seed('01', 'assigned'); f.crashAt(step);
    await expect(f.core.rotate('net-1')).rejects.toThrow();
    await f.core.rotate('net-1');
    expect(f.keys.get(oldKey)?.revokedAt).toBe('now');
    expect([...f.keys.values()].filter((key) => key.owner === 'pc-01' && !key.revokedAt)).toHaveLength(1);
    expect(f.keys.get(f.read().slots['01'].boardKey ?? '')?.revokedAt).toBeNull();
  });
  it.each(['archive', 'retire verify', 'row retire', 'key clear', 'audit'])('retire resumes after %s fails', async (step) => {
    const f = fixture(); f.seed('01', 'assigned'); f.crashAt(step);
    await expect(f.core.retire('net-1')).rejects.toThrow();
    await f.core.retire('net-1');
    expect(f.slots.get('01')?.state).toBe('retired');
    expect(f.shadows.get('net-1')?.retiredAt).toBe(100);
    expect(f.read().slots['01'].boardKey).toBeNull();
    expect(f.audits.at(-1)?.action).toBe('shadow_retired');
  });
  it('never prints a key, a password or an email', async () => {
    const f = fixture(); const thrown: string[] = [];
    const capture = async (run: () => Promise<unknown>) => { try { await run(); } catch (error) { thrown.push(error instanceof Error ? error.message : String(error)); } };
    await capture(() => f.core.pool(1)); await capture(() => f.core.assign('net-1', 'Name', ['money']));
    await capture(() => f.core.check()); await capture(() => f.core.list()); await capture(() => f.core.rotate('net-1'));
    await capture(() => f.core.retire('net-1')); await capture(() => f.core.probe());
    await capture(() => f.core.rotate('net-1')); f.close(); await capture(() => f.core.pool(2));
    const otherLines: string[] = [];
    const otherSecrets: string[] = [];
    const failures = [
      { command: 'pool', steps: ['setup write', 'sign up', 'session', 'row create', 'runtime write'] },
      { command: 'assign', steps: ['sign in', 'profile', 'list keys', 'mint', 'grant', 'role', 'assign verify', 'key write', 'row assign', 'audit'] },
      { command: 'rotate', steps: ['list keys', 'mint', 'store', 'delete', 'rotate verify', 'audit'] },
      { command: 'retire', steps: ['archive', 'retire verify', 'row retire', 'key clear', 'audit'] },
    ];
    for (const group of failures) for (const step of group.steps) {
      const run = fixture();
      if (group.command !== 'pool') run.seed('01', group.command === 'assign' ? 'free' : 'assigned');
      run.crashAt(step);
      if (group.command === 'pool') await capture(() => run.core.pool(1));
      if (group.command === 'assign') await capture(() => run.core.assign('net-1', 'Name', ['money']));
      if (group.command === 'rotate') await capture(() => run.core.rotate('net-1'));
      if (group.command === 'retire') await capture(() => run.core.retire('net-1'));
      otherLines.push(...run.lines);
      otherSecrets.push(...Object.values(run.setupRead().slots).flatMap((entry) => [entry.email, entry.password]));
      otherSecrets.push(...run.keys.keys());
    }
    const output = [...f.lines, ...otherLines, ...thrown].join('\n');
    expect(thrown).toEqual(expect.arrayContaining(['Active shadow assignment missing', 'Pool can only be made inside the sign-up window']));
    const secrets = [...Object.values(f.setupRead().slots).flatMap((entry) => [entry.email, entry.password]),
      ...f.keys.keys(), email, password, oldKey];
    for (const value of [...secrets, ...otherSecrets]) expect(output).not.toContain(value);
  });
});
