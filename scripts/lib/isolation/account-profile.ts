/**
 * Account-profile detection (onboarding plan, invariant I7 support).
 *
 * Onboarding self-host targets a STANDALONE AWS account that this install owns
 * outright. A managed account (a member of an AWS Organization, the Org
 * management account, or a Control-Tower-governed account) is REFUSED, because
 * the deny-by-default isolation scanner (scanner.ts) and the scoped-role
 * permission boundary cannot make safety guarantees when an Org SCP, a
 * Control-Tower guardrail, or another team's resources are layered on top. The
 * caller surfaces an 'unsupported-account-profile' fail action for any profile
 * that is not 'standalone'.
 *
 * FAIL CLOSED: every path that cannot positively prove a standalone account
 * returns supported:false. An unevaluable probe (throttling, a permission we
 * do not have, a malformed response) yields profile 'unknown' + supported:false
 * with a reason, never an optimistic 'standalone'. The ONE positive signal that
 * flips supported:true is Organizations reporting that the account is NOT in an
 * organization (AWSOrganizationsNotInUseException), AND no Control-Tower
 * footprint being observed.
 *
 * Import-safe: no top-level side effects. Clients are injected so the whole
 * thing is mockable; nothing runs on import and no SDK client is constructed at
 * module load.
 */

// ─────────────────────────────────────────────────────────────────────
// Injected client shape
// ─────────────────────────────────────────────────────────────────────

/**
 * Minimal AWS-shaped client. Mirrors scripts/lib/preflight/checks.ts AwsClient:
 * tests inject a fake `{ send }`. Real callers pass the read-only `aws` CLI
 * adapter (cliClient) for organizations / controltower, neither of whose SDK
 * package is a dependency. The command carried is the CLI-shaped
 * `{ action, args }`, so the same fake serves both files.
 */
export interface AwsClient {
  send(command: unknown): Promise<unknown>;
}

/** CLI-shaped command (matches checks.ts CliCommand). */
export interface CliCommand {
  action: string;
  args: string[];
}

export interface AccountProfileClients {
  /** AWS Organizations (CLI-backed; @aws-sdk/client-organizations is not a dep). */
  organizations: AwsClient;
  /** AWS Control Tower (CLI-backed; @aws-sdk/client-controltower is not a dep). */
  controlTower: AwsClient;
}

export type AccountProfile =
  | 'standalone'
  | 'org-member'
  | 'org-management'
  | 'control-tower'
  | 'unknown';

export interface AccountProfileResult {
  profile: AccountProfile;
  reasons: string[];
  /** True ONLY for a positively-proven standalone account. */
  supported: boolean;
}

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

