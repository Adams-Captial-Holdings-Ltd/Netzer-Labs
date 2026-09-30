/**
 * The Phase 4 bootstrap acceptance list, as tests.
 *
 * The bar asks for five properties of `scripts/paperclip-bootstrap.ts` and
 * every one of them is a property of the protocol layer this file exercises:
 * re-running is a PROVABLE no-op (zero new agents, zero new keys), `main`
 * holds role `ceo`, every agent carries `metadata.netzarAgentId`,
 * `PAPERCLIP_RESPONSIBLE_USER_AUTHZ_MODE` is asserted unset, and no token is
 * ever printed.
 *
 * The transport is faked, not mocked: `fakePaperclip` is a tiny in-memory
 * Paperclip that RECORDS every request. That is what makes "zero POSTs on the
 * second run" an assertion about behaviour rather than about a spy call count
 * — the same run, run twice, against state that persisted between them.
 *
 * A1-16: the routes and payload shapes here were established by probe against
 * the pinned artifact (see `tests/contract/`), never by reading Paperclip
 * source. Nothing in this file cites a Paperclip line number.
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect, vi } from 'vitest';
import {
  LOCK_AUDITOR_KEY_FIELD,
  RECONCILER_KEY_NAME,
  agentKeyName,
  agentSpecs,
  assertResponsibleUserAuthzUnset,
  createKey,
  ensureAgents,
  netzarAgentId,
  parseDispatchSlugs,
  reconcileKey,
  type AgentKeyRecord,
  type AgentRecord,
  type PaperclipRequest,
  assertPrivateDispatchUrl,
  ensureNativeRunnerOff,
  ensureLockAuditor,
  lockVerdictProblem,
} from './bootstrap-core.js';

const COMPANY = 'company-uuid';

describe('runtime lock bootstrap', () => {
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

  it('keeps the lock auditor secret field name in sync', () => {
    // Deploy phases seed, the orchestrator task injects, and the orchestrator reads this same name.
    expect(LOCK_AUDITOR_KEY_FIELD).toBe('lock_auditor_key');
  });

  it('accepts a private dispatch url and rejects unsafe dispatch url values', () => {
    for (const host of ['orchestrator.claudeclaw-dispatch.internal', '10.0.4.7']) {
      expect(() => assertPrivateDispatchUrl(`http://${host}:3001/api/paperclip/dispatch`)).not.toThrow();
    }
    for (const value of [
      'https://10.0.4.7:3001/api/paperclip/dispatch',
      'http://example.com:3001/api/paperclip/dispatch',
      'http://10.0.4.7:3002/api/paperclip/dispatch',
      'http://10.0.4.7:3001/wrong',
      'http://10.0.4.7:3001/api/paperclip/dispatch?q=1',
      'http://user:password@10.0.4.7:3001/api/paperclip/dispatch',
      'http://internal:3001/api/paperclip/dispatch',
    ]) {
      expect(() => assertPrivateDispatchUrl(value)).toThrow(/PAPERCLIP_DISPATCH_URL.*private.*public address/);
    }
  });

  it('leaves an already disabled enableNativeRunner alone, then patches and verifies false', async () => {
    let enabled = false;
    const calls: Recorded[] = [];
    const request: PaperclipRequest = async (path, init = {}) => {
      calls.push({ pathname: path, method: init.method ?? 'GET', body: init.body });
      if (init.method === 'PATCH') enabled = false;
      return json({ enableNativeRunner: enabled });
    };
    expect(await ensureNativeRunnerOff(request)).toBe('already-off');
    expect(calls.map((c) => c.method)).toEqual(['GET']);
    enabled = true;
    calls.length = 0;
    expect(await ensureNativeRunnerOff(request)).toBe('turned-off');
    expect(calls.map((c) => c.method)).toEqual(['GET', 'PATCH', 'GET']);
    expect(JSON.parse(String(calls[1].body))).toEqual({ enableNativeRunner: false });
  });

  it('rejects an old pin whose enableNativeRunner PATCH does not stick', async () => {
    const request: PaperclipRequest = async () => json({});
    await expect(ensureNativeRunnerOff(request)).rejects.toThrow(/no enableNativeRunner.*v2026\.916\.1/);
  });

  it('creates a viewer auditor through sign-up, board-api-keys and company-access', async () => {
    const calls: Recorded[] = [];
    const key = 'fake-minted-key';
    const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, pathname: path, body });
      if (path === '/api/auth/sign-up/email') return json({}, 201);
      if (path === '/api/auth/profile') return json({});
      if (path === '/api/board-api-keys') return json({ token: key }, 201);
      if (path === '/api/cli-auth/me') {
        if (new Headers(init?.headers).get('authorization') === 'Bearer fake-stale-key') return json({}, 401);
        return json({ userId: 'auditor-user', companyIds: [COMPANY], isInstanceAdmin: false });
      }
      throw new Error(`Unexpected ${path}`);
    }) as typeof fetch;
    vi.stubGlobal('fetch', fetchFn);
    try {
      const request: PaperclipRequest = async (path, init = {}) => {
        calls.push({ method: init.method ?? 'GET', pathname: path, body: init.body ? JSON.parse(String(init.body)) : undefined });
        if (path.endsWith('/members')) return json({ members: [{ id: 'member-1', principalId: 'auditor-user' }] });
        return json(path.endsWith('/member-1') ? { membershipRole: 'viewer' } : {});
      };
      expect(await ensureLockAuditor({ request, companyId: COMPANY, baseUrl: 'http://paperclip.internal', storedKey: 'fake-stale-key', fetchFn, randomBytesFn: () => Buffer.alloc(32, 7) })).toEqual({ action: 'created', key });
      expect(calls.map((c) => `${c.method} ${c.pathname}`)).toContain('POST /api/auth/sign-up/email');
      expect(calls.map((c) => `${c.method} ${c.pathname}`)).toContain('PATCH /api/auth/profile');
      expect(calls.map((c) => `${c.method} ${c.pathname}`)).toContain('POST /api/board-api-keys');
      expect(calls.map((c) => `${c.method} ${c.pathname}`)).toContain(`PUT /api/admin/users/auditor-user/company-access`);
      const createdInOrder = [
        'POST /api/auth/sign-up/email',
        'PATCH /api/auth/profile',
        'POST /api/board-api-keys',
        `PUT /api/admin/users/auditor-user/company-access`,
        `PATCH /api/companies/${COMPANY}/members/member-1`,
      ].map((call) => calls.findIndex((c) => `${c.method} ${c.pathname}` === call));
      expect(createdInOrder).toEqual([...createdInOrder].sort((a, b) => a - b));
      expect(createdInOrder.every((index) => index >= 0)).toBe(true);
      expect(calls.find((c) => c.pathname.endsWith('/member-1'))?.body).toEqual({ membershipRole: 'viewer' });
      expect(calls.find((c) => c.pathname === '/api/board-api-keys')?.body).toEqual({ name: 'netzer-lock-auditor', expiresAt: null });
      const signup = calls.find((c) => c.pathname === '/api/auth/sign-up/email')?.body as { email: string; password: string };
      expect(signup.email).toMatch(/@netzer\.invalid$/);
      expect(signup.password).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(calls.filter((c) => c.pathname !== '/api/auth/sign-up/email'))).not.toContain(signup.password);
      expect(JSON.stringify(calls)).not.toContain(key);
    } finally { vi.unstubAllGlobals(); }
  });

  it.each(['', 'REPLACE_ME'])('creates an auditor for absent stored key %j', async (storedKey) => {
    const calls: string[] = [];
    const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      calls.push(`${init?.method ?? 'GET'} ${path}`);
      if (path === '/api/board-api-keys') return json({ token: 'fake-minted-key' }, 201);
      if (path === '/api/cli-auth/me') return json({ userId: 'auditor-user', companyIds: [COMPANY], isInstanceAdmin: false });
      return json({});
    }) as typeof fetch;
    vi.stubGlobal('fetch', fetchFn);
    try {
      const request: PaperclipRequest = async (path) => path.endsWith('/members')
        ? json({ members: [{ id: 'member-1', principalId: 'auditor-user' }] })
        : json({ membershipRole: 'viewer' });
      expect(await ensureLockAuditor({ request, companyId: COMPANY, baseUrl: 'http://paperclip.internal', storedKey, fetchFn, randomBytesFn: () => Buffer.alloc(32, 7) })).toEqual({ action: 'created', key: 'fake-minted-key' });
      expect(calls[0]).toBe('POST /api/auth/sign-up/email');
      expect(calls.filter((call) => call === 'GET /api/cli-auth/me')).toHaveLength(2);
    } finally { vi.unstubAllGlobals(); }
  });

  it('reuses a valid key without writes and rejects an admin key', async () => {
    const calls: Recorded[] = [];
    let admin = false;
    const fetchFn = vi.fn(async () => json({ userId: 'auditor-user', companyIds: [COMPANY], isInstanceAdmin: admin })) as typeof fetch;
    const request: PaperclipRequest = async (path, init = {}) => { calls.push({ pathname: path, method: init.method ?? 'GET', body: undefined }); return json({}); };
    const opts = { request, companyId: COMPANY, baseUrl: 'http://paperclip.internal', storedKey: 'fake-stored-key', fetchFn };
    expect(await ensureLockAuditor(opts)).toEqual({ action: 'reused' });
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([]);
    admin = true;
    await expect(ensureLockAuditor(opts)).rejects.toThrow(/administrator/);
    await expect(ensureLockAuditor(opts)).rejects.not.toThrow(/fake-stored-key/);
  });

  it('explains clean, unknown, and non_http_agent violations', () => {
    expect(lockVerdictProblem({ verdict: 'clean' })).toBeUndefined();
    expect(lockVerdictProblem({ verdict: 'unknown', reason: 'auditor_key_rejected' })).toMatch(/auditor_key_rejected.*could not read Paperclip/);
    expect(lockVerdictProblem({ verdict: 'violated', violations: [{ code: 'non_http_agent', detail: 'worker uses process' }] })).toMatch(/non_http_agent.*worker uses process.*never deletes agents.*refuse to start/);
  });
});

interface Recorded {
  method: string;
  pathname: string;
  body: unknown;
}

/**
 * An in-memory Paperclip holding just the agent and key state the bootstrap
 * touches. Returns a request function plus the call log, so a test can assert
 * on what was SENT, not only on what came back.
 */
