import { describe, expect, it } from 'vitest';
import { fallbackMessage, workMessage } from './messages';

describe('workMessage', () => {
  it('uses the known sentence', () => {
    expect(workMessage(new Error('stale_payload'))).toBe(
      'This changed after you opened it. Review the new version before deciding.',
    );
  });
  it('uses the fallback for an unknown code and a prototype key', () => {
    expect(workMessage('unknown_code')).toBe(fallbackMessage);
    expect(workMessage('constructor')).toBe(fallbackMessage);
  });
});
