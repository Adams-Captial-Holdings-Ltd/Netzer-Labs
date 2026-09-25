/** P4 owner routes: real dashboard router, mocked data seams, no AWS account. */
import { beforeEach, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { TokenPrincipal } from '../../lib/auth/dashboard-auth.js';

const { authenticateDashboardToken, getSession, listArtifactHeads, listArtifactVersions,
  presignArtifactDownload, writeAuditOrThrow, send } = vi.hoisted(() => ({
  authenticateDashboardToken: vi.fn(), getSession: vi.fn(), listArtifactHeads: vi.fn(),
  listArtifactVersions: vi.fn(), presignArtifactDownload: vi.fn(), writeAuditOrThrow: vi.fn(), send: vi.fn(),
}));
vi.mock('../../lib/auth/dashboard-auth.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/auth/dashboard-auth.js')>();
  return { ...actual, extractBearerToken: (h?: string) => (h ?? '').replace(/^Bearer\s+/i, ''),
    authenticateDashboardToken: (raw: string) => authenticateDashboardToken(raw) };
});
vi.mock('../../lib/state/sessions-repo.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/state/sessions-repo.js')>();
  return { ...actual, getSession: (...args: unknown[]) => getSession(...args) };
});
vi.mock('../../lib/chat/artifacts-repo.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/chat/artifacts-repo.js')>();
  return { ...actual, listArtifactHeads: (...args: unknown[]) => listArtifactHeads(...args),
    listArtifactVersions: (...args: unknown[]) => listArtifactVersions(...args),
    presignArtifactDownload: (...args: unknown[]) => presignArtifactDownload(...args) };
});
vi.mock('../../lib/audit/audit-writer.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/audit/audit-writer.js')>();
  return { ...actual, writeAuditOrThrow: (event: unknown) => writeAuditOrThrow(event) };
});
vi.mock('../../lib/state/ddb.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/state/ddb.js')>();
  return { ...actual, ddb: () => ({ send }) };
});
vi.mock('../../lib/state/kill-switches-repo.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/state/kill-switches-repo.js')>();
  return { ...actual, isKillSwitchActive: async () => ({ active: false }) };
});
vi.mock('../../observability/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }, truncateForLog: (s: string) => s,
}));

import { buildDashboardRouter } from './handler.js';

const CHAT = 'dashboard:p4-owner-route';
const AID = 'f78d0000-0000-4000-8000-000000000001';
const FULL_URL = 'http://localhost:4566/p4-curated/key?versionId=v1&X-Amz-Signature=full-query';
const OWNER = 'dashboard:user:user-a';
const descriptor = { artifactId: AID, version: 2, fileName: 'report.pdf', contentType: 'application/pdf',
  createdAt: '2026-09-25T00:00:00.000Z' };
const principal: Record<string, TokenPrincipal> = {
  owner: { tokenHash: 'hash-owner', label: 'owner', hashPrefix16: 'owner', role: 'operator', userId: 'user-a' },
  other: { tokenHash: 'hash-other', label: 'other', hashPrefix16: 'other', role: 'operator', userId: 'user-b' },
  admin: { tokenHash: 'hash-admin', label: 'admin', hashPrefix16: 'admin', role: 'admin', userId: 'admin-user' },
};
const session = (ownerId = OWNER) => ({ agentId: 'main', chatId: CHAT, userId: ownerId,
  surface: 'dashboard', turns: [], updatedAt: 1 });
const app = () => { const h = new Hono(); h.route('/api', buildDashboardRouter()); return h; };
const qs = `agentId=main&chatId=${encodeURIComponent(CHAT)}`;
const get = (who: string, path: string) => app().request(path, { headers: { Authorization: `Bearer ${who}` } });
const heads = (who: string) => get(who, `/api/artifacts?${qs}`);
const versions = (who: string) => get(who, `/api/artifacts/versions?${qs}&artifactId=${AID}`);
const download = (who: string) => get(who, `/api/artifacts/download?${qs}&artifactId=${AID}&version=1`);

beforeEach(() => {
  vi.clearAllMocks();
  authenticateDashboardToken.mockImplementation(async (raw: string) => principal[raw] ?? null);
  getSession.mockResolvedValue(session());
  listArtifactHeads.mockResolvedValue([descriptor]);
  listArtifactVersions.mockResolvedValue([{ ...descriptor, version: 1 }, descriptor]);
  presignArtifactDownload.mockResolvedValue(FULL_URL);
  writeAuditOrThrow.mockResolvedValue(undefined);
  send.mockResolvedValue({ Items: [] });
});

it('P4 owner routes return URL free descriptors and immutable version choices', async () => {
  const h = await heads('owner');
  expect(h.status).toBe(200);
  const list = await h.json() as { artifacts: unknown[] };
  expect(list.artifacts).toEqual([descriptor]);
  const v = await versions('owner');
  expect(v.status).toBe(200);
  const choices = await v.json() as { versions: Array<{ version: number }> };
  expect(choices.versions.map((x) => x.version)).toEqual([1, 2]);
  expect(JSON.stringify({ list, choices })).not.toMatch(/X-Amz-|s3Key|s3Bucket|storageKey|https?:\/\//);
  expect(listArtifactHeads).toHaveBeenCalledWith({ agentId: 'main', chatId: CHAT, ownerId: OWNER });
});

it('P4 owner download remints a short lived named link for the exact version', async () => {
  const response = await download('owner');
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ url: FULL_URL, fileName: 'report.pdf', version: 1 });
  expect(presignArtifactDownload).toHaveBeenCalledWith({ agentId: 'main', chatId: CHAT,
    ownerId: OWNER, artifactId: AID, version: 1 });
});

it('P4 missing and foreign artifacts return the same refusal', async () => {
  getSession.mockResolvedValueOnce(session('dashboard:user:user-b'));
  const foreign = await download('owner');
  getSession.mockResolvedValueOnce(null);
  const missing = await download('owner');
  expect(foreign.status).toBe(404);
  expect(missing.status).toBe(404);
  expect(await foreign.text()).toBe(await missing.text());
  expect(presignArtifactDownload).not.toHaveBeenCalled();
});

it('P4 admin artifact reads await their audit and fail closed', async () => {
  getSession.mockResolvedValue(session());
  const order: string[] = [];
  writeAuditOrThrow.mockImplementation(async () => { order.push('audit'); });
  listArtifactHeads.mockImplementation(async () => { order.push('list'); return [descriptor]; });
  const allowed = await heads('admin');
  expect(allowed.status).toBe(200);
  expect(order).toEqual(['audit', 'list']);
  expect(writeAuditOrThrow).toHaveBeenCalledWith(expect.objectContaining({ action: 'session_read_override' }));
  writeAuditOrThrow.mockRejectedValueOnce(new Error('audit stores down'));
  const refused = await heads('admin');
  expect(refused.status).toBeGreaterThanOrEqual(500);
  expect(listArtifactHeads).toHaveBeenCalledTimes(1);
});
