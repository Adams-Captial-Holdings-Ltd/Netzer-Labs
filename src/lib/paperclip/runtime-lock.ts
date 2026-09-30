import { logger } from '../../observability/logger.js';

export const PAPERCLIP_LOCK_RECHECK_MS = 60_000;
export const REQUIRED_HIDDEN_SETTINGS = ['instance.adapters', 'instance.plugins'] as const;

export interface RuntimeLockSnapshot {
  hiddenSettings: string[];
  enableNativeRunner: boolean;
  agents: Array<{ id: string; name: string; adapterType: string; heartbeatEnabled: boolean }>;
  remoteProfileCount: number;
  toolApplicationCount: number;
  toolConnectionCount: number;
}

export type LockVerdict =
  | { verdict: 'clean' }
  | { verdict: 'violated'; violations: Array<{ code: string; detail: string }> }
  | { verdict: 'unknown'; reason: string };

export function evaluateRuntimeLock(snapshot: RuntimeLockSnapshot): LockVerdict {
  const violations: Array<{ code: string; detail: string }> = [];
  if (snapshot.enableNativeRunner) violations.push({ code: 'native_runner_on', detail: 'enableNativeRunner is true' });
  const missing = REQUIRED_HIDDEN_SETTINGS.filter((key) => !snapshot.hiddenSettings.includes(key));
  if (missing.length) violations.push({ code: 'settings_not_locked', detail: `Missing hidden settings: ${missing.join(', ')}` });
  for (const agent of snapshot.agents) {
    if (agent.adapterType !== 'http') violations.push({ code: 'non_http_agent', detail: `${agent.name} uses ${agent.adapterType}` });
  }
  if (snapshot.remoteProfileCount) violations.push({ code: 'remote_profile_present', detail: 'Remote agent profile exists' });
  if (snapshot.toolApplicationCount || snapshot.toolConnectionCount) {
    violations.push({ code: 'tool_access_present', detail: 'Paperclip tool access exists' });
  }
  for (const agent of snapshot.agents) {
    if (agent.heartbeatEnabled) violations.push({ code: 'agent_timer_heartbeat_on', detail: `${agent.name} has timer heartbeat enabled` });
  }
  return violations.length ? { verdict: 'violated', violations } : { verdict: 'clean' };
}

type ReadOptions = { fetchFn: typeof fetch; baseUrl: string; companyId: string; auditorKey?: string | undefined };
type ReadResult = { body: unknown; reason?: never } | { body?: never; reason: string };
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function booleanLike(value: unknown): boolean {
  if (value === true || value === 1) return true;
  return typeof value === 'string' && ['true', '1', 'yes', 'on'].includes(value.trim().toLowerCase());
}

