/**
 * Phase 1 contract probes: freeze what the pinned Paperclip artifact actually
 * does, locally, before a line of client logic depends on a guess.
 *
 * A1-16 applies to every comment in this file: no Paperclip source line number
 * is authority here. Each probe names the method + path, the behaviour it
 * observed, and carries the bar criterion it settles in its test name.
 *
 * Two kinds of probe live here and they are labelled differently:
 *   - a BLOCKING probe asserts a value the bar specifies. If it goes red the
 *     integration is unsafe to run, not merely surprising.
 *   - a CHARACTERIZATION probe records what the server did, because neither
 *     research packet could say. It asserts the invariants that hold whatever
 *     the answer is, and pins the answer to `artifact-characterization.json` so
 *     an artifact bump that flips it is a red test rather than a surprise in
 *     production. Regenerate that file with UPDATE_PAPERCLIP_SNAPSHOT=1 and
 *     commit the diff; nothing in it is ever hand-written.
 *
 * These contracts need the disposable Paperclip harness
 * (`docker-compose.paperclip.yml`) and PAPERCLIP_TEST_AUTH_SECRET in the
 * environment - the same variable Compose itself refuses to start without. The
 * shared LocalStack integration lane has neither, so the suite gates on the
 * secret exactly like `src/lib/paperclip/client.paperclip.integration.test.ts`:
 * an armed harness (`npm run test:paperclip:all`) runs the contracts for real,
 * everything else skips them visibly instead of failing inside docker.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bootstrapPaperclip,
  paperclipAdminRequest,
  type PaperclipBootstrap,
  type PaperclipBootstrapAgent,
} from '../fixtures/paperclip-bootstrap.js';
import {
  ISSUE_LIST_MAX_LIMIT,
  PAPERCLIP_RUN_ID_HEADER,
  type PaperclipCreateIssueResponse,
  type PaperclipErrorBody,
  type PaperclipHealth,
  type PaperclipHeartbeatRun,
  type PaperclipIssue,
  type PaperclipIssueComment,
  type PaperclipValidationIssue,
  type PaperclipWakeupResponse,
  type PaperclipWorkProduct,
} from '../../src/lib/paperclip/types.js';

const OPENAPI_SNAPSHOT = new URL('./openapi.snapshot.json', import.meta.url);
const CHARACTERIZATION = new URL('./artifact-characterization.json', import.meta.url);
const UPDATE_MODE = process.env.UPDATE_PAPERCLIP_SNAPSHOT === '1';

/** Every field `issueToMission` reads. Absence of any one breaks the projection. */
const PROJECTION_FIELDS = [
  'id',
  'identifier',
  'title',
  'description',
  'status',
  'priority',
  'assigneeAgentId',
  'createdByAgentId',
  'createdAt',
  'updatedAt',
] as const;

/** Every field `PaperclipHeartbeatRun` types. A1-12 asserts each on a live 202. */
const HEARTBEAT_RUN_FIELDS = [
  'id',
  'companyId',
  'agentId',
  'invocationSource',
  'triggerDetail',
  'status',
  'wakeupRequestId',
  'responsibleUserId',
  'startedAt',
  'finishedAt',
  'error',
  'createdAt',
  'updatedAt',
] as const;

/** Every field `PaperclipWakeupSkipped` types. */
const WAKEUP_SKIPPED_FIELDS = [
  'status',
  'reason',
  'message',
  'issueId',
  'executionRunId',
  'executionAgentId',
  'executionAgentName',
] as const;

/**
 * Every route template this integration builds, as method + OpenAPI path. A1-15
 * checks each against the committed snapshot, which is the one half of the bar's
 * "the snapshot is the contract" rule the artifact can actually honour.
 */
const INTEGRATION_ROUTES: Array<[string, string]> = [
  ['get', '/api/health'],
  ['get', '/api/openapi.json'],
  ['get', '/api/companies'],
  ['get', '/api/companies/{companyId}'],
  ['get', '/api/companies/{companyId}/issues'],
  ['post', '/api/companies/{companyId}/issues'],
  ['get', '/api/companies/{companyId}/issues/count'],
  ['get', '/api/companies/{companyId}/agents'],
  ['get', '/api/companies/{companyId}/approvals'],
  ['get', '/api/companies/{companyId}/activity'],
  ['get', '/api/agents/me'],
  ['get', '/api/agents/{id}'],
  ['post', '/api/agents/{id}/wakeup'],
  ['post', '/api/agents/{id}/keys'],
  ['delete', '/api/agents/{id}/keys/{keyId}'],
  ['get', '/api/issues/{id}'],
  ['patch', '/api/issues/{id}'],
  ['get', '/api/issues/{id}/comments'],
  ['post', '/api/issues/{id}/comments'],
  ['get', '/api/issues/{id}/work-products'],
  ['post', '/api/issues/{id}/work-products'],
  ['post', '/api/issues/{id}/checkout'],
  ['post', '/api/issues/{id}/release'],
  ['get', '/api/issues/{id}/approvals'],
  ['get', '/api/issues/{id}/activity'],
  ['get', '/api/issues/{id}/runs'],
  ['get', '/api/issues/{issueId}/live-runs'],
  ['get', '/api/issues/{issueId}/active-run'],
];

/**
 * The routes whose success responses the projection and the ACL will read. The
 * A1-15 probe asserts the document types every one of them as an opaque object,
 * which is why a response type in `types.ts` may only be widened by a probe.
 */
const OPAQUE_RESPONSE_ROUTES: Array<[string, string]> = [
  ['get', '/api/companies/{companyId}/issues'],
  ['get', '/api/issues/{id}'],
  ['get', '/api/issues/{id}/comments'],
  ['post', '/api/issues/{id}/work-products'],
  ['post', '/api/agents/{id}/wakeup'],
  ['get', '/api/companies/{companyId}/issues/count'],
];

/**
 * Every field `PaperclipHealthOk` declares. The health-body probe asserts each
 * one appears on a live body, so no field can be typed from a source read: the
 * OpenAPI document declares only the subset below and stays silent about the
 * rest, which is how `authReady`, `features` and `deploymentExposure` were
 * typed once with no evidence behind them at all.
 */
const HEALTH_OK_FIELDS = [
  'status',
  'deploymentMode',
  'deploymentExposure',
  'version',
  'serverVersion',
  'serverInfo',
  'authReady',
  'features',
  'bootstrapStatus',
  'bootstrapInviteActive',
  'databaseBackup',
  'warnings',
] as const;

/** The only health fields the OpenAPI document itself declares. */
const DOCUMENTED_HEALTH_FIELDS = [
  'status',
  'version',
  'deploymentMode',
  'bootstrapStatus',
  'bootstrapInviteActive',
  'databaseBackup',
  'warnings',
  'serverInfo',
] as const;

/** The exact set of active keys `paperclip-bootstrap.ts` provisions. */
const PROVISIONED_KEY_NAMES = new Set(['netzar-reconciler', 'netzar-agent-main', 'netzar-agent-research']);

/**
 * C-2. The overlap a poller subtracts from its watermark before re-reading.
 * Wide enough to swallow the `+1ms` predicate the vendored patch compiles and
 * the microsecond-to-millisecond truncation underneath it.
 */
const POLL_OVERLAP_MS = 2_000;

/**
 * C-2's same-millisecond collision hunt, which is MANDATORY - the probe fails if
 * it never reproduces one. It used to skip the sibling half on a lost race, and
 * a soft pass is indistinguishable from a broken hunt.
 *
 * The budget is set from measurement, not hope: six concurrent creates against
 * this harness collide in roughly two batches out of three, so twelve attempts
 * is a margin of many orders of magnitude and the loop stops at the first hit
 * (typically the first or second batch, ~6-12 issues).
 */
const COLLISION_ATTEMPTS = 12;
const COLLISION_BATCH = 6;

/**
 * A1-10, shape (b): how many concurrent issue-list reads the coalescer probe
 * fires. IDENTICAL requests coalesce onto one in-flight computation and never
 * 429 no matter how many there are - 64 is far past any plausible ceiling and
 * still answers 200 - so provoking the retry needs DISTINCT request keys, which
 * is what `COALESCER_DISTINCT` supplies (24 against a measured ceiling of 8).
 */
const COALESCER_IDENTICAL = 64;
const COALESCER_DISTINCT = 24;

/** A1-10, shape (a): headroom over the advertised search limit when draining it. */
const SEARCH_DRAIN_HEADROOM = 5;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

interface ProbeResult<T> {
  status: number;
  headers: Headers;
  body: T;
}

interface WriteOutcome {
  status: number;
  error: string | null;
}

interface RunIdBoundary {
  /** Keyed by "METHOD /path" - the four agent write shapes, driven run-less. */
  routes: Record<string, WriteOutcome & { requiresRunId: boolean }>;
  /** A1-3: an EMPTY header is not a held run. This records what it is instead. */
  emptyHeader: WriteOutcome;
}

let fixture: PaperclipBootstrap;
let committed: Record<string, unknown>;
const recorded: Record<string, unknown> = {};
let runIdBoundary: RunIdBoundary;
let runId: string;

/**
 * A raw probe: never throws on a non-2xx, because half the contracts here are
 * about the failure bodies. A2-13: `.json()` is only attempted when the body
 * parses, so an ALB or proxy HTML error folds into `{error: <text>}` rather
 * than crashing the probe.
 *
 * A `null` token sends NO `Authorization` header at all. Only the health-body
 * probe uses it, and it is the reason that probe can speak about an anonymous
 * caller: every other probe here is authenticated, so no other probe may.
 */
async function probe<T>(path: string, token: string | null, init: RequestInit = {}): Promise<ProbeResult<T>> {
  const response = await fetch(`${fixture.baseUrl}${path}`, {
    ...init,
    headers: {
      // A1-2: the auth header is exactly this. There is no x-api-key.
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...init.headers,
    },
  });
  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { error: text };
    }
  }
  return { status: response.status, headers: response.headers, body: body as T };
}

function companyIssues(query = ''): string {
  return `/api/companies/${fixture.companyId}/issues${query ? `?${query}` : ''}`;
}

function errorOf(body: unknown): string | undefined {
  const error = (body as PaperclipErrorBody | null)?.error;
  return typeof error === 'string' ? error : undefined;
}

/**
 * A1-4: `details` carries the zod issue array on a 400 and it names the field
 * that was wrong. Rendering it is the difference between "Validation error" and
 * a message that tells the next reader which key to supply.
 */
function detailsOf(body: unknown): string {
  const details = (body as PaperclipErrorBody | null)?.details;
  if (!Array.isArray(details)) return '';
  return details
    .map((entry) => {
      const issue = entry as Partial<PaperclipValidationIssue>;
      const at = Array.isArray(issue.path) ? issue.path.join('.') : '';
      return at ? `${at}: ${issue.message ?? ''}` : String(issue.message ?? '');
    })
    .join(' | ');
}

