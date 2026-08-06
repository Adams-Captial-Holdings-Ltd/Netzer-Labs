/**
 * ClaudeClaw Enterprise — redacting support bundle (IaC readiness item 36).
 *
 * Runs the SAME verification registry as `npm run status` programmatically
 * (scripts/lib/verify/checks.ts) and emits a machine-readable bundle that is
 * safe to paste into a PUBLIC GitHub issue:
 *
 *   {
 *     schemaVersion: 1,
 *     generatedAt,
 *     deployedVersion,        // deployId + gitSha + imageTag from the manifest, if readable
 *     tier, mode, region,
 *     checks: [{ id, status, sanitizedDetail, remediationLink }],
 *     hashedResourceIds: [{ kind, hash }],
 *     redaction: { applied, saltSource, note }
 *   }
 *
 * Redaction design (plan item 36): identifying values in check details —
 * 12-digit account ids, `arn:aws...` ARNs, `http(s)://` hosts, resource
 * names carrying the app prefix, and the configured domain — are replaced by
 * the first 12 hex chars of an HMAC-SHA256 keyed by a PER-DEPLOYMENT salt.
 * Unsalted hashes of predictable resource names are reversible by dictionary
 * and correlate ACROSS users; salted, they correlate only within one
 * deployment, which is the useful property (a maintainer can see two failures
 * name the same bucket without learning the bucket's name).
 *
 * Salt source: the deploy manifest's `synthInputs.CCE_SUPPORT_SALT` when
 * present. Writing that salt AT DEPLOY TIME (generate once, add the key to
 * SYNTH_INPUT_ALLOWLIST, record it in the manifest) is the follow-up; this
 * script deliberately adds NOTHING to the manifest type. Until the deploy
 * writes one, a random per-RUN session salt is used and the bundle says so:
 * hashes then correlate only within that single bundle, not across bundles
 * from the same deployment.
 *
 * `--raw` skips redaction for PRIVATE use (SECURITY.md escalation path).
 * Raw bundles name your account, ARNs, resources, and domain — never paste
 * one publicly.
 *
 *   npx tsx scripts/support-bundle.ts            # human header + JSON
 *   npx tsx scripts/support-bundle.ts --json     # JSON only on stdout
 *   npx tsx scripts/support-bundle.ts --raw      # UNREDACTED, private use only
 *   npx tsx scripts/support-bundle.ts --strict   # include the paid strict probes
 *   npx tsx scripts/support-bundle.ts --env=staging
 */

import { createHmac, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseEnvFile, resolveEnvFlag, envFileNameFor } from './lib/env-file.js';
import {
  allChecks,
  buildVerifyContext,
  getManifest,
  runVerify,
  type CheckResult,
} from './lib/verify/checks.js';

// ─────────────────────────────────────────────────────────────────────
// Bundle schema
// ─────────────────────────────────────────────────────────────────────

export const BUNDLE_SCHEMA_VERSION = 1;

export interface HashedResourceId {
  /** What KIND of value was masked (account-id, arn, url-host, resource-name, domain). */
  kind: string;
  /** First 12 hex chars of HMAC-SHA256(salt, value). */
  hash: string;
}

export interface BundleCheck {
  id: string;
  status: string;
  sanitizedDetail: string;
  remediationLink: string;
}

export interface SupportBundle {
  schemaVersion: typeof BUNDLE_SCHEMA_VERSION;
  generatedAt: string;
  /** Self-identifies the install for issue reports (docs-at-tag guidance). */
  deployedVersion: { deployId: string; gitSha: string; imageTag: string } | null;
  tier: number;
  mode: string;
  region: string;
  checks: BundleCheck[];
  hashedResourceIds: HashedResourceId[];
  redaction: {
    applied: boolean;
    /** 'manifest' = per-deployment salt; 'session' = random per-run salt. */
    saltSource: 'manifest' | 'session' | 'none';
    note: string;
  };
}

// ─────────────────────────────────────────────────────────────────────
// Redactor
// ─────────────────────────────────────────────────────────────────────

