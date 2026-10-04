import { describe, expect, it, vi } from 'vitest';

const values = new Map<string, string>();
vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
vi.stubGlobal('window', { matchMedia: () => ({ matches: false, addEventListener: () => {} }) });
const properties = new Map<string, string>();
vi.stubGlobal('document', { documentElement: { classList: { toggle: () => {} }, style: { setProperty: (k: string, v: string) => properties.set(k, v), removeProperty: (k: string) => properties.delete(k) } } });

function luminance(hex: string) {
  const parts = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(x => x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);
  return 0.2126 * parts[0] + 0.7152 * parts[1] + 0.0722 * parts[2];
}
function ratio(a: string, b: string) { const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (light + 0.05) / (dark + 0.05); }

describe('customer primary contrast', () => {
  it('uses white for invalid hex input', async () => {
    const { primaryTextFor } = await import('./theme');
    expect(primaryTextFor('not-a-colour')).toBe('#ffffff');
  });
  it('chooses readable text for dark, light, and middle customer colours', async () => {
    const { primaryTextFor, brand, applyBrand } = await import('./theme');
    expect(properties.get('--color-text-inverse')).toBe(primaryTextFor('#6366f1'));
    for (const fill of ['#000000', '#ffffff', '#777777', '#6366f1', '#ffff00', '#00ffff', '#123abc']) {
      const text = primaryTextFor(fill);
      expect(ratio(fill, text)).toBeGreaterThanOrEqual(4.5);
      brand.value = { ...brand.value, primaryColor: fill };
      applyBrand();
      expect(properties.get('--color-text-inverse')).toBe(text);
      expect(ratio(properties.get('--color-primary-hover')!, text)).toBeGreaterThanOrEqual(4.5);
    }
  });
});
