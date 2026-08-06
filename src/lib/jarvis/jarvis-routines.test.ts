import { describe, it, expect } from 'vitest';
import {
  validateRoutine,
  ROUTINE_NAME_MAX,
  ROUTINE_PROMPT_MAX,
  ROUTINE_ID_RE,
} from './jarvis-routines.js';

const valid = { name: 'Morning brief', prompt: 'Tour the overview and summarize.', showOnHover: true };

describe('validateRoutine', () => {
  it('accepts a well-formed routine', () => {
    expect(validateRoutine('morning-brief', valid)).toBeNull();
  });

  it('accepts omitted showOnHover (defaults true at save)', () => {
    expect(validateRoutine('a1', { name: 'x', prompt: 'y' })).toBeNull();
  });

  it.each([
    ['Uppercase-Id'],
    ['-leading-dash'],
    ['has space'],
    ['has_underscore'],
    [''],
    ['a'.repeat(41)],
  ])('rejects bad id %j', (id) => {
    expect(validateRoutine(id, valid)).toBe('invalid_id');
  });

  it('id regex allows max-length slug', () => {
    expect(ROUTINE_ID_RE.test('a' + '-b'.repeat(19) + 'c')).toBe(true);
  });

  it('rejects a missing or blank name', () => {
    expect(validateRoutine('ok', { ...valid, name: undefined })).toBe('missing_name');
    expect(validateRoutine('ok', { ...valid, name: '   ' })).toBe('missing_name');
  });

  it('rejects an over-long name', () => {
    expect(validateRoutine('ok', { ...valid, name: 'n'.repeat(ROUTINE_NAME_MAX + 1) })).toBe('name_too_long');
  });

  it('rejects a missing or blank prompt', () => {
    expect(validateRoutine('ok', { ...valid, prompt: undefined })).toBe('missing_prompt');
    expect(validateRoutine('ok', { ...valid, prompt: ' ' })).toBe('missing_prompt');
  });

  it('rejects an over-long prompt (WAF body-cap guard)', () => {
    expect(validateRoutine('ok', { ...valid, prompt: 'p'.repeat(ROUTINE_PROMPT_MAX + 1) })).toBe('prompt_too_long');
  });

  it('rejects a non-boolean showOnHover', () => {
    expect(validateRoutine('ok', { ...valid, showOnHover: 'yes' })).toBe('invalid_show_on_hover');
  });
});