function fakePaperclip(): { request: PaperclipRequest; calls: Recorded[] } {
  const agents: AgentRecord[] = [];
  const keys = new Map<string, AgentKeyRecord[]>();
  const calls: Recorded[] = [];
  let nextId = 1;

  const request: PaperclipRequest = async (pathname, init = {}) => {
    const method = (init.method ?? 'GET').toUpperCase();
    const body = init.body === undefined ? undefined : JSON.parse(String(init.body));
    calls.push({ method, pathname, body });
    const json = (value: unknown, status = 200): Response =>
      new Response(JSON.stringify(value), {
        status,
        headers: { 'content-type': 'application/json' },
      });

    const agentList = /^\/api\/companies\/[^/]+\/agents$/.exec(pathname);
    if (agentList && method === 'GET') return json(agents);
    if (agentList && method === 'POST') {
      const created: AgentRecord = {
        id: `agent-${nextId++}`,
        name: String((body as { name: string }).name),
        role: String((body as { role: string }).role),
        status: 'active',
        reportsTo: ((body as { reportsTo: string | null }).reportsTo ?? null) as string | null,
        adapterType: 'http',
        adapterConfig: (body as { adapterConfig: AgentRecord['adapterConfig'] }).adapterConfig,
        metadata: (body as { metadata: Record<string, unknown> }).metadata,
      };
      agents.push(created);
      return json(created);
    }

    // PATCH /api/agents/{id} — the adapter reconcile route. Declared by the
    // pinned OpenAPI snapshot (tests/contract/openapi.snapshot.json), which is
    // where this fake gets its shape from; see the note on ensureAgents.
    const agentItem = /^\/api\/agents\/([^/]+)$/.exec(pathname);
    if (agentItem && method === 'PATCH') {
      const agent = agents.find((a) => a.id === agentItem[1]);
      if (!agent) return json({ error: 'agent not found' }, 404);
      const patch = body as { adapterConfig?: AgentRecord['adapterConfig'] };
      if (patch.adapterConfig !== undefined) agent.adapterConfig = patch.adapterConfig;
      return json(agent);
    }

    const keyList = /^\/api\/agents\/([^/]+)\/keys$/.exec(pathname);
    if (keyList && method === 'GET') return json(keys.get(keyList[1]) ?? []);
    if (keyList && method === 'POST') {
      const record: AgentKeyRecord = {
        id: `key-${nextId++}`,
        name: String((body as { name: string }).name),
        scope: (body as { scope: { kind: string } }).scope,
        responsibleUserId: 'operator-uuid',
        revokedAt: null,
        // Paperclip reveals the token exactly once, at creation.
        token: `pcp_${nextId}_secrettoken`,
      };
      keys.set(keyList[1], [...(keys.get(keyList[1]) ?? []), record]);
      return json(record);
    }

    const keyItem = /^\/api\/agents\/([^/]+)\/keys\/([^/]+)$/.exec(pathname);
    if (keyItem && method === 'DELETE') {
      keys.set(
        keyItem[1],
        (keys.get(keyItem[1]) ?? []).map((k) =>
          k.id === keyItem[2] ? { ...k, revokedAt: new Date().toISOString() } : k,
        ),
      );
      return json({});
    }
    throw new Error(`fakePaperclip has no route for ${method} ${pathname}`);
  };

  return { request, calls };
}

