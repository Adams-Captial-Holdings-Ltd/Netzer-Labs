import { describe, it, expect } from 'vitest';
import { resolveWebSearchPiiPolicy } from './web-search-policy.js';

describe('resolveWebSearchPiiPolicy', () => {
  it('defaults to redact when unset', () => {
    expect(resolveWebSearchPiiPolicy(undefined)).toBe('redact');
    expect(resolveWebSearchPiiPolicy('')).toBe('redact');
  });

  it('parses each explicit value', () => {
    expect(resolveWebSearchPiiPolicy('refuse')).toBe('refuse');
    expect(resolveWebSearchPiiPolicy('redact')).toBe('redact');
    expect(resolveWebSearchPiiPolicy('allow')).toBe('allow');
  });

  it('is case-insensitive and trims whitespace', () => {
    expect(resolveWebSearchPiiPolicy(' REFUSE ')).toBe('refuse');
    expect(resolveWebSearchPiiPolicy('Allow')).toBe('allow');
  });

  it('falls back to redact on unknown values', () => {
    expect(resolveWebSearchPiiPolicy('strict')).toBe('redact');
    expect(resolveWebSearchPiiPolicy('yes')).toBe('redact');
  });
});
