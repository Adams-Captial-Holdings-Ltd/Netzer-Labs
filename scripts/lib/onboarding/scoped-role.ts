/**
 * Scoped-role privilege boundary (onboarding plan, invariant I2 + the I4
 * off-account foothold catalog it must deny).
 *
 * The onboarding self-host flow runs bootstrap and every subsequent deploy
 * as a SCOPED role whose permission boundary makes the forbidden mutations
 * technically impossible, not merely "policy says no". This module is the
 * single source of truth for:
 *
 *  - I4 catalog (FORBIDDEN_FOOTHOLD_ACTIONS): every action class that would
 *    let a compromised deploy carve an off-account foothold (new IAM
 *    principals/keys, trust edits, federation, image/snapshot/RAM sharing,
 *    resource-policy puts that add cross-account/public principals, KMS
 *    grants to external principals, Lambda function URLs, log subscription
 *    filters, cross-account EventBridge targets, or any cost-cap/budget
 *    change). Every builder below explicitly DENIES these.
 *
 *  - buildBootstrapSessionPolicy(): the STS session policy the bootstrap
 *    step runs under. ALLOWS only the named bootstrap actions, and pins an
 *    explicit Deny over every forbidden class so even the privileged
 *    bootstrap window cannot mint a foothold.
 *
 *  - buildScopedDeployBoundary(): the IAM permission boundary attached to the
 *    scoped deploy role. ALLOWS the app-stack deploy surface and DENIES every
 *    forbidden class plus any cost-cap/budget mutation. A permission boundary
 *    is an upper bound: it caps the effective permissions of the role no
 *    matter what identity policies are later attached.
 *
 *  - buildScopedDeployRoleTrust(account): the trust policy so only this
 *    account's own bootstrap identity can assume the scoped deploy role.
 *
 *  - assertNoStrongerAdminCredential(env): the fail-closed credential-source
 *    guard. Once onboarding has the scoped role, doctor/bootstrap/deploy call
 *    this to refuse to run if a STRONGER (admin) credential than the scoped
 *    role is discoverable in the environment, so a forgotten admin key cannot
 *    silently grant back everything the boundary was meant to remove.
 *
 *  - denies(policy, action): a pure helper that evaluates whether `action` is
 *    denied by an explicit Deny statement in `policy`. Tests and the deploy
 *    "negative matrix" verify each forbidden action is denied.
 *
 * Import-safe: no top-level side effects, no AWS calls at import. The only
 * optional AWS call lives inside assertNoStrongerAdminCredential when an STS
 * checker is injected; by default it inspects the environment only.
 *
 * No em dashes anywhere by house rule.
 */

// ─────────────────────────────────────────────────────────────────────
// Minimal IAM policy-document types
// ─────────────────────────────────────────────────────────────────────

export type PolicyEffect = 'Allow' | 'Deny';

export interface PolicyStatementJson {
  Sid?: string;
  Effect: PolicyEffect;
  Action: string | string[];
  Resource?: string | string[];
  Principal?: Record<string, string | string[]> | string;
  Condition?: Record<string, Record<string, string | string[]>>;
}

export interface PolicyDocumentJson {
  Version: '2012-10-17';
  Statement: PolicyStatementJson[];
}

// ─────────────────────────────────────────────────────────────────────
// I4 catalog: the explicit deny list (off-account foothold actions)
// ─────────────────────────────────────────────────────────────────────

/**
 * FORBIDDEN_FOOTHOLD_ACTIONS groups the I4 off-account foothold catalog by
 * class. Every builder below denies ALL of these. The classes, not just a
 * flat list, are what reviewers reason about, so they are named.
 *
 * A note on wildcards: several entries use a trailing `*` (e.g. `iam:Create*`)
 * to capture the whole sub-family. IAM evaluates an explicit Deny on a
 * wildcard action against every matching API, so `iam:Create*` denies
 * CreateUser, CreateRole, CreateAccessKey, CreateLoginProfile, etc. with one
 * statement. The flat FORBIDDEN_FOOTHOLD_ACTIONS export expands the catalog
 * for the negative matrix and for denies() lookups.
 */
