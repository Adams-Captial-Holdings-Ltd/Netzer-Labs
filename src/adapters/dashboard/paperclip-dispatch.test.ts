/**
 * `POST /api/paperclip/dispatch`: the C-17 shared-secret gate, the kill switch,
 * shape rejection, the unknown-actor cross-check, duplicate suppression, and
 * the one property the whole route exists for — the 202 lands BEFORE the work
 * promise settles.
 *
 * Every dependency is injected, so nothing here touches DynamoDB, Bedrock or
 * Paperclip.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFile } from 'node:fs/promises';
import { Hono } from 'hono';
import type { PaperclipDispatchContext } from '../../lib/paperclip/types.js';

// The default `claim` wiring is the one dependency this file does NOT inject in
// the wiring test below: `deps.claim` defaulting to `tryClaimOnce` is what turns
// the tested route branch into durable, cross-task dedupe, and an injected-only
// default would rot unnoticed. `tryClaimOnce`'s own behaviour (the
// attribute_not_exists(PK)-only condition, the ConditionalCheckFailedException
// -> false mapping, the fail-open branch, the CLAIM# item shape) is pinned in
// src/lib/state/runner-lease.test.ts.
const { claimOnce, releaseOnce } = vi.hoisted(() => ({
  claimOnce: vi.fn(() => Promise.resolve(true)),
  releaseOnce: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../lib/state/runner-lease.js', () => ({
  tryClaimOnce: claimOnce,
  releaseClaimOnce: releaseOnce,
}));

import type { AgentTurnResponse, TurnRefusal } from '../../agent/agent-loop.js';
import type { MissionEngine } from '../../lib/paperclip/mission-engine.js';
import type { ProjectedMission } from '../../lib/paperclip/mission-projection.js';
import { parsePaperclipError } from '../../lib/paperclip/error.js';
import { dispatchClaimKey, runDispatchWork } from '../../lib/paperclip/dispatch-worker.js';
import {
  DISPATCH_CLAIM_TTL_SECONDS,
  buildPaperclipDispatchRouter,
  verifyDispatchSecret,
  type PaperclipDispatchDeps,
} from './paperclip-dispatch.js';

beforeEach(() => {
  claimOnce.mockClear();
  claimOnce.mockResolvedValue(true);
});

const SECRET = 'dispatch-secret-value';
const ISSUE_ID = 'a1b2c3d4-0000-4000-8000-000000000001';
const RUN_ID = '11111111-2222-4333-8444-555555555555';

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { netzarAgentId: 'main', issueId: ISSUE_ID, runId: RUN_ID, ...overrides };
}

function app(deps: PaperclipDispatchDeps = {}): Hono {
  const a = new Hono();
  a.route(
    '/api/paperclip',
    buildPaperclipDispatchRouter({
      secret: () => SECRET,
      killSwitch: () => Promise.resolve({ active: false }),
      knownAgents: () => ['main', 'research'],
      enabledAgents: () => Promise.resolve(['main']),
      claim: () => Promise.resolve(true),
      work: () => Promise.resolve(),
      ...deps,
    }),
  );
  return a;
}

async function post(a: Hono, init: { auth?: string; raw?: string; json?: unknown } = {}): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (init.auth !== undefined) headers.authorization = init.auth;
  return a.request('/api/paperclip/dispatch', {
    method: 'POST',
    headers,
    body: init.raw ?? JSON.stringify(init.json ?? body()),
  });
}

describe('the 202 ack (the reason this route is not POST /api/test-turn)', () => {
  it('answers 202 BEFORE the work promise settles', async () => {
    // Paperclip's adapter budget is `timeoutMs: 10_000` (agentSpecs()), which a
    // tool-looping turn blows. The work promise below never settles at all; the
    // response must still arrive.
    let started = false;
    let release = (): void => {};
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const res = await post(
      app({
        work: () => {
          started = true;
          return pending;
        },
      }),
      { auth: `Bearer ${SECRET}` },
    );
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true, accepted: true, issueId: ISSUE_ID });
    expect(started, 'the work was never started').toBe(true);
    release();
  });
});

describe('C-17 shared-secret authentication (never the human capability model)', () => {
  it('401s an absent bearer', async () => {
    const res = await post(app());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
  });

  it('401s a wrong bearer, and a bearer of the wrong length', async () => {
    expect((await post(app(), { auth: 'Bearer wrong-secret-value' })).status).toBe(401);
    expect((await post(app(), { auth: `Bearer ${SECRET}x` })).status).toBe(401);
  });

  it('401s with reason no_secret when the secret is unset or a placeholder, and never fails open', async () => {
    // env.ts declares PAPERCLIP_DISPATCH_SECRET as optionalNonPlaceholder(), so
    // '' and REPLACE_ME both arrive here as undefined. Break-glass for a broken
    // secret is DISABLE INGRESS, never "accept unsigned traffic".
    const res = await post(app({ secret: () => undefined }), { auth: `Bearer ${SECRET}` });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized', reason: 'no_secret' });
  });

  it('does no work and reads no switch state for an unauthenticated caller', async () => {
    let worked = false;
    let switchRead = false;
    await post(
      app({
        killSwitch: () => {
          switchRead = true;
          return Promise.resolve({ active: false });
        },
        work: () => {
          worked = true;
          return Promise.resolve();
        },
      }),
      { auth: 'Bearer nope' },
    );
    expect(worked).toBe(false);
    expect(switchRead, 'an unauthenticated caller must not be able to probe switch state').toBe(false);
  });

  it('compares timing-safely, length-guarded (timingSafeEqual throws on a length mismatch)', () => {
    expect(verifyDispatchSecret(SECRET, SECRET)).toBe(true);
    expect(verifyDispatchSecret('short', SECRET)).toBe(false);
    expect(verifyDispatchSecret(undefined, SECRET)).toBe(false);
    expect(verifyDispatchSecret(SECRET, undefined)).toBe(false);
    expect(verifyDispatchSecret('', '')).toBe(false);
  });
});

describe('paperclip_disabled', () => {
  it('503s when the switch is on, after authenticating and before enqueuing anything', async () => {
    let worked = false;
    const res = await post(
      app({
        killSwitch: () => Promise.resolve({ active: true, reason: 'incident 42' }),
        work: () => {
          worked = true;
          return Promise.resolve();
        },
      }),
      { auth: `Bearer ${SECRET}` },
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'paperclip_disabled', reason: 'incident 42' });
    expect(worked, 'a switched-off integration must not take the work').toBe(false);
  });
});

describe('malformed and unusable bodies', () => {
  it('400s invalid JSON', async () => {
    const res = await post(app(), { auth: `Bearer ${SECRET}`, raw: '{not json' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_json' });
  });

  it('400s a well-formed body missing a required field', async () => {
    for (const missing of ['netzarAgentId', 'issueId', 'runId']) {
      const payload = body();
      delete payload[missing];
      const res = await post(app(), { auth: `Bearer ${SECRET}`, json: payload });
      expect(res.status, `a body with no ${missing} was accepted`).toBe(400);
      expect(await res.json()).toEqual({
        error: 'invalid_body',
        required: ['netzarAgentId', 'issueId', 'runId'],
      });
    }
  });

  it('404s an unknown agent — in-band identity is a claim, never a fact', async () => {
    const res = await post(app(), {
      auth: `Bearer ${SECRET}`,
      json: body({ netzarAgentId: 'not-an-agent' }),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'unknown_agent', netzarAgentId: 'not-an-agent' });
  });

  it('202-ignores a known agent an operator has not armed in paperclip/enabled_agents', async () => {
    // A 4xx here would make Paperclip fail the run over a deliberate
    // configuration choice, so this is reject-vs-ignore, not an error.
    let worked = false;
    const res = await post(app({ work: () => { worked = true; return Promise.resolve(); } }), {
      auth: `Bearer ${SECRET}`,
      json: body({ netzarAgentId: 'research' }),
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true, ignored: 'agent_not_enabled' });
    expect(worked).toBe(false);
  });
});

describe('duplicate (runId, issueId) delivery', () => {
  it('is a NO-OP answering 202 {deduplicated:true}, and NEVER a 4xx', async () => {
    let worked = 0;
    const res = await post(
      app({
        claim: () => Promise.resolve(false),
        work: () => {
          worked += 1;
          return Promise.resolve();
        },
      }),
      { auth: `Bearer ${SECRET}` },
    );
    expect(res.status).toBe(202);
    expect(res.status, 'a 4xx would make the adapter retry or fail the run').toBeLessThan(400);
    expect(await res.json()).toEqual({ ok: true, deduplicated: true });
    expect(worked).toBe(0);
  });

  it('DEFAULTS to the durable tryClaimOnce claim, keyed PAPERCLIP_DISPATCH#<runId>#<issueId>', async () => {
    // `claim` is deliberately left un-injected here. A module-level Set could
    // not satisfy this acceptance item at all — the orchestrator autoscales, so
    // the two deliveries of one dispatch can land on two Fargate tasks — and the
    // route branch that answers 202 {deduplicated:true} is only as durable as
    // the primitive it defaults to.
    const res = await post(app({ claim: undefined }), { auth: `Bearer ${SECRET}` });
    expect(res.status).toBe(202);
    expect(claimOnce).toHaveBeenCalledWith(
      `PAPERCLIP_DISPATCH#${RUN_ID}#${ISSUE_ID}`,
      DISPATCH_CLAIM_TTL_SECONDS,
    );
    expect(DISPATCH_CLAIM_TTL_SECONDS).toBe(86_400);
  });

  it('a false from the default claim is the 202 {deduplicated:true} branch end to end', async () => {
    claimOnce.mockResolvedValue(false);
    let worked = 0;
    const res = await post(
      app({ claim: undefined, work: () => { worked += 1; return Promise.resolve(); } }),
      { auth: `Bearer ${SECRET}` },
    );
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true, deduplicated: true });
    expect(worked, 'a redelivery must not run the turn a second time').toBe(0);
  });

  it('claims on the (runId, issueId) pair, so two revisions of one issue are distinct', async () => {
    const claimed: PaperclipDispatchContext[] = [];
    const a = app({
      claim: (ctx) => {
        claimed.push(ctx);
        return Promise.resolve(true);
      },
    });
    await post(a, { auth: `Bearer ${SECRET}` });
    await post(a, { auth: `Bearer ${SECRET}`, json: body({ runId: 'a-second-run' }) });
    expect(claimed.map((c) => c.dedupeKey)).toEqual([
      `${RUN_ID}#${ISSUE_ID}`,
      `a-second-run#${ISSUE_ID}`,
    ]);
  });
});

/**
 * THE ROUTE AND THE WORKER, COMPOSED. Every other suite in this file injects
 * `claim` and `work` independently, which is exactly why the loss channel could
 * hide between them: the route took a 24-hour claim before the work ran, and the
 * worker — built never to reject — swallowed every failure after the 202. The
 * two guarantees below are one property and cannot be stated apart:
 *
 *   a genuinely CONCURRENT duplicate must still produce exactly one run, AND
 *   a dispatch that failed transiently must be retryable by a redelivery.
 *
 * So this suite wires the real `runDispatchWork` to the real route, over one
 * in-memory claim store that both halves share.
 */
