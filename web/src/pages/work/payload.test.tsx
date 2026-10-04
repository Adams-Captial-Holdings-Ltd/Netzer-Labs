import { describe, expect, it } from 'vitest';
import { PayloadBlock } from './ApprovalDetail';

describe('approval payload rendering', () => {
  it('uses a definition list for a flat payload', () => {
    expect(PayloadBlock({ value: { action: 'Release payment', amount: '1,250.00 USD' } }).type).toBe('dl');
  });
  it('uses formatted JSON for nested content', () => {
    const rendered = PayloadBlock({ value: { invoice: { key: 'INV-1002' } } });
    expect(rendered.type).toBe('pre');
    expect(rendered.props.children).toContain('"INV-1002"');
  });
});
