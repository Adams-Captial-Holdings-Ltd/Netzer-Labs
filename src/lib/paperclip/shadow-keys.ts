type SecretsManagerClient = import('@aws-sdk/client-secrets-manager').SecretsManagerClient;
import { loadEnv } from '../../config/env.js';
import { logger } from '../../observability/logger.js';

export class ShadowKeyUnavailableError extends Error {
  constructor(slot: string) {
    super(`Shadow key unavailable for slot ${slot}`);
    this.name = 'ShadowKeyUnavailableError';
  }
}

type Secret = { v: 1; slots: Record<string, { boardKey: string | null }> };

function parseSecret(value: unknown): Secret | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const root = value as Record<string, unknown>;
  if (Object.keys(root).length !== 2 || root.v !== 1 || typeof root.slots !== 'object'
    || root.slots === null || Array.isArray(root.slots)) return undefined;
  const source = root.slots as Record<string, unknown>;
  const slots: Secret['slots'] = Object.create(null) as Secret['slots'];
  for (const [id, valueAtSlot] of Object.entries(source)) {
    if (typeof valueAtSlot !== 'object' || valueAtSlot === null || Array.isArray(valueAtSlot)) return undefined;
    const entry = valueAtSlot as Record<string, unknown>;
    if (!Object.hasOwn(entry, 'boardKey') || !(typeof entry.boardKey === 'string' || entry.boardKey === null)) return undefined;
    slots[id] = { boardKey: entry.boardKey };
  }
  return { v: 1, slots };
}

export function createShadowKeyStore({ getSecretString, now, ttlMs = 60_000 }: {
  getSecretString: () => Promise<string>;
  now: () => number;
  ttlMs?: number;
}): { boardKeyFor(slot: string): Promise<string> } {
  let cached: { slots: Secret['slots']; expiresAt: number } | undefined;
  let inFlight: Promise<Secret['slots']> | undefined;

  function readSecret(slot: string): Promise<Secret['slots']> {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        const parsed = parseSecret(JSON.parse(await getSecretString()) as unknown);
        if (!parsed) throw new Error('invalid secret');
        cached = { slots: parsed.slots, expiresAt: now() + ttlMs };
        return parsed.slots;
      } catch {
        cached = undefined;
        throw new ShadowKeyUnavailableError(slot);
      } finally { inFlight = undefined; }
    })();
    return inFlight;
  }

  return {
    async boardKeyFor(slot: string): Promise<string> {
      if (!/^(0[1-9]|[1-9][0-9])$/.test(slot)) throw new ShadowKeyUnavailableError(slot);
      let slots: Secret['slots'];
      let fetched = false;
      if (!cached || now() >= cached.expiresAt) { slots = await readSecret(slot); fetched = true; }
      else { slots = cached.slots; }
      if (!fetched && (!Object.hasOwn(slots, slot) || slots[slot]?.boardKey === null)) slots = await readSecret(slot);
      const entry = Object.hasOwn(slots, slot) ? slots[slot] : undefined;
      const key = entry?.boardKey;
      if (typeof key !== 'string' || !key.trim() || key === 'REPLACE_ME') {
        throw new ShadowKeyUnavailableError(slot);
      }
      return key;
    },
  };
}

let secretsClient: SecretsManagerClient | undefined;
export function defaultShadowKeyStore(): ReturnType<typeof createShadowKeyStore> {
  return createShadowKeyStore({
    now: Date.now,
    getSecretString: async () => {
      const secretId = loadEnv().SHADOW_APPROVERS_SECRET_ID;
      if (!secretId) throw new ShadowKeyUnavailableError('unknown');
      const { GetSecretValueCommand, SecretsManagerClient } = await import('@aws-sdk/client-secrets-manager');
      secretsClient ??= new SecretsManagerClient({ ...(process.env.AWS_REGION ? { region: process.env.AWS_REGION } : {}) });
      let secretString: string;
      try {
        const result = await secretsClient.send(new GetSecretValueCommand({ SecretId: secretId }));
        if (!result.SecretString) throw new ShadowKeyUnavailableError('unknown');
        secretString = result.SecretString;
      } catch (error) {
        logger.warn({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'shadow key secret read failed');
        throw new ShadowKeyUnavailableError('unknown');
      }
      let valid = false;
      try { valid = !!parseSecret(JSON.parse(secretString) as unknown); }
      catch { /* Secret content is never logged. */ }
      if (!valid) {
        logger.warn({}, 'shadow key secret invalid');
        throw new ShadowKeyUnavailableError('unknown');
      }
      return secretString;
    },
  });
}
