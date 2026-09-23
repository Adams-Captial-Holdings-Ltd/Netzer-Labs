import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeDynamo } from '../../__test-utils__/fake-dynamo.js';

/**
 * P1 WI-1.4 — moving pre-WI-1.1 dashboard conversations onto the owner model
 * (owner decisions 8, 40, 46), against an in-memory table.
 *
 * Before WI-1.1 a dashboard conversation's owner was `dashboard:<tokenHash>`.
 * A person can be proven for it only through that token: its own `userId` (a
 * magic-link session) or the one user an admin linked it to (decision 1). What
 * can be proven is re-owned with an immutable source record; what cannot is
 * deleted (decision 46 — a handful existed, so no claim path). The version
 * fence and all-or-nothing transaction are proved against Floci in
 * sessions-repo.p1.integration.test.ts.
 */

const { send, writeAudit } = vi.hoisted(() => ({ send: vi.fn(), writeAudit: vi.fn() }));

vi.mock('./ddb.js', async (importActual) => {
  const actual = await importActual<typeof import('./ddb.js')>();
  return { ...actual, ddb: () => ({ send }) };
});
vi.mock('./runtime-config-repo.js', () => ({ getConfig: async () => undefined }));
vi.mock('../../agent/memory-ingest.js', () => ({ ingestEvictedTurns: () => undefined }));
vi.mock('../audit/audit-writer.js', async (importActual) => {
  const actual = await importActual<typeof import('../audit/audit-writer.js')>();
  return { ...actual, writeAudit: (e: unknown) => writeAudit(e) };
});

import { migrateLegacyConversations } from './legacy-chat-migration.js';

let table: ReturnType<typeof createFakeDynamo>;

beforeEach(() => {
  table = createFakeDynamo();
  send.mockReset();
  send.mockImplementation(table.send);
  writeAudit.mockReset();
  writeAudit.mockResolvedValue(undefined);
});

const HASH = { session: 'a'.repeat(64), linked: 'b'.repeat(64), noPerson: 'c'.repeat(64), gone: 'd'.repeat(64) };

function token(hash: string, extra: Record<string, unknown> = {}) {
  table.rows.set(`TOKEN#${hash}|META`, {
    PK: `TOKEN#${hash}`, SK: 'META', tokenHash: hash, label: 'l', createdAt: 'x', lastUsedAt: 'x',
    createdBy: 'system', active: true, role: 'admin', ...extra,
  });
}

/** A dashboard conversation as the pre-WI-1.1 code left it: owner is a token hash, no ttl. */
function legacyChat(chatId: string, owner: string | undefined, extra: Record<string, unknown> = {}) {
  table.rows.set(`AGENT#main|CHAT#${chatId}`, {
    PK: 'AGENT#main',
    SK: `CHAT#${chatId}`,
    turns: [
      { role: 'user', text: `${chatId} question`, ts: 1 },
      { role: 'assistant', text: `${chatId} answer`, ts: 2 },
    ],
    updatedAt: 2,
    ...(owner === undefined ? {} : { userId: owner }),
    ...extra,
  });
}

const row = (chatId: string) => table.rows.get(`AGENT#main|CHAT#${chatId}`);
const children = (chatId: string) =>
  [...table.rows.values()].filter((r) => r.PK === 'AGENT#main' && String(r.SK).startsWith(`CHAT#${chatId}#`));
const snapshot = () => JSON.stringify([...table.rows.entries()].sort());

function seedEveryCase() {
  token(HASH.session, { userId: 'user-a', createdBy: 'user:user-a' });
  token(HASH.linked, { linkedUserId: 'user-owner' });
  token(HASH.noPerson, { createdBy: 'dashboard:ops' });
  legacyChat('dashboard:1', `dashboard:${HASH.session}`);
  legacyChat('dashboard:2', `dashboard:${HASH.linked}`);
  legacyChat('dashboard:3', `dashboard:${HASH.noPerson}`);
  legacyChat('dashboard:4', `dashboard:${HASH.gone}`);
  legacyChat('dashboard:5', undefined);
  // Not legacy: already a person's, ephemeral (decision 1), another surface.
  legacyChat('dashboard:6', 'dashboard:user:user-a');
  legacyChat('dashboard:7', `dashboard:${HASH.noPerson}`, { ttl: 9_999_999_999 });
  legacyChat('slack:C1:U1', 'U1', { ttl: 9_999_999_999 });
}

