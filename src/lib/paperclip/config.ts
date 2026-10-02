/**
 * Where the Paperclip client gets its base URL, its company and its keys — and
 * the one place that decides "not configured" is not the same thing as "broken".
 *
 * A2-9 IS THE WHOLE POINT OF THIS FILE. Linear throws SYNCHRONOUSLY from
 * `parseClientOptions` when neither credential is present, with the URL to
 * create one. Ours has a sharper hazard to answer: `getConfig` in
 * `src/lib/state/runtime-config-repo.ts` is FAIL-OPEN — on a DynamoDB error it
 * logs "runtime-config read failed — failing open" and returns the last cached
 * value, or `undefined` when nothing was ever cached (proven by its own unit
 * test, "getConfig fails open to undefined on DDB error"). A DDB outage and an
 * unconfigured install are therefore literally the same value at the call site.
 * So the split here is deliberate:
 *
 *   `loadPaperclipConfig()`  — async, reads env and runtime-config, resolves
 *                              nothing and validates nothing.
 *   `paperclipConfig(input)` — SYNCHRONOUS, total, and throws
 *                              `PaperclipDisabledError` naming the remediation
 *                              location. This is what the client constructor
 *                              calls, so construction fails fast and a missing
 *                              base URL can never become `fetch(undefined/api/…)`.
 *
 * SPELLINGS ARE LOAD-BEARING (C-19). `agent_keys` and `dispatch_secret` are the
 * shipped secret field names (`infra/lib/secrets-stack.ts` template, merged by
 * `scripts/paperclip-bootstrap.ts`); `agent_keys_json` / `dispatch_token` are
 * the plan's wrong variants and a field mismatch is a task that cannot START,
 * with a `ResourceInitializationError` rather than an application error. One
 * secret field injects as one env var, which is why `agent_keys` is a JSON
 * STRING arriving as `PAPERCLIP_AGENT_KEYS_JSON`.
 */
import { getConfig } from '../state/runtime-config-repo.js';
import { loadEnv } from '../../config/env.js';
import { PaperclipDisabledError, parseNumber } from './error.js';

/**
 * Named in every remediation message. The suffix form is what a non-default
 * app name produces (`infra/lib/constants.ts` builds
 * `RESOURCE_NAMES.secrets.paperclip` as `/<app>/paperclip`).
 */
export const PAPERCLIP_SECRET_PATH = '/claudeclaw[-suffix]/paperclip';

/**
 * The runtime-config key A2-9 requires the message to name. NOT seeded, and
 * deliberately so: an instance URL's default is absence, not a tunable, which
 * is exactly why `power/url` is read by `src/adapters/dashboard/power.ts` and
 * appears nowhere in `scripts/lib/seed-defaults.ts` either.
 */
export const PAPERCLIP_BASE_URL_CONFIG_KEY = 'base_url';
export const PAPERCLIP_CONFIG_CATEGORY = 'paperclip';

/**
 * A2-11, our first deliberate divergence from Linear, which has NO timeout
 * anywhere in its six hand-written files. The ALB `idleTimeout` is 4000 s, so a
 * hung Paperclip would otherwise pin a Fargate request slot for over an hour.
 * Reads are cheap to retry; writes may already have landed, so they get longer.
 */
export const PAPERCLIP_READ_TIMEOUT_MS = 10_000;
export const PAPERCLIP_WRITE_TIMEOUT_MS = 20_000;

/** The bootstrap's first agent. `main` holds role `ceo` in every provisioned company. */
export const PAPERCLIP_DEFAULT_ACTOR = 'main';

export interface PaperclipConfig {
  baseUrl: string;
  companyId: string;
  /** slug → agent API key, as stored in the secret's `agent_keys` field. */
  agentKeys: Readonly<Record<string, string>>;
  defaultActor: string;
  readTimeoutMs: number;
  writeTimeoutMs: number;
}

/**
 * Derived rather than re-declared, so the two cannot drift.
 *
 * DELIBERATELY ABSENT: `reconcilerKey` and `dispatchSecret`. Their env keys are
 * declared (Phase 4 injects all three secret fields in one CDK edit) but
 * nothing in this phase reads them, and a config object that carries a secret
 * no code uses is a secret in one more place for no benefit. Add them back in
 * the phase that has a reader.
 */
export type PaperclipConfigInput = Partial<PaperclipConfig>;

function disabled(what: string, remediation: string): PaperclipDisabledError {
  return new PaperclipDisabledError({
    body: { error: `Paperclip is not configured: ${what}`, remediation },
  });
}

