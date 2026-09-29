import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  killSwitchMock,
  transcribeMock,
  ingestChatMediaMock,
  writeAuditMock,
  s3SendMock,
  getConfigMock,
  probeVideoMock,
  extractKeyframesMock,
  extractAudioTrackMock,
  writeTempFileMock,
  tempCleanupMock,
} = vi.hoisted(() => ({
  killSwitchMock: vi.fn(),
  transcribeMock: vi.fn(),
  ingestChatMediaMock: vi.fn(),
  writeAuditMock: vi.fn(),
  s3SendMock: vi.fn(),
  getConfigMock: vi.fn(),
  probeVideoMock: vi.fn(),
  extractKeyframesMock: vi.fn(),
  extractAudioTrackMock: vi.fn(),
  writeTempFileMock: vi.fn(),
  tempCleanupMock: vi.fn(),
}));

vi.mock('../state/kill-switches-repo.js', () => ({
  isKillSwitchActive: killSwitchMock,
}));
vi.mock('../transcribe/transcriber.js', () => ({
  transcribeAudio: transcribeMock,
}));
vi.mock('./chat-kb-ingest.js', () => ({
  ingestChatMedia: ingestChatMediaMock,
  ingestFormatFor: (name: string) =>
    /\.(pdf|docx|pptx|txt|md|csv|html)$/i.test(name) ? 'x' : null,
  buildKbConfirmation: vi.fn(),
}));
vi.mock('../audit/audit-writer.js', () => ({
  writeAudit: writeAuditMock,
}));
vi.mock('../state/runtime-config-repo.js', () => ({
  getConfig: getConfigMock,
}));
vi.mock('../video/frames.js', () => ({
  probeVideo: probeVideoMock,
  extractKeyframes: extractKeyframesMock,
  extractAudioTrack: extractAudioTrackMock,
  writeTempFile: writeTempFileMock,
}));
vi.mock('../observability/xray.js', () => ({
  captureAwsClient: <T,>(c: T): T => c,
}));
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class {
    send = s3SendMock;
  },
  PutObjectCommand: class {
    constructor(public input: unknown) {}
  },
}));

process.env.RAW_BUCKET = 'raw-test-bucket';
const { processMedia } = await import('./process.js');

const JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.alloc(16, 1),
]);

function input(over: Record<string, unknown> = {}) {
  return {
    surface: 'telegram' as const,
    agentId: 'main',
    targetAgentId: 'ops',
    chatId: 'owner:emmanuel',
    kind: 'photo' as const,
    fileName: 'pic.jpg',
    bytes: JPEG,
    ...over,
  };
}

const JPEG_FRAME = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff]),
  Buffer.alloc(8, 7),
]);

beforeEach(() => {
  vi.clearAllMocks();
  killSwitchMock.mockResolvedValue({ active: false });
  s3SendMock.mockResolvedValue({});
  ingestChatMediaMock.mockResolvedValue(null);
  getConfigMock.mockResolvedValue(undefined);
  tempCleanupMock.mockResolvedValue(undefined);
  writeTempFileMock.mockResolvedValue({ path: '/tmp/test.mp4', cleanup: tempCleanupMock });
  probeVideoMock.mockResolvedValue({ durationSec: 12, width: 1280, height: 720 });
  extractKeyframesMock.mockResolvedValue([JPEG_FRAME, JPEG_FRAME]);
});

