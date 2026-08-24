/**
 * Durability guards for CCE-Storage.
 *
 * These exist because of a real production incident: the vector index lived in
 * the vectors-STAGING bucket, that bucket carried a lifecycle rule with no
 * prefix and no filter, and S3 therefore expired the entire knowledge base
 * seven days after each document was ingested. `versioned: false` made it
 * permanent. See `docs/features/knowledge-durability/README.md`.
 *
 * The invariant these tests defend is narrow and absolute: **a bucket holding
 * durable data must not carry any rule that can delete a current object, and
 * must have versioning on.** Reviewers miss that; a synth assertion does not.
 */
import { describe, it, expect } from 'vitest';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { StorageStack } from './storage-stack.js';
import { UPLOAD_PREFIX } from '../../src/lib/vectors/store.js';

const ENV = { account: '637423318609', region: 'us-east-1' };

function buckets(): Record<string, Record<string, unknown>> {
  const app = new App();
  const stack = new StorageStack(app, 'CCE-Storage', { tier: 1, env: ENV });
  return Template.fromStack(stack).findResources('AWS::S3::Bucket');
}

/** Rules that can delete a CURRENT object (noncurrent-version cleanup cannot). */
function currentObjectExpiries(bucket: Record<string, unknown>): unknown[] {
  const props = (bucket.Properties ?? {}) as Record<string, unknown>;
  const lc = (props.LifecycleConfiguration ?? {}) as { Rules?: Record<string, unknown>[] };
  return (lc.Rules ?? []).filter(
    (r) => r.ExpirationInDays !== undefined || r.ExpirationDate !== undefined,
  );
}

function byLogicalId(prefix: string): [string, Record<string, unknown>] {
  const found = Object.entries(buckets()).find(([id]) => id.startsWith(prefix));
  expect(found, `no bucket with logical id starting "${prefix}"`).toBeDefined();
  return found as [string, Record<string, unknown>];
}

describe('vectors bucket (durable knowledge index)', () => {
  it('carries NO rule that can expire a current object', () => {
    const [, bucket] = byLogicalId('VectorsBucket');
    // Not "scoped to a prefix", not "long enough" — none at all. The index is
    // the only copy of ingested knowledge; nothing re-derives it.
    expect(currentObjectExpiries(bucket)).toEqual([]);
  });

  it('has versioning enabled so a delete is recoverable', () => {
    const [, bucket] = byLogicalId('VectorsBucket');
    const props = bucket.Properties as Record<string, unknown>;
    expect(props.VersioningConfiguration).toEqual({ Status: 'Enabled' });
  });

  it('is a different bucket from the staging bucket', () => {
    const [durableId] = byLogicalId('VectorsBucket');
    const [stagingId] = byLogicalId('VectorsStagingBucket');
    expect(durableId).not.toEqual(stagingId);
  });
});

describe('vectors staging bucket (disposable uploads)', () => {
  it('scopes its expiry to the upload prefix the app actually writes', () => {
    const [, bucket] = byLogicalId('VectorsStagingBucket');
    const rules = currentObjectExpiries(bucket) as Record<string, unknown>[];
    expect(rules).toHaveLength(1);
    // An unprefixed rule here is precisely the 2026-08 defect.
    expect(rules[0].Prefix).toBe(UPLOAD_PREFIX);
  });

  it('keeps its prefix in sync with src/lib/vectors/store.ts', () => {
    // Drift between the CDK literal and the app constant silently re-widens
    // the rule over keys the app did not intend to be disposable.
    const [, bucket] = byLogicalId('VectorsStagingBucket');
    const rules = currentObjectExpiries(bucket) as Record<string, unknown>[];
    expect(rules[0].Prefix).toBe('uploads/');
    expect(UPLOAD_PREFIX).toBe('uploads/');
  });
});

