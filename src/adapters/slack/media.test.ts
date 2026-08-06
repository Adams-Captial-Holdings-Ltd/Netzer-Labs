import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { getConfigMock, processMediaMock } = vi.hoisted(() => ({
  getConfigMock: vi.fn(),
  processMediaMock: vi.fn(),
}));

vi.mock('../../lib/state/runtime-config-repo.js', () => ({
  getConfig: getConfigMock,
}));
vi.mock('../../lib/media/process.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/media/process.js')>();
  return {
    ...actual, // keep kindForMime/stageLabel — only the pipeline is stubbed
    processMedia: processMediaMock,
    buildKbConfirmation: (kb: { chunks: number }, name: string) =>
      `indexed ${name} (${kb.chunks})`,
  };
});

import { classifySlackFile, downloadSlackFile, processSlackFiles } from './media.js';
import type { SlackFile } from './types.js';

const fetchMock = vi.fn();
const realFetch = global.fetch;

beforeEach(() => {
  vi.clearAllMocks();
  getConfigMock.mockResolvedValue(undefined);
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  global.fetch = realFetch;
});

function slackFile(over: Partial<SlackFile> = {}): SlackFile {
  return {
    id: 'F123',
    name: 'report.pdf',
    mimetype: 'application/pdf',
    size: 1234,
    url_private: 'https://files.slack.com/files-pri/T-F123/report.pdf',
    ...over,
  };
}

function okResponse(bytes: Buffer, contentType = 'application/pdf'): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: (h: string) => (h === 'content-type' ? contentType : null) },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  } as unknown as Response;
}

describe('classifySlackFile', () => {
  it('maps mimetypes to media kinds', () => {
    expect(classifySlackFile(slackFile({ mimetype: 'image/png' }))).toBe('photo');
    expect(classifySlackFile(slackFile({ mimetype: 'audio/mpeg' }))).toBe('audio');
    expect(classifySlackFile(slackFile({ mimetype: 'video/mp4' }))).toBe('video');
    expect(classifySlackFile(slackFile({ mimetype: 'application/pdf' }))).toBe('document');
    expect(classifySlackFile(slackFile({ mimetype: undefined }))).toBe('document');
  });
});

describe('downloadSlackFile', () => {
  it('sends the bot token as a Bearer header', async () => {
    fetchMock.mockResolvedValue(okResponse(Buffer.from('pdf bytes')));
    const out = await downloadSlackFile(slackFile(), 'xoxb-token');
    expect(out?.fileName).toBe('report.pdf');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://files.slack.com/files-pri/T-F123/report.pdf',
      { headers: { Authorization: 'Bearer xoxb-token' } },
    );
  });

  it('prefers url_private_download when present', async () => {
    fetchMock.mockResolvedValue(okResponse(Buffer.from('x')));
    await downloadSlackFile(
      slackFile({ url_private_download: 'https://files.slack.com/dl/report.pdf' }),
      'xoxb',
    );
    expect(fetchMock.mock.calls[0][0]).toBe('https://files.slack.com/dl/report.pdf');
  });

  it('returns null when Slack serves the HTML login page (missing files:read)', async () => {
    fetchMock.mockResolvedValue(okResponse(Buffer.from('<html>login</html>'), 'text/html; charset=utf-8'));
    expect(await downloadSlackFile(slackFile(), 'xoxb')).toBeNull();
  });

  it('returns null on declared oversize without fetching', async () => {
    getConfigMock.mockResolvedValue('100');
    expect(await downloadSlackFile(slackFile({ size: 500 }), 'xoxb')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns null on non-2xx', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 403 } as Response);
    expect(await downloadSlackFile(slackFile(), 'xoxb')).toBeNull();
  });

  it('returns null when there is no private url', async () => {
    expect(await downloadSlackFile(slackFile({ url_private: undefined }), 'xoxb')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('processSlackFiles', () => {
  it('aggregates blocks, transcripts, acks, and kb confirmations', async () => {
    fetchMock.mockResolvedValue(okResponse(Buffer.from('bytes')));
    processMediaMock
      .mockResolvedValueOnce({
        blocks: [{ kind: 'document', format: 'pdf', bytes: Buffer.from('b') }],
        ackText: '',
        kb: { docId: 'chat-1', scope: 'default', chunks: 4, deduped: false },
      })
      .mockResolvedValueOnce({
        blocks: [],
        transcript: 'hello from audio',
        transcriptKind: 'audio',
        ackText: '',
        kb: null,
      });
    const out = await processSlackFiles({
      files: [slackFile(), slackFile({ id: 'F124', name: 'note.mp3', mimetype: 'audio/mpeg' })],
      botToken: 'xoxb',
      agentId: 'main',
      targetAgentId: 'ops',
      chatId: 'owner:emmanuel',
    });
    expect(out.blocks).toHaveLength(1);
    expect(out.transcripts).toEqual([{ text: 'hello from audio', kind: 'audio' }]);
    expect(out.kbConfirmations).toEqual(['indexed report.pdf (4)']);
    expect(out.failed).toBe(0);
    expect(processMediaMock).toHaveBeenCalledWith(
      expect.objectContaining({ surface: 'slack', targetAgentId: 'ops', kind: 'document' }),
      expect.any(Function),
    );
  });

  it('counts failed downloads and continues', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 403 } as Response)
      .mockResolvedValueOnce(okResponse(Buffer.from('bytes')));
    processMediaMock.mockResolvedValue({ blocks: [], ackText: 'stored.', kb: null });
    const out = await processSlackFiles({
      files: [slackFile({ id: 'F1' }), slackFile({ id: 'F2' })],
      botToken: 'xoxb',
      agentId: 'main',
      targetAgentId: 'main',
      chatId: 'slack:C1',
    });
    expect(out.failed).toBe(1);
    expect(out.acks).toEqual(['stored.']);
  });

  it('caps processing at 3 files per message', async () => {
    fetchMock.mockResolvedValue(okResponse(Buffer.from('bytes')));
    processMediaMock.mockResolvedValue({ blocks: [], ackText: '', kb: null });
    await processSlackFiles({
      files: [1, 2, 3, 4, 5].map((i) => slackFile({ id: `F${i}` })),
      botToken: 'xoxb',
      agentId: 'main',
      targetAgentId: 'main',
      chatId: 'slack:C1',
    });
    expect(processMediaMock).toHaveBeenCalledTimes(3);
  });
});
