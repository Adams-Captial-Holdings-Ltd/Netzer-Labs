/**
 * Staging-only live characterization for the Paperclip surfaces whose OpenAPI
 * success bodies are intentionally opaque. Values never leave this process:
 * logs contain only status codes, normalized media types, and structural
 * shapes. Every failure is collapsed to a controlled code before it is logged.
 */
import { randomUUID } from 'node:crypto';

type JsonShape = string | JsonShape[] | { [key: string]: JsonShape };

export const PAPERCLIP_PHASE_PROBE_SUCCESS_MARKERS = [
  'org',
  'whoami',
  'goals-list',
  'org-svg',
  'goal-create',
  'goal-get',
  'goal-update',
  'goal-delete',
] as const;

export const PAPERCLIP_PHASE_PROBE_FAILURE_MARKER = 'PAPERCLIP_PHASE_PROBE_FAILED';

type SuccessMarker = (typeof PAPERCLIP_PHASE_PROBE_SUCCESS_MARKERS)[number];
type ProbeFailureCode =
  | 'missing-base-url'
  | 'missing-company-id'
  | 'missing-agent-keys-json'
  | 'invalid-agent-keys-json'
  | 'agent-keys-json-not-an-object'
  | 'no-usable-agent-key'
  | 'request-failed-before-response'
  | 'response-metadata-unreadable'
  | 'response-body-unreadable'
  | 'response-body-invalid-json'
  | 'request-rejected'
  | 'org-svg-invalid'
  | 'goal-create-missing-id';

export class PaperclipPhaseProbeError extends Error {
  readonly code: ProbeFailureCode;
  readonly status?: number;

  constructor(code: ProbeFailureCode, status?: number) {
    super(status === undefined ? code : `${code} (HTTP ${status})`);
    this.name = 'PaperclipPhaseProbeError';
    this.code = code;
    this.status = status;
  }
}

type ProbeFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface PaperclipPhaseProbeDeps {
  env?: Record<string, string | undefined>;
  fetchFn?: ProbeFetch;
  log?: (line: string) => void;
  uuid?: () => string;
}

interface ProbeResponse {
  status: number;
  contentType: string | null;
  body: unknown;
}

function fail(code: ProbeFailureCode, status?: number): never {
  throw new PaperclipPhaseProbeError(code, status);
}

function safeShapeKey(key: string): string {
  return /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(key) ? '<uuid-key>' : key;
}

export function redactShape(value: unknown, depth = 0): JsonShape {
  if (depth >= 8) return 'depth-limit';
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    return value.length === 0 ? [] : [redactShape(value[0], depth + 1)];
  }
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [safeShapeKey(key), redactShape(child, depth + 1)]),
    );
  }
  return typeof value;
}

function required(
  env: Record<string, string | undefined>,
  name: string,
  code: ProbeFailureCode,
): string {
  const value = env[name]?.trim();
  if (!value) fail(code);
  return value;
}

