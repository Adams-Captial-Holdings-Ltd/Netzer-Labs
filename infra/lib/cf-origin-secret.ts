/**
 * B1 · ALB hard-gating on X-CloudFront-Origin.
 *
 * Both the CloudFront origin (security-stack) and the ALB listener
 * (compute-stack) need to agree on the secret value of the
 * `X-CloudFront-Origin` header. The CloudFront origin sends it on every
 * origin request; the ALB rule forwards only requests carrying it.
 * Direct ALB DNS hits without the header get 403 — closes the "guess
 * origin.<apex> to bypass CloudFront WAF" gap.
 *
 * Two sources, checked in order:
 *   1. CCE_CF_ORIGIN_SECRET env var (override for rotation)
 *   2. SHA256 of `account-region-cf-origin-v1`, truncated to 32 chars
 *      (deterministic per (account, region); same across redeploys; both
 *      stacks compute the same value without any cross-stack wiring)
 *
 * Rotating the secret: either set CCE_CF_ORIGIN_SECRET or bump the `v1`
 * version tag below to invalidate the deterministic value. A rotation
 * requires the two-phase deploy described in docs/runbooks/rotate-cf-origin-secret.md
 * (update security stack first, wait for CloudFront propagation, then
 * update compute stack), because the two stacks change non-atomically
 * across the global CloudFront edge.
 */

import { createHash } from 'node:crypto';

const VERSION_TAG = 'v1';

export function cloudFrontOriginSecret(account: string, region: string): string {
  const override = process.env.CCE_CF_ORIGIN_SECRET;
  if (override && override.length > 0) {
    return override;
  }
  return createHash('sha256')
    .update(`${account}-${region}-cf-origin-${VERSION_TAG}`)
    .digest('hex')
    .slice(0, 32);
}

export const ORIGIN_HEADER_NAME = 'X-CloudFront-Origin';
