import { describe, it, expect } from 'vitest';
import {
  APP_SCHEMA_VERSION,
  collectSynthInputs,
  type DeployManifest,
  MANIFEST_SCHEMA_VERSION,
  parseManifest,
  serializeManifest,
  SYNTH_INPUT_ALLOWLIST,
} from './manifest.js';

function sampleManifest(): DeployManifest {
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    appSchemaVersion: APP_SCHEMA_VERSION,
    deployId: 'CCE-20260611123456-0123456789ab-d34d',
    gitSha: '0123456789abcdef0123456789abcdef01234567',
    cleanTree: true,
    account: '111122223333',
    region: 'us-east-1',
    tier: 1,
    mode: 'chat',
    featureFlags: { imageGen: false, tts: true },
    imageTag: 'CCE-20260611123456-0123456789ab-d34d',
    imageDigest: 'sha256:abc',
    ecrRepo: 'claudeclaw-orchestrator',
    images: [
      {
        taskFamily: 'orchestrator',
        containerName: 'app',
        repo: 'claudeclaw-orchestrator',
        digest: 'sha256:abc',
        platform: 'linux/arm64',
      },
    ],
    cdkVersion: '2.170.0',
    synthInputs: { AWS_REGION: 'us-east-1' },
    stacks: ['CCE-Network', 'CCE-Compute'],
    stackTemplateHashes: { 'CCE-Network': 'h1', 'CCE-Compute': 'h2' },
    secretVersions: [
      {
        secretId: 'cce/surfaces',
        versionId: 'v-2',
        label: 'CCE-20260611123456-0123456789ab-d34d',
        previousVersionId: 'v-1',
      },
    ],
    seedRevision: 'seed-7',
    cdkOutArchiveKey: 'deploys/CCE-20260611123456-0123456789ab-d34d/cdk.out.tgz',
    deployedAt: '2026-06-11T12:40:00.000Z',
  };
}

describe('serializeManifest / parseManifest round trip', () => {
  it('parse(serialize(m)) deep-equals m', () => {
    const m = sampleManifest();
    expect(parseManifest(serializeManifest(m))).toEqual(m);
  });

  it('serialization is stable regardless of key insertion order', () => {
    const m = sampleManifest();
    const shuffled = Object.fromEntries(Object.entries(m).reverse()) as unknown as DeployManifest;
    expect(serializeManifest(shuffled)).toBe(serializeManifest(m));
  });
});

describe('parseManifest validation', () => {
  it('fails loud on invalid JSON', () => {
    expect(() => parseManifest('{nope')).toThrow(/not valid JSON/);
  });

  it('fails loud on a missing schemaVersion', () => {
    const m = sampleManifest() as unknown as Record<string, unknown>;
    delete m.schemaVersion;
    expect(() => parseManifest(JSON.stringify(m))).toThrow(/missing "schemaVersion"/);
  });

  it('fails loud on an unknown/newer schemaVersion, naming both versions', () => {
    const m = { ...sampleManifest(), schemaVersion: 99 };
    expect(() => parseManifest(JSON.stringify(m))).toThrow(
      /schema version 99 is not supported by this tool \(expected 1\); use the matching release/,
    );
  });

  it.each(['deployId', 'gitSha', 'imageTag', 'ecrRepo', 'stacks'] as const)(
    'fails on missing required field %s',
    (field) => {
      const m = sampleManifest() as unknown as Record<string, unknown>;
      delete m[field];
      expect(() => parseManifest(JSON.stringify(m))).toThrow(
        new RegExp(`missing required field "${field}"`),
      );
    },
  );

  it('rejects a non-array stacks field', () => {
    const m = { ...sampleManifest(), stacks: 'CCE-Network' };
    expect(() => parseManifest(JSON.stringify(m))).toThrow(/"stacks" must be an array/);
  });
});

describe('collectSynthInputs', () => {
  it('picks only allowlisted keys; secrets never pass through', () => {
    const picked = collectSynthInputs({
      AWS_REGION: 'us-east-1',
      CCE_TIER: '1',
      SLACK_BOT_TOKEN: 'xoxb-secret',
      TELEGRAM_BOT_TOKEN: '12345:secret',
      TAVILY_API_KEY: 'tvly-secret',
      RANDOM_THING: 'x',
    });
    expect(picked).toEqual({ AWS_REGION: 'us-east-1', CCE_TIER: '1' });
    expect(JSON.stringify(picked)).not.toMatch(/secret/);
  });

  it('drops undefined values for allowlisted keys', () => {
    expect(collectSynthInputs({ AWS_REGION: undefined })).toEqual({});
  });

  it('the allowlist itself contains no token/secret-shaped keys', () => {
    for (const key of SYNTH_INPUT_ALLOWLIST) {
      expect(key).not.toMatch(/TOKEN|SECRET|PASSWORD|API_KEY/i);
    }
  });
});
