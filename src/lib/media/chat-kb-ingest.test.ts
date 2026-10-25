import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  getConfigMock,
  killSwitchMock,
  ingestDocumentMock,
  documentExistsMock,
  loadAgentMock,
  writeAuditMock,
} = vi.hoisted(() => ({
  getConfigMock: vi.fn(),
  killSwitchMock: vi.fn(),
  ingestDocumentMock: vi.fn(),
  documentExistsMock: vi.fn(),
  loadAgentMock: vi.fn(),
  writeAuditMock: vi.fn(),
}));

vi.mock('../state/runtime-config-repo.js', () => ({
  getConfig: getConfigMock,
}));
vi.mock('../state/kill-switches-repo.js', () => ({
  isKillSwitchActive: killSwitchMock,
}));
vi.mock('../vectors/ingest.js', () => ({
  ingestDocument: ingestDocumentMock,
}));
vi.mock('../vectors/store.js', () => ({
  documentExists: documentExistsMock,
}));
vi.mock('../config/agent-loader.js', () => ({
  loadAgent: loadAgentMock,
  DEFAULT_KNOWLEDGE_SCOPE: 'default',
  SHARED_KNOWLEDGE_SCOPE: 'shared',
}));
vi.mock('../audit/audit-writer.js', () => ({
  writeAudit: writeAuditMock,
}));

import {
  contentDocId,
  ingestChatMedia,
  ingestFormatFor,
  buildKbConfirmation,
} from './chat-kb-ingest.js';
import { chatKnowledgeScope, ownerTag } from '../vectors/scope-access.js';

const baseArgs = {
  targetAgentId: 'ops',
  chatId: 'owner:emmanuel',
  surface: 'telegram' as const,
  uploaderId: 'telegram-user-42',
  fileName: 'report.pdf',
  bytes: Buffer.from('%PDF-1.4 fake pdf bytes'),
  sourceS3Url: 's3://raw/telegram/x/report.pdf',
};

beforeEach(() => {
  vi.clearAllMocks();
  killSwitchMock.mockResolvedValue({ active: false });
  getConfigMock.mockResolvedValue(undefined);
  documentExistsMock.mockResolvedValue(false);
  loadAgentMock.mockResolvedValue({ knowledgeScope: 'ops-scope' });
  ingestDocumentMock.mockImplementation(async (a: { scope: string }) => ({
    docId: 'chat-abc',
    scope: a.scope,
    chunks: 7,
    failed: 0,
    uploadedAt: '2026-06-12T00:00:00Z',
  }));
});

// NZR-6: the uploading chat's private scope, for baseArgs.
const CHAT_SCOPE = chatKnowledgeScope('ops', 'owner:emmanuel', 'telegram-user-42');

describe('contentDocId', () => {
  it('is stable for the same bytes and differs for different bytes', () => {
    const a = contentDocId(Buffer.from('hello'));
    const b = contentDocId(Buffer.from('hello'));
    const c = contentDocId(Buffer.from('world'));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^chat-[0-9a-f]{24}$/);
  });
});

describe('ingestFormatFor', () => {
  it('maps known extensions and rejects others', () => {
    expect(ingestFormatFor('a.pdf')).toBe('pdf');
    expect(ingestFormatFor('a.DOCX')).toBe('docx');
    expect(ingestFormatFor('a.pptx')).toBe('pptx');
    expect(ingestFormatFor('a.md')).toBe('markdown');
    expect(ingestFormatFor('a.html')).toBe('html');
    expect(ingestFormatFor('a.txt')).toBe('text');
    expect(ingestFormatFor('a.csv')).toBe('text');
    expect(ingestFormatFor('a.png')).toBeNull();
    expect(ingestFormatFor('a.zip')).toBeNull();
  });
});

