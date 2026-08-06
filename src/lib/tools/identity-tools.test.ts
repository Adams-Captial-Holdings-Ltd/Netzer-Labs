import { describe, it, expect } from 'vitest';
import { parseSurfaceRef } from './identity-tools.js';

describe('parseSurfaceRef', () => {
  it('extracts slack user id from per-user shape', () => {
    expect(parseSurfaceRef('slack:C123:U05NFC6BUSC')).toEqual({
      surface: 'slack',
      surfaceUserId: 'U05NFC6BUSC',
    });
  });

  it('extracts slack user id when threaded', () => {
    expect(parseSurfaceRef('slack:C123:U05NFC6BUSC:1700000000.123')).toEqual({
      surface: 'slack',
      surfaceUserId: 'U05NFC6BUSC',
    });
  });

  it('falls back to channel id when slack chatId omits user', () => {
    expect(parseSurfaceRef('slack:C123')).toEqual({
      surface: 'slack',
      surfaceUserId: 'C123',
    });
  });

  it('skips DM thread timestamp and uses channel', () => {
    expect(parseSurfaceRef('slack:C123:1700000000.123')).toEqual({
      surface: 'slack',
      surfaceUserId: 'C123',
    });
  });

  it('parses telegram chat ids', () => {
    expect(parseSurfaceRef('tg:9876543210')).toEqual({
      surface: 'telegram',
      surfaceUserId: '9876543210',
    });
  });

  it('parses whatsapp phone numbers', () => {
    expect(parseSurfaceRef('wa:+15551234567')).toEqual({
      surface: 'whatsapp',
      surfaceUserId: '+15551234567',
    });
  });

  it('returns undefined for dashboard / system / canonical chatIds', () => {
    expect(parseSurfaceRef('dashboard:abc')).toBeUndefined();
    expect(parseSurfaceRef('system:canary')).toBeUndefined();
    expect(parseSurfaceRef('owner:emmanuel')).toBeUndefined();
    expect(parseSurfaceRef('user:11111111-1111-1111-1111-111111111111')).toBeUndefined();
  });
});
