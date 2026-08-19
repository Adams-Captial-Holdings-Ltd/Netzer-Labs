import { readdir, readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  bootstrapPaperclip,
  readPaperclipLogsSince,
  type PaperclipBootstrap,
} from '../../../tests/fixtures/paperclip-bootstrap.js';

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

async function createAssignedIssue(
  fixture: PaperclipBootstrap,
  title: string,
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
        assigneeAgentId: fixture.agents.main.id,
        priority: 'medium',
      }),
    },
  );
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
    const issue = await createAssignedIssue(fixture, `I3 strict watermark ${Date.now()}`);
    const updatedAt = new Date(issue.updatedAt);
    expect(Number.isNaN(updatedAt.getTime())).toBe(false);

    const listFrom = async (watermark: string): Promise<PaperclipIssue[]> => {
      const query = new URLSearchParams({
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
        'x-paperclip-run-id': fabricatedRunId,
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

    const sourceDirectory = new URL('./', import.meta.url);
    const paperclipSources = (await readdir(sourceDirectory))
      .filter((name) => name.endsWith('.ts') && !name.includes('.test.'));
    for (const sourceName of paperclipSources) {
      const source = await readFile(new URL(sourceName, sourceDirectory), 'utf8');
      expect(source, `${sourceName} must never synthesize a Paperclip run id`).not.toMatch(/\brandomUUID\b/);
    }
  });
});