export const FORBIDDEN_FOOTHOLD_CLASSES = {
  /**
   * New IAM principals + long-lived credentials outside the stack. A new
   * user/role/access-key/login-profile is the most direct off-account
   * foothold a compromised deploy could mint.
   */
  iamPrincipalCreation: [
    'iam:CreateUser',
    'iam:CreateRole',
    'iam:CreateAccessKey',
    'iam:CreateLoginProfile',
    'iam:CreateServiceSpecificCredential',
    'iam:CreateSAMLProvider',
    'iam:CreateOpenIDConnectProvider',
  ],
  /**
   * Trust-edge edits: rewriting which principal may assume a role, or
   * attaching/putting policies that widen a role. UpdateAssumeRolePolicy is
   * the classic privilege-escalation primitive.
   */
  iamTrustEdits: [
    'iam:UpdateAssumeRolePolicy',
    'iam:PutRolePolicy',
    'iam:PutUserPolicy',
    'iam:PutGroupPolicy',
    'iam:AttachRolePolicy',
    'iam:AttachUserPolicy',
    'iam:AttachGroupPolicy',
    'iam:PutRolePermissionsBoundary',
    'iam:DeleteRolePermissionsBoundary',
    'iam:AddUserToGroup',
    'iam:UpdateSAMLProvider',
    'iam:AddClientIDToOpenIDConnectProvider',
    'iam:UpdateOpenIDConnectProviderThumbprint',
    // Managed-policy widening: writing a new default version of a customer
    // managed policy re-grants whatever PutRolePolicy/AttachRolePolicy would,
    // and a permission boundary on THIS role does not stop it from rewriting a
    // policy a DIFFERENT principal uses. The canonical IAM escalation path.
    'iam:CreatePolicyVersion',
    'iam:SetDefaultPolicyVersion',
  ],
  /**
   * STS federation: minting a federated/web-identity/SAML session is the
   * "external/OIDC/SAML federation" foothold I2 names. The deploy only ever
   * needs sts:AssumeRole (the CDK bootstrap roles), never these, so the
   * boundary denies them even though sts:* is in the broad allow surface.
   */
  stsFederation: [
    'sts:GetFederationToken',
    'sts:AssumeRoleWithWebIdentity',
    'sts:AssumeRoleWithSAML',
  ],
  /**
   * EC2 sharing: making an AMI or EBS snapshot readable by another account
   * (or public), and RAM resource shares. Each is a route to exfiltrate
   * compute images/data to an attacker account.
   */
  ec2AndRamSharing: [
    'ec2:ModifyImageAttribute',
    'ec2:ModifySnapshotAttribute',
    'ec2:ModifyFpgaImageAttribute',
    'ram:CreateResourceShare',
    'ram:AssociateResourceShare',
    'ram:UpdateResourceShare',
  ],
  /**
   * Resource-policy puts that can add a cross-account or public principal to
   * a data/messaging/compute resource. The deploy never needs to set these
   * (CDK manages resource policies through the stacks under the bootstrap
   * roles, not through this scoped surface), so they are denied wholesale.
   */
  resourcePolicyPuts: [
    's3:PutBucketPolicy',
    's3:PutBucketAcl',
    's3:PutAccessPointPolicy',
    'ecr:SetRepositoryPolicy',
    'ecr-public:SetRepositoryPolicy',
    'secretsmanager:PutResourcePolicy',
    'sns:AddPermission',
    'sns:SetTopicAttributes',
    'sqs:AddPermission',
    'sqs:SetQueueAttributes',
    'lambda:AddPermission',
    'lambda:AddLayerVersionPermission',
    'glue:PutResourcePolicy',
    'events:PutPermission',
    'backup:PutBackupVaultAccessPolicy',
  ],
  /**
   * KMS grants/policy that hand decrypt authority to an external principal,
   * and CreateGrant which can name an arbitrary grantee.
   */
  kmsExternalGrants: [
    'kms:CreateGrant',
    'kms:PutKeyPolicy',
  ],
  /**
   * Lambda function URLs: an unauthenticated public HTTPS entry point onto a
   * function, created without touching API Gateway or the ALB.
   */
  lambdaFunctionUrl: [
    'lambda:CreateFunctionUrlConfig',
    'lambda:UpdateFunctionUrlConfig',
  ],
  /**
   * CloudWatch Logs subscription filters: a live tap that streams log data
   * (which can carry secrets/PII) to a destination, including cross-account.
   */
  logsSubscription: [
    'logs:PutSubscriptionFilter',
    'logs:PutDestination',
    'logs:PutDestinationPolicy',
  ],
  /**
   * EventBridge rule/target creation: a rule with a cross-account target can
   * forward events (and the data in them) out of the account. The deploy
   * uses EventBridge Scheduler through the bootstrap roles, never this scoped
   * surface, so rule/target puts are denied here.
   */
  eventsCrossAccount: [
    'events:PutRule',
    'events:PutTargets',
    // A Connection stores credentials and an API Destination is an arbitrary
    // outbound HTTPS endpoint: together they are an off-account egress +
    // credential primitive the deploy never needs from this scoped surface.
    'events:CreateConnection',
    'events:UpdateConnection',
    'events:CreateApiDestination',
    'events:UpdateApiDestination',
  ],
  /**
   * Cost-cap / budget changes. The daily cost cap and the mirrored AWS Budget
   * are the spend ceiling; a deploy that could raise or delete them defeats
   * the primary financial guardrail, so every budget mutation is denied on
   * the scoped surface (the in-app cap path runs as the task role, not this
   * deploy role).
   */
  costCapMutation: [
    'budgets:ModifyBudget',
    'budgets:DeleteBudget',
    'budgets:CreateBudget',
    'budgets:CreateBudgetAction',
    'budgets:UpdateBudgetAction',
    'budgets:DeleteBudgetAction',
    'ce:UpdateCostAllocationTagsStatus',
    'ce:CreateAnomalyMonitor',
  ],
} as const;

