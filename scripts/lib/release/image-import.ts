/**
 * Release-image import: public gallery → adopter's private ECR (item 41).
 *
 * ECR Public is DISTRIBUTION ONLY, never the runtime source. Fargate tasks
 * in private subnets pull through private-ECR VPC endpoints; running off the
 * public gallery would break private-subnet pulls, expose rollouts to public
 * pull quotas, and contradict P3's private-ECR retention/rollback guarantees.
 * So deploy/update IMPORT the verified digest into the adopter's own private
 * regional repo (a bootstrap-state primitive, item 6) and the manifest pins
 * the PRIVATE digest.
 *
 * The copy MUST be registry-native and manifest-preserving (`crane copy` or
 * `skopeo copy --all`), run from the operator's machine with explicit
 * egress. NEVER `docker pull` + `docker tag` + `docker push`: the docker
 * daemon round-trip can rewrite manifests (compression, schema conversion,
 * platform selection), which changes the digest and silently breaks the
 * signature chain. The injected runner interface only exposes copy + digest
 * — there is deliberately no way to express a pull/tag/push flow through it.
 *
 * ECR pull-through cache is ruled out for the same reason it sounds
 * attractive: it defers the copy to FIRST PULL, which happens at task start
 * — exactly when a private-subnet task cannot reach the public internet.
 * The import must complete (and verify) BEFORE Compute synth pins the
 * digest, not lazily at runtime.
 *
 * Trust carries by DIGEST PINNING after verified import; the private copy is
 * not re-signed. After the copy, the private-ECR digest is read back and
 * MUST equal the signed digest — a mismatch is a hard failure (tampering,
 * a manifest-rewriting tool, or a corrupted copy).
 */

/**
 * Registry-native copy runner. ONLY copy + digest are exposed, so a
 * docker-daemon pull/tag/push flow cannot be expressed through this seam.
 * Production wires `crane` (`crane copy`, `crane digest`) or skopeo
 * (`skopeo copy --all`, `skopeo inspect --format {{.Digest}}`).
 */
export interface RegistryCopyRunner {
  /** `crane copy <src> <dst>` — manifest-preserving, registry-to-registry. */
  copy(srcRef: string, dstRef: string): Promise<void>;
  /** `crane digest <ref>` — the manifest digest as the registry reports it. */
  digest(ref: string): Promise<string>;
}

export interface ImportReleaseImageOptions {
  craneRunner: RegistryCopyRunner;
  /** The SIGNED digest from the verified release metadata (sha256:...). */
  expectedDigest: string;
  /** Public source ref; must pin the expected digest (repo@sha256:...). */
  publicRef: string;
  /** Private destination repo URI (account.dkr.ecr.region.amazonaws.com/name). */
  privateRepo: string;
  /** Optional progress logger. */
  log?: (line: string) => void;
}

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

/** Destination tag for an imported digest: stable, collision-free, greppable. */
export function importTagForDigest(digest: string): string {
  return `release-${digest.replace(/^sha256:/, '').slice(0, 16)}`;
}

/**
 * Import one verified release image into the private ECR repo and verify the
 * resulting digest equals the signed digest. Returns the VERIFIED digest for
 * manifest pinning (the Compute task definition references repo@digest).
 *
 * Refuses before copying when the public ref does not pin the expected
 * digest — copying a tag would race against tag moves; the source must be
 * addressed by the exact signed digest.
 */
export async function importReleaseImage(opts: ImportReleaseImageOptions): Promise<string> {
  const { craneRunner, expectedDigest, publicRef, privateRepo } = opts;
  const log = opts.log ?? ((): void => {});

  if (!DIGEST_RE.test(expectedDigest)) {
    throw new Error(
      `importReleaseImage: expectedDigest "${expectedDigest}" is not a sha256 digest; ` +
        'pass the signed digest from the verified release metadata',
    );
  }

  // The source MUST be digest-addressed with the signed digest. A tag ref
  // could be moved between verification and copy; a different digest means
  // the caller is importing something the signature never covered.
  const atIndex = publicRef.indexOf('@');
  if (atIndex === -1) {
    throw new Error(
      `importReleaseImage: public ref "${publicRef}" is not digest-addressed; ` +
        `use <repo>@${expectedDigest} so the copy source is exactly the signed artifact`,
    );
  }
  const refDigest = publicRef.slice(atIndex + 1);
  if (refDigest !== expectedDigest) {
    throw new Error(
      `importReleaseImage: public ref pins ${refDigest} but the signed digest is ` +
        `${expectedDigest}; refusing to import an artifact the signature does not cover`,
    );
  }

  const dstRef = `${privateRepo}:${importTagForDigest(expectedDigest)}`;
  log(`registry-native copy ${publicRef} -> ${dstRef}`);
  await craneRunner.copy(publicRef, dstRef);

  // Verify-after-copy: the private registry must report the SAME digest. A
  // manifest-preserving copy guarantees it; anything else (docker round-trip,
  // partial copy, tampering in transit) surfaces right here, hard.
  const privateDigest = await craneRunner.digest(dstRef);
  if (privateDigest !== expectedDigest) {
    throw new Error(
      `image import FAILED verification: private ECR reports digest ${privateDigest} ` +
        `for ${dstRef}, but the signed digest is ${expectedDigest}. The copy was not ` +
        'manifest-preserving (or the artifact was tampered with in transit). Do not ' +
        'deploy this image; delete the imported tag and re-run the import with crane/skopeo.',
    );
  }

  log(`verified private digest ${privateDigest} (matches signed digest)`);
  return privateDigest;
}
