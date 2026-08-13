/**
 * Secret-safe Cloudflare Tunnel -> Secrets Manager transfer (permanent
 * private dashboard plan, Task 2).
 *
 * The connector token is the one value in this feature that must never be
 * seen. It travels exactly one path:
 *
 *     cloudflared (piped stdout) -> memory -> PutSecretValue -> KMS
 *
 * and nothing else. Specifically it is never an argv element, never printed,
 * never written to `.env`, never attached to an exception, never part of the
 * returned value, and never present in a deploy manifest or cdk.out. The
 * operator's only interactive step is a browser authorization
 * (`cloudflared tunnel login`) — they are never asked to copy or paste a
 * token anywhere.
 *
 * Both external systems are injected so the unit tests exercise the real
 * control flow without touching Cloudflare or AWS.
 */

import { spawn } from 'node:child_process';
import { PutSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { WARP_TUNNEL_NAME } from '../../../infra/lib/warp-private-access.js';

/**
 * Secrets Manager version stage that marks "a real connector token has been
 * written". `scripts/deploy.ts` gates the Compute phase on this stage
 * EXISTING; it never reads the value behind it.
 */
export const WARP_SECRET_READY_STAGE = 'CCE-WARP-READY';

/** Emitted when the operator has not authorized Cloudflare in a browser. */
export const WARP_LOGIN_REMEDIATION =
  'ACTION NEEDED: authorize Cloudflare in the browser with `cloudflared tunnel login`, ' +
  'then re-run `npm run warp:setup`. Do not paste any token into this terminal or chat.';

/** Emitted when the foundation phase has not created the secret yet. */
export const WARP_SECRET_MISSING_REMEDIATION =
  'ACTION NEEDED: run `npm run deploy` once. It will create the retained encrypted tunnel ' +
  'secret during the foundation phase and stop with the exact `npm run warp:setup` ' +
  'remediation. Then re-run this command.';

/**
 * Emitted when the named tunnel does not exist remotely. Deliberately does
 * NOT suggest `cloudflared tunnel create`: a locally managed tunnel keeps its
 * credentials in a file on one laptop, which cannot survive a Fargate task
 * restart. The tunnel must be remotely managed, created through the connected
 * Cloudflare API.
 */
export const WARP_TUNNEL_MISSING_REMEDIATION =
  `Create the remotely managed \`${WARP_TUNNEL_NAME}\` tunnel through the connected ` +
  'Cloudflare API, then re-run `npm run warp:setup`.';

/** A typed operator blocker: expected, actionable, not a crash. */
export class WarpSetupBlocker extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WarpSetupBlocker';
  }
}

/** Minimal `cloudflared` surface: run args, get stdout. Never logs. */
export interface CloudflaredAdapter {
  capture(args: string[]): Promise<string>;
}

/** Minimal Secrets Manager surface (the `{ send }` of the real client). */
export interface SecretsManagerLike {
  send(command: unknown): Promise<{ VersionId?: string }>;
}

export interface SyncWarpTunnelSecretOptions {
  /** The only account allowed to receive this write. */
  expectedAccountId: string;
  /** What STS actually reports for the current credentials. */
  actualAccountId: string;
  /** Full Secrets Manager path, e.g. `/claudeclaw/cloudflare-tunnel`. */
  secretId: string;
  cloudflared: CloudflaredAdapter;
  secrets: SecretsManagerLike;
  /** Progress sink. Receives status lines only — never the token. */
  log?: (line: string) => void;
}

export interface WarpTunnelResult {
  tunnelId: string;
  tunnelName: typeof WARP_TUNNEL_NAME;
  secretVersionId: string;
}

