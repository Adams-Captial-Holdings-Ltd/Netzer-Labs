/**
 * X-Ray initialization. Opt-in via CCE_XRAY_ENABLED=1 (set by the
 * tier-aware compute stack for T2+).
 *
 * What we get:
 *   - SDK v3 client instrumentation on Bedrock + DDB + S3 + SES + Polly
 *   - Segment per agent turn (the wrapping happens in agent-loop)
 *
 * What we deliberately skip:
 *   - HTTP middleware on Hono (would need a custom adapter)
 *   - Manual subsegments per tool invocation (cost vs value isn't there
 *     at v1; we already record latency in the audit log)
 */

// aws-xray-sdk-core is CommonJS; named imports work in TS typings but
// fail at runtime under Node ESM. Use the default import + destructure
// so both TS and Node agree.
import xray from 'aws-xray-sdk-core';
const { captureAWSv3Client, setContextMissingStrategy, setDaemonAddress } = xray;
import { logger } from '../../observability/logger.js';

let initialized = false;

export function isXrayEnabled(): boolean {
  return process.env.CCE_XRAY_ENABLED === '1';
}

export function initXray(): void {
  if (initialized) return;
  if (!isXrayEnabled()) return;
  // D1: with the X-Ray daemon sidecar in the Fargate task (T2+),
  // localhost:2000 reaches a real listener. Use LOG_ERROR so missing
  // segments surface as warnings rather than silently dropping. If we
  // ever ship a tier with X-Ray on but no daemon, this would spam logs
  // — that combination doesn't currently exist (compute-stack adds the
  // daemon whenever tier.xrayEnabled is true).
  setContextMissingStrategy('LOG_ERROR');
  const daemonAddress = process.env.AWS_XRAY_DAEMON_ADDRESS;
  if (daemonAddress) {
    setDaemonAddress(daemonAddress);
  }
  initialized = true;
  logger.info({ daemonAddress: daemonAddress ?? '(default)' }, 'x-ray initialized');
}

/**
 * Wrap an AWS SDK v3 client so X-Ray captures spans for each call.
 * No-op when X-Ray is disabled.
 */
export function captureAwsClient<T>(client: T): T {
  if (!isXrayEnabled()) return client;
  initXray();
  try {
    // The XRay SDK types are a bit loose around v3 generics.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return captureAWSv3Client(client as any) as T;
  } catch (err) {
    logger.warn(
      { errMessage: err instanceof Error ? err.message : String(err) },
      'x-ray capture failed; using uninstrumented client',
    );
    return client;
  }
}