describe('the claim survives a concurrent duplicate and does NOT survive a transient failure', () => {
  /**
   * `take` is `tryClaimOnce`'s attribute_not_exists(PK) put — first caller wins,
   * every later one loses. `drop` is `releaseClaimOnce`'s unconditional delete.
   */
  function claimStore(): {
    held: Set<string>;
    take: (key: string) => Promise<boolean>;
    drop: (key: string) => Promise<void>;
  } {
    const held = new Set<string>();
    return {
      held,
      take: (key) => {
        if (held.has(key)) return Promise.resolve(false);
        held.add(key);
        return Promise.resolve(true);
      },
      drop: (key) => {
        held.delete(key);
        return Promise.resolve();
      },
    };
  }

  const projected = {
    id: ISSUE_ID,
    identifier: 'NZR-1',
    ownerAgent: 'main',
    createdByAgent: 'paperclip',
    createdByChat: 'paperclip',
    title: 'Ship the thing',
    body: 'Details of the thing.',
    priority: 50,
    status: 'open',
    createdAt: '2026-08-21T00:00:00.000Z',
    updatedAt: '2026-08-21T00:00:00.000Z',
    bodyTruncated: false,
  } as ProjectedMission;

  const stubEngine = {
    listMissions: () => Promise.resolve([]),
    getMission: () => Promise.resolve(projected),
    createMission: () => Promise.resolve(projected),
    setStatus: () => Promise.resolve(projected),
    reassign: () => Promise.resolve(projected),
    comment: () => Promise.resolve(),
  } as unknown as MissionEngine;

  const turn = (): AgentTurnResponse => ({
    text: 'done',
    modelId: 'test-model',
    costUsd: 0,
    latencyMs: 1,
    inputTokens: 1,
    outputTokens: 1,
    toolCallCount: 0,
  });

  const upstream5xx = (): unknown =>
    parsePaperclipError(new Error('bad gateway'), { status: 503, body: { error: 'upstream' } });

  /** The route, wired to the REAL worker over `store`. */
  function composed(
    store: ReturnType<typeof claimStore>,
    runTurn: () => Promise<AgentTurnResponse>,
  ): { app: Hono; settled: () => Promise<unknown> } {
    const inFlight: Array<Promise<void>> = [];
    return {
      app: app({
        claim: (ctx) => store.take(dispatchClaimKey(ctx)),
        work: (ctx) => {
          const p = runDispatchWork(ctx, {
            engine: stubEngine,
            runTurn,
            getSessionFn: () => Promise.resolve(null),
            appendTurnsFn: () => Promise.resolve(),
            releaseClaim: (c) => store.drop(dispatchClaimKey(c)),
          });
          inFlight.push(p);
          return p;
        },
      }),
      settled: () => Promise.all(inFlight),
    };
  }

  it('two dispatches racing at the same instant still produce EXACTLY ONE run', async () => {
    const store = claimStore();
    let runs = 0;
    const { app: a, settled } = composed(store, () => {
      runs += 1;
      return Promise.resolve(turn());
    });

    const [first, second] = await Promise.all([
      post(a, { auth: `Bearer ${SECRET}` }),
      post(a, { auth: `Bearer ${SECRET}` }),
    ]);
    await settled();

    const bodies = [await first.json(), await second.json()];
    expect(runs, 'one (runId, issueId) ran the turn twice').toBe(1);
    expect(bodies).toContainEqual({ ok: true, accepted: true, issueId: ISSUE_ID });
    expect(bodies).toContainEqual({ ok: true, deduplicated: true });
  });

  it('a RELEASED claim is retryable, while a duplicate of a COMPLETED dispatch is still refused', async () => {
    const store = claimStore();
    let attempts = 0;
    // First delivery: a 503 from the far side, after the 202 has gone out.
    // Second: it works. Third: nothing should run at all.
    const { app: a, settled } = composed(store, () => {
      attempts += 1;
      return attempts === 1 ? Promise.reject(upstream5xx()) : Promise.resolve(turn());
    });

    const first = await post(a, { auth: `Bearer ${SECRET}` });
    expect(await first.json()).toEqual({ ok: true, accepted: true, issueId: ISSUE_ID });
    await settled();
    expect(
      store.held.size,
      'the transient failure kept the claim, so the dispatch ended here for 24 hours',
    ).toBe(0);

    const retry = await post(a, { auth: `Bearer ${SECRET}` });
    expect(
      await retry.json(),
      'the redelivery was deduplicated instead of retried — the loss channel',
    ).toEqual({ ok: true, accepted: true, issueId: ISSUE_ID });
    await settled();
    expect(attempts, 'the redelivery did not actually run the turn').toBe(2);

    const duplicate = await post(a, { auth: `Bearer ${SECRET}` });
    expect(await duplicate.json()).toEqual({ ok: true, deduplicated: true });
    await settled();
    expect(attempts, 'a duplicate of a COMPLETED dispatch ran the turn a third time').toBe(2);
    expect(store.held.size, 'a successful dispatch must keep its claim').toBe(1);
  });

  it('a RETRYABLE REFUSAL is retryable end to end: the redelivery actually runs the turn', async () => {
    // The refusal that RETURNS instead of throwing. Nothing rejects, so the
    // worker's catch never runs and the claim used to be kept exactly as if the
    // dispatch had completed — a one-minute maintenance freeze consumed the
    // dispatch for 24 hours. This is that end to end: two deliveries, the first
    // refused by the freeze, the second answering for real.
    const store = claimStore();
    let attempts = 0;
    const { app: a, settled } = composed(store, () => {
      attempts += 1;
      return Promise.resolve(
        attempts === 1
          ? {
              ...turn(),
              text: 'Sessions are temporarily frozen for maintenance. Your message was not processed. Please try again shortly.',
              modelId: '',
              refusal: { kind: 'sessions_frozen', retryable: true },
            }
          : turn(),
      );
    });

    const first = await post(a, { auth: `Bearer ${SECRET}` });
    expect(await first.json()).toEqual({ ok: true, accepted: true, issueId: ISSUE_ID });
    await settled();
    expect(store.held.size, 'the freeze kept the claim; the dispatch ended here for 24 hours').toBe(
      0,
    );

    const redelivery = await post(a, { auth: `Bearer ${SECRET}` });
    expect(
      await redelivery.json(),
      'the redelivery was deduplicated instead of retried once the freeze lifted',
    ).toEqual({ ok: true, accepted: true, issueId: ISSUE_ID });
    await settled();
    expect(attempts, 'the redelivery did not actually run the turn').toBe(2);
    expect(store.held.size, 'a completed dispatch must keep its claim').toBe(1);
  });

  it('a HYPOTHETICAL non-retryable refusal stays terminal, so the redelivery is still deduplicated', async () => {
    // DELIBERATELY NOT THE KILL PHRASE. `kill_phrase` is the only
    // `retryable: false` kind in today's union and it cannot reach a dispatch:
    // the worker declares no `origin`, so its turn is `origin: 'machine'` and
    // the kill-phrase gate never runs — board text must not be able to halt the
    // fleet or be told that it did (src/lib/paperclip/dispatch-kill-phrase.test.ts).
    // What this pins is the routing rule itself, which reads `retryable` and
    // never `kind`: a terminal refusal keeps the claim exactly as a
    // deterministic throw does, because replaying it can only end the same way.
    const store = claimStore();
    let attempts = 0;
    const { app: a, settled } = composed(store, () => {
      attempts += 1;
      return Promise.resolve({
        ...turn(),
        text: 'This request cannot be processed and will not be retried.',
        modelId: '',
        refusal: { kind: 'future_terminal_kind', retryable: false } as unknown as TurnRefusal,
      });
    });

    await post(a, { auth: `Bearer ${SECRET}` });
    await settled();
    expect(store.held.size, 'a terminal refusal released the claim').toBe(1);

    const redelivery = await post(a, { auth: `Bearer ${SECRET}` });
    expect(await redelivery.json()).toEqual({ ok: true, deduplicated: true });
    await settled();
    expect(attempts).toBe(1);
  });

  it('a DETERMINISTIC failure keeps the claim, so the redelivery is still deduplicated', async () => {
    // A 401 replays identically forever. Retrying it would burn a fresh agent
    // turn against the daily cap on every redelivery and never succeed.
    const store = claimStore();
    let attempts = 0;
    const { app: a, settled } = composed(store, () => {
      attempts += 1;
      return Promise.reject(
        parsePaperclipError(new Error('nope'), { status: 401, body: { error: 'nope' } }),
      );
    });

    await post(a, { auth: `Bearer ${SECRET}` });
    await settled();
    expect(store.held.size, 'a deterministic failure released the claim').toBe(1);

    const redelivery = await post(a, { auth: `Bearer ${SECRET}` });
    expect(await redelivery.json()).toEqual({ ok: true, deduplicated: true });
    await settled();
    expect(attempts).toBe(1);
  });
});