function describeFailure(result: { status: number; body: unknown }): string {
  const details = detailsOf(result.body);
  return `HTTP ${result.status} ${errorOf(result.body) ?? ''}${details ? ` [${details}]` : ''}`.trim();
}

/**
 * A1-4: the human string is always on `error`. Nothing in this integration may
 * read `message` or `detail` as the primary string, so every failure body a
 * probe sees is held to that here rather than in one place only.
 */
function expectErrorEnvelope(result: ProbeResult<unknown>): void {
  if (result.status < 400 || result.body === null) return;
  const body = result.body as Record<string, unknown>;
  expect(typeof body.error, `failure body must carry its human string on 'error': ${JSON.stringify(body)}`).toBe('string');
  expect(body).not.toHaveProperty('message');
  expect(body).not.toHaveProperty('detail');
}

/** No write in this integration may answer 5xx. A 500 is never a contract. */
function expectNotServerError(label: string, result: { status: number; body: unknown }): void {
  expect(result.status, `${label} answered a server error: ${describeFailure(result)}`).toBeLessThan(500);
}

function outcomeOf(result: { status: number; body: unknown }): WriteOutcome {
  return { status: result.status, error: errorOf(result.body) ?? null };
}

/**
 * Compare one characterization slice against the committed record, or stash it
 * for the writer when regenerating. The committed file is the artifact's
 * answer; a bump that changes it must be an explicit, reviewed diff.
 */
function expectCharacterized(section: string, observed: unknown): void {
  recorded[section] = observed;
  if (UPDATE_MODE) return;
  expect(
    observed,
    `${section} changed against the pinned artifact. Re-read the consequence in artifact-characterization.json, then regenerate it with UPDATE_PAPERCLIP_SNAPSHOT=1.`,
  ).toEqual(committed[section]);
}

async function createIssue(
  title: string,
  extra: Record<string, unknown> = {},
  token = fixture.agents.main.key,
): Promise<ProbeResult<PaperclipCreateIssueResponse>> {
  return probe<PaperclipCreateIssueResponse>(companyIssues(), token, {
    method: 'POST',
    body: JSON.stringify({
      title,
      description: 'Paperclip Phase 1 contract probe',
      assigneeAgentId: fixture.agents.main.id,
      priority: 'medium',
      ...extra,
    }),
  });
}

async function createdIssue(title: string, extra: Record<string, unknown> = {}): Promise<PaperclipIssue> {
  const result = await createIssue(title, extra);
  expect(result.status, `issue creation failed: ${describeFailure(result)}`).toBeLessThan(300);
  return result.body;
}

/**
 * An issue with NO assignee, which every write-shape probe targets.
 *
 * Creating an assigned issue fires an assignment wakeup, and for about a second
 * afterwards that run owns the issue: `POST /api/issues/{id}/work-products`
 * then answers 401 "Agent run id required" to a run-less actor and 409 "Issue
 * run ownership conflict" to an actor holding any other run. Measured over
 * repeated rounds the assigned variant flips between those and 201 purely on
 * timing, so the write characterizations would record a race. Unassigned issues
 * have no execution run and answer identically every time.
 *
 * A1-13: `status` stays omitted, so an unassigned issue defaults to `backlog` -
 * which is why every checkout here expects `todo` or `backlog`.
 */
async function createdUnassignedIssue(
  title: string,
  extra: Record<string, unknown> = {},
): Promise<PaperclipIssue> {
  const result = await probe<PaperclipCreateIssueResponse>(companyIssues(), fixture.agents.main.key, {
    method: 'POST',
    body: JSON.stringify({ title, description: 'Paperclip Phase 1 contract probe', priority: 'medium', ...extra }),
  });
  expect(result.status, `unassigned issue creation failed: ${describeFailure(result)}`).toBeLessThan(300);
  expect(result.body.assigneeAgentId, 'the write-shape target must have no assignee').toBeNull();
  return result.body;
}

/** A1-3: the header is OMITTED, never sent empty, when no run is held. */
function runHeaders(): Record<string, string> {
  return runId ? { [PAPERCLIP_RUN_ID_HEADER]: runId } : {};
}

async function postComment(issueId: string, body: string): Promise<ProbeResult<PaperclipIssueComment>> {
  return probe<PaperclipIssueComment>(`/api/issues/${issueId}/comments`, fixture.agents.main.key, {
    method: 'POST',
    body: JSON.stringify({ body }),
  });
}

/**
 * Acquire a GENUINE heartbeat run id by waking the agent.
 *
 * A1-3/A1-12: the client must NEVER do this - it must never synthesize a run id
 * and must never adopt a wakeup's run id as its own `X-Paperclip-Run-Id`; the
 * only legitimate source is inbound dispatch. The probe suite does it
 * deliberately, because a real run id is the only way to drive checkout and
 * work-product creation past the run-id guard and reach `boardMutationGuard`
 * (A1-17), and because fabricating one is already covered by the shipped FI-4
 * probe.
 */
async function acquireRunId(agent: PaperclipBootstrapAgent = fixture.agents.main): Promise<string> {
  const wakeup = await probe<PaperclipWakeupResponse>(
    `/api/agents/${agent.id}/wakeup`,
    agent.key,
    { method: 'POST', body: JSON.stringify({ source: 'on_demand', reason: 'phase-1 contract probe' }) },
  );
  // ANY 2xx. The bar's corrected A1-12 says to record this status code, not to
  // assert it, and this hook runs in `beforeAll`: pinning a literal here would
  // kill the ENTIRE contract suite on an artifact bump, in a hook whose message
  // blames the run id. The A1-12 probe records the code where it can be read.
  expect(wakeup.status, `wakeup could not supply a run id: ${describeFailure(wakeup)}`).toBeGreaterThanOrEqual(200);
  expect(wakeup.status, `wakeup could not supply a run id: ${describeFailure(wakeup)}`).toBeLessThan(300);
  const body = wakeup.body;
  expect(
    body.status,
    `wakeup was skipped, so no run id exists to drive the run-gated write shapes: ${JSON.stringify(body)}`,
  ).not.toBe('skipped');
  return (body as PaperclipHeartbeatRun).id;
}

/**
 * C-3. Packet 1 says the run-id guard covers comments; Packet 4 says comments
 * need none and PATCH needs one only conditionally. Settle it by probe, once,
 * in the hook - every later probe that writes needs the answer.
 */
async function characterizeRunIdBoundary(): Promise<RunIdBoundary> {
  const shapes: Array<[string, () => Promise<ProbeResult<PaperclipErrorBody>>]> = [
    ['POST /api/issues/{id}/comments', async () => {
      const issue = await createdUnassignedIssue(`C-3 run-less comment ${Date.now()}`);
      return probe<PaperclipErrorBody>(`/api/issues/${issue.id}/comments`, fixture.agents.main.key, {
        method: 'POST',
        body: JSON.stringify({ body: 'C-3: run-less agent actor comment' }),
      });
    }],
    ['PATCH /api/issues/{id}', async () => {
      const issue = await createdUnassignedIssue(`C-3 run-less patch ${Date.now()}`);
      return probe<PaperclipErrorBody>(`/api/issues/${issue.id}`, fixture.agents.main.key, {
        method: 'PATCH',
        body: JSON.stringify({ title: `C-3 run-less patch applied ${Date.now()}` }),
      });
    }],
    ['POST /api/issues/{id}/checkout', async () => {
      const issue = await createdUnassignedIssue(`C-3 run-less checkout ${Date.now()}`);
      return probe<PaperclipErrorBody>(`/api/issues/${issue.id}/checkout`, fixture.agents.main.key, {
        method: 'POST',
        body: JSON.stringify({ agentId: fixture.agents.main.id, expectedStatuses: ['todo', 'backlog'] }),
      });
    }],
    ['POST /api/issues/{id}/work-products', async () => {
      const issue = await createdUnassignedIssue(`C-3 run-less work product ${Date.now()}`);
      return probe<PaperclipErrorBody>(`/api/issues/${issue.id}/work-products`, fixture.agents.main.key, {
        method: 'POST',
        body: JSON.stringify({ type: 'document', provider: 'netzar', title: 'C-3 run-less work product' }),
      });
    }],
  ];

  const routes: RunIdBoundary['routes'] = {};
  for (const [route, run] of shapes) {
    const result = await run();
    expectNotServerError(route, result);
    routes[route] = { ...outcomeOf(result), requiresRunId: result.status === 401 };
  }

  // A1-3, the other half: an EMPTY header must never be sent. This records what
  // the server does with one, so "omitted, never empty" is a measured rule.
  const emptyIssue = await createdUnassignedIssue(`C-3 empty run-id header ${Date.now()}`);
  const empty = await probe<PaperclipErrorBody>(`/api/issues/${emptyIssue.id}/checkout`, fixture.agents.main.key, {
    method: 'POST',
    headers: { [PAPERCLIP_RUN_ID_HEADER]: '' },
    body: JSON.stringify({ agentId: fixture.agents.main.id, expectedStatuses: ['todo', 'backlog'] }),
  });
  expectNotServerError('empty run-id header', empty);

  return { routes, emptyHeader: outcomeOf(empty) };
}

/**
 * Revoke every active agent key the fixture did not provision.
 *
 * A1-9 mints a task_bridge key and revokes it in a `finally`, but a timeout or
 * a crash between the two would leave it active, and `assertActiveKeys` then
 * fails EVERY later bootstrap against this harness - including the probes that
 * pass today. This sweep is the backstop.
 */
async function revokeStrayKeys(): Promise<string[]> {
  const revoked: string[] = [];
  for (const agentId of [fixture.agents.main.id, fixture.agents.research.id]) {
    const listed = await paperclipAdminRequest(`/api/agents/${agentId}/keys`);
    if (!listed.ok) continue;
    const keys = await listed.json().catch(() => null) as Array<{ id?: string; name?: string; revokedAt?: string | null }> | null;
    for (const key of keys ?? []) {
      if (!key.id || key.revokedAt != null || PROVISIONED_KEY_NAMES.has(key.name ?? '')) continue;
      await paperclipAdminRequest(`/api/agents/${agentId}/keys/${key.id}`, { method: 'DELETE' });
      revoked.push(key.name ?? key.id);
    }
  }
  return revoked;
}

