/**
 * A2-23(a): the executable README.
 *
 * Section 5b of `docs/features/paperclip/README.md` documents this client with
 * four fenced `ts` blocks, each preceded by an HTML comment naming it. Every one
 * of those blocks is COMPILED (it is real TypeScript in this file) and RUN
 * (against a fake transport) below — and `documented()` asserts the block in the
 * README is byte-identical to the code that just ran.
 *
 * That two-way check is the whole point, and it is Linear's `readme.test.ts`
 * pattern with its `CODE_SECTION` markers. Compiling the snippet alone proves it
 * type-checks but lets the doc drift; comparing text alone proves they match but
 * lets both be wrong. Doing both means a snippet cannot rot in either direction:
 * change the README and this fails, change the code and this fails.
 *
 * THERE IS NO THIRD COPY. `written()` slices the snippet out of THIS FILE's own
 * source between its `// CODE_SECTION:` markers; an earlier version retyped each
 * snippet as a string array, which is a third transcription to keep in sync and
 * therefore the exact drift this file exists to prevent. The snippets are
 * written at column 0 inside their own block so the slice needs no dedent.
 */
import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import { PaperclipClient } from './client.js';
import { PaperclipDisabledError, PaperclipError, PaperclipRatelimitedError } from './error.js';
import { paperclipIssue, paperclipTestClient } from './test-helpers.js';

const README = new URL('../../../docs/features/paperclip/README.md', import.meta.url);
let readme = '';
let ownSource = '';

beforeAll(async () => {
  readme = await readFile(README, 'utf8');
  ownSource = await readFile(new URL(import.meta.url), 'utf8');
});

/**
 * Pulls the fenced block that follows `<!-- CODE_SECTION: name -->`. A missing
 * marker is a hard failure, not a skip: a silently absent section would make
 * every assertion in its test vacuous.
 */
function documented(name: string): string {
  const match = new RegExp(`<!-- CODE_SECTION: ${name} -->\\r?\\n\`\`\`ts\\r?\\n([\\s\\S]*?)\`\`\``).exec(readme);
  if (!match?.[1]) throw new Error(`README has no CODE_SECTION: ${name}`);
  return normalize(match[1]);
}

/** The same section as it is actually written — and run — in this file. */
function written(name: string): string {
  const match = new RegExp(`// CODE_SECTION: ${name}\\r?\\n([\\s\\S]*?)// CODE_SECTION: ${name} END`).exec(ownSource);
  if (!match?.[1]) throw new Error(`this file has no CODE_SECTION: ${name}`);
  return normalize(match[1]);
}

function normalize(block: string): string {
  return block.trim().replace(/\r\n/g, '\n');
}

/** Answers every call with the same JSON body. */
function fakeFetch(body: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
}

describe('A2-23(a): every documented snippet compiles, runs, and matches the README', () => {
  it('construct', () => {
// CODE_SECTION: construct
const paperclip = new PaperclipClient({
  baseUrl: 'https://paperclip.internal',
  companyId: '00000000-0000-4000-8000-000000000001',
  agentKeys: { main: 'agent-key-for-main' },
  defaultActor: 'main',
});
// CODE_SECTION: construct END
    expect(paperclip.config.defaultActor).toBe('main');
    expect(documented('construct')).toBe(written('construct'));
  });

  it('paginate', async () => {
    let calls = 0;
    const paperclip = client(
      (async () => {
        calls += 1;
        const rows = calls === 1 ? [paperclipIssue({ id: 'i1' }), paperclipIssue({ id: 'i2' })] : [];
        return new Response(JSON.stringify(rows), { headers: { 'content-type': 'application/json' } });
      }) as unknown as typeof fetch,
    );

// CODE_SECTION: paginate
const page = await paperclip.listIssues({
  updatedSince: '2026-08-20T00:00:00.000Z',
  sortField: 'updated',
  limit: 2,
});
const everything = await page.paginateAll();
// CODE_SECTION: paginate END

    expect(everything.map((row) => row.id)).toEqual(['i1', 'i2']);
    expect(documented('paginate')).toBe(written('paginate'));
  });

  it('errors', async () => {
    const waited: number[] = [];
    const sleep = async (ms: number) => void waited.push(ms);
    const logger = { warn: (fields: unknown, message: string) => void logged.push({ fields, message }) };
    const logged: Array<{ fields: unknown; message: string }> = [];
    const paperclip = client(
      fakeFetch({ error: 'Search rate limit exceeded', retryAfterSeconds: 3 }, 429),
    );

// CODE_SECTION: errors
try {
  await paperclip.getIssue('a1b2c3d4-0000-4000-8000-000000000001');
} catch (err) {
  if (err instanceof PaperclipRatelimitedError) {
    await sleep(err.advertisedWaitMs() ?? 1_000);
  } else if (err instanceof PaperclipError) {
    logger.warn({ type: err.type, status: err.status, path: err.request?.path }, err.message);
  }
}
// CODE_SECTION: errors END

    expect(waited).toEqual([3_000]);
    expect(logged).toEqual([]);
    expect(documented('errors')).toBe(written('errors'));
  });

  it('killswitch', async () => {
    const paperclip = client(fakeFetch({ status: 'ok' }), async () => ({
      active: true,
      reason: 'incident 42',
    }));

// CODE_SECTION: killswitch
const failure = await paperclip.getHealth().catch((err: unknown) => err);
// PaperclipDisabledError, not PaperclipUnavailableError:
// "paperclip_disabled kill switch active: …"
// CODE_SECTION: killswitch END

    expect(failure).toBeInstanceOf(PaperclipDisabledError);
    expect((failure as PaperclipError).message).toContain('incident 42');
    expect(documented('killswitch')).toBe(written('killswitch'));
  });
});

function client(
  fetchFn: typeof fetch,
  killSwitch: () => Promise<{ active: boolean; reason?: string }> = async () => ({ active: false }),
): PaperclipClient {
  return paperclipTestClient({ baseUrl: 'https://paperclip.internal', fetchFn, killSwitch });
}
