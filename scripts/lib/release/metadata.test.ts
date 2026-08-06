import { describe, expect, it } from 'vitest';
import {
  immutableMetadataHash,
  parseArtifactManifest,
  parseReleaseMetadata,
  RELEASE_METADATA_SCHEMA_VERSION,
  requiredActionsHash,
  serializeReleaseMetadata,
  type ReleaseMetadata,
} from './metadata.js';

const COMMIT = 'a'.repeat(40);

function baseMetadata(overrides: Partial<ReleaseMetadata> = {}): ReleaseMetadata {
  return {
    schemaVersion: RELEASE_METADATA_SCHEMA_VERSION,
    tag: 'v1.0.0',
    commit: COMMIT,
    appSchemaVersion: 1,
    bootstrapPrerequisites: { minNode: '20.0.0', minNpm: '10.0.0' },
    requiredActions: [
      {
        id: 'grant-titan',
        classification: 'manual-preflight',
        description: 'Grant Titan embeddings in the Bedrock console',
      },
    ],
    migrationFlags: { phases: ['expand'], maintenanceModePhases: [] },
    rollbackPosture: 'reversible',
    supportWindow: { directFrom: 'v0.9.0' },
    upgradingUrl: 'https://example.com/UPGRADING',
    images: [{ platform: 'linux/arm64', digest: `sha256:${'b'.repeat(64)}`, publicRepo: 'public.ecr.aws/x/y' }],
    artifactManifestKey: 'artifact-manifest.json',
    ...overrides,
  };
}

