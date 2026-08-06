/**
 * Signed machine-readable release metadata (IaC readiness plan, item 44).
 *
 * Every release ships a metadata.json that the dashboard, the update
 * discovery banner, and the UPDATER SHIM consume — tooling never parses
 * release-note prose. The contract has two halves with different rigor:
 *
 *  - the SIGNATURE-RELEVANT CORE (schemaVersion, commit, image digests,
 *    bootstrapPrerequisites) is hard-required by the parser, because the
 *    shim cannot verify or gate anything without it;
 *  - everything else is tolerated loosely WITH DEFAULTS, and unknown EXTRA
 *    fields are always accepted, because item 49's updater-critical-formats
 *    rule says an OLD shim must parse NEW metadata well enough to upgrade.
 *    A year-old install's shim reading tomorrow's metadata must get far
 *    enough to verify the signature, check prerequisites, and exec the
 *    target runner; the target's own (new) code handles the new fields.
 *
 * Schema-version handling is therefore asymmetric on purpose:
 *  - missing/invalid schemaVersion: LOUD hard error (refuse to guess);
 *  - schemaVersion NEWER than this tool knows: parse the core, surface a
 *    warning — never a hard failure, or old shims could never upgrade past
 *    the release that bumped the schema;
 *  - schemaVersion older than 1 cannot exist (1 is the first).
 *
 * The channel tag (`tag`) is metadata for humans and for artifact addressing;
 * it is EXCLUDED from the immutable hash (see immutableMetadataHash) so the
 * rc and the promoted final release share one signature (item 44: the
 * signature covers immutable content, never the channel tag).
 */

import { createHash } from 'node:crypto';

/** Version of THIS metadata format. Bumps follow item 49's warn-then-remove rules. */
export const RELEASE_METADATA_SCHEMA_VERSION = 1;

/** Version of the release artifact manifest format (item 41). */
export const ARTIFACT_MANIFEST_SCHEMA_VERSION = 1;

export type RequiredActionClassification =
  | 'automatic'
  | 'manual-preflight'
  | 'approval-required';

export interface RequiredAction {
  id: string;
  classification: RequiredActionClassification;
  description: string;
  docsUrl?: string;
}

export type MigrationPhaseName = 'expand' | 'backfill' | 'contract';

export type RollbackPosture = 'reversible' | 'forward-only' | 'restore-plan-required';

/** One published image: per-platform digest in the public distribution repo. */
export interface ReleaseImage {
  platform: string;
  digest: string;
  publicRepo: string;
}

export interface ReleaseMetadata {
  schemaVersion: number;
  /** Channel tag (v1.2.3 or rc/v1.2.3). NEVER part of the signed content. */
  tag: string;
  commit: string;
  /** Application schema version (item 18); rollback preflight reads it. */
  appSchemaVersion: number;
  /** Checked by the OLD shim BEFORE any target code executes (item 42). */
  bootstrapPrerequisites: { minNode: string; minNpm: string };
  requiredActions: RequiredAction[];
  migrationFlags: {
    phases: MigrationPhaseName[];
    /** Which migration phases need maintenance mode (workers stopped, queues paused). */
    maintenanceModePhases: string[];
  };
  rollbackPosture: RollbackPosture;
  /** Oldest release this one supports a DIRECT (single-hop) upgrade from. */
  supportWindow: { directFrom: string };
  /** Human UPGRADING notes; tooling links it, never parses it. */
  upgradingUrl: string;
  images: ReleaseImage[];
  /** Release-asset key of the artifact manifest (item 41). */
  artifactManifestKey: string;
}

/**
 * The release artifact manifest (item 41): tag → commit → per-platform
 * digests → provenance. The signature artifact covers the same digests, so
 * a tampered manifest fails cross-checking in the shim.
 */
export interface ArtifactManifest {
  schemaVersion: number;
  tag: string;
  commit: string;
  images: ReleaseImage[];
  /** Builder identity / workflow run URL; included in the signed payload. */
  provenance: string;
}

