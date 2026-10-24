import type { Capability } from '../auth/permissions.js';

/**
 * NZR-43: which runtime-config categories the generic /api/config* routes
 * serve, and the capability a read needs. A category not listed is refused
 * (default deny). Writes keep the legacy admin gate in requiredRole. A Map,
 * not an object literal, so `constructor` / `__proto__` never resolve.
 */
export const CONFIG_POLICY: ReadonlyMap<string, { read: Capability }> = new Map(
  ([
    ['profile', 'dashboard:read'],
    ['branding', 'dashboard:read'],
    ['themes', 'dashboard:read'],
    ['cost', 'dashboard:read'],
    ['sessions', 'dashboard:read'],
    ['rate_limits', 'dashboard:read'],
    ['memory', 'dashboard:read'],
    ['media', 'dashboard:read'],
    ['images', 'dashboard:read'],
    ['agent', 'dashboard:read'],
    ['bedrock', 'dashboard:read'],
    ['delegation', 'dashboard:read'],
    ['drift', 'dashboard:read'],
    ['iam', 'dashboard:read'],
    ['paperclip', 'integrations:read'],
    // Function URL, alert recipients (personal data), Jarvis routines.
    ['power', 'security:read'],
    ['alerting', 'security:read'],
    ['jarvis', 'security:read'],
  ] as const).map(([category, read]) => [category, { read }]),
);

/** Categories holding secrets: refused on every generic route, for everyone.
 * Their dedicated routes (/api/oauth/*, /api/integrations/mcp) own them. */
export const SECRET_CONFIG_CATEGORIES: ReadonlySet<string> = new Set(['oauth', 'oauth_state', 'mcp']);

/** True when a key (or JSON field) name looks like it holds a secret. The
 * token rule is suffix-only so `max_output_tokens` stays readable. */
export function isSecretConfigKey(key: string): boolean {
  return (
    /(secret|password|passwd|bearer|credential|api[_-]?key|private[_-]?key)/i.test(key) ||
    /(^|[_-])token$/i.test(key) ||
    /[a-z]Token$/.test(key)
  );
}

/** `****` plus the last 4 characters; `****` alone below 12 characters. */
export function maskSecret(value: string): string {
  return value.length < 12 ? '****' : `****${value.slice(-4)}`;
}

function maskTree(node: unknown): { out: unknown; changed: boolean } {
  if (Array.isArray(node)) {
    let changed = false;
    const out = node.map((v) => {
      const r = maskTree(v);
      changed ||= r.changed;
      return r.out;
    });
    return { out, changed };
  }
  if (node && typeof node === 'object') {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      if (isSecretConfigKey(k) && v != null) {
        out[k] = typeof v === 'string' ? maskSecret(v) : '****';
        changed = true;
      } else {
        const r = maskTree(v);
        out[k] = r.out;
        changed ||= r.changed;
      }
    }
    return { out, changed };
  }
  return { out: node, changed: false };
}

/**
 * Mask a runtime-config value on its way out (responses, audit rows, logs).
 * A secret-shaped key masks the whole value; a JSON value has secret-shaped
 * fields masked at any depth. JSON is re-serialized only when a field was
 * masked, so untouched values (themes/library) come back byte-identical.
 */
export function maskConfigValue<T extends string | null | undefined>(key: string, value: T): T | string {
  if (typeof value !== 'string') return value;
  if (isSecretConfigKey(key)) return maskSecret(value);
  const head = value.trimStart()[0];
  if (head !== '{' && head !== '[') return value;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return value;
  }
  const { out, changed } = maskTree(parsed);
  return changed ? JSON.stringify(out) : value;
}

/** maskConfigValue over a whole category. */
export function maskConfigValues(values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(values).map(([k, v]) => [k, maskConfigValue(k, v)]));
}
