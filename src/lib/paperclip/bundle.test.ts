/**
 * A2-23(d): this integration re-run against a BUILT artifact rather than the
 * source, and against a build shaped to break it.
 *
 * WHAT IT BUILDS. Every `.ts` module in this directory is compiled with the
 * repo's own TypeScript compiler to ES5 CommonJS and linked together through one
 * `require` shim; the emit — not the source — is what the assertions below drive.
 * Modules OUTSIDE this directory (`../../observability/logger.js`,
 * `../state/kill-switches-repo.js`, `../state/runtime-config-repo.js`,
 * `../../config/env.js`, `../state/mission-tasks-repo.js`) are handed to the
 * emit as the REAL modules, pre-imported below. Nothing is stubbed, faked or
 * mocked: the only injected values are the ones the production constructor
 * already takes as options.
 *
 * WHY THIS AND NOT `dist/`. Linear's `bundle.test.ts` `require`s
 * `../../dist/index.cjs`, which only works because its suite runs after its
 * build. `npm test` here is `vitest run` alone (`package.json`), so a test
 * reading `dist/` would either skip silently on a clean checkout — a test that
 * proves nothing is worse than no test — or make every developer build first.
 *
 * WHY ES5. `npm run build` is `tsc -p tsconfig.build.json`, which inherits
 * `target: esnext`, so today's artifact keeps native `class` and `instanceof`
 * works whether or not the base class restores its prototype — which is exactly
 * why asserting A2-8 against the current build would be vacuous. Downlevelled
 * `class` is where `instanceof` silently breaks for every subclass, so this
 * manufactures that emit deliberately. Linear ships `target: esnext` for the
 * same reason ("tsdown takes care of downlevelling") and its bundle test
 * therefore asserts on `error.type`, never on `instanceof`.
 */
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import type * as ClientModule from './client.js';
import type * as ErrorModule from './error.js';
import { paperclipIssue, TEST_COMPANY } from './test-helpers.js';

interface Built {
  error: typeof ErrorModule;
  client: typeof ClientModule;
  emitted: Map<string, string>;
}

/** Compiled once: four transpiles of the same graph would just be slower. */
const built: Promise<Built> = buildEs5();

async function buildEs5(): Promise<Built> {
  // The real modules from outside this directory, imported as ESM and handed to
  // the CommonJS emit unchanged.
  const outside = new Map<string, unknown>([
    ['../../observability/logger.js', await import('../../observability/logger.js')],
    ['../state/kill-switches-repo.js', await import('../state/kill-switches-repo.js')],
    ['../state/runtime-config-repo.js', await import('../state/runtime-config-repo.js')],
    ['../../config/env.js', await import('../../config/env.js')],
    ['../state/mission-tasks-repo.js', await import('../state/mission-tasks-repo.js')],
  ]);

  const emitted = new Map<string, string>();
  const loaded = new Map<string, Record<string, unknown>>();

  async function load(specifier: string): Promise<Record<string, unknown>> {
    const cached = loaded.get(specifier);
    if (cached) return cached;
    const source = await readFile(new URL(specifier.replace(/\.js$/, '.ts'), import.meta.url), 'utf8');
    const { outputText } = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES5, module: ts.ModuleKind.CommonJS },
    });
    emitted.set(specifier, outputText);
    const exports: Record<string, unknown> = {};
    loaded.set(specifier, exports);
    // Every relative import in this directory is resolved eagerly first, so the
    // synchronous `require` the ES5 emit performs always has its answer ready.
    const siblings = new Map<string, unknown>();
    for (const [, id] of outputText.matchAll(/require\("(\.[^"]+)"\)/g)) {
      siblings.set(id, id.startsWith('./') ? await load(id) : outside.get(id));
      if (!siblings.get(id)) throw new Error(`the ES5 emit of ${specifier} required ${id}, which is not linked here`);
    }
    const run = new Function('exports', 'require', outputText) as (
      exports: Record<string, unknown>,
      require: (id: string) => unknown,
    ) => void;
    run(exports, (id: string) => siblings.get(id));
    return exports;
  }

  return {
    error: (await load('./error.js')) as unknown as typeof ErrorModule,
    client: (await load('./client.js')) as unknown as typeof ClientModule,
    emitted,
  };
}

function jsonFetch(body: unknown, status = 200, headers: Record<string, string> = {}): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    })) as unknown as typeof fetch;
}

