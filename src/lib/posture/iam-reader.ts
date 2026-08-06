/**
 * IAM posture reader (Tier B, read-only).
 *
 * Reads the orchestrator's OWN task role posture only. It never enumerates
 * other roles in the account. The flow is:
 *
 *   1. Discover the task role NAME. On Fargate the role is whatever STS
 *      GetCallerIdentity resolves to for the assumed-role session; we strip
 *      the assumed-role ARN down to its base role name. An explicit
 *      CCE_TASK_ROLE_NAME / CCE_TASK_ROLE_ARN env var (if the foundation ever
 *      wires one) takes precedence so we avoid an STS round-trip.
 *   2. GetRole for trust + metadata.
 *   3. Inline policies: ListRolePolicies + GetRolePolicy.
 *   4. Managed policies: ListAttachedRolePolicies + GetPolicy +
 *      GetPolicyVersion (default version).
 *
 * Every AWS call is wrapped so a denied permission degrades to an 'unknown'
 * signal rather than throwing. The pure evaluator (iam-evaluator.ts) turns the
 * gathered documents into findings + a grade; this module only does IO.
 *
 * No secret VALUES are ever returned. Policy documents are public IAM metadata.
 */

import {
  IAMClient,
  GetRoleCommand,
  ListRolePoliciesCommand,
  GetRolePolicyCommand,
  ListAttachedRolePoliciesCommand,
  GetPolicyCommand,
  GetPolicyVersionCommand,
} from '@aws-sdk/client-iam';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { logger } from '../../observability/logger.js';

const REGION = process.env.AWS_REGION ?? 'us-east-1';

let _iam: IAMClient | null = null;
let _sts: STSClient | null = null;

function iam(): IAMClient {
  // IAM is a global service; the SDK still wants a region for signing.
  if (!_iam) _iam = new IAMClient({ region: REGION });
  return _iam;
}
function sts(): STSClient {
  if (!_sts) _sts = new STSClient({ region: REGION });
  return _sts;
}

/** Test seam. Lets unit / integration tests inject fakes. */
export function __setIamClients(
  next: { iam?: IAMClient | null; sts?: STSClient | null } = {},
): void {
  if ('iam' in next) _iam = next.iam ?? null;
  if ('sts' in next) _sts = next.sts ?? null;
}

/** A single policy document (inline or managed) plus where it came from. */
export interface PolicyDoc {
  /** Inline statement name, or the managed policy name. */
  name: string;
  source: 'inline' | 'managed';
  /** Managed policy ARN, when source === 'managed'. */
  arn?: string;
  /**
   * Parsed policy document. IAM returns it URL-encoded JSON; we decode +
   * parse here so the evaluator stays pure over plain objects. Null when the
   * document could not be fetched or parsed (degraded, not fatal).
   */
  document: PolicyDocument | null;
}

/** Minimal shape of an IAM policy document we evaluate over. */
export interface PolicyDocument {
  Version?: string;
  Statement?: PolicyStatement | PolicyStatement[];
}

export interface PolicyStatement {
  Sid?: string;
  Effect?: string;
  Action?: string | string[];
  NotAction?: string | string[];
  Resource?: string | string[];
  NotResource?: string | string[];
  Condition?: Record<string, unknown>;
}

/** Everything the evaluator needs, plus IO status flags for fail-soft cards. */
export interface IamPosture {
  /** Resolved task role name, or null if it could not be discovered. */
  roleName: string | null;
  /** True once we successfully fetched GetRole metadata. */
  roleFound: boolean;
  /** All inline + managed policy documents we managed to read. */
  policies: PolicyDoc[];
  /**
   * Buckets of things that errored, so the router can surface an honest
   * 'unknown' card instead of pretending a denied describe means "clean".
   */
  errors: string[];
}

/** URL-decode + JSON-parse an IAM policy document string, fail-soft. */
export function parsePolicyDocument(raw: string | undefined): PolicyDocument | null {
  if (!raw) return null;
  try {
    // IAM Get*Policy* returns the document URL-encoded.
    const decoded = decodeURIComponent(raw);
    return JSON.parse(decoded) as PolicyDocument;
  } catch {
    try {
      // Some paths already hand back plain JSON; try that before giving up.
      return JSON.parse(raw) as PolicyDocument;
    } catch {
      return null;
    }
  }
}

