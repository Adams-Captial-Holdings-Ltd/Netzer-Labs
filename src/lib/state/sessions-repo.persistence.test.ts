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
import { isPersistentChat, repairEmptyTurns, NO_RESPONSE_NOTICE, type Turn } from './sessions-repo.js';

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

/**
 * A chat must never be able to kill itself permanently.
 *
 * Production, 2026-08-24, chat dashboard:1787596504860: a request for a SWOT
 * analysis PDF hit outputTokens 1024 / stopReason max_tokens while the model
 * was still emitting the generate_document call, so the reply carried no text
 * block at all. The empty assistant turn was persisted, and both following
 * turns died on
 *   ValidationException: messages: text content blocks must be non-empty
 * with no reply produced — the turn simply never returned. That chat stays
 * dead until the history is repaired, which is what this does on read.
 */
describe('repairEmptyTurns', () => {
  const t = (role: 'user' | 'assistant', text: string): Turn => ({ role, text, ts: 1 });

  it('replaces an empty assistant turn rather than dropping it', () => {
    // Dropping it would leave two adjacent user turns, which Bedrock rejects
    // just as hard as the empty block did.
    expect(repairEmptyTurns([t('user', 'give me a pdf'), t('assistant', ''), t('user', 'hello?')])).toEqual([
      t('user', 'give me a pdf'),
      t('assistant', NO_RESPONSE_NOTICE),
      t('user', 'hello?'),
    ]);
  });

  it('treats whitespace-only text as empty', () => {
    expect(repairEmptyTurns([t('assistant', '   \n\t ')])).toEqual([t('assistant', NO_RESPONSE_NOTICE)]);
  });

  it('survives a stored turn whose text is missing entirely', () => {
    const legacy = [{ role: 'assistant', ts: 1 } as unknown as Turn];
    expect(repairEmptyTurns(legacy)[0]?.text).toBe(NO_RESPONSE_NOTICE);
  });

  it('leaves a healthy transcript untouched', () => {
    const turns = [t('user', 'hi'), t('assistant', 'hello')];
    expect(repairEmptyTurns(turns)).toEqual(turns);
  });

  it('never emits a turn Bedrock would reject', () => {
    const poisoned = [t('user', 'a'), t('assistant', ''), t('user', 'b'), t('assistant', '  ')];
    for (const turn of repairEmptyTurns(poisoned)) {
      expect(turn.text.trim().length).toBeGreaterThan(0);
    }
  });
});

/**
 * The guard must be WIRED, not merely present.
 *
 * A harsh review caught that nothing proved `getSession` actually calls
 * `repairEmptyTurns` — the unit tests above import the pure function and assert
 * on arrays, which would still pass if the call site were deleted. It also
 * caught that `t.text?.trim()` guards null and undefined but NOT a wrong type:
 * a legacy row whose text is a number threw a TypeError inside getSession,
 * turning a poisoned chat into a 500 instead of repairing it.
 */
describe('repairEmptyTurns hardening', () => {
  const t = (role: 'user' | 'assistant', text: unknown): Turn =>
    ({ role, text, ts: 1 }) as unknown as Turn;

  it('survives a stored turn whose text is a number, not a string', () => {
    expect(() => repairEmptyTurns([t('assistant', 42)])).not.toThrow();
    expect(repairEmptyTurns([t('assistant', 42)])[0]?.text).toBe(NO_RESPONSE_NOTICE);
  });

  it('survives null, undefined and object text alike', () => {
    for (const bad of [null, undefined, {}, []]) {
      expect(() => repairEmptyTurns([t('assistant', bad)])).not.toThrow();
      expect(repairEmptyTurns([t('assistant', bad)])[0]?.text).toBe(NO_RESPONSE_NOTICE);
    }
  });

  it('never emits a turn Bedrock would reject, whatever the stored shape', () => {
    const junk = [t('user', 'a'), t('assistant', 42), t('user', null), t('assistant', '  ')];
    for (const turn of repairEmptyTurns(junk)) {
      expect(typeof turn.text).toBe('string');
      expect(turn.text.trim().length).toBeGreaterThan(0);
    }
  });
});
