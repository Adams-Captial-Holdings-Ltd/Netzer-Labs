/** P4 owner routes: real dashboard router, mocked data seams, no AWS account. */
import { beforeEach, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { TokenPrincipal } from '../../lib/auth/dashboard-auth.js';

const { authenticateDashboardToken, getSession, listArtifactHeads, listArtifactVersions,
  presignArtifactDownload, saveArtifact, writeAuditOrThrow, send, runAgentTurn, appendTurns, runCommand, listKnownAgents, getFullHistory } = vi.hoisted(() => ({
  authenticateDashboardToken: vi.fn(), getSession: vi.fn(), listArtifactHeads: vi.fn(),
  listArtifactVersions: vi.fn(), presignArtifactDownload: vi.fn(), saveArtifact: vi.fn(), writeAuditOrThrow: vi.fn(), send: vi.fn(),
  runAgentTurn: vi.fn(), appendTurns: vi.fn(), runCommand: vi.fn(), listKnownAgents: vi.fn(), getFullHistory: vi.fn(),
}));
vi.mock('../../lib/auth/dashboard-auth.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/auth/dashboard-auth.js')>();
  return { ...actual, extractBearerToken: (h?: string) => (h ?? '').replace(/^Bearer\s+/i, ''),
    authenticateDashboardToken: (raw: string) => authenticateDashboardToken(raw) };
});
vi.mock('../../lib/state/sessions-repo.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/state/sessions-repo.js')>();
  return { ...actual, getSession: (...args: unknown[]) => getSession(...args),
    appendTurns: (...args: unknown[]) => appendTurns(...args),
    getFullHistory: (...args: unknown[]) => getFullHistory(...args) };
});
vi.mock('../../lib/chat/artifacts-repo.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/chat/artifacts-repo.js')>();
  return { ...actual, listArtifactHeads: (...args: unknown[]) => listArtifactHeads(...args),
    listArtifactVersions: (...args: unknown[]) => listArtifactVersions(...args),
    presignArtifactDownload: (...args: unknown[]) => presignArtifactDownload(...args),
    saveArtifact: (...args: unknown[]) => saveArtifact(...args) };
});
vi.mock('../../agent/agent-loop.js', async (importActual) => {
  const actual = await importActual<typeof import('../../agent/agent-loop.js')>();
  return { ...actual, runAgentTurn: (...args: unknown[]) => runAgentTurn(...args) };
});
vi.mock('../../agent/commands.js', () => ({ runCommand: (...args: unknown[]) => runCommand(...args) }));
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
  runAgentTurn.mockResolvedValue({ text: 'Ready.', modelId: 'model', costUsd: 0, latencyMs: 1, inputTokens: 1, outputTokens: 1, toolCallCount: 0 });
  appendTurns.mockResolvedValue(undefined);
  runCommand.mockResolvedValue(undefined);
  listKnownAgents.mockReturnValue(['main']);
  getFullHistory.mockResolvedValue({ turns: [], truncated: false });
  saveArtifact.mockResolvedValue(descriptor);
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

const stream = () => app().request('/api/test-turn/stream', { method: 'POST',
  headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
  body: JSON.stringify({ agentId: 'main', chatId: CHAT, text: 'Please create the report.' }),
});
const events = (wire: string, name: string): unknown[] => wire.split('\n\n')
  .filter((block) => block.includes(`event: ${name}\n`))
  .map((block) => JSON.parse(block.split('\n').find((line) => line.startsWith('data: '))!.slice(6)));

it('P4 stream publishes only stored artifact references before completion', async () => {
  runAgentTurn.mockResolvedValueOnce({ text: 'Ready.', modelId: 'model', costUsd: 0, latencyMs: 1,
    inputTokens: 1, outputTokens: 1, toolCallCount: 1, artifacts: [descriptor] });
  const response = await stream();
  expect(response.status).toBe(200);
  const wire = await response.text();
  expect(appendTurns, 'transcript write must finish before an artifact is published').toHaveBeenCalledOnce();
  const refs = events(wire, 'artifact_ref');
  expect(refs, 'an additive SSE event carries the durable descriptor').toEqual([descriptor]);
  expect(wire.indexOf('event: artifact_ref')).toBeLessThan(wire.indexOf('event: done'));
  expect(wire).not.toMatch(/X-Amz-|s3Bucket|s3Key|p4-curated/);
  expect(appendTurns.mock.calls[0]![2][1]).toMatchObject({ artifacts: [descriptor] });
});

it('P4 failed artifact persistence never claims a saved file', async () => {
  const grammar = ':::artifact{identifier="notes" type="text/markdown" title="Notes.md"}\n# Private draft\n:::';
  runAgentTurn.mockResolvedValueOnce({ text: `Here is the file.\n${grammar}`, modelId: 'model', costUsd: 0,
    latencyMs: 1, inputTokens: 1, outputTokens: 1, toolCallCount: 0 });
  saveArtifact.mockRejectedValueOnce(new Error('DLP refused private-key'));
  const wire = await (await stream()).text();
  expect(saveArtifact, 'grammar storage must be attempted before claiming a saved file').toHaveBeenCalledOnce();
  expect(events(wire, 'artifact_ref')).toEqual([]);
  expect(wire).not.toMatch(/private-key|saved file|artifact_ref/i);
});

it('P4 transcript restores artifact references without keys or URLs', async () => {
  getFullHistory.mockResolvedValueOnce({ turns: [{ role: 'assistant', text: 'Ready.', ts: 1,
    artifacts: [{ ...descriptor, s3Key: 'private-key', url: FULL_URL }] }], truncated: false });
  const response = await get('owner', `/api/sessions/transcript?${qs}`);
  expect(response.status).toBe(200);
  const transcript = await response.json() as { turns: Array<{ artifacts?: unknown[] }> };
  expect(transcript.turns[0]?.artifacts).toEqual([descriptor]);
  expect(JSON.stringify(transcript)).not.toMatch(/private-key|X-Amz-|s3Key|url/);
});

it('P4 grammar artifacts pass the same safety and ownership checks as tools', async () => {
  const grammar = ':::artifact{identifier="notes" type="text/markdown" title="Notes.md"}\n# Safe notes\nBody\n:::';
  const grammarResult = { text: `Here it is.\n${grammar}`, modelId: 'model', costUsd: 0,
    latencyMs: 1, inputTokens: 1, outputTokens: 1, toolCallCount: 0 };
  runAgentTurn.mockImplementationOnce(async (req: { onChunk?: (text: string) => void }) => {
    req.onChunk?.(grammarResult.text);
    return grammarResult;
  });
  runAgentTurn.mockResolvedValue(grammarResult);
  const first = await (await stream()).text();
  expect(saveArtifact, 'grammar body must use the same CURATED save/DLP seam').toHaveBeenCalledWith(expect.objectContaining({
    agentId: 'main', chatId: CHAT, ownerId: OWNER, fileName: 'Notes.md',
    contentType: 'text/markdown', body: Buffer.from('# Safe notes\nBody'),
  }));
  expect(events(first, 'artifact_ref')).toEqual([descriptor]);
  expect(first, 'artifact source stays off the SSE wire before DLP and after storage').not.toContain('# Safe notes');
  saveArtifact.mockRejectedValueOnce(new Error('blocked DLP secret=private-key'));
  const refused = await (await stream()).text();
  expect(events(refused, 'artifact_ref')).toEqual([]);
  expect(refused).not.toMatch(/private-key|stored artifact|artifact_ref/);
});
