/**
 * Paperclip tenant bootstrap — the transport-agnostic half.
 *
 * ONE implementation of every Paperclip call the bootstrap makes, shared by
 * the two callers that need it:
 *
 *  - `tests/fixtures/paperclip-bootstrap.ts` — the local docker harness. It
 *    adds the docker-exec pieces (onboard, `auth bootstrap-ceo`, the
 *    /dev/shm credential cache) and its own, deliberately paranoid,
 *    assertions about a DISPOSABLE stack.
 *  - `scripts/paperclip-bootstrap.ts` — the deployed instance. It adds a
 *    Secrets Manager credential store and an email/password sign-in.
 *
 * The two differ in transport and in policy, not in protocol, so what lives
 * here is exactly the protocol: how a board session is held, how a company,
 * an agent and an API key are read and created. Everything opinionated —
 * "there must be exactly two agents", "an unexpected active key is a
 * failure" — stays with the caller that holds that opinion, because the
 * harness's opinions would be wrong on a real tenant and vice versa.
 *
 * Route facts here were established BY PROBE against the pinned artifact
 * (see `tests/contract/`), never transcribed from a source read: per A1-16 no
 * Paperclip line number is authority anywhere in this integration.
 *
 * NO TOKEN IS EVER LOGGED by anything in this file. Minting an API key is the
 * one call that returns a bearer token, and it is returned to the caller and
 * nowhere else.
 */

/** A board-session-bound request. The caller owns cookies and base URL. */
export type PaperclipRequest = (pathname: string, init?: RequestInit) => Promise<Response>;

export interface CompanyRecord {
  id: string;
  name: string;
  issuePrefix: string;
  requireBoardApprovalForNewAgents: boolean;
}

export interface AgentRecord {
  id: string;
  name: string;
  role: string;
  status: string;
  reportsTo: string | null;
  adapterType: string;
  adapterConfig: {
    url?: string;
    payloadTemplate?: Record<string, unknown>;
  } | null;
  metadata: Record<string, unknown> | null;
}

export interface AgentKeyRecord {
  id: string;
  name: string;
  scope?: { kind?: string };
  responsibleUserId?: string | null;
  revokedAt?: string | null;
  /** Returned ONCE, at creation. Never persisted by this module. */
  token?: string;
}

/** What one Netzar agent looks like on the Paperclip side. */
export interface AgentSpec {
  /** The Netzar agent id. Becomes `metadata.netzarAgentId`, the join key. */
  slug: string;
  name: string;
  /** Paperclip role. `main` is `ceo`; everything else is `general`. */
  role: string;
  /** Netzar slug of the manager, or null for the top of the chart. */
  reportsToSlug: string | null;
  /** `adapterType` is always "http": Paperclip calls Netzar, never the reverse. */
  adapterConfig: Record<string, unknown>;
}

/** Name of the single company-wide reconciler key (A1-9: STANDARD scope). */
export const RECONCILER_KEY_NAME = 'netzar-reconciler';

/** Per-agent key name. Deterministic, so a re-run recognizes its own work. */
export function agentKeyName(slug: string): string {
  return `netzar-agent-${slug}`;
}

/**
 * Cookie jar for Better Auth sessions.
 *
 * Paperclip's board plane is COOKIE-based (Better Auth), disjoint from
 * Netzar's opaque bearer tokens. Only key administration needs a board
 * session — no agent key can mint another — so this is confined to bootstrap.
 */
export class CookieJar {
  readonly #cookies = new Map<string, string>();

