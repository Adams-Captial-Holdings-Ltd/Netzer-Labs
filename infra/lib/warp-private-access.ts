/**
 * Private WARP access resolution (permanent private dashboard plan, Task 1).
 *
 * An OPT-IN overlay on the no-domain `infra-only` posture resolved by
 * `deploy-mode.ts`. When enabled, a `cloudflared` sidecar joins the existing
 * production task and a Route 53 PRIVATE hosted zone points
 * `dashboard.pgn.internal` at the INTERNAL ALB, so an enrolled Cloudflare One
 * device reaches the dashboard without an SSM port-forward.
 *
 * Kept pure (no CDK, no AWS SDK, no Cloudflare) for the same reason
 * `resolveDeployMode` is: every safety invariant has to be provable in a unit
 * test, not only through a full synth.
 *
 * Three invariants this function exists to enforce:
 *
 *   1. DEFAULT OFF. Anything other than the exact literal `'1'` resolves to
 *      `{ enabled: false }`, so no existing client deploy changes shape and a
 *      typo can never arm the connector.
 *
 *   2. PRIVATE POSTURE ONLY. The connector is only valid in the internal-ALB
 *      corner (`CCE_DEPLOY_MODE=infra-only` with no `DOMAIN_NAME`). Fronting a
 *      public HTTPS listener with a tunnel would put plain-HTTP bearer auth on
 *      a world-reachable path, so that combination fails closed at synth.
 *
 *   3. `salessly.io` IS PROHIBITED. That zone and the `claudeclaw` tunnel
 *      belong to a different, already-live system. The check runs BEFORE
 *      hostname-shape validation so the prohibition reports itself as a
 *      prohibition (not as a generic "invalid hostname") for every form,
 *      including the bare apex.
 *
 * NOTE: this module never reads, accepts, or returns a Cloudflare token. The
 * connector token travels only from `cloudflared` into Secrets Manager (see
 * `scripts/lib/warp/setup.ts`) and from Secrets Manager into the container.
 */

/** The exact tunnel name this system owns. Never `claudeclaw`. */
export const WARP_TUNNEL_NAME = 'netzar-production-private';

/** Default private hostname when `CCE_WARP_PRIVATE_HOSTNAME` is unset. */
export const WARP_DEFAULT_HOSTNAME = 'dashboard.pgn.internal';

export type WarpPrivateAccessConfig =
  | { enabled: false }
  | {
      enabled: true;
      /** Fully-qualified private hostname, normalized (trimmed, lowercased). */
      hostname: string;
      /** Everything after the first label — the PrivateHostedZone name. */
      zoneName: string;
      /** The first label — the ARecord name inside that zone. */
      recordName: string;
      tunnelName: typeof WARP_TUNNEL_NAME;
    };

/** Env subset we read; matches `process.env`'s shape. */
export type WarpPrivateAccessEnv = Record<string, string | undefined>;

/** One DNS label: alphanumeric, inner hyphens allowed, 1-63 chars. */
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function resolveWarpPrivateAccess(
  env: WarpPrivateAccessEnv = process.env,
): WarpPrivateAccessConfig {
  // Invariant 1: exact-literal opt-in. Unset, blank, '0', 'true' -> off.
  if (env.CCE_WARP_PRIVATE_ACCESS !== '1') return { enabled: false };

  // Invariant 2: only the internal-ALB corner. A non-blank DOMAIN_NAME means
  // the ALB is internet-facing, which this feature must never sit in front of.
  if (env.CCE_DEPLOY_MODE !== 'infra-only' || env.DOMAIN_NAME?.trim()) {
    throw new Error(
      'CCE_WARP_PRIVATE_ACCESS=1 requires CCE_DEPLOY_MODE=infra-only and no DOMAIN_NAME',
    );
  }

  const hostname = (env.CCE_WARP_PRIVATE_HOSTNAME ?? WARP_DEFAULT_HOSTNAME).trim().toLowerCase();

  // Invariant 3: checked FIRST so every salessly.io form (including the
  // 2-label apex, which would otherwise trip the shape check below) reports
  // the prohibition rather than a generic parse error.
  if (hostname === 'salessly.io' || hostname.endsWith('.salessly.io')) {
    throw new Error('salessly.io is prohibited for Netzar private access');
  }

  // At least 3 labels: a PrivateHostedZone needs a real parent zone to hold
  // the record, and a 2-label private zone would shadow a public apex.
  const labels = hostname.split('.');
  if (labels.length < 3 || labels.some((label) => !LABEL.test(label))) {
    throw new Error(`invalid CCE_WARP_PRIVATE_HOSTNAME: ${hostname}`);
  }

  return {
    enabled: true,
    hostname,
    recordName: labels[0],
    zoneName: labels.slice(1).join('.'),
    tunnelName: WARP_TUNNEL_NAME,
  };
}
