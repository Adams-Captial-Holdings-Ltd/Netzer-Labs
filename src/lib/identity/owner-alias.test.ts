import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveOwnerChatId, isPrincipalScopedChatId } from './owner-alias.js';

const ORIGINAL_ENV: Record<string, string | undefined> = {};
const KEYS = [
  'CCE_OWNER_TELEGRAM_CHATS',
  'CCE_OWNER_SLACK_USERS',
  'CCE_OWNER_DASHBOARD_EMAILS',
  'CCE_OWNER_LABEL',
] as const;

beforeEach(() => {
  for (const k of KEYS) {
    ORIGINAL_ENV[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of KEYS) {
    if (ORIGINAL_ENV[k] === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = ORIGINAL_ENV[k];
    }
  }
});

describe('resolveOwnerChatId', () => {
  it('returns null when no env vars are configured', () => {
    expect(resolveOwnerChatId('telegram', '12345')).toBeNull();
    expect(resolveOwnerChatId('slack', 'U_FAKE')).toBeNull();
  });

  it('maps a configured telegram chat to owner:<label>', () => {
    process.env.CCE_OWNER_TELEGRAM_CHATS = '12345';
    process.env.CCE_OWNER_LABEL = 'emmanuel';
    expect(resolveOwnerChatId('telegram', '12345')).toBe('owner:emmanuel');
  });

  it('does not match a telegram chat that is not on the list', () => {
    process.env.CCE_OWNER_TELEGRAM_CHATS = '12345';
    expect(resolveOwnerChatId('telegram', '99999')).toBeNull();
  });

  it('maps a configured slack user to owner:<label>', () => {
    process.env.CCE_OWNER_SLACK_USERS = 'U05NFC6BUSC';
    process.env.CCE_OWNER_LABEL = 'emmanuel';
    expect(resolveOwnerChatId('slack', 'U05NFC6BUSC')).toBe('owner:emmanuel');
  });

  it('does not match a slack user that is not on the list', () => {
    process.env.CCE_OWNER_SLACK_USERS = 'U05NFC6BUSC';
    expect(resolveOwnerChatId('slack', 'U_OTHER')).toBeNull();
  });

  it('supports comma-separated entries with surrounding whitespace', () => {
    process.env.CCE_OWNER_TELEGRAM_CHATS = '1, 2,3 ,4';
    expect(resolveOwnerChatId('telegram', '1')).toBe('owner:owner');
    expect(resolveOwnerChatId('telegram', '2')).toBe('owner:owner');
    expect(resolveOwnerChatId('telegram', '3')).toBe('owner:owner');
    expect(resolveOwnerChatId('telegram', '4')).toBe('owner:owner');
    expect(resolveOwnerChatId('telegram', '5')).toBeNull();
  });

  it('defaults the label to `owner` when CCE_OWNER_LABEL is unset', () => {
    process.env.CCE_OWNER_TELEGRAM_CHATS = '12345';
    expect(resolveOwnerChatId('telegram', '12345')).toBe('owner:owner');
  });

  it('uses a custom label when CCE_OWNER_LABEL is set', () => {
    process.env.CCE_OWNER_SLACK_USERS = 'U_ABC';
    process.env.CCE_OWNER_LABEL = 'founder';
    expect(resolveOwnerChatId('slack', 'U_ABC')).toBe('owner:founder');
  });

  it('treats undefined identifier as no match', () => {
    process.env.CCE_OWNER_SLACK_USERS = 'U_ABC';
    expect(resolveOwnerChatId('slack', undefined)).toBeNull();
  });

  it('maps a configured dashboard email case-insensitively', () => {
    process.env.CCE_OWNER_DASHBOARD_EMAILS = 'Boss@Example.com, two@example.com';
    process.env.CCE_OWNER_LABEL = 'emmanuel';
    expect(resolveOwnerChatId('dashboard', 'boss@example.com')).toBe('owner:emmanuel');
    expect(resolveOwnerChatId('dashboard', 'BOSS@EXAMPLE.COM')).toBe('owner:emmanuel');
    expect(resolveOwnerChatId('dashboard', 'other@example.com')).toBeNull();
    expect(resolveOwnerChatId('dashboard', undefined)).toBeNull();
  });
});

describe('isPrincipalScopedChatId', () => {
  it('accepts only owner/user scoped ids — never channel or dashboard sessions', () => {
    expect(isPrincipalScopedChatId('owner:emmanuel')).toBe(true);
    expect(isPrincipalScopedChatId('user:abc-123')).toBe(true);
    expect(isPrincipalScopedChatId('slack:C0123:U0456')).toBe(false);
    expect(isPrincipalScopedChatId('dashboard:171234')).toBe(false);
    expect(isPrincipalScopedChatId('12345678')).toBe(false);
  });
});
