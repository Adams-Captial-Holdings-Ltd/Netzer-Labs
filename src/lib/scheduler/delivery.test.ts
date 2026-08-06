import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { sendTelegramMock, sendSlackMock, listLinksMock } = vi.hoisted(() => ({
  sendTelegramMock: vi.fn().mockResolvedValue({ ok: true }),
  sendSlackMock: vi.fn().mockResolvedValue({ ok: true }),
  listLinksMock: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../adapters/telegram/send.js', () => ({
  sendMessage: sendTelegramMock,
}));
vi.mock('../../adapters/slack/send.js', () => ({
  postMessage: sendSlackMock,
}));
vi.mock('../state/identities-repo.js', () => ({
  listLinks: listLinksMock,
}));

import {
  parseSlackChatId,
  resolveDeliveryTarget,
  deliverScheduledReply,
} from './delivery.js';
import type { ScheduledTask } from '../state/scheduled-tasks-repo.js';

function task(over: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 't1',
    agentId: 'main',
    chatId: '123456789',
    promptText: 'brief',
    nextRunAt: 1,
    status: 'active',
    createdAt: '2026-06-12T00:00:00Z',
    createdBy: 'agent',
    ...over,
  };
}

const SAVED_ENV = process.env.CCE_OWNER_TELEGRAM_CHATS;

beforeEach(() => {
  vi.clearAllMocks();
  listLinksMock.mockResolvedValue([]);
  delete process.env.CCE_OWNER_TELEGRAM_CHATS;
});

afterEach(() => {
  if (SAVED_ENV === undefined) delete process.env.CCE_OWNER_TELEGRAM_CHATS;
  else process.env.CCE_OWNER_TELEGRAM_CHATS = SAVED_ENV;
});

describe('parseSlackChatId', () => {
  it('parses all four chatId shapes', () => {
    expect(parseSlackChatId('slack:C0123')).toEqual({ channel: 'C0123' });
    expect(parseSlackChatId('slack:C0123:U0456')).toEqual({ channel: 'C0123' });
    expect(parseSlackChatId('slack:C0123:1234567890.123456')).toEqual({
      channel: 'C0123',
      threadTs: '1234567890.123456',
    });
    expect(parseSlackChatId('slack:C0123:U0456:1234567890.123')).toEqual({
      channel: 'C0123',
      threadTs: '1234567890.123',
    });
  });
});

describe('resolveDeliveryTarget', () => {
  it('explicit deliveryTarget wins over everything', async () => {
    const t = task({
      chatId: 'owner:emmanuel',
      deliveryTarget: { surface: 'slack', chatId: 'slack:C0999' },
    });
    expect(await resolveDeliveryTarget(t)).toEqual({ surface: 'slack', chatId: 'slack:C0999' });
  });

  it('slack: prefix routes to slack', async () => {
    expect(await resolveDeliveryTarget(task({ chatId: 'slack:C0123:U1' }))).toEqual({
      surface: 'slack',
      chatId: 'slack:C0123:U1',
    });
  });

  it('dashboard/system/delegation chatIds deliver nowhere', async () => {
    expect(await resolveDeliveryTarget(task({ chatId: 'dashboard:171' }))).toBeNull();
    expect(await resolveDeliveryTarget(task({ chatId: 'system:dashboard-ab' }))).toBeNull();
    expect(await resolveDeliveryTarget(task({ chatId: 'delegation:main:x' }))).toBeNull();
  });

  it('owner:* resolves through CCE_OWNER_TELEGRAM_CHATS (the bug this module fixes)', async () => {
    process.env.CCE_OWNER_TELEGRAM_CHATS = '987654321, 1111';
    expect(await resolveDeliveryTarget(task({ chatId: 'owner:emmanuel' }))).toEqual({
      surface: 'telegram',
      chatId: '987654321',
    });
  });

  it('owner:* without configured chats delivers nowhere (never a literal owner: chat_id)', async () => {
    expect(await resolveDeliveryTarget(task({ chatId: 'owner:emmanuel' }))).toBeNull();
    expect(sendTelegramMock).not.toHaveBeenCalled();
  });

  it('user:* resolves through identity links, telegram preferred', async () => {
    listLinksMock.mockResolvedValue([
      { canonicalId: 'abc', surface: 'slack', surfaceUserId: 'U777', claimedAt: '' },
      { canonicalId: 'abc', surface: 'telegram', surfaceUserId: '555', claimedAt: '' },
    ]);
    expect(await resolveDeliveryTarget(task({ chatId: 'user:abc' }))).toEqual({
      surface: 'telegram',
      chatId: '555',
    });
  });

  it('legacy numeric chatIds default to telegram', async () => {
    expect(await resolveDeliveryTarget(task({ chatId: '123456789' }))).toEqual({
      surface: 'telegram',
      chatId: '123456789',
    });
  });
});

describe('deliverScheduledReply', () => {
  it('sends via slack with parsed thread', async () => {
    await deliverScheduledReply(
      task({ deliveryTarget: { surface: 'slack', chatId: 'slack:C01:1700000000.123456' } }),
      'hello',
    );
    expect(sendSlackMock).toHaveBeenCalledWith('C01', 'hello', { threadTs: '1700000000.123456' });
  });

  it('sends via telegram for explicit telegram targets', async () => {
    await deliverScheduledReply(
      task({ chatId: 'owner:emmanuel', deliveryTarget: { surface: 'telegram', chatId: '42' } }),
      'hello',
    );
    expect(sendTelegramMock).toHaveBeenCalledWith('main', '42', 'hello', {});
  });

  it('no-ops when there is no target', async () => {
    await deliverScheduledReply(task({ chatId: 'system:x' }), 'hello');
    expect(sendTelegramMock).not.toHaveBeenCalled();
    expect(sendSlackMock).not.toHaveBeenCalled();
  });
});