function agentKey(env: Record<string, string | undefined>): string {
  const raw = required(env, 'PAPERCLIP_AGENT_KEYS_JSON', 'missing-agent-keys-json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail('invalid-agent-keys-json');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail('agent-keys-json-not-an-object');
  }
  const keys = parsed as Record<string, unknown>;
  const preferred = keys.main;
  if (typeof preferred === 'string' && preferred.length > 0) return preferred;
  const first = Object.values(keys).find(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
  if (!first) fail('no-usable-agent-key');
  return first;
}

function mediaType(response: Response): string | null {
  let raw: string | null;
  try {
    raw = response.headers.get('content-type');
  } catch {
    fail('response-metadata-unreadable');
  }
  if (raw === null) return null;
  const type = raw.split(';', 1)[0]!.trim().toLowerCase();
  if (type === 'application/json' || type.endsWith('+json')) return 'application/json';
  if (type === 'image/svg+xml') return type;
  return 'other';
}


async function request(
  baseUrl: string,
  key: string,
  path: string,
  fetchFn: ProbeFetch,
  init: RequestInit = {},
): Promise<ProbeResponse> {
  let response: Response;
  try {
    response = await fetchFn(`${baseUrl.replace(/\/$/, '')}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${key}`,
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...init.headers,
      },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    fail('request-failed-before-response');
  }

  const contentType = mediaType(response);
  let text: string;
  try {
    text = await response.text();
  } catch {
    fail('response-body-unreadable');
  }

  let body: unknown = text;
  if (contentType === 'application/json') {
    try {
      body = text.length === 0 ? null : JSON.parse(text);
    } catch {
      fail('response-body-invalid-json');
    }
  }
  if (!response.ok) {
    const status = Number.isInteger(response.status) && response.status >= 100 && response.status <= 599
      ? response.status
      : undefined;
    fail('request-rejected', status);
  }
  return { status: response.status, contentType, body };
}

function record(name: SuccessMarker, response: ProbeResponse, log: (line: string) => void): void {
  log(`PAPERCLIP_PHASE_PROBE ${JSON.stringify({
    name,
    status: response.status,
    contentType: response.contentType,
    shape: redactShape(response.body),
  })}`);
}

export function paperclipPhaseProbeFailureLine(error: unknown): string {
  if (error instanceof PaperclipPhaseProbeError) {
    return `${PAPERCLIP_PHASE_PROBE_FAILURE_MARKER} ${error.name}: ${error.message}`;
  }
  const name = error instanceof Error ? 'Error' : 'NonError';
  return `${PAPERCLIP_PHASE_PROBE_FAILURE_MARKER} ${name}: unexpected-probe-failure`;
}

export async function runPaperclipPhaseProbe(deps: PaperclipPhaseProbeDeps = {}): Promise<void> {
  const env = deps.env ?? process.env;
  const fetchFn = deps.fetchFn ?? fetch;
  const log = deps.log ?? console.log;
  const uuid = deps.uuid ?? randomUUID;
  const baseUrl = required(env, 'PAPERCLIP_BASE_URL', 'missing-base-url');
  const companyId = required(env, 'PAPERCLIP_COMPANY_ID', 'missing-company-id');
  const key = agentKey(env);
  const company = encodeURIComponent(companyId);
  let goalId: string | undefined;

  try {
    for (const [name, path] of [
      ['org', `/api/companies/${company}/org`],
      ['whoami', '/api/agents/me'],
      ['goals-list', `/api/companies/${company}/goals`],
    ] as const) {
      const result = await request(baseUrl, key, path, fetchFn);
      record(name, result, log);
    }

    const svg = await request(baseUrl, key, `/api/companies/${company}/org.svg`, fetchFn);
    const svgText = typeof svg.body === 'string' ? svg.body : '';
    if (!svgText.includes('<svg')) fail('org-svg-invalid');
    record('org-svg', { ...svg, body: { svg: true } }, log);

    const created = await request(baseUrl, key, `/api/companies/${company}/goals`, fetchFn, {
      method: 'POST',
      body: JSON.stringify({
        title: `netzar-contract-probe-${uuid()}`,
        description: 'temporary staging contract probe',
        level: 'agent',
        status: 'planned',
      }),
    });
    record('goal-create', created, log);
    const createdId =
      typeof created.body === 'object' && created.body !== null
        ? (created.body as Record<string, unknown>).id
        : undefined;
    if (typeof createdId !== 'string' || createdId.length === 0) fail('goal-create-missing-id');
    goalId = createdId;

    const encodedGoal = encodeURIComponent(goalId);
    const fetched = await request(baseUrl, key, `/api/goals/${encodedGoal}`, fetchFn);
    record('goal-get', fetched, log);

    const updated = await request(baseUrl, key, `/api/goals/${encodedGoal}`, fetchFn, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'active' }),
    });
    record('goal-update', updated, log);

    const deleted = await request(baseUrl, key, `/api/goals/${encodedGoal}`, fetchFn, {
      method: 'DELETE',
    });
    record('goal-delete', deleted, log);
    goalId = undefined;
  } finally {
    if (goalId) {
      await request(
        baseUrl,
        key,
        `/api/goals/${encodeURIComponent(goalId)}`,
        fetchFn,
        { method: 'DELETE' },
      ).catch(() => undefined);
    }
  }
}

if (process.argv[1]?.endsWith('paperclip-phase-probe.js')) {
  runPaperclipPhaseProbe().catch((error: unknown) => {
    console.error(paperclipPhaseProbeFailureLine(error));
    process.exitCode = 1;
  });
}
