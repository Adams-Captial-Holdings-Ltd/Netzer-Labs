/**
 * Integration test: scheduled-tasks-repo against LocalStack.
 *
 * Covers create → list → due-query → markFired → cancel for both
 * one-shot and recurring tasks.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  ensureLocalStack,
  configureLocalAwsEnv,
  createDdbTable,
} from '../../__test-utils__/localstack.js';

const TABLE = 'claudeclaw-integ-scheduled-tasks';

beforeAll(async () => {
  configureLocalAwsEnv();
  process.env.TABLE_SCHEDULED_TASKS = TABLE;
  await ensureLocalStack();
  await createDdbTable({
    name: TABLE,
    partitionKey: { name: 'PK', type: 'S' },
    sortKey: { name: 'SK', type: 'S' },
    gsis: [
      {
        indexName: 'gsi1-active-nextrun',
        partitionKey: { name: 'GSI1PK', type: 'S' },
        sortKey: { name: 'GSI1SK', type: 'S' },
      },
    ],
  });
});

async function loadRepo(): Promise<typeof import('./scheduled-tasks-repo.js')> {
  return await import('./scheduled-tasks-repo.js');
}

describe('scheduled-tasks-repo (LocalStack)', () => {
  it('one-shot task: create → due → markFired → transitions to done', async () => {
    const repo = await loadRepo();
    const nowSec = Math.floor(Date.now() / 1000);
    const task = await repo.createScheduledTask({
      agentId: 'integ-1',
      chatId: 'integ-chat-1',
      promptText: 'hello',
      nextRunAt: nowSec, // already due
      createdBy: 'agent',
    });
    expect(task.id).toBeTruthy();

    // Query due — should include our task
    const due = await repo.listDueTasks(nowSec + 1, 25);
    const found = due.find((t) => t.id === task.id);
    expect(found).toBeTruthy();

    // markFired → status=done
    await repo.markFired(task, new Date());
    const all = await repo.listScheduledTasksForAgent('integ-1', 50);
    expect(all.find((t) => t.id === task.id)?.status).toBe('done');
  });

  it('recurring task: markFired advances nextRunAt, status stays active', async () => {
    const repo = await loadRepo();
    const nowSec = Math.floor(Date.now() / 1000);
    const task = await repo.createScheduledTask({
      agentId: 'integ-2',
      chatId: 'integ-chat-2',
      promptText: 'every minute',
      nextRunAt: nowSec,
      intervalSec: 60,
      createdBy: 'agent',
    });
    await repo.markFired(task, new Date());
    const rows = await repo.listScheduledTasksForAgent('integ-2', 50);
    const refreshed = rows.find((t) => t.id === task.id);
    expect(refreshed?.status).toBe('active');
    expect(refreshed && refreshed.nextRunAt > task.nextRunAt).toBe(true);
  });

  it('cancel transitions to cancelled and drops out of the due query', async () => {
    const repo = await loadRepo();
    const nowSec = Math.floor(Date.now() / 1000);
    const task = await repo.createScheduledTask({
      agentId: 'integ-3',
      chatId: 'integ-chat-3',
      promptText: 'doomed',
      nextRunAt: nowSec,
      createdBy: 'agent',
    });
    const ok = await repo.cancelScheduledTask('integ-3', task.id);
    expect(ok).toBe(true);
    const due = await repo.listDueTasks(nowSec + 1, 25);
    expect(due.find((t) => t.id === task.id)).toBeUndefined();
  });
});
