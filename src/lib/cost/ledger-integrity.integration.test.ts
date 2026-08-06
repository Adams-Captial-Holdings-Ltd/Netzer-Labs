/**
 * Integration test: ledger-integrity KMS HMAC MAC against REAL KMS (LocalStack).
 *
 * The mocked unit tests (./ledger-integrity.test.ts) prove the conditional
 * branching by stubbing `{ send }`. They CANNOT prove the real KMS MAC
 * semantics: that GenerateMac over the canonical bytes produces a MAC which
 * VerifyMac accepts, and that ANY altered byte makes VerifyMac reject (the
 * KMSInvalidMacException path that drives the fail-closed BLOCK). This file
 * exercises macSign / macVerify / verifyChain against a real HMAC_256 KMS key
 * on LocalStack so the canonicalize -> GenerateMac -> VerifyMac round trip is
 * tested end to end with genuine cryptographic MACs.
 *
 * CAPABILITY PROBE: LocalStack community editions have historically NOT
 * implemented KMS HMAC keys (KeySpec HMAC_256, KeyUsage GENERATE_VERIFY_MAC) or
 * the GenerateMac / VerifyMac operations. The beforeAll below creates such a key
 * and attempts ONE GenerateMac. If anything in that path is rejected
 * (UnsupportedOperationException, NotFoundException, validation error, any
 * throw), every test below is it.skip(...)'d with the reason
 * 'LocalStack KMS HMAC unsupported in this image'. We never fake a pass: a
 * skipped-with-reason test is the correct, honest outcome for an unsupported op.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  KMSClient,
  CreateKeyCommand,
  GenerateMacCommand,
} from '@aws-sdk/client-kms';
import {
  ensureLocalStack,
  configureLocalAwsEnv,
} from '../../__test-utils__/localstack.js';
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

const ENDPOINT = process.env.AWS_ENDPOINT_URL ?? 'http://localhost:4566';

/**
 * Build a real KMS client pointed at LocalStack, EXACTLY mirroring the
 * dynamoClient() shape in the localstack helper.
 */
function kmsClient(): KMSClient {
  return new KMSClient({
    endpoint: ENDPOINT,
    region: 'us-east-1',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });
}

/**
 * Adapt a real KMSClient to the module's KmsMacClient seam. The module only
 * uses `.send()`, so the live client satisfies the interface directly; this
 * wrapper exists only to make the type intent explicit at the call sites.
 */
function macClientFrom(client: KMSClient): KmsMacClient {
  return { send: (command: unknown) => client.send(command as never) };
}

/** A genuine day record for the SAME UTC day; spent rises with seq. */
function rec(seq: number, spent: number): LedgerRecord {
  return { day: '2026-06-16', cap: 50, spent, reserved: 0, headroom: 50 - spent, seq };
}

// Module-level capability state, decided once in beforeAll.
let hmacSupported = false;
let probeReason = '';
let keyId = '';
let kms: KmsMacClient;

beforeAll(async () => {
  configureLocalAwsEnv();
  await ensureLocalStack();

  const client = kmsClient();
  kms = macClientFrom(client);

  // Probe: create an HMAC_256 / GENERATE_VERIFY_MAC key, then attempt one
  // GenerateMac. Any failure in either step means LocalStack in this image does
  // not support KMS HMAC, so we honestly skip rather than fake.
  try {
    const created = await client.send(
      new CreateKeyCommand({
        KeySpec: 'HMAC_256',
        KeyUsage: 'GENERATE_VERIFY_MAC',
        Description: 'claudeclaw-integ-ledger-integrity HMAC MAC key',
      }),
    );
    const id = created.KeyMetadata?.KeyId;
    if (!id) {
      probeReason = 'CreateKey returned no KeyId';
      return;
    }
    keyId = id;

    // The decisive probe: a real GenerateMac over the canonical bytes.
    const mac = await client.send(
      new GenerateMacCommand({
        KeyId: keyId,
        MacAlgorithm: MAC_ALGORITHM,
        Message: canonicalize(rec(1, 0.5)),
      }),
    );
    if (!mac.Mac || mac.Mac.length === 0) {
      probeReason = 'GenerateMac returned an empty Mac';
      return;
    }
    hmacSupported = true;
  } catch (err) {
    // UnsupportedOperationException / NotFoundException / validation / anything.
    probeReason =
      err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    hmacSupported = false;
  }
});

/**
 * Skip-or-run helper. hmacSupported is only known AFTER the beforeAll probe
 * (the probe runs after vitest collection), so each test calls this at the top.
 * In vitest 2.x, ctx.skip() takes no reason argument and throws to abort, so we
 * log the reason first ('LocalStack KMS HMAC unsupported in this image') and
 * then ctx.skip() marks the test skipped at runtime. This is the honest outcome
 * for an unsupported op: skipped-with-reason, never a faked pass against a stub.
 */
function skipUnlessHmac(ctx: { skip: () => void }): void {
  if (hmacSupported) return;
  // eslint-disable-next-line no-console
  console.warn(
    `[ledger-integrity.integration] SKIPPED: LocalStack KMS HMAC unsupported in this image (${probeReason})`,
  );
  ctx.skip();
}

