/**
 * Release assembly (IaC readiness plan, items 41 + 44) — implementation.
 *
 * scripts/release/build-release.mjs is the stable plain-node launcher
 * (release CI calls it at tag time); this file is the logic, in TS so it
 * shares the metadata/signing modules with the verifier — one source of
 * truth, the release is validated WITH THE SAME CODE the shim verifies with.
 *
 * Given a tag + signing key file, emits dist-release/<tag>/:
 *   metadata.json                      — item 44's signed metadata contract
 *   artifact-manifest.json             — item 41's tag→commit→digests map
 *   signature.json                     — payload + ed25519 sig (tag-free)
 *   promotion-attestation.skeleton.json— filled at v* publish time, binding
 *                                        the final tag to the rc artifacts
 *
 * Then self-validates through verifyReleaseArtifacts — the exact verify path
 * the updater shim runs — so a release that would fail adopters fails HERE.
 *
 * Image digests come from --images <file.json> (an array of
 * {platform,digest,publicRepo}) because the multi-arch build + public-gallery
 * push happen in release CI before this step; at first-release time the
 * gallery does not exist yet and a fixture file exercises the pipeline.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ARTIFACT_MANIFEST_SCHEMA_VERSION,
  immutableMetadataHash,
  RELEASE_METADATA_SCHEMA_VERSION,
  serializeArtifactManifest,
  serializeReleaseMetadata,
  type ArtifactManifest,
  type ReleaseImage,
  type ReleaseMetadata,
} from '../lib/release/metadata.js';
import {
  SIGNATURE_ARTIFACT_SCHEMA_VERSION,
  serializeSignatureArtifact,
  signReleasePayload,
  type ReleaseSignPayload,
  type SignatureArtifact,
} from '../lib/release/signing.js';
import { PROMOTION_ATTESTATION_SCHEMA_VERSION } from '../lib/release/promotion.js';
import { verifyReleaseArtifacts } from '../update/shim.js';
import { APP_SCHEMA_VERSION } from '../lib/lifecycle/manifest.js';
import { capture } from '../lib/shell.js';

export interface AssembleReleaseOptions {
  tag: string;
  commit: string;
  privKeyPem: string;
  /** Public key PEM(s) to self-validate against (the would-be trust roots). */
  verifyRoots: string[];
  images: ReleaseImage[];
  provenance: string;
  /** Overridable pieces of the metadata; sane defaults below. */
  minNode?: string;
  minNpm?: string;
  /** Oldest release this one direct-upgrades from (N-1 per item 49). */
  directFrom?: string;
  upgradingUrl?: string;
}

export interface AssembledRelease {
  files: Record<string, string>;
  metadata: ReleaseMetadata;
}