describe('bucket-wide durability classification', () => {
  /**
   * Every bucket must be named here. Adding a bucket without classifying it
   * fails this test on purpose — that forced choice is the whole point.
   *
   * DISPOSABLE means "losing every object here is a non-event". Anything else
   * is DURABLE and may not carry a rule that deletes current objects.
   */
  const DISPOSABLE = new Set(['LogsBucket', 'VectorsStagingBucket']);

  /**
   * KNOWN GAP, tracked in `docs/features/knowledge-durability/README.md`
   * section 7. RawBucket expires every object at 365 days with versioning off,
   * and holds agent-GENERATED documents (`src/lib/tools/document-generation-tools.ts`)
   * alongside transient media. It is the same defect class as the vectors
   * incident with a longer fuse. Listing it here keeps the gap visible instead
   * of letting an allowlist quietly bless it; remove this entry when the
   * retention decision is made.
   */
  const UNRESOLVED = new Set(['RawBucket']);

  it('classifies every bucket in the stack', () => {
    for (const id of Object.keys(buckets())) {
      const known =
        [...DISPOSABLE, ...UNRESOLVED].some((p) => id.startsWith(p)) ||
        ['ConfigBucket', 'CuratedBucket', 'VectorsBucket', 'AuditLock'].some((p) =>
          id.startsWith(p),
        );
      expect(known, `unclassified bucket "${id}" — declare it DURABLE or DISPOSABLE`).toBe(
        true,
      );
    }
  });

  it('no durable bucket carries an unscoped expiry', () => {
    for (const [id, bucket] of Object.entries(buckets())) {
      if ([...DISPOSABLE, ...UNRESOLVED].some((p) => id.startsWith(p))) continue;
      const unscoped = (currentObjectExpiries(bucket) as Record<string, unknown>[]).filter(
        (r) => r.Prefix === undefined && r.Filter === undefined,
      );
      expect(unscoped, `durable bucket "${id}" has a bucket-wide expiry rule`).toEqual([]);
    }
  });
});

/**
 * Reachability guard.
 *
 * Durability is not the only way knowledge silently fails to persist. In the
 * same 2026-08 production incident the browser could not PUT at all: the
 * staging bucket's CORS allowlist was built only from `DOMAIN_NAME`, the
 * deploy shell set `CCE_DASHBOARD_URL` instead, and the synthesized allowlist
 * was `['http://localhost:3000']`. Every upload from `https://app.pgnos.ai`
 * died in CORS preflight, so nothing ever reached S3 and nothing was logged
 * server-side. A bucket that cannot be written to loses knowledge just as
 * effectively as one that expires it.
 */
describe('vectors staging bucket (browser upload reachability)', () => {
  function originsWith(env: Record<string, string | undefined>): string[] {
    const saved = { DOMAIN_NAME: process.env.DOMAIN_NAME, CCE_DASHBOARD_URL: process.env.CCE_DASHBOARD_URL };
    // Assigning undefined into process.env coerces to the STRING "undefined";
    // the key has to be deleted to be genuinely absent.
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      const [, bucket] = byLogicalId('VectorsStagingBucket');
      const props = bucket.Properties as { CorsConfiguration?: { CorsRules?: { AllowedOrigins?: string[] }[] } };
      return (props.CorsConfiguration?.CorsRules ?? []).flatMap((r) => r.AllowedOrigins ?? []);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  it('allows the dashboard origin when only CCE_DASHBOARD_URL is set', () => {
    // The exact shape of the outage: DOMAIN_NAME absent from the deploy shell.
    const origins = originsWith({ DOMAIN_NAME: undefined, CCE_DASHBOARD_URL: 'https://app.pgnos.ai' });
    expect(origins).toContain('https://app.pgnos.ai');
  });

  it('allows the dashboard origin when only DOMAIN_NAME is set', () => {
    const origins = originsWith({ DOMAIN_NAME: 'app.pgnos.ai', CCE_DASHBOARD_URL: undefined });
    expect(origins).toContain('https://app.pgnos.ai');
  });

  it('never degrades to a localhost-only allowlist when an origin is configured', () => {
    const origins = originsWith({ DOMAIN_NAME: undefined, CCE_DASHBOARD_URL: 'https://app.pgnos.ai' });
    expect(origins).not.toEqual(['http://localhost:3000']);
  });

  it('takes the origin only, discarding any path on the dashboard URL', () => {
    const origins = originsWith({ DOMAIN_NAME: undefined, CCE_DASHBOARD_URL: 'https://app.pgnos.ai/dashboard/' });
    expect(origins).toContain('https://app.pgnos.ai');
  });
});
