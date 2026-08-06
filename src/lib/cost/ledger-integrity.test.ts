import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  macSign,
  macVerify,
  verifyChain,
  canonicalize,
  MAC_ALGORITHM,
  type KmsMacClient,
  type SignedLedgerRecord,
} from './ledger-integrity.js';
import type { LedgerRecord } from './spend-ledger.js';

const KEY = 'arn:aws:kms:us-east-1:000000000000:key/auditor-mac';

function rec(seq: number, spent: number): LedgerRecord {
  return { day: '2026-06-16', cap: 50, spent, reserved: 0, headroom: 50 - spent, seq };
}

function kmsWith(send: ReturnType<typeof vi.fn>): KmsMacClient {
  return { send };
}

describe('ledger-integrity macSign / macVerify (KMS MAC)', () => {
  let send: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    send = vi.fn();
  });

  it('macSign calls GenerateMac with the canonical message and returns a base64 MAC', async () => {
    send.mockResolvedValueOnce({ Mac: new Uint8Array([1, 2, 3, 4]) });
    const out = await macSign({ kms: kmsWith(send), keyId: KEY, ledgerRecord: rec(1, 0.5) });

    const cmd = send.mock.calls[0][0];
    expect(cmd.constructor.name).toBe('GenerateMacCommand');
    expect(cmd.input.KeyId).toBe(KEY);
    expect(cmd.input.MacAlgorithm).toBe(MAC_ALGORITHM);
    expect(cmd.input.Message).toEqual(canonicalize(rec(1, 0.5)));
    expect(out).toBe(Buffer.from([1, 2, 3, 4]).toString('base64'));
  });

  it('macSign throws when KMS returns no Mac', async () => {
    send.mockResolvedValueOnce({});
    await expect(
      macSign({ kms: kmsWith(send), keyId: KEY, ledgerRecord: rec(1, 0.5) }),
    ).rejects.toThrow(/no Mac/);
  });

  it('macVerify passes for a record KMS reports MacValid:true', async () => {
    send.mockResolvedValueOnce({ MacValid: true });
    const ok = await macVerify({
      kms: kmsWith(send),
      keyId: KEY,
      ledgerRecord: rec(1, 0.5),
      mac: Buffer.from([9, 9]).toString('base64'),
    });
    expect(ok).toBe(true);
    const cmd = send.mock.calls[0][0];
    expect(cmd.constructor.name).toBe('VerifyMacCommand');
    expect(cmd.input.MacAlgorithm).toBe(MAC_ALGORITHM);
  });

  it('macVerify FAILS CLOSED when MacValid is false', async () => {
    send.mockResolvedValueOnce({ MacValid: false });
    const ok = await macVerify({
      kms: kmsWith(send),
      keyId: KEY,
      ledgerRecord: rec(1, 0.5),
      mac: Buffer.from([9, 9]).toString('base64'),
    });
    expect(ok).toBe(false);
  });

  it('macVerify FAILS CLOSED when KMS throws (e.g. KMSInvalidMacException / KMS down)', async () => {
    send.mockRejectedValueOnce(
      Object.assign(new Error('bad'), { name: 'KMSInvalidMacException' }),
    );
    const ok = await macVerify({
      kms: kmsWith(send),
      keyId: KEY,
      ledgerRecord: rec(1, 0.5),
      mac: Buffer.from([9, 9]).toString('base64'),
    });
    expect(ok).toBe(false);
  });

  it('macVerify FAILS CLOSED on an empty / malformed mac without calling KMS', async () => {
    const ok = await macVerify({
      kms: kmsWith(send),
      keyId: KEY,
      ledgerRecord: rec(1, 0.5),
      mac: '',
    });
    expect(ok).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });
});

