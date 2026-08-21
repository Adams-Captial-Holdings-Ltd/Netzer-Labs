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
import { describe, it, expect } from 'vitest';
import {
  RECONCILER_KEY_NAME,
  agentKeyName,
  agentSpecs,
  assertResponsibleUserAuthzUnset,
  createKey,
  ensureAgents,
  netzarAgentId,
  reconcileKey,
  type AgentKeyRecord,
  type AgentRecord,
  type PaperclipRequest,
} from './bootstrap-core.js';

const COMPANY = 'company-uuid';

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

    const first = await reconcileKey(request, main, agentKeyName('main'), 'main', undefined, false);
    expect(first.action).toBe('created');
    expect(first.scope).toBe('standard');
    const stored = first.token;
    const afterFirst = calls.length;

    // Second run: the key is active on Paperclip AND its token is held here.
    const second = await reconcileKey(request, main, agentKeyName('main'), 'main', stored, false);
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
    await reconcileKey(request, main, agentKeyName('main'), 'main', undefined, false);
    const afterFirst = calls.length;

    const replaced = await reconcileKey(request, main, agentKeyName('main'), 'main', undefined, false);
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
        false,
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
        false,
      ),
    ).rejects.toThrow(/no responsible user/);
  });

  it('creates nothing at all in --dry-run', async () => {
    const { request, calls } = fakePaperclip();
    const { agents } = await ensureAgents(request, COMPANY, SPECS);
    const afterAgents = calls.length;
    const outcome = await reconcileKey(
      request,
      agents.get('main')!,
      agentKeyName('main'),
      'main',
      undefined,
      true,
    );
    expect(outcome.token).toBeUndefined();
    expect(calls.slice(afterAgents).filter((c) => c.method !== 'GET')).toEqual([]);
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
      false,
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
