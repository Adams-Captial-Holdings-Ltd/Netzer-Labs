import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const getConfigMock = vi.fn<(cat: string, key: string) => Promise<string | undefined>>();
const killSwitchMock = vi.fn<(name: string) => Promise<{ active: boolean }>>();

vi.mock('./runtime-config-repo.js', () => ({
  getConfig: (cat: string, key: string) => getConfigMock(cat, key),
  setConfig: vi.fn(async () => {}),
}));
vi.mock('./kill-switches-repo.js', () => ({
  isKillSwitchActive: (name: string) => killSwitchMock(name),
}));

import {
  isCostCapEnabled,
  isCostCapEnforced,
  getEffectiveCostCap,
  resolveEffectiveCostCap,
} from './cost-cap-repo.js';

describe('cost cap enforcement gating', () => {
  beforeEach(() => {
    getConfigMock.mockReset();
    killSwitchMock.mockReset();
    getConfigMock.mockResolvedValue(undefined);
    killSwitchMock.mockResolvedValue({ active: false });
  });

  it('isCostCapEnabled is true only when the flag is exactly "true"', async () => {
    getConfigMock.mockResolvedValue('true');
    expect(await isCostCapEnabled()).toBe(true);
    getConfigMock.mockResolvedValue('false');
    expect(await isCostCapEnabled()).toBe(false);
    getConfigMock.mockResolvedValue(undefined);
    expect(await isCostCapEnabled()).toBe(false);
  });

  it('isCostCapEnforced is false when neither the switch nor the flag is on', async () => {
    expect(await isCostCapEnforced()).toBe(false);
  });

  it('isCostCapEnforced is true when only the cap_enabled flag is on', async () => {
    getConfigMock.mockResolvedValue('true'); // flag on, kill switch off
    expect(await isCostCapEnforced()).toBe(true);
  });

  it('isCostCapEnforced is true when only the kill switch is on', async () => {
    killSwitchMock.mockResolvedValue({ active: true }); // switch on, flag off
    expect(await isCostCapEnforced()).toBe(true);
  });

  it('fails open (not enforced) when the kill-switch read throws', async () => {
    killSwitchMock.mockRejectedValue(new Error('ddb blip'));
    expect(await isCostCapEnforced()).toBe(false);
  });
});

describe('effective cost cap resolution', () => {
  // envDefaultCap() reads CCE_DAILY_COST_CAP_USD (else the hard-coded 50). Pin
  // it deterministically so the fallback value is predictable, and restore.
  const savedEnv = process.env.CCE_DAILY_COST_CAP_USD;
  beforeEach(() => {
    getConfigMock.mockReset();
    delete process.env.CCE_DAILY_COST_CAP_USD; // hard-coded default 50 applies
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.CCE_DAILY_COST_CAP_USD;
    else process.env.CCE_DAILY_COST_CAP_USD = savedEnv;
  });

  it('honors a positive runtime override and reports source=runtime-config', async () => {
    getConfigMock.mockResolvedValue('250');
    expect(await resolveEffectiveCostCap()).toEqual({ capUsd: 250, source: 'runtime-config' });
    expect(await getEffectiveCostCap()).toBe(250);
  });

  it('ignores a stored 0 and falls back to the env default, reporting source=env-default', async () => {
    getConfigMock.mockResolvedValue('0');
    // The bug: a user who set the cap to 0 got the default enforced AND the GET
    // reported it as a runtime override. Both must be corrected here.
    expect(await resolveEffectiveCostCap()).toEqual({ capUsd: 50, source: 'env-default' });
    expect(await getEffectiveCostCap()).toBe(50);
  });

  it('ignores a negative override and falls back to the env default', async () => {
    getConfigMock.mockResolvedValue('-10');
    expect(await resolveEffectiveCostCap()).toEqual({ capUsd: 50, source: 'env-default' });
  });

  it('ignores an empty / whitespace override and falls back to the env default', async () => {
    getConfigMock.mockResolvedValue('   ');
    expect(await resolveEffectiveCostCap()).toEqual({ capUsd: 50, source: 'env-default' });
  });

  it('ignores a non-numeric override and falls back to the env default', async () => {
    getConfigMock.mockResolvedValue('lots');
    expect(await resolveEffectiveCostCap()).toEqual({ capUsd: 50, source: 'env-default' });
  });

  it('uses CCE_DAILY_COST_CAP_USD as the env default when no override is set', async () => {
    process.env.CCE_DAILY_COST_CAP_USD = '123';
    getConfigMock.mockResolvedValue(undefined);
    expect(await resolveEffectiveCostCap()).toEqual({ capUsd: 123, source: 'env-default' });
  });
});
