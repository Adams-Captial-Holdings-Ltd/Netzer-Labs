import { beforeAll, describe, expect, it } from 'vitest';
import { bootstrapPaperclip, paperclipAdminRequest, type PaperclipBootstrap } from '../../fixtures/paperclip-bootstrap.js';
import { paperclipPin, withBearer } from './harness.js';

describe.skipIf(!process.env.PAPERCLIP_TEST_AUTH_SECRET)('Paperclip updatedSince contracts on both pins', () => {
  let fixture: PaperclipBootstrap;
  let pin: 'old' | 'new';
  const issues = () => `/api/companies/${fixture.companyId}/issues`;
  const list = (value: string) => withBearer(fixture.agents.main.key)(
    `${issues()}?updatedSince=${encodeURIComponent(value)}&limit=500`,
  );

  beforeAll(async () => {
    fixture = await bootstrapPaperclip();
    pin = await paperclipPin();
  }, 120_000);

  it('an updatedSince one hour in the future returns no issues', async () => {
    const response = await list(new Date(Date.now() + 3_600_000).toISOString());
    expect(response.status).toBe(200);
    const body = await response.json() as unknown;
    expect(body, `future updatedSince returned ${Array.isArray(body) ? body.length : typeof body} rows/body`).toEqual([]);
  });

  it('a malformed updatedSince is rejected on both pins', async () => {
    const response = await list('not-a-date');
    const body = await response.json() as { error?: unknown };
    expect(response.status, `malformed updatedSince response: ${JSON.stringify(body)}`).toBe(400);
  });

  it('an offset-less updatedSince is rejected on old and accepted on new', async () => {
    const response = await list('2026-01-01T00:00:00');
    const body = await response.json() as unknown;
    const observed = Array.isArray(body) ? `array of ${body.length} issues` : JSON.stringify(body);
    expect(response.status, `${pin} pin offset-less updatedSince response: ${observed}`).toBe(pin === 'old' ? 400 : 200);
    if (pin === 'new') expect(Array.isArray(body), `new pin body: ${observed}`).toBe(true);
  });

  it("updatedSince one millisecond after an issue's updatedAt excludes it, one millisecond before includes it, on both pins", async () => {
    // The old pin excludes at T because its patch adds 1ms; v2026.916.1 re-returns at T (5 of 5 measured), so this test avoids asserting that boundary.
    const created = await withBearer(fixture.agents.main.key)(issues(), {
      method: 'POST',
      body: JSON.stringify({ title: `Watermark contract ${Date.now()}`, description: 'Contract probe', priority: 'medium' }),
    });
    expect(created.status).toBe(201);
    const issue = await created.json() as { id: string; updatedAt: string };
    try {
      expect(Number.isNaN(new Date(issue.updatedAt).getTime())).toBe(false);
      for (const [offset, shouldInclude] of [[1, false], [-1, true]] as const) {
        const watermark = new Date(new Date(issue.updatedAt).getTime() + offset).toISOString();
        const response = await list(watermark);
        expect(response.status).toBe(200);
        const rows = await response.json() as Array<{ id: string }>;
        expect(Array.isArray(rows)).toBe(true);
        expect(rows.some((row) => row.id === issue.id), `${pin} pin inclusion at ${offset}ms from updatedAt`).toBe(shouldInclude);
      }
    } finally {
      const removed = await paperclipAdminRequest(`/api/issues/${issue.id}`, { method: 'DELETE' });
      expect(removed.status).toBe(200);
    }
  });
});