/** Build + sign + SELF-VERIFY the release artifact set. Pure (no fs). */
export function assembleRelease(opts: AssembleReleaseOptions): AssembledRelease {
  const metadata: ReleaseMetadata = {
    schemaVersion: RELEASE_METADATA_SCHEMA_VERSION,
    tag: opts.tag,
    commit: opts.commit,
    appSchemaVersion: APP_SCHEMA_VERSION,
    bootstrapPrerequisites: {
      minNode: opts.minNode ?? '20.0.0',
      minNpm: opts.minNpm ?? '10.0.0',
    },
    // First releases carry no actions/migrations; later releases pass these
    // in once the release process grows a per-release config file.
    requiredActions: [],
    migrationFlags: { phases: [], maintenanceModePhases: [] },
    rollbackPosture: 'reversible',
    // NOTE: every defaulted field below must be CHANNEL-INDEPENDENT. The
    // immutable metadata hash covers them, so anything derived from the tag
    // would give rc and final different hashes and break the shared
    // signature (the build-release test proves this stays true).
    supportWindow: { directFrom: opts.directFrom ?? '' },
    upgradingUrl:
      opts.upgradingUrl ??
      `https://github.com/Adams-Captial-Holdings-Ltd/Netzer-Labs/blob/${opts.commit}/docs/release-pipeline.md`,
    images: opts.images,
    artifactManifestKey: 'artifact-manifest.json',
  };

  const manifest: ArtifactManifest = {
    schemaVersion: ARTIFACT_MANIFEST_SCHEMA_VERSION,
    tag: opts.tag,
    commit: opts.commit,
    images: opts.images,
    provenance: opts.provenance,
  };

  const payload: ReleaseSignPayload = {
    commit: opts.commit,
    imageDigests: Object.fromEntries(opts.images.map((i) => [i.platform, i.digest])),
    provenance: opts.provenance,
    metadataHash: immutableMetadataHash(metadata),
  };
  const signature: SignatureArtifact = {
    schemaVersion: SIGNATURE_ARTIFACT_SCHEMA_VERSION,
    payload,
    sig: signReleasePayload(opts.privKeyPem, payload),
  };

  // The promotion skeleton: publish-time tooling fills finalTag/canaryRunId
  // and signs it when the rc is promoted (sig stays empty here on purpose).
  const promotionSkeleton = {
    schemaVersion: PROMOTION_ATTESTATION_SCHEMA_VERSION,
    finalTag: '<filled at v* publish time>',
    rcTag: opts.tag,
    commit: opts.commit,
    imageDigests: payload.imageDigests,
    canaryRunId: '<canary run that upgraded previous-release -> this rc>',
    sig: '<signed at promotion>',
  };

  const files: Record<string, string> = {
    'metadata.json': serializeReleaseMetadata(metadata),
    'artifact-manifest.json': serializeArtifactManifest(manifest),
    'signature.json': serializeSignatureArtifact(signature),
    'promotion-attestation.skeleton.json': JSON.stringify(promotionSkeleton, null, 2) + '\n',
  };

  // SELF-VALIDATE with the shim's exact verify path: a release that fails
  // adopters fails right here, at build time.
  verifyReleaseArtifacts({
    metadataJson: files['metadata.json'],
    artifactManifestJson: files['artifact-manifest.json'],
    signatureJson: files['signature.json'],
    rotationDocs: [],
    pinnedRoots: opts.verifyRoots,
  });

  return { files, metadata };
}

// ─────────────────────────────────────────────────────────────────────
// CLI main (invoked by build-release.mjs):
//   --tag v1.0.0 --key <ed25519-priv.pem> --pub <ed25519-pub.pem>
//   --images <images.json> [--provenance <string>] [--out dist-release]
// ─────────────────────────────────────────────────────────────────────

function flagValue(argv: string[], name: string): string | undefined {
  const withEq = argv.find((a) => a.startsWith(`${name}=`));
  if (withEq) return withEq.split('=').slice(1).join('=');
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

export async function buildReleaseMain(argv: string[]): Promise<number> {
  const tag = flagValue(argv, '--tag');
  const keyPath = flagValue(argv, '--key');
  const pubPath = flagValue(argv, '--pub');
  const imagesPath = flagValue(argv, '--images');
  if (!tag || !keyPath || !pubPath || !imagesPath) {
    console.error(
      'usage: node scripts/release/build-release.mjs --tag <tag> --key <priv.pem> ' +
        '--pub <pub.pem> --images <images.json> [--provenance <s>] [--out <dir>]',
    );
    return 2;
  }

  const commitRes = await capture('git', ['rev-parse', tag === 'HEAD' ? 'HEAD' : `${tag}^{commit}`]);
  if (commitRes.code !== 0) {
    console.error(`cannot resolve commit for tag ${tag}: ${commitRes.stderr.trim()}`);
    return 1;
  }

  const { files } = assembleRelease({
    tag,
    commit: commitRes.stdout.trim(),
    privKeyPem: readFileSync(keyPath, 'utf8'),
    verifyRoots: [readFileSync(pubPath, 'utf8')],
    images: JSON.parse(readFileSync(imagesPath, 'utf8')) as ReleaseImage[],
    provenance: flagValue(argv, '--provenance') ?? `local-build:${tag}`,
  });

  const outRoot = flagValue(argv, '--out') ?? 'dist-release';
  const outDir = join(outRoot, tag.replace(/\//g, '-'));
  mkdirSync(outDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(outDir, name), content);
    console.log(`wrote ${join(outDir, name)}`);
  }
  console.log('release artifacts assembled and self-verified (shim verify path).');
  return 0;
}
