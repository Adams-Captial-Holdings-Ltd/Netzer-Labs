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

const baseArgs = {
  targetAgentId: 'ops',
  chatId: 'owner:emmanuel',
  surface: 'telegram' as const,
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
  ingestDocumentMock.mockResolvedValue({
    docId: 'chat-abc',
    scope: 'ops-scope',
    chunks: 7,
    failed: 0,
    uploadedAt: '2026-06-12T00:00:00Z',
  });
});

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
  it('ingests a document into the agent scope with chat tags', async () => {
    const result = await ingestChatMedia(baseArgs);
    expect(result).toEqual({
      docId: 'chat-abc',
      scope: 'ops-scope',
      chunks: 7,
      deduped: false,
    });
    expect(ingestDocumentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: 'ops-scope',
        docTitle: 'report.pdf',
        format: 'pdf',
        tags: ['chat', 'telegram', 'agent:ops'],
      }),
    );
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

  it('uses the shared scope when configured', async () => {
    getConfigMock.mockImplementation(async (_cat: string, key: string) =>
      key === 'chat_kb_ingest_scope' ? 'shared' : undefined,
    );
    await ingestChatMedia(baseArgs);
    expect(ingestDocumentMock).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'shared' }),
    );
    expect(loadAgentMock).not.toHaveBeenCalled();
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
        tags: ['chat', 'telegram', 'agent:ops', 'video'],
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

  it('falls back to default scope when loadAgent fails', async () => {
    loadAgentMock.mockRejectedValue(new Error('no agent'));
    await ingestChatMedia(baseArgs);
    expect(ingestDocumentMock).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'default' }),
    );
  });
});

describe('buildKbConfirmation', () => {
  it('mentions cross-surface availability for fresh ingests', () => {
    const text = buildKbConfirmation(
      { docId: 'chat-x', scope: 'default', chunks: 3, deduped: false },
      'deck.pptx',
    );
    expect(text).toContain('deck.pptx');
    expect(text).toContain('3 chunks');
    expect(text).toContain('Slack');
  });

  it('says already-indexed for dedups', () => {
    const text = buildKbConfirmation(
      { docId: 'chat-x', scope: 'default', chunks: 0, deduped: true },
      'deck.pptx',
    );
    expect(text).toContain('already in the knowledge base');
  });
});
