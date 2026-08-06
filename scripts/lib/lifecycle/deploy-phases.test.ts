import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildImageRecords,
  extractGuardrailOutputs,
  hashStackTemplates,
  imageInspectHasArm64,
  imageJsonHasArm64,
  KEEP_DEPLOY_LABELS,
  planSecretWrites,
  populateSecretsV2,
  pruneDeployLabels,
  recoveryCommand,
  resolveRuntimeConfigTable,
  SecretWriteFailure,
  seedRevisionOf,
  sha256Hex,
  XRAY_SIDECAR_DIGEST_FALLBACK,
  XRAY_SIDECAR_REPO,
  xrayDigestFromComputeStackSource,
} from './deploy-phases.js';
import { newDeployId } from './ids.js';
import { collectSynthInputs } from './manifest.js';

const GIT_SHA = '0123456789abcdef0123456789abcdef01234567';
const DEPLOY_ID = newDeployId(GIT_SHA, new Date('2026-06-11T12:00:00Z'));
const GUARDRAILS = { guardrailId: 'gr-123', guardrailVersion: 'DRAFT' };
const REGION = 'us-east-1';

// ─────────────────────────────────────────────────────────────────────
// Fake Secrets Manager
// ─────────────────────────────────────────────────────────────────────

interface FakeSecretState {
  /** versionId → staging labels */
  versions: Map<string, string[]>;
}

interface FakeOptions {
  /** secretIds whose PutSecretValue throws. */
  failPutFor?: Set<string>;
  /** secretIds whose DescribeSecret throws (generic error). */
  failDescribeFor?: Set<string>;
}

function fakeSecretsClient(secretIds: string[], opts: FakeOptions = {}) {
  const secrets = new Map<string, FakeSecretState>(
    secretIds.map((id) => [id, { versions: new Map() }]),
  );
  const removedStages: Array<{ secretId: string; stage: string; versionId: string }> = [];
  let putCount = 0;

  const client = {
    secrets,
    removedStages,
    async send(cmd: { constructor: { name: string }; input?: Record<string, unknown> }) {
      const name = cmd.constructor.name;
      const input = (cmd as { input: Record<string, unknown> }).input;
      const secretId = String(input.SecretId);
      if (name === 'DescribeSecretCommand') {
        if (opts.failDescribeFor?.has(secretId)) {
          throw new Error(`AccessDeniedException: describe denied for ${secretId}`);
        }
        const s = secrets.get(secretId);
        if (!s) {
          const err = new Error(`Secrets Manager can't find the specified secret. (${secretId})`);
          err.name = 'ResourceNotFoundException';
          throw err;
        }
        return {
          VersionIdsToStages: Object.fromEntries(
            [...s.versions].map(([v, stages]) => [v, [...stages]]),
          ),
        };
      }
      if (name === 'PutSecretValueCommand') {
        if (opts.failPutFor?.has(secretId)) {
          throw new Error(`AccessDeniedException: put denied for ${secretId}`);
        }
        const s = secrets.get(secretId);
        if (!s) throw new Error(`unknown secret ${secretId}`);
        const newVersionId = `v-new-${++putCount}`;
        // Move AWSCURRENT off prior versions, the way the real service does.
        for (const [vid, stages] of s.versions) {
          const idx = stages.indexOf('AWSCURRENT');
          if (idx >= 0) {
            stages.splice(idx, 1);
            stages.push('AWSPREVIOUS');
            s.versions.set(vid, stages);
          }
        }
        s.versions.set(newVersionId, [...(input.VersionStages as string[])]);
        return { VersionId: newVersionId };
      }
      if (name === 'UpdateSecretVersionStageCommand') {
        const s = secrets.get(secretId);
        if (!s) throw new Error(`unknown secret ${secretId}`);
        const versionId = String(input.RemoveFromVersionId);
        const stage = String(input.VersionStage);
        const stages = s.versions.get(versionId);
        if (!stages || !stages.includes(stage)) {
          throw new Error(`stage ${stage} not on version ${versionId}`);
        }
        s.versions.set(versionId, stages.filter((st) => st !== stage));
        removedStages.push({ secretId, stage, versionId });
        return {};
      }
      throw new Error(`fake client: unexpected command ${name}`);
    },
  };
  return client;
}

const BASE = '/claudeclaw';
const ALL_SECRET_IDS = [
  `${BASE}/slack`,
  `${BASE}/telegram`,
  `${BASE}/dashboard`,
  `${BASE}/db-encryption`,
  `${BASE}/vendor-keys`,
  `${BASE}/bedrock-guardrails`,
];