describe('processMedia', () => {
  it('refuses when media_upload_disabled is active', async () => {
    killSwitchMock.mockResolvedValue({ active: true, reason: 'test' });
    const out = await processMedia(input());
    expect(out.ackText).toContain('temporarily disabled');
    expect(out.blocks).toHaveLength(0);
    expect(s3SendMock).not.toHaveBeenCalled();
  });

  it('builds an image block for photos and proceeds (empty ack)', async () => {
    const out = await processMedia(input());
    expect(out.blocks).toEqual([
      expect.objectContaining({ kind: 'image', format: 'jpeg' }),
    ]);
    expect(out.ackText).toBe('');
    expect(out.s3Url).toBe(`s3://raw-test-bucket/${out.s3Key}`);
    expect(out.s3Key).toMatch(/^telegram\/owner:emmanuel\//);
  });

  // P3 (owner decision 3): a chat file enters the knowledge base only when its
  // sender opts in, and Telegram has no opt-in control — so this pdf is read by
  // the model inline and is NOT ingested. (Before P3 every chat document was.)
  it('builds a document block for pdfs and leaves the KB alone without an opt-in', async () => {
    ingestChatMediaMock.mockResolvedValue({
      docId: 'chat-1',
      scope: 'ops-scope',
      chunks: 5,
      deduped: false,
    });
    const out = await processMedia(
      input({ kind: 'document', fileName: 'report.pdf', mimeType: 'application/pdf', bytes: Buffer.from('%PDF-1.4') }),
    );
    expect(out.blocks).toEqual([
      expect.objectContaining({ kind: 'document', format: 'pdf' }),
    ]);
    expect(out.ackText).toBe('');
    expect(out.kb ?? null).toBeNull();
    expect(ingestChatMediaMock).not.toHaveBeenCalled();
  });

  // P3 (WI-3.2): a .docx is a ZIP container, and these bytes are not a ZIP at all,
  // so the bounded ZIP check refuses it before anything opens it: no block, no
  // ingest, and an ack that names the file. (Before P3 it went to the KB unread.)
  it('refuses a docx that is not a real document, and says so', async () => {
    ingestChatMediaMock.mockResolvedValue({
      docId: 'chat-2',
      scope: 'default',
      chunks: 3,
      deduped: false,
    });
    const out = await processMedia(
      input({ kind: 'document', fileName: 'notes.docx', bytes: Buffer.from('zipzip') }),
    );
    expect(out.blocks).toHaveLength(0);
    expect(ingestChatMediaMock).not.toHaveBeenCalled();
    expect(out.ackText).toContain('notes.docx');
  });

  it('voice notes get transcribed and proceed', async () => {
    transcribeMock.mockResolvedValue({ transcript: 'hello world', jobName: 'j1' });
    const out = await processMedia(
      input({ kind: 'voice', fileName: 'note.ogg', mimeType: 'audio/ogg', bytes: Buffer.alloc(10, 2) }),
    );
    expect(out.transcript).toBe('hello world');
    expect(out.transcriptKind).toBe('audio');
    expect(out.ackText).toBe('');
  });

  it('voice transcription failure degrades to an ack', async () => {
    transcribeMock.mockRejectedValue(new Error('transcribe down'));
    const out = await processMedia(
      input({ kind: 'voice', fileName: 'note.ogg', mimeType: 'audio/ogg', bytes: Buffer.alloc(10, 2) }),
    );
    expect(out.transcript).toBeUndefined();
    expect(out.ackText).toContain("Couldn't transcribe");
  });

  // P3 (owner decision 3): a video's transcript comes from a chat attachment, so it
  // too stays out of the knowledge base unless its sender opts in — Telegram cannot.
  it('videos get a transcript + keyframes and the transcript stays out of the KB', async () => {
    transcribeMock.mockResolvedValue({ transcript: 'quarterly numbers look good', jobName: 'j2' });
    ingestChatMediaMock.mockResolvedValue({
      docId: 'chat-v',
      scope: 'default',
      chunks: 2,
      deduped: false,
    });
    const out = await processMedia(
      input({ kind: 'video', fileName: 'clip.mp4', mimeType: 'video/mp4', bytes: Buffer.alloc(32, 3) }),
    );
    expect(out.blocks).toHaveLength(2);
    expect(out.blocks[0]).toEqual(expect.objectContaining({ kind: 'image', format: 'jpeg' }));
    expect(out.transcript).toBe('quarterly numbers look good');
    expect(out.transcriptKind).toBe('video');
    expect(out.ackText).toBe('');
    // mp4 goes to Transcribe straight from the raw S3 URI
    expect(transcribeMock).toHaveBeenCalledWith(
      expect.objectContaining({ mimeType: 'video/mp4', maxWaitMs: 180_000 }),
    );
    expect(ingestChatMediaMock).not.toHaveBeenCalled();
    expect(tempCleanupMock).toHaveBeenCalled();
  });

  it('video transcription failure degrades to frames-only', async () => {
    transcribeMock.mockRejectedValue(new Error('transcribe down'));
    const out = await processMedia(
      input({ kind: 'video', fileName: 'clip.mp4', mimeType: 'video/mp4', bytes: Buffer.alloc(32, 3) }),
    );
    expect(out.blocks).toHaveLength(2);
    expect(out.transcript).toBeUndefined();
    expect(out.ackText).toBe('');
  });

  it('unreadable video degrades to a stored ack', async () => {
    probeVideoMock.mockRejectedValue(new Error('not a video'));
    const out = await processMedia(
      input({ kind: 'video', fileName: 'clip.mp4', mimeType: 'video/mp4', bytes: Buffer.alloc(32, 3) }),
    );
    expect(out.blocks).toHaveLength(0);
    expect(out.ackText).toContain('ffprobe failed');
  });

  it('over-length videos skip the transcript but still extract frames', async () => {
    probeVideoMock.mockResolvedValue({ durationSec: 99999, width: 1280, height: 720 });
    const out = await processMedia(
      input({ kind: 'video', fileName: 'clip.mp4', mimeType: 'video/mp4', bytes: Buffer.alloc(32, 3) }),
    );
    expect(transcribeMock).not.toHaveBeenCalled();
    expect(out.blocks).toHaveLength(2);
  });

  it('video processing honors its kill switch', async () => {
    killSwitchMock.mockImplementation(async (name: string) => ({
      active: name === 'video_processing_disabled',
    }));
    const out = await processMedia(
      input({ kind: 'video', fileName: 'clip.mp4', mimeType: 'video/mp4', bytes: Buffer.alloc(32, 3) }),
    );
    expect(out.blocks).toHaveLength(0);
    expect(out.ackText).toContain('switched off');
    expect(probeVideoMock).not.toHaveBeenCalled();
  });

  it('non-mp4 containers extract the audio track for Transcribe', async () => {
    extractAudioTrackMock.mockResolvedValue(Buffer.alloc(64, 9));
    transcribeMock.mockResolvedValue({ transcript: 'from a mov', jobName: 'j3' });
    const out = await processMedia(
      input({ kind: 'video', fileName: 'clip.mov', mimeType: 'video/quicktime', bytes: Buffer.alloc(32, 3) }),
    );
    expect(extractAudioTrackMock).toHaveBeenCalled();
    expect(transcribeMock).toHaveBeenCalledWith(
      expect.objectContaining({ mimeType: 'audio/mp4' }),
    );
    expect(out.transcript).toBe('from a mov');
  });

  it('skips the raw S3 put when the object is pre-staged', async () => {
    const out = await processMedia(
      input({ s3Key: 'uploads/abc/report.pdf', s3Bucket: 'staging-bucket', kind: 'document', fileName: 'report.pdf', bytes: Buffer.from('%PDF-1.4') }),
    );
    expect(s3SendMock).not.toHaveBeenCalled();
    expect(out.s3Url).toBe('s3://staging-bucket/uploads/abc/report.pdf');
  });

  it('emits stage callbacks and survives a throwing callback', async () => {
    const stages: string[] = [];
    const out = await processMedia(input(), (s) => {
      stages.push(s);
      throw new Error('ui exploded');
    });
    expect(stages).toContain('storing');
    expect(out.blocks).toHaveLength(1);
  });

  it('audits the upload with kb info', async () => {
    ingestChatMediaMock.mockResolvedValue({
      docId: 'chat-9',
      scope: 'default',
      chunks: 2,
      deduped: false,
    });
    // P3: an opted-in dashboard file is the one way into the KB now (decision 3).
    await processMedia(
      input({ surface: 'dashboard', addToKnowledge: true, kind: 'document', fileName: 'a.pdf', mimeType: 'application/pdf', bytes: Buffer.from('%PDF') }),
    );
    expect(writeAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'media_upload',
        surface: 'dashboard',
        detail: expect.objectContaining({ kbDocId: 'chat-9' }),
      }),
    );
  });
});