export async function readRuntimeLockVerdict({ fetchFn, baseUrl, companyId, auditorKey }: ReadOptions): Promise<LockVerdict> {
  if (!auditorKey) return { verdict: 'unknown', reason: 'lock_auditor_key_missing' };
  const company = `/api/companies/${encodeURIComponent(companyId)}`;
  const paths = [
    '/api/health',
    '/api/instance/settings/experimental',
    `${company}/agents`,
    `${company}/remote-agent-profiles`,
    `${company}/tools/applications`,
    `${company}/tools/connections`,
  ];
  const reads = await Promise.all(paths.map(async (path, index): Promise<ReadResult> => {
    try {
      const response = await fetchFn(`${baseUrl.replace(/\/+$/, '')}${path}`, {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
        ...(index ? { headers: { authorization: `Bearer ${auditorKey}` } } : {}),
      });
      if (response.status === 401 || response.status === 403) return { reason: 'auditor_key_rejected' };
      if (response.status >= 500) return { reason: 'paperclip_unreachable' };
      if (!response.ok) return { reason: 'unexpected_shape' };
      try { return { body: await response.json() }; } catch { return { reason: 'unexpected_shape' }; }
    } catch {
      return { reason: 'paperclip_unreachable' };
    }
  }));

  const [health, settings, agentRows, profiles, applications, connections] = reads.map((item) => item.body);
  let observed: LockVerdict = { verdict: 'clean' };
  if (record(health) && record(settings) && typeof settings.enableNativeRunner === 'boolean' &&
      Array.isArray(agentRows) && Array.isArray(profiles) && record(applications) &&
      Array.isArray(applications.applications) && record(connections) && Array.isArray(connections.connections) &&
      (health.hiddenSettings === undefined || (Array.isArray(health.hiddenSettings) && health.hiddenSettings.every((x) => typeof x === 'string'))) &&
      agentRows.every((row) => record(row) && typeof row.id === 'string' && typeof row.name === 'string' && typeof row.adapterType === 'string')) {
    observed = evaluateRuntimeLock({
      hiddenSettings: (health.hiddenSettings ?? []) as string[],
      enableNativeRunner: settings.enableNativeRunner,
      agents: agentRows.map((row) => {
        const runtime = record(row.runtimeConfig) ? row.runtimeConfig : {};
        const heartbeat = record(runtime.heartbeat) ? runtime.heartbeat : {};
        return { id: row.id as string, name: row.name as string, adapterType: row.adapterType as string, heartbeatEnabled: booleanLike(heartbeat.enabled) };
      }),
      remoteProfileCount: profiles.length,
      toolApplicationCount: applications.applications.length,
      toolConnectionCount: connections.connections.length,
    });
  }
  // A proven violation wins even when another read failed.
  const partial: RuntimeLockSnapshot = {
    hiddenSettings: record(health) && Array.isArray(health.hiddenSettings) ? health.hiddenSettings.filter((x): x is string => typeof x === 'string') : [...REQUIRED_HIDDEN_SETTINGS],
    enableNativeRunner: record(settings) && settings.enableNativeRunner === true,
    agents: Array.isArray(agentRows) ? agentRows.filter((row) => record(row) && typeof row.adapterType === 'string').map((row) => {
      const runtime = record(row.runtimeConfig) ? row.runtimeConfig : {};
      const heartbeat = record(runtime.heartbeat) ? runtime.heartbeat : {};
      return { id: typeof row.id === 'string' ? row.id : '', name: typeof row.name === 'string' ? row.name : '', adapterType: row.adapterType as string, heartbeatEnabled: booleanLike(heartbeat.enabled) };
    }) : [],
    remoteProfileCount: Array.isArray(profiles) ? profiles.length : 0,
    toolApplicationCount: record(applications) && Array.isArray(applications.applications) ? applications.applications.length : 0,
    toolConnectionCount: record(connections) && Array.isArray(connections.connections) ? connections.connections.length : 0,
  };
  const violations = evaluateRuntimeLock(partial);
  if (violations.verdict === 'violated') return violations;
  const failure = reads.find((item) => item.reason);
  if (failure?.reason) return { verdict: 'unknown', reason: failure.reason };
  return observed.verdict === 'clean' && !(record(health) && record(settings) && typeof settings.enableNativeRunner === 'boolean' &&
    Array.isArray(agentRows) && agentRows.every((row) => record(row) && typeof row.id === 'string' && typeof row.name === 'string' && typeof row.adapterType === 'string') &&
    Array.isArray(profiles) && record(applications) && Array.isArray(applications.applications) &&
    record(connections) && Array.isArray(connections.connections) &&
    (health.hiddenSettings === undefined || (Array.isArray(health.hiddenSettings) && health.hiddenSettings.every((x) => typeof x === 'string'))))
    ? { verdict: 'unknown', reason: 'unexpected_shape' } : observed;
}

let state: { closed: boolean; code: string | null } = { closed: false, code: null };
let previous: string | null = null;

export function getPaperclipLockState(): { closed: boolean; code: string | null } { return { ...state }; }
export function __resetPaperclipLockForTest(): void { state = { closed: false, code: null }; previous = null; }
export function startupLockAction(verdict: LockVerdict): 'proceed' | 'refuse' | 'latch' {
  return verdict.verdict === 'clean' ? 'proceed' : verdict.verdict === 'violated' ? 'refuse' : 'latch';
}

function applyVerdict(verdict: LockVerdict): void {
  const codes = verdict.verdict === 'violated' ? verdict.violations.map((v) => v.code) : verdict.verdict === 'unknown' ? [verdict.reason] : [];
  state = { closed: verdict.verdict !== 'clean', code: verdict.verdict === 'clean' ? null : `${verdict.verdict}:${codes.join(',')}` };
  const signature = JSON.stringify(verdict);
  if (signature !== previous) {
    logger[verdict.verdict === 'clean' ? 'info' : 'warn']({ verdict: verdict.verdict, codes, closed: state.closed }, 'paperclip lock verdict');
    previous = signature;
  }
}

async function safeRead(read: () => Promise<LockVerdict>): Promise<LockVerdict> {
  try { return await read(); } catch { return { verdict: 'unknown', reason: 'paperclip_unreachable' }; }
}

export async function enforceStartupLock({ read, sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)), attempts = 3, retryDelayMs = 1_000 }: {
  read: () => Promise<LockVerdict>; sleep?: (ms: number) => Promise<void>; attempts?: number; retryDelayMs?: number;
}): Promise<LockVerdict> {
  let verdict: LockVerdict = { verdict: 'unknown', reason: 'paperclip_unreachable' };
  for (let attempt = 0; attempt < Math.max(1, attempts); attempt++) {
    verdict = await safeRead(read);
    applyVerdict(verdict);
    if (verdict.verdict === 'violated') throw new Error(`Refusing to start: Paperclip runtime lock violated: ${verdict.violations.map((v) => v.code).join(',')}`);
    if (verdict.verdict === 'clean') return verdict;
    if (attempt < attempts - 1) await sleep(retryDelayMs);
  }
  return verdict;
}

export function startPaperclipLockWatcher({ read }: { read: () => Promise<LockVerdict> }): { stop: () => void } {
  let reading = false;
  const timer = setInterval(() => {
    if (reading) return;
    reading = true;
    void safeRead(read).then(applyVerdict).finally(() => { reading = false; });
  }, PAPERCLIP_LOCK_RECHECK_MS);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
