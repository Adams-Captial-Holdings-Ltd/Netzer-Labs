/**
 * Deny-by-default isolation scanner (onboarding plan, invariant I7).
 *
 * Onboarding self-host runs in a STANDALONE account that must be EMPTY before
 * we provision into it, so a botched destroy or a stray pre-existing resource
 * can never be confused with ours and can never silently rack up spend. This
 * scanner proves emptiness the only safe way: deny-by-default. It enumerates
 * every enabled region, probes the stateful / paid services in each, and
 * declares the account empty ONLY when every probe in every region returned
 * zero non-allowlisted resources AND every probe could actually be evaluated.
 *
 * The verdict is a STRUCTURED BOOLEAN the tool computes from findings, NEVER
 * prose. Three outcomes:
 *   - 'empty'         every region scanned, every probe evaluated, zero findings.
 *   - 'not-empty'     at least one non-allowlisted resource found.
 *   - 'indeterminate' any region could not be enumerated/scanned, OR any probe
 *                     was unevaluable. FAIL CLOSED: an unscanned region or an
 *                     unevaluable service NEVER reads as 'empty'.
 *
 * Note the precedence: a real finding makes the account 'not-empty' even if
 * other probes were unevaluable (you cannot un-see a resource), but the
 * absence of findings is only ever 'empty' when the scan was COMPLETE.
 *
 * Allowlist (the ONLY things permitted in an "empty" account):
 *   - the default VPC (one per region) and its default-VPC-attached primitives;
 *   - default / AWS-service-linked IAM roles (path /aws-service-role/ and the
 *     well-known AWS default roles);
 *   nothing else. Every other resource is a finding.
 *
 * EXTENSION POINT: SERVICE_PROBES is the registry. Add a probe object to cover
 * another service. This file ships a representative-but-real subset
 * (EC2 instances, non-default VPCs, EIPs, ECS clusters, DynamoDB tables, S3
 * buckets, Lambda functions, ELBv2 load balancers, CloudFormation stacks,
 * Secrets, KMS customer keys, ECR repos). RDS, Route53, CloudFront, Budgets,
 * and broader IAM are called out in the plan and slot in here the same way.
 *
 * Import-safe: no top-level side effects. All AWS clients are injected (the
 * `{ send }` shape from scripts/lib/preflight/checks.ts) so the whole scan is
 * mockable; nothing runs on import and no SDK client is built at module load.
 */

// ─────────────────────────────────────────────────────────────────────
// Versioning
// ─────────────────────────────────────────────────────────────────────

/**
 * Scanner version. BUMP when the probe set or allowlist semantics change so a
 * recorded "empty" verdict can be tied to exactly the coverage that produced
 * it. A newer scanner finding resources an older one missed must be a NEW scan,
 * not a silent reinterpretation of an old verdict.
 */
export const SCANNER_VERSION = '1.0.0';

// ─────────────────────────────────────────────────────────────────────
// Injected client shape
// ─────────────────────────────────────────────────────────────────────

/** Minimal AWS-shaped client (mirrors preflight/checks.ts AwsClient). */
export interface AwsClient {
  send(command: unknown): Promise<unknown>;
}

/** CLI-shaped command (matches checks.ts CliCommand) for services with no SDK dep. */
export interface CliCommand {
  action: string;
  args: string[];
}

/**
 * A per-region client factory. The scanner asks for a service client scoped to
 * a region; the caller decides whether to return an SDK client or the read-only
 * `aws` CLI adapter. Tests return fakes. Global services are requested with the
 * synthetic region GLOBAL_REGION.
 */
export type ClientFactory = (service: string, region: string) => AwsClient;

/** Synthetic region label for account-global services (S3, IAM, etc.). */
export const GLOBAL_REGION = 'global';

// ─────────────────────────────────────────────────────────────────────
// Result types
// ─────────────────────────────────────────────────────────────────────

export interface Finding {
  service: string;
  region: string;
  resourceId: string;
}

export interface Unevaluable {
  service: string;
  region: string;
  reason: string;
}

export type Verdict = 'empty' | 'not-empty' | 'indeterminate';