/**
 * The flat I4 deny list: every forbidden action across all classes, sorted
 * and de-duplicated. This is what tests iterate to PROVE denial and what
 * denies() is checked against.
 */
export const FORBIDDEN_FOOTHOLD_ACTIONS: readonly string[] = Object.freeze(
  Array.from(
    new Set(
      (Object.values(FORBIDDEN_FOOTHOLD_CLASSES) as readonly (readonly string[])[]).flat(),
    ),
  ).sort(),
);

/**
 * The deny statement applied by every builder. One explicit Deny over the
 * whole catalog on Resource '*'. In IAM an explicit Deny always wins over any
 * Allow, so an attached identity policy (or a wildcard Allow elsewhere) can
 * never re-grant a forbidden action while this statement is in force.
 */
function forbiddenFootholdDenyStatement(sid: string): PolicyStatementJson {
  return {
    Sid: sid,
    Effect: 'Deny',
    Action: [...FORBIDDEN_FOOTHOLD_ACTIONS],
    Resource: '*',
  };
}

// ─────────────────────────────────────────────────────────────────────
// Bootstrap session policy
// ─────────────────────────────────────────────────────────────────────

/**
 * The named actions the bootstrap step legitimately needs: stand up the CDK
 * toolkit primitives, the onboarding state primitives (bucket, lock table,
 * ECR repo), and read its own identity. Deliberately NARROW. Anything not
 * listed is implicitly denied by the absence of an Allow; the forbidden
 * classes are additionally denied EXPLICITLY so they cannot be re-granted.
 */
