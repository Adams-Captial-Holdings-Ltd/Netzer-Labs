/** P4 WI-4.4: forget_me uses the shared artifact erasure and records partial failure. */
import { beforeEach, expect, it, vi } from 'vitest';

const { deleteSession, listMemoriesForChat, forgetMemory, auditStrict, auditLoose } = vi.hoisted(() => ({
  deleteSession: vi.fn(), listMemoriesForChat: vi.fn(), forgetMemory: vi.fn(),
  auditStrict: vi.fn(), auditLoose: vi.fn(),
}));
vi.mock('../state/sessions-repo.js', () => ({ getSession: async () => null, deleteSession }));
vi.mock('../state/memories-repo.js', () => ({ listMemoriesForChat, forgetMemory }));
vi.mock('../state/scheduled-tasks-repo.js', () => ({ listScheduledTasksForAgent: async () => [], deleteScheduledTask: vi.fn() }));
vi.mock('../state/inter-agent-tasks-repo.js', () => ({ listInbox: async () => [], deleteInterAgentTask: vi.fn() }));
vi.mock('../missions/mission-acl.js', () => ({ listMissionsForExport: async () => [] }));
vi.mock('../audit/audit-writer.js', () => ({ writeAuditOrThrow: auditStrict, writeAudit: auditLoose }));
vi.mock('../../observability/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const AGENT = 'main';
const CHAT = 'dashboard:p4-privacy';
const { purgeChatData } = await import('./privacy-tools.js');

beforeEach(() => {
  deleteSession.mockReset().mockResolvedValue(undefined);
  listMemoriesForChat.mockReset().mockResolvedValue([]);
  forgetMemory.mockReset().mockResolvedValue(undefined);
  auditStrict.mockReset().mockResolvedValue(undefined);
  auditLoose.mockReset().mockResolvedValue(undefined);
});

it('P4 forget me erases artifact versions through the shared delete path', async () => {
  const order: string[] = [];
  deleteSession.mockImplementation(async () => { order.push('shared-delete'); });
  auditStrict.mockImplementation(async () => { order.push('durable-audit'); });

  const report = await purgeChatData(AGENT, CHAT);

  expect(deleteSession, 'forget_me must call the same version-aware deleteSession as the owner route')
    .toHaveBeenCalledOnce();
  expect(deleteSession).toHaveBeenCalledWith(AGENT, CHAT);
  expect(auditStrict, 'the success trail must be durably accepted before forget_me returns').toHaveBeenCalledOnce();
  expect(order).toEqual(['shared-delete', 'durable-audit']);
  expect(report.counts.sessionDeleted).toBe(true);
  expect(auditLoose, 'fire-and-forget audit cannot prove the erasure').not.toHaveBeenCalled();
});

it('P4 forget me records a partial failure after earlier data was deleted', async () => {
  listMemoriesForChat.mockResolvedValue([{ id: 'm-1', content: 'private', importance: 1, tags: [], createdAt: '2026-01-01' }]);
  deleteSession.mockRejectedValue(new Error('S3 version delete denied'));

  await expect(purgeChatData(AGENT, CHAT)).rejects.toThrow(/version delete denied/i);

  expect(forgetMemory).toHaveBeenCalledOnce();
  expect(forgetMemory).toHaveBeenCalledWith(AGENT, CHAT, 'm-1');
  expect(auditStrict, 'partial erasure needs a durable audit even when the session remains').toHaveBeenCalledOnce();
  expect(auditStrict.mock.calls[0][0]).toMatchObject({ action: 'data_purged', agentId: AGENT, chatId: CHAT,
    result: 'error', detail: { counts: { memories: 1, sessionDeleted: false } } });
  expect(auditLoose).not.toHaveBeenCalled();
});
