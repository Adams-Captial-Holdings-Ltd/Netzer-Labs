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
  it('is a keyboard-reachable region with a name', () => {
    const region = PayloadBlock({ value: { action: 'Release payment' } });
    expect(region.props.role).toBe('region');
    expect(region.props.tabIndex).toBe(0);
    expect(region.props['aria-label']).toBeTruthy();
  });
});