describe('ledger-integrity KMS HMAC (LocalStack, real KMS)', () => {
  it('macSign then macVerify round-trips true for a genuine record', async (ctx) => {
    skipUnlessHmac(ctx);
    const record = rec(1, 0.5);
    const mac = await macSign({ kms, keyId, ledgerRecord: record });
    expect(typeof mac).toBe('string');
    expect(mac.length).toBeGreaterThan(0);

    const ok = await macVerify({ kms, keyId, ledgerRecord: record, mac });
    expect(ok).toBe(true);
  });

  it('macVerify FAILS CLOSED (false) for a record whose content was altered after signing', async (ctx) => {
    skipUnlessHmac(ctx);
    const original = rec(2, 1.0);
    const mac = await macSign({ kms, keyId, ledgerRecord: original });

    // Tamper: decrement the cumulative spend after signing. The canonical bytes
    // change, so the real KMS VerifyMac throws KMSInvalidMacException and
    // macVerify returns false (fail closed). This is the path the mocked unit
    // test could only simulate.
    const tampered: LedgerRecord = { ...original, spent: 0.25, headroom: 50 - 0.25 };
    const ok = await macVerify({ kms, keyId, ledgerRecord: tampered, mac });
    expect(ok).toBe(false);

    // Sanity: the genuine record still verifies with the same MAC, proving the
    // false above is from the alteration, not a flaky key.
    const stillOk = await macVerify({ kms, keyId, ledgerRecord: original, mac });
    expect(stillOk).toBe(true);
  });

  it('verifyChain returns { ok:true } over a clean, genuinely-signed chain', async (ctx) => {
    skipUnlessHmac(ctx);
    const records = [rec(1, 0.5), rec(2, 1.5), rec(3, 2.0)];
    const signed: SignedLedgerRecord[] = [];
    for (const r of records) {
      signed.push({ record: r, mac: await macSign({ kms, keyId, ledgerRecord: r }) });
    }
    const verdict = await verifyChain(signed, { kms, keyId });
    expect(verdict).toEqual({ ok: true });
  });

  it('verifyChain BLOCKS a chain whose record was decremented after signing (forged)', async (ctx) => {
    skipUnlessHmac(ctx);
    const r1 = rec(1, 0.5);
    const r2 = rec(2, 1.5);
    const signed: SignedLedgerRecord[] = [
      { record: r1, mac: await macSign({ kms, keyId, ledgerRecord: r1 }) },
      { record: r2, mac: await macSign({ kms, keyId, ledgerRecord: r2 }) },
    ];
    // Decrement r2's spent in place but keep its (now stale) MAC. Against real
    // KMS the MAC no longer matches the canonical bytes, so verifyChain reaches
    // the macVerify==false branch and BLOCKS with reason 'forged' at index 1.
    signed[1] = { record: { ...r2, spent: 0.1, headroom: 50 - 0.1 }, mac: signed[1].mac };
    const verdict = await verifyChain(signed, { kms, keyId });
    expect(verdict).toEqual({
      ok: false,
      verdict: 'BLOCK',
      reason: 'forged',
      atIndex: 1,
    });
  });

  it('verifyChain BLOCKS a non-finite seq (NaN) with reason non_finite', async (ctx) => {
    skipUnlessHmac(ctx);
    const r1 = rec(1, 0.5);
    // A NaN seq slips past every relational comparison, so the module rejects it
    // up front BEFORE any KMS call. We still sign r1 with the real key so the
    // first record is genuine and the NaN is the only defect.
    const nanRec: LedgerRecord = { ...rec(2, 1.5), seq: Number.NaN };
    const signed: SignedLedgerRecord[] = [
      { record: r1, mac: await macSign({ kms, keyId, ledgerRecord: r1 }) },
      // The MAC here is irrelevant; the non_finite guard fires first.
      { record: nanRec, mac: await macSign({ kms, keyId, ledgerRecord: r1 }) },
    ];
    const verdict = await verifyChain(signed, { kms, keyId });
    expect(verdict).toEqual({
      ok: false,
      verdict: 'BLOCK',
      reason: 'non_finite',
      atIndex: 1,
    });
  });

  it('verifyChain BLOCKS a tail-truncated chain when expectedHeadSeq is supplied (truncated)', async (ctx) => {
    skipUnlessHmac(ctx);
    // Genuinely sign three records, then DELETE the newest one (a real
    // delete-the-tail attack: each surviving row is still genuinely signed).
    // The external head pointer knows the true head was seq=3, so verifyChain
    // must BLOCK 'truncated' even though every remaining MAC verifies.
    const full = [rec(1, 0.5), rec(2, 1.5), rec(3, 2.0)];
    const signed: SignedLedgerRecord[] = [];
    for (const r of full) {
      signed.push({ record: r, mac: await macSign({ kms, keyId, ledgerRecord: r }) });
    }
    const truncated = signed.slice(0, 2); // newest row deleted

    const verdict = await verifyChain(truncated, {
      kms,
      keyId,
      expectedHeadSeq: 3,
      expectedHeadSpent: 2.0,
    });
    expect(verdict).toEqual({
      ok: false,
      verdict: 'BLOCK',
      reason: 'truncated',
      atIndex: 1,
    });
  });
});
