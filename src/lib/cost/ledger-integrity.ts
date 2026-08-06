/**
 * KEY-SEPARATED ledger integrity (invariant I3, second half).
 *
 * The spend ledger (./spend-ledger.ts) is the atomic gate. This module makes the
 * ledger TAMPER-EVIDENT: every authoritative day record is signed with a KMS
 * HMAC (a MAC), and the chain of records is verified so a missing, rolled-back,
 * decremented, forged, or non-monotonic ledger is DETECTED and produces a
 * fail-closed BLOCK verdict.
 *
 * KEY SEPARATION (the whole point): the MAC key is a KMS HMAC key whose key
 * policy grants kms:GenerateMac / kms:VerifyMac to a SEPARATE principal/role that
 * the workload task role and the deploy/CDK role CANNOT assume or use. The
 * Fargate task that runs the agent loop can WRITE ledger rows but cannot mint a
 * valid MAC for a row it forged, and cannot read the key material. Verification
 * runs under the separated principal (e.g. a dedicated auditor Lambda / role).
 * Because neither the workload nor the deploy role can call GenerateMac on this
 * key, an attacker who compromises either role can MODIFY a ledger row but
 * cannot produce a matching MAC for the altered content, so verifyChain() flags
 * the forgery. One attack the per-row MAC alone CANNOT catch is DELETING the
 * newest rows (each surviving row is genuinely signed): detecting that requires
 * verifyChain to be given an externally-known head (expectedHeadSeq) stored
 * outside the deletable table, against which it fails closed on truncation. The CDK grant that
 * wires this separation (a standalone KMS key + a key policy that excludes the
 * task and deploy roles, granting only the auditor principal) is added by the
 * orchestrator later; this module is grant-agnostic and only calls the KMS MAC
 * APIs.
 *
 * Fail-CLOSED everywhere: if a MAC cannot be generated or verified (KMS
 * unavailable, key disabled, IAM denied), the verdict is BLOCK, never "assume
 * valid". A monitoring/KMS outage can never silently mark a tampered ledger as
 * trustworthy.
 */

import {
  GenerateMacCommand,
  VerifyMacCommand,
  type GenerateMacCommandOutput,
  type VerifyMacCommandOutput,
} from '@aws-sdk/client-kms';
import type { LedgerRecord } from './spend-ledger.js';

/**
 * Minimal KMS seam. The real implementation is the @aws-sdk/client-kms
 * KMSClient. Narrowed to `.send()` so tests pass a `{ send: vi.fn() }` fake.
 */
export interface KmsMacClient {
  send(command: unknown): Promise<unknown>;
}

/**
 * The HMAC algorithm. SHA-256 is the conservative default supported by every
 * KMS HMAC key spec. Kept as a constant so signer and verifier never disagree
 * (a mismatch would make every verify fail closed, which is safe but useless).
 */
export const MAC_ALGORITHM = 'HMAC_SHA_256' as const;

/**
 * Canonical, stable serialization of a ledger record. The SAME bytes must be fed
 * to GenerateMac and VerifyMac, so field order is fixed and numbers are rendered
 * deterministically (no locale, no float drift beyond JSON's own representation).
 * Any change to a signed field (e.g. a decremented `spent` or a rolled-back
 * `seq`) changes these bytes, so the stored MAC no longer verifies.
 */
export function canonicalize(rec: LedgerRecord): Uint8Array {
  // Explicit field order; do NOT JSON.stringify the object directly (key order
  // is not guaranteed across runtimes for dynamically built objects).
  const canonical = [
    `day=${rec.day}`,
    `cap=${rec.cap}`,
    `spent=${rec.spent}`,
    `reserved=${rec.reserved}`,
    `headroom=${rec.headroom}`,
    `seq=${rec.seq}`,
  ].join('|');
  return new TextEncoder().encode(canonical);
}

export interface MacSignArgs {
  kms: KmsMacClient;
  /** The KMS HMAC key id / ARN / alias. Must be the SEPARATED key. */
  keyId: string;
  ledgerRecord: LedgerRecord;
}

/**
 * Produce a KMS HMAC over the canonicalized record. Returns the base64 MAC to
 * store alongside the record. Throws on KMS failure (the caller persisting a row
 * must treat a sign failure as "do not commit / alert", never "store unsigned").
 */
export async function macSign(args: MacSignArgs): Promise<string> {
  const { kms, keyId, ledgerRecord } = args;
  const out = (await kms.send(
    new GenerateMacCommand({
      KeyId: keyId,
      MacAlgorithm: MAC_ALGORITHM,
      Message: canonicalize(ledgerRecord),
    }),
  )) as GenerateMacCommandOutput;
  if (!out.Mac) {
    throw new Error('macSign: KMS returned no Mac');
  }
  return Buffer.from(out.Mac).toString('base64');
}

export interface MacVerifyArgs {
  kms: KmsMacClient;
  keyId: string;
  ledgerRecord: LedgerRecord;
  /** The base64 MAC previously stored for this record. */
  mac: string;
}

/**
 * Verify a record against its stored MAC. Returns true ONLY on an explicit KMS
 * MacValid === true. Every other outcome (MacValid false, KMS error, KMS
 * invalid-signature exception, malformed mac) returns false — FAIL CLOSED. A
 * caller treats false as tamper/unavailable and BLOCKS.
 */
