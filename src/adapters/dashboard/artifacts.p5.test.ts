/** P5 preview content route and download names: real dashboard router, mocked data seams, no AWS. */
import { beforeEach, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import JSZip from 'jszip';
import type { TokenPrincipal } from '../../lib/auth/dashboard-auth.js';
import { buildPptx } from '../../lib/documents/pptx.js';

const { authenticateDashboardToken, getSession, listArtifactVersions, presignArtifactDownload,
  readArtifactBody, writeAuditOrThrow, send, listKnownAgents } = vi.hoisted(() => ({
  authenticateDashboardToken: vi.fn(), getSession: vi.fn(), listArtifactVersions: vi.fn(),
  presignArtifactDownload: vi.fn(), readArtifactBody: vi.fn(), writeAuditOrThrow: vi.fn(), send: vi.fn(),
  listKnownAgents: vi.fn(),
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
  return { ...actual,
    listArtifactVersions: (...args: unknown[]) => listArtifactVersions(...args),
    presignArtifactDownload: (...args: unknown[]) => presignArtifactDownload(...args),
    readArtifactBody: (...args: unknown[]) => readArtifactBody(...args) };
});
vi.mock('../../lib/config/agent-loader.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/config/agent-loader.js')>();
  return { ...actual, listKnownAgents: () => listKnownAgents(), listKnownAgentsAsync: async () => listKnownAgents() };
});
vi.mock('../../lib/state/runtime-config-repo.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/state/runtime-config-repo.js')>();
  return { ...actual, getConfig: async () => undefined };
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

const CHAT = 'dashboard:p5-owner-route';
const AID = 'f78d0000-0000-4000-8000-000000000005';
const FULL_URL = 'http://localhost:4566/p5-curated/key?versionId=v1&X-Amz-Signature=full-query';
const OWNER = 'dashboard:user:user-a';
const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const page = { artifactId: AID, version: 1, fileName: 'Quarterly report', contentType: 'text/html',
  createdAt: '2026-09-26T00:00:00.000Z' };
const deckRef = { ...page, fileName: 'Launch deck', contentType: PPTX };
const principal: Record<string, TokenPrincipal> = {
  owner: { tokenHash: 'hash-owner', label: 'owner', hashPrefix16: 'owner', role: 'operator', userId: 'user-a' },
  other: { tokenHash: 'hash-other', label: 'other', hashPrefix16: 'other', role: 'operator', userId: 'user-b' },
  admin: { tokenHash: 'hash-admin', label: 'admin', hashPrefix16: 'admin', role: 'admin', userId: 'admin-user' },
  // A custom profile that grants nothing: it holds no sessions:read.
  noread: { tokenHash: 'hash-noread', label: 'noread', hashPrefix16: 'noread', role: 'viewer', userId: 'user-c',
    profileId: 'p5-custom-no-sessions' } as TokenPrincipal,
};
const session = (ownerId = OWNER) => ({ agentId: 'main', chatId: CHAT, userId: ownerId,
  surface: 'dashboard', turns: [], updatedAt: 1 });
const app = () => { const h = new Hono(); h.route('/api', buildDashboardRouter()); return h; };
const qs = `agentId=main&chatId=${encodeURIComponent(CHAT)}`;
const get = (who: string, path: string) => app().request(path, { headers: { Authorization: `Bearer ${who}` } });
const content = (who: string, extra = '') =>
  get(who, `/api/artifacts/content?${qs}&artifactId=${AID}&version=1${extra}`);
const download = (who: string) => get(who, `/api/artifacts/download?${qs}&artifactId=${AID}&version=1`);

async function bomb(): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file('ppt/slides/slide1.xml', 'A'.repeat(21 * 1024 * 1024));
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

beforeEach(() => {
  // resetAllMocks, not clearAllMocks: a queued once-answer a red test never used must not
  // leak into the next test (M89).
  vi.resetAllMocks();
  authenticateDashboardToken.mockImplementation(async (raw: string) => principal[raw] ?? null);
  getSession.mockResolvedValue(session());
  listArtifactVersions.mockResolvedValue([page, { ...page, version: 2 }]);
  presignArtifactDownload.mockResolvedValue(FULL_URL);
  readArtifactBody.mockResolvedValue(new TextEncoder().encode('<p>Q3</p>'));
  writeAuditOrThrow.mockResolvedValue(undefined);
  send.mockResolvedValue({ Items: [] });
  listKnownAgents.mockReturnValue(['main']);
});

it('P5 content route returns the exact stored version as an inert attachment', async () => {
  const hostile = new TextEncoder().encode('<!doctype html><script>parent.alert(document.cookie)</script>');
  readArtifactBody.mockResolvedValueOnce(hostile);
  const res = await content('owner');
  expect(res.status).toBe(200);
  expect(Buffer.from(await res.arrayBuffer()).equals(Buffer.from(hostile)), 'the exact stored bytes').toBe(true);
  // Inert: the dashboard origin never renders stored markup, even if this URL is opened directly.
  expect(res.headers.get('content-type')).toBe('application/octet-stream');
  expect(res.headers.get('content-disposition')).toMatch(/^attachment;/);
  expect(res.headers.get('content-disposition')).toContain("filename*=UTF-8''Quarterly%20report.html");
  expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  expect(res.headers.get('content-security-policy')).toMatch(/\bsandbox\b/);
  expect(res.headers.get('content-security-policy')).toMatch(/default-src 'none'/);
  expect(res.headers.get('cache-control')).toBe('no-store');
  expect(readArtifactBody).toHaveBeenCalledWith({ agentId: 'main', chatId: CHAT, ownerId: OWNER,
    artifactId: AID, version: 1 });
});