describe('ingestChatMedia', () => {
  // NZR-6 rewrite (was: "ingests a document into the agent scope", the leak).
  it("ingests a document into the uploading chat's private scope with chat and owner tags", async () => {
    const result = await ingestChatMedia(baseArgs);
    expect(result).toEqual({
      docId: 'chat-abc',
      scope: CHAT_SCOPE,
      chunks: 7,
      deduped: false,
    });
    expect(ingestDocumentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: CHAT_SCOPE,
        docTitle: 'report.pdf',
        format: 'pdf',
        tags: ['chat', 'telegram', 'agent:ops', ownerTag('telegram-user-42')],
      }),
    );
    expect(loadAgentMock).not.toHaveBeenCalled();
    expect(writeAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'knowledge_ingest', result: 'ok' }),
    );
  });

  it('returns null when the kill switch is active and never ingests', async () => {
    killSwitchMock.mockResolvedValue({ active: true, reason: 'test' });
    expect(await ingestChatMedia(baseArgs)).toBeNull();
    expect(ingestDocumentMock).not.toHaveBeenCalled();
  });

  it('returns null when the runtime flag is off', async () => {
    getConfigMock.mockImplementation(async (_cat: string, key: string) =>
      key === 'chat_kb_ingest_enabled' ? '0' : undefined,
    );
    expect(await ingestChatMedia(baseArgs)).toBeNull();
    expect(ingestDocumentMock).not.toHaveBeenCalled();
  });

  it('short-circuits as deduped when the doc already exists', async () => {
    documentExistsMock.mockResolvedValue(true);
    const result = await ingestChatMedia(baseArgs);
    expect(result?.deduped).toBe(true);
    expect(ingestDocumentMock).not.toHaveBeenCalled();
  });

  // NZR-6 rewrite (was: "uses the shared scope when configured", the leak).
  it('ignores a shared-scope config and stays in the chat scope', async () => {
    getConfigMock.mockImplementation(async (_cat: string, key: string) =>
      key === 'chat_kb_ingest_scope' ? 'shared' : undefined,
    );
    await ingestChatMedia(baseArgs);
    expect(ingestDocumentMock).toHaveBeenCalledWith(
      expect.objectContaining({ scope: CHAT_SCOPE }),
    );
  });

  it('returns null when the file exceeds the size cap', async () => {
    getConfigMock.mockImplementation(async (_cat: string, key: string) =>
      key === 'chat_kb_ingest_max_bytes' ? '10' : undefined,
    );
    expect(await ingestChatMedia(baseArgs)).toBeNull();
    expect(ingestDocumentMock).not.toHaveBeenCalled();
  });

  it('returns null for unsupported formats', async () => {
    expect(
      await ingestChatMedia({ ...baseArgs, fileName: 'photo.png' }),
    ).toBeNull();
    expect(ingestDocumentMock).not.toHaveBeenCalled();
  });

  it('ingests a transcript as audio format', async () => {
    const result = await ingestChatMedia({
      ...baseArgs,
      bytes: undefined,
      fileName: 'standup.mp4',
      transcript: 'we shipped the thing',
      extraTags: ['video'],
    });
    expect(result?.deduped).toBe(false);
    expect(ingestDocumentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        format: 'audio',
        content: 'we shipped the thing',
        tags: ['chat', 'telegram', 'agent:ops', ownerTag('telegram-user-42'), 'video'],
      }),
    );
  });

  it('never throws into the turn: ingest failure returns null and audits error', async () => {
    ingestDocumentMock.mockRejectedValue(new Error('bedrock down'));
    expect(await ingestChatMedia(baseArgs)).toBeNull();
    expect(writeAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'knowledge_ingest', result: 'error' }),
    );
  });

  // NZR-6 rewrite (was: "falls back to default scope when loadAgent fails", the leak).
  it('never falls back to the default scope when loadAgent fails', async () => {
    loadAgentMock.mockRejectedValue(new Error('no agent'));
    await ingestChatMedia(baseArgs);
    expect(ingestDocumentMock).toHaveBeenCalledWith(
      expect.objectContaining({ scope: CHAT_SCOPE }),
    );
  });
});

describe('buildKbConfirmation', () => {
  // NZR-6 rewrite (was: "mentions cross-surface availability", a false promise).
  it('says the file is available in this chat', () => {
    const text = buildKbConfirmation(
      { docId: 'chat-x', scope: CHAT_SCOPE, chunks: 3, deduped: false },
      'deck.pptx',
    );
    expect(text).toBe('📚 Indexed deck.pptx (3 chunks). Ask me about it in this chat.');
    expect(text).not.toContain('Slack');
  });

  it('says already-indexed for dedups', () => {
    const text = buildKbConfirmation(
      { docId: 'chat-x', scope: 'default', chunks: 0, deduped: true },
      'deck.pptx',
    );
    expect(text).toContain('already in the knowledge base');
  });
});