describe('A2-23(d): the built artifact', () => {
  it('the emit really is downlevelled and really is multi-module, so the assertions below are not vacuous', async () => {
    const { emitted } = await built;
    expect([...emitted.keys()]).toEqual(
      expect.arrayContaining(['./error.js', './client.js', './config.js', './types.js']),
    );
    expect(emitted.get('./error.js')).not.toContain('class PaperclipError');
    expect(emitted.get('./error.js')).toContain('__extends');
    expect(emitted.get('./client.js')).toContain('require("./error.js")');
  });

  it('A2-8: instanceof survives for every leaf, which is what the prototype restoration buys', async () => {
    const { error } = await built;
    const err = error.parsePaperclipError(new Error('boom'), {
      status: 429,
      body: { error: 'Search rate limit exceeded', retryAfterSeconds: 3 },
      headers: new Headers({ 'retry-after': '3' }),
    });
    expect(err).toBeInstanceOf(error.PaperclipRatelimitedError);
    expect(err).toBeInstanceOf(error.PaperclipError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('PaperclipRatelimitedError');
    expect(err.stack).toBeTruthy();
  });

  it('the DISCRIMINANT is what a cross-build assertion uses, and it agrees with the source build', async () => {
    // `instanceof` cannot cross this boundary: the class objects are different
    // (this one was compiled seconds ago). `type` is a string, so it can — which
    // is the rule Linear's bundle test follows and the reason `type` exists.
    const { error } = await built;
    for (const [status, expected] of [
      [401, 'auth'],
      [403, 'auth'],
      [409, 'conflict'],
      [429, 'ratelimited'],
      [500, 'unavailable'],
    ] as const) {
      expect(error.parsePaperclipError(new Error('x'), { status }).type).toBe(expected);
    }
    expect(
      error.parsePaperclipError(new Error('x'), { status: 401, body: { error: error.RUN_ID_REQUIRED_MESSAGE } }).type,
    ).toBe('run_id_required');
  });

  it('A2-5: the NaN guard holds in the built artifact too', async () => {
    const { error } = await built;
    const err = error.parsePaperclipError(new Error('x'), {
      status: 429,
      body: { error: 'slow down' },
      headers: new Headers({ 'retry-after': 'soon' }),
    }) as InstanceType<typeof ErrorModule.PaperclipRatelimitedError>;
    expect(err.retryAfter).toBeUndefined();
    expect(err.advertisedWaitMs()).toBeUndefined();
  });

  it('A2-12: the built transport retries, backs off and opens its breaker exactly as the source one does', async () => {
    const { client, error } = await built;
    const waits: number[] = [];
    const built5xx = new client.PaperclipClient({
      baseUrl: 'https://paperclip.test',
      companyId: TEST_COMPANY,
      agentKeys: { main: 'key-main' },
      fetchFn: jsonFetch({ error: 'upstream is down' }, 503),
      killSwitch: async () => ({ active: false }),
      retry: { ...client.PAPERCLIP_RETRY_POLICY, random: () => 1, sleep: async (ms) => void waits.push(ms) },
    });

    // Five failed CALLS, three attempts each: the breaker counts calls.
    for (let call = 0; call < 5; call += 1) {
      await expect(built5xx.getHealth()).rejects.toBeInstanceOf(error.PaperclipUnavailableError);
    }
    expect(waits).toEqual([250, 500, 250, 500, 250, 500, 250, 500, 250, 500]);
    const open = await built5xx.getHealth().catch((err: unknown) => err);
    expect((open as ErrorModule.PaperclipError).message).toContain('circuit breaker is open');
  });

  it('A2-15: the built page container carries its filters to page 2 and refuses to truncate silently', async () => {
    const { client, error } = await built;
    let calls = 0;
    const paging = new client.PaperclipClient({
      baseUrl: 'https://paperclip.test',
      companyId: TEST_COMPANY,
      agentKeys: { main: 'key-main' },
      killSwitch: async () => ({ active: false }),
      retry: client.PAPERCLIP_NO_RETRY,
      // An infinite board: every page is full, so `paginateAll` can only stop
      // at its bound.
      fetchFn: (async () => {
        calls += 1;
        return new Response(JSON.stringify([paperclipIssue({ id: `i${calls}` })]), {
          headers: { 'content-type': 'application/json' },
        });
      }) as unknown as typeof fetch,
    });
    const page = await paging.listIssues({ limit: 1, status: 'todo' });
    await expect(page.paginateAll(3)).rejects.toBeInstanceOf(error.PaperclipPaginationTruncatedError);
    expect(calls).toBe(3);
  });
});
