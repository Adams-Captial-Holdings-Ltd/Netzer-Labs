/**
 * GET /api/warroom-transcripts/:id — transcript PDF export.
 *
 * Lives on buildDashboardRouter (handler.ts), NOT buildWarroomRouter, so this
 * drives the REAL dashboard router through app.request() and mirrors the
 * mocking pattern of authz-matrix.test.ts (dashboard-auth + kill-switches +
 * audit-writer stubbed; warroom meetings-repo/publisher stubbed per-test).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { TokenPrincipal } from '../../lib/auth/dashboard-auth.js';

// ── Auth: drive by bearer token string -> principal, same shape as
// authz-matrix.test.ts. 'noread' is a templated-viewer-shaped principal whose
// capability set we strip warroom:read from below, to exercise the 403 path
// without touching a custom-profile DDB read.
function principalFor(raw: string): TokenPrincipal | null {
  if (raw === 'owner') {
    return { tokenHash: 'hash-owner', label: 'Root token', hashPrefix16: 'owner', role: 'admin', profileId: 'owner' };
  }
  if (raw === 'viewer') {
    return { tokenHash: 'hash-viewer', label: 'viewer', hashPrefix16: 'viewer', role: 'viewer' };
  }
  if (raw === 'noread') {
    return { tokenHash: 'hash-noread', label: 'noread', hashPrefix16: 'noread', role: 'viewer' };
  }
  return null;
}

vi.mock('../../lib/auth/dashboard-auth.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/auth/dashboard-auth.js')>();
  return {
    ...actual,
    extractBearerToken: (authHeader?: string, queryToken?: string) =>
      (authHeader ?? '').replace(/^Bearer\s+/i, '') || (queryToken ?? ''),
    authenticateDashboardToken: (raw: string) => Promise.resolve(principalFor(raw)),
    // Strip warroom:read for the 'noread' principal only; every other
    // principal resolves through the real capability machinery.
    capabilitiesForPrincipal: (p: TokenPrincipal, custom?: unknown) => {
      const caps = actual.capabilitiesForPrincipal(p, custom as never);
      if (p.label === 'noread') return caps.filter((c) => c !== 'warroom:read');
      return caps;
    },
  };
});

vi.mock('../../lib/state/kill-switches-repo.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/state/kill-switches-repo.js')>();
  return { ...actual, isKillSwitchActive: () => Promise.resolve({ active: false }) };
});

vi.mock('../../lib/audit/audit-writer.js', () => ({
  writeAudit: () => Promise.resolve(),
}));

vi.mock('../../observability/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  truncateForLog: (s: string) => s,
}));

const getMeeting = vi.fn();
vi.mock('../../lib/warroom/meetings-repo.js', () => ({
  getMeeting: (id: string) => getMeeting(id),
}));

const getHistory = vi.fn();
vi.mock('../../lib/warroom/publisher.js', () => ({
  getHistory: (meetingId: string, sinceSeq: number, limit: number) => getHistory(meetingId, sinceSeq, limit),
}));

import { buildDashboardRouter } from './handler.js';

function req(path: string, token?: string): Promise<Response> {
  const app = new Hono();
  app.route('/api', buildDashboardRouter());
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  return Promise.resolve(app.request(`/api${path}`, { headers }));
}

async function pdfText(res: Response): Promise<string> {
  const buf = Buffer.from(await res.arrayBuffer());
  const { PDFParse } = (await import('pdf-parse')) as typeof import('pdf-parse');
  const parser = new PDFParse({ data: new Uint8Array(buf) });
  try {
    const result = await parser.getText();
    return result.text ?? '';
  } finally {
    await parser.destroy().catch(() => {});
  }
}

const MEETING = {
  meetingId: 'm1',
  createdBy: 'dashboard',
  title: 'Launch Planning',
  status: 'active' as const,
  participants: ['alice', 'bob'],
  membershipVersion: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
};

const THREE_TURNS = [
  { meetingId: 'm1', seq: 1, speaker: 'alice', type: 'user' as const, content: 'What is the plan?', ts: '2026-01-01T00:00:01.000Z' },
  { meetingId: 'm1', seq: 2, speaker: 'analyst', type: 'agent' as const, content: 'Here is the plan.', ts: '2026-01-01T00:00:02.000Z', agentId: 'agent-analyst' },
  { meetingId: 'm1', seq: 3, speaker: 'system', type: 'system' as const, content: 'Meeting ended.', ts: '2026-01-01T00:00:03.000Z' },
];

beforeEach(() => {
  getMeeting.mockReset();
  getHistory.mockReset();
});

describe('GET /api/warroom-transcripts/:id', () => {
  it('401s with no Authorization header', async () => {
    const res = await req('/warroom-transcripts/m1');
    expect(res.status).toBe(401);
  });

  it('403s a principal lacking warroom:read', async () => {
    const res = await req('/warroom-transcripts/m1', 'noread');
    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.requiredCapability).toBe('warroom:read');
  });

  it('404s when the meeting does not exist', async () => {
    getMeeting.mockResolvedValue(null);
    const res = await req('/warroom-transcripts/nope', 'viewer');
    expect(res.status).toBe(404);
  });

  it('returns a PDF transcript with speakers and bodies in order', async () => {
    getMeeting.mockResolvedValue(MEETING);
    getHistory.mockResolvedValue(THREE_TURNS);

    const res = await req('/warroom-transcripts/m1', 'viewer');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    const disposition = res.headers.get('content-disposition') ?? '';
    expect(disposition).toContain('attachment');
    expect(disposition).toContain('filename="war-room-launch-planning.pdf"');

    const text = await pdfText(res);
    const expectedInOrder = [
      'alice',
      'What is the plan?',
      'agent-analyst',
      'Here is the plan.',
      'system',
      'Meeting ended.',
    ];
    let cursor = -1;
    for (const needle of expectedInOrder) {
      const idx = text.indexOf(needle);
      expect(idx).toBeGreaterThan(cursor);
      cursor = idx;
    }
  });

  it('pages through getHistory until a short page ends the loop', async () => {
    getMeeting.mockResolvedValue(MEETING);
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      meetingId: 'm1',
      seq: i + 1,
      speaker: 'alice',
      type: 'user' as const,
      content: `turn ${i + 1}`,
      ts: '2026-01-01T00:00:00.000Z',
    }));
    const page2 = Array.from({ length: 50 }, (_, i) => ({
      meetingId: 'm1',
      seq: 100 + i + 1,
      speaker: 'alice',
      type: 'user' as const,
      content: `turn ${100 + i + 1}`,
      ts: '2026-01-01T00:00:00.000Z',
    }));
    getHistory.mockResolvedValueOnce(page1).mockResolvedValueOnce(page2);

    const res = await req('/warroom-transcripts/m1', 'viewer');
    expect(res.status).toBe(200);
    expect(getHistory).toHaveBeenCalledTimes(2);
    expect(getHistory).toHaveBeenNthCalledWith(1, 'm1', 0, 100);
    expect(getHistory).toHaveBeenNthCalledWith(2, 'm1', 100, 100);

    const text = await pdfText(res);
    expect(text).toContain('turn 150');
  });

  /**
   * The regression this route shipped with. `buildPdf` REFUSES any character
   * the WinAnsi font cannot draw (guard added by the document-builder hotfix),
   * and agent replies routinely contain emoji and check marks. Without the
   * substitution pass this throws, the route has no catch, and the export 500s
   * on the first real transcript — a failure that cannot reproduce anywhere the
   * guard is absent, and that ASCII-only fixtures never see.
   */
  it('exports a transcript containing emoji instead of failing on it', async () => {
    getMeeting.mockResolvedValue({ ...MEETING, title: 'Launch Planning 🚀' });
    getHistory.mockResolvedValue([
      {
        meetingId: 'm1',
        seq: 1,
        speaker: 'alice',
        type: 'user' as const,
        content: 'Ship it 🚀 — done ✓ (наш план, 計画)',
        ts: '2026-01-01T00:00:01.000Z',
      },
    ]);

    const res = await req('/warroom-transcripts/m1', 'viewer');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');

    // The renderable text survives; only the unrenderable codepoints are
    // substituted, so the reader still gets the message.
    const text = await pdfText(res);
    expect(text).toContain('Ship it');
    expect(text).toContain('done');
    expect(text).not.toContain('🚀');
  });
});
