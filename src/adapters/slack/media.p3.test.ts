import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * P3 (step 5) — Slack's half of the one chat ceiling (CLAUDE.md "Chat surface
 * parity": attachment handling is on the mirror list).
 *
 * Written BEFORE the change, as the bar (netzar-chat-plan/p3-proof.sh rows SL-1, SL-2).
 *
 *   - Owner decision 29 sets 30 MB per chat file; Jev settled that Slack shares it
 *     (slack_cap: align_30, 0.85). Today Slack's download cap is the knowledge-base
 *     ingest setting, 50 MB by default. That setting may still LOWER the cap (the
 *     existing "declared oversize" test sets it to 100 bytes and keeps passing), but
 *     nothing can raise it past 30 MB any more.
 *   - Slack reads at most three files a message, as before — and now SAYS which
 *     files it skipped, instead of dropping them in silence (the plan's P3
 *     acceptance: "no silent fourth-file drop", mirrored here).
 */

const { getConfigMock, processMediaMock } = vi.hoisted(() => ({
  getConfigMock: vi.fn(),
  processMediaMock: vi.fn(),
}));

vi.mock('../../lib/state/runtime-config-repo.js', () => ({ getConfig: getConfigMock }));
vi.mock('../../lib/media/process.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/media/process.js')>();
  return {
    ...actual,
    processMedia: processMediaMock,
    buildKbConfirmation: (kb: { chunks: number }, name: string) => `indexed ${name} (${kb.chunks})`,
  };
});

import { downloadSlackFile, processSlackFiles } from './media.js';
import type { SlackFile } from './types.js';

const MB = 1024 * 1024;
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

function okResponse(bytes: Buffer): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: (h: string) => (h === 'content-type' ? 'application/pdf' : null) },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  } as unknown as Response;
}

describe('chat attachments (P3) — Slack', () => {
  it('refuses a Slack file over 30 MB whatever the knowledge-base setting says', async () => {
    const over = slackFile({ size: 30 * MB + 1 });

    // Unset: the old 50 MB default no longer applies.
    expect(await downloadSlackFile(over, 'xoxb')).toBeNull();
    // Set to 50 MB explicitly: still refused.
    getConfigMock.mockResolvedValue(String(50 * MB));
    expect(await downloadSlackFile(over, 'xoxb')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();

    // A file that lied about its size is caught on its real bytes.
    getConfigMock.mockResolvedValue(undefined);
    fetchMock.mockResolvedValue(okResponse(Buffer.alloc(30 * MB + 1)));
    expect(await downloadSlackFile(slackFile({ size: 10 }), 'xoxb')).toBeNull();

    // Exactly 30 MB is inside the ceiling.
    fetchMock.mockResolvedValue(okResponse(Buffer.alloc(10)));
    expect(await downloadSlackFile(slackFile({ size: 30 * MB }), 'xoxb')).not.toBeNull();
  });

  it('tells the sender when files past the third were not read', async () => {
    fetchMock.mockResolvedValue(okResponse(Buffer.from('bytes')));
    processMediaMock.mockResolvedValue({ blocks: [], ackText: '', kb: null });

    const out = await processSlackFiles({
      files: [1, 2, 3, 4, 5].map((i) => slackFile({ id: `F${i}`, name: `f${i}.pdf` })),
      botToken: 'xoxb',
      agentId: 'main',
      targetAgentId: 'main',
      chatId: 'slack:C1',
    });

    expect(processMediaMock).toHaveBeenCalledTimes(3);
    const said = out.acks.join('\n');
    expect(said).toContain('f4.pdf');
    expect(said).toContain('f5.pdf');
  });

  it('tells the sender which file it did not read because it is over the size limit', async () => {
    // Review finding (silent-failure-hunter E1): the file vanished from the reply, and when it
    // was the only one the reply blamed a missing files:read scope instead of its size.
    const out = await processSlackFiles({
      files: [slackFile({ id: 'F9', name: 'huge.mov', mimetype: 'video/quicktime', size: 30 * MB + 1 })],
      botToken: 'xoxb',
      agentId: 'main',
      targetAgentId: 'main',
      chatId: 'slack:C1',
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(processMediaMock).not.toHaveBeenCalled();
    const said = out.acks.join('\n');
    expect(said).toContain('huge.mov');
    expect(said).toContain('30 MB');
  });
});