/**
 * Discover the orchestrator's own task role name.
 *
 * Precedence:
 *   1. CCE_TASK_ROLE_NAME (explicit name).
 *   2. CCE_TASK_ROLE_ARN  (extract the base role name).
 *   3. STS GetCallerIdentity -> assumed-role ARN -> base role name.
 *
 * Returns null when nothing resolves (e.g. local dev with no creds). The
 * caller turns that into an 'unknown' card rather than failing.
 */
export async function discoverTaskRoleName(): Promise<string | null> {
  const envName = process.env.CCE_TASK_ROLE_NAME;
  if (envName) return envName;

  const envArn = process.env.CCE_TASK_ROLE_ARN;
  if (envArn) {
    const fromArn = roleNameFromArn(envArn);
    if (fromArn) return fromArn;
  }

  try {
    const id = await sts().send(new GetCallerIdentityCommand({}));
    // Assumed-role ARN looks like:
    //   arn:aws:sts::123:assumed-role/<RoleName>/<sessionName>
    // Base role ARN looks like:
    //   arn:aws:iam::123:role/<RoleName>
    return roleNameFromArn(id.Arn);
  } catch (err) {
    logger.warn({ err }, 'iam-posture: GetCallerIdentity failed, role unknown');
    return null;
  }
}

/** Extract the base IAM role name from an assumed-role or role ARN. */
export function roleNameFromArn(arn: string | undefined): string | null {
  if (!arn) return null;
  // assumed-role/<RoleName>/<session>
  const assumed = arn.match(/:assumed-role\/([^/]+)\//);
  if (assumed) return assumed[1];
  // role/<path...>/<RoleName>  -> take the last path segment.
  const role = arn.match(/:role\/(.+)$/);
  if (role) {
    const segments = role[1].split('/');
    return segments[segments.length - 1] || null;
  }
  return null;
}

/**
 * Read the full posture of the orchestrator's own task role. Never throws:
 * each AWS call is individually guarded and surfaces into `errors`.
 */
export async function fetchIamPosture(): Promise<IamPosture> {
  const errors: string[] = [];
  const policies: PolicyDoc[] = [];

  const roleName = await discoverTaskRoleName();
  if (!roleName) {
    return { roleName: null, roleFound: false, policies, errors: ['role-undiscovered'] };
  }

  let roleFound = false;
  try {
    await iam().send(new GetRoleCommand({ RoleName: roleName }));
    roleFound = true;
  } catch (err) {
    logger.warn({ err, roleName }, 'iam-posture: GetRole failed');
    errors.push('get-role-denied');
  }

  // ── Inline policies ───────────────────────────────────────────────
  try {
    const list = await iam().send(new ListRolePoliciesCommand({ RoleName: roleName }));
    for (const name of list.PolicyNames ?? []) {
      try {
        const got = await iam().send(
          new GetRolePolicyCommand({ RoleName: roleName, PolicyName: name }),
        );
        policies.push({
          name,
          source: 'inline',
          document: parsePolicyDocument(got.PolicyDocument),
        });
      } catch (err) {
        logger.warn({ err, roleName, name }, 'iam-posture: GetRolePolicy failed');
        errors.push(`inline:${name}`);
      }
    }
  } catch (err) {
    logger.warn({ err, roleName }, 'iam-posture: ListRolePolicies failed');
    errors.push('list-inline-denied');
  }

  // ── Managed policies ──────────────────────────────────────────────
  try {
    const attached = await iam().send(
      new ListAttachedRolePoliciesCommand({ RoleName: roleName }),
    );
    for (const p of attached.AttachedPolicies ?? []) {
      if (!p.PolicyArn) continue;
      try {
        const meta = await iam().send(new GetPolicyCommand({ PolicyArn: p.PolicyArn }));
        const versionId = meta.Policy?.DefaultVersionId;
        let document: PolicyDocument | null = null;
        if (versionId) {
          const ver = await iam().send(
            new GetPolicyVersionCommand({ PolicyArn: p.PolicyArn, VersionId: versionId }),
          );
          document = parsePolicyDocument(ver.PolicyVersion?.Document);
        }
        policies.push({
          name: p.PolicyName ?? p.PolicyArn,
          source: 'managed',
          arn: p.PolicyArn,
          document,
        });
      } catch (err) {
        logger.warn({ err, roleName, arn: p.PolicyArn }, 'iam-posture: managed policy read failed');
        errors.push(`managed:${p.PolicyName ?? p.PolicyArn}`);
      }
    }
  } catch (err) {
    logger.warn({ err, roleName }, 'iam-posture: ListAttachedRolePolicies failed');
    errors.push('list-managed-denied');
  }

  return { roleName, roleFound, policies, errors };
}
