/**
 * C-11 / M31 — THE BLOCKING GATE, executed end to end.
 *
 * The regression this pins: `issueToMission` hardcodes an unconditional
 * `createdByChat: 'paperclip'`, and `exportChatData` selects a subject's
 * missions with `m.createdByChat === chatId`. Left alone, that combination
 * returns an EMPTY `missions: []` from a GDPR subject-access export for every
 * Paperclip-origin mission — silently, with no error and no log — and once the
 * ACL is armed that is the DEFAULT for the whole board.
 *
 * So this drives the real thing: a mission created through the ACL with a real
 * chat id, then read back through the real `exportChatData`, and the assertion
 * is that the subject's mission is present WITH THE SAME FIELD NAMES the legacy
 * export produced. The negative control below runs the identical flow with the
 * provenance write suppressed and shows the export going empty — which is what
 * makes the positive case mean something.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { flag } = vi.hoisted(() => ({ flag: { value: '1' as string | undefined } }));
vi.mock('../../config/env.js', () => ({
  loadEnv: () => ({ CCE_PAPERCLIP_ENABLED: flag.value }),
}));

const { provStore, writeProvenance } = vi.hoisted(() => ({
  provStore: new Map<string, Record<string, unknown>>(),
  writeProvenance: { enabled: true },
}));
vi.mock('../state/mission-provenance-repo.js', () => ({
  putMissionProvenance: vi.fn((row: { missionId: string }) => {
    if (writeProvenance.enabled) provStore.set(row.missionId, row as Record<string, unknown>);
    return Promise.resolve();
  }),
  getMissionProvenance: vi.fn((ids: readonly string[]) =>
    Promise.resolve(
      new Map(ids.filter((id) => provStore.has(id)).map((id) => [id, provStore.get(id)])),
    ),
  ),
}));

// The DynamoDB half of the board. `preCutover.rows` is what already existed
// when the operator flipped the flag — the data the union read exists to save.
const { preCutover } = vi.hoisted(() => ({ preCutover: { rows: [] as unknown[] } }));
vi.mock('../state/mission-tasks-repo.js', async (actual) => ({
  ...(await actual<typeof import('../state/mission-tasks-repo.js')>()),
  listMissionsForAgent: vi.fn(() => Promise.resolve(preCutover.rows)),
  createMission: vi.fn(),
  listMissionsByStatus: vi.fn(() => Promise.resolve([])),
  updateMissionStatus: vi.fn(),
  reassignMission: vi.fn(),
}));

// The rest of the export payload is not under test; keep DynamoDB out of it.
vi.mock('../state/sessions-repo.js', () => ({
  getSession: () => Promise.resolve(null),
  deleteSession: () => Promise.resolve(),
}));
vi.mock('../state/memories-repo.js', () => ({
  listMemoriesForChat: () => Promise.resolve([]),
  forgetMemory: () => Promise.resolve(),
}));
vi.mock('../state/scheduled-tasks-repo.js', () => ({
  listScheduledTasksForAgent: () => Promise.resolve([]),
  deleteScheduledTask: () => Promise.resolve(),
}));
vi.mock('../state/inter-agent-tasks-repo.js', () => ({
  listInbox: () => Promise.resolve([]),
  deleteInterAgentTask: () => Promise.resolve(),
  sendInterAgent: () => Promise.resolve(),
}));
vi.mock('../../observability/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  truncateForLog: (s: string) => s,
}));

import type { MissionEngine } from '../paperclip/mission-engine.js';
import type { ProjectedMission } from '../paperclip/mission-projection.js';
import {
  __setMissionEngineForTest,
  createBoardMission,
  listBoardMissions,
} from '../missions/mission-acl.js';
import { exportChatData } from './privacy-tools.js';

const ISSUE = 'cccccccc-3333-4333-8333-333333333333';
const CHAT = 'telegram:998877';

const PROJECTED: ProjectedMission = {
  id: ISSUE,
  identifier: 'NZR-7',
  ownerAgent: 'main',
  createdByAgent: 'paperclip',
  // The hardcode. It matches no real chat id, which is the entire hazard.
  createdByChat: 'paperclip',
  title: 'Renew the TLS cert',
  body: 'Before it expires.',
  priority: 'medium',
  status: 'open',
  createdAt: '2026-08-20T10:00:00.000Z',
  updatedAt: '2026-08-20T10:00:00.000Z',
  bodyTruncated: false,
};

beforeEach(() => {
  flag.value = '1';
  preCutover.rows = [];
  provStore.clear();
  writeProvenance.enabled = true;
  __setMissionEngineForTest({
    listMissions: () => Promise.resolve([PROJECTED]),
    getMission: () => Promise.resolve(PROJECTED),
    createMission: () => Promise.resolve(PROJECTED),
    setStatus: () => Promise.resolve(PROJECTED),
    reassign: () => Promise.resolve(PROJECTED),
    comment: () => Promise.resolve(),
  } as unknown as MissionEngine);
});

describe('ACCEPTANCE 5 (BLOCKING): the GDPR export still returns the subject\'s missions', () => {
  it('a Paperclip-origin mission created by a chat comes back in THAT chat\'s export, with identical field names', async () => {
    await createBoardMission({
      ownerAgent: 'main',
      createdByAgent: 'main',
      createdByChat: CHAT,
      title: 'Renew the TLS cert',
      body: 'Before it expires.',
      assignmentReason: 'explicit assignment',
    });

    const payload = await exportChatData('main', CHAT);

    expect(payload.missions).toEqual([
      {
        id: ISSUE,
        title: 'Renew the TLS cert',
        body: 'Before it expires.',
        status: 'open',
        createdAt: '2026-08-20T10:00:00.000Z',
      },
    ]);
    // The five keys the legacy `ExportPayload.missions` projection had — no
    // more, no fewer, same spellings.
    expect(Object.keys(payload.missions[0])).toEqual([
      'id',
      'title',
      'body',
      'status',
      'createdAt',
    ]);
  });

  it('NEGATIVE CONTROL: with the provenance row suppressed the export silently empties — the exact regression', async () => {
    writeProvenance.enabled = false;
    await createBoardMission({
      ownerAgent: 'main',
      createdByAgent: 'main',
      createdByChat: CHAT,
      title: 'Renew the TLS cert',
      body: 'Before it expires.',
    });

    const payload = await exportChatData('main', CHAT);
    expect(payload.missions).toEqual([]);
  });

  it('another chat\'s export does NOT leak this subject\'s mission', async () => {
    await createBoardMission({
      ownerAgent: 'main',
      createdByAgent: 'main',
      createdByChat: CHAT,
      title: 'Renew the TLS cert',
      body: 'Before it expires.',
    });
    const other = await exportChatData('main', 'telegram:000000');
    expect(other.missions).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ACCEPTANCE 5, THE OTHER HALF.
//
// The provenance row makes NEWLY CREATED Paperclip-origin missions exportable.
// It does nothing for the missions that already existed in DynamoDB when the
// operator armed the flag — and the board read is Paperclip-only, so those
// rows leave the export the instant the flag flips. Same silent shape as the
// `createdByChat` hole, arriving through a different door, and acceptance 5
// says "the subject's missions" without a "created after Tuesday" qualifier.
//
// `listMissionsForExport` is the only reader that unions both substrates.
// These pin that it does, that it does so unconditionally rather than as a
// failure fallback, and that a half-failed read is an ERROR rather than a
// short answer that looks complete.
// ═══════════════════════════════════════════════════════════════════════════
describe('ACCEPTANCE 5 (BLOCKING): the flag flip does not shrink a subject-access export', () => {
  const PRE_CUTOVER = {
    id: 'ddddffff-3333-4333-8333-333333333333',
    ownerAgent: 'main',
    createdByAgent: 'main',
    createdByChat: CHAT,
    title: 'Opened before the cutover',
    body: 'Lives only in DynamoDB.',
    priority: 'medium',
    status: 'open' as const,
    createdAt: '2026-08-01T09:00:00.000Z',
    updatedAt: '2026-08-01T09:00:00.000Z',
  };

  it('a pre-cutover DynamoDB mission is STILL exported after the flag is armed', async () => {
    preCutover.rows = [PRE_CUTOVER];

    // Before: legacy stack, the row is in the export.
    flag.value = undefined;
    const before = await exportChatData('main', CHAT);
    expect(before.missions.map((m) => m.id)).toEqual([PRE_CUTOVER.id]);

    // After: ACL armed, Paperclip holds nothing yet. The row must survive.
    flag.value = '1';
    __setMissionEngineForTest({
      listMissions: () => Promise.resolve([]),
      getMission: () => Promise.resolve(PROJECTED),
      createMission: () => Promise.resolve(PROJECTED),
      setStatus: () => Promise.resolve(PROJECTED),
      reassign: () => Promise.resolve(PROJECTED),
      comment: () => Promise.resolve(),
    } as unknown as MissionEngine);

    const after = await exportChatData('main', CHAT);
    expect(after.missions.map((m) => m.id)).toEqual([PRE_CUTOVER.id]);
    // Same five field names on either side of the flip.
    expect(Object.keys(after.missions[0])).toEqual([
      'id',
      'title',
      'body',
      'status',
      'createdAt',
    ]);
  });

  it('BOTH origins come back in one export — Paperclip-created and pre-cutover together', async () => {
    preCutover.rows = [PRE_CUTOVER];
    await createBoardMission({
      ownerAgent: 'main',
      createdByAgent: 'main',
      createdByChat: CHAT,
      title: 'Renew the TLS cert',
      body: 'Before it expires.',
    });

    const payload = await exportChatData('main', CHAT);
    expect(payload.missions.map((m) => m.id).sort()).toEqual([ISSUE, PRE_CUTOVER.id].sort());
  });

  it('CONTRAST: the BOARD does drop pre-cutover rows — the union is the export\'s alone', async () => {
    preCutover.rows = [PRE_CUTOVER];
    __setMissionEngineForTest({
      listMissions: () => Promise.resolve([]),
      getMission: () => Promise.resolve(PROJECTED),
      createMission: () => Promise.resolve(PROJECTED),
      setStatus: () => Promise.resolve(PROJECTED),
      reassign: () => Promise.resolve(PROJECTED),
      comment: () => Promise.resolve(),
    } as unknown as MissionEngine);

    // The documented cutover loss, asserted rather than assumed: the board is
    // one whole stack (C-8) and goes as empty as Paperclip is. Only the
    // compliance read refuses that.
    expect(await listBoardMissions('main', 100)).toEqual([]);
    expect((await exportChatData('main', CHAT)).missions).toHaveLength(1);
  });

  it('a row present in BOTH substrates under one id is exported ONCE, not twice', async () => {
    // Dedupe is by id, so an id-preserving migration is exact.
    preCutover.rows = [{ ...PRE_CUTOVER, id: ISSUE, title: 'Renew the TLS cert' }];
    await createBoardMission({
      ownerAgent: 'main',
      createdByAgent: 'main',
      createdByChat: CHAT,
      title: 'Renew the TLS cert',
      body: 'Before it expires.',
    });

    const payload = await exportChatData('main', CHAT);
    expect(payload.missions.map((m) => m.id)).toEqual([ISSUE]);
  });

  it('a Paperclip failure REJECTS the export — it never returns the DynamoDB half alone', async () => {
    preCutover.rows = [PRE_CUTOVER];
    __setMissionEngineForTest({
      listMissions: () => Promise.reject(new Error('paperclip transport down')),
      getMission: () => Promise.resolve(PROJECTED),
      createMission: () => Promise.resolve(PROJECTED),
      setStatus: () => Promise.resolve(PROJECTED),
      reassign: () => Promise.resolve(PROJECTED),
      comment: () => Promise.resolve(),
    } as unknown as MissionEngine);

    // The union is NOT a fallback. A half-readable subject-access response
    // shaped exactly like a complete one is the worst available outcome, so
    // the failure propagates instead of being absorbed.
    await expect(exportChatData('main', CHAT)).rejects.toThrow('paperclip transport down');
  });
});