export interface ParsedReleaseMetadata {
  metadata: ReleaseMetadata;
  /**
   * Non-fatal compatibility notes: newer schema version, defaulted optional
   * fields. Callers surface these; they never abort an upgrade.
   */
  warnings: string[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function parseJsonObject(json: string, what: string): Record<string, unknown> {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    throw new Error(
      `${what} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!isRecord(raw)) throw new Error(`${what} must be a JSON object`);
  return raw;
}

function requireSchemaVersion(
  m: Record<string, unknown>,
  what: string,
  knownVersion: number,
  warnings: string[],
): number {
  const sv = m.schemaVersion;
  if (sv === undefined || sv === null) {
    throw new Error(`${what} is missing "schemaVersion"; refusing to guess its format`);
  }
  if (typeof sv !== 'number' || !Number.isInteger(sv) || sv < 1) {
    throw new Error(
      `${what} has invalid schemaVersion ${JSON.stringify(sv)} (need an integer >= 1)`,
    );
  }
  if (sv > knownVersion) {
    // Item 49: an OLD shim must keep parsing NEWER metadata well enough to
    // upgrade. The hard-required core below is the forever-stable subset.
    warnings.push(
      `${what} schemaVersion ${sv} is newer than this tool understands (${knownVersion}); ` +
        'parsing the stable core only — fields added by newer schemas are ignored here ' +
        'and handled by the target release itself',
    );
  }
  return sv;
}

function requireNonEmptyString(
  m: Record<string, unknown>,
  field: string,
  what: string,
): string {
  const v = m[field];
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`${what} is missing required field "${field}" (non-empty string)`);
  }
  return v;
}

const VALID_CLASSIFICATIONS: ReadonlySet<string> = new Set([
  'automatic',
  'manual-preflight',
  'approval-required',
]);

function parseImages(raw: unknown, what: string): ReleaseImage[] {
  if (!Array.isArray(raw)) {
    throw new Error(`${what} is missing required field "images" (array of platform/digest)`);
  }
  return raw.map((img, i) => {
    if (!isRecord(img)) throw new Error(`${what} images[${i}] must be an object`);
    const platform = img.platform;
    const digest = img.digest;
    const publicRepo = img.publicRepo;
    if (typeof platform !== 'string' || typeof digest !== 'string' || !digest.startsWith('sha256:')) {
      throw new Error(
        `${what} images[${i}] needs string "platform" and a "digest" starting with sha256:`,
      );
    }
    return {
      platform,
      digest,
      publicRepo: typeof publicRepo === 'string' ? publicRepo : '',
    };
  });
}

/**
 * Parse release metadata. Hard-requires ONLY the signature-relevant core an
 * old shim cannot do without (schemaVersion, commit, bootstrapPrerequisites,
 * images). Everything else gets a tolerated default plus a warning, and
 * unknown extra fields are silently accepted — both required so an old shim
 * can parse new metadata (item 49).
 */
export function parseReleaseMetadata(json: string): ParsedReleaseMetadata {
  const what = 'release metadata';
  const m = parseJsonObject(json, what);
  const warnings: string[] = [];

  const schemaVersion = requireSchemaVersion(
    m,
    what,
    RELEASE_METADATA_SCHEMA_VERSION,
    warnings,
  );
  const commit = requireNonEmptyString(m, 'commit', what);

  // bootstrapPrerequisites is updater-critical: the OLD shim gates on it
  // BEFORE any target code executes, so it is part of the hard core.
  const prereqsRaw = m.bootstrapPrerequisites;
  if (!isRecord(prereqsRaw)) {
    throw new Error(
      `${what} is missing required field "bootstrapPrerequisites" ({ minNode, minNpm }); ` +
        'the shim cannot gate Node/npm versions without it',
    );
  }
  const minNode = prereqsRaw.minNode;
  const minNpm = prereqsRaw.minNpm;
  if (typeof minNode !== 'string' || minNode.length === 0 || typeof minNpm !== 'string') {
    throw new Error(
      `${what} bootstrapPrerequisites needs string "minNode" and "minNpm" fields`,
    );
  }

  const images = parseImages(m.images, what);

  // ── Tolerated (defaulted) fields below: never a hard failure ──
  const tag = typeof m.tag === 'string' ? m.tag : '';
  if (!tag) warnings.push(`${what} has no "tag"; the channel tag is unknown (cosmetic only)`);

  const appSchemaVersion =
    typeof m.appSchemaVersion === 'number' && Number.isInteger(m.appSchemaVersion)
      ? m.appSchemaVersion
      : 0;
  if (appSchemaVersion === 0) {
    warnings.push(`${what} has no "appSchemaVersion"; schema-boundary checks degrade to unknown`);
  }

  const requiredActions: RequiredAction[] = [];
  if (Array.isArray(m.requiredActions)) {
    for (const [i, a] of m.requiredActions.entries()) {
      if (!isRecord(a) || typeof a.id !== 'string' || typeof a.description !== 'string') {
        warnings.push(`${what} requiredActions[${i}] is malformed; treating as approval-required`);
        continue;
      }
      const cls =
        typeof a.classification === 'string' && VALID_CLASSIFICATIONS.has(a.classification)
          ? (a.classification as RequiredActionClassification)
          : // Unknown classification (a future schema may add one): fail SAFE
            // by treating it as the most restrictive class we know.
            'approval-required';
      if (cls !== a.classification) {
        warnings.push(
          `${what} requiredActions[${i}] has unknown classification ` +
            `${JSON.stringify(a.classification)}; treating as approval-required`,
        );
      }
      requiredActions.push({
        id: a.id,
        classification: cls,
        description: a.description,
        ...(typeof a.docsUrl === 'string' ? { docsUrl: a.docsUrl } : {}),
      });
    }
  } else if (m.requiredActions !== undefined) {
    warnings.push(`${what} "requiredActions" is not an array; treating as empty`);
  }

  const mfRaw = isRecord(m.migrationFlags) ? m.migrationFlags : {};
  const phases = Array.isArray(mfRaw.phases)
    ? mfRaw.phases.filter(
        (p): p is MigrationPhaseName => p === 'expand' || p === 'backfill' || p === 'contract',
      )
    : [];
  const maintenanceModePhases = Array.isArray(mfRaw.maintenanceModePhases)
    ? mfRaw.maintenanceModePhases.filter((p): p is string => typeof p === 'string')
    : [];

  let rollbackPosture: RollbackPosture;
  if (
    m.rollbackPosture === 'reversible' ||
    m.rollbackPosture === 'forward-only' ||
    m.rollbackPosture === 'restore-plan-required'
  ) {
    rollbackPosture = m.rollbackPosture;
  } else {
    // Unknown/missing posture: assume the most conservative class so a
    // rollback never proceeds on a guess.
    rollbackPosture = 'restore-plan-required';
    warnings.push(
      `${what} has unknown rollbackPosture ${JSON.stringify(m.rollbackPosture)}; ` +
        'assuming restore-plan-required (most conservative)',
    );
  }

  const swRaw = isRecord(m.supportWindow) ? m.supportWindow : {};
  const supportWindow = {
    directFrom: typeof swRaw.directFrom === 'string' ? swRaw.directFrom : '',
  };

  const upgradingUrl = typeof m.upgradingUrl === 'string' ? m.upgradingUrl : '';
  const artifactManifestKey =
    typeof m.artifactManifestKey === 'string' ? m.artifactManifestKey : '';
  if (!artifactManifestKey) {
    warnings.push(`${what} has no "artifactManifestKey"; using the conventional asset name`);
  }

  return {
    metadata: {
      schemaVersion,
      tag,
      commit,
      appSchemaVersion,
      bootstrapPrerequisites: { minNode, minNpm },
      requiredActions,
      migrationFlags: { phases, maintenanceModePhases },
      rollbackPosture,
      supportWindow,
      upgradingUrl,
      images,
      artifactManifestKey,
    },
    warnings,
  };
}

/** Parse the artifact manifest with the same tolerance rules (item 49). */
export function parseArtifactManifest(json: string): ArtifactManifest {
  const what = 'artifact manifest';
  const m = parseJsonObject(json, what);
  const warnings: string[] = [];
  const schemaVersion = requireSchemaVersion(
    m,
    what,
    ARTIFACT_MANIFEST_SCHEMA_VERSION,
    warnings,
  );
  const commit = requireNonEmptyString(m, 'commit', what);
  const images = parseImages(m.images, what);
  return {
    schemaVersion,
    tag: typeof m.tag === 'string' ? m.tag : '',
    commit,
    images,
    provenance: typeof m.provenance === 'string' ? m.provenance : '',
  };
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, sortKeysDeep(value[k])]),
    );
  }
  return value;
}

/** Stable pretty JSON (sorted keys), same bytes for the same content. */
export function serializeReleaseMetadata(m: ReleaseMetadata): string {
  return JSON.stringify(sortKeysDeep(m), null, 2) + '\n';
}

/** Stable pretty JSON for the artifact manifest. */
export function serializeArtifactManifest(m: ArtifactManifest): string {
  return JSON.stringify(sortKeysDeep(m), null, 2) + '\n';
}

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Hash of the metadata's IMMUTABLE content: canonical sorted-key JSON with
 * the channel `tag` REMOVED. This is the `metadataHash` inside the signed
 * payload — and the reason an rc and its promoted final share one signature:
 * promotion only changes the tag, and the tag is excluded by construction.
 */
export function immutableMetadataHash(m: ReleaseMetadata): string {
  const { tag: _tag, ...rest } = m;
  return sha256Hex(JSON.stringify(sortKeysDeep(rest)));
}

/**
 * sha256 over the CANONICALIZED requiredActions: sorted by id, sorted keys.
 * The dogfooding approval artifact (item 47) binds to this hash, so an
 * approval cannot be replayed against a release whose required actions
 * changed — even if the version string stayed the same (rc respins).
 */
export function requiredActionsHash(m: ReleaseMetadata): string {
  const canonical = [...m.requiredActions]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((a) => sortKeysDeep(a));
  return sha256Hex(JSON.stringify(canonical));
}
