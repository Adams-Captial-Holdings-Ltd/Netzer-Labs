/** P4 artifact references must survive the per-message transcript, not just the 20-turn replay window. */
import { expect, it, vi } from 'vitest';
import { createFakeDynamo } from '../../__test-utils__/fake-dynamo.js';

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('./ddb.js', async (importActual) => {
  const actual = await importActual<typeof import('./ddb.js')>();
  return { ...actual, ddb: () => ({ send }) };
});
vi.mock('./runtime-config-repo.js', () => ({ getConfig: async () => undefined }));
vi.mock('../../agent/memory-ingest.js', () => ({ ingestEvictedTurns: async () => undefined }));

import { appendTurns, getFullHistory, getSession } from './sessions-repo.js';

it('P4 artifact references survive replay-window eviction in durable message records', async () => {
  const table = createFakeDynamo();
  send.mockImplementation((cmd: Parameters<typeof table.send>[0]) => table.send(cmd));
  const chatId = 'dashboard:p4-artifact-history';
  const owner = { surface: 'dashboard' as const, userId: 'dashboard:user:p4-owner', ephemeral: false };
  const artifact = { artifactId: 'f78d0000-0000-4000-8000-000000000001', version: 1,
    fileName: 'report.pdf', contentType: 'application/pdf', createdAt: '2026-09-25T00:00:00.000Z' };
  await appendTurns('main', chatId, [
    { role: 'user', text: 'Create the report', ts: 1 },
    { role: 'assistant', text: 'Ready.', ts: 1, artifacts: [artifact] },
  ], undefined, owner);
  const record = table.rows.get(`AGENT#main|CHAT#${chatId}#MSG#0000000001`);
  expect(record?.artifacts, 'message record must retain URL-free artifact references').toEqual([artifact]);
  for (let i = 0; i < 11; i++) {
    await appendTurns('main', chatId, [
      { role: 'user', text: `Later question ${i}`, ts: i + 2 },
      { role: 'assistant', text: `Later answer ${i}`, ts: i + 2 },
    ], undefined, owner);
  }
  const session = await getSession('main', chatId);
  expect(session?.turns.some((turn) => turn.text === 'Ready.')).toBe(false);
  const history = await getFullHistory('main', chatId, session!);
  expect(history.turns.find((turn) => turn.text === 'Ready.')?.artifacts).toEqual([artifact]);
});