export const BOOTSTRAP_ALLOWED_ACTIONS: readonly string[] = Object.freeze([
  // CloudFormation: deploy/inspect the toolkit + app stacks during bootstrap.
  'cloudformation:CreateStack',
  'cloudformation:UpdateStack',
  'cloudformation:DescribeStacks',
  'cloudformation:DescribeStackEvents',
  'cloudformation:DescribeStackResources',
  'cloudformation:GetTemplate',
  'cloudformation:CreateChangeSet',
  'cloudformation:DescribeChangeSet',
  'cloudformation:ExecuteChangeSet',
  'cloudformation:DeleteChangeSet',
  'cloudformation:ListStacks',
  // State bucket (onboarding primitive) + CDK assets bucket.
  's3:CreateBucket',
  's3:PutBucketVersioning',
  's3:PutEncryptionConfiguration',
  's3:PutBucketTagging',
  's3:PutBucketPublicAccessBlock',
  's3:GetBucketLocation',
  's3:ListBucket',
  's3:GetObject',
  's3:PutObject',
  // Deploy-lock table (onboarding primitive).
  'dynamodb:CreateTable',
  'dynamodb:DescribeTable',
  'dynamodb:TagResource',
  'dynamodb:PutItem',
  'dynamodb:GetItem',
  'dynamodb:UpdateItem',
  'dynamodb:DeleteItem',
  // Private ECR repo (release-image import).
  'ecr:CreateRepository',
  'ecr:DescribeRepositories',
  'ecr:PutLifecyclePolicy',
  'ecr:TagResource',
  'ecr:GetAuthorizationToken',
  // KMS for the CDK assets + state encryption (use only, never policy/grant).
  'kms:Encrypt',
  'kms:Decrypt',
  'kms:GenerateDataKey',
  'kms:DescribeKey',
  // Identity reads.
  'sts:GetCallerIdentity',
  'iam:GetRole',
  'iam:ListRoles',
]);

/**
 * The STS session policy the bootstrap step runs under. ALLOWS only the named
 * bootstrap actions (on Resource '*', because the session policy is an
 * intersection with the caller's identity which is already account-scoped),
 * and pins the explicit forbidden-class Deny so the privileged bootstrap
 * window can never mint an off-account foothold.
 */
export function buildBootstrapSessionPolicy(): PolicyDocumentJson {
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'BootstrapAllowedActions',
        Effect: 'Allow',
        Action: [...BOOTSTRAP_ALLOWED_ACTIONS],
        Resource: '*',
      },
      forbiddenFootholdDenyStatement('DenyForbiddenFootholdDuringBootstrap'),
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────
// Scoped deploy permission boundary
// ─────────────────────────────────────────────────────────────────────

/**
 * The service prefixes the scoped deploy role is allowed to operate. The
 * boundary ALLOWS these broadly (CDK touches many APIs across these services
 * to deploy the app stacks) and then DENIES the forbidden classes on top, so
 * the net is "deploy the app, but never carve a foothold or move the cap".
 *
 * A permission boundary is an upper bound on effective permissions: the role's
 * own identity policy still has to grant an action, and that grant only takes
 * effect if it also passes this boundary. So a broad Allow here is safe; it
 * widens the ceiling, it does not by itself grant anything.
 */
export const SCOPED_DEPLOY_ALLOWED_SERVICE_PREFIXES: readonly string[] =
  Object.freeze([
    'cloudformation:*',
    's3:*',
    'dynamodb:*',
    'ec2:*',
    'ecr:*',
    'ecs:*',
    'elasticloadbalancing:*',
    'logs:*',
    'kms:*',
    'secretsmanager:*',
    'sns:*',
    'sqs:*',
    'lambda:*',
    'iam:*',
    'scheduler:*',
    'events:*',
    'application-autoscaling:*',
    'wafv2:*',
    'cloudwatch:*',
    'ssm:*',
    'bedrock:*',
    'apigateway:*',
    'execute-api:*',
    'ram:*',
    'sts:*',
  ]);

