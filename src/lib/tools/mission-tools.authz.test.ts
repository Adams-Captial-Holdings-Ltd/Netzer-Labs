import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  createMissionMock,
  listByStatusMock,
  listForAgentMock,
  updateStatusMock,
  listKnownAgentsMock,
} = vi.hoisted(() => ({
  createMissionMock: vi.fn(),
  listByStatusMock: vi.fn(),
  listForAgentMock: vi.fn(),
  updateStatusMock: vi.fn(),
  listKnownAgentsMock: vi.fn(),
}));

vi.mock('../state/mission-tasks-repo.js', () => ({
  createMission: createMissionMock,
  listMissionsByStatus: listByStatusMock,
  listMissionsForAgent: listForAgentMock,
  updateMissionStatus: updateStatusMock,
}));
vi.mock('../state/inter-agent-tasks-repo.js', () => ({ sendInterAgent: vi.fn() }));
vi.mock('../config/agent-loader.js', () => ({
  listKnownAgents: listKnownAgentsMock,
  loadAgent: vi.fn(),
}));
vi.mock('../bedrock/client.js', () => ({ converseTurn: vi.fn() }));

import './mission-tools.js'; // side-effect registration
import { tools } from './registry.js';

const ctx = { agentId: 'research', chatId: 'owner:emmanuel' };

beforeEach(() => {
  vi.clearAllMocks();
  listKnownAgentsMock.mockReturnValue(['main', 'research', 'ops']);
  listByStatusMock.mockResolvedValue([]);
  listForAgentMock.mockResolvedValue([]);
  updateStatusMock.mockResolvedValue(true);
});

// Missions are per-agent state. An agent naming another agent's owner id must
// be refused on both the read and the write path; without these checks any
// prompt-injected agent could read or cancel another agent's queue.
describe('mission tool ownership checks', () => {
  it('list_missions refuses a foreign owner', async () => {
    const out = await tools.invoke('list_missions', { owner: 'ops' }, ctx);
    expect(out.isError).toBe(true);
    expect(listByStatusMock).not.toHaveBeenCalled();
    expect(listForAgentMock).not.toHaveBeenCalled();
  });

  it('list_missions defaults to the calling agent', async () => {
    await tools.invoke('list_missions', {}, ctx);
    expect(listByStatusMock).toHaveBeenCalledWith('research', 'open', 15);
  });

  it('list_missions allows naming yourself explicitly', async () => {
    await tools.invoke('list_missions', { owner: 'research' }, ctx);
    expect(listByStatusMock).toHaveBeenCalledWith('research', 'open', 15);
  });

  it('update_mission refuses a foreign owner', async () => {
    const out = await tools.invoke(
      'update_mission',
      { mission_id: 'abc12345', owner: 'ops', status: 'cancelled' },
      ctx,
    );
    expect(out.isError).toBe(true);
    expect(updateStatusMock).not.toHaveBeenCalled();
  });

  it('update_mission still works on your own missions', async () => {
    const out = await tools.invoke(
      'update_mission',
      { mission_id: 'abc12345', status: 'done' },
      ctx,
    );
    expect(out.isError).toBeFalsy();
    expect(updateStatusMock).toHaveBeenCalledWith('research', 'abc12345', 'done');
  });
});
