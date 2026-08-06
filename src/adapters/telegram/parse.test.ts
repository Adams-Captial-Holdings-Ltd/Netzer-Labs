import { describe, it, expect } from 'vitest';
import { parseUpdate } from './parse.js';
import type { TelegramUpdate } from './types.js';

const baseUpdate: TelegramUpdate = {
  update_id: 1,
  message: {
    message_id: 42,
    date: 1747521600,
    chat: { id: 12345, type: 'private', first_name: 'Emmanuel' },
    from: { id: 9999, is_bot: false, first_name: 'Emmanuel' },
    text: 'hello',
  },
};

describe('telegram parseUpdate', () => {
  it('normalizes a text message into IncomingMessage', () => {
    const msg = parseUpdate('main', baseUpdate);
    expect(msg).not.toBeNull();
    expect(msg!.surface).toBe('telegram');
    expect(msg!.agentId).toBe('main');
    expect(msg!.chatId).toBe('12345');
    expect(msg!.userId).toBe('9999');
    expect(msg!.messageId).toBe('42');
    expect(msg!.text).toBe('hello');
    expect(msg!.receivedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('drops messages from bots (feedback-loop guard)', () => {
    const fromBot: TelegramUpdate = {
      ...baseUpdate,
      message: {
        ...baseUpdate.message!,
        from: { id: 1, is_bot: true, first_name: 'OtherBot' },
      },
    };
    expect(parseUpdate('main', fromBot)).toBeNull();
  });

  it('returns null for updates without a message', () => {
    expect(parseUpdate('main', { update_id: 2 })).toBeNull();
  });

  it('returns null for messages with no text or caption', () => {
    const noText: TelegramUpdate = {
      ...baseUpdate,
      message: { ...baseUpdate.message!, text: undefined },
    };
    expect(parseUpdate('main', noText)).toBeNull();
  });

  it('uses caption when text is missing', () => {
    const captionOnly: TelegramUpdate = {
      ...baseUpdate,
      message: { ...baseUpdate.message!, text: undefined, caption: 'photo cap' },
    };
    const result = parseUpdate('main', captionOnly);
    expect(result?.text).toBe('photo cap');
  });
});
