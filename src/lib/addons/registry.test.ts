import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { addonConfigured, listAddons, registerAddon } from './registry.js';

describe('addon registry', () => {
  const SAVED = process.env.CCE_TEST_ADDON_KEY;
  beforeEach(() => {
    delete process.env.CCE_TEST_ADDON_KEY;
  });
  afterEach(() => {
    if (SAVED === undefined) delete process.env.CCE_TEST_ADDON_KEY;
    else process.env.CCE_TEST_ADDON_KEY = SAVED;
  });

  it('reports unconfigured add-ons', () => {
    registerAddon({
      id: 'unit_test_addon',
      title: 'Unit test',
      category: 'tool',
      description: 'fixture',
      required: [{ envVar: 'CCE_TEST_ADDON_KEY' }],
      defaultOn: false,
    });
    expect(addonConfigured('unit_test_addon')).toBe(false);
  });

  it('reports configured once env var is set', () => {
    registerAddon({
      id: 'unit_test_addon_2',
      title: 'Unit test 2',
      category: 'tool',
      description: 'fixture',
      required: [{ envVar: 'CCE_TEST_ADDON_KEY' }],
      defaultOn: false,
    });
    process.env.CCE_TEST_ADDON_KEY = 'present';
    expect(addonConfigured('unit_test_addon_2')).toBe(true);
  });

  it('rejects REPLACE_ME placeholder', () => {
    registerAddon({
      id: 'unit_test_addon_3',
      title: 'Unit test 3',
      category: 'tool',
      description: 'fixture',
      required: [{ envVar: 'CCE_TEST_ADDON_KEY' }],
      defaultOn: false,
    });
    process.env.CCE_TEST_ADDON_KEY = 'REPLACE_ME';
    expect(addonConfigured('unit_test_addon_3')).toBe(false);
  });

  it('returns false for unknown ids', () => {
    expect(addonConfigured('does_not_exist')).toBe(false);
  });

  it('listAddons includes registered ids', () => {
    const ids = listAddons().map((a) => a.id);
    expect(ids).toContain('unit_test_addon');
  });
});