/**
 * The permission-boundary policy for the scoped deploy role. ALLOWS the
 * app-stack deploy surface (the service prefixes above) and DENIES every
 * forbidden class, including any cost-cap/budget mutation. Because Deny
 * always beats Allow, the broad `iam:*` / `s3:*` / `kms:*` Allows above can
 * never reach a forbidden action: CreateUser, UpdateAssumeRolePolicy,
 * PutBucketPolicy, CreateGrant, CreateFunctionUrlConfig, PutSubscriptionFilter,
 * ModifyBudget, and the rest stay denied at the boundary.
 *
 * KNOWN GAP (must close before this boundary gates a REAL deploy): iam:PassRole
 * is intentionally NOT in the unconditional deny catalog, because CDK genuinely
 * needs PassRole for its execution roles, so a blanket deny would break deploys.
 * But unconditioned PassRole under `iam:*` is the canonical escalation primitive
 * (a compromised deploy could pass an existing admin role to a Lambda/ECS task it
 * creates). The correct fix is a CONDITIONED PassRole (an `iam:PassedToService`
 * condition limited to the services the app actually launches, and/or resource-
 * scoped to the app's own roles), which requires mapping the deploy's real
 * PassRole needs. Until then the boundary does not constrain PassRole, and the
 * boundary-sim negative matrix (which only iterates the unconditional catalog)
 * will not flag it. Tracked as a pre-go-live follow-up.
 */
export function buildScopedDeployBoundary(): PolicyDocumentJson {
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'ScopedDeploySurface',
        Effect: 'Allow',
        Action: [...SCOPED_DEPLOY_ALLOWED_SERVICE_PREFIXES],
        Resource: '*',
      },
      forbiddenFootholdDenyStatement('DenyForbiddenFootholdAtBoundary'),
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────
// Scoped deploy role trust policy
// ─────────────────────────────────────────────────────────────────────

/**
 * The trust policy for the scoped deploy role: only the named account's own
 * root (i.e. an identity in THIS account that has been granted sts:AssumeRole)
 * may assume it. No external account, no federation, no wildcard principal.
 * The Deny guards against a future federated/web-identity assume sneaking in.
 */
export function buildScopedDeployRoleTrust(account: string): PolicyDocumentJson {
  if (!account || !/^\d{12}$/.test(account)) {
    throw new Error(
      'buildScopedDeployRoleTrust requires a 12-digit AWS account id',
    );
  }
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'AllowSameAccountAssume',
        Effect: 'Allow',
        Principal: { AWS: `arn:aws:iam::${account}:root` },
        Action: 'sts:AssumeRole',
      },
      {
        Sid: 'DenyFederatedAssume',
        Effect: 'Deny',
        Principal: '*',
        Action: [
          'sts:AssumeRoleWithWebIdentity',
          'sts:AssumeRoleWithSAML',
        ],
        Resource: '*',
      },
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────
// denies(): pure policy evaluator for the negative matrix
// ─────────────────────────────────────────────────────────────────────

/**
 * Convert an IAM action-pattern (which may end in `*`) to a tester against a
 * concrete action. `iam:Create*` matches `iam:CreateUser`; `s3:PutBucketPolicy`
 * matches only itself; `*` matches everything.
 */
function actionPatternMatches(pattern: string, action: string): boolean {
  if (pattern === '*') return true;
  if (pattern === action) return true;
  if (pattern.endsWith('*')) {
    return action.startsWith(pattern.slice(0, -1));
  }
  return false;
}

function asArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

/**
 * True when `action` is explicitly DENIED by `policy`: there exists a
 * statement with Effect 'Deny' whose Action list matches `action`. This is
 * the property the negative matrix asserts. We intentionally do NOT model the
 * Allow set here: an explicit Deny is unconditional in IAM (it always wins),
 * so proving the Deny exists is sufficient to prove the action is forbidden
 * regardless of any Allow.
 */
export function denies(policy: PolicyDocumentJson, action: string): boolean {
  for (const stmt of policy.Statement) {
    if (stmt.Effect !== 'Deny') continue;
    const patterns = asArray(stmt.Action);
    if (patterns.some((p) => actionPatternMatches(p, action))) {
      return true;
    }
  }
  return false;
}

