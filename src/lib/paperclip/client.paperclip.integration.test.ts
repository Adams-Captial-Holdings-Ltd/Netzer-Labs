import { readdir, readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  bootstrapPaperclip,
  readPaperclipLogsSince,
  type PaperclipBootstrap,
} from '../../../tests/fixtures/paperclip-bootstrap.js';
import { PAPERCLIP_RUN_ID_HEADER } from './types.js';

interface PaperclipIssue {
  id: string;
  updatedAt: string;
}

async function requestJson<T>(
  fixture: PaperclipBootstrap,
  path: string,
  token: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(`${fixture.baseUrl}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...init.headers,
    },
  });
  if (!response.ok) {
    throw new Error(`Paperclip request ${path} returned HTTP ${response.status}`);
  }
  return await response.json() as T;
}

async function createIssue(
  fixture: PaperclipBootstrap,
  title: string,
  extra: Record<string, unknown> = {},
): Promise<PaperclipIssue> {
  return requestJson<PaperclipIssue>(
    fixture,
    `/api/companies/${fixture.companyId}/issues`,
    fixture.agents.main.key,
    {
      method: 'POST',
      body: JSON.stringify({
        title,
        description: 'Paperclip integration contract probe',
        priority: 'medium',
        ...extra,
      }),
    },
  );
}

async function createAssignedIssue(
  fixture: PaperclipBootstrap,
  title: string,
  extra: Record<string, unknown> = {},
): Promise<PaperclipIssue> {
  return createIssue(fixture, title, { assigneeAgentId: fixture.agents.main.id, ...extra });
}

// These contracts need the disposable Paperclip harness (docker-compose.
// paperclip.yml) and PAPERCLIP_TEST_AUTH_SECRET in the process environment —
// the same variable Compose itself refuses to start without. The shared
// LocalStack integration lane (CI and `npm run test:integration`) has
// neither, so gate on the secret: armed harness runs the contracts for real
// (`npm run test:paperclip:all`), everything else skips them visibly instead
// of failing inside the fixture's docker invocation.
describe.skipIf(!process.env.PAPERCLIP_TEST_AUTH_SECRET)('Paperclip pinned-image contracts', () => {
  let fixture: PaperclipBootstrap;

  beforeAll(async () => {
    fixture = await bootstrapPaperclip();
  }, 120_000);

  it('I3: updatedSince is a strict greater-than watermark', async () => {
    // Both assertions below are EXACT SETS - zero rows, then one specific row -
    // so they only hold while nothing else on this board moves inside the
    // window. The board is shared: `tests/contract/paperclip-routes.paperclip.
    // integration.test.ts` writes dozens of issues and fires real wakeups
    // against the same company, and a background heartbeat landing here would
    // turn an exact-set assertion red for a reason that has nothing to do with
    // the watermark. Scope the read to a throwaway parent, the way the contract
    // suite's own offset probe does, so the set is this test's rows and no
    // others.
    const parent = await createIssue(fixture, `I3 watermark scope ${Date.now()}`);
    const issue = await createAssignedIssue(fixture, `I3 strict watermark ${Date.now()}`, { parentId: parent.id });
    const updatedAt = new Date(issue.updatedAt);
    expect(Number.isNaN(updatedAt.getTime())).toBe(false);

    const listFrom = async (watermark: string): Promise<PaperclipIssue[]> => {
      const query = new URLSearchParams({
        parentId: parent.id,
        updatedSince: watermark,
        sortField: 'updated',
        sortDir: 'asc',
        limit: '500',
      });
      return requestJson<PaperclipIssue[]>(
        fixture,
        `/api/companies/${fixture.companyId}/issues?${query.toString()}`,
        fixture.reconcilerKey,
      );
    };

    const atWatermark = await listFrom(issue.updatedAt);
    expect(atWatermark).toHaveLength(0);

    const oneMillisecondBefore = new Date(updatedAt.getTime() - 1).toISOString();
    const beforeWatermark = await listFrom(oneMillisecondBefore);
    expect(beforeWatermark).toEqual([expect.objectContaining({ id: issue.id })]);
  });

  it('FI-4: a fabricated run id passes the header guard and reaches the heartbeat FK', async () => {
    const issue = await createAssignedIssue(fixture, `FI-4 fabricated run ${Date.now()}`);
    const fabricatedRunId = '00000000-0000-4000-8000-000000000000';
    const logStart = new Date(Date.now() - 1_000).toISOString();
    const response = await fetch(`${fixture.baseUrl}/api/issues/${issue.id}/checkout`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${fixture.agents.main.key}`,
        'content-type': 'application/json',
        // A1-3: the spelling is pinned once, in `types.ts`. Hard-coding the
        // literal here is the one place a header rename would go unnoticed.
        [PAPERCLIP_RUN_ID_HEADER]: fabricatedRunId,
      },
      body: JSON.stringify({
        agentId: fixture.agents.main.id,
        expectedStatuses: ['todo'],
      }),
    });
    const responseBody = await response.text();

    expect(response.status).not.toBe(401);
    expect([409, 500]).toContain(response.status);

    let evidence = responseBody;
    for (let attempt = 0; attempt < 30 && !/\b23503\b/.test(evidence); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      evidence = `${responseBody}\n${await readPaperclipLogsSince(logStart)}`;
    }
    expect(evidence).toMatch(/\b23503\b/);
    expect(evidence).toContain('issues_checkout_run_id_heartbeat_runs_id_fk');
    expect(evidence).toContain(fabricatedRunId);

    // The live-source assertions, all three over the same walk of every
    // non-test module in this directory.
    //
    // A1-3 names `randomUUID()` AND `uuid()`: a fabricated run id passes the
    // header guard and dies at the write with the 23503 above rather than a
    // clean 4xx, so neither spelling may exist here.
    //
    // A1-14 asks for a test that `onBehalfOfUserId` never appears in a
    // serialized body. Attribution spoofing is audited server-side, and the
    // string appearing nowhere in this directory is the whole of the contract -
    // there is no body-builder to inspect at runtime that this scan does not
    // already cover, and the guard is what keeps the absence true.
    const sourceDirectory = new URL('./', import.meta.url);
    const paperclipSources = (await readdir(sourceDirectory))
      .filter((name) => name.endsWith('.ts') && !name.includes('.test.'));
    expect(paperclipSources.length, 'the source scan matched no files, so all three assertions below are vacuous')
      .toBeGreaterThan(0);
    for (const sourceName of paperclipSources) {
      const source = await readFile(new URL(sourceName, sourceDirectory), 'utf8');
      expect(source, `${sourceName} must never synthesize a Paperclip run id`).not.toMatch(/\brandomUUID\b/);
      expect(source, `${sourceName} must never synthesize a Paperclip run id`).not.toMatch(/\buuid\s*\(/i);
      expect(source, `A1-14: ${sourceName} must never serialize onBehalfOfUserId`).not.toMatch(/onBehalfOfUserId/);
    }
  });
});
