/**
 * Public dashboard access resolution (pgnos public dashboard plan, Task 1).
 *
 * An OPT-IN overlay on the no-domain `infra-only` posture resolved by
 * `deploy-mode.ts`. When enabled, a `cloudflared` sidecar joins the existing
 * production task and Cloudflare publishes `app.pgnos.ai` as a proxied tunnel
 * hostname, so an ordinary browser reaches the Netzar OS sign-in page without
 * an SSM port-forward and without Cloudflare Access in front of it.
 *
 * The tunnel is outbound-only from the private task, so this adds NO AWS
 * ingress: no public task IP, no public ALB listener, no security-group hole.
 *
 * Kept pure (no CDK, no AWS SDK, no Cloudflare) for the same reason
 * `resolveDeployMode` and `resolveWarpPrivateAccess` are: every safety
 * invariant has to be provable in a unit test, not only through a full synth.
 *
 * Five invariants this function exists to enforce:
 *
 *   1. DEFAULT OFF. Anything other than the exact literal `'1'` resolves to
 *      `{ enabled: false }`, so no existing deploy changes shape and a typo
 *      can never arm the connector.
 *
 *   2. PRIVATE POSTURE ONLY. Valid only in the internal-ALB corner
 *      (`CCE_DEPLOY_MODE=infra-only` with no `DOMAIN_NAME`). A non-blank
 *      `DOMAIN_NAME` means the ALB is internet-facing, which is the
 *      "conflicting public domain settings" case the design rules out: the
 *      whole point is that Cloudflare is the only public edge.
 *
 *   3. MUTUALLY EXCLUSIVE WITH WARP. Both features add a `cloudflared`
 *      sidecar to the same task. The public design supersedes the private
 *      WARP one, and arming both would put two connectors in one task with
 *      two different tunnels, so that combination fails closed at synth.
 *
 *   4. `salessly.io` IS PROHIBITED. That zone and the `claudeclaw` tunnel
 *      belong to a different, already-live system. The check runs BEFORE
 *      hostname-shape validation so the prohibition reports itself as a
 *      prohibition (not as a generic "invalid hostname") for every form,
 *      including the bare apex.
 *
 *   5. `pgnos.ai` ONLY. The published hostname must sit inside the one zone
 *      this system owns, which makes publishing into any other zone
 *      impossible by construction rather than by review.
 *
 * NOTE: this module never reads, accepts, or returns a Cloudflare token. The
 * connector token travels only from Cloudflare into Secrets Manager (see the
 * secret-safe setup lifecycle) and from Secrets Manager into the container.
 */

import { APP } from './constants.js';

/** The exact tunnel name this system owns. Never `claudeclaw`. */
export const PUBLIC_TUNNEL_NAME = 'netzar-production-public';

/**
 * Secrets Manager entry holding the connector token. Exported so the CDK
 * stack and the setup CLI name the same secret and cannot drift apart.
 */
export const PUBLIC_TUNNEL_SECRET_NAME = `${APP}-public-tunnel`;

/** The one zone this feature may publish into. */
export const PUBLIC_ZONE = 'pgnos.ai';

/** Default published hostname when `CCE_PUBLIC_HOSTNAME` is unset. */
export const PUBLIC_DEFAULT_HOSTNAME = 'app.pgnos.ai';

/**
 * Where the connector forwards. Task-local only: the sidecar shares the task
 * network namespace with the orchestrator, so this never leaves the task.
 */
export const PUBLIC_TUNNEL_SERVICE = 'http://localhost:3000';

export type PublicDashboardAccessConfig =
  | { enabled: false }
  | {
      enabled: true;
      /** Fully-qualified published hostname, normalized (trimmed, lowercased). */
      hostname: string;
      /** Everything after the first label — the Cloudflare zone that holds it. */
      zoneName: string;
      /** The first label — the record name inside that zone. */
      recordName: string;
      tunnelName: typeof PUBLIC_TUNNEL_NAME;
      service: typeof PUBLIC_TUNNEL_SERVICE;
    };

/** Env subset we read; matches `process.env`'s shape. */
export type PublicDashboardAccessEnv = Record<string, string | undefined>;

/** One DNS label: alphanumeric, inner hyphens allowed, 1-63 chars. */
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function resolvePublicDashboardAccess(
  env: PublicDashboardAccessEnv = process.env,
): PublicDashboardAccessConfig {
  // Invariant 1: exact-literal opt-in. Unset, blank, '0', 'true' -> off.
  if (env.CCE_PUBLIC_ACCESS !== '1') return { enabled: false };

  // Invariant 2: only the internal-ALB corner. A non-blank DOMAIN_NAME means
  // the ALB is internet-facing, which this feature must never sit beside.
  if (env.CCE_DEPLOY_MODE !== 'infra-only' || env.DOMAIN_NAME?.trim()) {
    throw new Error(
      'CCE_PUBLIC_ACCESS=1 requires CCE_DEPLOY_MODE=infra-only and no DOMAIN_NAME',
    );
  }

  // Invariant 3: never two connectors in one task.
  if (env.CCE_WARP_PRIVATE_ACCESS === '1') {
    throw new Error(
      'CCE_PUBLIC_ACCESS=1 conflicts with CCE_WARP_PRIVATE_ACCESS=1: enable exactly one connector',
    );
  }

  const hostname = (env.CCE_PUBLIC_HOSTNAME ?? PUBLIC_DEFAULT_HOSTNAME).trim().toLowerCase();

  // Invariant 4: checked FIRST so every salessly.io form (including the
  // 2-label apex, which would otherwise trip the shape check below) reports
  // the prohibition rather than a generic parse error.
  if (hostname === 'salessly.io' || hostname.endsWith('.salessly.io')) {
    throw new Error('salessly.io is prohibited for Netzar public access');
  }

  // At least 3 labels: the published record needs a real parent zone, and a
  // 2-label hostname would be the apex itself, which carries unrelated
  // records (the Microsoft 365 verification TXT) and is not ours to publish.
  const labels = hostname.split('.');
  if (labels.length < 3 || labels.some((label) => !LABEL.test(label))) {
    throw new Error(`invalid CCE_PUBLIC_HOSTNAME: ${hostname}`);
  }

  // Invariant 5: inside the one zone this system owns.
  if (!hostname.endsWith(`.${PUBLIC_ZONE}`)) {
    throw new Error(`CCE_PUBLIC_HOSTNAME must be inside ${PUBLIC_ZONE}: ${hostname}`);
  }

  return {
    enabled: true,
    hostname,
    recordName: labels[0],
    zoneName: labels.slice(1).join('.'),
    tunnelName: PUBLIC_TUNNEL_NAME,
    service: PUBLIC_TUNNEL_SERVICE,
  };
}
