/**
 * FROZEN ACCEPTANCE TEST: Work Platform step 2 (SPECIFICATION checkpoint).
 *
 * Written by the coordinator BEFORE any production code. The builder implements
 * `runtime-lock.ts` (and the consumer hooks named in the last describe
 * block) to make this file pass, and MUST NOT edit it: the step gate pins its
 * sha256. Add your own tests in other files.
 *
 * WHAT THIS PINS (ADR 0014 item 2, amended by the lock-architecture decision
 * "B-prime", 2026-09-30): the orchestrator proves, LIVE, at start and every 60 s,
 * that all five runtime-lock conditions hold on the Paperclip it talks to:
 *   1. the native runner is off (board-only read, so a NON-ADMIN company-member
 *      board key, the "lock auditor", reads it; the instance-admin key never
 *      leaves the operator machine),
 *   2. no agent uses a non-http adapter (auditor key),
 *   3. no remote agent profile exists (auditor key),
 *   4. Paperclip tool access is off: no tool application and no tool connection
 *      (auditor key),
 *   5. timer heartbeats are off on every agent (auditor key; Paperclip reads the
 *      flag with its own parseBooleanLike, which this file mirrors),
 * and that the two operator-managed settings levers that cannot trap a fresh
 * install are locked (`instance.adapters`, `instance.plugins`; unauthenticated
 * health lists them). The native-runner flag is DELIBERATELY not in that list: it
 * defaults ON, and a hidden setting cannot be changed through the API, so hiding
 * it before the bootstrap has turned it off would freeze it ON for good. It is
 * protected by condition 1's live read instead, and the bootstrap turns it off.
 *
 * THE THREE OUTCOMES. `violated` at start = refuse to start (the process exits, so
 * the ECS circuit breaker fails the deploy). `unknown` (Paperclip unreachable,
 * a credential missing or rejected, a payload that has drifted in shape) = start,
 * but latch the Paperclip surface CLOSED with a real non-2xx and re-check every
 * 60 s (Jev 0.89: Paperclip rolls at min healthy 0, so "refuse" would crash-loop
 * the orchestrator during any Paperclip roll). `clean` = open. The latch is closed
 * unless the latest verdict is clean. A violation found on any read wins over a
 * failed read.
 *
 * ALL FIVE READS USE THE AUDITOR'S BOARD KEY, NEVER AN AGENT KEY. Read in the
 * Paperclip source: a board actor with company access always gets the full agent
 * row, viewers included ("allow_simple_company_member"), but an agent actor
 * without the agent_config:read grant gets `runtimeConfig: {}`, which would read
 * as "heartbeats off" and fail OPEN.
 *
 * Nothing in this file touches AWS or a real Paperclip.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PAPERCLIP_LOCK_RECHECK_MS,
  REQUIRED_HIDDEN_SETTINGS,
  __resetPaperclipLockForTest,
  enforceStartupLock,
  evaluateRuntimeLock,
  getPaperclipLockState,
  readRuntimeLockVerdict,
  startPaperclipLockWatcher,
  startupLockAction,
  type LockVerdict,
  type RuntimeLockSnapshot,
} from './runtime-lock.js';
import { PaperclipClient, __resetPaperclipCompanyPin } from './client.js';
import { PaperclipDisabledError } from './error.js';
import { __resetPaperclipReconcilerForTest, runPaperclipReconcilePassOnce } from './reconciler.js';

const BASE = 'http://paperclip.claudeclaw.internal:3100';
const COMPANY = 'c0000000-0000-4000-8000-000000000001';
// Distinctive on purpose: the no-leak test searches the verdict for these strings.
const AUDITOR_KEY = 'pcp_board_AUDITOR_SECRET_VALUE_7f3a';
const AGENT_KEY = 'pcp_AGENT_SECRET_VALUE_91bc';

const cleanSnapshot = (): RuntimeLockSnapshot => ({
  hiddenSettings: [...REQUIRED_HIDDEN_SETTINGS],
  enableNativeRunner: false,
  agents: [{ id: 'a1', name: 'main', adapterType: 'http', heartbeatEnabled: false }],
  remoteProfileCount: 0,
  toolApplicationCount: 0,
  toolConnectionCount: 0,
});

const violationCodes = (v: LockVerdict): string[] =>
  v.verdict === 'violated' ? v.violations.map((x) => x.code) : [];

// ─────────────────────────────────────────────────────────────────────────────
// 1. The pure verdict
// ─────────────────────────────────────────────────────────────────────────────
describe('evaluateRuntimeLock: ADR 0014 item 2, five conditions and one lock', () => {
  it('is clean when all five conditions hold and the two settings are locked', () => {
    expect(evaluateRuntimeLock(cleanSnapshot())).toEqual({ verdict: 'clean' });
  });

  it('REQUIRED_HIDDEN_SETTINGS is exactly the two trap-free levers, and never the native-runner flag', () => {
    expect([...REQUIRED_HIDDEN_SETTINGS].sort()).toEqual(['instance.adapters', 'instance.plugins'].sort());
    expect(REQUIRED_HIDDEN_SETTINGS.join(',')).not.toContain('enableNativeRunner');
  });

  it('condition 1: the native runner on is native_runner_on', () => {
    const v = evaluateRuntimeLock({ ...cleanSnapshot(), enableNativeRunner: true });
    expect(violationCodes(v)).toEqual(['native_runner_on']);
  });

  it.each([...REQUIRED_HIDDEN_SETTINGS])('a hidden-settings list missing %s is settings_not_locked and names the key', (missing) => {
    const hidden = REQUIRED_HIDDEN_SETTINGS.filter((k) => k !== missing);
    const v = evaluateRuntimeLock({ ...cleanSnapshot(), hiddenSettings: [...hidden] });
    expect(violationCodes(v)).toEqual(['settings_not_locked']);
    expect(v.verdict === 'violated' && v.violations[0]?.detail).toContain(missing);
  });

  it('extra hidden settings are fine', () => {
    const v = evaluateRuntimeLock({
      ...cleanSnapshot(),
      hiddenSettings: [...REQUIRED_HIDDEN_SETTINGS, 'instance.general.keyboardShortcuts'],
    });
    expect(v).toEqual({ verdict: 'clean' });
  });

  it.each(['claude_local', 'process', 'paperclip_runner', 'codex_local'])(
    'condition 2: an agent on the %s adapter is non_http_agent and the detail names the agent',
    (adapterType) => {
      const v = evaluateRuntimeLock({
        ...cleanSnapshot(),
        agents: [
          { id: 'a1', name: 'main', adapterType: 'http', heartbeatEnabled: false },
          { id: 'a2', name: 'Summarizer', adapterType, heartbeatEnabled: false },
        ],
      });
      expect(violationCodes(v)).toEqual(['non_http_agent']);
      expect(v.verdict === 'violated' && v.violations[0]?.detail).toContain('Summarizer');
    },
  );

  it('an adapter type that merely contains "http" is not http', () => {
    const v = evaluateRuntimeLock({
      ...cleanSnapshot(),
      agents: [{ id: 'a2', name: 'x', adapterType: 'http_remote', heartbeatEnabled: false }],
    });
    expect(violationCodes(v)).toEqual(['non_http_agent']);
  });

  it('condition 3: any remote agent profile is remote_profile_present', () => {
    expect(violationCodes(evaluateRuntimeLock({ ...cleanSnapshot(), remoteProfileCount: 1 }))).toEqual([
      'remote_profile_present',
    ]);
  });

  it('condition 4: a tool application OR a tool connection is tool_access_present', () => {
    expect(violationCodes(evaluateRuntimeLock({ ...cleanSnapshot(), toolApplicationCount: 1 }))).toEqual([
      'tool_access_present',
    ]);
    expect(violationCodes(evaluateRuntimeLock({ ...cleanSnapshot(), toolConnectionCount: 2 }))).toEqual([
      'tool_access_present',
    ]);
  });

  it('condition 5: a timer heartbeat on any agent is agent_timer_heartbeat_on and names the agent', () => {
    const v = evaluateRuntimeLock({
      ...cleanSnapshot(),
      agents: [
        { id: 'a1', name: 'main', adapterType: 'http', heartbeatEnabled: false },
        { id: 'a2', name: 'writer', adapterType: 'http', heartbeatEnabled: true },
      ],
    });
    expect(violationCodes(v)).toEqual(['agent_timer_heartbeat_on']);
    expect(v.verdict === 'violated' && v.violations[0]?.detail).toContain('writer');
  });

  it('reports every violation, in the fixed order of the conditions, each agent once per code', () => {
    const v = evaluateRuntimeLock({
      hiddenSettings: [],
      enableNativeRunner: true,
      agents: [
        { id: 'a1', name: 'one', adapterType: 'claude_local', heartbeatEnabled: true },
        { id: 'a2', name: 'two', adapterType: 'process', heartbeatEnabled: false },
      ],
      remoteProfileCount: 3,
      toolApplicationCount: 1,
      toolConnectionCount: 1,
    });
    expect(violationCodes(v)).toEqual([
      'native_runner_on',
      'settings_not_locked',
      'non_http_agent',
      'non_http_agent',
      'remote_profile_present',
      'tool_access_present',
      'agent_timer_heartbeat_on',
    ]);
    // ONE settings_not_locked violation, whose detail names EVERY missing key.
    const detail = v.verdict === 'violated' ? (v.violations.find((x) => x.code === 'settings_not_locked')?.detail ?? '') : '';
    for (const key of REQUIRED_HIDDEN_SETTINGS) expect(detail).toContain(key);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Reading the facts from Paperclip (injected fetch, no network)
// ─────────────────────────────────────────────────────────────────────────────
interface Route {
  status?: number;
  body?: unknown;
  raw?: string;
  throws?: Error;
}
type Routes = Record<string, Route>;

const goodRoutes = (): Routes => ({
  '/api/health': { body: { status: 'ok', hiddenSettings: [...REQUIRED_HIDDEN_SETTINGS] } },
  '/api/instance/settings/experimental': { body: { enableNativeRunner: false, enableBuiltInAgents: false } },
  [`/api/companies/${COMPANY}/agents`]: {
    body: [
      { id: 'a1', name: 'main', role: 'ceo', adapterType: 'http', runtimeConfig: { heartbeat: { enabled: false, maxConcurrentRuns: 1 } } },
      { id: 'a2', name: 'writer', role: 'general', adapterType: 'http', runtimeConfig: {} },
    ],
  },
  [`/api/companies/${COMPANY}/remote-agent-profiles`]: { body: [] },
  [`/api/companies/${COMPANY}/tools/applications`]: { body: { applications: [] } },
  [`/api/companies/${COMPANY}/tools/connections`]: { body: { connections: [] } },
});

function fakeFetch(routes: Routes) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });
    const route = routes[new URL(url).pathname];
    if (!route) return new Response('not found', { status: 404 });
    if (route.throws) throw route.throws;
    return new Response(route.raw ?? JSON.stringify(route.body ?? {}), {
      status: route.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  return { fetchFn: fn as unknown as typeof fetch, calls, fn };
}

const readWith = (routes: Routes, over: { auditorKey?: string | undefined; baseUrl?: string } = {}) => {
  const f = fakeFetch(routes);
  const verdict = readRuntimeLockVerdict({
    fetchFn: f.fetchFn,
    baseUrl: over.baseUrl ?? BASE,
    companyId: COMPANY,
    auditorKey: 'auditorKey' in over ? over.auditorKey : AUDITOR_KEY,
  });
  return { verdict, ...f };
};

const authOf = (init: RequestInit | undefined): string | null => new Headers(init?.headers).get('authorization');

describe('readRuntimeLockVerdict: reads the five conditions live, with the least privilege each read needs', () => {
  it('a compliant Paperclip is clean', async () => {
    const { verdict } = readWith(goodRoutes());
    expect(await verdict).toEqual({ verdict: 'clean' });
  });

  it('reads exactly six GET endpoints, tolerates a trailing slash on the base URL, and never follows a redirect', async () => {
    const { verdict, calls } = readWith(goodRoutes(), { baseUrl: `${BASE}/` });
    await verdict;
    const paths = calls.map((c) => new URL(c.url).pathname).sort();
    expect(paths).toEqual(
      [
        '/api/health',
        '/api/instance/settings/experimental',
        `/api/companies/${COMPANY}/agents`,
        `/api/companies/${COMPANY}/remote-agent-profiles`,
        `/api/companies/${COMPANY}/tools/applications`,
        `/api/companies/${COMPANY}/tools/connections`,
      ].sort(),
    );
    for (const c of calls) {
      expect(new URL(c.url).origin).toBe(BASE);
      expect(c.init?.method ?? 'GET').toBe('GET');
      expect(c.init?.redirect).toBe('error');
      expect(c.init?.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it('sends the auditor key on every read except health, which carries no credential, and never an agent key', async () => {
    const { verdict, calls } = readWith(goodRoutes());
    await verdict;
    const auth = Object.fromEntries(calls.map((c) => [new URL(c.url).pathname, authOf(c.init)]));
    expect(auth['/api/health']).toBeNull();
    for (const path of [
      '/api/instance/settings/experimental',
      `/api/companies/${COMPANY}/agents`,
      `/api/companies/${COMPANY}/remote-agent-profiles`,
      `/api/companies/${COMPANY}/tools/applications`,
      `/api/companies/${COMPANY}/tools/connections`,
    ]) {
      expect(auth[path], path).toBe(`Bearer ${AUDITOR_KEY}`);
    }
    expect(JSON.stringify(calls.map((c) => c.init))).not.toContain(AGENT_KEY);
  });

  it('health without a hiddenSettings field (nothing is hidden) is settings_not_locked, not an error', async () => {
    const routes = goodRoutes();
    routes['/api/health'] = { body: { status: 'ok' } };
    expect(violationCodes(await readWith(routes).verdict)).toEqual(['settings_not_locked']);
  });

  it('native runner on, read through the auditor key, is native_runner_on', async () => {
    const routes = goodRoutes();
    routes['/api/instance/settings/experimental'] = { body: { enableNativeRunner: true } };
    expect(violationCodes(await readWith(routes).verdict)).toEqual(['native_runner_on']);
  });

  it('a non-http agent in the company list is non_http_agent and names it', async () => {
    const routes = goodRoutes();
    routes[`/api/companies/${COMPANY}/agents`] = {
      body: [
        { id: 'a1', name: 'main', adapterType: 'http', runtimeConfig: {} },
        { id: 'a9', name: 'Reflection Coach', adapterType: 'claude_local', runtimeConfig: {} },
      ],
    };
    const v = await readWith(routes).verdict;
    expect(violationCodes(v)).toEqual(['non_http_agent']);
    expect(v.verdict === 'violated' && v.violations[0]?.detail).toContain('Reflection Coach');
  });

  it.each([true, 1, 'true', '1', 'yes', 'on', ' ON '])(
    'heartbeat.enabled = %j counts as ON, exactly as Paperclip reads it',
    async (enabled) => {
      const routes = goodRoutes();
      routes[`/api/companies/${COMPANY}/agents`] = {
        body: [{ id: 'a1', name: 'main', adapterType: 'http', runtimeConfig: { heartbeat: { enabled } } }],
      };
      expect(violationCodes(await readWith(routes).verdict)).toEqual(['agent_timer_heartbeat_on']);
    },
  );

  it.each([false, 0, 'false', '0', 'no', 'off', 'maybe', null])(
    'heartbeat.enabled = %j is OFF, exactly as Paperclip reads it (unparseable counts as off there)',
    async (enabled) => {
      const routes = goodRoutes();
      routes[`/api/companies/${COMPANY}/agents`] = {
        body: [{ id: 'a1', name: 'main', adapterType: 'http', runtimeConfig: { heartbeat: { enabled } } }],
      };
      expect(await readWith(routes).verdict).toEqual({ verdict: 'clean' });
    },
  );

  it('an agent row with no runtimeConfig at all has heartbeats off', async () => {
    const routes = goodRoutes();
    routes[`/api/companies/${COMPANY}/agents`] = { body: [{ id: 'a1', name: 'main', adapterType: 'http' }] };
    expect(await readWith(routes).verdict).toEqual({ verdict: 'clean' });
  });

  it('a remote profile, a tool application and a tool connection are each found', async () => {
    const routes = goodRoutes();
    routes[`/api/companies/${COMPANY}/remote-agent-profiles`] = { body: [{ id: 'r1' }] };
    routes[`/api/companies/${COMPANY}/tools/applications`] = { body: { applications: [{ id: 't1' }] } };
    routes[`/api/companies/${COMPANY}/tools/connections`] = { body: { connections: [{ id: 'c1' }] } };
    expect(violationCodes(await readWith(routes).verdict)).toEqual(['remote_profile_present', 'tool_access_present']);
  });

  it('a verdict never contains a credential', async () => {
    const routes = goodRoutes();
    routes['/api/instance/settings/experimental'] = { body: { enableNativeRunner: true } };
    routes[`/api/companies/${COMPANY}/agents`] = {
      body: [{ id: 'a9', name: 'leaky', adapterType: 'process', adapterConfig: { headers: { authorization: `Bearer ${AGENT_KEY}` } } }],
    };
    const json = JSON.stringify(await readWith(routes).verdict);
    expect(json).not.toContain(AUDITOR_KEY);
    expect(json).not.toContain(AGENT_KEY);
    expect(json).toContain('leaky');
  });

  // ── unknown: cannot prove it, so the surface stays closed (never "assume clean") ──
  it('no auditor key is unknown/lock_auditor_key_missing and makes no request', async () => {
    const { verdict, fn } = readWith(goodRoutes(), { auditorKey: undefined });
    expect(await verdict).toEqual({ verdict: 'unknown', reason: 'lock_auditor_key_missing' });
    expect(fn).not.toHaveBeenCalled();
  });

  it('a network error on any read is unknown/paperclip_unreachable', async () => {
    const routes = goodRoutes();
    routes['/api/health'] = { throws: new TypeError('fetch failed') };
    expect(await readWith(routes).verdict).toEqual({ verdict: 'unknown', reason: 'paperclip_unreachable' });
  });

  it.each([500, 502, 503])('a %i from Paperclip is unknown/paperclip_unreachable', async (status) => {
    const routes = goodRoutes();
    routes['/api/health'] = { status, body: { status: 'starting' } };
    expect(await readWith(routes).verdict).toEqual({ verdict: 'unknown', reason: 'paperclip_unreachable' });
  });

  it.each([401, 403])('a %i on a board read is unknown/auditor_key_rejected', async (status) => {
    const routes = goodRoutes();
    routes['/api/instance/settings/experimental'] = { status, body: { error: 'nope' } };
    expect(await readWith(routes).verdict).toEqual({ verdict: 'unknown', reason: 'auditor_key_rejected' });
  });

  it.each([401, 403])('a %i on the agent list is unknown/auditor_key_rejected too (there is no second key)', async (status) => {
    const routes = goodRoutes();
    routes[`/api/companies/${COMPANY}/agents`] = { status, body: { error: 'nope' } };
    expect(await readWith(routes).verdict).toEqual({ verdict: 'unknown', reason: 'auditor_key_rejected' });
  });

  it.each([404, 410, 422])('a %i on any read (a route that has vanished or changed) is unknown/unexpected_shape', async (status) => {
    const routes = goodRoutes();
    routes[`/api/companies/${COMPANY}/tools/applications`] = { status, body: { error: 'gone' } };
    expect(await readWith(routes).verdict).toEqual({ verdict: 'unknown', reason: 'unexpected_shape' });
  });

  it.each([
    ['experimental settings without a boolean enableNativeRunner', '/api/instance/settings/experimental', { enableBuiltInAgents: false }],
    ['an agent list that is not an array', `/api/companies/${COMPANY}/agents`, { agents: [] }],
    ['an agent row without adapterType', `/api/companies/${COMPANY}/agents`, [{ id: 'a1', name: 'main' }]],
    ['remote profiles that are not an array', `/api/companies/${COMPANY}/remote-agent-profiles`, { profiles: [] }],
    ['tool applications without the applications array', `/api/companies/${COMPANY}/tools/applications`, { items: [] }],
    ['tool connections without the connections array', `/api/companies/${COMPANY}/tools/connections`, {}],
    ['a health body that is not an object', '/api/health', 'ok'],
  ])('%s is unknown/unexpected_shape (a drifted contract fails closed)', async (_label, path, body) => {
    const routes = goodRoutes();
    routes[path] = { body };
    expect(await readWith(routes).verdict).toEqual({ verdict: 'unknown', reason: 'unexpected_shape' });
  });

  it('a body that is not JSON is unknown/unexpected_shape', async () => {
    const routes = goodRoutes();
    routes['/api/instance/settings/experimental'] = { raw: '<html>gateway</html>' };
    expect(await readWith(routes).verdict).toEqual({ verdict: 'unknown', reason: 'unexpected_shape' });
  });

  it('a violation that WAS read beats a read that failed (violated wins over unknown)', async () => {
    const routes = goodRoutes();
    routes[`/api/companies/${COMPANY}/agents`] = {
      body: [{ id: 'a9', name: 'Summarizer', adapterType: 'claude_local', runtimeConfig: {} }],
    };
    routes['/api/instance/settings/experimental'] = { status: 503, body: {} };
    expect(violationCodes(await readWith(routes).verdict)).toEqual(['non_http_agent']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. What each verdict does to the process
// ─────────────────────────────────────────────────────────────────────────────
const unknownVerdict: LockVerdict = { verdict: 'unknown', reason: 'paperclip_unreachable' };
const cleanVerdict: LockVerdict = { verdict: 'clean' };
const violatedVerdict: LockVerdict = {
  verdict: 'violated',
  violations: [
    { code: 'native_runner_on', detail: 'enableNativeRunner is true' },
    { code: 'non_http_agent', detail: 'Summarizer uses claude_local' },
  ],
};

describe('startupLockAction and enforceStartupLock', () => {
  beforeEach(() => __resetPaperclipLockForTest());

  it('clean proceeds, violated refuses, unknown latches', () => {
    expect(startupLockAction(cleanVerdict)).toBe('proceed');
    expect(startupLockAction(violatedVerdict)).toBe('refuse');
    expect(startupLockAction(unknownVerdict)).toBe('latch');
  });

  it('the lock is open until a gate has run (other code and every other test never see a closed latch)', () => {
    expect(getPaperclipLockState()).toEqual({ closed: false, code: null });
  });

  it('a violated verdict refuses to start: the promise rejects with a message that names every code, and does not retry', async () => {
    const read = vi.fn(async () => violatedVerdict);
    const sleep = vi.fn(async () => {});
    await expect(enforceStartupLock({ read, sleep })).rejects.toThrow(/^Refusing to start: Paperclip runtime lock violated/);
    await expect(enforceStartupLock({ read, sleep })).rejects.toThrow(/native_runner_on.*non_http_agent/s);
    expect(read).toHaveBeenCalledTimes(2); // once per enforce call
    expect(sleep).not.toHaveBeenCalled();
  });

  it('a clean verdict opens the latch and resolves with the verdict', async () => {
    const read = vi.fn(async () => cleanVerdict);
    await expect(enforceStartupLock({ read })).resolves.toEqual(cleanVerdict);
    expect(getPaperclipLockState()).toEqual({ closed: false, code: null });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('unknown is retried (default 3 attempts, the delay between them), and a later clean opens the latch', async () => {
    const reads: LockVerdict[] = [unknownVerdict, cleanVerdict];
    const read = vi.fn(async () => reads.shift() ?? cleanVerdict);
    const sleep = vi.fn(async () => {});
    await expect(enforceStartupLock({ read, sleep, retryDelayMs: 1234 })).resolves.toEqual(cleanVerdict);
    expect(read).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(1234);
    expect(getPaperclipLockState()).toEqual({ closed: false, code: null });
  });

  it('unknown on every attempt resolves (the process starts) and latches the surface closed with a readable code', async () => {
    const read = vi.fn(async () => unknownVerdict);
    const sleep = vi.fn(async () => {});
    await expect(enforceStartupLock({ read, sleep })).resolves.toEqual(unknownVerdict);
    expect(read).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(getPaperclipLockState()).toEqual({ closed: true, code: 'unknown:paperclip_unreachable' });
  });

  it('attempts is honoured', async () => {
    const read = vi.fn(async () => unknownVerdict);
    await enforceStartupLock({ read, sleep: async () => {}, attempts: 1 });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('a read that THROWS is treated as unknown, never as clean and never as a crash', async () => {
    const read = vi.fn(async (): Promise<LockVerdict> => {
      throw new Error('boom');
    });
    await expect(enforceStartupLock({ read, sleep: async () => {}, attempts: 1 })).resolves.toEqual({
      verdict: 'unknown',
      reason: 'paperclip_unreachable',
    });
    expect(getPaperclipLockState().closed).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. The 60 s re-check
// ─────────────────────────────────────────────────────────────────────────────
describe('startPaperclipLockWatcher: re-check every 60 s; the latch is closed unless the latest verdict is clean', () => {
  beforeEach(() => {
    __resetPaperclipLockForTest();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    __resetPaperclipLockForTest();
  });

  it('the interval is sixty seconds', () => {
    expect(PAPERCLIP_LOCK_RECHECK_MS).toBe(60_000);
  });

  it('latches closed after unknown, opens when a later read is clean, closes again on a later violation, names the codes', async () => {
    const reads: LockVerdict[] = [
      unknownVerdict,
      cleanVerdict,
      { verdict: 'violated', violations: [{ code: 'native_runner_on', detail: 'x' }, { code: 'remote_profile_present', detail: 'y' }] },
      cleanVerdict,
    ];
    const read = vi.fn(async () => reads.shift() ?? cleanVerdict);
    await enforceStartupLock({ read, attempts: 1, sleep: async () => {} }); // consumes the first (unknown)
    expect(getPaperclipLockState()).toEqual({ closed: true, code: 'unknown:paperclip_unreachable' });

    const watcher = startPaperclipLockWatcher({ read });
    await vi.advanceTimersByTimeAsync(PAPERCLIP_LOCK_RECHECK_MS);
    expect(getPaperclipLockState()).toEqual({ closed: false, code: null });
    await vi.advanceTimersByTimeAsync(PAPERCLIP_LOCK_RECHECK_MS);
    expect(getPaperclipLockState()).toEqual({ closed: true, code: 'violated:native_runner_on,remote_profile_present' });
    await vi.advanceTimersByTimeAsync(PAPERCLIP_LOCK_RECHECK_MS);
    expect(getPaperclipLockState()).toEqual({ closed: false, code: null });
    watcher.stop();
  });

  it('does not read before the interval has elapsed, and stop() ends the checks', async () => {
    const read = vi.fn(async () => cleanVerdict);
    const watcher = startPaperclipLockWatcher({ read });
    await vi.advanceTimersByTimeAsync(PAPERCLIP_LOCK_RECHECK_MS - 1);
    expect(read).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(1);
    watcher.stop();
    await vi.advanceTimersByTimeAsync(PAPERCLIP_LOCK_RECHECK_MS * 3);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('never runs two reads at once: a tick that finds a read still in flight is skipped', async () => {
    let release: (v: LockVerdict) => void = () => {};
    const read = vi.fn(
      () =>
        new Promise<LockVerdict>((resolve) => {
          release = resolve;
        }),
    );
    const watcher = startPaperclipLockWatcher({ read });
    await vi.advanceTimersByTimeAsync(PAPERCLIP_LOCK_RECHECK_MS);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(PAPERCLIP_LOCK_RECHECK_MS * 2);
    expect(read).toHaveBeenCalledTimes(1); // still waiting on the first
    release(cleanVerdict);
    await vi.advanceTimersByTimeAsync(PAPERCLIP_LOCK_RECHECK_MS);
    expect(read).toHaveBeenCalledTimes(2);
    watcher.stop();
  });

  it('a read that throws closes the latch as unknown and the watcher keeps going', async () => {
    const reads: Array<() => Promise<LockVerdict>> = [
      async () => {
        throw new Error('boom');
      },
      async () => cleanVerdict,
    ];
    const read = vi.fn(() => (reads.shift() ?? (async () => cleanVerdict))());
    const watcher = startPaperclipLockWatcher({ read });
    await vi.advanceTimersByTimeAsync(PAPERCLIP_LOCK_RECHECK_MS);
    expect(getPaperclipLockState()).toEqual({ closed: true, code: 'unknown:paperclip_unreachable' });
    await vi.advanceTimersByTimeAsync(PAPERCLIP_LOCK_RECHECK_MS);
    expect(getPaperclipLockState()).toEqual({ closed: false, code: null });
    watcher.stop();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. The closed latch really closes the two outbound Paperclip surfaces that live in src/lib/paperclip
//    (the inbound dispatch route is pinned in src/adapters/dashboard/paperclip-dispatch.private.test.ts)
// ─────────────────────────────────────────────────────────────────────────────
describe('the closed latch closes the Paperclip client and the reconciler', () => {
  beforeEach(() => {
    __resetPaperclipLockForTest();
    __resetPaperclipCompanyPin();
    __resetPaperclipReconcilerForTest();
  });
  afterEach(() => __resetPaperclipLockForTest());

  const latchClosedAsUnknown = () =>
    enforceStartupLock({ read: async () => unknownVerdict, attempts: 1, sleep: async () => {} });

  it('PaperclipClient refuses every request with PaperclipDisabledError naming the lock code, and makes no network call', async () => {
    await latchClosedAsUnknown();
    const fetchFn = vi.fn();
    const killSwitch = vi.fn(async () => ({ active: false }));
    const client = new PaperclipClient({
      baseUrl: BASE,
      companyId: COMPANY,
      agentKeys: { main: AGENT_KEY },
      fetchFn: fetchFn as unknown as typeof fetch,
      killSwitch: killSwitch as never,
    });
    const err = await client.listAgents().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PaperclipDisabledError);
    const text = JSON.stringify((err as PaperclipDisabledError).body);
    expect(text).toMatch(/lock/i);
    expect(text).toContain('unknown:paperclip_unreachable');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('control: with the latch open the same client reaches fetch', async () => {
    const fetchFn = vi.fn(async () => new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }));
    const client = new PaperclipClient({
      baseUrl: BASE,
      companyId: COMPANY,
      agentKeys: { main: AGENT_KEY },
      fetchFn: fetchFn as unknown as typeof fetch,
      killSwitch: (async () => ({ active: false })) as never,
    });
    await expect(client.listAgents()).resolves.toEqual([]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('the reconciler does no work while the latch is closed, even when forced: no client call, no lease', async () => {
    await latchClosedAsUnknown();
    const listIssues = vi.fn();
    const acquireLease = vi.fn(async () => true);
    const result = await runPaperclipReconcilePassOnce(
      { force: true },
      {
        getConfigFn: (async () => ({ reconciler_mode: 'live' })) as never,
        client: { listIssues } as unknown as PaperclipClient,
        acquireLease: acquireLease as never,
        now: () => 1_700_000_000_000,
      },
    );
    expect(result).toMatchObject({ ran: false, reason: 'lock-closed' });
    expect(listIssues).not.toHaveBeenCalled();
    expect(acquireLease).not.toHaveBeenCalled();
  });
});