const MINIMAL_ENV: Record<string, string> = {
  DASHBOARD_TOKEN: 'dash-token',
  APP_ENCRYPTION_KEY: 'aabbccdd',
};

// ─────────────────────────────────────────────────────────────────────
// planSecretWrites
// ─────────────────────────────────────────────────────────────────────

describe('planSecretWrites', () => {
  it('always plans dashboard + bedrock-guardrails as configured', () => {
    const plans = planSecretWrites({}, BASE, GUARDRAILS);
    const leaves = plans.map((p) => p.leaf);
    expect(leaves).toContain('dashboard');
    expect(leaves).toContain('bedrock-guardrails');
    for (const leaf of ['dashboard', 'bedrock-guardrails']) {
      expect(plans.find((p) => p.leaf === leaf)?.configured).toBe(true);
    }
  });

  it('slack is configured only when SLACK_BOT_TOKEN is set', () => {
    const withToken = planSecretWrites({ SLACK_BOT_TOKEN: 'xoxb-1' }, BASE, GUARDRAILS);
    expect(withToken.find((p) => p.leaf === 'slack')?.configured).toBe(true);
    // Signing secret alone: the secret is written but NOT a configured surface.
    const signingOnly = planSecretWrites({ SLACK_SIGNING_SECRET: 's' }, BASE, GUARDRAILS);
    expect(signingOnly.find((p) => p.leaf === 'slack')?.configured).toBe(false);
  });

  it('telegram is configured only when TELEGRAM_TOKENS_JSON is set', () => {
    const plans = planSecretWrites(
      { TELEGRAM_TOKENS_JSON: '{"main":"t"}' },
      BASE,
      GUARDRAILS,
    );
    expect(plans.find((p) => p.leaf === 'telegram')?.configured).toBe(true);
  });

  it('vendor-keys is never configured (failures stay warnings)', () => {
    const plans = planSecretWrites({ TAVILY_API_KEY: 'k' }, BASE, GUARDRAILS);
    expect(plans.find((p) => p.leaf === 'vendor-keys')?.configured).toBe(false);
  });

  it('guardrails secret value carries the stack-output id/version', () => {
    const plans = planSecretWrites({}, BASE, GUARDRAILS);
    const value = JSON.parse(plans.find((p) => p.leaf === 'bedrock-guardrails')!.value);
    expect(value).toEqual({ guardrail_id: 'gr-123', guardrail_version: 'DRAFT' });
  });
});

// ─────────────────────────────────────────────────────────────────────
// populateSecretsV2
// ─────────────────────────────────────────────────────────────────────

