/**
 * Integration test: kill-switches-repo against LocalStack.
 *
 * The repo's failure mode is fail-open (return active=false when DDB
 * is unreachable). The integration test verifies the read path works
 * end-to-end against a real DDB, and that the write path persists.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  ensureLocalStack,
  configureLocalAwsEnv,
  createDdbTable,
} from '../../__test-utils__/localstack.js';

const TABLE = 'claudeclaw-integ-kill-switches';

beforeAll(async () => {
  configureLocalAwsEnv();
  process.env.TABLE_KILL_SWITCHES = TABLE;
  await ensureLocalStack();
  await createDdbTable({
    name: TABLE,
    partitionKey: { name: 'PK', type: 'S' },
    sortKey: { name: 'SK', type: 'S' },
  });
});

async function loadRepo(): Promise<typeof import('./kill-switches-repo.js')> {
  return await import('./kill-switches-repo.js');
}

describe('kill-switches-repo (LocalStack)', () => {
  it('returns inactive when nothing has been written', async () => {
    const repo = await loadRepo();
    repo.invalidateKillSwitchCache();
    const state = await repo.isKillSwitchActive('bedrock_global');
    expect(state.active).toBe(false);
  });

  it('round-trips a written kill switch', async () => {
    const repo = await loadRepo();
    repo.invalidateKillSwitchCache();
    await repo.setKillSwitch(
      'tool_use',
      true,
      'integ test — incident drill',
      'integ-test',
    );
    const state = await repo.isKillSwitchActive('tool_use');
    expect(state.active).toBe(true);
    expect(state.reason).toMatch(/incident drill/);
  });

  it('clears the cache so a flip is visible without a 30s wait', async () => {
    const repo = await loadRepo();
    await repo.setKillSwitch('memory_writes', true, 'on', 'integ');
    expect((await repo.isKillSwitchActive('memory_writes')).active).toBe(true);
    await repo.setKillSwitch('memory_writes', false, 'off', 'integ');
    repo.invalidateKillSwitchCache('memory_writes');
    expect((await repo.isKillSwitchActive('memory_writes')).active).toBe(false);
  });
});
