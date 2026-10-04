import { describe, expect, it } from 'vitest';
import { KeepKey } from './shared';

describe('KeepKey', () => {
  it('wraps the case key in a no-wrap span and keeps the words around it', () => {
    const out = KeepKey({ text: 'Invoice INV-1001 from Sample Vendor A', caseKey: 'INV-1001' });
    const [before, key, after] = out.props.children;
    expect(before).toBe('Invoice ');
    expect(key.props.class).toBe('whitespace-nowrap');
    expect(key.props.children).toBe('INV-1001');
    expect(after).toBe(' from Sample Vendor A');
  });
  it('returns the text as it is when it does not hold the key', () => {
    expect(KeepKey({ text: 'Payment release', caseKey: 'INV-1001' }).props.children).toBe('Payment release');
  });
});
