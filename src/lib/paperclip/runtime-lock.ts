/**
 * Live reader for ADR 0014 item 2, with its verdict, latch, startup gate, and watcher.
 * An unprovable runtime shape is never clean.
 * A proven violation beats a failed read.
 * A stale verdict closes the latch.
 */
import { logger } from '../../observability/logger.js';

export const PAPERCLIP_LOCK_RECHECK_MS = 60_000;
export const PAPERCLIP_LOCK_STALE_MS = 5 * PAPERCLIP_LOCK_RECHECK_MS;
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
const array = (value: unknown): value is unknown[] => Array.isArray(value);
const strings = (value: unknown): value is string[] => array(value) && value.every((item) => typeof item === 'string');

function booleanLike(value: unknown): boolean {
  if (value === true || value === 1) return true;
  return typeof value === 'string' && ['true', '1', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function parseAgent(value: unknown): { agent?: RuntimeLockSnapshot['agents'][number]; provable: boolean } {
  if (!record(value) || typeof value.id !== 'string' || typeof value.name !== 'string' || typeof value.adapterType !== 'string') {
    return { provable: false };
  }
  const runtime = value.runtimeConfig;
  const runtimeValid = runtime == null || record(runtime);
  const heartbeat = record(runtime) ? runtime.heartbeat : undefined;
  const heartbeatValid = heartbeat == null || record(heartbeat);
  return {
    agent: {
      id: value.id, name: value.name, adapterType: value.adapterType,
      heartbeatEnabled: record(heartbeat) && booleanLike(heartbeat.enabled),
    },
    provable: runtimeValid && heartbeatValid,
  };
}

function parseAgents(value: unknown): { agents: RuntimeLockSnapshot['agents']; provable: boolean } {
  if (!array(value)) return { agents: [], provable: false };
  const agents: RuntimeLockSnapshot['agents'] = [];
  let provable = true;
  for (const row of value) {
    const parsed = parseAgent(row);
    if (parsed.agent) agents.push(parsed.agent);
    if (!parsed.provable) provable = false;
  }
  return { agents, provable };
}

function parseCount(value: unknown, key?: string): number | null {
  const list = key ? (record(value) ? value[key] : undefined) : value;
  return array(list) ? list.length : null;
}

function parseHiddenSettings(value: unknown): string[] | null {
  if (!record(value)) return null;
  const hidden = value.hiddenSettings === undefined ? [] : value.hiddenSettings;
  return strings(hidden) ? hidden : null;
}

function parseRunner(value: unknown): boolean | null {
  return record(value) && typeof value.enableNativeRunner === 'boolean' ? value.enableNativeRunner : null;
}

function parseSnapshot(reads: ReadResult[]): { snapshot: RuntimeLockSnapshot; provable: boolean } {
  const [health, settings, rows, profiles, applications, connections] = reads.map((item) => item.body);
  const hiddenSettings = parseHiddenSettings(health);
  const enableNativeRunner = parseRunner(settings);
  const agents = parseAgents(rows);
  const remoteProfileCount = parseCount(profiles);
  const toolApplicationCount = parseCount(applications, 'applications');
  const toolConnectionCount = parseCount(connections, 'connections');
  return {
    snapshot: {
      hiddenSettings: hiddenSettings ?? [...REQUIRED_HIDDEN_SETTINGS],
      enableNativeRunner: enableNativeRunner ?? false,
      agents: agents.agents,
      remoteProfileCount: remoteProfileCount ?? 0,
      toolApplicationCount: toolApplicationCount ?? 0,
      toolConnectionCount: toolConnectionCount ?? 0,
    },
    provable: hiddenSettings !== null && enableNativeRunner !== null &&
      agents.provable && remoteProfileCount !== null && toolApplicationCount !== null && toolConnectionCount !== null,
  };
}

async function readPath(fetchFn: typeof fetch, baseUrl: string, path: string, authed: boolean, auditorKey: string): Promise<ReadResult> {
  const requestTimeoutMs = 10_000;
  try {
    const response = await fetchFn(`${baseUrl.replace(/\/+$/, '')}${path}`, {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(requestTimeoutMs),
      ...(authed ? { headers: { authorization: `Bearer ${auditorKey}` } } : {}),
    });
    if (!response.ok) {
      logger.warn({ path, status: response.status }, 'paperclip lock read failed');
      if (response.status === 408 || response.status === 429 || response.status >= 500 ||
          (!authed && (response.status === 401 || response.status === 403))) return { reason: 'paperclip_unreachable' };
      return { reason: response.status === 401 || response.status === 403 ? 'auditor_key_rejected' : 'unexpected_shape' };
    }
    try { return { body: await response.json() }; }
    catch {
      logger.warn({ path, status: response.status, errMessage: 'invalid JSON' }, 'paperclip lock read failed');
      return { reason: 'unexpected_shape' };
    }
  } catch (error) {
    const errMessage = (error instanceof Error ? error.message : String(error)).replaceAll(auditorKey, '[redacted]');
    logger.warn({ path, errMessage }, 'paperclip lock read failed');
    return { reason: 'paperclip_unreachable' };
  }
}

export async function readRuntimeLockVerdict({ fetchFn, baseUrl, companyId, auditorKey }: ReadOptions): Promise<LockVerdict> {
  if (!auditorKey) return { verdict: 'unknown', reason: 'lock_auditor_key_missing' };
  const company = `/api/companies/${encodeURIComponent(companyId)}`;
  const paths = [
    { path: '/api/health', authed: false },
    { path: '/api/instance/settings/experimental', authed: true },
    { path: `${company}/agents`, authed: true },
    { path: `${company}/remote-agent-profiles`, authed: true },
    { path: `${company}/tools/applications`, authed: true },
    { path: `${company}/tools/connections`, authed: true },
  ];
  const reads = await Promise.all(paths.map(({ path, authed }) => readPath(fetchFn, baseUrl, path, authed, auditorKey)));
  const parsed = parseSnapshot(reads);
  let observed: LockVerdict = { verdict: 'unknown', reason: 'unexpected_shape' };
  const evaluated = evaluateRuntimeLock(parsed.snapshot);
  if (evaluated.verdict === 'violated') return evaluated;
  const failure = reads.find((item) => item.reason);
  if (failure?.reason) return { verdict: 'unknown', reason: failure.reason };
  if (parsed.provable) observed = { verdict: 'clean' };
  return observed;
}

export async function readConfiguredLockVerdict({ loadConfig, fetchFn, auditorKey }: {
  loadConfig: () => Promise<{ baseUrl?: string | undefined; companyId?: string | undefined }>;
  fetchFn: typeof fetch;
  auditorKey?: string | undefined;
}): Promise<LockVerdict> {
  let config: Awaited<ReturnType<typeof loadConfig>>;
  try { config = await loadConfig(); } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const errMessage = auditorKey ? message.replaceAll(auditorKey, '[redacted]') : message;
    try { logger.warn({ errMessage }, 'paperclip lock cannot load its configuration'); } catch { /* logging must not reject the reader */ }
    return { verdict: 'unknown', reason: 'paperclip_config_unavailable' };
  }
  if (!config.baseUrl || !config.companyId) return { verdict: 'unknown', reason: 'paperclip_config_missing' };
  try { return await readRuntimeLockVerdict({ fetchFn, baseUrl: config.baseUrl, companyId: config.companyId, auditorKey }); }
  catch { return { verdict: 'unknown', reason: 'paperclip_unreachable' }; }
}

let state: { closed: boolean; code: string | null } = { closed: false, code: null };
let previous: string | null = null;
let lastAppliedAt: number | null = null;
let staleWarned = false;

export function getPaperclipLockState(): { closed: boolean; code: string | null } {
  if (lastAppliedAt !== null && !state.closed && Date.now() - lastAppliedAt > PAPERCLIP_LOCK_STALE_MS) {
    return { closed: true, code: 'unknown:lock_check_stale' };
  }
  return { ...state };
}
export function __resetPaperclipLockForTest(): void { state = { closed: false, code: null }; previous = null; lastAppliedAt = null; staleWarned = false; }
export function startupLockAction(verdict: LockVerdict): 'proceed' | 'refuse' | 'latch' {
  return verdict.verdict === 'clean' ? 'proceed' : verdict.verdict === 'violated' ? 'refuse' : 'latch';
}

function applyVerdict(verdict: LockVerdict): void {
  const codes = verdict.verdict === 'violated' ? verdict.violations.map((v) => v.code) : verdict.verdict === 'unknown' ? [verdict.reason] : [];
  state = { closed: verdict.verdict !== 'clean', code: verdict.verdict === 'clean' ? null : `${verdict.verdict}:${codes.join(',')}` };
  lastAppliedAt = Date.now();
  staleWarned = false;
  const signature = JSON.stringify(verdict);
  if (signature !== previous) {
    logger[verdict.verdict === 'clean' ? 'info' : 'warn']({ verdict: verdict.verdict, codes, closed: state.closed }, 'paperclip lock verdict');
    previous = signature;
  }
}

async function safeRead(read: () => Promise<LockVerdict>): Promise<LockVerdict> {
  try { return await read(); } catch (error) {
    logger.warn({ errMessage: error instanceof Error ? error.message : String(error) }, 'paperclip lock read threw');
    return { verdict: 'unknown', reason: 'paperclip_unreachable' };
  }
}

export async function enforceStartupLock({ read, sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)), attempts = 3, retryDelayMs = 1_000 }: {
  read: () => Promise<LockVerdict>; sleep?: (ms: number) => Promise<void>; attempts?: number; retryDelayMs?: number;
}): Promise<LockVerdict> {
  let verdict: LockVerdict = { verdict: 'unknown', reason: 'paperclip_unreachable' };
  const maxAttempts = Number.isInteger(attempts) && attempts >= 1 ? attempts : 3;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    verdict = await safeRead(read);
    applyVerdict(verdict);
    switch (startupLockAction(verdict)) {
      case 'refuse':
        throw new Error(`Refusing to start: Paperclip runtime lock violated: ${verdict.verdict === 'violated' ? verdict.violations.map((v) => v.code).join(',') : ''}`);
      case 'proceed': return verdict;
      case 'latch': if (attempt < maxAttempts - 1) await sleep(retryDelayMs);
    }
  }
  return verdict;
}

export function startPaperclipLockWatcher({ read }: { read: () => Promise<LockVerdict> }): { stop: () => void } {
  let reading = false;
  let stopped = false;
  const timer = setInterval(() => {
    if (reading) {
      if (!staleWarned && lastAppliedAt !== null && Date.now() - lastAppliedAt > PAPERCLIP_LOCK_STALE_MS) {
        staleWarned = true;
        try { logger.warn({ ageMs: Date.now() - lastAppliedAt }, 'paperclip lock verdict is stale'); } catch { /* logging must not stop checks */ }
      }
      return;
    }
    reading = true;
    void safeRead(read).then((verdict) => { if (!stopped) applyVerdict(verdict); })
      .finally(() => { reading = false; })
      .catch((error) => {
        try { logger.warn({ errMessage: error instanceof Error ? error.message : String(error) }, 'paperclip lock watcher tick failed'); }
        catch { /* logging must not reject the watcher chain */ }
      });
  }, PAPERCLIP_LOCK_RECHECK_MS);
  timer.unref();
  return { stop: () => { stopped = true; clearInterval(timer); } };
}
