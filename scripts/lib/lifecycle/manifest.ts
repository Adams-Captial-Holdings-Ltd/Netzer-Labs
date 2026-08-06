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
