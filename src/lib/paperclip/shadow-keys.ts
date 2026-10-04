export class ShadowKeyUnavailableError extends Error {
  constructor(slot: string) {
    super(`Shadow key unavailable for slot ${slot}`);
    this.name = 'ShadowKeyUnavailableError';
  }
}

type Secret = { v: 1; slots: Record<string, { email: string; password: string; boardKey: string | null }> };

function parseSecret(value: unknown): Secret | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const root = value as Record<string, unknown>;
  if (Object.keys(root).length !== 2 || root.v !== 1 || typeof root.slots !== 'object' || root.slots === null || Array.isArray(root.slots)) return undefined;
  const source = root.slots as Record<string, unknown>;
  const slots: Secret['slots'] = Object.create(null) as Secret['slots'];
  for (const [id, valueAtSlot] of Object.entries(source)) {
    if (typeof valueAtSlot !== 'object' || valueAtSlot === null || Array.isArray(valueAtSlot)) return undefined;
    const entry = valueAtSlot as Record<string, unknown>;
    if (Object.keys(entry).length !== 3 || typeof entry.email !== 'string' || typeof entry.password !== 'string' ||
        !(typeof entry.boardKey === 'string' || entry.boardKey === null)) return undefined;
    slots[id] = { email: entry.email, password: entry.password, boardKey: entry.boardKey };
  }
  return { v: 1, slots };
}

export function createShadowKeyStore({ getSecretString, now, ttlMs = 60_000 }: {
  getSecretString: () => Promise<string>;
  now: () => number;
  ttlMs?: number;
}): { boardKeyFor(slot: string): Promise<string> } {
  let cached: { slots: Secret['slots']; expiresAt: number } | undefined;

  async function readSecret(slot: string): Promise<Secret['slots']> {
    try {
      const parsed = parseSecret(JSON.parse(await getSecretString()) as unknown);
      if (!parsed) throw new Error('invalid secret');
      cached = { slots: parsed.slots, expiresAt: now() + ttlMs };
      return parsed.slots;
    } catch {
      cached = undefined;
      throw new ShadowKeyUnavailableError(slot);
    }
  }

  return {
    async boardKeyFor(slot: string): Promise<string> {
      if (!/^(0[1-9]|[1-9][0-9])$/.test(slot)) throw new ShadowKeyUnavailableError(slot);
      let slots = cached && now() < cached.expiresAt ? cached.slots : await readSecret(slot);
      if (!Object.hasOwn(slots, slot)) slots = await readSecret(slot);
      const entry = Object.hasOwn(slots, slot) ? slots[slot] : undefined;
      const key = entry?.boardKey;
      if (typeof key !== 'string' || !key.trim() || key === 'REPLACE_ME') {
        throw new ShadowKeyUnavailableError(slot);
      }
      return key;
    },
  };
}
