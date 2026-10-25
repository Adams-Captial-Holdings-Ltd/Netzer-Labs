import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';

/**
 * NZR-6 frozen tests: a file added to knowledge from a chat lands in that
 * chat's private scope, bound to the uploader. Config and agent settings cannot
 * widen it, no uploader means no ingest, and dedup never crosses chats.
 */

const h = vi.hoisted(() => ({
  getConfig: vi.fn(),
  killSwitch: vi.fn(),
  ingestDocument: vi.fn(),
  documentExists: vi.fn(),
  loadAgent: vi.fn(),
  writeAudit: vi.fn(),
}));

vi.mock('../state/runtime-config-repo.js', () => ({ getConfig: h.getConfig }));
vi.mock('../state/kill-switches-repo.js', () => ({ isKillSwitchActive: h.killSwitch }));
vi.mock('../vectors/ingest.js', () => ({ ingestDocument: h.ingestDocument }));
vi.mock('../vectors/store.js', () => ({ documentExists: h.documentExists }));
vi.mock('../config/agent-loader.js', () => ({
  loadAgent: h.loadAgent,
  DEFAULT_KNOWLEDGE_SCOPE: 'default',
  SHARED_KNOWLEDGE_SCOPE: 'shared',
}));
vi.mock('../audit/audit-writer.js', () => ({ writeAudit: h.writeAudit }));

import { ingestChatMedia, buildKbConfirmation, contentDocId } from './chat-kb-ingest.js';
import { chatKnowledgeScope, normalizeScope } from '../vectors/scope-access.js';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const ALICE = 'dashboard:user:alice';
const BOB = 'dashboard:user:bob';
const SA = `chat_${sha(`ops|dashboard:chatA|${ALICE}`).slice(0, 24)}`;
const SB = `chat_${sha(`ops|dashboard:chatB|${BOB}`).slice(0, 24)}`;
const BYTES = Buffer.from('%PDF-1.4 fake report bytes');

const argsA = {
  targetAgentId: 'ops',
  chatId: 'dashboard:chatA',
  surface: 'dashboard' as const,
  uploaderId: ALICE,
  fileName: 'report.pdf',
  bytes: BYTES,
  sourceS3Url: 's3://raw/dashboard/dashboard:chatA/report.pdf',
};
const argsB = { ...argsA, chatId: 'dashboard:chatB', uploaderId: BOB };

beforeEach(() => {
  vi.clearAllMocks();
  h.killSwitch.mockResolvedValue({ active: false });
  h.getConfig.mockResolvedValue(undefined);
  h.documentExists.mockResolvedValue(false);
  h.loadAgent.mockResolvedValue({ knowledgeScope: 'ops_private' });
  h.ingestDocument.mockImplementation(async (a: { docId: string; scope: string }) => ({
    docId: a.docId,
    scope: a.scope,
    chunks: 7,
    failed: 0,
    uploadedAt: '2026-10-25T00:00:00Z',
  }));
  h.writeAudit.mockResolvedValue(undefined);
});

const ingestedScopes = () => h.ingestDocument.mock.calls.map((c) => (c[0] as { scope: string }).scope);

describe('NZR-6 chat uploads go to the uploading chat only', () => {
  it("F6-1 ingests a chat-added document into the uploading chat's private scope, not the agent scope", async () => {
    expect(chatKnowledgeScope('ops', 'dashboard:chatA', ALICE)).toBe(SA);
    // The derived name is its own S3 prefix: normalizeScope leaves it alone.
    expect(normalizeScope(SA)).toBe(SA);

    const result = await ingestChatMedia(argsA);
    expect(result).toEqual({ docId: contentDocId(BYTES), scope: SA, chunks: 7, deduped: false });
    expect(['ops_private', 'default', 'shared']).not.toContain(SA);
    expect(h.ingestDocument).toHaveBeenCalledTimes(1);
    expect(h.ingestDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: SA,
        tags: ['chat', 'dashboard', 'agent:ops', `owner:${sha(ALICE).slice(0, 16)}`],
      }),
    );
    expect(buildKbConfirmation(result!, 'report.pdf')).toBe('📚 Indexed report.pdf (7 chunks). Ask me about it in this chat.');
  });

  it('F6-2 ignores media/chat_kb_ingest_scope=shared for chat uploads', async () => {
    h.getConfig.mockImplementation(async (_c: string, key: string) => (key === 'chat_kb_ingest_scope' ? 'shared' : undefined));
    await ingestChatMedia(argsA);
    expect(ingestedScopes()).toEqual([SA]);
  });

  it('F6-3 uses the chat-private scope, never default, when the agent config cannot load', async () => {
    h.loadAgent.mockRejectedValue(new Error('no agent'));
    await ingestChatMedia(argsA);
    h.loadAgent.mockResolvedValue({});
    await ingestChatMedia(argsA);
    expect(ingestedScopes()).toEqual([SA, SA]);
  });

  it('F6-4 does not deduplicate across chats', async () => {
    const docId = contentDocId(BYTES);
    // A already added report.pdf in chatA.
    h.documentExists.mockImplementation(async (scope: string, id: string) => scope === SA && id === docId);
    const result = await ingestChatMedia(argsB);
    expect(h.documentExists.mock.calls).toEqual([[SB, docId]]);
    expect(ingestedScopes()).toEqual([SB]);
    expect(result?.deduped).toBe(false);
    expect(buildKbConfirmation(result!, 'report.pdf')).not.toContain('already in the knowledge base');
  });

  it('F6-10 refuses to ingest a chat file with no uploader', async () => {
    for (const uploaderId of ['', undefined as unknown as string]) {
      h.writeAudit.mockClear();
      expect(await ingestChatMedia({ ...argsA, uploaderId })).toBeNull();
      expect(h.writeAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'knowledge_ingest',
          result: 'blocked',
          detail: expect.objectContaining({ reason: 'no_uploader' }),
        }),
      );
    }
    expect(h.ingestDocument).not.toHaveBeenCalled();
    expect(h.documentExists).not.toHaveBeenCalled();
  });
});
