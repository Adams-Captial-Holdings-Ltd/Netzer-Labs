import { describe, it, expect } from 'vitest';
import {
  createScheduledTask,
} from './scheduled-tasks-repo.js';

// Pure-logic checks on argument validation. The repo's DDB writes
// aren't exercised here — those run in prod smoke tests — but the
// rate-limit guard is pure validation and worth a unit test.

describe('createScheduledTask validation', () => {
  it('rejects sub-minute intervalSec', async () => {
    await expect(
      createScheduledTask({
        agentId: 'main',
        chatId: 'unit-test',
        promptText: 'noop',
        nextRunAt: Math.floor(Date.now() / 1000) + 60,
        intervalSec: 30,
      }),
    ).rejects.toThrowError(/>= 60/);
  });

  it('rejects negative intervalSec', async () => {
    await expect(
      createScheduledTask({
        agentId: 'main',
        chatId: 'unit-test',
        promptText: 'noop',
        nextRunAt: Math.floor(Date.now() / 1000) + 60,
        intervalSec: -1,
      }),
    ).rejects.toThrowError(/>= 60/);
  });
});