export interface ScanResult {
  empty: boolean;
  scannerVersion: string;
  scannedRegions: string[];
  unscannedRegions: string[];
  findings: Finding[];
  unevaluable: Unevaluable[];
  verdict: Verdict;
}

// ─────────────────────────────────────────────────────────────────────
// Probe contract
// ─────────────────────────────────────────────────────────────────────

/** What a single probe returns for one region. */
export interface ProbeOutput {
  findings: Finding[];
  unevaluable: Unevaluable[];
}

export interface ProbeContext {
  region: string;
  /** Resolve a client for an arbitrary AWS service in this probe's region. */
  client: (service: string) => AwsClient;
}

export interface ServiceProbe {
  /** Stable service label used in findings/unevaluable rows. */
  service: string;
  /** Global services run once under GLOBAL_REGION; regional ones run per region. */
  scope: 'regional' | 'global';
  run(ctx: ProbeContext): Promise<ProbeOutput>;
}

// ─────────────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────────────

function errName(err: unknown): string {
  return err instanceof Error ? err.name : 'UnknownError';
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function finding(service: string, region: string, resourceId: string): Finding {
  return { service, region, resourceId };
}

function unevaluable(service: string, region: string, reason: string): Unevaluable {
  return { service, region, reason };
}

/** Default / AWS-service-linked IAM roles that are allowed in an empty account. */
const ALLOWLISTED_IAM_ROLE_PATHS = ['/aws-service-role/'];
const ALLOWLISTED_IAM_ROLE_NAMES = new Set([
  'AWSServiceRoleForOrganizations',
  'AWSServiceRoleForSupport',
  'AWSServiceRoleForTrustedAdvisor',
  'OrganizationAccountAccessRole',
]);

function isAllowlistedIamRole(role: { RoleName?: string; Path?: string; Arn?: string }): boolean {
  const path = role.Path ?? '';
  if (ALLOWLISTED_IAM_ROLE_PATHS.some((p) => path.startsWith(p))) return true;
  if (path.startsWith('/aws-service-role/')) return true;
  const name = role.RoleName ?? '';
  if (ALLOWLISTED_IAM_ROLE_NAMES.has(name)) return true;
  // Service-linked roles are also identifiable by ARN segment.
  if ((role.Arn ?? '').includes(':role/aws-service-role/')) return true;
  return false;
}

// ─────────────────────────────────────────────────────────────────────
// Probes (the registry below is the EXTENSION POINT)
// ─────────────────────────────────────────────────────────────────────

const ec2InstancesProbe: ServiceProbe = {
  service: 'ec2:instance',
  scope: 'regional',
  async run(ctx) {
    try {
      const out = (await ctx.client('ec2').send({
        action: 'describe-instances',
        args: [],
      } satisfies CliCommand)) as {
        Reservations?: Array<{ Instances?: Array<{ InstanceId?: string; State?: { Name?: string } }> }>;
      };
      const findings: Finding[] = [];
      for (const r of out.Reservations ?? []) {
        for (const inst of r.Instances ?? []) {
          // Terminated instances are inert (no spend, auto-reaped); ignore them.
          if (inst.State?.Name === 'terminated') continue;
          if (inst.InstanceId) findings.push(finding(this.service, ctx.region, inst.InstanceId));
        }
      }
      return { findings, unevaluable: [] };
    } catch (err) {
      return {
        findings: [],
        unevaluable: [unevaluable(this.service, ctx.region, `${errName(err)}: ${errMessage(err)}`)],
      };
    }
  },
};

const ec2VpcsProbe: ServiceProbe = {
  service: 'ec2:vpc',
  scope: 'regional',
  async run(ctx) {
    try {
      const out = (await ctx.client('ec2').send({
        action: 'describe-vpcs',
        args: [],
      } satisfies CliCommand)) as {
        Vpcs?: Array<{ VpcId?: string; IsDefault?: boolean }>;
      };
      const findings: Finding[] = [];
      for (const vpc of out.Vpcs ?? []) {
        // The default VPC is allowlisted; anything beyond it is a finding.
        if (vpc.IsDefault) continue;
        if (vpc.VpcId) findings.push(finding(this.service, ctx.region, vpc.VpcId));
      }
      return { findings, unevaluable: [] };
    } catch (err) {
      return {
        findings: [],
        unevaluable: [unevaluable(this.service, ctx.region, `${errName(err)}: ${errMessage(err)}`)],
      };
    }
  },
};

const ec2EipsProbe: ServiceProbe = {
  service: 'ec2:eip',
  scope: 'regional',
  async run(ctx) {
    try {
      const out = (await ctx.client('ec2').send({
        action: 'describe-addresses',
        args: [],
      } satisfies CliCommand)) as { Addresses?: Array<{ AllocationId?: string; PublicIp?: string }> };
      const findings = (out.Addresses ?? []).map((a) =>
        finding(this.service, ctx.region, a.AllocationId ?? a.PublicIp ?? 'unknown-eip'),
      );
      return { findings, unevaluable: [] };
    } catch (err) {
      return {
        findings: [],
        unevaluable: [unevaluable(this.service, ctx.region, `${errName(err)}: ${errMessage(err)}`)],
      };
    }
  },
};

const ecsClustersProbe: ServiceProbe = {
  service: 'ecs:cluster',
  scope: 'regional',
  async run(ctx) {
    try {
      const out = (await ctx.client('ecs').send({
        action: 'list-clusters',
        args: [],
      } satisfies CliCommand)) as { clusterArns?: string[] };
      const findings = (out.clusterArns ?? []).map((arn) => finding(this.service, ctx.region, arn));
      return { findings, unevaluable: [] };
    } catch (err) {
      return {
        findings: [],
        unevaluable: [unevaluable(this.service, ctx.region, `${errName(err)}: ${errMessage(err)}`)],
      };
    }
  },
};

const dynamoTablesProbe: ServiceProbe = {
  service: 'dynamodb:table',
  scope: 'regional',
  async run(ctx) {
    try {
      const out = (await ctx.client('dynamodb').send({
        action: 'list-tables',
        args: [],
      } satisfies CliCommand)) as { TableNames?: string[] };
      const findings = (out.TableNames ?? []).map((t) => finding(this.service, ctx.region, t));
      return { findings, unevaluable: [] };
    } catch (err) {
      return {
        findings: [],
        unevaluable: [unevaluable(this.service, ctx.region, `${errName(err)}: ${errMessage(err)}`)],
      };
    }
  },
};

const lambdaFunctionsProbe: ServiceProbe = {
  service: 'lambda:function',
  scope: 'regional',
  async run(ctx) {
    try {
      const out = (await ctx.client('lambda').send({
        action: 'list-functions',
        args: [],
      } satisfies CliCommand)) as { Functions?: Array<{ FunctionName?: string; FunctionArn?: string }> };
      const findings = (out.Functions ?? []).map((f) =>
        finding(this.service, ctx.region, f.FunctionArn ?? f.FunctionName ?? 'unknown-function'),
      );
      return { findings, unevaluable: [] };
    } catch (err) {
      return {
        findings: [],
        unevaluable: [unevaluable(this.service, ctx.region, `${errName(err)}: ${errMessage(err)}`)],
      };
    }
  },
};

const elbv2Probe: ServiceProbe = {
  service: 'elbv2:loadbalancer',
  scope: 'regional',
  async run(ctx) {
    try {
      const out = (await ctx.client('elbv2').send({
        action: 'describe-load-balancers',
        args: [],
      } satisfies CliCommand)) as { LoadBalancers?: Array<{ LoadBalancerArn?: string; LoadBalancerName?: string }> };
      const findings = (out.LoadBalancers ?? []).map((lb) =>
        finding(this.service, ctx.region, lb.LoadBalancerArn ?? lb.LoadBalancerName ?? 'unknown-lb'),
      );
      return { findings, unevaluable: [] };
    } catch (err) {
      return {
        findings: [],
        unevaluable: [unevaluable(this.service, ctx.region, `${errName(err)}: ${errMessage(err)}`)],
      };
    }
  },
};

const cloudFormationProbe: ServiceProbe = {
  service: 'cloudformation:stack',
  scope: 'regional',
  async run(ctx) {
    try {
      // Use list-stacks with a status filter so DELETE_COMPLETE stacks (inert)
      // do not register as findings.
      const out = (await ctx.client('cloudformation').send({
        action: 'list-stacks',
        args: [
          '--stack-status-filter',
          'CREATE_COMPLETE',
          'UPDATE_COMPLETE',
          'ROLLBACK_COMPLETE',
          'UPDATE_ROLLBACK_COMPLETE',
          'CREATE_IN_PROGRESS',
          'UPDATE_IN_PROGRESS',
          'IMPORT_COMPLETE',
        ],
      } satisfies CliCommand)) as { StackSummaries?: Array<{ StackName?: string; StackId?: string }> };
      const findings = (out.StackSummaries ?? []).map((s) =>
        finding(this.service, ctx.region, s.StackId ?? s.StackName ?? 'unknown-stack'),
      );
      return { findings, unevaluable: [] };
    } catch (err) {
      return {
        findings: [],
        unevaluable: [unevaluable(this.service, ctx.region, `${errName(err)}: ${errMessage(err)}`)],
      };
    }
  },
};

const secretsProbe: ServiceProbe = {
  service: 'secretsmanager:secret',
  scope: 'regional',
  async run(ctx) {
    try {
      const out = (await ctx.client('secretsmanager').send({
        action: 'list-secrets',
        args: [],
      } satisfies CliCommand)) as { SecretList?: Array<{ ARN?: string; Name?: string }> };
      const findings = (out.SecretList ?? []).map((s) =>
        finding(this.service, ctx.region, s.ARN ?? s.Name ?? 'unknown-secret'),
      );
      return { findings, unevaluable: [] };
    } catch (err) {
      return {
        findings: [],
        unevaluable: [unevaluable(this.service, ctx.region, `${errName(err)}: ${errMessage(err)}`)],
      };
    }
  },
};

const kmsKeysProbe: ServiceProbe = {
  service: 'kms:key',
  scope: 'regional',
  async run(ctx) {
    try {
      const out = (await ctx.client('kms').send({
        action: 'list-keys',
        args: [],
      } satisfies CliCommand)) as { Keys?: Array<{ KeyId?: string; KeyArn?: string }> };
      const keys = out.Keys ?? [];
      const findings: Finding[] = [];
      const unevaluables: Unevaluable[] = [];
      for (const k of keys) {
        const keyId = k.KeyId ?? k.KeyArn;
        if (!keyId) continue;
        // AWS-managed keys (KeyManager === 'AWS') are not customer keys and are
        // allowlisted; we must DescribeKey to learn the manager. If that
        // describe fails we cannot classify the key, which is unevaluable
        // (fail closed) rather than silently ignored.
        try {
          const desc = (await ctx.client('kms').send({
            action: 'describe-key',
            args: ['--key-id', keyId],
          } satisfies CliCommand)) as { KeyMetadata?: { KeyManager?: string } };
          const manager = desc.KeyMetadata?.KeyManager;
          if (manager === 'AWS') continue; // AWS-managed, allowlisted
          findings.push(finding(this.service, ctx.region, keyId));
        } catch (err) {
          unevaluables.push(
            unevaluable(this.service, ctx.region, `describe-key ${keyId} failed (${errName(err)}: ${errMessage(err)})`),
          );
        }
      }
      return { findings, unevaluable: unevaluables };
    } catch (err) {
      return {
        findings: [],
        unevaluable: [unevaluable(this.service, ctx.region, `${errName(err)}: ${errMessage(err)}`)],
      };
    }
  },
};

const ecrReposProbe: ServiceProbe = {
  service: 'ecr:repository',
  scope: 'regional',
  async run(ctx) {
    try {
      const out = (await ctx.client('ecr').send({
        action: 'describe-repositories',
        args: [],
      } satisfies CliCommand)) as { repositories?: Array<{ repositoryName?: string; repositoryArn?: string }> };
      const findings = (out.repositories ?? []).map((r) =>
        finding(this.service, ctx.region, r.repositoryArn ?? r.repositoryName ?? 'unknown-repo'),
      );
      return { findings, unevaluable: [] };
    } catch (err) {
      return {
        findings: [],
        unevaluable: [unevaluable(this.service, ctx.region, `${errName(err)}: ${errMessage(err)}`)],
      };
    }
  },
};

// ── Global-scope probes ──────────────────────────────────────────────

const s3BucketsProbe: ServiceProbe = {
  service: 's3:bucket',
  scope: 'global',
  async run(ctx) {
    try {
      const out = (await ctx.client('s3api').send({
        action: 'list-buckets',
        args: [],
      } satisfies CliCommand)) as { Buckets?: Array<{ Name?: string }> };
      const findings = (out.Buckets ?? [])
        .map((b) => b.Name)
        .filter((n): n is string => !!n)
        .map((n) => finding(this.service, ctx.region, n));
      return { findings, unevaluable: [] };
    } catch (err) {
      return {
        findings: [],
        unevaluable: [unevaluable(this.service, ctx.region, `${errName(err)}: ${errMessage(err)}`)],
      };
    }
  },
};

const iamRolesProbe: ServiceProbe = {
  service: 'iam:role',
  scope: 'global',
  async run(ctx) {
    try {
      const out = (await ctx.client('iam').send({
        action: 'list-roles',
        args: [],
      } satisfies CliCommand)) as { Roles?: Array<{ RoleName?: string; Path?: string; Arn?: string }> };
      const findings: Finding[] = [];
      for (const role of out.Roles ?? []) {
        if (isAllowlistedIamRole(role)) continue;
        findings.push(finding(this.service, ctx.region, role.Arn ?? role.RoleName ?? 'unknown-role'));
      }
      return { findings, unevaluable: [] };
    } catch (err) {
      return {
        findings: [],
        unevaluable: [unevaluable(this.service, ctx.region, `${errName(err)}: ${errMessage(err)}`)],
      };
    }
  },
};

/**
 * THE EXTENSION POINT. Append a ServiceProbe to cover another stateful/paid
 * service (RDS, Route53 hosted zones, CloudFront distributions, Budgets, more
 * IAM resource types). Regional probes run in every enabled region; global
 * probes run once under GLOBAL_REGION. Keep each probe fail-closed: catch its
 * own errors into `unevaluable` rather than throwing, and treat anything it
 * cannot classify as unevaluable, never as empty.
 */
export const SERVICE_PROBES: ServiceProbe[] = [
  ec2InstancesProbe,
  ec2VpcsProbe,
  ec2EipsProbe,
  ecsClustersProbe,
  dynamoTablesProbe,
  lambdaFunctionsProbe,
  elbv2Probe,
  cloudFormationProbe,
  secretsProbe,
  kmsKeysProbe,
  ecrReposProbe,
  s3BucketsProbe,
  iamRolesProbe,
];

// ─────────────────────────────────────────────────────────────────────
// Region enumeration
// ─────────────────────────────────────────────────────────────────────

interface RegionEnumeration {
  regions: string[];
  /** True when the list could not be obtained — the scan is then indeterminate. */
  failed: boolean;
  reason?: string;
  /**
   * Regions returned by DescribeRegions whose OptInStatus is neither a known
   * reachable value NOR the safe 'not-opted-in' (disabled) value: an unknown,
   * transitional, or malformed status. These are NOT scanned and NOT dropped;
   * the caller folds them into the scan's unscannedRegions so the verdict is
   * 'indeterminate' (fail closed), never 'empty'.
   */
  unreachableRegions?: string[];
}

/**
 * Enumerate enabled regions via ec2:DescribeRegions, including opt-in regions
 * whose opt-in-status is 'opted-in' (or 'opt-in-not-required'). A failure to
 * enumerate is FATAL to emptiness: we cannot prove an account empty across
 * regions we could not list, so the caller marks the verdict indeterminate.
 */
async function enumerateRegions(ec2Global: AwsClient): Promise<RegionEnumeration> {
  try {
    const out = (await ec2Global.send({
      action: 'describe-regions',
      args: ['--all-regions'],
    } satisfies CliCommand)) as {
      Regions?: Array<{ RegionName?: string; OptInStatus?: string }>;
    };
    const regions: string[] = [];
    const unreachableRegions: string[] = [];
    for (const r of out.Regions ?? []) {
      if (!r.RegionName) continue;
      // Normalize: OptInStatus is a free-form field; a casing/whitespace variant
      // must not be mistaken for "disabled" and silently dropped.
      const status = (r.OptInStatus ?? 'opt-in-not-required').trim().toLowerCase();
      if (status === 'opt-in-not-required' || status === 'opted-in') {
        regions.push(r.RegionName); // reachable: scan it
      } else if (status === 'not-opted-in') {
        continue; // a disabled opt-in region genuinely cannot hold resources
      } else {
        // Unknown / transitional / malformed (e.g. 'opting-in', 'pending-
        // activation', ''): we CANNOT prove this region is off, so it must be
        // treated as unscanned (=> indeterminate), never dropped (=> empty).
        unreachableRegions.push(r.RegionName);
      }
    }
    if (regions.length === 0 && unreachableRegions.length === 0) {
      return { regions: [], failed: true, reason: 'DescribeRegions returned no enabled regions' };
    }
    return { regions, failed: false, unreachableRegions };
  } catch (err) {
    return { regions: [], failed: true, reason: `${errName(err)}: ${errMessage(err)}` };
  }
}

// ─────────────────────────────────────────────────────────────────────
// Verdict computation (structured boolean, never prose)
// ─────────────────────────────────────────────────────────────────────

export interface ComputeVerdictInput {
  findings: Finding[];
  unevaluable: Unevaluable[];
  unscannedRegions: string[];
}

/**
 * The verdict rule, in one place so it is auditable:
 *   - any finding            => 'not-empty'   (cannot un-see a resource)
 *   - else any unscanned
 *     region OR unevaluable  => 'indeterminate' (FAIL CLOSED: never "empty")
 *   - else                   => 'empty'
 * `empty` is true ONLY for the 'empty' verdict.
 */
export function computeVerdict(input: ComputeVerdictInput): { verdict: Verdict; empty: boolean } {
  if (input.findings.length > 0) return { verdict: 'not-empty', empty: false };
  if (input.unscannedRegions.length > 0 || input.unevaluable.length > 0) {
    return { verdict: 'indeterminate', empty: false };
  }
  return { verdict: 'empty', empty: true };
}

// ─────────────────────────────────────────────────────────────────────
// Scan runner
// ─────────────────────────────────────────────────────────────────────

export interface RunIsolationScanOptions {
  /** Per-region client factory. Required. */
  clientFor: ClientFactory;
  /**
   * Override the region list (skip enumeration). When omitted the scanner calls
   * ec2:DescribeRegions on a client built via clientFor('ec2', regionForEnum).
   */
  regions?: string[];
  /** Region used to enumerate regions and to host global-service clients. */
  regionForEnum?: string;
  /** Override the probe set (tests / extension). Defaults to SERVICE_PROBES. */
  probes?: ServiceProbe[];
}

/**
 * Run the deny-by-default scan. Returns a fully structured ScanResult; the
 * verdict is computed, never authored. Probe-level errors become `unevaluable`
 * rows (fail closed); a region whose probes throw at the factory level is moved
 * to `unscannedRegions`. The result is import-safe to compute and carries no
 * side effects beyond the injected AWS reads.
 */
export async function runIsolationScan(opts: RunIsolationScanOptions): Promise<ScanResult> {
  const probes = opts.probes ?? SERVICE_PROBES;
  const enumRegion = opts.regionForEnum ?? 'us-east-1';

  // 1. Determine the region set.
  let regions: string[];
  const unscannedRegions: string[] = [];
  const findings: Finding[] = [];
  const unevaluables: Unevaluable[] = [];
  const scannedRegions: string[] = [];
  if (opts.regions && opts.regions.length > 0) {
    regions = [...opts.regions];
  } else {
    const ec2Global = opts.clientFor('ec2', enumRegion);
    const enumeration = await enumerateRegions(ec2Global);
    if (enumeration.failed) {
      // We could not even learn the region list. Everything is unscanned; the
      // result is unambiguously indeterminate. We surface a single sentinel
      // unscanned region so the caller sees a non-empty unscannedRegions list.
      const enumFail: Unevaluable[] = [
        unevaluable('ec2:describe-regions', enumRegion, enumeration.reason ?? 'region enumeration failed'),
      ];
      const verdict = computeVerdict({ findings: [], unevaluable: enumFail, unscannedRegions: ['<all>'] });
      return {
        empty: verdict.empty,
        scannerVersion: SCANNER_VERSION,
        scannedRegions: [],
        unscannedRegions: ['<all>'],
        findings: [],
        unevaluable: enumFail,
        verdict: verdict.verdict,
      };
    }
    regions = enumeration.regions;
    // Regions with an unknown/transitional OptInStatus are reachable-unknown:
    // record them as unscanned + unevaluable so emptiness cannot be claimed for
    // a region we never probed (fail closed).
    for (const r of enumeration.unreachableRegions ?? []) {
      unscannedRegions.push(r);
      unevaluables.push(unevaluable('ec2:describe-regions', r, 'unrecognized OptInStatus; region not scanned'));
    }
  }

  const regionalProbes = probes.filter((p) => p.scope === 'regional');
  const globalProbes = probes.filter((p) => p.scope === 'global');

  // 2. Regional probes, per region.
  for (const region of regions) {
    let clientResolver: (service: string) => AwsClient;
    try {
      // Resolve the factory eagerly so a factory that cannot serve this region
      // (e.g. CLI/credential error) drops the WHOLE region into unscanned
      // rather than silently producing zero findings.
      const probeClient = (service: string): AwsClient => opts.clientFor(service, region);
      // Smoke-resolve one client so a throwing factory is caught here.
      probeClient('ec2');
      clientResolver = probeClient;
    } catch (err) {
      unscannedRegions.push(region);
      unevaluables.push(unevaluable('region', region, `client factory failed: ${errName(err)}: ${errMessage(err)}`));
      continue;
    }

    for (const probe of regionalProbes) {
      try {
        const out = await probe.run({ region, client: clientResolver });
        findings.push(...out.findings);
        unevaluables.push(...out.unevaluable);
      } catch (err) {
        // A probe that throws despite the contract must not abort the region;
        // record it as unevaluable (fail closed) and keep scanning.
        unevaluables.push(unevaluable(probe.service, region, `probe threw: ${errName(err)}: ${errMessage(err)}`));
      }
    }
    // The region was reachable and every regional probe ran, so it counts as
    // "scanned" (we did look). Any per-probe unevaluables are reflected in the
    // unevaluables list, which keeps the verdict honest (fail closed).
    scannedRegions.push(region);
  }

  // 3. Global probes, once, under GLOBAL_REGION.
  if (globalProbes.length > 0) {
    let globalResolver: ((service: string) => AwsClient) | null = null;
    try {
      const probeClient = (service: string): AwsClient => opts.clientFor(service, GLOBAL_REGION);
      probeClient('iam');
      globalResolver = probeClient;
    } catch (err) {
      unevaluables.push(
        unevaluable('global', GLOBAL_REGION, `global client factory failed: ${errName(err)}: ${errMessage(err)}`),
      );
    }
    if (globalResolver) {
      for (const probe of globalProbes) {
        try {
          const out = await probe.run({ region: GLOBAL_REGION, client: globalResolver });
          findings.push(...out.findings);
          unevaluables.push(...out.unevaluable);
        } catch (err) {
          unevaluables.push(
            unevaluable(probe.service, GLOBAL_REGION, `probe threw: ${errName(err)}: ${errMessage(err)}`),
          );
        }
      }
    }
  }

  // 4. Compute the structured verdict.
  const { verdict, empty } = computeVerdict({ findings, unevaluable: unevaluables, unscannedRegions });

  return {
    empty,
    scannerVersion: SCANNER_VERSION,
    scannedRegions,
    unscannedRegions,
    findings,
    unevaluable: unevaluables,
    verdict,
  };
}
