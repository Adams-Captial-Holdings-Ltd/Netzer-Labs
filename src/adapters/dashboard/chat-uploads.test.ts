import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { S3Client, HeadObjectCommand } from '@aws-sdk/client-s3';
import type { TokenPrincipal } from '../../lib/auth/dashboard-auth.js';

/**
 * P3 (step 5) — the dashboard's attachment routes: the upload link, the send-time
 * preflight, the transcript, the owner's download and the file-only message.
 *
 * Written BEFORE the change, as the bar (netzar-chat-plan/p3-proof.sh rows U-1..U-8,
 * M-3..M-7, K-8, K-9 and the guard G-4). It REPLACES test-turn-attachments.test.ts, whose
 * "caps attachments at 3 per send" pinned the silent fourth-file drop P3 removes
 * (UPL-01); that file's other tests are kept below, the two that sent keys now
 * sending keys the new upload route signed.
 *
 * The contract, as the owner's decisions and Jev's settle it (the P3 session log 6.1):
 *   - POST /api/chat/uploads signs ONE presigned S3 PUT per file, with the file's
 *     exact size and type signed into the URL, so S3 itself refuses a different
 *     size or type (Jev: put_signed_length, 0.99 — no new package, no infra change).
 *     A file over 30 MB (decision 29) is refused with 413 and an unsupported type
 *     with 415, before anything is signed. The key sits under a prefix derived from
 *     the caller, so one person cannot send another's upload.
 *   - The send refuses a fourth file (was: dropped in silence), and HEADs every
 *     staged file BEFORE reading it or starting a turn: an object over 30 MB is a
 *     413 before any byte is buffered or any model spend (UPL-04, the plan's P3
 *     acceptance).
 *   - A message's files are stored with it and come back in the transcript, never
 *     with their storage key; the owner re-mints a short-lived, named download link;
 *     anyone else gets 404; an admin's look at someone else's is audited first
 *     (decision 1).
 *
 * Drives the REAL router through app.request() with auth by role string (the same
 * harness as the file it replaces). The media pipeline, the agent loop and the
 * sessions repo are mocked; S3 is intercepted at the SDK, and the presigner runs
 * for real — it signs locally, with fake credentials restored inside this file
 * (vitest.setup.ts removes them, and signing needs some; nothing is dialled).
 */

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
  return { ...actual, isKillSwitchActive: () => Promise.resolve({ active: false }) };
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
  beginTurnMock,
  endTurnMock,
  getFullHistoryMock,
  runCommandMock,
  writeAuditOrThrowMock,
} = vi.hoisted(() => {
  // Read at import time by store.ts / process.ts.
  process.env.VECTORS_STAGING_BUCKET = 'staging-test-bucket';
  process.env.RAW_BUCKET = 'raw-test-bucket';
  process.env.AWS_REGION ??= 'us-east-1';
  return {
    getObjectBufferMock: vi.fn(),
    deleteObjectMock: vi.fn(),
    processMediaMock: vi.fn(),
    runAgentTurnMock: vi.fn(),
    getSessionMock: vi.fn(),
    appendTurnsMock: vi.fn(),
    beginTurnMock: vi.fn(),
    endTurnMock: vi.fn(),
    getFullHistoryMock: vi.fn(),
    runCommandMock: vi.fn(),
    writeAuditOrThrowMock: vi.fn(),
  };
});

vi.mock('../../lib/vectors/store.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/vectors/store.js')>();
  return { ...actual, getObjectBuffer: getObjectBufferMock, deleteObject: deleteObjectMock };
});

vi.mock('../../lib/media/process.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/media/process.js')>();
  return { ...actual, processMedia: processMediaMock };
});

vi.mock('../../agent/agent-loop.js', async (importActual) => {
  const actual = await importActual<typeof import('../../agent/agent-loop.js')>();
  return { ...actual, runAgentTurn: runAgentTurnMock };
});

