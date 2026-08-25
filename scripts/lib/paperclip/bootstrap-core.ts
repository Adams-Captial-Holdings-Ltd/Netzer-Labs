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
 * Create the agents in `specs` that do not already exist, in the order given
 * so a manager exists before its report. Idempotent: an agent is recognized
 * by `metadata.netzarAgentId`, never by name.
 *
 * Returns every mapped agent keyed by Netzar slug, plus how many were created
 * — which is what lets a caller PROVE a re-run was a no-op.
 */
export async function ensureAgents(
  request: PaperclipRequest,
  companyId: string,
  specs: AgentSpec[],
): Promise<{ agents: Map<string, AgentRecord>; created: string[] }> {
  const existing = await listAgents(request, companyId);
  const bySlug = new Map<string, AgentRecord>();
  for (const agent of existing) {
    const slug = netzarAgentId(agent);
    if (slug) bySlug.set(slug, agent);
  }
  const created: string[] = [];
  for (const spec of specs) {
    if (bySlug.has(spec.slug)) continue;
    const reportsTo = spec.reportsToSlug ? (bySlug.get(spec.reportsToSlug)?.id ?? null) : null;
    if (spec.reportsToSlug && !reportsTo) {
      throw new Error(
        `Paperclip agent ${spec.slug} reports to ${spec.reportsToSlug}, which does not exist yet`,
      );
    }
    bySlug.set(spec.slug, await createAgent(request, companyId, spec, reportsTo));
    created.push(spec.slug);
  }
  return { agents: bySlug, created };
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
 * ROTATION WART, named rather than hidden: `ensureAgents` only CREATES missing
 * agents, so re-running with a rotated secret does not rewrite an existing
 * agent's adapter_config. Rotating means updating the agent in the Paperclip
 * board (or deleting it so the bootstrap recreates it) in the same change as
 * the secret.
 *
 * PHASE 6 DID NOT CLOSE IT, AND SAYS SO RATHER THAN PAPERING OVER IT.
 * UNVERIFIED: there is no agent-UPDATE call anywhere in this repo — this module
 * has `listAgents` and `createAgent` and nothing else — and no probe in the
 * 21-probe set exercises one, so the method and path that would rewrite an
 * existing `adapter_config` are established by NOTHING green here. A1-16
 * forbids settling it from the plan document, which is already wrong about this
 * route's auth. So rotation AND rollback are, today, a BOARD-UI OPERATION:
 * blank the agent's `adapter_config.url` in the Paperclip board and dispatch
 * for that agent stops, with no redeploy and no image. The complementary
 * app-side switch, which this repo CAN prove, is the `paperclip/enabled_agents`
 * runtime-config row: removing a slug from it makes the dispatch route answer
 * 202 `{ignored:'agent_not_enabled'}` within one 30 s config-cache TTL.
 * Writing `PATCH /api/agents/{id}` into code on the strength of the plan alone
 * is exactly the move that must not happen; it needs a probe first.
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
   * THE URL IS THE ARMING SWITCH, and that is what makes rollback a DATA EDIT
   * rather than a deploy: an agent whose `adapter_config` carries no `url` has
   * nothing for Paperclip to POST to. The app-side arming switch is the
   * separate `paperclip/enabled_agents` runtime-config row the dispatch route
   * reads; the two are independent on purpose, so an operator can close either
   * end without touching the other and without shipping an image.
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
  dryRun: boolean,
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

  if (dryRun) {
    return { slug, keyName, keyId: '(dry-run)', scope: 'standard', action: 'created' };
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
