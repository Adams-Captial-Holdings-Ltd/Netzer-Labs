import { beforeEach, describe, expect, it, vi } from 'vitest';

const { send } = vi.hoisted(() => ({
  send: vi.fn<(command: unknown) => Promise<unknown>>(() => Promise.resolve({})),
}));
vi.mock('./ddb.js', () => ({ ddb: () => ({ send }) }));

import { createMission, type MissionPriority } from './mission-tasks-repo.js';

beforeEach(() => {
  send.mockClear();
});

describe('four-band priority migration safety', () => {
  it('writes representative legacy-scale GSI ranks so mixed old/new rows sort by band', async () => {
    const priorities: MissionPriority[] = ['critical', 'high', 'medium', 'low'];
    for (const priority of priorities) {
      await createMission({
        ownerAgent: 'main',
        createdByAgent: 'main',
        createdByChat: 'test',
        title: priority,
        body: priority,
        priority,
      });
    }

    const newKeys = send.mock.calls.map(([command]) =>
      String((command as { input: { Item: { GSI1SK: string } } }).input.Item.GSI1SK),
    );
    expect(newKeys.map((key) => key.slice(9, 12))).toEqual(['095', '080', '050', '020']);

    const legacyKeys = [
      'PRIORITY#089#legacy-high',
      'PRIORITY#069#legacy-medium',
      'PRIORITY#039#legacy-low',
    ];
    expect([...newKeys, ...legacyKeys].sort().reverse().map((key) => key.slice(9, 12))).toEqual([
      '095', '089', '080', '069', '050', '039', '020',
    ]);
  });
});