describe('mount position is behavior, not style', () => {
  it('mounts /api/paperclip BEFORE the /api dashboard catch-all in server.ts', async () => {
    // The dashboard router opens with router.use('*'), which extracts a bearer,
    // calls authenticateDashboardToken and on failure 401s AND writes an
    // auth_failure audit row. Paperclip's bearer is not a dashboard-tokens row,
    // so a mount after it would 401 every dispatch and spam the audit log.
    const server = await readFile(new URL('../../server.ts', import.meta.url), 'utf8');
    const paperclip = server.indexOf("app.route('/api/paperclip'");
    const catchAll = server.indexOf("app.route('/api', buildDashboardRouter())");
    expect(paperclip, '/api/paperclip is not mounted at all').toBeGreaterThan(-1);
    expect(catchAll).toBeGreaterThan(-1);
    expect(paperclip).toBeLessThan(catchAll);
  });

  it('adds no capability and no role — C-17 kept permissions.ts out of scope', async () => {
    const route = await readFile(new URL('./paperclip-dispatch.ts', import.meta.url), 'utf8');
    // Comment lines are excluded: the file NAMES permissions.ts to say it is
    // untouched, which is documentation, not a dependency.
    const code = route
      .split(/\r?\n/)
      .filter((line) => !/^\s*(\*|\/\/)/.test(line))
      .join('\n');
    expect(code).not.toMatch(/hasCapability|requiredRole|authz-matrix|auth\/permissions/);
  });
});