const SPECS = agentSpecs({
  slugs: ['main', 'research'],
  dispatchUrl: 'https://netzar.example/api/paperclip/dispatch',
  dispatchSecret: 'dispatch-secret-value',
});

describe('the org chart the recovery ladder depends on', () => {
  it("gives `main` the role `ceo`, and every other agent reports to it", () => {
    // Paperclip's recovery ladder is the only computed routing it has:
    // assignee.reportsTo -> creator.reportsTo -> role 'cto' -> role 'ceo'.
    // An org with no `ceo` has no terminal escalation target, so a stuck
    // issue escalates to nobody and simply stops.
    const main = SPECS.find((s) => s.slug === 'main')!;
    expect(main.role).toBe('ceo');
    expect(main.reportsToSlug).toBeNull();
    for (const spec of SPECS.filter((s) => s.slug !== 'main')) {
      expect(spec.role).toBe('general');
      expect(spec.reportsToSlug).toBe('main');
    }
  });

  it('refuses a slug list without `main`', () => {
    expect(() =>
      agentSpecs({ slugs: ['research'], dispatchUrl: 'https://x', dispatchSecret: 's' }),
    ).toThrow(/must include 'main'/);
  });

  it('embeds the REAL dispatch secret, never a placeholder string', () => {
    // Paperclip does no interpolation on adapter_config, so a `${VAR}` here
    // would be sent verbatim as the bearer and every dispatch would 401.
    const headers = SPECS[0].adapterConfig.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer dispatch-secret-value');
    expect(JSON.stringify(SPECS)).not.toMatch(/\$\{/);
  });
});

describe('agent provisioning', () => {
  it('stamps metadata.netzarAgentId on every agent it creates, and reads it back', async () => {
    // The join key between the two systems, and the ONLY thing idempotence
    // keys on. An agent recognized by display name instead would be
    // duplicated by a rename.
    const { request, calls } = fakePaperclip();
    const first = await ensureAgents(request, COMPANY, SPECS);
    expect(first.created).toEqual(['main', 'research']);
    const posted = calls.filter((c) => c.method === 'POST');
    expect(posted).toHaveLength(2);
    for (const call of posted) {
      const meta = (call.body as { metadata: Record<string, unknown> }).metadata;
      expect(typeof meta.netzarAgentId).toBe('string');
    }
    // ...and the round trip: what comes back is keyed by the same id.
    for (const slug of ['main', 'research']) {
      expect(netzarAgentId(first.agents.get(slug)!)).toBe(slug);
    }
  });

  it('creates the manager before its report, so reportsTo can resolve', async () => {
    const { request } = fakePaperclip();
    const { agents } = await ensureAgents(request, COMPANY, SPECS);
    expect(agents.get('research')!.reportsTo).toBe(agents.get('main')!.id);
    expect(agents.get('main')!.reportsTo).toBeNull();
  });

  it('is a PROVABLE no-op on the second run: zero new agents, zero POSTs', async () => {
    // The acceptance item, stated as behaviour rather than as intent. Same
    // fake instance, same specs, run twice.
    const { request, calls } = fakePaperclip();
    await ensureAgents(request, COMPANY, SPECS);
    const afterFirst = calls.length;

    const second = await ensureAgents(request, COMPANY, SPECS);
    expect(second.created).toEqual([]);
    expect(second.agents.size).toBe(2);
    const secondRunCalls = calls.slice(afterFirst);
    expect(secondRunCalls.filter((c) => c.method !== 'GET')).toEqual([]);
  });
});

describe('API keys', () => {
  it('mints every key with STANDARD scope, never task_bridge', async () => {
    // A1-9, by probe: a task_bridge key is hard-403d on the company-wide
    // issue list with "Task bridge keys cannot use company-wide issue list
    // APIs", which silently breaks the reconciler instead of failing loudly.
    const { request, calls } = fakePaperclip();
    const { agents } = await ensureAgents(request, COMPANY, SPECS);
    await createKey(request, agents.get('main')!.id, RECONCILER_KEY_NAME);
    const post = calls.filter((c) => /\/keys$/.test(c.pathname) && c.method === 'POST').pop()!;
    expect(post.body).toEqual({ name: RECONCILER_KEY_NAME, scope: { kind: 'standard' } });
  });

  it('is a PROVABLE no-op on the second run: zero new keys, zero POSTs', async () => {
    const { request, calls } = fakePaperclip();
    const { agents } = await ensureAgents(request, COMPANY, SPECS);
    const main = agents.get('main')!;

    const first = await reconcileKey(request, main, agentKeyName('main'), 'main', undefined);
    expect(first.action).toBe('created');
    expect(first.scope).toBe('standard');
    const stored = first.token;
    const afterFirst = calls.length;

    // Second run: the key is active on Paperclip AND its token is held here.
    const second = await reconcileKey(request, main, agentKeyName('main'), 'main', stored);
    expect(second.action).toBe('reused');
    expect(second.token).toBeUndefined();
    expect(second.keyId).toBe(first.keyId);
    expect(calls.slice(afterFirst).filter((c) => c.method !== 'GET')).toEqual([]);
  });

  it('revokes and re-mints a key whose token we do not hold', async () => {
    // Paperclip stores only the SHA of a token, so a key active there whose
    // token is not in Secrets Manager is UNUSABLE. Leaving it looks like
    // working credentials; revoking it is the honest state.
    const { request, calls } = fakePaperclip();
    const { agents } = await ensureAgents(request, COMPANY, SPECS);
    const main = agents.get('main')!;
    await reconcileKey(request, main, agentKeyName('main'), 'main', undefined);
    const afterFirst = calls.length;

    const replaced = await reconcileKey(request, main, agentKeyName('main'), 'main', undefined);
    expect(replaced.action).toBe('replaced');
    expect(calls.slice(afterFirst).some((c) => c.method === 'DELETE')).toBe(true);
  });

  it('refuses to reuse a key that is not standard-scoped or has no responsible user', async () => {
    const notStandard: AgentRecord = {
      id: 'agent-x',
      name: 'x',
      role: 'ceo',
      status: 'active',
      reportsTo: null,
      adapterType: 'http',
      adapterConfig: null,
      metadata: { netzarAgentId: 'main' },
    };
    const listing = (records: AgentKeyRecord[]): PaperclipRequest => async () =>
      new Response(JSON.stringify(records), { headers: { 'content-type': 'application/json' } });

    await expect(
      reconcileKey(
        listing([
          { id: 'k', name: agentKeyName('main'), scope: { kind: 'task_bridge' }, responsibleUserId: 'u' },
        ]),
        notStandard,
        agentKeyName('main'),
        'main',
        'pcp_held',
      ),
    ).rejects.toThrow(/task_bridge/);

    await expect(
      reconcileKey(
        listing([
          { id: 'k', name: agentKeyName('main'), scope: { kind: 'standard' }, responsibleUserId: null },
        ]),
        notStandard,
        agentKeyName('main'),
        'main',
        'pcp_held',
      ),
    ).rejects.toThrow(/no responsible user/);
  });

});

describe('no token ever printed', () => {
  it('keeps the minted token out of every string the caller prints', async () => {
    // What the bootstrap prints is `${mark} ${keyName} id=${keyId}
    // scope=${scope}`. The token is carried on a SEPARATE field that goes
    // straight to Secrets Manager, so this asserts the printed fields cannot
    // contain it even by accident.
    const { request } = fakePaperclip();
    const { agents } = await ensureAgents(request, COMPANY, SPECS);
    const outcome = await reconcileKey(
      request,
      agents.get('main')!,
      agentKeyName('main'),
      'main',
      undefined,
    );
    expect(outcome.token).toMatch(/^pcp_/);
    const printed = `${outcome.keyName} id=${outcome.keyId} scope=${outcome.scope}`;
    expect(printed).not.toContain(outcome.token!);
  });

  it('never logs a token from inside the protocol layer', () => {
    // The one call that ever sees a token is createKey(). Grep the module
    // rather than trusting the reviewer: a console.log added later would slip
    // past every behavioural test above.
    const source = readFileSync(new URL('./bootstrap-core.ts', import.meta.url), 'utf-8');
    expect(source).not.toMatch(/console\./);
  });
});

describe('PAPERCLIP_RESPONSIBLE_USER_AUTHZ_MODE', () => {
  it('is asserted unset, because responsibleUserId is the only human accountability', () => {
    expect(() => assertResponsibleUserAuthzUnset({})).not.toThrow();
    expect(() =>
      assertResponsibleUserAuthzUnset({ PAPERCLIP_RESPONSIBLE_USER_AUTHZ_MODE: 'relaxed' }),
    ).toThrow(/PAPERCLIP_RESPONSIBLE_USER_AUTHZ_MODE is set/);
  });
});

describe('Phase 6: exactly one agent is pointed at the dispatch route', () => {
  it('gives a url to `main` only, so the first install dispatches for ONE actor', () => {
    const withUrl = SPECS.filter((s) => typeof s.adapterConfig.url === 'string');
    expect(withUrl).toHaveLength(1);
    expect(withUrl[0].slug).toBe('main');
    expect(withUrl[0].adapterConfig.url).toBe('https://netzar.example/api/paperclip/dispatch');
  });

  it('leaves an un-armed agent with no url AND no second plaintext copy of the secret', () => {
    const research = SPECS.find((s) => s.slug === 'research')!;
    expect(research.adapterConfig.url).toBeUndefined();
    expect(research.adapterConfig.headers).toBeUndefined();
    expect(JSON.stringify(research)).not.toContain('dispatch-secret-value');
  });

  it('arms a different set on request, and blanking the url is the rollback', () => {
    // ROLLBACK IS AN ENV EDIT PLUS A RE-RUN, NOT A DEPLOY: an adapter row with
    // no url has nothing for Paperclip to POST to, and since P0-2b-2
    // `ensureAgents` applies that state to an ALREADY-CREATED agent too (the
    // drift tests above). What is shown HERE is only that the spec builder can
    // produce either state; that the PATCH is accepted by a LIVE Paperclip is
    // still unproven — no probe in the 21-probe set drives
    // `PATCH /api/agents/{id}`.
    const armed = agentSpecs({
      slugs: ['main', 'research'],
      dispatchUrl: 'https://netzar.example/api/paperclip/dispatch',
      dispatchSecret: 'dispatch-secret-value',
      dispatchSlugs: [],
    });
    expect(armed.filter((s) => typeof s.adapterConfig.url === 'string')).toHaveLength(0);
  });
});


describe('adapter_config drift is reconciled, not left behind', () => {
  // P0-2b-2. Measured on staging 2026-09-06: the `research` agent record held
  // adapterConfig keys [method, payloadTemplate, timeoutMs] and NO url, so
  // Paperclip logged `HTTP adapter missing url` and escalated every
  // research-assigned issue to Main. The bootstrap had created that agent on a
  // run whose spec carried no url and never revisited it.
  const DISPATCH_URL = 'https://netzar.example/api/paperclip/dispatch';
  const specsFor = (dispatchSlugs: string[]) =>
    agentSpecs({
      slugs: ['main', 'research'],
      dispatchUrl: DISPATCH_URL,
      dispatchSecret: 'dispatch-secret-value',
      dispatchSlugs,
    });

  it('PATCHes the drifted agent exactly once, with exactly {adapterConfig}', async () => {
    const { request, calls } = fakePaperclip();
    const first = await ensureAgents(request, COMPANY, specsFor(['main']));
    expect(first.created).toEqual(['main', 'research']);
    expect(first.updated).toEqual([]);
    const researchId = first.agents.get('research')!.id;
    const afterFirst = calls.length;

    const armed = specsFor(['main', 'research']);
    const second = await ensureAgents(request, COMPANY, armed);

    // The request log, not a spy count: one write, and it is the PATCH.
    expect(calls.slice(afterFirst).filter((c) => c.method !== 'GET')).toEqual([
      {
        method: 'PATCH',
        pathname: `/api/agents/${researchId}`,
        body: { adapterConfig: armed.find((s) => s.slug === 'research')!.adapterConfig },
      },
    ]);
    expect(second.created).toEqual([]);
    expect(second.updated).toEqual(['research']);
  });

  it('is a PROVABLE no-op when the live adapter_config already matches: zero PATCHes', async () => {
    // The 2026-09-03 contract ("agents created 0, reused 2 ... nothing
    // written") survives the new reconcile: a converged run still writes
    // nothing at all.
    const { request, calls } = fakePaperclip();
    await ensureAgents(request, COMPANY, SPECS);
    const afterFirst = calls.length;

    const second = await ensureAgents(request, COMPANY, SPECS);
    expect(second.created).toEqual([]);
    expect(second.updated).toEqual([]);
    expect(calls.slice(afterFirst).filter((c) => c.method !== 'GET')).toEqual([]);
  });

  it('creates a missing agent, and never PATCHes the agent it just created', async () => {
    const { request, calls } = fakePaperclip();
    const result = await ensureAgents(request, COMPANY, SPECS);
    expect(result.created).toEqual(['main', 'research']);
    expect(result.updated).toEqual([]);
    expect(calls.filter((c) => c.method === 'PATCH')).toEqual([]);
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(2);
  });

  it('compares by VALUE, not by key order: Paperclip stores adapter_config as jsonb', async () => {
    // jsonb does not preserve object key order, so a byte comparison of
    // JSON.stringify would PATCH on every run forever and turn the no-op
    // contract into a write loop.
    const { request, calls } = fakePaperclip();
    const first = await ensureAgents(request, COMPANY, SPECS);
    const research = SPECS.find((s) => s.slug === 'research')!;
    const reordered = Object.fromEntries(Object.entries(research.adapterConfig).reverse());
    expect(Object.keys(reordered)).not.toEqual(Object.keys(research.adapterConfig));
    await request(`/api/agents/${first.agents.get('research')!.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ adapterConfig: reordered }),
    });
    const afterSetup = calls.length;

    const second = await ensureAgents(request, COMPANY, SPECS);
    expect(second.updated).toEqual([]);
    expect(calls.slice(afterSetup).filter((c) => c.method !== 'GET')).toEqual([]);
  });
});

describe('PAPERCLIP_DISPATCH_SLUGS decides which agents are armed', () => {
  const armedSlugs = (value: string | undefined): string[] =>
    agentSpecs({
      slugs: ['main', 'research'],
      dispatchUrl: 'https://netzar.example/api/paperclip/dispatch',
      dispatchSecret: 'dispatch-secret-value',
      dispatchSlugs: parseDispatchSlugs(value),
    })
      .filter((s) => typeof s.adapterConfig.url === 'string')
      .map((s) => s.slug);

  it('arms `research` only when it is listed', () => {
    expect(armedSlugs(undefined)).toEqual(['main']);
    expect(armedSlugs('')).toEqual(['main']);
    expect(armedSlugs('main,research')).toEqual(['main', 'research']);
    expect(armedSlugs(' research , main ')).toEqual(['main', 'research']);
  });

  it('keeps `main` armed whatever the variable says', () => {
    // `main` is the ceo, the actor the reconciler key belongs to and the
    // terminal of Paperclip's escalation ladder. A typo that silently
    // disarmed it would stop every dispatch with no error anywhere.
    expect(parseDispatchSlugs(undefined)).toEqual(['main']);
    expect(parseDispatchSlugs('research')).toEqual(['main', 'research']);
    expect(parseDispatchSlugs('main,main')).toEqual(['main']);
    expect(armedSlugs('research')).toEqual(['main', 'research']);
  });
});