export async function macVerify(args: MacVerifyArgs): Promise<boolean> {
  const { kms, keyId, ledgerRecord, mac } = args;
  let macBytes: Uint8Array;
  try {
    macBytes = new Uint8Array(Buffer.from(mac, 'base64'));
  } catch {
    return false;
  }
  if (macBytes.length === 0) return false;

  try {
    const out = (await kms.send(
      new VerifyMacCommand({
        KeyId: keyId,
        MacAlgorithm: MAC_ALGORITHM,
        Message: canonicalize(ledgerRecord),
        Mac: macBytes,
      }),
    )) as VerifyMacCommandOutput;
    return out.MacValid === true;
  } catch (err) {
    // KMSInvalidMacException is thrown (not a soft false) when the MAC does not
    // match. Any thrown error — bad MAC, KMS down, IAM denied — is a BLOCK.
    void err;
    return false;
  }
}

/** A stored, signed ledger record: the day snapshot plus its base64 MAC. */
export interface SignedLedgerRecord {
  record: LedgerRecord;
  mac: string;
}

export type ChainVerdict =
  | { ok: true }
  | {
      ok: false;
      verdict: 'BLOCK';
      reason:
        | 'empty'
        | 'forged'
        | 'non_monotonic_seq'
        | 'decremented_spent'
        | 'rolled_back'
        | 'non_finite'
        | 'truncated';
      atIndex?: number;
    };

/**
 * Verify an ordered chain of signed day records (oldest -> newest, same day).
 * BLOCKS on any of:
 *   - empty chain where a ledger was expected (a "missing" ledger is suspicious,
 *     not benign) — caller passes expectNonEmpty to enforce this;
 *   - a record whose MAC does not verify (forged / corrupted);
 *   - a non-monotonic mutation counter (seq must be strictly increasing);
 *   - a decremented cumulative spend (spent must be non-decreasing within a day);
 *   - a rolled-back record (a later record with a seq <= an earlier one, i.e. an
 *     old snapshot re-inserted to lower the total).
 *
 * Returns { ok:true } only when EVERY record verifies AND the sequence is
 * strictly monotonic with non-decreasing spend AND (when an external head is
 * supplied) the newest record matches it. Any failure is a fail-closed BLOCK
 * verdict naming the reason and the offending index.
 *
 * TAIL TRUNCATION: per-record MACs alone CANNOT detect a delete-the-newest-rows
 * attack (every surviving row is genuinely signed; the prefix is internally
 * consistent at a lower spend total). Deletion needs no forgery, so to catch it
 * the caller MUST pass expectedHeadSeq (and ideally expectedHeadSpent) read from
 * an independently-stored, separately-signed head pointer OUTSIDE the deletable
 * ledger table. With a head supplied, a short or empty chain BLOCKS ('truncated').
 */
export async function verifyChain(
  records: SignedLedgerRecord[],
  opts: {
    kms: KmsMacClient;
    keyId: string;
    expectNonEmpty?: boolean;
    /** Externally-known newest seq; a chain not ending here is truncated. */
    expectedHeadSeq?: number;
    /** Externally-known newest cumulative spend (checked when provided). */
    expectedHeadSpent?: number;
  } = {
    kms: { send: async () => ({}) },
    keyId: '',
  },
): Promise<ChainVerdict> {
  const headExpected = opts.expectedHeadSeq !== undefined;
  if (records.length === 0) {
    // A missing ledger is a BLOCK when the caller expected one, and a head that
    // was expected but is entirely gone is a (total) truncation, not benign.
    if (headExpected) {
      return { ok: false, verdict: 'BLOCK', reason: 'truncated' };
    }
    if (opts.expectNonEmpty) {
      return { ok: false, verdict: 'BLOCK', reason: 'empty' };
    }
    return { ok: true };
  }

  let prevSeq = -Infinity;
  let prevSpent = -Infinity;

  for (let i = 0; i < records.length; i++) {
    const { record, mac } = records[i];

    // 0) Non-finite seq/spent: NaN/Infinity slip past EVERY relational
    //    comparison below (x < y, x <= y, x === y are all false for NaN), so a
    //    forged record carrying seq=NaN would otherwise pass. Reject up front.
    if (!Number.isFinite(record.seq) || !Number.isFinite(record.spent)) {
      return { ok: false, verdict: 'BLOCK', reason: 'non_finite', atIndex: i };
    }

    // 1) Forgery / tamper: the MAC must verify. Fails closed on any KMS issue.
    const valid = await macVerify({
      kms: opts.kms,
      keyId: opts.keyId,
      ledgerRecord: record,
      mac,
    });
    if (!valid) {
      return { ok: false, verdict: 'BLOCK', reason: 'forged', atIndex: i };
    }

    // 2) Rolled-back: a later snapshot must not carry an older-or-equal seq.
    //    (A re-inserted old record to lower the running total.)
    if (record.seq <= prevSeq && i > 0) {
      return { ok: false, verdict: 'BLOCK', reason: 'rolled_back', atIndex: i };
    }

    // 3) Non-monotonic counter: seq must strictly increase across the chain.
    if (record.seq < prevSeq || (i > 0 && record.seq === prevSeq)) {
      return { ok: false, verdict: 'BLOCK', reason: 'non_monotonic_seq', atIndex: i };
    }

    // 4) Decremented spend: cumulative spent never goes down within a day.
    if (record.spent < prevSpent) {
      return { ok: false, verdict: 'BLOCK', reason: 'decremented_spent', atIndex: i };
    }

    prevSeq = record.seq;
    prevSpent = record.spent;
  }

  // 5) Tail truncation: every surviving row is genuinely signed, so only an
  //    externally-known head can prove the newest rows were not deleted. When a
  //    head is supplied, the chain MUST end exactly on it; otherwise BLOCK.
  if (headExpected) {
    const head = records[records.length - 1].record;
    if (
      head.seq !== opts.expectedHeadSeq ||
      (opts.expectedHeadSpent !== undefined && head.spent !== opts.expectedHeadSpent)
    ) {
      return { ok: false, verdict: 'BLOCK', reason: 'truncated', atIndex: records.length - 1 };
    }
  }

  return { ok: true };
}
