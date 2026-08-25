/**
 * A2-23(b): a local HTTP server over REAL `fetch`.
 *
 * Everything in `client.test.ts` is driven through an injected `fetchFn`, which
 * is fast but proves nothing about what actually goes on the wire — header
 * casing, query serialization, JSON body encoding and content-type negotiation
 * all live below that seam. This file is the one that exercises them, the way
 * Linear's `_tests/_mock.ts` does: a real server, a recorded `requests` array,
 * an auth gate that 401s anything without the expected key, and volatile
 * headers normalized so an assertion is stable.
 *
 * `node:http` rather than express + body-parser + get-port: A2-21 is zero new
 * runtime dependencies, and adding three dev dependencies to assert on a
 * recorded request would be the same instinct one layer down.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type PaperclipClient } from './client.js';
import {
  PaperclipAuthError,
  PaperclipError,
  PaperclipUnavailableError,
} from './error.js';
import { expectPaperclipError, paperclipIssue, paperclipTestClient } from './test-helpers.js';

const AGENT_KEY = 'mock-agent-key';

interface RecordedRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: unknown;
}

const requests: RecordedRequest[] = [];
/** Per-path queue of canned responses; the last one replays. */
let responses: Array<{ status?: number; contentType?: string; body: string }> = [];

let server: Server;
let baseUrl = '';

function handler(req: IncomingMessage, res: ServerResponse): void {
  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  req.on('end', () => {
    const url = new URL(req.url ?? '/', 'http://mock');
    const raw = Buffer.concat(chunks).toString('utf8');
    const headers = Object.fromEntries(
      Object.entries(req.headers).map(([name, value]) => [
        name,
        // The port is ephemeral, so `host` is the one volatile header. Pinned
        // to a literal exactly as Linear's mock rewrites it, so a captured
        // header set is comparable run to run.
        name === 'host' ? 'DYNAMIC' : Array.isArray(value) ? value.join(', ') : String(value ?? ''),
      ]),
    );

    // The auth gate: anything not presenting the agent key is a 401 in the
    // artifact's own envelope shape, `{error}` and nothing else.
    if (headers.authorization !== `Bearer ${AGENT_KEY}`) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    requests.push({
      method: req.method ?? 'GET',
      path: url.pathname,
      query: Object.fromEntries(url.searchParams.entries()),
      headers,
      body: raw.length === 0 ? undefined : (JSON.parse(raw) as unknown),
    });

    const canned = responses[Math.min(requests.length - 1, responses.length - 1)] ?? { body: '[]' };
    res.writeHead(canned.status ?? 200, { 'content-type': canned.contentType ?? 'application/json' });
    res.end(canned.body);
  });
}

function client(overrides: Record<string, unknown> = {}): PaperclipClient {
  return paperclipTestClient({
    baseUrl,
    agentKeys: { main: AGENT_KEY, imposter: 'wrong-key' },
    ...overrides,
  });
}

function issueJson(id: string): string {
  return JSON.stringify(paperclipIssue({ id, identifier: `NZR-${id}`, title: id }));
}

beforeAll(async () => {
  server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('mock server has no port');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

beforeEach(() => {
  requests.length = 0;
  responses = [];
});

describe('A2-23(b): the client over a local HTTP server and real fetch', () => {
  it('records method, path, query, headers and body from a request that really crossed a socket', async () => {
    responses = [{ body: JSON.stringify({ id: 'c1', body: 'hello', createdAt: '2026-08-21T00:00:00.000Z' }) }];
    await client().addComment('a1b2c3d4-0000-4000-8000-000000000001', { body: 'hello' });

    expect(requests).toHaveLength(1);
    const recorded = requests[0] as RecordedRequest;
    expect(recorded.method).toBe('POST');
    expect(recorded.path).toBe('/api/issues/a1b2c3d4-0000-4000-8000-000000000001/comments');
    expect(recorded.headers.host).toBe('DYNAMIC');
    expect(recorded.headers['content-type']).toBe('application/json');
    expect(recorded.headers['user-agent']).toBe('netzar-os/0.0.1');
    expect(recorded.headers['x-paperclip-run-id']).toBeUndefined();
    expect(recorded.body).toEqual({ body: 'hello' });
  });

  it('a call presenting the wrong key is a 401 that arrives as a typed PaperclipAuthError', async () => {
    await expectPaperclipError(
      () => client().getHealth({ actor: 'imposter' }),
      PaperclipAuthError,
      'Unauthorized',
    );
    expect(requests).toHaveLength(0);
  });

  it('A2-15: the refetch closure still carries the original filters at page 2, over real fetch', async () => {
    responses = [
      { body: `[${issueJson('i1')},${issueJson('i2')}]` },
      { body: `[${issueJson('i3')}]` },
      { body: '[]' },
    ];
    const page = await client().listIssues({
      limit: 2,
      status: 'todo',
      assigneeAgentId: 'null',
      updatedSince: '2026-08-20T00:00:00.000Z',
      sortField: 'updated',
      sortDir: 'asc',
    });
    const all = await page.paginateAll();

    expect(all.map((row) => row.id)).toEqual(['i1', 'i2', 'i3']);
    expect(requests).toHaveLength(3);
    const pageTwo = (requests[1] as RecordedRequest).query;
    expect(pageTwo).toMatchObject({
      limit: '2',
      status: 'todo',
      assigneeAgentId: 'null',
      updatedSince: '2026-08-20T00:00:00.000Z',
      sortField: 'updated',
      sortDir: 'asc',
      offset: '2',
    });
  });

  it('A2-13: an HTML 502 from a proxy becomes a typed error over real fetch, not a JSON parse crash', async () => {
    responses = [{ status: 502, contentType: 'text/html', body: '<html>502 Bad Gateway</html>' }];
    const err = await expectPaperclipError(
      () => client().listIssues(),
      PaperclipUnavailableError,
      'responded 502',
    );
    expect(err.body?.error).toContain('502 Bad Gateway');
  });

  it('A2-13: a Content-Type application/json body that is not JSON degrades instead of throwing SyntaxError', async () => {
    // Linear calls response.json() with no try/catch, so this exact case
    // escapes both of its public exits as a raw SyntaxError.
    responses = [{ status: 200, contentType: 'application/json', body: '<html>truncated' }];
    const err = await expectPaperclipError(() => client().listIssues(), PaperclipError, 'responded 200');
    expect(err.body?.error).toContain('truncated');
  });
});