vi.mock('../../lib/state/sessions-repo.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/state/sessions-repo.js')>();
  return {
    ...actual,
    getSession: getSessionMock,
    appendTurns: appendTurnsMock,
    beginTurn: beginTurnMock,
    endTurn: endTurnMock,
    getFullHistory: getFullHistoryMock,
  };
});

vi.mock('../../agent/commands.js', () => ({ runCommand: runCommandMock }));

vi.mock('../../lib/audit/audit-writer.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/audit/audit-writer.js')>();
  return { ...actual, writeAudit: vi.fn(), writeAuditOrThrow: writeAuditOrThrowMock };
});

import { buildDashboardRouter } from './handler.js';

const MB = 1024 * 1024;
const PDF = 'application/pdf';

function app() {
  const a = new Hono();
  a.route('/api', buildDashboardRouter());
  return a;
}

function call(role: string, method: string, path: string, body?: unknown) {
  return app().request(`/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${role}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const postStream = (body: unknown, role = 'operator') => call(role, 'POST', '/test-turn/stream', body);
const sign = (body: unknown, role = 'operator') => call(role, 'POST', '/chat/uploads', body);

/** What S3 answers a HEAD with, per key. A key not in the map does not exist. */
let heads: Map<string, { ContentLength: number; ContentType: string }>;
let s3Commands: string[];

/** Ask the upload route for a key the way the browser does, and record what S3 would then hold. */
async function stagedKey(role: string, fileName = 'r.pdf', mimeType = PDF, size = 1234): Promise<string> {
  const res = await sign({ fileName, mimeType, size }, role);
  expect(res.status).toBe(200);
  const { key } = (await res.json()) as { key: string };
  heads.set(key, { ContentLength: size, ContentType: mimeType });
  return key;
}

function media(over: Record<string, unknown> = {}) {
  return {
    s3Url: 's3://raw-test-bucket/dashboard/x/r.pdf',
    s3Key: 'dashboard/dashboard:1750000000001/2026/09/24/1-r.pdf',
    byteLength: 1234,
    blocks: [{ kind: 'document', format: 'pdf', bytes: Buffer.from('x'), name: 'r' }],
    ackText: '',
    kb: null,
    kind: 'document',
    ...over,
  };
}

beforeAll(() => {
  // Local signing only: well-formed fakes, for an account that does not exist.
  process.env.AWS_ACCESS_KEY_ID = 'AKIAP3SIGNINGFAKE000';
  process.env.AWS_SECRET_ACCESS_KEY = 'p3-signing-fake-secret-not-real';
});

beforeEach(() => {
  vi.clearAllMocks();
  heads = new Map();
  s3Commands = [];
  vi.spyOn(S3Client.prototype, 'send').mockImplementation(async (cmd: unknown) => {
    s3Commands.push((cmd as { constructor: { name: string } }).constructor.name);
    if (cmd instanceof HeadObjectCommand) {
      const found = heads.get(String(cmd.input.Key));
      if (!found) throw Object.assign(new Error('NotFound'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });
      return found as never;
    }
    throw new Error(`unexpected S3 command ${(cmd as { constructor: { name: string } }).constructor.name}`);
  });
  getSessionMock.mockResolvedValue(null);
  appendTurnsMock.mockResolvedValue(undefined);
  beginTurnMock.mockResolvedValue({ started: true });
  endTurnMock.mockResolvedValue(true);
  runCommandMock.mockResolvedValue(null);
  getObjectBufferMock.mockResolvedValue(Buffer.from('%PDF-1.4 test'));
  deleteObjectMock.mockResolvedValue(undefined);
  processMediaMock.mockResolvedValue(media());
  writeAuditOrThrowMock.mockResolvedValue(undefined);
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
  // ── Kept from test-turn-attachments.test.ts ────────────────────────────────
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
    const key = await stagedKey('operator');
    const res = await postStream({ text: '', attachments: [{ s3Key: key, fileName: 'r.pdf', mimeType: PDF }] });
    expect(res.status).toBe(200);
    const sse = await res.text();
    expect(sse).toContain('event: final');
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
    expect(deleteObjectMock).toHaveBeenCalledWith(key);
    // attachment turns skip the slash-command router (captions are data)
    expect(runCommandMock).not.toHaveBeenCalled();
  });

  it('KB-only docs (no inline block) reply without an agent turn', async () => {
    processMediaMock.mockResolvedValue(media({
      blocks: [],
      ackText: 'got notes.docx and indexed it into the knowledge base (3 chunks).',
      kb: { docId: 'chat-2', scope: 'default', chunks: 3, deduped: false },
    }));
    const key = await stagedKey('operator', 'notes.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    const res = await postStream({ text: '', attachments: [{ s3Key: key, fileName: 'notes.docx', addToKnowledge: true }] });
    const sse = await res.text();
    expect(sse).toContain('event: reply');
    expect(sse).toContain('indexed it into the knowledge base');
    expect(sse).toContain('media_only');
    expect(runAgentTurnMock).not.toHaveBeenCalled();
  });

  // ── P3 ─────────────────────────────────────────────────────────────────────
  it('refuses a fourth attachment instead of dropping it', async () => {
    const keys = [await stagedKey('operator', 'a.pdf'), await stagedKey('operator', 'b.pdf'),
      await stagedKey('operator', 'c.pdf'), await stagedKey('operator', 'd.pdf')];

    const res = await postStream({ text: 'four', attachments: keys.map((k, i) => ({ s3Key: k, fileName: `${i}.pdf`, mimeType: PDF })) });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'too_many_attachments' });
    expect(processMediaMock).not.toHaveBeenCalled();
    expect(runAgentTurnMock).not.toHaveBeenCalled();
  });

  it('refuses an upload key that belongs to someone else', async () => {
    const theirs = await stagedKey('admin');

    const res = await postStream({ text: 'mine now?', attachments: [{ s3Key: theirs, fileName: 'r.pdf', mimeType: PDF }] }, 'operator');

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'upload_not_found' });
    expect(getObjectBufferMock).not.toHaveBeenCalled();
    expect(processMediaMock).not.toHaveBeenCalled();
  });

  it('refuses an attachment over 30 MB before reading or spending', async () => {
    const key = await stagedKey('operator', 'big.pdf', PDF, 1234);
    // What S3 actually holds is bigger than what was declared.
    heads.set(key, { ContentLength: 30 * MB + 1, ContentType: PDF });

    const res = await postStream({ text: 'read it', clientMessageId: 'p3-oversize', attachments: [{ s3Key: key, fileName: 'big.pdf', mimeType: PDF }] });

    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: 'file_too_large' });
    expect(s3Commands).toContain('HeadObjectCommand');
    expect(s3Commands).not.toContain('GetObjectCommand');
    expect(getObjectBufferMock).not.toHaveBeenCalled();
    expect(beginTurnMock).not.toHaveBeenCalled();
    expect(processMediaMock).not.toHaveBeenCalled();
    expect(runAgentTurnMock).not.toHaveBeenCalled();
  });

  it('refuses an attachment whose stored type is not the one it was signed for', async () => {
    const key = await stagedKey('operator');
    heads.set(key, { ContentLength: 1234, ContentType: 'application/x-msdownload' });

    const res = await postStream({ text: 'read it', attachments: [{ s3Key: key, fileName: 'r.pdf', mimeType: PDF }] });

    expect(res.status).toBe(415);
    expect(await res.json()).toMatchObject({ error: 'unsupported_type' });
    expect(getObjectBufferMock).not.toHaveBeenCalled();
    expect(runAgentTurnMock).not.toHaveBeenCalled();
  });

  it('stores a file-only message with its attachments', async () => {
    processMediaMock.mockResolvedValue(media({ blocks: [], ackText: 'Stored r.pdf.' }));
    const key = await stagedKey('operator', 'r.pdf', PDF, 1234);

    const res = await postStream({ text: '', attachments: [{ s3Key: key, fileName: 'r.pdf', mimeType: PDF }] });
    await res.text();

    // The media-only path answers without a model turn, and still keeps the
    // message and its file, so a reload shows what was sent (UPL-04/05).
    expect(runAgentTurnMock).not.toHaveBeenCalled();
    expect(appendTurnsMock).toHaveBeenCalledTimes(1);
    const turns = appendTurnsMock.mock.calls[0]![2] as Array<{ role: string; attachments?: unknown[] }>;
    expect(turns[0]!.role).toBe('user');
    expect(turns[0]!.attachments).toEqual([
      { id: expect.any(String), name: 'r.pdf', type: PDF, size: 1234, key: media().s3Key },
    ]);
  });

  it('tells the model which file it could not read', async () => {
    processMediaMock.mockResolvedValue(media({
      blocks: [],
      ackText: 'annual.pdf is over the 4.5 MB the model can read at once, so it was stored but not read.',
    }));
    const key = await stagedKey('operator', 'annual.pdf');

    const res = await postStream({ text: 'summarize please', attachments: [{ s3Key: key, fileName: 'annual.pdf', mimeType: PDF }] });
    await res.text();

    expect(runAgentTurnMock).toHaveBeenCalledTimes(1);
    const { userText } = runAgentTurnMock.mock.calls[0]![0] as { userText: string };
    expect(userText).toContain('summarize please');
    expect(userText).toContain('annual.pdf');
  });

  it('passes the knowledge opt-in to the media pipeline for that file only', async () => {
    const a = await stagedKey('operator', 'share.pdf');
    const b = await stagedKey('operator', 'private.pdf');

    const res = await postStream({
      text: 'two files',
      attachments: [
        { s3Key: a, fileName: 'share.pdf', mimeType: PDF, addToKnowledge: true },
        { s3Key: b, fileName: 'private.pdf', mimeType: PDF },
      ],
    });
    await res.text();

    expect(processMediaMock).toHaveBeenCalledTimes(2);
    expect(processMediaMock.mock.calls[0]![0]).toMatchObject({ fileName: 'share.pdf', addToKnowledge: true });
    expect((processMediaMock.mock.calls[1]![0] as { addToKnowledge?: boolean }).addToKnowledge ?? false).toBe(false);
  });
});

describe('POST /chat/uploads', () => {
  it('refuses to sign an upload over 30 MB', async () => {
    const res = await sign({ fileName: 'big.pdf', mimeType: PDF, size: 30 * MB + 1 });

    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: 'file_too_large', maxBytes: 30 * MB });
  });

  it('refuses to sign an unsupported file type', async () => {
    const res = await sign({ fileName: 'tool.exe', mimeType: 'application/x-msdownload', size: 10 });

    expect(res.status).toBe(415);
    expect(await res.json()).toMatchObject({ error: 'unsupported_type' });
  });

  it('signs the exact size and type into the upload link', async () => {
    const res = await sign({ fileName: '../../etc/Q3 report.pdf', mimeType: PDF, size: 1234 });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string; key: string; id: string; headers: Record<string, string> };
    const url = new URL(body.url);
    const signed = (url.searchParams.get('X-Amz-SignedHeaders') ?? '').split(';');
    // S3 checks both against the actual PUT, so a bigger file or another type is refused by S3 itself.
    expect(signed).toEqual(expect.arrayContaining(['content-length', 'content-type', 'host']));
    // UPL-02: a 300-second transfer window, as today.
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
    // The header the browser must send is the one that was signed.
    expect(body.headers['Content-Type']).toBe(PDF);
    // The key lives under the chat upload prefix, one folder per upload, and the
    // file's own name cannot climb out of it.
    expect(body.key.startsWith('uploads/chat/')).toBe(true);
    expect(body.key).not.toContain('..');
    expect(body.key.split('/')).toHaveLength(5); // uploads / chat / <caller> / <upload id> / <name>
    expect(body.key.split('/')[3]).toBe(body.id);
  });
});

describe('GET /sessions/transcript and /sessions/attachment', () => {
  const MINE = 'dashboard:hash-operator';
  const CHAT = 'dashboard:1750000000001';
  const stored = {
    id: 'upload-1',
    name: 'Q3 report.pdf',
    type: PDF,
    size: 1234,
    key: `dashboard/${CHAT}/2026/09/24/1-Q3_report.pdf`,
  };

  function conversation(owner: string) {
    getSessionMock.mockResolvedValue({ agentId: 'main', chatId: CHAT, turns: [], updatedAt: 1, userId: owner });
    getFullHistoryMock.mockResolvedValue({
      turns: [
        { role: 'user', text: 'here it is', ts: 1, attachments: [stored] },
        { role: 'assistant', text: 'read it', ts: 1 },
      ],
      truncated: false,
    });
  }

  it('returns attachments in the transcript without storage keys', async () => {
    conversation(MINE);

    const res = await call('operator', 'GET', `/sessions/transcript?agentId=main&chatId=${encodeURIComponent(CHAT)}`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { turns: Array<{ attachments?: unknown[] }> };
    expect(body.turns[0]!.attachments).toEqual([{ id: 'upload-1', name: 'Q3 report.pdf', type: PDF, size: 1234 }]);
    expect(JSON.stringify(body)).not.toContain(stored.key);
    expect(JSON.stringify(body)).not.toContain('"key"');
  });

  it('gives the owner a named download link', async () => {
    conversation(MINE);

    const res = await call('operator', 'GET', `/sessions/attachment?agentId=main&chatId=${encodeURIComponent(CHAT)}&id=upload-1`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string; name: string };
    expect(body.name).toBe('Q3 report.pdf');
    const url = new URL(body.url);
    expect(url.pathname).toContain(encodeURIComponent(stored.key).replace(/%2F/g, '/'));
    // A fresh link each time, short-lived, and it downloads under the file's own name.
    expect(Number(url.searchParams.get('X-Amz-Expires'))).toBeLessThanOrEqual(300);
    const disposition = url.searchParams.get('response-content-disposition') ?? '';
    expect(disposition).toMatch(/^attachment/);
    expect(decodeURIComponent(disposition)).toContain('Q3 report.pdf');
  });

  // Named without P1's directory-wide filter words ("does not own"), so the P1 gate
  // does not pick this test up (P80 — the P2 gate's rule, kept).
  it('answers 404 to anyone but the file\'s owner', async () => {
    conversation('dashboard:someone-else');

    const res = await call('operator', 'GET', `/sessions/attachment?agentId=main&chatId=${encodeURIComponent(CHAT)}&id=upload-1`);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
    // An unknown file id in your own conversation reads the same.
    conversation(MINE);
    const missing = await call('operator', 'GET', `/sessions/attachment?agentId=main&chatId=${encodeURIComponent(CHAT)}&id=nope`);
    expect(missing.status).toBe(404);
  });

  it('audits an admin download before the link leaves', async () => {
    conversation('dashboard:someone-else');

    const res = await call('admin', 'GET', `/sessions/attachment?agentId=main&chatId=${encodeURIComponent(CHAT)}&id=upload-1`);

    expect(res.status).toBe(200);
    expect(writeAuditOrThrowMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'session_read_override', chatId: CHAT }));

    // When that audit cannot be written, nothing is returned (decision 1, P98).
    writeAuditOrThrowMock.mockRejectedValueOnce(new Error('audit store down'));
    const refused = await call('admin', 'GET', `/sessions/attachment?agentId=main&chatId=${encodeURIComponent(CHAT)}&id=upload-1`);
    expect(refused.status).toBe(500);
    expect(await refused.json()).toEqual({ error: 'override_not_audited' });
  });
});
