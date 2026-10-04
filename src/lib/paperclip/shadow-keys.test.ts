/**
 * FROZEN acceptance tests for Work Platform step 6: the approvers' Paperclip
 * board keys. Written by the coordinator BEFORE any production code. Do not edit
 * without the owner's yes: the step gate pins this file's sha256.
 *
 * ONE-WAY (owner 2026-10-04): one Secrets Manager secret, `/<app>/shadow-approvers`,
 * value `{"v":1,"slots":{"<slot>":{"email","password","boardKey"|null}}}`. The
 * orchestrator reads it at request time (a new approver must not need a task
 * restart) through an injected `getSecretString`, with a short cache.
 *
 * A key that cannot be proven usable is refused: an approval can never be sent
 * with a placeholder, a null or somebody else's key. Nothing here touches AWS.
 */
import { describe, it, expect, vi } from 'vitest';
import { createShadowKeyStore, ShadowKeyUnavailableError } from './shadow-keys.js';

const secret = (slots: Record<string, unknown>, v: unknown = 1) => JSON.stringify({ v, slots });
const slot = (boardKey: unknown) => ({ email: 'shadow-01-ab12@netzer.invalid', password: 'PW-SECRET-VALUE', boardKey });

function harness(values: string[] | (() => Promise<string>), ttlMs?: number) {
  let now = 0;
  let call = 0;
  const getSecretString = vi.fn(typeof values === 'function' ? values
    : async () => values[Math.min(call++, values.length - 1)]!);
  const store = createShadowKeyStore({ getSecretString, now: () => now, ...(ttlMs === undefined ? {} : { ttlMs }) });
  return { store, getSecretString, advance: (ms: number) => { now += ms; } };
}

describe('the shadow approvers secret', () => {
  it('returns the board key of the asked slot', async () => {
    const h = harness([secret({ '01': slot('pcp_board_AAA'), '02': slot('pcp_board_BBB') })]);
    expect(await h.store.boardKeyFor('02')).toBe('pcp_board_BBB');
    expect(await h.store.boardKeyFor('01')).toBe('pcp_board_AAA');
  });

  it('reads the secret once inside the cache window and again after it (default 60 s)', async () => {
    const h = harness([secret({ '01': slot('pcp_board_AAA') })]);
    await h.store.boardKeyFor('01');
    h.advance(59_000);
    await h.store.boardKeyFor('01');
    expect(h.getSecretString).toHaveBeenCalledTimes(1);
    h.advance(2_000);
    await h.store.boardKeyFor('01');
    expect(h.getSecretString).toHaveBeenCalledTimes(2);
  });

  it('a rotated key is picked up when the cache window ends', async () => {
    const h = harness([secret({ '01': slot('pcp_board_OLD') }), secret({ '01': slot('pcp_board_NEW') })], 1_000);
    expect(await h.store.boardKeyFor('01')).toBe('pcp_board_OLD');
    h.advance(1_001);
    expect(await h.store.boardKeyFor('01')).toBe('pcp_board_NEW');
  });

  it('a slot assigned after the last read is found by ONE refetch, without waiting for the window', async () => {
    const h = harness([secret({ '01': slot('pcp_board_AAA') }), secret({ '01': slot('pcp_board_AAA'), '02': slot('pcp_board_BBB') })]);
    await h.store.boardKeyFor('01');
    expect(await h.store.boardKeyFor('02')).toBe('pcp_board_BBB');
    expect(h.getSecretString).toHaveBeenCalledTimes(2);
  });

  it('a slot that does not exist costs at most one refetch per call and is refused', async () => {
    const h = harness([secret({ '01': slot('pcp_board_AAA') })]);
    await h.store.boardKeyFor('01');
    await expect(h.store.boardKeyFor('09')).rejects.toBeInstanceOf(ShadowKeyUnavailableError);
    expect(h.getSecretString).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['an unassigned slot (null key)', secret({ '01': slot(null) })],
    ['an empty key', secret({ '01': slot('') })],
    ['a whitespace key', secret({ '01': slot('   ') })],
    ['the REPLACE_ME placeholder', secret({ '01': slot('REPLACE_ME') })],
    ['a key that is not a string', secret({ '01': slot(12345) })],
    ['a slot entry that is not an object', secret({ '01': 'pcp_board_AAA' })],
    ['another secret version', secret({ '01': slot('pcp_board_AAA') }, 2)],
    ['a missing version', JSON.stringify({ slots: { '01': slot('pcp_board_AAA') } })],
    ['slots that are not an object', JSON.stringify({ v: 1, slots: ['pcp_board_AAA'] })],
    ['text that is not JSON', 'REPLACE_ME'],
    ['an empty secret', ''],
  ])('%s is refused', async (_name, value) => {
    const h = harness([value]);
    await expect(h.store.boardKeyFor('01')).rejects.toBeInstanceOf(ShadowKeyUnavailableError);
  });

  it('a secret that cannot be read is refused, and the next call tries again', async () => {
    let fail = true;
    const h = harness(async () => { if (fail) throw new Error('AccessDeniedException: arn:aws:secretsmanager:...'); return secret({ '01': slot('pcp_board_AAA') }); });
    await expect(h.store.boardKeyFor('01')).rejects.toBeInstanceOf(ShadowKeyUnavailableError);
    fail = false;
    expect(await h.store.boardKeyFor('01')).toBe('pcp_board_AAA');
  });

  it('a bad read never serves a stale key past the window', async () => {
    const h = harness([secret({ '01': slot('pcp_board_AAA') }), 'not json'], 1_000);
    expect(await h.store.boardKeyFor('01')).toBe('pcp_board_AAA');
    h.advance(1_001);
    await expect(h.store.boardKeyFor('01')).rejects.toBeInstanceOf(ShadowKeyUnavailableError);
  });

  it.each(['00', '1', '100', 'ab', '', '../01', '__proto__', 'constructor'])('the slot id %j is refused without reading a key', async (bad) => {
    const h = harness([secret({ '00': slot('pcp_board_AUDITOR'), '01': slot('pcp_board_AAA') })]);
    await expect(h.store.boardKeyFor(bad)).rejects.toBeInstanceOf(ShadowKeyUnavailableError);
  });

  it('an error never carries a key, a password or an email', async () => {
    const h = harness([JSON.stringify({ v: 2, slots: { '01': slot('pcp_board_LEAK') } })]);
    const error = await h.store.boardKeyFor('01').catch((e: unknown) => e as Error);
    const text = `${(error as Error).message} ${JSON.stringify(error)} ${String((error as Error).stack)}`;
    expect(text).not.toContain('pcp_board_LEAK');
    expect(text).not.toContain('PW-SECRET-VALUE');
    expect(text).not.toContain('netzer.invalid');
  });
});
