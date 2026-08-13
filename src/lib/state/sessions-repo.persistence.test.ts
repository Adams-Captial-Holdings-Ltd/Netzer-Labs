/**
 * Conversation persistence: which chats are allowed to expire.
 *
 * Sessions carry a 7-day DynamoDB TTL. That is right for Telegram and Slack —
 * neither surface has any way to browse history, so a permanent row there is
 * pure storage growth and an unasked-for retention change. It is wrong for the
 * dashboard, where the Chat tab lists prior conversations and reopens them.
 *
 * DynamoDB TTL only deletes items that CARRY the ttl attribute, so "persistent"
 * means omitting it entirely, not setting a far-future value.
 */

import { describe, it, expect } from 'vitest';
import { isPersistentChat } from './sessions-repo.js';

describe('isPersistentChat', () => {
  it('persists dashboard conversations', () => {
    expect(isPersistentChat('dashboard:1786626031081')).toBe(true);
  });

  it('expires bot-surface conversations', () => {
    // Telegram uses a raw numeric chat id; Slack uses slack:<channel>[:thread].
    expect(isPersistentChat('123456789')).toBe(false);
    expect(isPersistentChat('slack:C01ABCDEF')).toBe(false);
    expect(isPersistentChat('slack:C01ABCDEF:1699999999.000100')).toBe(false);
  });

  it('expires system, smoke and test chats', () => {
    // safeDashboardChatId lets these prefixes through unchanged. They are not
    // user-browsable conversations, so they keep the TTL.
    expect(isPersistentChat('system:nightly-consolidation')).toBe(false);
    expect(isPersistentChat('smoke:canary')).toBe(false);
    expect(isPersistentChat('test:fixture')).toBe(false);
  });

  it('expires owner-aliased principal chats', () => {
    expect(isPersistentChat('owner:emmanuel')).toBe(false);
  });

  it('does not match a chat that merely contains the prefix', () => {
    // Guards against a substring check creeping in.
    expect(isPersistentChat('slack:dashboard:C01')).toBe(false);
    expect(isPersistentChat('x-dashboard:1')).toBe(false);
  });

  it('handles the empty string without throwing', () => {
    expect(isPersistentChat('')).toBe(false);
  });
});