describe('ledger-integrity verifyChain (tamper detection)', () => {
  let send: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    send = vi.fn();
  });

  function signed(seq: number, spent: number): SignedLedgerRecord {
    return { record: rec(seq, spent), mac: Buffer.from([seq]).toString('base64') };
  }

  it('passes for a strictly monotonic, non-decreasing-spend, all-MACs-valid chain', async () => {
    send.mockResolvedValue({ MacValid: true });
    const verdict = await verifyChain(
      [signed(1, 0), signed(2, 0.3), signed(3, 0.7)],
      { kms: kmsWith(send), keyId: KEY },
    );
    expect(verdict).toEqual({ ok: true });
  });

  it('BLOCKS a forged record (MAC does not verify)', async () => {
    // first valid, second forged.
    send.mockResolvedValueOnce({ MacValid: true }).mockResolvedValueOnce({ MacValid: false });
    const verdict = await verifyChain(
      [signed(1, 0), signed(2, 0.3)],
      { kms: kmsWith(send), keyId: KEY },
    );
    expect(verdict).toMatchObject({ ok: false, verdict: 'BLOCK', reason: 'forged', atIndex: 1 });
  });

  it('BLOCKS a decremented spend even when every MAC verifies', async () => {
    send.mockResolvedValue({ MacValid: true });
    // seq rises (3 > 2) but spent goes DOWN 0.7 -> 0.2 (someone lowered the bill).
    const verdict = await verifyChain(
      [signed(2, 0.7), signed(3, 0.2)],
      { kms: kmsWith(send), keyId: KEY },
    );
    expect(verdict).toMatchObject({ ok: false, verdict: 'BLOCK', reason: 'decremented_spent' });
  });

  it('BLOCKS a rolled-back record (a later snapshot carries an older seq)', async () => {
    send.mockResolvedValue({ MacValid: true });
    // seq goes 5 then back to 4 — an old record re-inserted to undo spend.
    const verdict = await verifyChain(
      [signed(5, 0.9), signed(4, 0.5)],
      { kms: kmsWith(send), keyId: KEY },
    );
    expect(verdict).toMatchObject({ ok: false, verdict: 'BLOCK', reason: 'rolled_back' });
  });

  it('BLOCKS a non-monotonic seq (duplicate sequence number)', async () => {
    send.mockResolvedValue({ MacValid: true });
    const verdict = await verifyChain(
      [signed(2, 0.1), signed(2, 0.4)],
      { kms: kmsWith(send), keyId: KEY },
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(['non_monotonic_seq', 'rolled_back']).toContain(verdict.reason);
    }
  });

  it('BLOCKS an empty chain when one was expected (a missing ledger is suspicious)', async () => {
    const verdict = await verifyChain([], { kms: kmsWith(send), keyId: KEY, expectNonEmpty: true });
    expect(verdict).toMatchObject({ ok: false, verdict: 'BLOCK', reason: 'empty' });
    expect(send).not.toHaveBeenCalled();
  });

  it('an empty chain is fine when none was required', async () => {
    const verdict = await verifyChain([], { kms: kmsWith(send), keyId: KEY });
    expect(verdict).toEqual({ ok: true });
  });
});

// ─────────────────────────────────────────────────────────────────────
// Regression: adversarial review findings (verifyChain fail-open gaps)
// ─────────────────────────────────────────────────────────────────────

describe('regression: verifyChain detects tail truncation + non-finite', () => {
  function signed(seq: number, spent: number): SignedLedgerRecord {
    return { record: rec(seq, spent), mac: Buffer.from([seq]).toString('base64') };
  }

  it('BLOCKS a tail-truncated chain when the external head is known (no forgery needed)', async () => {
    const send = vi.fn().mockResolvedValue({ MacValid: true }); // every surviving row is genuinely signed
    // Real head is seq 3 (spent 2.0); attacker deletes it, leaving a valid low prefix.
    const verdict = await verifyChain([signed(1, 0), signed(2, 1.0)], {
      kms: kmsWith(send),
      keyId: KEY,
      expectedHeadSeq: 3,
      expectedHeadSpent: 2.0,
    });
    expect(verdict).toEqual({ ok: false, verdict: 'BLOCK', reason: 'truncated', atIndex: 1 });
  });

  it('passes when the chain ends exactly on the known head', async () => {
    const send = vi.fn().mockResolvedValue({ MacValid: true });
    const verdict = await verifyChain([signed(1, 0), signed(2, 1.0), signed(3, 2.0)], {
      kms: kmsWith(send),
      keyId: KEY,
      expectedHeadSeq: 3,
      expectedHeadSpent: 2.0,
    });
    expect(verdict).toEqual({ ok: true });
  });

  it('BLOCKS a totally-emptied ledger when a head was expected', async () => {
    const send = vi.fn().mockResolvedValue({ MacValid: true });
    const verdict = await verifyChain([], { kms: kmsWith(send), keyId: KEY, expectedHeadSeq: 5 });
    expect(verdict).toEqual({ ok: false, verdict: 'BLOCK', reason: 'truncated' });
  });

  it('BLOCKS a record with a non-finite seq (NaN slips past relational checks)', async () => {
    const send = vi.fn().mockResolvedValue({ MacValid: true });
    const verdict = await verifyChain([{ record: rec(NaN, 5), mac: 'AA==' }], {
      kms: kmsWith(send),
      keyId: KEY,
    });
    expect(verdict).toEqual({ ok: false, verdict: 'BLOCK', reason: 'non_finite', atIndex: 0 });
  });
});
