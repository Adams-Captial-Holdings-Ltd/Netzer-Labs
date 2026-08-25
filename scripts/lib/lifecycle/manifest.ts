/**
 * Deploy-manifest contract (IaC readiness plan, item 14).
 *
 * One shared TypeScript type with an explicit schema version, so deploy,
 * rollback, status, and teardown all read and write the same record. The
 * manifest is what makes rollback reproducible from a fresh clone: it pins
 * the git sha, the per-deploy image digests for EVERY container, per-stack
 * template hashes, per-secret version ids, and a pointer to the archived
 * cdk.out. `synthInputs` is an ALLOWLISTED non-secret subset of the env that
 * fed synth; a raw env dump would leak surface tokens into the state bucket,
 * so only the named keys ever pass through.
 *
 * `appSchemaVersion` (plan item 18) tracks the APPLICATION schema: DynamoDB
 * item shapes, runtime-config keys, queue/scheduler payload formats. Releases
 * that change those bump it, and rollback preflight refuses a downgrade
 * across that boundary unless paired with a reversible migration, because
 * rolling back code alone can strand the app on item shapes it cannot read.
 */

/** Version of THIS manifest format. Parsers hard-fail on a mismatch. */
export const MANIFEST_SCHEMA_VERSION = 1;

/** Application schema version (DDB item shapes, runtime-config keys, queue payloads). */
export const APP_SCHEMA_VERSION = 1;

/**
 * One container image as actually deployed: (task family, container name,
 * repo, digest, platform). Recorded for EVERY container in every task
 * definition, sidecars included, so rollback reproduces the full container
 * set (plan item 9).
 */
export interface ContainerImageRecord {
  taskFamily: string;
  containerName: string;
  repo: string;
  digest: string;
  platform: string;
}

/**
 * Container name of the Paperclip server image (ADR 0010).
 *
 * PHASE 4 OWNS THIS STRING. Phase 1.5 records the image before any task
 * definition exists, so this name and the `${app}-paperclip` task family in
 * buildImageRecords() are both PREDICTIONS of what infra/lib/paperclip-stack.ts
 * will choose. If Phase 4 names the container or the family anything else, it
 * changes them HERE, in buildImageRecords, and in the literals pinned by
 * paperclip-image-pipeline.test.ts - otherwise the manifest records a rollback
 * target that matches nothing in ECS. It lives here rather than at either use
 * site because two files already compare against it and a third (Phase 4's
 * rollback) will.
 */
export const PAPERCLIP_CONTAINER_NAME = 'paperclip-server';

/** One secret version written by this deploy, labeled with the deployId. */
export interface SecretVersionRecord {
  secretId: string;
  versionId: string;
  label: string;
  previousVersionId?: string;
}

export interface DeployManifest {
  schemaVersion: number;
  appSchemaVersion: number;
  deployId: string;
  gitSha: string;
  cleanTree: boolean;
  account: string;
  region: string;
  tier: number;
  mode: 'chat' | 'infra-only';
  featureFlags: Record<string, boolean>;
  imageTag: string;
  imageDigest?: string;
  ecrRepo: string;
  images: ContainerImageRecord[];
  cdkVersion: string;
  synthInputs: Record<string, string>;
  stacks: string[];
  stackTemplateHashes: Record<string, string>;
  secretVersions: SecretVersionRecord[];
  seedRevision?: string;
  cdkOutArchiveKey?: string;
  deployedAt: string;
}

/**
 * The ONLY env keys that may be recorded as synth inputs. Everything else,
 * notably surface tokens and vendor API keys, never reaches the manifest.
 */
