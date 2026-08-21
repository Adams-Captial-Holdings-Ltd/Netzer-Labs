/**
 * The helpers imported ONLY by `*.test.ts` in this directory.
 *
 * They live here rather than in `error.ts` because a test assertion helper
 * exported from a production module ships in the runtime bundle and invites a
 * production caller. The precedent is `src/__test-utils__/localstack.ts`, one
 * directory up. Everything here has more than one consumer, which is what makes
 * it shared rather than one file's private convenience.
 *
 * `expectPaperclipError` asserts on the class AND a message substring, where
 * Linear's `expectError` asserts on an enum value. Both are safe here and only
 * here: nothing in this lane crosses a build boundary. `bundle.test.ts`, which
 * does, asserts on the `type` discriminant instead.
 *
 * This file imports `vitest`, so `tsconfig.build.json` excludes it BY NAME: the
 * test-file glob it sits beside does not match a name without `.test.` in it,
 * and the A2-21 source scan classes it as a test module for the same reason.
 * Without that exclusion it would compile into `dist/` — the exact thing its
 * first paragraph exists to prevent.
 *
 * The local mock HTTP server A2-23(b) requires is NOT here: it is declared
 * inside `client.mock-server.test.ts`, its only consumer.
 */
import { expect } from 'vitest';
import { PaperclipClient, PAPERCLIP_NO_RETRY, type PaperclipClientOptions } from './client.js';
import type { PaperclipError } from './error.js';
import type { PaperclipIssue } from './types.js';

export const TEST_COMPANY = 'c0ffee00-0000-4000-8000-000000000001';
export const TEST_ISSUE_ID = 'a1b2c3d4-0000-4000-8000-000000000001';

/** A wire issue row carrying all ten projection fields. */
export function paperclipIssue(overrides: Partial<PaperclipIssue> = {}): PaperclipIssue {
  return {
    id: TEST_ISSUE_ID,
    identifier: 'NZR-1',
    title: 'probe',
    description: null,
    status: 'todo',
    priority: 'medium',
    assigneeAgentId: null,
    createdByAgentId: null,
    createdAt: '2026-08-21T00:00:00.000Z',
    updatedAt: '2026-08-21T00:00:00.000Z',
    ...overrides,
  };
}

/**
 * A configured client with the kill switch open and retry off, so a test opts
 * IN to a policy rather than discovering one. Every caller supplies its own
 * transport — an injected `fetchFn` in the unit lane, a real `baseUrl` in the
 * mock-server lane.
 */
export function paperclipTestClient(overrides: PaperclipClientOptions = {}): PaperclipClient {
  return new PaperclipClient({
    baseUrl: 'https://paperclip.test',
    companyId: TEST_COMPANY,
    agentKeys: { main: 'key-main' },
    defaultActor: 'main',
    killSwitch: async () => ({ active: false }),
    retry: PAPERCLIP_NO_RETRY,
    ...overrides,
  });
}

/**
 * Asserts that `run` rejects with `Expected` and a message containing
 * `messageSubstring`, and hands the narrowed error back for further assertions.
 * The "did not throw" case is a hard failure, never a silent pass — which is
 * what `expect.unreachable` buys over a bare `return`.
 */
export async function expectPaperclipError(
  run: () => unknown,
  Expected: new (...args: never[]) => PaperclipError,
  messageSubstring: string,
): Promise<PaperclipError> {
  try {
    await run();
  } catch (err) {
    expect(err).toBeInstanceOf(Expected);
    expect((err as PaperclipError).message).toContain(messageSubstring);
    return err as PaperclipError;
  }
  return expect.unreachable(`Expected ${Expected.name}, but nothing was thrown`);
}
