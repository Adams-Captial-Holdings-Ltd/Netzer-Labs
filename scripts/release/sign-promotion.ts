/**
 * Promotion attestation signing (IaC readiness plan, item 44) — implementation.
 *
 * build-release.ts emits `promotion-attestation.skeleton.json` with
 * `sig: '<signed at promotion>'`: the rc build knows its own tag, commit and
 * image digests, but nothing in the repo ever SIGNS that binding. This is that
 * step. Release CI runs it when `rc/vX.Y.Z` is promoted to the final `vX.Y.Z`
 * tag, and writes the real `promotion-attestation.json` next to the release.
 *
 * WHY THE rcTag CHECK LIVES HERE, AND NOWHERE ELSE
 * ------------------------------------------------
 * `rcTag` is inside the signed bytes (promotion.ts `attestationBytes`), so an
 * attacker downstream cannot mutate it — only the legitimate signer ever
 * chooses it. A wrong `rcTag` is therefore a PUBLISHER mistake, and this call
 * site is exactly where a publisher makes it. `verifyPromotionAttestation`
 * deliberately never inspects `rcTag` at all, so if the refusal below does not
 * catch a mis-promotion, nothing downstream will.
 *
 * NOTE ON THE SPLIT: like build-release.ts this module is import-safe — it has
 * no top-level effects, so a test importing `signPromotion` can never fire the
 * CLI. The matching thin `sign-promotion-entry.ts` / `.mjs` launcher pair is
 * the release-CI wiring step and is intentionally not part of this change.
 */

import { createPublicKey } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createPromotionAttestation,
  serializePromotionAttestation,
  verifyPromotionAttestation,
  type PromotionAttestation,
} from '../lib/release/promotion.js';
import type { ReleaseImage } from '../lib/release/metadata.js';

export interface SignPromotionOptions {
  /** The final release tag being published (v1.4.0). */
  finalTag: string;
  /** The rc tag whose artifacts were canary-tested; must be `rc/<finalTag>`. */
  rcTag: string;
  commit: string;
  /** Same shape build-release.ts takes via --images. */
  images: ReleaseImage[];
  privKeyPem: string;
  canaryRunId?: string;
}

/**
 * Refuse anything that is not a real rc → final promotion. Order matters: the
 * tag SHAPE is checked first so passing an rc tag as --final-tag reports the
 * shape problem rather than a confusing prefix mismatch.
 */
export function assertPromotionTags(finalTag: string, rcTag: string): void {
  if (!/^v\d/.test(finalTag)) {
    throw new Error(
      `--final-tag ${finalTag} is not a final release tag (expected /^v\\d/, e.g. v1.4.0); ` +
        'rc-shaped tags are refused — promote TO the final tag, not to another rc',
    );
  }
  if (rcTag === finalTag) {
    throw new Error(
      `refusing to self-promote: --rc-tag equals --final-tag (${finalTag}); the attestation ` +
        'must bind the final tag to the rc that was actually canary-tested',
    );
  }
  if (rcTag !== `rc/${finalTag}`) {
    throw new Error(
      `--rc-tag ${rcTag} does not name the rc for ${finalTag} (expected rc/${finalTag}); ` +
        'rcTag is inside the signed bytes, so signing this would permanently attest that ' +
        `${finalTag} was tested as ${rcTag}`,
    );
  }
}

/** Validate the promotion, sign it, and SELF-VERIFY the signature. Pure (no fs). */
export function signPromotion(opts: SignPromotionOptions): PromotionAttestation {
  assertPromotionTags(opts.finalTag, opts.rcTag);

  const imageDigests = Object.fromEntries(opts.images.map((i) => [i.platform, i.digest]));
  const att = createPromotionAttestation(opts.privKeyPem, {
    finalTag: opts.finalTag,
    rcTag: opts.rcTag,
    commit: opts.commit,
    imageDigests,
    ...(opts.canaryRunId !== undefined ? { canaryRunId: opts.canaryRunId } : {}),
  });

  // SELF-VERIFY with the same function adopters run, against the public key
  // derived from the signing key — an attestation that would fail adopters
  // fails right here (build-release.ts does the same with the shim path).
  const pubPem = createPublicKey(opts.privKeyPem)
    .export({ type: 'spki', format: 'pem' })
    .toString();
  const res = verifyPromotionAttestation([pubPem], att, {
    finalTag: opts.finalTag,
    commit: opts.commit,
    imageDigests,
  });
  if (!res.ok) {
    throw new Error(`signed promotion attestation failed self-verification: ${res.problems.join('; ')}`);
  }
  return att;
}

// ─────────────────────────────────────────────────────────────────────
// CLI main:
//   --final-tag v1.4.0 --rc-tag rc/v1.4.0 --commit <sha> \
//   --images <images.json> --key <ed25519-priv.pem> \
//   [--canary-run-id <id>] [--out dist-release]
// ─────────────────────────────────────────────────────────────────────

function flagValue(argv: string[], name: string): string | undefined {
  const withEq = argv.find((a) => a.startsWith(`${name}=`));
  if (withEq) return withEq.split('=').slice(1).join('=');
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

export async function signPromotionMain(argv: string[]): Promise<number> {
  const finalTag = flagValue(argv, '--final-tag');
  const rcTag = flagValue(argv, '--rc-tag');
  const commit = flagValue(argv, '--commit');
  const imagesPath = flagValue(argv, '--images');
  const keyPath = flagValue(argv, '--key');
  if (!finalTag || !rcTag || !commit || !imagesPath || !keyPath) {
    console.error(
      'usage: node scripts/release/sign-promotion.mjs --final-tag <v*> --rc-tag <rc/v*> ' +
        '--commit <sha> --images <images.json> --key <priv.pem> ' +
        '[--canary-run-id <id>] [--out <dir>]',
    );
    return 2;
  }

  const canaryRunId = flagValue(argv, '--canary-run-id');
  let att: PromotionAttestation;
  try {
    att = signPromotion({
      finalTag,
      rcTag,
      commit,
      images: JSON.parse(readFileSync(imagesPath, 'utf8')) as ReleaseImage[],
      privKeyPem: readFileSync(keyPath, 'utf8'),
      ...(canaryRunId !== undefined ? { canaryRunId } : {}),
    });
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  const outDir = join(flagValue(argv, '--out') ?? 'dist-release', finalTag.replace(/\//g, '-'));
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, 'promotion-attestation.json');
  writeFileSync(outFile, serializePromotionAttestation(att));
  console.log(`wrote ${outFile}`);
  console.log(`promotion attestation signed and self-verified: ${rcTag} -> ${finalTag}`);
  return 0;
}