/** Replace every occurrence of a live secret with a marker. */
function redact(text: string, secret: string): string {
  if (!secret) return text;
  return text.split(secret).join('[redacted]');
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Find the named remote tunnel, read its connector token, and store that
 * token in Secrets Manager under a version stage the deploy gate can check.
 *
 * Order matters: the account guard runs BEFORE any Cloudflare read or AWS
 * write, so a wrong-profile run mutates nothing anywhere.
 */
export async function syncWarpTunnelSecret(
  opts: SyncWarpTunnelSecretOptions,
): Promise<WarpTunnelResult> {
  const { expectedAccountId, actualAccountId, secretId, cloudflared, secrets } = opts;
  const log = opts.log ?? ((): void => {});

  // Gate: account identity, before Cloudflare and before Secrets Manager.
  if (!expectedAccountId) {
    throw new WarpSetupBlocker(
      'refusing to run without an expected AWS account id (AWS_ACCOUNT_ID); ' +
        'this command must never write to whatever account happens to be current',
    );
  }
  if (actualAccountId !== expectedAccountId) {
    throw new WarpSetupBlocker(
      `refusing to write the Cloudflare tunnel secret: expected ${expectedAccountId}, ` +
        `current credentials resolve to ${actualAccountId || '(unknown)'}`,
    );
  }
  log(`AWS account ${expectedAccountId} confirmed.`);

  // Read-only: list remote tunnels and pick ours by exact name.
  const listed = await cloudflared.capture(['tunnel', 'list', '--output', 'json']);
  let tunnels: Array<{ id?: string; name?: string }>;
  try {
    tunnels = JSON.parse(listed) as Array<{ id?: string; name?: string }>;
  } catch {
    // Never echo the raw output: it is operator-account data.
    throw new WarpSetupBlocker(
      'could not parse `cloudflared tunnel list --output json`. ' + WARP_LOGIN_REMEDIATION,
    );
  }
  const tunnel = Array.isArray(tunnels)
    ? tunnels.find((t) => t?.name === WARP_TUNNEL_NAME)
    : undefined;
  if (!tunnel?.id) {
    throw new WarpSetupBlocker(WARP_TUNNEL_MISSING_REMEDIATION);
  }
  log(`Found remotely managed tunnel ${WARP_TUNNEL_NAME} (${tunnel.id}).`);

  // The single sensitive read. `token` is scoped tightly and cleared below.
  let token = (await cloudflared.capture(['tunnel', 'token', tunnel.id])).trim();
  if (!token || token === 'REPLACE_ME') {
    token = '';
    throw new WarpSetupBlocker(
      `cloudflared returned no tunnel token for ${WARP_TUNNEL_NAME}. ` + WARP_LOGIN_REMEDIATION,
    );
  }

  let secretVersionId: string;
  try {
    const put = await secrets.send(
      new PutSecretValueCommand({
        SecretId: secretId,
        SecretString: JSON.stringify({ token }),
        // AWSCURRENT so ECS reads it; the extra stage is the deploy gate's
        // existence probe (checked with DescribeSecret, never GetSecretValue).
        VersionStages: ['AWSCURRENT', WARP_SECRET_READY_STAGE],
      }),
    );
    secretVersionId = put.VersionId ?? '';
  } catch (err) {
    // An SDK error can echo request context; scrub it unconditionally.
    throw new Error(`failed to write ${secretId}: ${redact(messageOf(err), token)}`);
  } finally {
    token = '';
  }

  log(`Wrote ${secretId} version ${secretVersionId} (token not displayed).`);
  return { tunnelId: tunnel.id, tunnelName: WARP_TUNNEL_NAME, secretVersionId };
}

// ── Real adapters ─────────────────────────────────────────────────────

/**
 * `cloudflared` over spawn with PIPED stdout. stdio is never 'inherit' here,
 * so `tunnel token` output cannot reach the operator's terminal. stderr is
 * captured (not inherited) and only surfaced without the token.
 */
export function realCloudflared(bin = 'cloudflared'): CloudflaredAdapter {
  return {
    capture(args: string[]): Promise<string> {
      return new Promise((resolve, reject) => {
        const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        proc.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
        proc.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
        proc.on('error', () =>
          reject(new WarpSetupBlocker(`\`${bin}\` is not available on PATH. ` + WARP_LOGIN_REMEDIATION)),
        );
        proc.on('close', (code) => {
          if (code === 0) return resolve(stdout);
          // `tunnel token` failures usually mean "not authorized yet".
          reject(
            new WarpSetupBlocker(
              `\`${bin} ${args[0] ?? ''} ${args[1] ?? ''}\` exited ${code ?? 1}. ` +
                `${stderr.trim().split('\n').slice(0, 3).join(' ')} ${WARP_LOGIN_REMEDIATION}`.trim(),
            ),
          );
        });
      });
    },
  };
}

/** True when the `cloudflared` binary answers `--version`. */
export async function cloudflaredAvailable(bin = 'cloudflared'): Promise<boolean> {
  try {
    await realCloudflared(bin).capture(['--version']);
    return true;
  } catch {
    return false;
  }
}

/**
 * The ONLY interactive step. Inherits the terminal (and therefore the
 * browser handoff) because this command prints a URL for the operator to
 * approve. It never emits a token — `tunnel login` writes a cert to the
 * operator's own `~/.cloudflared`, and the connector token is fetched
 * separately over the piped adapter above.
 */
export function cloudflaredLogin(bin = 'cloudflared'): Promise<number> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, ['tunnel', 'login'], { stdio: 'inherit' });
    proc.on('error', () =>
      reject(new WarpSetupBlocker(`\`${bin}\` is not available on PATH. ` + WARP_LOGIN_REMEDIATION)),
    );
    proc.on('close', (code) => resolve(code ?? 1));
  });
}