describe('provable owners are moved over (WI-1.4, decision 46)', () => {
  it('maps a legacy conversation through its session token\'s user, with an immutable source record', async () => {
    seedEveryCase();

    await migrateLegacyConversations({ apply: true });

    expect(row('dashboard:1')?.userId).toBe('dashboard:user:user-a');
    // The version bump is what makes a turn racing the migration re-read, so it
    // cannot write the old owner back (appendTurns' version fence).
    expect(row('dashboard:1')?.version).toBe(1);
    const src = children('dashboard:1').find((r) => String(r.SK).endsWith('#SRC'));
    expect(src).toMatchObject({ legacyOwner: `dashboard:${HASH.session}`, owner: 'dashboard:user:user-a', provenBy: 'session' });
  });

  it('maps a legacy conversation through the admin link on a token with no user of its own', async () => {
    // Decision 46: the owner's master token wrote five production conversations
    // and is linked to the owner before this runs.
    seedEveryCase();

    await migrateLegacyConversations({ apply: true });

    expect(row('dashboard:2')?.userId).toBe('dashboard:user:user-owner');
    expect(children('dashboard:2').find((r) => String(r.SK).endsWith('#SRC'))).toMatchObject({ provenBy: 'link' });
  });

  it('maps a legacy conversation and gives each pre-P1 window turn its own record, which it had nowhere else', async () => {
    seedEveryCase();

    await migrateLegacyConversations({ apply: true });

    const records = children('dashboard:1').filter((r) => String(r.SK).includes('#MSG#'));
    expect(records.map((r) => [r.seq, r.text])).toEqual([[0, 'dashboard:1 question'], [1, 'dashboard:1 answer']]);
    expect(records.every((r) => r.userId === 'dashboard:user:user-a')).toBe(true);
  });
});

describe('unprovable owners are deleted (WI-1.4, decision 46)', () => {
  it('deletes a legacy conversation whose token is gone, a token with no person, or no owner at all — records and all', async () => {
    seedEveryCase();
    table.rows.set('AGENT#main|CHAT#dashboard:4#MSG#0000000000', {
      PK: 'AGENT#main', SK: 'CHAT#dashboard:4#MSG#0000000000', seq: 0, role: 'user', text: 'x',
    });

    await migrateLegacyConversations({ apply: true });

    for (const chatId of ['dashboard:3', 'dashboard:4', 'dashboard:5']) {
      expect(row(chatId)).toBeUndefined();
      expect(children(chatId)).toEqual([]);
    }
  });

  it('deletes a legacy conversation and audits every deletion', async () => {
    seedEveryCase();

    const report = await migrateLegacyConversations({ apply: true });

    expect(report.deleted).toBe(3);
    const purges = writeAudit.mock.calls.map((c) => c[0] as Record<string, unknown>);
    expect(purges.map((e) => e.chatId).sort()).toEqual(['dashboard:3', 'dashboard:4', 'dashboard:5']);
    for (const e of purges) expect(e).toMatchObject({ action: 'data_purged', detail: expect.objectContaining({ scope: 'legacy-migration' }) });
  });
});

describe('what the migration leaves alone', () => {
  it('skips conversations already owned by a person, ephemeral rows and other surfaces', async () => {
    seedEveryCase();
    const before = { 6: row('dashboard:6'), 7: row('dashboard:7'), slack: row('slack:C1:U1') };

    const report = await migrateLegacyConversations({ apply: true });

    expect(row('dashboard:6')).toEqual(before[6]);
    expect(row('dashboard:7')).toEqual(before[7]);
    expect(row('slack:C1:U1')).toEqual(before.slack);
    expect(report.skipped).toEqual({ alreadyOwned: 1, ephemeral: 1, otherSurface: 1 });
  });
});

describe('a dry run by default, and safe to repeat', () => {
  it('changes nothing unless it is told to apply, and still reports what it would do', async () => {
    seedEveryCase();
    const before = snapshot();

    const report = await migrateLegacyConversations({ apply: false });

    expect(snapshot()).toBe(before);
    expect(writeAudit).not.toHaveBeenCalled();
    expect(report).toMatchObject({
      apply: false,
      legacy: 5,
      mapped: { session: 1, link: 1 },
      unprovable: { tokenGone: 1, noPerson: 1, noOwner: 1 },
      reowned: 0,
      deleted: 0,
    });
  });

  it('running it twice changes nothing the second time', async () => {
    seedEveryCase();
    const initial = snapshot();
    const first = await migrateLegacyConversations({ apply: true });
    const afterFirst = snapshot();
    // The first run must really have done the work, or "nothing changed the
    // second time" is true of a migration that never does anything (M41).
    expect(afterFirst).not.toBe(initial);
    expect(first).toMatchObject({ reowned: 2, deleted: 3 });

    const second = await migrateLegacyConversations({ apply: true });

    expect(snapshot()).toBe(afterFirst);
    expect(second).toMatchObject({ legacy: 0, reowned: 0, deleted: 0 });
  });
});