function errName(err: unknown): string {
  return err instanceof Error ? err.name : 'UnknownError';
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * AWS error codes Organizations returns when an account is NOT part of an org.
 * Either of these is the POSITIVE standalone signal.
 */
const NOT_IN_ORG_ERROR_NAMES = new Set([
  'AWSOrganizationsNotInUseException',
  'OrganizationsNotInUseException',
]);

/** AWS error codes meaning "you are not allowed to ask" — fail closed, not standalone. */
const ACCESS_DENIED_ERROR_NAMES = new Set([
  'AccessDenied',
  'AccessDeniedException',
  'UnauthorizedOperation',
  'AuthorizationError',
]);

// ─────────────────────────────────────────────────────────────────────
// Detection
// ─────────────────────────────────────────────────────────────────────

interface OrgFinding {
  /** 'standalone' | 'member' | 'management' | 'unknown' */
  kind: 'standalone' | 'member' | 'management' | 'unknown';
  reason: string;
}

async function probeOrganizations(client: AwsClient): Promise<OrgFinding> {
  try {
    const out = (await client.send({
      action: 'describe-organization',
      args: [],
    } satisfies CliCommand)) as {
      Organization?: { Id?: string; MasterAccountId?: string };
    };
    const org = out.Organization;
    if (!org || !org.Id) {
      // A 2xx with no organization body is unexpected; do not assume standalone.
      return {
        kind: 'unknown',
        reason:
          'Organizations DescribeOrganization returned no organization body; cannot prove standalone',
      };
    }
    // We are in an organization. Master vs member is informational here; both
    // are unsupported. We cannot cheaply learn THIS account id from
    // DescribeOrganization alone, so report 'member' unless we can tell it is
    // the management account by some later signal. Treat as org membership.
    return {
      kind: 'member',
      reason: `account is part of AWS Organization ${org.Id} (management account ${org.MasterAccountId ?? 'unknown'})`,
    };
  } catch (err) {
    if (NOT_IN_ORG_ERROR_NAMES.has(errName(err))) {
      return { kind: 'standalone', reason: 'Organizations reports this account is not in an organization' };
    }
    if (ACCESS_DENIED_ERROR_NAMES.has(errName(err))) {
      // AccessDenied is AMBIGUOUS: a member account often denies
      // DescribeOrganization to non-management callers. Per the plan we treat a
      // denied DescribeOrganization as LIKELY-standalone-but-unprovable: it is
      // NOT a positive standalone proof, so it does not flip supported:true on
      // its own. We surface it as 'unknown' and let fail-closed apply.
      return {
        kind: 'unknown',
        reason: `Organizations DescribeOrganization was denied (${errName(err)}); cannot prove standalone, failing closed`,
      };
    }
    return {
      kind: 'unknown',
      reason: `Organizations DescribeOrganization unevaluable (${errName(err)}: ${errMessage(err)})`,
    };
  }
}

interface CtFinding {
  present: boolean;
  /** True when we could actually evaluate; false => unevaluable. */
  evaluated: boolean;
  reason: string;
}

async function probeControlTower(client: AwsClient): Promise<CtFinding> {
  // Control Tower exposes landing-zone listing. A non-empty list means the
  // account sits under CT governance => unsupported. An empty list is a real
  // signal of "no CT". An error is unevaluable (fail closed).
  try {
    const out = (await client.send({
      action: 'list-landing-zones',
      args: [],
    } satisfies CliCommand)) as { landingZones?: unknown[] };
    const zones = out.landingZones ?? [];
    if (zones.length > 0) {
      return { present: true, evaluated: true, reason: `Control Tower landing zone present (${zones.length})` };
    }
    return { present: false, evaluated: true, reason: 'no Control Tower landing zone observed' };
  } catch (err) {
    if (ACCESS_DENIED_ERROR_NAMES.has(errName(err))) {
      // A managed (member) account typically cannot call CT APIs; denial here
      // is consistent with being governed. Unevaluable, fail closed.
      return {
        present: false,
        evaluated: false,
        reason: `Control Tower ListLandingZones denied (${errName(err)}); cannot rule CT out`,
      };
    }
    return {
      present: false,
      evaluated: false,
      reason: `Control Tower ListLandingZones unevaluable (${errName(err)}: ${errMessage(err)})`,
    };
  }
}

/**
 * Detect the account model. Returns:
 *  - profile 'standalone' + supported:true ONLY when Organizations positively
 *    reports "not in an organization" AND Control Tower was evaluated with no
 *    landing zone present.
 *  - profile 'org-member' / 'org-management' / 'control-tower' + supported:false
 *    when a managed footprint is observed.
 *  - profile 'unknown' + supported:false for anything unevaluable (fail closed).
 *
 * The caller maps supported:false to an 'unsupported-account-profile' fail
 * action and refuses to bootstrap.
 */
export async function detectAccountProfile(
  clients: AccountProfileClients,
): Promise<AccountProfileResult> {
  const reasons: string[] = [];

  const org = await probeOrganizations(clients.organizations);
  reasons.push(org.reason);

  // If Organizations says we ARE in an org, that alone is disqualifying; we do
  // not even need Control Tower to be conclusive. Still probe CT for a richer
  // reason, but the profile is org-scoped.
  if (org.kind === 'member' || org.kind === 'management') {
    const ct = await probeControlTower(clients.controlTower);
    reasons.push(ct.reason);
    if (ct.present) {
      return { profile: 'control-tower', reasons, supported: false };
    }
    return {
      profile: org.kind === 'management' ? 'org-management' : 'org-member',
      reasons,
      supported: false,
    };
  }

  // Organizations could not positively prove standalone (denied / unevaluable /
  // empty body). FAIL CLOSED: do not even consult CT as a way to flip to
  // supported, because the ONLY positive standalone signal is the explicit
  // not-in-use exception.
  if (org.kind === 'unknown') {
    // Probe CT anyway: if CT IS present we can at least name the profile
    // 'control-tower' instead of the vaguer 'unknown'.
    const ct = await probeControlTower(clients.controlTower);
    reasons.push(ct.reason);
    if (ct.present) {
      return { profile: 'control-tower', reasons, supported: false };
    }
    return { profile: 'unknown', reasons, supported: false };
  }

  // org.kind === 'standalone': Organizations positively reports not-in-org.
  // Require Control Tower to ALSO be cleanly evaluated as absent before we
  // grant supported:true. A standalone account can still, in theory, carry a
  // self-managed CT landing zone; and an UNEVALUABLE CT probe must fail closed.
  const ct = await probeControlTower(clients.controlTower);
  reasons.push(ct.reason);
  if (ct.present) {
    return { profile: 'control-tower', reasons, supported: false };
  }
  if (!ct.evaluated) {
    return {
      profile: 'unknown',
      reasons: [...reasons, 'standalone via Organizations but Control Tower was unevaluable; failing closed'],
      supported: false,
    };
  }
  return { profile: 'standalone', reasons, supported: true };
}