describe.skipIf(!process.env.PAPERCLIP_TEST_AUTH_SECRET)('Paperclip pinned-artifact route contracts', () => {
  beforeAll(async () => {
    fixture = await bootstrapPaperclip();
    committed = JSON.parse(await readFile(CHARACTERIZATION, 'utf8')) as Record<string, unknown>;
    if (!UPDATE_MODE && committed.$placeholder === true) {
      throw new Error('artifact-characterization.json is a placeholder; regenerate it with UPDATE_PAPERCLIP_SNAPSHOT=1 and commit it');
    }
    runIdBoundary = await characterizeRunIdBoundary();
    runId = await acquireRunId();
  }, 180_000);

  afterAll(async () => {
    if (!fixture) return;
    const stray = await revokeStrayKeys();
    if (stray.length > 0) console.log('[cleanup] revoked stray agent keys:', stray.join(', '));
    if (!UPDATE_MODE) return;
    await writeFile(
      CHARACTERIZATION,
      `${JSON.stringify({ ...committed, ...recorded, $placeholder: undefined }, null, 2)}\n`,
      'utf8',
    );
    console.log('[characterization] artifact-characterization.json regenerated from the pinned artifact; commit it.');
  }, 60_000);

  it('health body by actor: every field PaperclipHealthOk types is on a live body', async () => {
    // The ONLY probe in this file that speaks for an anonymous caller, because
    // it is the only one that makes an anonymous request: `probe(path, null)`
    // sends no Authorization header at all, while every other probe here sends
    // one unconditionally. Nothing else may describe an anonymous body.
    const anonymous = await probe<PaperclipHealth>('/api/health', null);
    const authenticated = await probe<PaperclipHealth>('/api/health', fixture.reconcilerKey);
    expect(anonymous.status).toBe(200);
    expect(authenticated.status).toBe(200);
    expect(anonymous.body.status).toBe('ok');
    expect(authenticated.body.status).toBe('ok');

    const anonymousKeys = Object.keys(anonymous.body).sort();
    const authenticatedKeys = Object.keys(authenticated.body).sort();

    // Why every field on `PaperclipHealthOk` is optional: the anonymous body is
    // a strict subset of the authenticated one, so one type covers both.
    for (const field of anonymousKeys) {
      expect(authenticatedKeys, `the anonymous health body is no longer a subset: ${field}`).toContain(field);
    }

    // The anti-invention direction, and the reason this probe exists. A field
    // typed on `PaperclipHealthOk` that no live body carries has no provenance
    // and must be deleted rather than narrated: the OpenAPI document declares
    // only DOCUMENTED_HEALTH_FIELDS and says nothing about the rest, so reading
    // is not evidence here.
    const observed = [...new Set([...anonymousKeys, ...authenticatedKeys])];
    for (const field of HEALTH_OK_FIELDS) {
      expect(observed, `PaperclipHealthOk types ${field}; no live health body carries it`).toContain(field);
    }

    expectCharacterized('healthBodyByActor', { anonymous: anonymousKeys, authenticated: authenticatedKeys });
  });

  it('A1-5: the issue list answers with a bare Array, not an envelope', async () => {
    await createdIssue(`A1-5 bare array ${Date.now()}`);
    const listed = await probe<PaperclipIssue[]>(companyIssues('limit=1'), fixture.reconcilerKey);

    expect(listed.status).toBe(200);
    expect(Array.isArray(listed.body)).toBe(true);
    expect(listed.body).not.toHaveProperty('total');
    expect(listed.body).not.toHaveProperty('nextOffset');
  });

  it('A1-8 (BLOCKING): updatedSince one hour in the future returns an empty list', async () => {
    // The board must be non-empty first, or an unpatched server answering with
    // the full unfiltered list would still look like [] and the trap would pass
    // vacuously - which is exactly the silent failure this probe exists to stop.
    await createdIssue(`A1-8 watermark trap ${Date.now()}`);
    const unfiltered = await probe<PaperclipIssue[]>(companyIssues('limit=1'), fixture.reconcilerKey);
    expect(unfiltered.status).toBe(200);
    expect(unfiltered.body.length).toBeGreaterThan(0);

    const future = new Date(Date.now() + 3_600_000).toISOString();
    const filtered = await probe<PaperclipIssue[]>(
      companyIssues(`updatedSince=${encodeURIComponent(future)}&limit=1`),
      fixture.reconcilerKey,
    );
    expect(filtered.status).toBe(200);
    expect(
      filtered.body,
      'updatedSince returned rows: the vendored patch is absent and this build silently ignores the param. The reconciler must refuse to start.',
    ).toEqual([]);

    // Independent second signal. An unknown query param is silently ignored, so
    // a build that rejects a malformed value is provably parsing it.
    const malformed = await probe<PaperclipErrorBody>(
      companyIssues('updatedSince=2026-01-01T00:00:00'),
      fixture.reconcilerKey,
    );
    expect(malformed.status).toBe(400);
    expectErrorEnvelope(malformed);
    expect(errorOf(malformed.body)).toContain('updatedSince');
  });

  it('A1-9 (BLOCKING): a task_bridge key is 403 on the company-wide list, a standard key is 200', async () => {
    const standard = await probe<PaperclipIssue[]>(companyIssues('limit=1'), fixture.reconcilerKey);
    expect(standard.status, 'the reconciler key must be STANDARD scope').toBe(200);

    // The bootstrap fixture deliberately cannot mint this: `provisionKeys`
    // asserts every key it provisions is standard scope. Mint one directly
    // through the fixture's own admin session, and revoke it again - a stray
    // active key fails the next bootstrap's `assertActiveKeys`.
    //
    // The scope shape is not a guess. `POST /api/agents/{id}/keys` in the
    // committed OpenAPI snapshot declares a three-way oneOf, and the
    // task_bridge arm accepts projectId/projectIds/parentIssueId/
    // parentIssueIds/allowedAssigneeAgentIds - `issueId` belongs to the
    // skill_test arm, not this one. A bare `{kind:'task_bridge'}` is a 400
    // whose zod details read "task_bridge keys require at least one project or
    // parent issue boundary", so a boundary is supplied here.
    const agentId = fixture.agents.research.id;
    const keyPath = `/api/agents/${agentId}/keys`;
    const boundIssue = await createdIssue(`A1-9 task_bridge binding ${Date.now()}`);
    const scopeShapes: Array<Record<string, unknown>> = [
      { kind: 'task_bridge', parentIssueIds: [boundIssue.id] },
      { kind: 'task_bridge', parentIssueId: boundIssue.id },
    ];

    let minted: { id: string; token: string } | undefined;
    const rejections: string[] = [];
    for (const scope of scopeShapes) {
      const response = await paperclipAdminRequest(keyPath, {
        method: 'POST',
        body: JSON.stringify({ name: `netzar-contract-task-bridge-${Date.now()}`, scope }),
      });
      const body = await response.json().catch(() => null) as { id?: string; token?: string } | null;
      if (response.ok && body?.id && body?.token) {
        minted = { id: body.id, token: body.token };
        break;
      }
      rejections.push(`${JSON.stringify(scope)} -> ${describeFailure({ status: response.status, body })}`);
    }

    expect(
      minted,
      `could not mint a task_bridge-scoped key, so the negative probe guarding the reconciler's key scope did not run. Compare the payload against the scope oneOf in tests/contract/openapi.snapshot.json. Attempts: ${rejections.join(' ; ')}`,
    ).toBeDefined();

    try {
      const denied = await probe<PaperclipErrorBody>(companyIssues('limit=1'), minted!.token);
      expect(denied.status).toBe(403);
      expectErrorEnvelope(denied);
      expect(errorOf(denied.body)).toBe('Task bridge keys cannot use company-wide issue list APIs');
    } finally {
      const revoked = await paperclipAdminRequest(`${keyPath}/${minted!.id}`, { method: 'DELETE' });
      expect(revoked.status, 'the task_bridge key must be revoked or the next bootstrap fails').toBe(200);
    }
  }, 60_000);

  it('A1-7: sortField accepts only `updated`, limit over the max is clamped, limit<=0 is a 400', async () => {
    const badSort = await probe<PaperclipErrorBody>(companyIssues('sortField=created'), fixture.reconcilerKey);
    expect(badSort.status).toBe(400);
    expectErrorEnvelope(badSort);
    expect(errorOf(badSort.body)).toBe("sortField must be 'updated' when provided");

    const goodSort = await probe<PaperclipIssue[]>(
      companyIssues('sortField=updated&sortDir=asc&limit=1'),
      fixture.reconcilerKey,
    );
    expect(goodSort.status).toBe(200);

    // Silently clamped, never rejected - the dangerous half of A1-7.
    const overMax = await probe<PaperclipIssue[]>(
      companyIssues(`limit=${ISSUE_LIST_MAX_LIMIT * 5}`),
      fixture.reconcilerKey,
    );
    expect(overMax.status).toBe(200);
    expect(Array.isArray(overMax.body)).toBe(true);
    expect(overMax.body.length).toBeLessThanOrEqual(ISSUE_LIST_MAX_LIMIT);

    for (const limit of ['0', '-1']) {
      const rejected = await probe<PaperclipErrorBody>(companyIssues(`limit=${limit}`), fixture.reconcilerKey);
      expect(rejected.status, `limit=${limit} must be a 400`).toBe(400);
      expectErrorEnvelope(rejected);
    }
  });

  it('A1-5 (BLOCKING): offset pages the list, and a negative offset is a 400', async () => {
    // A1-5 leaves "page until a short page" as the ONLY way to size a board,
    // and A1-8 establishes that a param this server does not implement is
    // silently ignored with a 200. An ignored `offset` therefore hands the
    // reconciler an identical page 1 forever - the same silent trap A1-8
    // exists to catch - so the field is typed only because this probe runs.
    // Paged over a two-row set NOTHING else touches - two unassigned children
    // of one parent - rather than over the whole board. The board is mutating
    // underneath this suite (a background wakeup moves an issue's updatedAt and
    // reorders an `updated` sort mid-test), so paging the board would make this
    // probe a race against unrelated writes rather than a test of `offset`.
    const parent = await createdUnassignedIssue(`A1-5 offset parent ${Date.now()}`);
    const left = await createdUnassignedIssue(`A1-5 offset a ${Date.now()}`, { parentId: parent.id });
    const right = await createdUnassignedIssue(`A1-5 offset b ${Date.now()}`, { parentId: parent.id });
    expect(
      left.updatedAt,
      'the two rows share an updatedAt, so their order under an `updated` sort is undefined and offset cannot be read from it',
    ).not.toBe(right.updatedAt);

    const page = async (offset: number): Promise<ProbeResult<PaperclipIssue[]>> => probe<PaperclipIssue[]>(
      companyIssues(`parentId=${parent.id}&limit=1&offset=${offset}&sortField=updated&sortDir=asc`),
      fixture.reconcilerKey,
    );
    const first = await page(0);
    const second = await page(1);
    const past = await page(2);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body).toHaveLength(1);
    expect(second.body).toHaveLength(1);
    expect(
      [first.body[0].id, second.body[0].id].sort(),
      'the two single-row pages did not cover the two-row set: this build is ignoring offset and a paging reconciler would re-read page 1 forever',
    ).toEqual([left.id, right.id].sort());
    // The short page a sweep terminates on, since there is no total to count to.
    expect(past.status).toBe(200);
    expect(past.body, 'paging past the end must be a short page, not a repeat of the last one').toEqual([]);

    // The independent second signal, exactly as A1-8 uses one: a build that
    // rejects a malformed value is provably parsing the param rather than
    // dropping it on the floor.
    const negative = await probe<PaperclipErrorBody>(companyIssues('limit=1&offset=-1'), fixture.reconcilerKey);
    expect(negative.status).toBe(400);
    expectErrorEnvelope(negative);
    expect(errorOf(negative.body)).toContain('offset');
  });

  it('A1-7: the status, assigneeAgentId and parentId filters are acted on, not silently ignored', async () => {
    const parent = await createdUnassignedIssue(`A1-7 filter parent ${Date.now()}`);
    const child = await createIssue(`A1-7 filter child ${Date.now()}`, { parentId: parent.id });
    expect(child.status, `child creation failed: ${describeFailure(child)}`).toBeLessThan(300);

    const backlog = await probe<PaperclipIssue[]>(companyIssues('status=backlog&limit=25'), fixture.reconcilerKey);
    expect(backlog.status).toBe(200);
    expect(backlog.body.length, 'the board must hold a backlog issue or this filter passes vacuously').toBeGreaterThan(0);
    expect([...new Set(backlog.body.map((issue) => issue.status))]).toEqual(['backlog']);

    const mine = await probe<PaperclipIssue[]>(
      companyIssues(`assigneeAgentId=${fixture.agents.main.id}&limit=25`),
      fixture.reconcilerKey,
    );
    expect(mine.status).toBe(200);
    expect(mine.body.length).toBeGreaterThan(0);
    expect([...new Set(mine.body.map((issue) => issue.assigneeAgentId))]).toEqual([fixture.agents.main.id]);

    // The literal string `null` is the unassigned filter, which is why the type
    // is `string | 'null'` rather than a plain uuid.
    const unassigned = await probe<PaperclipIssue[]>(companyIssues('assigneeAgentId=null&limit=25'), fixture.reconcilerKey);
    expect(unassigned.status).toBe(200);
    expect(unassigned.body.length).toBeGreaterThan(0);
    expect([...new Set(unassigned.body.map((issue) => issue.assigneeAgentId))]).toEqual([null]);

    const children = await probe<PaperclipIssue[]>(companyIssues(`parentId=${parent.id}&limit=25`), fixture.reconcilerKey);
    expect(children.status).toBe(200);
    expect(children.body.map((issue) => issue.id)).toEqual([child.body.id]);

    // How the three filters reject a bad value is NOT uniform, and the ACL has
    // to know: assigneeAgentId is a clean 422, an unknown status is a silent
    // empty 200, and a malformed parentId reaches the query and comes back a
    // 500 - so that one must be validated before it is ever forwarded.
    const malformedAssignee = await probe<PaperclipErrorBody>(
      companyIssues('assigneeAgentId=not-a-uuid'),
      fixture.reconcilerKey,
    );
    expectErrorEnvelope(malformedAssignee);
    expect(errorOf(malformedAssignee.body)).toBe("assigneeAgentId must be a UUID or 'null'");

    const malformedParent = await probe<PaperclipErrorBody>(companyIssues('parentId=not-a-uuid'), fixture.reconcilerKey);
    expectErrorEnvelope(malformedParent);

    const unknownStatus = await probe<PaperclipIssue[]>(companyIssues('status=nonsense&limit=5'), fixture.reconcilerKey);
    expectCharacterized('listFilterValidation', {
      'assigneeAgentId=<not a uuid>': outcomeOf(malformedAssignee),
      'parentId=<not a uuid>': outcomeOf(malformedParent),
      'status=<not a status>': {
        ...outcomeOf(unknownStatus),
        rows: Array.isArray(unknownStatus.body) ? unknownStatus.body.length : null,
      },
    });
  }, 60_000);

  it('A1-5: view=compact is an ETagged projection that still carries every field the projection reads', async () => {
    await createdUnassignedIssue(`A1-5 compact ${Date.now()}`);
    const compact = await probe<Array<Record<string, unknown>>>(
      companyIssues('view=compact&limit=2'),
      fixture.reconcilerKey,
    );
    expect(compact.status).toBe(200);
    expect(Array.isArray(compact.body)).toBe(true);
    expect(compact.body.length).toBeGreaterThan(0);
    // The compact row is a genuinely different projection - it drops roughly a
    // third of the full row - so "the projection can read it" has to be proven
    // here too and not inferred from the detail response.
    for (const field of PROJECTION_FIELDS) {
      expect(compact.body[0], `the compact projection drops ${field}`).toHaveProperty(field);
    }

    // A1-10: every list response carries the in-flight coalescer's marker.
    expect(typeof compact.headers.get('x-paperclip-request-cache')).toBe('string');
    expect(compact.headers.get('cache-control')).toBe('private, must-revalidate');
    const etag = compact.headers.get('etag');
    expect(etag, 'view=compact must answer with an ETag or the 304 path is unreachable').toBeTruthy();

    const revalidate = async (tag: string): Promise<ProbeResult<unknown>> => probe<unknown>(
      companyIssues('view=compact&limit=2'),
      fixture.reconcilerKey,
      { headers: { 'if-none-match': tag } },
    );
    // A background wakeup landing between the two reads changes the board and
    // therefore the ETag, so one retry against the fresh tag keeps this
    // deterministic instead of racing an unrelated write.
    let revalidated = await revalidate(etag as string);
    if (revalidated.status === 200) revalidated = await revalidate(revalidated.headers.get('etag') ?? (etag as string));
    expect(revalidated.status).toBe(304);
  });

  it('A1-11 (BLOCKING): the checkout and release contract strings, observed rather than transcribed', async () => {
    // A1-11 requires these strings mapped in one place FROM PROVEN TEXT. Two of
    // the three are produced here. The pause pair is not reachable without
    // driving a project budget to its hard stop, so `types.ts` marks those two
    // UNVERIFIED rather than typing prose as if it were measured.
    const researchRunId = await acquireRunId(fixture.agents.research);
    const target = await createdUnassignedIssue(`A1-11 checkout as another agent ${Date.now()}`);
    const impersonation = await probe<PaperclipErrorBody>(
      `/api/issues/${target.id}/checkout`,
      fixture.agents.research.key,
      {
        method: 'POST',
        headers: { [PAPERCLIP_RUN_ID_HEADER]: researchRunId },
        body: JSON.stringify({ agentId: fixture.agents.main.id, expectedStatuses: ['todo', 'backlog'] }),
      },
    );
    expect(impersonation.status).toBe(403);
    expectErrorEnvelope(impersonation);
    expect(errorOf(impersonation.body)).toBe('Agent can only checkout as itself');

    // Release takes no validated body - the agent id comes from the actor - but
    // it does demand a run id, which is the half C-3 could not settle for it.
    const releaseTarget = await createdUnassignedIssue(`A1-11 release ${Date.now()}`);
    const runless = await probe<PaperclipErrorBody>(
      `/api/issues/${releaseTarget.id}/release`,
      fixture.agents.main.key,
      { method: 'POST' },
    );
    expect(runless.status).toBe(401);
    expect(errorOf(runless.body)).toBe('Agent run id required');

    const released = await probe<PaperclipIssue>(`/api/issues/${releaseTarget.id}/release`, fixture.agents.main.key, {
      method: 'POST',
      headers: runHeaders(),
    });
    expect(released.status, `release failed: ${describeFailure(released)}`).toBe(200);
    expect(released.body.id).toBe(releaseTarget.id);
    // This is what makes `PaperclipReleaseResponse = PaperclipIssue` a
    // measurement rather than a guess.
    for (const field of PROJECTION_FIELDS) {
      expect(released.body, `the release response is an issue row; it must carry ${field}`).toHaveProperty(field);
    }

    // The two conflict shapes the parser must tell apart from the pause pair.
    const statusConflict = await probe<PaperclipErrorBody>(
      `/api/issues/${releaseTarget.id}/checkout`,
      fixture.agents.main.key,
      {
        method: 'POST',
        headers: runHeaders(),
        body: JSON.stringify({ agentId: fixture.agents.main.id, expectedStatuses: ['done'] }),
      },
    );
    expect(statusConflict.status).toBe(409);
    expectErrorEnvelope(statusConflict);

    const emptyExpected = await probe<PaperclipErrorBody>(
      `/api/issues/${releaseTarget.id}/checkout`,
      fixture.agents.main.key,
      {
        method: 'POST',
        headers: runHeaders(),
        body: JSON.stringify({ agentId: fixture.agents.main.id, expectedStatuses: [] }),
      },
    );
    expect(emptyExpected.status, 'expectedStatuses is non-empty by schema').toBe(400);
    expectErrorEnvelope(emptyExpected);

    expectCharacterized('checkoutReleaseContract', {
      'POST /api/issues/{id}/checkout as another agent': outcomeOf(impersonation),
      'POST /api/issues/{id}/release run-less': outcomeOf(runless),
      'POST /api/issues/{id}/release holding a run id': outcomeOf(released),
      'POST /api/issues/{id}/checkout with an unmatched expectedStatuses': outcomeOf(statusConflict),
      'POST /api/issues/{id}/checkout with an empty expectedStatuses': outcomeOf(emptyExpected),
    });
  }, 60_000);

  it('A1-6 (BLOCKING): comments default to desc, and the cursor pages are acted on', async () => {
    const issue = await createdIssue(`A1-6 comment order ${Date.now()}`);
    // Five, not two: `limit` and the cursor cannot be told apart from a
    // silently-ignored param on a page short enough that the full list IS the
    // answer. A1-8's trap applies here with force - `GET
    // /api/issues/{id}/comments` declares NO query parameter but its own `id` in
    // the committed OpenAPI snapshot, so every name below is unimplemented until
    // a probe watches the server act on it.
    const posted: PaperclipIssueComment[] = [];
    for (let index = 0; index < 5; index += 1) {
      const created = await postComment(issue.id, `A1-6 comment ${index}`);
      expect(created.status, `comment creation failed: ${describeFailure(created)}`).toBeLessThan(300);
      posted.push(created.body);
      // The cursor orders on the stored stamp; same-millisecond siblings would
      // make "older than the anchor" ambiguous, which is a different contract.
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    const commentPage = async (query = ''): Promise<ProbeResult<PaperclipIssueComment[]>> =>
      probe<PaperclipIssueComment[]>(
        `/api/issues/${issue.id}/comments${query ? `?${query}` : ''}`,
        fixture.reconcilerKey,
      );
    const idsOf = (result: ProbeResult<PaperclipIssueComment[]>): string[] =>
      (Array.isArray(result.body) ? result.body : []).map((comment) => comment.id);

    const defaultOrder = await commentPage();
    expect(defaultOrder.status).toBe(200);
    expect(Array.isArray(defaultOrder.body)).toBe(true);
    expect(defaultOrder.body).toHaveLength(posted.length);
    expect(defaultOrder.body[0]?.id, 'the default page must start at the NEWEST comment').toBe(posted[4].id);

    // Every field `PaperclipIssueComment` types, asserted on a live row.
    const newest = defaultOrder.body[0];
    expect(typeof newest.id).toBe('string');
    expect(newest.body).toBe('A1-6 comment 4');
    expect(Number.isNaN(new Date(newest.createdAt).getTime()), 'createdAt must parse as a date').toBe(false);

    const ascending = await commentPage('order=asc');
    expect(ascending.status).toBe(200);
    expect(ascending.body[0]?.id).toBe(posted[0].id);

    // `limit` is ACTED ON, not ignored: with five comments on the issue a page
    // of two can only come from the server honouring it.
    const limited = await commentPage('limit=2');
    expect(limited.status).toBe(200);
    expect(
      idsOf(limited),
      'limit=2 returned the whole thread, so `limit` is silently ignored here and PaperclipCommentsQuery.limit is a lie',
    ).toEqual(idsOf(defaultOrder).slice(0, 2));

    // The cursor, and the alias claim. The anchor is the MIDDLE row of the
    // observed default page, so "older than the anchor" is derived from what the
    // server returned rather than from an assumption about its ordering.
    const anchorIndex = 2;
    const anchor = defaultOrder.body[anchorIndex];
    const olderThanAnchor = idsOf(defaultOrder).slice(anchorIndex + 1);
    expect(olderThanAnchor.length, 'the anchor must have rows on both sides of it').toBeGreaterThan(0);

    const afterPage = await commentPage(`after=${anchor.id}`);
    expect(afterPage.status).toBe(200);
    expect(
      idsOf(afterPage),
      'after=<id> returned the whole thread, so the cursor is silently ignored and a paging caller re-reads page 1 forever',
    ).toEqual(olderThanAnchor);
    expect(idsOf(afterPage), 'the cursor row itself must not be replayed').not.toContain(anchor.id);

    const afterCommentIdPage = await commentPage(`afterCommentId=${anchor.id}`);
    expect(afterCommentIdPage.status).toBe(200);
    expect(
      idsOf(afterCommentIdPage),
      'afterCommentId is documented as an ALIAS of after; it selected a different page',
    ).toEqual(idsOf(afterPage));

    // Both names on one request, so the precedence is recorded rather than
    // guessed at. Nothing in `types.ts` claims a winner beyond what this records.
    const bothNames = await commentPage(`after=${anchor.id}&afterCommentId=${posted[0].id}`);

    // A1-8's trap, measured on THIS route rather than inferred from the issue
    // list: an unimplemented name is a silent 200 carrying the full thread, and
    // `limit=0` - a 400 on the issue list - is silently ignored here too.
    const unknownParam = await commentPage('zzzUnknown=1');
    const zeroLimit = await commentPage('limit=0');

    expectCharacterized('commentPagination', {
      'comments on the issue': posted.length,
      'GET /api/issues/{id}/comments': { ...outcomeOf(defaultOrder), rows: idsOf(defaultOrder).length },
      'GET /api/issues/{id}/comments?limit=2': { ...outcomeOf(limited), rows: idsOf(limited).length },
      'GET /api/issues/{id}/comments?after=<middle row>': { ...outcomeOf(afterPage), rows: idsOf(afterPage).length },
      'GET /api/issues/{id}/comments?afterCommentId=<middle row>': {
        ...outcomeOf(afterCommentIdPage),
        rows: idsOf(afterCommentIdPage).length,
      },
      'GET /api/issues/{id}/comments?after=<middle row>&afterCommentId=<oldest row>': {
        ...outcomeOf(bothNames),
        rows: idsOf(bothNames).length,
        'matches the after=<middle row> page': idsOf(bothNames).join(',') === idsOf(afterPage).join(','),
      },
      'GET /api/issues/{id}/comments?zzzUnknown=1': { ...outcomeOf(unknownParam), rows: idsOf(unknownParam).length },
      'GET /api/issues/{id}/comments?limit=0': { ...outcomeOf(zeroLimit), rows: idsOf(zeroLimit).length },
    });
  }, 60_000);

  it('A1-13: replaying an idempotencyKey yields one issue and deduplicated: true', async () => {
    // Deterministic by construction, never random: the server retains keys for
    // seven days and a random key would create a duplicate on every retry.
    const idempotencyKey = `netzar-contract-a1-13:${fixture.companyId}:${Date.now()}`;
    const body = { idempotencyKey, allowDuplicate: true };

    const first = await createIssue(`A1-13 idempotent create ${idempotencyKey}`, body);
    expect(first.status, `first create failed: ${describeFailure(first)}`).toBeLessThan(300);

    const replay = await createIssue(`A1-13 idempotent create ${idempotencyKey}`, body);
    expect(replay.status, 'a replayed key is a SUCCESS, not a conflict').toBe(200);
    expect(replay.body.id, 'the replay must resolve to the same issue').toBe(first.body.id);
    expect(replay.body.deduplicated).toBe(true);
    expect(first.body.deduplicated).not.toBe(true);
  });

  it('A1-12: /wakeup discriminates on the body, never on the status code', async () => {
    const run = await probe<PaperclipWakeupResponse>(
      `/api/agents/${fixture.agents.main.id}/wakeup`,
      fixture.agents.main.key,
      { method: 'POST', body: JSON.stringify({ source: 'on_demand', reason: 'A1-12 run branch' }) },
    );

    // The skip is PRODUCED, not waited for: naming an issue id that does not
    // resolve inside this company drives the wakeup down the skipped branch
    // every time. Accepting whichever body happened to arrive is how the
    // skipped envelope stayed unobserved while looking probed.
    const skipped = await probe<PaperclipWakeupResponse>(
      `/api/agents/${fixture.agents.main.id}/wakeup`,
      fixture.agents.main.key,
      {
        method: 'POST',
        body: JSON.stringify({
          source: 'on_demand',
          reason: 'A1-12 skipped branch',
          // A real uuid that is a Paperclip agent, never an issue - so the
          // lookup misses without fabricating an identifier.
          payload: { issueId: fixture.agents.main.id },
        }),
      },
    );

    // THE CLAIM A1-12 ACTUALLY MAKES, asserted; the value it originally guessed,
    // recorded. What matters is that both outcomes share one status code, so the
    // code discriminates nothing - that is assertable without naming it. The
    // number itself is recorded below instead, because the bar's own correction
    // to A1-12 says the first written claim about it was wrong and because the
    // committed OpenAPI snapshot declares a different value again (200, plus
    // 400/401/403) for this very operation.
    expect(run.status, `the run branch was not a success: ${describeFailure(run)}`).toBeLessThan(300);
    expect(skipped.status, `the skipped branch was not a success: ${describeFailure(skipped)}`).toBeLessThan(300);
    expect(
      skipped.status,
      'the two branches answered with DIFFERENT status codes, so the code now carries information A1-12 says it does not; re-derive the client before trusting the body discriminant',
    ).toBe(run.status);

    // The trap, asserted rather than described: BOTH bodies carry a `status`
    // key, so `'status' in body` classifies a successful wakeup as a skip.
    expect('status' in run.body, "'status' in body cannot discriminate: the run row carries one too").toBe(true);
    expect('status' in skipped.body).toBe(true);

    // The sound discriminant, in both directions. `'reason' in body` is the whole
    // test: it is the only one that also narrows the union at compile time, and
    // unlike a status-value check it rests on nothing this suite has not seen.
    // The run's own status is RECORDED below, never asserted against a list -
    // an earlier revision checked it against an eight-member union assembled
    // from no source at all, which would have gone red against correct server
    // behaviour the moment a wakeup landed as anything but the first member.
    expect(run.body.status).not.toBe('skipped');
    expect('reason' in run.body, 'the run row carries no reason; that is what makes it the runtime test').toBe(false);
    expect(skipped.body.status).toBe('skipped');
    expect('reason' in skipped.body).toBe(true);

    // The narrowing uses the discriminant `types.ts` prescribes, and it is the
    // only one available: `status === 'skipped'` no longer narrows this union
    // now that the run's own status is an open string rather than an invented
    // eight-member enum. That the compiler now insists on the `in` test is the
    // point - it is the test whose two halves are asserted on lines 989 and 991.
    if (!('reason' in skipped.body)) throw new Error('unreachable: asserted above');
    expect(typeof skipped.body.reason).toBe('string');
    expect(typeof skipped.body.message).toBe('string');
    expect(skipped.body.issueId, 'the skipped envelope echoes the issue id it could not resolve')
      .toBe(fixture.agents.main.id);
    for (const field of WAKEUP_SKIPPED_FIELDS) {
      expect(skipped.body, `the skipped envelope must carry ${field}`).toHaveProperty(field);
    }

    // Every field `PaperclipHeartbeatRun` types, asserted on the live run row.
    const runBody = run.body as PaperclipHeartbeatRun;
    for (const field of HEARTBEAT_RUN_FIELDS) {
      expect(runBody, `PaperclipHeartbeatRun types ${field}; the live run row must carry it`).toHaveProperty(field);
    }
    expect(runBody.companyId).toBe(fixture.companyId);
    expect(runBody.agentId).toBe(fixture.agents.main.id);
    // `source` was sent, so echoing it is a contract this probe may assert.
    expect(runBody.invocationSource).toBe('on_demand');
    expect(typeof runBody.id).toBe('string');
    expect(Number.isNaN(new Date(runBody.createdAt).getTime())).toBe(false);

    // Everything about this route that NOTHING in the research read specifies,
    // recorded rather than asserted: the status code both branches share, the
    // triggerDetail the server picks when the request omits it, the skip reason,
    // and the lifecycle status a freshly created run carries. Each is plausible,
    // each goes red on drift, and none of them is asserted - a plausible value
    // asserted from nowhere is exactly the tier confusion that made A1-12 wrong
    // in the first place, and `PaperclipHeartbeatRunStatus` is open precisely
    // because the last of these is the only member of it anything has observed.
    expectCharacterized('wakeupDefaults', {
      'status code on the run branch': run.status,
      'status code on the skipped branch': skipped.status,
      'triggerDetail when the request omits it': runBody.triggerDetail,
      'reason on a skip whose issueId does not resolve': skipped.body.reason,
      'status on the run row a fresh wakeup returns': runBody.status,
    });
  }, 60_000);

  it('A1-17 (CHARACTERIZATION): boardMutationGuard across all five write shapes with an agent key', async () => {
    // Each shape gets its own fresh issue so one write cannot contaminate the
    // next - a work product posted after a checkout on the SAME issue answers
    // 409 for run-ownership reasons that have nothing to do with the guard.
    const key = fixture.agents.main.key;
    const headers = runHeaders();
    expect(Object.keys(headers), 'A1-17 needs a genuine run id to reach the guard on the run-gated shapes')
      .toEqual([PAPERCLIP_RUN_ID_HEADER]);

    const patchTarget = await createdUnassignedIssue(`A1-17 patch target ${Date.now()}`);
    const commentTarget = await createdUnassignedIssue(`A1-17 comment target ${Date.now()}`);
    const checkoutTarget = await createdUnassignedIssue(`A1-17 checkout target ${Date.now()}`);
    const workProductTarget = await createdUnassignedIssue(`A1-17 work product target ${Date.now()}`);

    const writes: Array<{ shape: string; result: ProbeResult<unknown> }> = [
      {
        shape: 'POST /api/companies/{companyId}/issues',
        result: await createIssue(`A1-17 create ${Date.now()}`),
      },
      {
        shape: 'PATCH /api/issues/{id}',
        result: await probe(`/api/issues/${patchTarget.id}`, key, {
          method: 'PATCH',
          headers,
          body: JSON.stringify({ title: `A1-17 patched ${Date.now()}` }),
        }),
      },
      {
        shape: 'POST /api/issues/{id}/comments',
        result: await probe(`/api/issues/${commentTarget.id}/comments`, key, {
          method: 'POST',
          headers,
          body: JSON.stringify({ body: 'A1-17 guard characterization comment' }),
        }),
      },
      {
        shape: 'POST /api/issues/{id}/checkout',
        result: await probe(`/api/issues/${checkoutTarget.id}/checkout`, key, {
          method: 'POST',
          headers,
          body: JSON.stringify({ agentId: fixture.agents.main.id, expectedStatuses: ['todo', 'backlog'] }),
        }),
      },
      {
        shape: 'POST /api/issues/{id}/work-products',
        result: await probe<PaperclipWorkProduct>(`/api/issues/${workProductTarget.id}/work-products`, key, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            type: 'document',
            provider: 'netzar',
            title: 'A1-17 guard characterization artifact',
          }),
        }),
      },
    ];

    for (const { shape, result } of writes) {
      expectNotServerError(shape, result);
      expectErrorEnvelope(result);
      // The guard sits in front of every /api route. If it ever rejects an
      // agent-actor mutation, that rejection must be in the committed record
      // rather than passing as an anonymous non-2xx.
      expect(
        `${errorOf(result.body) ?? ''}`.toLowerCase(),
        `${shape} failed with an unrecorded boardMutationGuard rejection`,
      ).not.toContain('mutation');
    }

    expectCharacterized('boardMutationGuard', writes.map(({ shape, result }) => ({
      shape,
      status: result.status,
      error: errorOf(result.body) ?? null,
    })));

    // Every field `PaperclipWorkProduct` types, asserted on the live 201.
    const workProduct = writes[4].result.body as PaperclipWorkProduct;
    expect(writes[4].result.status).toBe(201);
    expect(workProduct.issueId).toBe(workProductTarget.id);
    expect(workProduct.type).toBe('document');
    expect(workProduct.provider).toBe('netzar');
    expect(workProduct.title).toBe('A1-17 guard characterization artifact');
    expect(typeof workProduct.id).toBe('string');
    expect(typeof workProduct.status).toBe('string');
  }, 60_000);

  it('C-3 (CHARACTERIZATION): which agent write shapes require X-Paperclip-Run-Id', () => {
    // The requirement is per-route AND per-issue-state: checkout always needs a
    // run, while `POST /api/issues/{id}/work-products` needs one only while the
    // issue has a live execution run. The ACL must therefore treat "Agent run
    // id required" as a runtime answer, not a compile-time property of a route.
    for (const [route, outcome] of Object.entries(runIdBoundary.routes)) {
      // Whatever the answer, a 401 here can only be the run-id guard, and its
      // string is the one the ACL must map to a typed error.
      if (outcome.requiresRunId) expect(outcome.error, route).toBe('Agent run id required');
      // A run-less write that is not a 401 must not be a run-id failure wearing
      // a different code, or the ACL would degrade to wakeup for no reason.
      if (!outcome.requiresRunId) expect(outcome.error ?? '', route).not.toContain('run id');
    }

    // A1-3: an empty header buys nothing - it is rejected exactly like an
    // absent one - which is why the client omits the header instead.
    const runless = runIdBoundary.routes['POST /api/issues/{id}/checkout'];
    expect(
      runIdBoundary.emptyHeader,
      'an empty X-Paperclip-Run-Id must be treated exactly like an absent one',
    ).toEqual({ status: runless.status, error: runless.error });

    expectCharacterized('runIdBoundary', runIdBoundary);
  });

  it('R4 (CHARACTERIZATION): does a comment move the parent issue updatedAt', async () => {
    const created = await createdIssue(`R4 comment touches updatedAt ${Date.now()}`);
    const before = await probe<PaperclipIssue>(`/api/issues/${created.id}`, fixture.reconcilerKey);
    expect(before.status).toBe(200);

    const comment = await postComment(created.id, 'R4: does this move the parent updatedAt');
    expect(comment.status, `comment creation failed: ${describeFailure(comment)}`).toBeLessThan(300);

    const after = await probe<PaperclipIssue>(`/api/issues/${created.id}`, fixture.reconcilerKey);
    expect(after.status).toBe(200);

    const beforeMs = new Date(before.body.updatedAt).getTime();
    const afterMs = new Date(after.body.updatedAt).getTime();
    expect(Number.isNaN(beforeMs)).toBe(false);
    expect(Number.isNaN(afterMs)).toBe(false);
    // The invariant that holds either way: updatedAt never moves backwards.
    expect(afterMs).toBeGreaterThanOrEqual(beforeMs);

    const moved = afterMs > beforeMs;
    expectCharacterized('commentMovesIssueUpdatedAt', {
      moved,
      consequence: moved
        ? 'the reconciler sees comment activity through the updatedSince watermark'
        : 'the reconciler is BLIND to comment activity; comments need their own read path',
    });
  });

  it('C-2 (BLOCKING): a truncated watermark loses rows, and overlap-and-dedupe delivers them exactly once', async () => {
    // The vendored patch compiles `updatedAt >= watermark + 1ms` while
    // updatedAt stores microseconds and callers only ever see millisecond
    // truncation. Every issue this probe writes is UNASSIGNED, so no assignment
    // wakeup follows the create and moves `updatedAt` out from under the
    // `(id, updatedAt)` key the dedupe is keyed on.
    const poll = async (since: Date): Promise<PaperclipIssue[]> => {
      const result = await probe<PaperclipIssue[]>(
        companyIssues(`updatedSince=${encodeURIComponent(since.toISOString())}&sortField=updated&sortDir=asc&limit=${ISSUE_LIST_MAX_LIMIT}`),
        fixture.reconcilerKey,
      );
      expect(result.status).toBe(200);
      return result.body;
    };

    // PART 1, the hazard, proven with ONE row and no race at all. A row's own
    // truncated stamp T names an instant at or before its true updatedAt, and
    // the server's predicate starts at T + 1ms, so a poller that stores T and
    // re-queries with it can never see that row again - nor any sibling written
    // in the same millisecond that its page did not already contain. This is
    // deterministic: it does not depend on two writes racing.
    const anchor = await createdUnassignedIssue(`C-2 truncation anchor ${Date.now()}`);
    const atOwnStamp = await poll(new Date(anchor.updatedAt));
    expect(
      atOwnStamp.map((issue) => issue.id),
      'a row re-queried at its own truncated updatedAt came back, so the +1ms predicate is not what this build compiles; re-derive the reconciler predicate before trusting the overlap below',
    ).not.toContain(anchor.id);

    const withOverlap = await poll(new Date(new Date(anchor.updatedAt).getTime() - POLL_OVERLAP_MS));
    expect(
      withOverlap.map((issue) => issue.id),
      'subtracting the poll overlap did not recover the row, so overlap-and-dedupe is not the fix',
    ).toContain(anchor.id);

    // PART 2, the same-millisecond siblings, and it is MANDATORY. The artifact
    // exposes no write that timestamps two issues in one transaction, so the
    // collision is hunted rather than commanded - but a hunt that shrugs and
    // passes when it loses the race proves nothing and hides the day the hunt
    // itself breaks. It retries until it reproduces one, and fails loudly if the
    // budget runs out.
    const written: PaperclipIssue[] = [];
    let collided: [PaperclipIssue, PaperclipIssue] | undefined;
    for (let attempt = 0; attempt < COLLISION_ATTEMPTS && !collided; attempt += 1) {
      const batch = await Promise.all(Array.from(
        { length: COLLISION_BATCH },
        (_unused, index) => createdUnassignedIssue(`C-2 same-millisecond ${attempt}-${index} ${Date.now()}`),
      ));
      written.push(...batch);
      const byStamp = new Map<string, PaperclipIssue[]>();
      for (const issue of batch) byStamp.set(issue.updatedAt, [...(byStamp.get(issue.updatedAt) ?? []), issue]);
      const siblings = [...byStamp.values()].find((group) => group.length > 1);
      if (siblings) collided = [siblings[0], siblings[1]];
    }
    expect(
      collided,
      `no two of ${written.length} concurrent writes shared a millisecond across ${COLLISION_ATTEMPTS} batches, so the sibling hazard was never reproduced and C-2 is unproven. On this harness a batch of ${COLLISION_BATCH} collides roughly two times in three; a run that reaches this line has a different write path or a different clock resolution, and the reconciler's overlap must be re-derived rather than assumed.`,
    ).toBeDefined();

    // The naive watermark - a poller storing the row's own truncated stamp -
    // must return NEITHER sibling: the predicate starts one millisecond after
    // the stamp they share, so both are lost, not just the one already seen.
    const naive = await poll(new Date(collided![0].updatedAt));
    const naiveIds = new Set(naive.map((issue) => issue.id));
    expect(
      naiveIds.has(collided![0].id) || naiveIds.has(collided![1].id),
      'the naive watermark unexpectedly returned a same-millisecond sibling; re-derive the reconciler predicate before trusting this',
    ).toBe(false);

    // PART 3, the fix, exercised the way the reconciler will run it: two
    // OVERLAPPING polls, then one dedupe across both. A single response can
    // never contain a duplicate, so deduping inside one page proves nothing.
    const mine = [anchor, ...written];
    const key = (issue: PaperclipIssue): string => `${issue.id}@${issue.updatedAt}`;

    // The second watermark is this probe's own high-water mark, not the whole
    // page's. The reconciler's rule is the same shape either way - advance to the
    // newest row processed, then re-poll from that minus the overlap - but the
    // board is shared and mutating, so an unrelated background write landing in
    // the first page would push the second window PAST every row written here
    // and leave the dedupe claim below vacuously true.
    const start = new Date(anchor.updatedAt).getTime();
    const advanced = mine.reduce((max, issue) => Math.max(max, new Date(issue.updatedAt).getTime()), start);
    // Without this the two polls can degenerate into the SAME query: if nothing
    // this probe wrote is newer than the anchor, `advanced === start`, the union
    // is one page doubled, and both the overlap count and the teeth-assertion
    // below pass without two genuinely different windows ever being compared.
    expect(
      advanced,
      'the collision batch did not land after the anchor, so the second poll would repeat the first and prove nothing',
    ).toBeGreaterThan(start);
    const firstPoll = await poll(new Date(start - POLL_OVERLAP_MS));
    const secondPoll = await poll(new Date(advanced - POLL_OVERLAP_MS));

    const union = [...firstPoll, ...secondPoll];
    const delivered = new Map<string, number>();
    for (const issue of union) delivered.set(key(issue), (delivered.get(key(issue)) ?? 0) + 1);
    expect(
      union.length - delivered.size,
      'the two polls did not overlap, so cross-poll dedupe was never exercised',
    ).toBeGreaterThan(0);

    // Dedupe on `(id, updatedAt)` exactly as the reconciler will: keep the first
    // sighting of each key, drop the rest.
    const survivors = new Map<string, number>();
    const kept = new Set<string>();
    for (const issue of union) {
      if (kept.has(key(issue))) continue;
      kept.add(key(issue));
      survivors.set(key(issue), (survivors.get(key(issue)) ?? 0) + 1);
    }

    // THE CLAIM WITH TEETH, and the reason the two counts above are separate.
    // "Exactly once" is only worth asserting if dedupe was asked to collapse a
    // row it HAD to collapse: at least one row this probe wrote must arrive
    // twice across the two polls and leave the dedupe once. Asserting presence
    // in a Set built from the union - which was what stood here - restates the
    // line before it and cannot fail.
    const collapsed = mine.filter((issue) => (delivered.get(key(issue)) ?? 0) > 1);
    expect(
      collapsed.length,
      'the polls overlapped, but over no row this probe wrote, so nothing it wrote was ever deduped and "exactly once" would be vacuous',
    ).toBeGreaterThan(0);

    for (const issue of mine) {
      expect(delivered.get(key(issue)), `${issue.identifier} must be delivered by the overlapping polls`).toBeGreaterThan(0);
      expect(survivors.get(key(issue)), `overlap-and-dedupe must yield ${issue.identifier} exactly once`).toBe(1);
    }
  }, 120_000);

  it('A1-10 (BLOCKING): the search 429 - Retry-After, retryAfterSeconds and the X-RateLimit headers', async () => {
    // A1-10 shape (a), and the first probe in this suite ever to SEE a 429. The
    // bar asserted `retryAfterSeconds`, `Retry-After` and the X-RateLimit pair
    // from a source read, and `types.ts` carried the field on that authority
    // alone until this probe existed. Everything below is observed.
    const search = (query: string): string =>
      `/api/companies/${fixture.companyId}/search?q=${encodeURIComponent(query)}`;
    const extract = (query: string): string =>
      `/api/companies/${fixture.companyId}/search/extract?contains=${encodeURIComponent(query)}`;

    // The bucket is in-memory and per (company, agent actor), so the documented
    // reset gives every run a full one. A run that starts already drained - a
    // re-run against a warm harness - honours the header rather than failing on
    // it, which is the client behaviour A1-10 is about; the window is 60s, so
    // this waits at most once and never in a reset run.
    let opening = await probe<Record<string, unknown>>(search('paperclip'), fixture.reconcilerKey);
    if (opening.status === 429) {
      const retryAfter = Number(opening.headers.get('retry-after'));
      expect(Number.isFinite(retryAfter), 'a 429 without a parseable Retry-After cannot be honoured').toBe(true);
      await sleep((retryAfter + 1) * 1_000);
      opening = await probe<Record<string, unknown>>(search('paperclip'), fixture.reconcilerKey);
    }
    expect(opening.status, `search is not reachable: ${describeFailure(opening)}`).toBe(200);

    // THE HEADERS RIDE ON THE SUCCESS, which is what makes them useful: a client
    // can back off before it is refused rather than after.
    const advertisedLimit = Number(opening.headers.get('x-ratelimit-limit'));
    expect(advertisedLimit, 'a 200 from search must advertise X-RateLimit-Limit').toBeGreaterThan(0);
    const openingRemaining = Number(opening.headers.get('x-ratelimit-remaining'));
    expect(openingRemaining).toBeGreaterThanOrEqual(0);
    expect(openingRemaining).toBeLessThan(advertisedLimit);

    // /search and /search/extract share ONE bucket - the second route's
    // remaining picks up where the first left off, it does not reset.
    const extracted = await probe<Record<string, unknown>>(extract('paperclip'), fixture.reconcilerKey);
    expect(extracted.status, `search/extract is not reachable: ${describeFailure(extracted)}`).toBe(200);
    expect(
      Number(extracted.headers.get('x-ratelimit-remaining')),
      'the two search routes must draw on one bucket',
    ).toBeLessThan(openingRemaining);

    // THE BAR IS WRONG ABOUT "EVERY RESPONSE". A1-10 says the X-RateLimit pair
    // rides on every search response; a request rejected by validation never
    // reaches the limiter and carries neither header - so a client that reads
    // its budget off an arbitrary response reads `null`, not a number.
    const unvalidated = await probe<PaperclipErrorBody>(
      `/api/companies/${fixture.companyId}/search/extract`,
      fixture.reconcilerKey,
    );
    expect(unvalidated.status).toBe(400);
    expectErrorEnvelope(unvalidated);
    expect(unvalidated.headers.get('x-ratelimit-limit'), 'a validation 400 precedes the limiter').toBeNull();

    // Drain it. Serial, because the point is the bucket and not a race.
    let refused: ProbeResult<PaperclipErrorBody> | undefined;
    let spent = 0;
    for (; spent < advertisedLimit + SEARCH_DRAIN_HEADROOM && !refused; spent += 1) {
      const next = await probe<PaperclipErrorBody>(search('paperclip'), fixture.reconcilerKey);
      if (next.status === 429) refused = next;
      else expect(next.status, `search answered neither 200 nor 429: ${describeFailure(next)}`).toBe(200);
    }
    expect(
      refused,
      `${advertisedLimit + SEARCH_DRAIN_HEADROOM} serial searches did not exhaust a bucket advertising ${advertisedLimit}; A1-10's search 429 is UNREACHABLE on this artifact and no client may be written against it`,
    ).toBeDefined();

    expectErrorEnvelope(refused!);
    expect(errorOf(refused!.body)).toBe('Search rate limit exceeded');
    // The body field `types.ts` types. It is a NUMBER, and the header is its
    // decimal string - a client may read either and must get the same seconds.
    expect(typeof refused!.body.retryAfterSeconds).toBe('number');
    expect(refused!.body.retryAfterSeconds!).toBeGreaterThan(0);
    expect(refused!.headers.get('retry-after')).toBe(String(refused!.body.retryAfterSeconds));
    expect(refused!.headers.get('x-ratelimit-remaining')).toBe('0');
    expect(Number(refused!.headers.get('x-ratelimit-limit'))).toBe(advertisedLimit);
    // No `code`: A1-11's rule applies here too. The string is the only handle,
    // so it is matched in the parser and nowhere else.
    expect(refused!.body.code).toBeUndefined();

    // The refusal covers BOTH routes, so a client that falls back from /search
    // to /search/extract is refused identically instead of finding a side door.
    const extractRefused = await probe<PaperclipErrorBody>(extract('paperclip'), fixture.reconcilerKey);
    expect(extractRefused.status).toBe(429);
    expect(errorOf(extractRefused.body)).toBe('Search rate limit exceeded');

    // AND IT IS SCOPED TO THE ACTOR, not the company: a drained reconciler does
    // not stall a second agent. `reconcilerKey` and `agents.main.key` are two
    // keys on ONE agent, so this needs the research agent to say anything.
    const otherActor = await probe<Record<string, unknown>>(search('paperclip'), fixture.agents.research.key);
    expect(
      otherActor.status,
      'a second agent was refused too, so the search bucket is broader than one actor and one slow reader stalls the board',
    ).toBe(200);

    // Recorded, not asserted: `retryAfterSeconds` counts down inside the window
    // so its value is never the same twice, and the limit is a tunable.
    expectCharacterized('searchRateLimit', {
      'GET /api/companies/{companyId}/search': {
        limit: advertisedLimit,
        rateLimitHeadersOnSuccess: true,
        sharedBucketWithExtract: true,
        drainedAfterSerialRequests: spent <= advertisedLimit + SEARCH_DRAIN_HEADROOM,
        refusal: { status: refused!.status, error: errorOf(refused!.body) ?? null },
        retryAfterHeaderMatchesBodyField: true,
        scopedToActor: 'agent',
      },
      'GET /api/companies/{companyId}/search/extract': {
        requiresContains: outcomeOf(unvalidated),
        rateLimitHeadersOnValidation400: false,
      },
    });
  }, 180_000);

  it('A1-10 (BLOCKING): the issue-list retry is a coalescer, not a rate limit, and identical reads never trip it', async () => {
    // A1-10 shape (b). It is a DIFFERENT mechanism from the search bucket and
    // the bar's remedy for it is wrong in a way that matters: it says the
    // reconciler must avoid "parallel identical list requests". Identical
    // requests are exactly the safe case - they coalesce onto one computation.
    // What trips the refusal is the number of DISTINCT list reads in flight for
    // one actor, so a sweep that fans out over offsets is the hazard and a sweep
    // that repeats one query is not.
    const listQuery = `limit=${ISSUE_LIST_MAX_LIMIT}&sortField=updated&sortDir=asc`;

    const identical = await Promise.all(Array.from(
      { length: COALESCER_IDENTICAL },
      () => probe<PaperclipIssue[] | PaperclipErrorBody>(companyIssues(listQuery), fixture.reconcilerKey),
    ));
    expect(
      identical.filter((result) => result.status !== 200).map((result) => describeFailure(result)),
      `${COALESCER_IDENTICAL} identical concurrent list reads must all be answered; if any is refused the coalescer is not what this build runs`,
    ).toEqual([]);
    const identicalCache = identical.map((result) => result.headers.get('x-paperclip-request-cache'));
    // Every list response carries the marker - that half of A1-10 is true.
    expect(identicalCache.filter((value) => value === null)).toEqual([]);
    expect(
      identicalCache.filter((value) => value === 'coalesced').length,
      'no response was marked coalesced, so the identical reads were served independently and this probe proves nothing about the coalescer',
    ).toBeGreaterThan(0);

    // Now the hazard: distinct keys, same actor. `offset` is the cheapest key
    // to vary and the A1-5 probe already proved the server acts on it.
    const distinct = await Promise.all(Array.from(
      { length: COALESCER_DISTINCT },
      (_unused, index) => probe<PaperclipIssue[] | PaperclipErrorBody>(
        companyIssues(`${listQuery}&offset=${index}`),
        fixture.reconcilerKey,
      ),
    ));
    const refusedIndex = distinct.findIndex((result) => result.status === 429);
    expect(
      refusedIndex,
      `${COALESCER_DISTINCT} concurrent DISTINCT list reads for one actor were all served, so the in-flight ceiling A1-10 describes is not enforced on this artifact and no client may be written against it`,
    ).toBeGreaterThanOrEqual(0);
    expect(
      distinct.filter((result) => result.status === 200).length,
      'every concurrent read was refused; the ceiling admits some or the reconciler can never make progress',
    ).toBeGreaterThan(0);

    const retry = distinct[refusedIndex] as ProbeResult<PaperclipErrorBody>;
    expectErrorEnvelope(retry);
    expect(errorOf(retry.body)).toBe('Too many concurrent issue-list requests for this actor/client');
    expect(typeof retry.body.retryAfterSeconds).toBe('number');
    expect(retry.body.retryAfterSeconds!).toBeGreaterThan(0);
    expect(retry.headers.get('retry-after')).toBe(String(retry.body.retryAfterSeconds));
    // THE TWO SHAPES ARE TOLD APART BY THEIR HEADERS, not just their strings:
    // this one carries the request-cache marker and NO X-RateLimit pair, so a
    // client that reads a rate-limit budget here reads nothing.
    expect(retry.headers.get('x-paperclip-request-cache')).toBe('retry');
    expect(retry.headers.get('x-ratelimit-limit'), 'the coalescer is not a rate limiter').toBeNull();

    // Honour it, the way the client must: wait the advertised seconds, re-issue
    // the SAME read serially, and it is answered. Cheap here - the coalescer
    // advertises a single-digit wait, unlike the search window.
    await sleep(retry.body.retryAfterSeconds! * 1_000);
    const honoured = await probe<PaperclipIssue[]>(
      companyIssues(`${listQuery}&offset=${refusedIndex}`),
      fixture.reconcilerKey,
    );
    expect(honoured.status, `honouring Retry-After must clear the refusal: ${describeFailure(honoured)}`).toBe(200);
    expect(Array.isArray(honoured.body), 'A1-5: the list is a bare array').toBe(true);

    expectCharacterized('issueListCoalescer', {
      'GET /api/companies/{companyId}/issues': {
        identicalConcurrentReads: COALESCER_IDENTICAL,
        identicalConcurrentRefusals: 0,
        distinctConcurrentReads: COALESCER_DISTINCT,
        refusal: { status: retry.status, error: errorOf(retry.body) ?? null },
        retryAfterSeconds: retry.body.retryAfterSeconds ?? null,
        requestCacheHeaderOnRefusal: 'retry',
        rateLimitHeadersOnRefusal: false,
        clearedByHonouringRetryAfter: true,
      },
    });
  }, 180_000);

  it('A1-15: GET /api/openapi.json is snapshotted, and it types no response field', async () => {
    const document = await probe<Record<string, unknown>>('/api/openapi.json', fixture.reconcilerKey);
    expect(document.status).toBe(200);
    expect(document.body).toBeTruthy();

    if (UPDATE_MODE) {
      await writeFile(OPENAPI_SNAPSHOT, `${JSON.stringify(document.body, null, 2)}\n`, 'utf8');
      console.log('[A1-15] openapi.snapshot.json regenerated from the live pinned artifact; commit it.');
      return;
    }

    // A1-15: the snapshot is the request-shape contract, so an artifact bump
    // that changes any shape must be a visible diff, not a surprise at runtime.
    const snapshot = JSON.parse(await readFile(OPENAPI_SNAPSHOT, 'utf8')) as Record<string, unknown>;
    expect(snapshot.$placeholder, 'the committed snapshot is a placeholder, not a snapshot').toBeUndefined();
    // Cheap first: a structural comparison of a 700 KB document is slow, and
    // only worth paying for the readable diff when it has actually drifted.
    if (JSON.stringify(document.body) !== JSON.stringify(snapshot)) expect(document.body).toEqual(snapshot);

    const paths = snapshot.paths as Record<string, Record<string, unknown>>;
    for (const [method, template] of INTEGRATION_ROUTES) {
      expect(paths[template]?.[method], `${method.toUpperCase()} ${template} is absent from the OpenAPI document`).toBeDefined();
    }

    // The half of A1-15 the artifact cannot honour, pinned so it cannot be
    // forgotten: every response this integration reads is declared as an opaque
    // object, so `types.ts` may only widen a response type from a probe. A bump
    // that starts typing these turns this red, which is the signal to revisit.
    for (const [method, template] of OPAQUE_RESPONSE_ROUTES) {
      const operation = paths[template][method] as { responses: Record<string, { content?: Record<string, { schema?: Record<string, unknown> }> }> };
      const success = operation.responses['200'] ?? operation.responses['201'];
      const schema = success?.content?.['application/json']?.schema ?? {};
      expect(schema.properties, `${method.toUpperCase()} ${template} now declares response fields`).toBeUndefined();
      expect(schema.additionalProperties, `${method.toUpperCase()} ${template} is no longer an opaque object`).toEqual({});
    }

    // THE OTHER HALF OF THE NARROWING, and the reason `types.ts` claims the
    // document is authoritative for request body field names, security and route
    // existence and for NOTHING ELSE. Two counterexamples, pinned here so the
    // claim cannot quietly widen back:
    //
    // (a) parameters. The issue list declares exactly two - `companyId` and
    //     `view` - while the route reads far more of them. `updatedSince`, the
    //     whole reason A1-8 exists, is absent from the document entirely, and
    //     `offset`, `limit`, `sortField`, `sortDir`, `status`, `assigneeAgentId`
    //     and `parentId` are all proven acted on by probes above.
    const issueList = paths['/api/companies/{companyId}/issues'].get as { parameters?: unknown[] };
    expect(
      (issueList.parameters ?? []).map((parameter) => (parameter as { name?: string }).name).sort(),
      'the document now declares more issue-list parameters; re-read the A1-15 narrowing in types.ts before widening it',
    ).toEqual(['companyId', 'view']);
    expect(JSON.stringify(issueList), 'updatedSince is absent from the document; the patch is the only evidence it exists')
      .not.toContain('updatedSince');

    // (b) `required`. The create body declares `status` required, and every
    //     create probe in this file omits it and is answered 201 - which is what
    //     entitles `createdUnassignedIssue` to rely on the backlog default.
    const createSchema = (paths['/api/companies/{companyId}/issues'].post as {
      requestBody: { content: Record<string, { schema: { required?: string[] } }> };
    }).requestBody.content['application/json'].schema;
    expect(
      createSchema.required,
      "the document's `required` list is not the artifact's: `status` is declared required and omitting it is a 201",
    ).toContain('status');

    // `/api/health` is the one route the document does type, so it is the one
    // place the bar's "the field must exist in the snapshot" rule is real.
    const health = paths['/api/health'].get as { responses: Record<string, { content: Record<string, { schema: { properties: Record<string, unknown> } }> }> };
    const healthFields = health.responses['200'].content['application/json'].schema.properties;
    for (const field of DOCUMENTED_HEALTH_FIELDS) {
      expect(healthFields, `PaperclipHealthOk types ${field}; the document must declare it`).toHaveProperty(field);
    }
  }, 120_000);

  it('route reachability: every documented integration point responds and the projection fields are present', async () => {
    const issue = await createdIssue(`reachability ${Date.now()}`);
    const routes: Array<[string, string]> = [
      ['GET /api/health', '/api/health'],
      ['GET /api/openapi.json', '/api/openapi.json'],
      ['GET /api/companies', '/api/companies'],
      ['GET /api/companies/{companyId}', `/api/companies/${fixture.companyId}`],
      ['GET /api/companies/{companyId}/issues', companyIssues('limit=1')],
      ['GET /api/companies/{companyId}/issues/count', `/api/companies/${fixture.companyId}/issues/count`],
      ['GET /api/companies/{companyId}/agents', `/api/companies/${fixture.companyId}/agents`],
      ['GET /api/companies/{companyId}/approvals', `/api/companies/${fixture.companyId}/approvals`],
      ['GET /api/companies/{companyId}/activity', `/api/companies/${fixture.companyId}/activity`],
      ['GET /api/agents/me', '/api/agents/me'],
      ['GET /api/agents/{id}', `/api/agents/${fixture.agents.main.id}`],
      ['GET /api/issues/{id}', `/api/issues/${issue.id}`],
      ['GET /api/issues/{id}/comments', `/api/issues/${issue.id}/comments`],
      ['GET /api/issues/{id}/work-products', `/api/issues/${issue.id}/work-products`],
      ['GET /api/issues/{id}/approvals', `/api/issues/${issue.id}/approvals`],
      ['GET /api/issues/{id}/activity', `/api/issues/${issue.id}/activity`],
      ['GET /api/issues/{id}/runs', `/api/issues/${issue.id}/runs`],
      ['GET /api/issues/{issueId}/live-runs', `/api/issues/${issue.id}/live-runs`],
      ['GET /api/issues/{issueId}/active-run', `/api/issues/${issue.id}/active-run`],
    ];

    const reachability: Array<{ route: string; status: number; error: string | null }> = [];
    for (const [route, path] of routes) {
      const result = await probe<unknown>(path, fixture.reconcilerKey);
      reachability.push({ route, status: result.status, error: errorOf(result.body) ?? null });
      expectErrorEnvelope(result);
      expectNotServerError(route, result);
      // A1-1: a path this integration builds must never be a 404 route miss.
      expect(errorOf(result.body), `${route} is not a mounted route`).not.toBe('API route not found');
    }
    expectCharacterized('routeReachability', reachability);

    // The projection's read set, asserted against a live detail response. A
    // field missing here breaks `issueToMission` at runtime, not at compile time.
    const detail = await probe<Record<string, unknown>>(`/api/issues/${issue.id}`, fixture.reconcilerKey);
    expect(detail.status).toBe(200);
    for (const field of PROJECTION_FIELDS) {
      expect(detail.body, `the projection reads ${field} off the detail response`).toHaveProperty(field);
    }

    // And against a LIST row, which is the surface the reconciler actually
    // projects from. The list is a different code path - `view=compact` proves
    // the route has more than one - so proving the detail response carries a
    // field says nothing about the rows a sweep will hand the projection.
    const listed = await probe<Array<Record<string, unknown>>>(
      companyIssues('limit=1&sortField=updated&sortDir=desc'),
      fixture.reconcilerKey,
    );
    expect(listed.status).toBe(200);
    expect(listed.body.length, 'the board must be non-empty or the list assertion is vacuous').toBeGreaterThan(0);
    for (const field of PROJECTION_FIELDS) {
      expect(listed.body[0], `the reconciler projects from LIST rows; the list row must carry ${field}`).toHaveProperty(field);
    }
  }, 120_000);

  it('characterized: /issues/count is an attention query, not a totals endpoint', async () => {
    // A1-5 says board totals come from this route. They do not: without
    // `attention=blocked` it is a 400, and with it the number is a count of
    // blocked issues. Paging to a short page is the only way to size a board.
    const bare = await probe<PaperclipErrorBody>(`/api/companies/${fixture.companyId}/issues/count`, fixture.reconcilerKey);
    expectErrorEnvelope(bare);
    const blocked = await probe<{ count?: number }>(
      `/api/companies/${fixture.companyId}/issues/count?attention=blocked`,
      fixture.reconcilerKey,
    );
    expect(blocked.status).toBe(200);
    expect(typeof blocked.body.count, 'the attention query answers with a numeric count').toBe('number');

    // The reconciler key is an AGENT key, and the company list is board-only.
    const companies = await probe<PaperclipErrorBody>('/api/companies', fixture.reconcilerKey);
    expectErrorEnvelope(companies);

    expectCharacterized('boardOnlyAndCountRoutes', {
      'GET /api/companies/{companyId}/issues/count': outcomeOf(bare),
      'GET /api/companies/{companyId}/issues/count?attention=blocked': { status: blocked.status, error: null },
      'GET /api/companies': outcomeOf(companies),
    });
  }, 60_000);
});
