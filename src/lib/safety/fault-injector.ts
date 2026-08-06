/**
 * App-level fault injector. Reads chaos kill switches and throws
 * synthetic exceptions to exercise the fallback chain and error
 * handling paths without needing AWS FIS.
 *
 * Each chaos switch stores a percentage in its `reason` field
 * (e.g., "50" = 50% injection rate). If the roll lands below the
 * percentage, a synthetic ThrottlingException is thrown.
 */

import { isKillSwitchActive, type KillSwitchName } from '../state/kill-switches-repo.js';
import { logger } from '../../observability/logger.js';

const CHAOS_SWITCHES: Record<string, KillSwitchName> = {
  opus: 'chaos_bedrock_throttle_opus',
  sonnet: 'chaos_bedrock_throttle_sonnet',
  haiku: 'chaos_bedrock_throttle_haiku',
};

export class SyntheticThrottleError extends Error {
  public override readonly name = 'ThrottlingException';
  constructor(target: string) {
    super(`[chaos] synthetic throttle on ${target}`);
  }
}

function familyFromModelId(modelId: string): string {
  if (/opus/i.test(modelId)) return 'opus';
  if (/sonnet/i.test(modelId)) return 'sonnet';
  return 'haiku';
}

export async function maybeThrowSyntheticBedrock(modelId: string): Promise<void> {
  const family = familyFromModelId(modelId);
  const switchName = CHAOS_SWITCHES[family];
  if (!switchName) return;

  const state = await isKillSwitchActive(switchName).catch(() => ({ active: false, reason: undefined as string | undefined }));
  if (!state.active) return;

  const pct = Number(state.reason ?? '100');
  if (!Number.isFinite(pct) || pct <= 0) return;

  if (Math.random() * 100 < pct) {
    logger.warn({ modelId, family, pct }, 'chaos: injecting synthetic throttle');
    throw new SyntheticThrottleError(modelId);
  }
}

export async function maybeThrowSyntheticSecrets(): Promise<void> {
  const state = await isKillSwitchActive('chaos_secrets_throttle').catch(() => ({ active: false, reason: undefined as string | undefined }));
  if (!state.active) return;

  const pct = Number(state.reason ?? '100');
  if (!Number.isFinite(pct) || pct <= 0) return;

  if (Math.random() * 100 < pct) {
    logger.warn({ pct }, 'chaos: injecting synthetic secrets throttle');
    throw new SyntheticThrottleError('SecretsManager');
  }
}