  capture(response: Response): void {
    const cookieHeaders = response.headers as Headers & { getSetCookie?: () => string[] };
    const values =
      cookieHeaders.getSetCookie?.() ??
      (response.headers.get('set-cookie') ? [response.headers.get('set-cookie') as string] : []);
    for (const value of values) {
      const pair = value.split(';', 1)[0];
      const separator = pair.indexOf('=');
      if (separator > 0) this.#cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
  }

  header(): string {
    return [...this.#cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }
}

/**
 * Build a session-bound request function.
 *
 * `origin` is set on every call because `boardMutationGuard` refuses board
 * mutations from an untrusted browser origin; sending the base URL as the
 * origin is what makes these calls look like the board talking to itself.
 */
export function makeBoardRequest(baseUrl: string, jar: CookieJar): PaperclipRequest {
  return async (pathname, init = {}) => {
    const headers = new Headers(init.headers);
    headers.set('origin', baseUrl);
    if (init.body !== undefined) headers.set('content-type', 'application/json');
    const cookie = jar.header();
    if (cookie) headers.set('cookie', cookie);
    const response = await fetch(`${baseUrl}${pathname}`, { ...init, headers });
    jar.capture(response);
    return response;
  };
}

/**
 * Parse a JSON body, or throw naming the operation.
 *
 * A1-4: the human string is always on `error`, never `message` or `detail`,
 * and many in-route errors carry no `code` at all — so the message is read
 * defensively and the status is always included.
 */
export async function jsonResponse<T>(response: Response, operation: string): Promise<T> {
  if (!response.ok) {
    const detail = (await response.json().catch(() => null)) as { error?: unknown } | null;
    const suffix = typeof detail?.error === 'string' ? `: ${detail.error}` : '';
    throw new Error(`${operation} returned HTTP ${response.status}${suffix}`);
  }
  try {
    return (await response.json()) as T;
  } catch {
    throw new Error(`${operation} returned invalid JSON`);
  }
}

/** Sign up the responsible user, falling back to sign-in when it exists. */
export async function signUpOrSignIn(
  request: PaperclipRequest,
  user: { name: string; email: string; password: string },
): Promise<void> {
  const signup = await request('/api/auth/sign-up/email', {
    method: 'POST',
    body: JSON.stringify(user),
  });
  if (signup.ok) return;
  const signin = await request('/api/auth/sign-in/email', {
    method: 'POST',
    body: JSON.stringify({ email: user.email, password: user.password }),
  });
  if (!signin.ok) {
    throw new Error(`Paperclip sign-in returned HTTP ${signin.status}`);
  }
}

export async function listCompanies(request: PaperclipRequest): Promise<CompanyRecord[]> {
  return jsonResponse<CompanyRecord[]>(await request('/api/companies'), 'Paperclip company list');
}

/**
 * Exactly one company, created once and thereafter only renamed.
 *
 * `issuePrefix` is derived by Paperclip from the FIRST name it is created
 * with and is not changed by a later rename — which is why the create name
 * and the display name are separate arguments.
 */
export async function ensureCompany(
  request: PaperclipRequest,
  opts: { createName: string; displayName: string },
): Promise<CompanyRecord> {
  const listed = await listCompanies(request);
  if (listed.length > 1) {
    throw new Error('Paperclip bootstrap requires exactly one company; found several');
  }
  let company = listed[0];
  if (!company) {
    company = await jsonResponse<CompanyRecord>(
      await request('/api/companies', {
        method: 'POST',
        body: JSON.stringify({ name: opts.createName }),
      }),
      'Paperclip company creation',
    );
  }
  if (
    company.name !== opts.displayName ||
    company.requireBoardApprovalForNewAgents !== false
  ) {
    company = await jsonResponse<CompanyRecord>(
      await request(`/api/companies/${company.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: opts.displayName,
          // Agents are created by this script, not approved by a human in the
          // board; leaving this on makes the bootstrap hang on a click.
          requireBoardApprovalForNewAgents: false,
        }),
      }),
      'Paperclip company update',
    );
  }
  return company;
}

/** The join key between the two systems. Netzar slug, on Paperclip metadata. */
export function netzarAgentId(agent: AgentRecord): string | undefined {
  const value = agent.metadata?.netzarAgentId;
  return typeof value === 'string' ? value : undefined;
}

export async function listAgents(
  request: PaperclipRequest,
  companyId: string,
): Promise<AgentRecord[]> {
  return jsonResponse<AgentRecord[]>(
    await request(`/api/companies/${companyId}/agents`),
    'Paperclip agent list',
  );
}

export async function createAgent(
  request: PaperclipRequest,
  companyId: string,
  spec: AgentSpec,
  reportsTo: string | null,
): Promise<AgentRecord> {
  return jsonResponse<AgentRecord>(
    await request(`/api/companies/${companyId}/agents`, {
      method: 'POST',
      body: JSON.stringify({
        name: spec.name,
        role: spec.role,
        reportsTo,
        // Always "http": Paperclip dispatches INTO Netzar. Any other adapter
        // type would put Paperclip's own execution plane in the loop, which
        // is precisely what the architecture exists to prevent.
        adapterType: 'http',
        adapterConfig: spec.adapterConfig,
        metadata: { netzarAgentId: spec.slug },
      }),
    }),
    `Paperclip ${spec.slug} agent creation`,
  );
}

/**
 * Stable-key JSON. Paperclip stores `adapter_config` as jsonb, which does not
 * preserve object key order, so `JSON.stringify(a) === JSON.stringify(b)` is
 * not a usable equality here: the same config read back can serialize
 * differently and would look like drift on every single run.
 */
function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
}

/**
 * The comparable projection of an adapter_config: every field by value, EXCEPT
 * `headers`, which is reduced to its sorted key names.
 *
 * P38: the authorization header carries the dispatch secret, and nothing in
 * this module prints or compares a secret value. The cost is named rather than
 * hidden — a ROTATED secret with the same header key set does not read as
 * drift, so rotation is still a deliberate act (call
 * `updateAgentAdapterConfig`, or delete the agent so the bootstrap recreates
 * it), not something a re-run heals. Arming and disarming, which is what this
 * comparison exists for, turn on `url` and on the PRESENCE of the header — and
 * both of those this projection does see.
 */
function comparableAdapterConfig(config: unknown): string {
  const record = (config ?? {}) as Record<string, unknown>;
  const headers = record.headers;
  return stableJson(
    headers !== null && typeof headers === 'object'
      ? { ...record, headers: Object.keys(headers as Record<string, unknown>).sort() }
      : record,
  );
}

/**
 * Rewrite ONE existing agent's `adapter_config`.
 *
 * ROUTE PROVENANCE. `PATCH /api/agents/{id}` carrying an `adapterConfig`
 * object is declared by the PINNED OpenAPI snapshot
 * (`tests/contract/openapi.snapshot.json`) — an artifact fact, not a plan claim
 * and not a Paperclip source read (A1-16). What the snapshot does NOT settle is
 * live behaviour: no probe in the 21-probe set drives this route, so its auth
 * and its response body stay UNVERIFIED until the first real bootstrap run
 * exercises it. Only the STATUS is relied on here — `jsonResponse` rejects
 * anything that is not 2xx.
 *
 * The body carries `adapterConfig` and nothing else, so this call cannot
 * silently re-role, rename or re-parent an agent.
 */
export async function updateAgentAdapterConfig(
  request: PaperclipRequest,
  agentId: string,
  adapterConfig: Record<string, unknown>,
): Promise<void> {
  await jsonResponse<unknown>(
    await request(`/api/agents/${agentId}`, {
      method: 'PATCH',
      body: JSON.stringify({ adapterConfig }),
    }),
    'Paperclip agent adapter_config update',
  );
}

/**
 * Create the agents in `specs` that do not already exist, in the order given
 * so a manager exists before its report, and RECONCILE the `adapter_config` of
 * the ones that do. Idempotent: an agent is recognized by
 * `metadata.netzarAgentId`, never by name.
 *
 * The reconcile exists because a create-only bootstrap freezes whatever the
 * FIRST run happened to build. Staging, measured 2026-09-06: the `research`
 * agent record held adapterConfig keys [method, payloadTemplate, timeoutMs] and
 * no `url`, Paperclip logged `HTTP adapter missing url`, and every
 * research-assigned issue escalated to Main instead of dispatching. Re-running
 * the bootstrap with a corrected spec changed nothing, because nothing here
 * ever updated an existing agent.
 *
 * Returns every mapped agent keyed by Netzar slug, plus which slugs were
 * created and which were updated — which is what lets a caller PROVE a re-run
 * was a no-op: both lists empty, and zero non-GET requests.
 */
export async function ensureAgents(
  request: PaperclipRequest,
  companyId: string,
  specs: AgentSpec[],
): Promise<{ agents: Map<string, AgentRecord>; created: string[]; updated: string[] }> {
  const existing = await listAgents(request, companyId);
  const bySlug = new Map<string, AgentRecord>();
  for (const agent of existing) {
    const slug = netzarAgentId(agent);
    if (slug) bySlug.set(slug, agent);
  }
  const created: string[] = [];
  const updated: string[] = [];
  for (const spec of specs) {
    const present = bySlug.get(spec.slug);
    if (present) {
      const live = comparableAdapterConfig(present.adapterConfig);
      if (live !== comparableAdapterConfig(spec.adapterConfig)) {
        await updateAgentAdapterConfig(request, present.id, spec.adapterConfig);
        // The local record takes the config that was just ACCEPTED, not one
        // read back out of the response: this route's response body shape is
        // not established by anything green here (see above), only its status.
        bySlug.set(spec.slug, {
          ...present,
          adapterConfig: spec.adapterConfig as AgentRecord['adapterConfig'],
        });
        updated.push(spec.slug);
      }
      continue;
    }
    const reportsTo = spec.reportsToSlug ? (bySlug.get(spec.reportsToSlug)?.id ?? null) : null;
    if (spec.reportsToSlug && !reportsTo) {
      throw new Error(
        `Paperclip agent ${spec.slug} reports to ${spec.reportsToSlug}, which does not exist yet`,
      );
    }
    bySlug.set(spec.slug, await createAgent(request, companyId, spec, reportsTo));
    created.push(spec.slug);
  }
  return { agents: bySlug, created, updated };
}

export async function listActiveKeys(
  request: PaperclipRequest,
  agentId: string,
): Promise<AgentKeyRecord[]> {
  const listed = await jsonResponse<AgentKeyRecord[]>(
    await request(`/api/agents/${agentId}/keys`),
    'Paperclip agent key list',
  );
  return listed.filter((key) => key.revokedAt == null);
}

/**
 * Mint one API key.
 *
 * A1-9: scope is STANDARD, proven by probe. A `task_bridge` key LOOKS more
 * secure and is hard-403'd on the company-wide issue list with
 * "Task bridge keys cannot use company-wide issue list APIs", which silently
 * breaks the reconciler.
 *
 * The returned token is the only time Paperclip ever reveals it. It is handed
 * straight back to the caller; nothing here logs, caches or formats it.
 */
export async function createKey(
  request: PaperclipRequest,
  agentId: string,
  name: string,
): Promise<{ id: string; token: string }> {
  const created = await jsonResponse<AgentKeyRecord>(
    await request(`/api/agents/${agentId}/keys`, {
      method: 'POST',
      body: JSON.stringify({ name, scope: { kind: 'standard' } }),
    }),
    'Paperclip agent key creation',
  );
  if (!created.token?.startsWith('pcp_')) {
    throw new Error('Paperclip did not return a one-time API token');
  }
  return { id: created.id, token: created.token };
}

export async function revokeKey(
  request: PaperclipRequest,
  agentId: string,
  keyId: string,
): Promise<void> {
  await request(`/api/agents/${agentId}/keys/${keyId}`, { method: 'DELETE' });
}

/**
 * Refuse to run while `PAPERCLIP_RESPONSIBLE_USER_AUTHZ_MODE` is set.
 *
 * It relaxes which user a minted key is attributed to, and `responsibleUserId`
 * is the ONLY human accountability an agent key carries. Lives here rather
 * than inline in the deployed script so a test can name it — the harness
 * fixture wants the same guarantee.
 */
export function assertResponsibleUserAuthzUnset(env: Record<string, string | undefined>): void {
  if (env.PAPERCLIP_RESPONSIBLE_USER_AUTHZ_MODE) {
    throw new Error(
      'PAPERCLIP_RESPONSIBLE_USER_AUTHZ_MODE is set. Unset it: every key this script mints must ' +
        'be attributed to the one named responsible user.',
    );
  }
}

/**
 * Parse `PAPERCLIP_DISPATCH_SLUGS`: the comma list of slugs that get a dispatch
 * `url`, i.e. the agents Paperclip is allowed to hand work to. Default `main`.
 *
 * `main` is in the result whatever the variable says. It is the `ceo`, the actor
 * the company-wide reconciler key belongs to, and the terminal of Paperclip's
 * escalation ladder, so a typo that silently disarmed it would stop every
 * dispatch with no error anywhere. Widening the set is what this variable is
 * for; the switch that can close `main` is the app-side
 * `paperclip/enabled_agents` runtime-config row.
 */
export function parseDispatchSlugs(value: string | undefined): string[] {
  const listed = (value ?? '')
    .split(',')
    .map((slug) => slug.trim())
    .filter(Boolean);
  return [...new Set(['main', ...listed])];
}

/**
 * Build the agent specs from a slug list.
 *
 * `main` is the `ceo` at the top of the chart and everything else reports to
 * it, because Paperclip's recovery ladder is the ONLY computed routing it has:
 * it walks `assignee.reportsTo -> creator.reportsTo -> role 'cto' -> role
 * 'ceo'`, so an org with no `ceo` has no terminal escalation target.
 *
 * `dispatchSecret` is embedded verbatim in `adapterConfig.headers`, not as a
 * `${VAR}` placeholder: Paperclip does no interpolation on adapter_config, so
 * a placeholder would be sent as the bearer and every dispatch would 401. It
 * is stored as plaintext jsonb — recorded, not hidden (C-17).
 *
 * ROTATION WART, NARROWED (P0-2b-2) AND NOT CLOSED. `ensureAgents` now
 * reconciles an existing agent's adapter_config against the spec, so arming,
 * disarming, a changed url and a changed payload template are all healed by a
 * re-run. What a re-run still does NOT heal is a ROTATED `dispatchSecret`: the
 * comparison reads the `headers` KEY NAMES and never a header value (P38), so a
 * new bearer under the same key does not read as drift. Rotating means calling
 * `updateAgentAdapterConfig` deliberately, or deleting the agent so the
 * bootstrap recreates it, in the same change as the secret.
 *
 * WHAT THAT CHANGED ABOUT ROLLBACK, SAID PLAINLY. Blanking an agent's
 * `adapter_config.url` in the Paperclip board still stops dispatch for that
 * agent at once, but it is no longer DURABLE: the next bootstrap run re-arms it
 * from the spec. The rollback that survives a re-run is the spec itself — drop
 * the slug from `PAPERCLIP_DISPATCH_SLUGS` and the next run PATCHes the url
 * away — and, app-side and independent, the `paperclip/enabled_agents`
 * runtime-config row: removing a slug from it makes the dispatch route answer
 * 202 `{ignored:'agent_not_enabled'}` within one 30 s config-cache TTL.
 *
 * STILL UNVERIFIED, and the first thing a real run has to prove: no probe in
 * the 21-probe set drives `PATCH /api/agents/{id}`, so its live auth and its
 * response are established by the pinned OpenAPI snapshot alone. The in-memory
 * Paperclip in `bootstrap-core.test.ts` proves what this module SENDS, never
 * what Paperclip accepts.
 */
export function agentSpecs(opts: {
  slugs: string[];
  dispatchUrl: string;
  dispatchSecret: string;
  /**
   * PHASE 6: which slugs actually get a `url`. Defaults to `['main']` — ONE
   * agent, so the first install dispatches for exactly one actor rather than
   * arming the whole chart at once.
   *
   * THE URL IS THE ARMING SWITCH: an agent whose `adapter_config` carries no
   * `url` has nothing for Paperclip to POST to. Since P0-2b-2 that switch is
   * driven by `PAPERCLIP_DISPATCH_SLUGS` and APPLIED BY `ensureAgents` on every
   * run, to already-created agents as well as new ones, so arming and rollback
   * are both an env edit plus a re-run rather than a deploy. The app-side arming
   * switch is the separate `paperclip/enabled_agents` runtime-config row the
   * dispatch route reads; the two are independent on purpose, so an operator can
   * close either end without touching the other and without shipping an image.
   */
  dispatchSlugs?: readonly string[];
}): AgentSpec[] {
  if (!opts.slugs.includes('main')) {
    throw new Error(
      "PAPERCLIP_AGENTS must include 'main' — it is the ceo and the reconciler's actor",
    );
  }
  const dispatchSlugs = opts.dispatchSlugs ?? ['main'];
  return opts.slugs.map((slug) => ({
    slug,
    name: `Netzar ${slug.charAt(0).toUpperCase()}${slug.slice(1)}`,
    role: slug === 'main' ? 'ceo' : 'general',
    reportsToSlug: slug === 'main' ? null : 'main',
    adapterConfig: dispatchSlugs.includes(slug)
      ? {
          url: opts.dispatchUrl,
          method: 'POST',
          headers: { authorization: `Bearer ${opts.dispatchSecret}` },
          payloadTemplate: { netzarAgentId: slug },
          timeoutMs: 10_000,
        }
      : // No `url` and NO SECRET. An un-armed agent's adapter row is not a
        // second copy of the dispatch secret sitting in plaintext jsonb for no
        // reason (C-17 records the copy that has a purpose; this one would not).
        { method: 'POST', payloadTemplate: { netzarAgentId: slug }, timeoutMs: 10_000 },
  }));
}

export interface KeyOutcome {
  slug: string;
  keyName: string;
  keyId: string;
  scope: string;
  action: 'created' | 'reused' | 'replaced';
  /** Present ONLY on the run that minted it. Never logged, never persisted here. */
  token?: string;
}

/**
 * Reconcile one key against BOTH sides: the active key list on Paperclip and
 * the token already stored in Secrets Manager.
 *
 * The two can disagree in one direction only that is recoverable. A key active
 * on Paperclip whose token we do not hold is UNUSABLE — Paperclip reveals a
 * token once and stores only its SHA hash — so it is revoked and re-minted
 * rather than left behind to look like working credentials.
 *
 * `action: 'reused'` on every key is what makes a re-run a PROVABLE no-op:
 * nothing is POSTed, nothing is DELETEd, and the caller can count it.
 */
export async function reconcileKey(
  request: PaperclipRequest,
  agent: AgentRecord,
  keyName: string,
  slug: string,
  storedToken: string | undefined,
): Promise<KeyOutcome> {
  const active = await listActiveKeys(request, agent.id);
  const existing = active.find((k) => k.name === keyName);
  const usable = storedToken?.startsWith('pcp_') === true;

  if (existing && usable) {
    if (existing.scope?.kind !== 'standard') {
      throw new Error(
        `${keyName} has scope '${existing.scope?.kind}', not 'standard'. A task_bridge key is ` +
          'hard-403d on the company-wide issue list and silently breaks the reconciler (A1-9). ' +
          'Revoke it in the Paperclip board and re-run.',
      );
    }
    if (!existing.responsibleUserId) {
      throw new Error(`${keyName} has no responsible user; revoke it and re-run`);
    }
    return { slug, keyName, keyId: existing.id, scope: 'standard', action: 'reused' };
  }

  let action: KeyOutcome['action'] = 'created';
  if (existing) {
    // Active on Paperclip, unreadable here. Nothing can ever use it again.
    await revokeKey(request, agent.id, existing.id);
    action = 'replaced';
  }
  const minted = await createKey(request, agent.id, keyName);
  return { slug, keyName, keyId: minted.id, scope: 'standard', action, token: minted.token };
}
