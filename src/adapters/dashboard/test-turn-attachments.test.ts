import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { TokenPrincipal } from '../../lib/auth/dashboard-auth.js';

// Contract test for POST /test-turn/stream attachments (dashboard chat file
// uploads). Drives the REAL router through app.request() with auth driven by
// role string (same harness as handler.middleware.test.ts); media pipeline,
// store, and agent loop are mocked so no AWS is touched.

function principalFor(raw: string): TokenPrincipal | null {
  const role = raw.replace(/^Bearer\s+/i, '');
  if (role !== 'viewer' && role !== 'operator' && role !== 'admin') return null;
  return { tokenHash: `hash-${role}`, label: role, hashPrefix16: role, role };
}

vi.mock('../../lib/auth/dashboard-auth.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/auth/dashboard-auth.js')>();
  return {
    ...actual,
    extractBearerToken: (authHeader?: string) => (authHeader ?? '').replace(/^Bearer\s+/i, ''),
    authenticateDashboardToken: (raw: string) => Promise.resolve(principalFor(raw)),
  };
});

vi.mock('../../lib/state/kill-switches-repo.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/state/kill-switches-repo.js')>();
  return {
    ...actual,
    isKillSwitchActive: () => Promise.resolve({ active: false }),
  };
});

vi.mock('../../observability/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  truncateForLog: (s: string) => s,
}));

const {
  getObjectBufferMock,
  deleteObjectMock,
  processMediaMock,
  runAgentTurnMock,
  getSessionMock,
  appendTurnsMock,
  runCommandMock,
} = vi.hoisted(() => ({
  getObjectBufferMock: vi.fn(),
  deleteObjectMock: vi.fn(),
  processMediaMock: vi.fn(),
  runAgentTurnMock: vi.fn(),
  getSessionMock: vi.fn(),
  appendTurnsMock: vi.fn(),
  runCommandMock: vi.fn(),
}));

vi.mock('../../lib/vectors/store.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/vectors/store.js')>();
  return {
    ...actual, // keep the real isUploadKey guard — it is the contract under test
    getObjectBuffer: getObjectBufferMock,
    deleteObject: deleteObjectMock,
  };
});

vi.mock('../../lib/media/process.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/media/process.js')>();
  return {
    ...actual,
    processMedia: processMediaMock,
  };
});

vi.mock('../../agent/agent-loop.js', async (importActual) => {
  const actual = await importActual<typeof import('../../agent/agent-loop.js')>();
  return {
    ...actual,
    runAgentTurn: runAgentTurnMock,
  };
});

vi.mock('../../lib/state/sessions-repo.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/state/sessions-repo.js')>();
  return {
    ...actual,
    getSession: getSessionMock,
    appendTurns: appendTurnsMock,
  };
});

vi.mock('../../agent/commands.js', () => ({
  runCommand: runCommandMock,
}));

import { buildDashboardRouter } from './handler.js';

function postStream(body: unknown) {
  const app = new Hono();
  app.route('/api', buildDashboardRouter());
  return app.request('/api/test-turn/stream', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer operator',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  getSessionMock.mockResolvedValue(null);
  appendTurnsMock.mockResolvedValue(undefined);
  runCommandMock.mockResolvedValue(null);
  getObjectBufferMock.mockResolvedValue(Buffer.from('%PDF-1.4 test'));
  deleteObjectMock.mockResolvedValue(undefined);
  runAgentTurnMock.mockResolvedValue({
    text: 'the answer',
    costUsd: 0.01,
    toolCallCount: 0,
    blocked: false,
    inputTokens: 10,
    outputTokens: 10,
    latencyMs: 100,
    modelId: 'anthropic.claude-3-5-sonnet',
  });
});

describe('POST /test-turn/stream attachments', () => {
  it('rejects keys outside the upload staging prefix', async () => {
    const res = await postStream({
      text: 'look at this',
      attachments: [{ s3Key: 'index/default/somedoc.jsonl', fileName: 'x.pdf' }],
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_upload_key' });
    expect(getObjectBufferMock).not.toHaveBeenCalled();
  });

  it('rejects path traversal in keys', async () => {
    const res = await postStream({
      text: 'x',
      attachments: [{ s3Key: 'uploads/../index/default/doc.jsonl', fileName: 'x.pdf' }],
    });
    expect(res.status).toBe(400);
  });

  it('still requires text when there are no attachments', async () => {
    const res = await postStream({ text: '' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'missing_text' });
  });

  it('allows a file-only send: processes media, runs the turn, cleans up staging', async () => {
    processMediaMock.mockResolvedValue({
      s3Url: 's3://raw/x',
      s3Key: 'dashboard/x',
      byteLength: 13,
      blocks: [{ kind: 'document', format: 'pdf', bytes: Buffer.from('x'), name: 'r.pdf' }],
      ackText: '',
      kb: { docId: 'chat-1', scope: 'default', chunks: 4, deduped: false },
      kind: 'document',
    });
    const res = await postStream({
      text: '',
      attachments: [{ s3Key: 'uploads/abc/r.pdf', fileName: 'r.pdf', mimeType: 'application/pdf' }],
    });
    expect(res.status).toBe(200);
    const sse = await res.text();
    expect(sse).toContain('event: final');
    expect(sse).toContain('event: kb');
    expect(sse).toContain('Indexed r.pdf');
    expect(processMediaMock).toHaveBeenCalledWith(
      expect.objectContaining({ surface: 'dashboard', kind: 'document', fileName: 'r.pdf' }),
      expect.any(Function),
    );
    expect(runAgentTurnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userText: 'What is this?',
        attachments: [expect.objectContaining({ kind: 'document' })],
      }),
    );
    expect(deleteObjectMock).toHaveBeenCalledWith('uploads/abc/r.pdf');
    // attachment turns skip the slash-command router (captions are data)
    expect(runCommandMock).not.toHaveBeenCalled();
  });

  it('KB-only docs (no inline block) reply without an agent turn', async () => {
    processMediaMock.mockResolvedValue({
      s3Url: 's3://raw/x',
      s3Key: 'dashboard/x',
      byteLength: 13,
      blocks: [],
      ackText: 'got notes.docx and indexed it into the knowledge base (3 chunks).',
      kb: { docId: 'chat-2', scope: 'default', chunks: 3, deduped: false },
      kind: 'document',
    });
    const res = await postStream({
      text: '',
      attachments: [{ s3Key: 'uploads/abc/notes.docx', fileName: 'notes.docx' }],
    });
    const sse = await res.text();
    expect(sse).toContain('event: reply');
    expect(sse).toContain('indexed it into the knowledge base');
    expect(sse).toContain('media_only');
    expect(runAgentTurnMock).not.toHaveBeenCalled();
  });

  it('caps attachments at 3 per send', async () => {
    processMediaMock.mockResolvedValue({
      s3Url: 's3://raw/x', s3Key: 'k', byteLength: 1,
      blocks: [{ kind: 'image', format: 'jpeg', bytes: Buffer.from('x') }],
      ackText: '', kb: null, kind: 'photo',
    });
    await postStream({
      text: 'look',
      attachments: [1, 2, 3, 4, 5].map((i) => ({ s3Key: `uploads/a/${i}.jpg`, fileName: `${i}.jpg`, mimeType: 'image/jpeg' })),
    });
    expect(processMediaMock).toHaveBeenCalledTimes(3);
  });
});