function isAllowedPaperclipBaseUrl(value: string): boolean {
  if (/[?#\s]/.test(value)) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/'
  ) return false;

  const hostname = url.hostname;
  if (hostname === 'localhost' || hostname === '[::1]') return true;
  const octets = hostname.split('.').map(Number);
  if (
    octets.length === 4 &&
    octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
  ) {
    const [a, b] = octets;
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  return /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.internal$/.test(hostname);
}

/**
 * Absence and malformation collapse to the same typed error, the way
 * `src/lib/salesforce/client.ts` normalizes both an unset token blob and an
 * unparseable one to `SalesforceNotConnectedError`.
 */
export function parseAgentKeys(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
  return Object.fromEntries(
    Object.entries(parsed as Record<string, unknown>).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].length > 0,
    ),
  );
}

/**
 * A2-9. Synchronous, total, and the only place that turns "unset" into a typed
 * error. Every message names WHERE to fix it.
 */
export function paperclipConfig(input: PaperclipConfigInput): PaperclipConfig {
  const baseUrl = input.baseUrl?.trim().replace(/\/+$/, '');
  if (!baseUrl) {
    throw disabled(
      'no base URL',
      `set runtime-config ${PAPERCLIP_CONFIG_CATEGORY}/${PAPERCLIP_BASE_URL_CONFIG_KEY}, or the PAPERCLIP_BASE_URL environment variable`,
    );
  }
  const companyId = input.companyId?.trim();
  if (!companyId) {
    throw disabled('no company id', 'set the PAPERCLIP_COMPANY_ID environment variable');
  }
  const agentKeys = input.agentKeys ?? {};
  const defaultActor = input.defaultActor?.trim() || PAPERCLIP_DEFAULT_ACTOR;
  if (Object.keys(agentKeys).length === 0) {
    throw disabled(
      'no agent keys',
      `populate the ${PAPERCLIP_SECRET_PATH} secret's agent_keys field by running scripts/paperclip-bootstrap.ts; it reaches this task as PAPERCLIP_AGENT_KEYS_JSON`,
    );
  }
  if (!agentKeys[defaultActor]) {
    throw disabled(
      `no agent key for the default actor ${JSON.stringify(defaultActor)}`,
      `set PAPERCLIP_DEFAULT_AGENT to one of: ${Object.keys(agentKeys).sort().join(', ')}`,
    );
  }
  return {
    baseUrl,
    companyId,
    agentKeys,
    defaultActor,
    readTimeoutMs: input.readTimeoutMs ?? PAPERCLIP_READ_TIMEOUT_MS,
    writeTimeoutMs: input.writeTimeoutMs ?? PAPERCLIP_WRITE_TIMEOUT_MS,
  };
}

export interface LoadPaperclipConfigDeps {
  env?: Partial<Record<string, string | undefined>>;
  getConfigFn?: typeof getConfig;
}

/** Reads only. Validation is `paperclipConfig`'s job, and it is synchronous. */
export async function loadPaperclipConfig(
  deps: LoadPaperclipConfigDeps = {},
): Promise<PaperclipConfigInput> {
  const env = deps.env ?? loadEnv();
  const read = deps.getConfigFn ?? getConfig;
  // Runtime-config wins over env (C-19: promotion is a config write, not a
  // deploy), and `getConfig`'s fail-open `undefined` simply lets env answer.
  const configured = await read(PAPERCLIP_CONFIG_CATEGORY, PAPERCLIP_BASE_URL_CONFIG_KEY);
  if (configured && !isAllowedPaperclipBaseUrl(configured)) {
    throw disabled(
      'runtime-config paperclip/base_url override is not allowed',
      'allowed values are http or https origin only, with host localhost, a loopback address, an RFC 1918 address, or a .internal name',
    );
  }
  return {
    baseUrl: configured ?? env.PAPERCLIP_BASE_URL,
    companyId: env.PAPERCLIP_COMPANY_ID,
    agentKeys: parseAgentKeys(env.PAPERCLIP_AGENT_KEYS_JSON),
    defaultActor: env.PAPERCLIP_DEFAULT_AGENT,
    readTimeoutMs: positiveInt(env.PAPERCLIP_READ_TIMEOUT_MS),
    writeTimeoutMs: positiveInt(env.PAPERCLIP_WRITE_TIMEOUT_MS),
  };
}

/**
 * The two timeout keys are declared as plain optional strings in
 * `src/config/env.ts`, not `z.coerce.number()`, on purpose: `node --env-file`
 * turns a bare `KEY=` into `''`, `Number('') === 0`, and a `.min()` on a coerced
 * number then makes `loadEnv()` THROW at startup. Parsing here keeps a stray
 * blank line in a `.env` from bricking the process. `parseNumber` is `error.ts`'s
 * — one number parser for the whole integration, so `NaN` has one place to leak
 * from rather than two.
 */
function positiveInt(raw: string | undefined): number | undefined {
  const parsed = parseNumber(raw);
  return parsed !== undefined && parsed > 0 ? Math.trunc(parsed) : undefined;
}