it('P5 content route gives missing and foreign artifacts the same refusal', async () => {
  getSession.mockResolvedValueOnce(session('dashboard:user:user-b'));
  const foreign = await content('owner');
  getSession.mockResolvedValueOnce(null);
  const missing = await content('owner');
  const noSuchVersion = await get('owner', `/api/artifacts/content?${qs}&artifactId=${AID}&version=9`);
  const otherPerson = await content('other');
  const answers = [foreign, missing, noSuchVersion, otherPerson];
  for (const answer of answers) expect(answer.status).toBe(404);
  const bodies = await Promise.all(answers.map((answer) => answer.text()));
  expect(new Set(bodies).size, 'one indistinguishable refusal').toBe(1);
  // The route's own refusal, not a framework 404 for a route that does not exist (P113).
  expect(JSON.parse(bodies[0]!)).toEqual({ error: 'not_found' });
  expect(readArtifactBody).not.toHaveBeenCalled();
});

it('P5 content route validates its scope and requires sessions read', async () => {
  const bad = [
    `/api/artifacts/content?agentId=..%2Fx&chatId=${encodeURIComponent(CHAT)}&artifactId=${AID}&version=1`,
    `/api/artifacts/content?agentId=main&chatId=telegram%3A1&artifactId=${AID}&version=1`,
    `/api/artifacts/content?${qs}&artifactId=not-a-uuid&version=1`,
    `/api/artifacts/content?${qs}&artifactId=${AID}&version=0`,
    `/api/artifacts/content?${qs}&artifactId=${AID}&version=1.5`,
    `/api/artifacts/content?${qs}&artifactId=${AID}&version=1&view=raw`,
  ];
  for (const path of bad) expect((await get('owner', path)).status, path).toBe(400);
  expect((await content('noread')).status).toBe(403);
  expect(readArtifactBody).not.toHaveBeenCalled();
});

it('P5 admin content reads await their audit and fail closed', async () => {
  const order: string[] = [];
  writeAuditOrThrow.mockImplementation(async () => { order.push('audit'); });
  readArtifactBody.mockImplementation(async () => { order.push('read'); return new Uint8Array([1]); });
  const allowed = await content('admin');
  expect(allowed.status).toBe(200);
  expect(order).toEqual(['audit', 'read']);
  expect(writeAuditOrThrow).toHaveBeenCalledWith(expect.objectContaining({ action: 'session_read_override' }));
  writeAuditOrThrow.mockRejectedValueOnce(new Error('audit stores down'));
  const refused = await content('admin');
  expect(refused.status).toBeGreaterThanOrEqual(500);
  expect(readArtifactBody).toHaveBeenCalledTimes(1);
});

it('P5 slide outline route returns bounded slide text for a deck', async () => {
  listArtifactVersions.mockResolvedValue([deckRef]);
  const deck = await buildPptx({ title: 'Launch', slides: [{ title: 'Why now' }, { title: 'Plan', bullets: ['Ship'] }] });
  readArtifactBody.mockResolvedValueOnce(new Uint8Array(deck));
  const res = await content('owner', '&view=outline');
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toMatch(/^application\/json/);
  const outline = await res.json() as { slides: Array<{ index: number; text: string }>; truncated: boolean };
  expect(outline.truncated).toBe(false);
  expect(outline.slides.map((s) => s.index)).toEqual(outline.slides.map((_, i) => i + 1));
  expect(outline.slides.map((s) => s.text).join('\n')).toMatch(/Why now[\s\S]*Plan[\s\S]*Ship/);
  expect(JSON.stringify(outline)).not.toMatch(/<a:t>|xmlns|X-Amz-|storageKey/);
});

it('P5 slide outline refuses non decks and unsafe archives', async () => {
  // Not a deck: refused from the descriptor alone, before any bytes are read.
  const notDeck = await content('owner', '&view=outline');
  expect(notDeck.status).toBe(400);
  expect(await notDeck.json()).toEqual({ error: 'outline_unsupported' });
  expect(readArtifactBody).not.toHaveBeenCalled();
  // A deck-typed artifact whose bytes are an archive bomb: refused, and the refusal names no internals.
  listArtifactVersions.mockResolvedValue([deckRef]);
  readArtifactBody.mockResolvedValueOnce(await bomb());
  const unsafe = await content('owner', '&view=outline');
  expect(unsafe.status).toBe(422);
  expect(await unsafe.json()).toEqual({ error: 'preview_unavailable' });
});

it('P5 download route returns the extended file name', async () => {
  const res = await download('owner');
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ url: FULL_URL, fileName: 'Quarterly report.html', version: 1 });
  expect(presignArtifactDownload).toHaveBeenCalledWith({ agentId: 'main', chatId: CHAT, ownerId: OWNER,
    artifactId: AID, version: 1 });
});
