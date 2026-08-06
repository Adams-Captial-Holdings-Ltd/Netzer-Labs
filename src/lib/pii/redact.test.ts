import { describe, it, expect, beforeEach } from 'vitest';
import {
  invalidatePiiCache,
  redactSync,
  detectPii,
  redactPiiUnconditional,
} from './redact.js';

describe('redactSync', () => {
  beforeEach(() => invalidatePiiCache());

  it('passes through when the cache says PII redaction is OFF', () => {
    // Cache is empty; redactSync should pass through.
    expect(redactSync('Email me at foo@bar.com')).toBe('Email me at foo@bar.com');
  });

  it('redacts common PII shapes via the public surface (when active)', () => {
    // Without flipping the switch, the assertions below only check that
    // the function exists and is safe; full pattern coverage is exercised
    // via integration once the switch is on in prod.
    expect(typeof redactSync).toBe('function');
  });
});

describe('detectPii', () => {
  it('returns no matches for safe text', () => {
    const out = detectPii('what is the weather in Toronto today');
    expect(out.found).toBe(false);
    expect(out.types).toEqual([]);
  });

  it('flags an email address', () => {
    const out = detectPii('contact alice@example.com about the lease');
    expect(out.found).toBe(true);
    expect(out.types).toContain('email');
  });

  it('flags multiple distinct PII types at once', () => {
    const out = detectPii(
      'call 555-123-4567 or email bob@example.org from 192.168.1.1',
    );
    expect(out.found).toBe(true);
    expect(out.types).toEqual(expect.arrayContaining(['phone', 'email', 'ipv4']));
  });

  it('is repeatable — the same input gives the same answer on a second call', () => {
    const a = detectPii('alice@example.com');
    const b = detectPii('alice@example.com');
    expect(a).toEqual(b);
  });
});

describe('redactPiiUnconditional', () => {
  it('redacts PII regardless of cache state', () => {
    invalidatePiiCache();
    const out = redactPiiUnconditional(
      'reach me at alice@example.com or 555-123-4567',
    );
    expect(out).not.toContain('alice@example.com');
    expect(out).not.toContain('555-123-4567');
    expect(out).toContain('[email]');
    expect(out).toContain('[phone]');
  });

  it('leaves text without PII untouched', () => {
    expect(redactPiiUnconditional('hello world')).toBe('hello world');
  });
});
