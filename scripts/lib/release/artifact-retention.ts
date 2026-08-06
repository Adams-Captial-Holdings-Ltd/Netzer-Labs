/**
 * Artifact-retention verification (IaC readiness plan, item 44).
 *
 * The support window (item 49) promises upgrade CHAINS: an old install hops
 * release-by-release through every intermediate version. That only works if
 * every release inside the window keeps ALL of its artifacts fetchable
 * upstream — tag, signed metadata, artifact manifest, signature, images,
 * promotion attestation, and the verification keys/rotation chain. A pruned
 * stepping-stone strands EVERY adopter behind it, permanently.
 *
 * Release CI runs verifyRetention() over the in-window release list on every
 * release; a single missing artifact fails the release. The fetcher is
 * injected so tests run on fakes and CI wires the real GitHub/ECR-Public
 * clients.
 */

import { parseReleaseMetadata, type ReleaseMetadata } from './metadata.js';

/** Everything retention checking needs to reach, behind one injected seam. */
export interface RetentionFetcher {
  /** Does the git tag still exist upstream? */
  tagExists(tag: string): Promise<boolean>;
  /** Release metadata.json bytes, or null when the asset is gone. */
  fetchMetadata(tag: string): Promise<string | null>;
  /** Artifact manifest bytes, or null. */
  fetchArtifactManifest(tag: string): Promise<string | null>;
  /** signature.json bytes, or null. */
  fetchSignature(tag: string): Promise<string | null>;
  /** promotion-attestation.json bytes, or null (rc tags never have one). */
  fetchPromotionAttestation(tag: string): Promise<string | null>;
  /** Is the image digest still pullable from the public gallery? */
  imageAvailable(publicRepo: string, digest: string): Promise<boolean>;
  /**
   * Are the verification keys (current roots + every rotation doc the chain
   * needs) still published? Old shims re-fetch rotation docs, so the FULL
   * chain must stay up, not just the newest key.
   */
  verificationKeysAvailable(): Promise<boolean>;
}

export interface RetentionReport {
  tag: string;
  ok: boolean;
  problems: string[];
}

export interface RetentionResult {
  ok: boolean;
  reports: RetentionReport[];
}

/** Final release tags (v*) carry a promotion attestation; rc tags do not. */
export function isFinalReleaseTag(tag: string): boolean {
  return /^v\d/.test(tag);
}

/**
 * Verify every listed release still has its complete artifact set upstream.
 * `releases` is the in-window tag list (newest release's supportWindow
 * decides membership; the caller computes the list). Never throws on a
 * missing artifact — it reports, so CI prints the FULL damage at once.
 */
export async function verifyRetention(
  fetcher: RetentionFetcher,
  releases: readonly string[],
): Promise<RetentionResult> {
  const reports: RetentionReport[] = [];

  const keysOk = await fetcher.verificationKeysAvailable();

  for (const tag of releases) {
    const problems: string[] = [];

    if (!(await fetcher.tagExists(tag))) {
      problems.push(`git tag ${tag} no longer exists upstream`);
    }

    let metadata: ReleaseMetadata | null = null;
    const metadataJson = await fetcher.fetchMetadata(tag);
    if (metadataJson === null) {
      problems.push(`release metadata for ${tag} is no longer fetchable`);
    } else {
      try {
        metadata = parseReleaseMetadata(metadataJson).metadata;
      } catch (err) {
        problems.push(
          `release metadata for ${tag} no longer parses: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if ((await fetcher.fetchArtifactManifest(tag)) === null) {
      problems.push(`artifact manifest for ${tag} is no longer fetchable`);
    }
    if ((await fetcher.fetchSignature(tag)) === null) {
      problems.push(`signature for ${tag} is no longer fetchable`);
    }
    if (isFinalReleaseTag(tag) && (await fetcher.fetchPromotionAttestation(tag)) === null) {
      problems.push(`promotion attestation for ${tag} is no longer fetchable`);
    }

    if (metadata) {
      for (const img of metadata.images) {
        if (!(await fetcher.imageAvailable(img.publicRepo, img.digest))) {
          problems.push(
            `image ${img.platform} ${img.digest} is no longer available in ${img.publicRepo}`,
          );
        }
      }
    }

    if (!keysOk) {
      problems.push('verification keys / rotation chain are no longer published');
    }

    reports.push({ tag, ok: problems.length === 0, problems });
  }

  return { ok: reports.every((r) => r.ok), reports };
}
