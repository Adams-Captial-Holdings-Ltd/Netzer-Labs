/**
 * Promotion attestation (IaC readiness plan, item 44).
 *
 * The release signature is deliberately TAG-FREE (signing.ts), so something
 * else must say "v1.4.0 IS the artifact that rc/v1.4.0 tested". That is the
 * promotion attestation: published alongside the final `v*` tag, it binds
 * the final tag to the exact rc-tested commit + image digests (and, when
 * available, the canary run that proved them). Unlike the release signature,
 * the attestation's signed bytes INCLUDE both tags — channel identity is its
 * entire purpose.
 */

import {
  createPrivateKey,
  createPublicKey,
  sign as edSign,
  verify as edVerify,
} from 'node:crypto';

export const PROMOTION_ATTESTATION_SCHEMA_VERSION = 1;

export interface PromotionAttestation {
  schemaVersion: number;
  /** The final release tag being published (v1.4.0). */
  finalTag: string;
  /** The rc tag whose artifacts were canary-tested (rc/v1.4.0). */
  rcTag: string;
  commit: string;
  /** platform -> sha256 digest; must equal the rc-tested digests exactly. */
  imageDigests: Record<string, string>;
  /** Canary run that upgraded previous-release → rc (item 38), when recorded. */
  canaryRunId?: string;
  /** base64 ed25519 over attestationBytes (everything except sig). */
  sig: string;
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(obj)
        .sort()
        .map((k) => [k, sortKeysDeep(obj[k])]),
    );
  }
  return value;
}

/** Canonical signed bytes: every field except `sig`, sorted keys. */
export function attestationBytes(att: Omit<PromotionAttestation, 'sig'>): Buffer {
  const { schemaVersion, finalTag, rcTag, commit, imageDigests, canaryRunId } = att;
  const body: Record<string, unknown> = {
    schemaVersion,
    finalTag,
    rcTag,
    commit,
    imageDigests,
  };
  if (canaryRunId !== undefined) body.canaryRunId = canaryRunId;
  return Buffer.from(JSON.stringify(sortKeysDeep(body)), 'utf8');
}

export interface CreatePromotionOptions {
  finalTag: string;
  rcTag: string;
  commit: string;
  imageDigests: Record<string, string>;
  canaryRunId?: string;
}

/** Create + sign a promotion attestation with a release-signing private key. */
export function createPromotionAttestation(
  privKeyPem: string,
  opts: CreatePromotionOptions,
): PromotionAttestation {
  const unsigned: Omit<PromotionAttestation, 'sig'> = {
    schemaVersion: PROMOTION_ATTESTATION_SCHEMA_VERSION,
    finalTag: opts.finalTag,
    rcTag: opts.rcTag,
    commit: opts.commit,
    imageDigests: opts.imageDigests,
    ...(opts.canaryRunId !== undefined ? { canaryRunId: opts.canaryRunId } : {}),
  };
  const key = createPrivateKey(privKeyPem);
  const sig = edSign(null, attestationBytes(unsigned), key).toString('base64');
  return { ...unsigned, sig };
}

/**
 * Verify an attestation against the trust roots, AND against the artifacts
 * the caller already verified: the attestation must name the same commit and
 * the exact same per-platform digests, or the binding is meaningless.
 */
export function verifyPromotionAttestation(
  roots: readonly string[],
  att: PromotionAttestation,
  expected: { finalTag: string; commit: string; imageDigests: Record<string, string> },
): { ok: boolean; problems: string[] } {
  const problems: string[] = [];

  if (typeof att.schemaVersion !== 'number' || att.schemaVersion < 1) {
    problems.push('attestation has an invalid schemaVersion');
  }
  if (att.finalTag !== expected.finalTag) {
    problems.push(
      `attestation finalTag "${att.finalTag}" does not match the tag being installed ` +
        `("${expected.finalTag}")`,
    );
  }
  if (att.commit !== expected.commit) {
    problems.push(
      `attestation commit ${att.commit} does not match the verified release commit ${expected.commit}`,
    );
  }
  const expectedPlatforms = Object.keys(expected.imageDigests).sort();
  const attPlatforms = Object.keys(att.imageDigests ?? {}).sort();
  if (JSON.stringify(expectedPlatforms) !== JSON.stringify(attPlatforms)) {
    problems.push(
      `attestation covers platforms [${attPlatforms.join(', ')}] but the release ` +
        `publishes [${expectedPlatforms.join(', ')}]`,
    );
  } else {
    for (const platform of expectedPlatforms) {
      if (att.imageDigests[platform] !== expected.imageDigests[platform]) {
        problems.push(
          `attestation digest for ${platform} (${att.imageDigests[platform]}) does not match ` +
            `the verified release digest (${expected.imageDigests[platform]})`,
        );
      }
    }
  }

  const bytes = attestationBytes(att);
  const sigOk = roots.some((root) => {
    try {
      return edVerify(null, bytes, createPublicKey(root), Buffer.from(att.sig, 'base64'));
    } catch {
      return false;
    }
  });
  if (!sigOk) problems.push('attestation signature does not verify against any trust root');

  return { ok: problems.length === 0, problems };
}

/** Parse promotion-attestation.json with loud schema-version errors. */
export function parsePromotionAttestation(json: string): PromotionAttestation {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    throw new Error(
      `promotion attestation is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('promotion attestation must be a JSON object');
  }
  const m = raw as Record<string, unknown>;
  if (m.schemaVersion === undefined) {
    throw new Error('promotion attestation is missing "schemaVersion"; refusing to guess its format');
  }
  for (const field of ['finalTag', 'rcTag', 'commit', 'sig'] as const) {
    if (typeof m[field] !== 'string' || m[field] === '') {
      throw new Error(`promotion attestation is missing required field "${field}"`);
    }
  }
  if (m.imageDigests === null || typeof m.imageDigests !== 'object') {
    throw new Error('promotion attestation is missing "imageDigests"');
  }
  return {
    schemaVersion: m.schemaVersion as number,
    finalTag: m.finalTag as string,
    rcTag: m.rcTag as string,
    commit: m.commit as string,
    imageDigests: m.imageDigests as Record<string, string>,
    ...(typeof m.canaryRunId === 'string' ? { canaryRunId: m.canaryRunId } : {}),
    sig: m.sig as string,
  };
}

/** Stable serialization. */
export function serializePromotionAttestation(att: PromotionAttestation): string {
  return JSON.stringify(sortKeysDeep(att as unknown as Record<string, unknown>), null, 2) + '\n';
}
