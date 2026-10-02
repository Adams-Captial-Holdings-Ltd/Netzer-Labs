import {
  LOCK_AUDITOR_KEY_FIELD,
  RECONCILER_KEY_NAME,
  type KeyOutcome,
} from './bootstrap-core.js';

export type BootstrapSecretFields = Record<string, string>;

interface LoadBootstrapSecretFieldsOptions {
  secretId: string;
  read: () => Promise<string | undefined>;
}

function recordOfStrings(value: unknown): value is BootstrapSecretFields {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((field) => typeof field === 'string')
  );
}

/**
 * Read the retained Paperclip secret without turning an unreadable live state
 * into an empty credential set: the run stops here, before reconcileKey can
 * revoke one-time keys.
 */
export async function loadBootstrapSecretFields(
  options: LoadBootstrapSecretFieldsOptions,
): Promise<BootstrapSecretFields> {
  try {
    const raw = await options.read();
    if (raw === undefined) throw new TypeError('SecretString is absent');
    const parsed: unknown = JSON.parse(raw);
    if (!recordOfStrings(parsed)) {
      throw new TypeError('SecretString must be a JSON object whose values are strings');
    }
    return parsed;
  } catch (error) {
    throw new Error(
      `could not read or parse ${options.secretId}; refusing to reconcile live one-time agent keys`,
      { cause: error },
    );
  }
}

interface ParseBootstrapAgentKeysOptions {
  value: string | undefined;
  secretId: string;
}

/**
 * Decode the nested agent-key map without treating corrupt live credentials as
 * an empty first install. The shipped placeholder is the only non-JSON value
 * that legitimately means "no keys yet".
 */
export function parseBootstrapAgentKeys(
  options: ParseBootstrapAgentKeysOptions,
): Record<string, string> {
  if (options.value === undefined || options.value === '' || options.value === 'REPLACE_ME') {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(options.value);
    if (!recordOfStrings(parsed)) {
      throw new TypeError('agent_keys must be a JSON object whose values are strings');
    }
    return parsed;
  } catch (error) {
    throw new Error(
      `could not parse agent_keys in ${options.secretId}; refusing to reconcile live one-time agent keys`,
      { cause: error },
    );
  }
}

interface MergeBootstrapSecretFieldsOptions {
  current: BootstrapSecretFields;
  companyId: string;
  storedAgentKeys: Record<string, string>;
  outcomes: KeyOutcome[];
  lockAuditorKey?: string;
}

/** Merge only the bootstrap-owned fields while preserving every other field. */
export function mergeBootstrapSecretFields(
  options: MergeBootstrapSecretFieldsOptions,
): BootstrapSecretFields {
  const next = { ...options.current };
  for (const outcome of options.outcomes) {
    if (!outcome.token) continue;
    if (outcome.keyName === RECONCILER_KEY_NAME) next.reconciler_key = outcome.token;
    else options.storedAgentKeys[outcome.slug] = outcome.token;
  }
  next.agent_keys = JSON.stringify(options.storedAgentKeys);
  next.company_id = options.companyId;
  if (options.lockAuditorKey !== undefined) next[LOCK_AUDITOR_KEY_FIELD] = options.lockAuditorKey;
  return next;
}