/**
 * True when `action` is granted by an Allow statement in `policy` and not
 * shadowed by an explicit Deny. Mirrors IAM evaluation order (explicit Deny
 * beats Allow). Used by tests to assert a bootstrap action is permitted.
 */
export function allows(policy: PolicyDocumentJson, action: string): boolean {
  if (denies(policy, action)) return false;
  for (const stmt of policy.Statement) {
    if (stmt.Effect !== 'Allow') continue;
    const patterns = asArray(stmt.Action);
    if (patterns.some((p) => actionPatternMatches(p, action))) {
      return true;
    }
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────
// assertNoStrongerAdminCredential: fail-closed credential-source guard
// ─────────────────────────────────────────────────────────────────────

export interface CredentialGuardResult {
  ok: boolean;
  reason?: string;
}

/**
 * Optional STS checker. When supplied, the guard can confirm whether a
 * discovered credential resolves to an admin/over-broad identity. It is kept
 * injectable (and optional) so the module stays import-safe and unit tests
 * never hit the network; the default path inspects the environment only.
 */
export interface AdminCredentialProbe {
  /**
   * Return true when the ambient credentials resolve to an identity that is
   * stronger than the scoped deploy role (e.g. AdministratorAccess, or any
   * identity outside the scoped-role boundary). Implementations typically call
   * sts:GetCallerIdentity + iam simulate; the guard treats a throw as
   * "could not prove it is safe" and fails closed.
   */
  isStrongerThanScopedRole(): Promise<boolean>;
}

/**
 * Env-var markers that indicate a discoverable credential SOURCE stronger than
 * (or able to override) the scoped role. AWS_ACCESS_KEY_ID present without an
 * assumed-role session token is a long-lived user key; AWS_PROFILE pointing at
 * a non-scoped profile, or an SSO session, can both resolve to admin.
 */
const SCOPED_ROLE_PROFILE_MARKER = 'claudeclaw-scoped-deploy';

/**
 * Inspect the environment (and, when provided, STS) for a credential source
 * that is STRONGER than the scoped deploy role. Returns { ok:false, reason }
 * the moment one is found, so doctor/bootstrap/deploy can FAIL CLOSED after
 * the scoped role exists: a forgotten admin access key, a default profile, or
 * an SSO cache must not silently grant back everything the boundary removed.
 *
 * The rule, in order:
 *
 *  1. If the caller is explicitly running AS the scoped role (the well-known
 *     marker env var CCE_SCOPED_ROLE_ACTIVE=1, set by bootstrap once it has
 *     assumed the role), a long-lived admin key in the same env is still a
 *     problem and is flagged.
 *  2. A static AWS_ACCESS_KEY_ID WITHOUT an AWS_SESSION_TOKEN is a long-lived
 *     user/root key. Long-lived keys are not the scoped role (which is always
 *     a temporary session), so this is flagged as a stronger source unless it
 *     is the scoped-role marker profile.
 *  3. A default profile / AWS_PROFILE that is not the scoped-role profile is a
 *     potential admin source; flagged.
 *  4. An SSO session (AWS_SSO_* / a populated sso cache hint) is a potential
 *     admin source; flagged.
 *  5. If an STS probe is injected and reports the resolved identity is
 *     stronger than the scoped role, flagged regardless of env shape.
 *
 * A clean env (only the scoped-role session, no static keys, no admin profile)
 * returns { ok:true }.
 */
export async function assertNoStrongerAdminCredential(
  env: NodeJS.ProcessEnv = process.env,
  probe?: AdminCredentialProbe,
): Promise<CredentialGuardResult> {
  const scopedActive = env.CCE_SCOPED_ROLE_ACTIVE === '1';
  const profile = env.AWS_PROFILE ?? env.AWS_DEFAULT_PROFILE;
  const isScopedProfile = profile === SCOPED_ROLE_PROFILE_MARKER;

  // (2) Long-lived static access key with no session token. The scoped role is
  // always a temporary session (it carries a session token), so a static key
  // is, by construction, a different and stronger credential source.
  const accessKeyId = env.AWS_ACCESS_KEY_ID;
  const sessionToken = env.AWS_SESSION_TOKEN ?? env.AWS_SECURITY_TOKEN;
  // A static key (no session token) is NEVER the scoped role, which is always a
  // temporary session. The profile NAME must not suppress this check: an
  // explicit AWS_ACCESS_KEY_ID outranks AWS_PROFILE in the SDK provider chain,
  // so naming the profile after the scoped marker while a static admin key is
  // present would otherwise fail OPEN (the static key is what actually signs).
  if (accessKeyId && !sessionToken) {
    const looksRoot = accessKeyId.startsWith('AKIA');
    return {
      ok: false,
      reason:
        `A long-lived AWS access key (${looksRoot ? 'AKIA…' : 'ASIA-less'} ` +
        `AWS_ACCESS_KEY_ID with no AWS_SESSION_TOKEN) is present in the ` +
        `environment. After bootstrap the deploy must run AS the scoped role ` +
        `(a temporary session), not a static admin key. Unset AWS_ACCESS_KEY_ID/` +
        `AWS_SECRET_ACCESS_KEY and assume ${SCOPED_ROLE_PROFILE_MARKER}.`,
    };
  }

  // (1) Even when the scoped role is active, a static key alongside it is a
  // back door. The check above already catches the keyless case; this catches
  // a static key co-existing with a session.
  if (scopedActive && accessKeyId && !isScopedProfile && sessionToken) {
    return {
      ok: false,
      reason:
        'The scoped role is active but a separate AWS_ACCESS_KEY_ID is also ' +
        'set in the environment, which can override the scoped session. ' +
        'Remove the static key so only the scoped-role session remains.',
    };
  }

  // (3) A non-scoped profile that could resolve to admin.
  if (profile && !isScopedProfile && !scopedActive) {
    return {
      ok: false,
      reason:
        `AWS_PROFILE='${profile}' is set and is not the scoped-deploy profile ` +
        `('${SCOPED_ROLE_PROFILE_MARKER}'). This profile may carry admin ` +
        `rights stronger than the scoped role. Switch to the scoped profile or ` +
        `assume the scoped role explicitly before deploying.`,
    };
  }

  // (4) An SSO session can resolve to admin.
  const ssoHints = [
    env.AWS_SSO_ACCOUNT_ID,
    env.AWS_SSO_ROLE_NAME,
    env.AWS_SSO_START_URL,
    env.AWS_SSO_SESSION,
  ].filter(Boolean);
  if (ssoHints.length > 0 && !isScopedProfile && !scopedActive) {
    return {
      ok: false,
      reason:
        'An AWS SSO session is present in the environment (AWS_SSO_*), which ' +
        'can resolve to an admin permission set stronger than the scoped role. ' +
        'Run the deploy under the scoped-role session instead.',
    };
  }

  // (5) Optional STS probe: even with a clean-looking env, confirm the
  // resolved identity is not stronger than the scoped role. A throw is treated
  // as "cannot prove safe" and fails closed.
  if (probe) {
    try {
      const stronger = await probe.isStrongerThanScopedRole();
      if (stronger) {
        return {
          ok: false,
          reason:
            'The resolved AWS identity is stronger than the scoped deploy ' +
            'role (STS/identity probe). Re-run under the scoped-role session.',
        };
      }
    } catch (err) {
      return {
        ok: false,
        reason:
          'Could not verify the active AWS identity against the scoped role ' +
          `(${err instanceof Error ? err.message : String(err)}); failing ` +
          'closed. Confirm you are running as the scoped deploy role.',
      };
    }
  }

  return { ok: true };
}

/** Exposed for tests + callers that build the scoped-role profile name. */
export const SCOPED_ROLE_PROFILE_NAME = SCOPED_ROLE_PROFILE_MARKER;