export const SYNTH_INPUT_ALLOWLIST: readonly string[] = [
  'AWS_REGION',
  'CDK_STACK_NAME',
  'CCE_TIER',
  // Both spellings, because infra/bin/app.ts reads `CCE_TIER ?? DEPLOY_TIER`
  // and the local driver's cdkEnvBag forwards only the legacy one. The tier
  // decides what EXISTS, not just how big it is: WAF, the audit-lock bucket,
  // the DDB export Lambda and — since Phase 9 — the whole Paperclip substrate
  // are provisioned by tier, so a rollback that re-synths from this manifest
  // at a different tier would drop a deployed, deletion-protected Aurora
  // cluster out of the assembly. That is the exact hazard the
  // CCE_PAPERCLIP_ENABLED entry below was added for, moved to where the gate
  // now lives.
  'DEPLOY_TIER',
  'CCE_NAME_SUFFIX',
  'CCE_DEPLOY_MODE',
  'DOMAIN_NAME',
  'ACM_CERT_ARN',
  'CCE_CICD_ENABLED',
  'CCE_CODEBUILD_ENABLED',
  'CCE_IMAGE_GEN_ENABLED',
  'CCE_TTS_ENABLED',
  'CCE_KNOWLEDGE_ENABLED',
  'JARVIS_LAUNCH_ENABLED',
  'BEDROCK_DEFAULT_MODEL',
  'BEDROCK_SONNET_MODEL',
  'BEDROCK_HAIKU_MODEL',
  'BEDROCK_OPUS_MODEL',
  'BEDROCK_EMBED_MODEL',
  'ECR_REPO_NAME',
  // Delegated-zone override + anomaly-monitor pin + endpoint opt-in (#45,
  // #49): all three change what synth produces, so a rollback that re-synths
  // from this manifest must replay them or it would fall back to the apex
  // zone lookup / a colliding monitor create / a different endpoint set.
  // None is a secret: zone ids/names and monitor ARNs are resource pointers.
  'HOSTED_ZONE_ID',
  'HOSTED_ZONE_NAME',
  'CCE_ANOMALY_MONITOR_ARN',
  'CCE_PRIVATE_ENDPOINTS',
  // Paperclip ROUTER flag (ADR 0010). Since Phase 9 it no longer decides what
  // synth produces — the tier above does that — but it is still a synth INPUT:
  // compute-stack.ts renders it into the orchestrator task definition, where
  // `paperclipRoutingEnabled()` reads it to choose between the Paperclip ACL
  // and the legacy mission handlers. Replaying it keeps a rollback serving
  // /api/missions from the same place the deploy it rolls back to did.
  'CCE_PAPERCLIP_ENABLED',
  // The ENVIRONMENT-SCOPED provisioning override, and it belongs here for the
  // same reason DEPLOY_TIER does: it decides what EXISTS. Staging is pinned to
  // Tier 0 and provisions the substrate through this variable alone, so a
  // rollback that re-synthed from a manifest without it would render the three
  // stacks EMPTY and orphan the deployed, deletion-protected Aurora cluster the
  // rollback was trying to restore around. One-directional, so replaying it can
  // only ever put the substrate back — never remove one, which is the property
  // that kept CCE_PAPERCLIP_SERVICE_READY out (see below).
  'CCE_PAPERCLIP_PROVISION_ENV_OVERRIDE',
  // Phase 4. Both change what synth produces: paperclip-stack.ts pins both
  // task definitions to the digest and reads the bootstrap flag as the
  // service's DesiredCount. A rollback that re-synths from this manifest must
  // replay them or it would float the image or bring a scaled-to-zero service
  // back up against a database the operator had deliberately not migrated yet.
  //
  // CCE_PAPERCLIP_SERVICE_READY was here and is deliberately GONE. It belonged
  // to the rejected design in which synth omitted the FargateService unless a
  // probe said '1' — the M33 defect, where replaying an empty value deletes a
  // running service. Nothing reads that name anywhere in the tree now, and it
  // must not come back: a variable that can remove a resource has no business
  // in a replay list. CCE_PAPERCLIP_BOOTSTRAP replaces it and can only move
  // DesiredCount, so the worst a replay can do is scale down, recoverably.
  //
  // Neither is a secret: a digest and a '1' flag. The Paperclip API
  // keys and the composed DATABASE_URL are NOT here and must never be added;
  // they live only in Secrets Manager.
  'CCE_PAPERCLIP_IMAGE_DIGEST',
  'CCE_PAPERCLIP_BOOTSTRAP',
  // Private WARP access opt-in + hostname. Both change what synth produces
  // (cloudflared sidecar, Route 53 private zone, ALB ingress shape), so a
  // rollback that re-synths from this manifest must replay them or it would
  // silently drop the connector — or re-open world ingress. Neither is a
  // secret: a '1' flag and a private hostname. The Cloudflare connector token
  // is NOT here and must never be added; it lives only in Secrets Manager.
  'CCE_WARP_PRIVATE_ACCESS',
  'CCE_PUBLIC_ACCESS',
  'CCE_PUBLIC_HOSTNAME',
  'CCE_WARP_PRIVATE_HOSTNAME',
] as const;

/**
 * Pick the allowlisted synth inputs out of an env bag. Never a raw env dump;
 * keys outside SYNTH_INPUT_ALLOWLIST are dropped unconditionally.
 */
export function collectSynthInputs(
  env: Record<string, string | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of SYNTH_INPUT_ALLOWLIST) {
    const value = env[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

const REQUIRED_FIELDS = ['deployId', 'gitSha', 'imageTag', 'ecrRepo', 'stacks'] as const;

/**
 * Parse and validate a manifest read from the state bucket. Fails loud on
 * malformed JSON, on a schema-version mismatch (an old rollback tool must
 * never silently misread a newer manifest), and on missing required fields.
 */
export function parseManifest(json: string): DeployManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    throw new Error(
      `deploy manifest is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('deploy manifest must be a JSON object');
  }
  const m = raw as Record<string, unknown>;
  if (m.schemaVersion === undefined) {
    throw new Error('deploy manifest is missing "schemaVersion"; refusing to guess its format');
  }
  if (m.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    throw new Error(
      `manifest schema version ${String(m.schemaVersion)} is not supported by this tool ` +
        `(expected ${MANIFEST_SCHEMA_VERSION}); use the matching release`,
    );
  }
  for (const field of REQUIRED_FIELDS) {
    if (m[field] === undefined || m[field] === null || m[field] === '') {
      throw new Error(`deploy manifest is missing required field "${field}"`);
    }
  }
  if (!Array.isArray(m.stacks)) {
    throw new Error('deploy manifest field "stacks" must be an array of stack names');
  }
  return m as unknown as DeployManifest;
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(obj)
        .sort()
        .map((k) => [k, sortKeysDeep(obj[k])]),
    );
  }
  return value;
}

/**
 * Stable pretty JSON: keys sorted recursively so the same manifest always
 * serializes to the same bytes (diffable in S3 versions, hashable in CI).
 */
export function serializeManifest(m: DeployManifest): string {
  return JSON.stringify(sortKeysDeep(m), null, 2) + '\n';
}