describe('parseReleaseMetadata', () => {
  it('round-trips serialize -> parse with no warnings', () => {
    const m = baseMetadata();
    const { metadata, warnings } = parseReleaseMetadata(serializeReleaseMetadata(m));
    expect(metadata).toEqual(m);
    expect(warnings).toEqual([]);
  });

  it('fails loud on missing schemaVersion', () => {
    const raw = JSON.parse(serializeReleaseMetadata(baseMetadata())) as Record<string, unknown>;
    delete raw.schemaVersion;
    expect(() => parseReleaseMetadata(JSON.stringify(raw))).toThrow(/schemaVersion/);
  });

  it('fails loud on invalid schemaVersion shapes', () => {
    for (const bad of ['1', 0, -2, 1.5, null]) {
      const raw = JSON.parse(serializeReleaseMetadata(baseMetadata())) as Record<string, unknown>;
      raw.schemaVersion = bad;
      expect(() => parseReleaseMetadata(JSON.stringify(raw))).toThrow(/schemaVersion/i);
    }
  });

  it('fails loud on non-JSON and non-object input', () => {
    expect(() => parseReleaseMetadata('not json')).toThrow(/not valid JSON/);
    expect(() => parseReleaseMetadata('[1,2]')).toThrow(/JSON object/);
  });

  it('hard-requires only the updater-critical core (commit, prereqs, images)', () => {
    for (const field of ['commit', 'bootstrapPrerequisites', 'images']) {
      const raw = JSON.parse(serializeReleaseMetadata(baseMetadata())) as Record<string, unknown>;
      delete raw[field];
      expect(() => parseReleaseMetadata(JSON.stringify(raw))).toThrow(new RegExp(field));
    }
  });

  it('an OLD parser tolerates NEWER metadata: unknown fields + newer schemaVersion', () => {
    // Simulate "tomorrow's" metadata: bumped schema, brand-new fields, a new
    // requiredAction classification this code has never heard of.
    const raw = JSON.parse(serializeReleaseMetadata(baseMetadata())) as Record<string, unknown>;
    raw.schemaVersion = RELEASE_METADATA_SCHEMA_VERSION + 5;
    raw.shinyNewTopLevelField = { nested: true };
    (raw.bootstrapPrerequisites as Record<string, unknown>).minDocker = '28.0';
    raw.requiredActions = [
      {
        id: 'future-action',
        classification: 'hologram-signoff',
        description: 'a class invented in 2031',
      },
    ];
    raw.rollbackPosture = 'time-travel';

    const { metadata, warnings } = parseReleaseMetadata(JSON.stringify(raw));
    // Core survives: enough to verify, gate prerequisites, and exec the target.
    expect(metadata.commit).toBe(COMMIT);
    expect(metadata.bootstrapPrerequisites.minNode).toBe('20.0.0');
    expect(metadata.images).toHaveLength(1);
    // Unknown classification fails SAFE to the most restrictive class.
    expect(metadata.requiredActions[0].classification).toBe('approval-required');
    // Unknown posture fails SAFE to the most conservative class.
    expect(metadata.rollbackPosture).toBe('restore-plan-required');
    expect(warnings.some((w) => w.includes('newer than this tool'))).toBe(true);
  });

  it('defaults tolerated fields with warnings instead of failing', () => {
    const minimal = {
      schemaVersion: 1,
      commit: COMMIT,
      bootstrapPrerequisites: { minNode: '20.0.0', minNpm: '' },
      images: [],
    };
    const { metadata, warnings } = parseReleaseMetadata(JSON.stringify(minimal));
    expect(metadata.requiredActions).toEqual([]);
    expect(metadata.migrationFlags).toEqual({ phases: [], maintenanceModePhases: [] });
    expect(metadata.rollbackPosture).toBe('restore-plan-required');
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('rejects images without sha256 digests', () => {
    const raw = JSON.parse(serializeReleaseMetadata(baseMetadata())) as Record<string, unknown>;
    raw.images = [{ platform: 'linux/arm64', digest: 'latest', publicRepo: 'x' }];
    expect(() => parseReleaseMetadata(JSON.stringify(raw))).toThrow(/sha256/);
  });
});

describe('immutableMetadataHash', () => {
  it('EXCLUDES the channel tag: rc and final metadata hash identically', () => {
    const rc = baseMetadata({ tag: 'rc/v1.0.0' });
    const final = baseMetadata({ tag: 'v1.0.0' });
    expect(immutableMetadataHash(rc)).toBe(immutableMetadataHash(final));
  });

  it('changes when immutable content changes', () => {
    const a = baseMetadata();
    const b = baseMetadata({ commit: 'b'.repeat(40) });
    expect(immutableMetadataHash(a)).not.toBe(immutableMetadataHash(b));
  });
});

describe('requiredActionsHash', () => {
  it('is order-insensitive (canonicalized by id)', () => {
    const actions = [
      { id: 'b', classification: 'automatic' as const, description: 'two' },
      { id: 'a', classification: 'manual-preflight' as const, description: 'one' },
    ];
    const m1 = baseMetadata({ requiredActions: actions });
    const m2 = baseMetadata({ requiredActions: [...actions].reverse() });
    expect(requiredActionsHash(m1)).toBe(requiredActionsHash(m2));
  });

  it('changes when an action changes (approval replay protection)', () => {
    const m1 = baseMetadata();
    const m2 = baseMetadata({
      requiredActions: [
        { id: 'grant-titan', classification: 'approval-required', description: 'changed' },
      ],
    });
    expect(requiredActionsHash(m1)).not.toBe(requiredActionsHash(m2));
  });
});

describe('parseArtifactManifest', () => {
  it('parses and tolerates extra fields', () => {
    const manifest = {
      schemaVersion: 1,
      tag: 'v1.0.0',
      commit: COMMIT,
      images: [{ platform: 'linux/arm64', digest: `sha256:${'c'.repeat(64)}`, publicRepo: 'r' }],
      provenance: 'ci-run-1',
      futureField: 42,
    };
    const parsed = parseArtifactManifest(JSON.stringify(manifest));
    expect(parsed.commit).toBe(COMMIT);
    expect(parsed.images).toHaveLength(1);
  });

  it('fails loud on missing schemaVersion', () => {
    expect(() => parseArtifactManifest(JSON.stringify({ commit: COMMIT, images: [] }))).toThrow(
      /schemaVersion/,
    );
  });
});
