/**
 * Deployment-mode resolution (IaC readiness plan, preamble).
 *
 * Two first-class modes:
 *   - `chat`       — ≥1 webhook surface, requires HTTPS/domain. The default,
 *                    and exactly what every existing deploy (including prod)
 *                    runs today.
 *   - `infra-only` — dashboard only, no chat surfaces.
 *
 * `privateAccessOnly` is the no-domain `infra-only` corner: public dashboard
 * access always requires a real domain + ACM cert on the ALB, and plain-HTTP
 * bearer auth must be impossible BY CONSTRUCTION — so in this mode the ALB is
 * synthesized INTERNAL (not internet-facing) in private subnets, and the only
 * supported access path is the SSM port-forward tunnel
 * (`npm run dashboard:tunnel`), where localhost plain HTTP is acceptable.
 *
 * Kept as a tiny pure function so it can be unit-tested without synthesizing
 * the whole ComputeStack (see compute-mode.test.ts).
 */

export type DeployMode = 'chat' | 'infra-only';

export interface ResolvedDeployMode {
  mode: DeployMode;
  /** Operator provided a (non-blank) DOMAIN_NAME. */
  hasDomain: boolean;
  /**
   * True ONLY for `infra-only` with no domain. Every behavioural change keyed
   * off this flag is a guaranteed no-op for existing chat-mode deploys
   * (CCE_DEPLOY_MODE unset or 'chat', and/or DOMAIN_NAME set).
   */
  privateAccessOnly: boolean;
}

/** Env subset we read; matches `process.env`'s shape. */
export type DeployModeEnv = Record<string, string | undefined>;

export function resolveDeployMode(env: DeployModeEnv = process.env): ResolvedDeployMode {
  // Anything other than the exact literal 'infra-only' (including unset,
  // blank, or garbage) resolves to 'chat' so a typo can never flip a
  // public prod ALB internal.
  const mode: DeployMode = env.CCE_DEPLOY_MODE === 'infra-only' ? 'infra-only' : 'chat';
  const hasDomain = Boolean(env.DOMAIN_NAME?.trim());
  return {
    mode,
    hasDomain,
    privateAccessOnly: mode === 'infra-only' && !hasDomain,
  };
}
