import { describe, it, expect, vi, beforeEach } from 'vitest';

// GDPR coverage for owner-scoped conversations (ADR 0010): forget_me /
// DELETE /api/export must erase the durable transcript + meta, and the export
// must include the full transcript — for `dashboard:c_*` chats only. Legacy
// and bot chats have no durable items and must not trigger the extra calls.

vi.mock('../../observability/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../audit/audit-writer.js', () => ({
  writeAudit: vi.fn(() => Promise.resolve()),
}));

const {
  getSessionMock,
  deleteSessionMock,
  listMemoriesMock,
  forgetMemoryMock,
  listScheduledMock,
  deleteScheduledMock,
  listInboxMock,
  deleteInterAgentMock,
  listMissionsMock,
  listMessagesMock,
  deleteConversationDataMock,
} = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  deleteSessionMock: vi.fn(),
  listMemoriesMock: vi.fn(),
  forgetMemoryMock: vi.fn(),
  listScheduledMock: vi.fn(),
  deleteScheduledMock: vi.fn(),
  listInboxMock: vi.fn(),
  deleteInterAgentMock: vi.fn(),
  listMissionsMock: vi.fn(),
  listMessagesMock: vi.fn(),
  deleteConversationDataMock: vi.fn(),
}));

vi.mock('../state/sessions-repo.js', async (importActual) => {
  const actual = await importActual<typeof import('../state/sessions-repo.js')>();
  return { ...actual, getSession: getSessionMock, deleteSession: deleteSessionMock };
});
vi.mock('../state/memories-repo.js', async (importActual) => {
  const actual = await importActual<typeof import('../state/memories-repo.js')>();
  return { ...actual, listMemoriesForChat: listMemoriesMock, forgetMemory: forgetMemoryMock };
});
vi.mock('../state/scheduled-tasks-repo.js', async (importActual) => {
  const actual = await importActual<typeof import('../state/scheduled-tasks-repo.js')>();
  return {
    ...actual,
    listScheduledTasksForAgent: listScheduledMock,
    deleteScheduledTask: deleteScheduledMock,
  };
});
vi.mock('../state/inter-agent-tasks-repo.js', async (importActual) => {
  const actual = await importActual<typeof import('../state/inter-agent-tasks-repo.js')>();
  return { ...actual, listInbox: listInboxMock, deleteInterAgentTask: deleteInterAgentMock };
});
vi.mock('../state/mission-tasks-repo.js', async (importActual) => {
  const actual = await importActual<typeof import('../state/mission-tasks-repo.js')>();
  return { ...actual, listMissionsForAgent: listMissionsMock };
});
vi.mock('../state/conversations-repo.js', async (importActual) => {
  const actual = await importActual<typeof import('../state/conversations-repo.js')>();
  return {
    ...actual, // keep the real isConversationChatId — it is the discriminator under test
    listMessages: listMessagesMock,
    deleteConversationData: deleteConversationDataMock,
  };
});

import { exportChatData, purgeChatData } from './privacy-tools.js';

beforeEach(() => {
  vi.clearAllMocks();
  getSessionMock.mockResolvedValue(null);
  deleteSessionMock.mockResolvedValue(undefined);
  listMemoriesMock.mockResolvedValue([]);
  listScheduledMock.mockResolvedValue([]);
  listInboxMock.mockResolvedValue([]);
  listMissionsMock.mockResolvedValue([]);
  listMessagesMock.mockResolvedValue([
    { role: 'user', text: 'hello', ts: 1 },
    { role: 'assistant', text: 'hi', ts: 1 },
  ]);
  deleteConversationDataMock.mockResolvedValue({ messagesDeleted: 2, metaDeleted: true });
});

describe('exportChatData', () => {
  it('includes the full durable transcript for an owner-scoped conversation', async () => {
    const out = await exportChatData('main', 'dashboard:c_abc');
    expect(listMessagesMock).toHaveBeenCalledWith('dashboard:c_abc', 1000);
    expect(out.messages).toHaveLength(2);
    expect(out.messages?.[0]).toEqual({ role: 'user', text: 'hello', ts: 1 });
  });

  it('omits messages for legacy and bot chats (no durable transcript exists)', async () => {
    const legacy = await exportChatData('main', 'dashboard:1755100000000');
    expect(legacy.messages).toBeUndefined();
    const bot = await exportChatData('main', '123456789');
    expect(bot.messages).toBeUndefined();
    expect(listMessagesMock).not.toHaveBeenCalled();
  });
});

describe('purgeChatData', () => {
  it('erases the durable transcript + meta for an owner-scoped conversation', async () => {
    const report = await purgeChatData('main', 'dashboard:c_abc');
    expect(deleteConversationDataMock).toHaveBeenCalledWith('dashboard:c_abc');
    expect(report.counts.conversationMessages).toBe(2);
    expect(report.counts.sessionDeleted).toBe(true);
  });

  it('skips conversation erasure for legacy chats but still purges the session', async () => {
    const report = await purgeChatData('main', 'dashboard:1755100000000');
    expect(deleteConversationDataMock).not.toHaveBeenCalled();
    expect(report.counts.conversationMessages).toBe(0);
    expect(deleteSessionMock).toHaveBeenCalledWith('main', 'dashboard:1755100000000');
  });
});