export interface RedactOptions {
  salt: string;
  /** App slug, e.g. `claudeclaw` — any token containing it is a resource name. */
  appSlug: string;
  /** Stack-name prefix, e.g. `CCE` — tokens starting `<prefix>-` are stacks. */
  stackPrefix?: string;
  /** Configured DOMAIN_NAME, masked verbatim when present. */
  domain?: string;
}

export function hashValue(value: string, salt: string): string {
  return createHmac('sha256', salt).update(value).digest('hex').slice(0, 12);
}

interface Collector {
  ids: Map<string, HashedResourceId>;
}

function mask(collector: Collector, kind: string, value: string, salt: string): string {
  const hash = hashValue(value, salt);
  collector.ids.set(`${kind}:${hash}`, { kind, hash });
  return `[${kind}:${hash}]`;
}

/**
 * Redact one detail string. Keeps the check's semantics (what failed, why)
 * while masking identifying values. Order matters: ARNs first (they embed
 * account ids and resource names), then URLs, then bare account ids, then
 * app-prefixed resource names, then the configured domain.
 */
export function redactText(
  text: string,
  opts: RedactOptions,
  collector?: Collector,
): { text: string; ids: HashedResourceId[] } {
  const col: Collector = collector ?? { ids: new Map() };
  const { salt } = opts;
  let out = text;

  // 1. ARNs (any partition: aws, aws-cn, aws-us-gov).
  out = out.replace(/\barn:aws[a-z-]*:[^\s"'`,)\]]+/g, (m) => mask(col, 'arn', m, salt));

  // 2. http(s) URLs — the HOST is the identifying part; the whole URL is
  //    masked by the host's hash so paths can't leak resource names either.
  out = out.replace(/https?:\/\/[^\s"'`,)\]]+/g, (m) => {
    let host = m;
    try {
      host = new URL(m).host;
    } catch {
      /* keep the full match as the hash input */
    }
    return mask(col, 'url-host', host, salt);
  });

  // 3. 12-digit AWS account ids.
  out = out.replace(/\b\d{12}\b/g, (m) => mask(col, 'account-id', m, salt));

  // 4. Resource names carrying the app prefix (buckets, tables, clusters,
  //    log groups, queues...) and stack names under the stack prefix.
  if (opts.appSlug) {
    const slug = escapeRegExp(opts.appSlug);
    const re = new RegExp(`\\b[\\w./-]*${slug}[\\w./-]*`, 'gi');
    out = out.replace(re, (m) => mask(col, 'resource-name', m, salt));
  }
  if (opts.stackPrefix) {
    const prefix = escapeRegExp(opts.stackPrefix);
    const re = new RegExp(`\\b${prefix}-[\\w-]+`, 'g');
    out = out.replace(re, (m) => mask(col, 'resource-name', m, salt));
  }

  // 5. The configured domain, verbatim (covers bare-hostname mentions that
  //    the URL pass can't see).
  if (opts.domain) {
    const dom = escapeRegExp(opts.domain);
    out = out.replace(new RegExp(dom, 'gi'), (m) => mask(col, 'domain', m.toLowerCase(), salt));
  }

  return { text: out, ids: [...col.ids.values()] };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─────────────────────────────────────────────────────────────────────
// Bundle construction
// ─────────────────────────────────────────────────────────────────────

const checkLayer = new Map(allChecks.map((c) => [c.id, c.layer] as const));

/**
 * Every named verify check has a troubleshooting entry (plan item 35) whose
 * GitHub heading slug is `<id>-<layer>` (heading text "`<id>` (<LAYER>)").
 */
export function remediationLinkFor(id: string): string {
  const layer = checkLayer.get(id);
  return layer
    ? `docs/troubleshooting.md#${id}-${layer.toLowerCase()}`
    : 'docs/troubleshooting.md';
}

export interface BuildBundleInput {
  results: CheckResult[];
  manifest: { deployId: string; gitSha: string; imageTag: string } | null;
  tier: number;
  mode: string;
  region: string;
  redact: boolean;
  redactOptions: RedactOptions;
  saltSource: 'manifest' | 'session';
  now?: Date;
}

export function buildBundle(input: BuildBundleInput): SupportBundle {
  const collector: Collector = { ids: new Map() };
  const checks: BundleCheck[] = input.results.map((r) => {
    const detail = [r.detail, r.remediation ? `fix: ${r.remediation}` : '']
      .filter(Boolean)
      .join(' · ');
    const sanitizedDetail = input.redact
      ? redactText(detail, input.redactOptions, collector).text
      : detail;
    return {
      id: r.id,
      status: r.status,
      sanitizedDetail,
      remediationLink: remediationLinkFor(r.id),
    };
  });
  return {
    schemaVersion: BUNDLE_SCHEMA_VERSION,
    generatedAt: (input.now ?? new Date()).toISOString(),
    deployedVersion: input.manifest,
    tier: input.tier,
    mode: input.mode,
    region: input.region,
    checks,
    hashedResourceIds: input.redact ? [...collector.ids.values()] : [],
    redaction: input.redact
      ? {
          applied: true,
          saltSource: input.saltSource,
          note:
            input.saltSource === 'manifest'
              ? 'resource ids are HMAC-SHA256 hashes keyed by this deployment’s salt; they correlate across bundles from this deployment only'
              : 'no per-deployment salt in the manifest; a random SESSION salt was used, so hashed ids correlate only WITHIN this bundle',
        }
      : {
          applied: false,
          saltSource: 'none',
          note: 'RAW bundle — contains real account ids, ARNs, resource names, and domains. Never paste publicly.',
        },
  };
}

// ─────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────

/** Manifest synthInputs key that will carry the per-deployment salt once the
 * deploy writes it (follow-up; nothing is added to the manifest type here). */
export const MANIFEST_SALT_KEY = 'CCE_SUPPORT_SALT';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const jsonMode = args.includes('--json');
  const raw = args.includes('--raw');
  const strict = args.includes('--strict');
  const envFlag = resolveEnvFlag(args);

  const __filename = fileURLToPath(import.meta.url);
  const repoRoot = dirname(dirname(__filename));
  const envPath = join(repoRoot, envFileNameFor(envFlag));
  const err = (msg: string): void => {
    // eslint-disable-next-line no-console
    console.error(msg);
  };

  if (!existsSync(envPath)) {
    err(`No env file at ${envPath}. Run \`npm run setup\` first.`);
    process.exit(1);
  }

  const env = parseEnvFile(readFileSync(envPath, 'utf-8'));
  const ctx = buildVerifyContext(env, { strict });

  if (!jsonMode) {
    err(`support-bundle: running ${strict ? 'strict ' : ''}verification checks (read-only${strict ? ' + the two paid strict probes' : ''})...`);
  }
  const results = await runVerify(ctx);
  const { manifest } = await getManifest(ctx);

  const manifestSalt = manifest?.synthInputs?.[MANIFEST_SALT_KEY];
  const saltSource: 'manifest' | 'session' = manifestSalt ? 'manifest' : 'session';
  const salt = manifestSalt ?? randomBytes(32).toString('hex');

  const bundle = buildBundle({
    results,
    manifest: manifest
      ? { deployId: manifest.deployId, gitSha: manifest.gitSha, imageTag: manifest.imageTag }
      : null,
    tier: ctx.tier,
    mode: ctx.mode,
    region: ctx.region,
    redact: !raw,
    redactOptions: {
      salt,
      appSlug: ctx.appSlug,
      stackPrefix: ctx.stackPrefix,
      domain: env.DOMAIN_NAME,
    },
    saltSource,
  });

  if (raw) {
    err('');
    err('████  RAW BUNDLE — REDACTION SKIPPED  ████');
    err('This output names your AWS account id, ARNs, resource names, and domain.');
    err('It exists for the PRIVATE escalation path in SECURITY.md.');
    err('NEVER paste it into a public issue, gist, discussion, or chat log.');
    err('');
  } else if (!jsonMode) {
    err('redacted bundle below — safe to paste into a public GitHub issue:');
    err('');
  }

  // eslint-disable-next-line no-console
  console.log(JSON.stringify(bundle, null, 2));
}

// Main-guard so tests can import the redactor without running checks.
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((e) => {
    // eslint-disable-next-line no-console
    console.error(`fatal error in support-bundle: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
