import { describe, it, expect } from 'vitest';
import { parseWhen, parseInterval } from './schedule-tools.js';

describe('parseWhen', () => {
  const now = new Date('2026-05-19T12:00:00Z');

  it('parses +30m as 1800s from now', () => {
    expect(parseWhen('+30m', now)).toBe(Math.floor(now.getTime() / 1000) + 1800);
  });

  it('parses +2h as 7200s', () => {
    expect(parseWhen('+2h', now)).toBe(Math.floor(now.getTime() / 1000) + 7200);
  });

  it('parses +1d as 86400s', () => {
    expect(parseWhen('+1d', now)).toBe(Math.floor(now.getTime() / 1000) + 86400);
  });

  it('parses ISO timestamps', () => {
    const iso = '2026-05-20T15:00:00Z';
    expect(parseWhen(iso, now)).toBe(Date.parse(iso) / 1000);
  });

  it('rejects garbage', () => {
    expect(() => parseWhen('soon', now)).toThrowError(/Couldn't parse/);
  });
});

describe('parseInterval', () => {
  it('returns undefined for nullish', () => {
    expect(parseInterval(undefined)).toBeUndefined();
    expect(parseInterval('')).toBeUndefined();
  });

  it('maps human aliases', () => {
    expect(parseInterval('hourly')).toBe(3600);
    expect(parseInterval('daily')).toBe(86400);
    expect(parseInterval('weekly')).toBe(7 * 86400);
  });

  it('parses every N unit', () => {
    expect(parseInterval('every 30m')).toBe(1800);
    expect(parseInterval('every 2h')).toBe(7200);
  });

  it('accepts raw seconds', () => {
    expect(parseInterval(900)).toBe(900);
  });

  it('rejects sub-minute intervals', () => {
    expect(() => parseInterval(30)).toThrowError(/>= 60/);
    expect(() => parseInterval('every 30s')).toThrowError(/>= 60/);
  });

  it('rejects garbage', () => {
    expect(() => parseInterval('whenever')).toThrowError(/Couldn't parse/);
  });
});