describe('populateSecretsV2', () => {
  it('a configured-surface write failure is fatal with the exact recovery command', async () => {
    const client = fakeSecretsClient(ALL_SECRET_IDS, {
      failPutFor: new Set([`${BASE}/dashboard`]),
    });
    let caught: unknown;
    try {
      await populateSecretsV2({
        client,
        env: MINIMAL_ENV,
        secretBase: BASE,
        deployId: DEPLOY_ID,
        region: REGION,
        guardrails: GUARDRAILS,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SecretWriteFailure);
    const failure = caught as SecretWriteFailure;
    expect(failure.secretId).toBe(`${BASE}/dashboard`);
    expect(failure.recovery).toContain(
      `aws secretsmanager put-secret-value --secret-id ${BASE}/dashboard`,
    );
    expect(failure.recovery).toContain(`--region ${REGION}`);
    // Recovery commands carry the placeholder SHAPE, never real values.
    expect(failure.recovery).not.toContain('dash-token');
  });

  it('an unconfigured-surface write failure stays a warning and the deploy continues', async () => {
    const client = fakeSecretsClient(ALL_SECRET_IDS, {
      failPutFor: new Set([`${BASE}/vendor-keys`]),
    });
    const result = await populateSecretsV2({
      client,
      env: { ...MINIMAL_ENV, TAVILY_API_KEY: 'tv-key' },
      secretBase: BASE,
      deployId: DEPLOY_ID,
      region: REGION,
      guardrails: GUARDRAILS,
    });
    expect(result.warnings.some((w) => w.includes(`${BASE}/vendor-keys`))).toBe(true);
    // The configured secrets all wrote fine.
    const ids = result.records.map((r) => r.secretId);
    expect(ids).toContain(`${BASE}/dashboard`);
    expect(ids).toContain(`${BASE}/bedrock-guardrails`);
    expect(ids).not.toContain(`${BASE}/vendor-keys`);
  });

  it('FAILS when the deploy label already exists on a secret (never silently move a label)', async () => {
    const client = fakeSecretsClient(ALL_SECRET_IDS);
    client.secrets
      .get(`${BASE}/dashboard`)!
      .versions.set('v-old', ['AWSCURRENT', DEPLOY_ID]);
    await expect(
      populateSecretsV2({
        client,
        env: MINIMAL_ENV,
        secretBase: BASE,
        deployId: DEPLOY_ID,
        region: REGION,
        guardrails: GUARDRAILS,
      }),
    ).rejects.toThrow(/ALREADY exists/);
  });

  it('captures version records: new VersionId, deploy label, previous AWSCURRENT', async () => {
    const client = fakeSecretsClient(ALL_SECRET_IDS);
    client.secrets
      .get(`${BASE}/dashboard`)!
      .versions.set('v-prior', ['AWSCURRENT']);
    const result = await populateSecretsV2({
      client,
      env: MINIMAL_ENV,
      secretBase: BASE,
      deployId: DEPLOY_ID,
      region: REGION,
      guardrails: GUARDRAILS,
    });
    const dashboard = result.records.find((r) => r.secretId === `${BASE}/dashboard`)!;
    expect(dashboard.versionId).toMatch(/^v-new-/);
    expect(dashboard.label).toBe(DEPLOY_ID);
    expect(dashboard.previousVersionId).toBe('v-prior');
    // A secret with no prior AWSCURRENT records no previousVersionId.
    const guardrails = result.records.find((r) => r.secretId === `${BASE}/bedrock-guardrails`)!;
    expect(guardrails.previousVersionId).toBeUndefined();
  });

  it('prunes only old CCE-* deploy labels, keeping the most recent 10 and AWS stages', async () => {
    const client = fakeSecretsClient(ALL_SECRET_IDS);
    const dashboard = client.secrets.get(`${BASE}/dashboard`)!;
    // 12 historical deploy labels (timestamps sort lexicographically) plus
    // AWS-managed stages and a non-deploy custom stage.
    for (let i = 1; i <= 12; i++) {
      const ts = `202501010000${String(i).padStart(2, '0')}`;
      dashboard.versions.set(`v-old-${i}`, [`CCE-${ts}-aaaaaaaaaaaa-000${i % 10}`]);
    }
    dashboard.versions.set('v-current', ['AWSCURRENT', 'my-custom-stage']);

    const result = await populateSecretsV2({
      client,
      env: MINIMAL_ENV,
      secretBase: BASE,
      deployId: DEPLOY_ID,
      region: REGION,
      guardrails: GUARDRAILS,
    });

    // After the new write there are 13 deploy labels; keep 10 → remove 3 oldest.
    const removed = client.removedStages.filter((r) => r.secretId === `${BASE}/dashboard`);
    expect(removed.map((r) => r.versionId).sort()).toEqual(['v-old-1', 'v-old-2', 'v-old-3']);
    for (const r of removed) {
      expect(r.stage.startsWith('CCE-')).toBe(true);
    }
    // AWS-managed and custom stages are untouched.
    expect(dashboard.versions.get('v-current')).toContain('my-custom-stage');
    // The fresh label is among the keepers.
    expect(result.pruned[`${BASE}/dashboard`]).toHaveLength(3);
  });

  it('pruneDeployLabels keeps everything when under the limit', async () => {
    const client = fakeSecretsClient([`${BASE}/dashboard`]);
    const s = client.secrets.get(`${BASE}/dashboard`)!;
    s.versions.set('v-1', ['CCE-20250101000001-aaaaaaaaaaaa-0001', 'AWSPREVIOUS']);
    s.versions.set('v-2', ['AWSCURRENT']);
    const removed = await pruneDeployLabels(client, `${BASE}/dashboard`, KEEP_DEPLOY_LABELS);
    expect(removed).toEqual([]);
    expect(client.removedStages).toEqual([]);
  });

  it('describe failure on a configured secret is fatal; on unconfigured it warns', async () => {
    const fatal = fakeSecretsClient(ALL_SECRET_IDS, {
      failDescribeFor: new Set([`${BASE}/bedrock-guardrails`]),
    });
    await expect(
      populateSecretsV2({
        client: fatal,
        env: MINIMAL_ENV,
        secretBase: BASE,
        deployId: DEPLOY_ID,
        region: REGION,
        guardrails: GUARDRAILS,
      }),
    ).rejects.toThrow(SecretWriteFailure);

    const warning = fakeSecretsClient(ALL_SECRET_IDS, {
      failDescribeFor: new Set([`${BASE}/vendor-keys`]),
    });
    const result = await populateSecretsV2({
      client: warning,
      env: { ...MINIMAL_ENV, TAVILY_API_KEY: 'k' },
      secretBase: BASE,
      deployId: DEPLOY_ID,
      region: REGION,
      guardrails: GUARDRAILS,
    });
    expect(result.warnings.some((w) => w.includes(`${BASE}/vendor-keys`))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────
// recoveryCommand
// ─────────────────────────────────────────────────────────────────────

describe('recoveryCommand', () => {
  it('builds the exact put-secret-value command with placeholder values', () => {
    const plan = planSecretWrites(MINIMAL_ENV, BASE, GUARDRAILS).find(
      (p) => p.leaf === 'dashboard',
    )!;
    const cmd = recoveryCommand(plan, REGION);
    expect(cmd).toBe(
      `aws secretsmanager put-secret-value --secret-id ${BASE}/dashboard ` +
        `--secret-string '${plan.placeholderShape}' --region ${REGION}`,
    );
    expect(cmd).toContain('<dashboard-token>');
  });
});

// ─────────────────────────────────────────────────────────────────────
// Guardrail outputs extraction
// ─────────────────────────────────────────────────────────────────────

describe('extractGuardrailOutputs', () => {
  it('finds the Guardrails stack and reads both outputs', () => {
    const outputs = {
      'CCE-Network': { VpcId: 'vpc-1' },
      'CCE-Guardrails': { GuardrailId: 'gr-9', GuardrailVersion: '2' },
    };
    expect(extractGuardrailOutputs(outputs)).toEqual({
      guardrailId: 'gr-9',
      guardrailVersion: '2',
    });
  });

  it('throws when no Guardrails stack is in the outputs', () => {
    expect(() => extractGuardrailOutputs({ 'CCE-Network': {} })).toThrow(/no Guardrails stack/);
  });

  it('throws when an output key is missing', () => {
    expect(() =>
      extractGuardrailOutputs({ 'CCE-Guardrails': { GuardrailId: 'gr-9' } }),
    ).toThrow(/GuardrailId\/GuardrailVersion/);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Manifest assembly helpers
// ─────────────────────────────────────────────────────────────────────

describe('hashStackTemplates', () => {
  let dir: string;
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('hashes every *.template.json by stack name and ignores other files', () => {
    dir = mkdtempSync(join(tmpdir(), 'cce-cdkout-'));
    writeFileSync(join(dir, 'CCE-Network.template.json'), '{"Resources":{"A":1}}');
    writeFileSync(join(dir, 'CCE-Storage.template.json'), '{"Resources":{"B":2}}');
    writeFileSync(join(dir, 'manifest.json'), '{"version":"36.0.0"}');
    writeFileSync(join(dir, 'CCE-Network.assets.json'), '{}');
    const hashes = hashStackTemplates(dir);
    expect(Object.keys(hashes).sort()).toEqual(['CCE-Network', 'CCE-Storage']);
    expect(hashes['CCE-Network']).toBe(sha256Hex('{"Resources":{"A":1}}'));
    expect(hashes['CCE-Network']).toMatch(/^[0-9a-f]{64}$/);
    // Different content → different hash.
    expect(hashes['CCE-Network']).not.toBe(hashes['CCE-Storage']);
  });
});

describe('collectSynthInputs allowlisting', () => {
  it('keeps only allowlisted keys and drops secrets/tokens unconditionally', () => {
    const out = collectSynthInputs({
      AWS_REGION: 'us-east-1',
      CDK_STACK_NAME: 'CCE',
      DOMAIN_NAME: 'cce.example.com',
      SLACK_BOT_TOKEN: 'xoxb-secret',
      TELEGRAM_TOKENS_JSON: '{"main":"123:abc"}',
      DASHBOARD_TOKEN: 'token',
      APP_ENCRYPTION_KEY: 'key',
      RANDOM_KEY: 'nope',
    });
    expect(out).toEqual({
      AWS_REGION: 'us-east-1',
      CDK_STACK_NAME: 'CCE',
      DOMAIN_NAME: 'cce.example.com',
    });
    expect(JSON.stringify(out)).not.toContain('xoxb-secret');
  });
});

describe('seedRevisionOf', () => {
  it('is stable for identical rows and changes when a value changes', () => {
    const rows = [{ category: 'cost', key: 'daily_cap_usd', value: '50', description: 'd' }];
    expect(seedRevisionOf(rows)).toBe(seedRevisionOf([...rows]));
    const changed = [{ ...rows[0], value: '100' }];
    expect(seedRevisionOf(changed)).not.toBe(seedRevisionOf(rows));
  });
});

describe('buildImageRecords', () => {
  const base = {
    app: 'claudeclaw',
    repoUri: '111122223333.dkr.ecr.us-east-1.amazonaws.com/claudeclaw-orchestrator',
    imageDigest: 'sha256:' + 'a'.repeat(64),
  };

  it('tier 1: orchestrator + worker, both arm64, no sidecar', () => {
    const records = buildImageRecords({ ...base, tier: 1 });
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      taskFamily: 'claudeclaw-orchestrator',
      containerName: 'orchestrator',
      platform: 'linux/arm64',
    });
    expect(records[1]).toMatchObject({
      taskFamily: 'claudeclaw-consolidation-worker',
      containerName: 'worker',
      digest: base.imageDigest,
    });
  });

  it('tier 2+: adds the pinned X-Ray sidecar record', () => {
    const records = buildImageRecords({ ...base, tier: 2, xrayDigest: 'sha256:' + 'b'.repeat(64) });
    expect(records).toHaveLength(3);
    expect(records[2]).toMatchObject({
      containerName: 'xray-daemon',
      repo: XRAY_SIDECAR_REPO,
      digest: 'sha256:' + 'b'.repeat(64),
    });
  });

  it('suffixed app names flow into the task families', () => {
    const records = buildImageRecords({ ...base, app: 'claudeclaw-staging', tier: 0 });
    expect(records[0].taskFamily).toBe('claudeclaw-staging-orchestrator');
    expect(records[1].taskFamily).toBe('claudeclaw-staging-consolidation-worker');
  });
});

describe('xrayDigestFromComputeStackSource', () => {
  it('extracts the pinned digest from the compute-stack source shape', () => {
    const source = `
      image: ContainerImage.fromRegistry(
        'public.ecr.aws/xray/aws-xray-daemon:3.6.0@${XRAY_SIDECAR_DIGEST_FALLBACK}',
      ),`;
    expect(xrayDigestFromComputeStackSource(source)).toBe(XRAY_SIDECAR_DIGEST_FALLBACK);
  });

  it('returns null when no pinned digest is present', () => {
    expect(xrayDigestFromComputeStackSource('no xray here')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────
// Architecture gate + table resolution
// ─────────────────────────────────────────────────────────────────────

describe('imageInspectHasArm64', () => {
  it('accepts imagetools output that lists linux/arm64', () => {
    expect(
      imageInspectHasArm64('MediaType: ...\nPlatform: linux/arm64\nDigest: sha256:abc'),
    ).toBe(true);
  });
  it('rejects amd64-only output (the default x86 docker build failure)', () => {
    expect(imageInspectHasArm64('Platform: linux/amd64')).toBe(false);
  });
});

describe('imageJsonHasArm64', () => {
  it('accepts a single-manifest image with image.architecture arm64', () => {
    expect(imageJsonHasArm64('{"image":{"architecture":"arm64"}}')).toBe(true);
  });
  it('rejects a single-manifest image with image.architecture amd64', () => {
    expect(imageJsonHasArm64('{"image":{"architecture":"amd64"}}')).toBe(false);
  });
  it('rejects index-shaped JSON without a top-level image.architecture', () => {
    // The regex path handles indexes; the JSON path is the single-manifest
    // fallback, so an index shape must not match here.
    expect(
      imageJsonHasArm64('{"manifest":[{"platform":{"architecture":"arm64"}}]}'),
    ).toBe(false);
  });
  it('rejects empty and non-JSON input', () => {
    expect(imageJsonHasArm64('')).toBe(false);
    expect(imageJsonHasArm64('not json')).toBe(false);
  });
});

describe('resolveRuntimeConfigTable', () => {
  it('explicit TABLE_RUNTIME_CONFIG wins', () => {
    expect(resolveRuntimeConfigTable({ TABLE_RUNTIME_CONFIG: 'custom' }, 'prod')).toBe('custom');
  });
  it('derives the suffixed name from CCE_NAME_SUFFIX', () => {
    expect(resolveRuntimeConfigTable({ CCE_NAME_SUFFIX: 'staging' }, 'prod')).toBe(
      'claudeclaw-staging-runtime-config',
    );
  });
  it('falls back to the --env flag, empty for prod', () => {
    expect(resolveRuntimeConfigTable({}, 'prod')).toBe('claudeclaw-runtime-config');
    expect(resolveRuntimeConfigTable({}, 'staging')).toBe('claudeclaw-staging-runtime-config');
  });
});
