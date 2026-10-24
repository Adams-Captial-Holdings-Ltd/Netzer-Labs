import { describe, expect, it } from 'vitest';
import { PayloadBlock } from './ApprovalDetail';

describe('approval payload rendering', () => {
  it('uses a definition list for a flat payload', () => {
    const region = PayloadBlock({ value: { action: 'Release payment', amount: '1,250.00 USD' } });
    expect(region.props.children.type).toBe('dl');
  });
  it('uses formatted JSON for nested content', () => {
    const region = PayloadBlock({ value: { invoice: { key: 'INV-1002' } } });
    expect(region.props.children.type).toBe('pre');
    expect(region.props.children.props.children).toContain('"INV-1002"');
  });
  it('is a plain block: no inner scroll box and no tab stop of its own', () => {
    const block = PayloadBlock({ value: { action: 'Release payment' } });
    expect(block.props.role).toBeUndefined();
    expect(block.props.tabIndex).toBeUndefined();
    expect(block.props.class).not.toMatch(/overflow|max-h/);
  });
});
