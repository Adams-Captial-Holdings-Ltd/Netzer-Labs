import { describe, it, expect } from 'vitest';
import {
  buildVerifyContext,
  checkById,
  runVerify,
  isInferenceProfileId,
  type VerifyClients,
  type VerifyContext,
  type BuildVerifyContextOptions,
} from './checks.js';
import type { AwsClient } from '../preflight/checks.js';
import type { FetchFn } from '../surface-validate.js';
import { MANIFEST_SCHEMA_VERSION } from '../lifecycle/manifest.js';

// ─────────────────────────────────────────────────────────────────────
// Fakes — every AWS client is an injected `{ send }` fake and the fetch
// function is an injected fake. No real AWS or network call is ever made
// from this file.
// ─────────────────────────────────────────────────────────────────────

const deny = (label: string): AwsClient => ({
  send: async () => {
    throw new Error(`unexpected AWS call to ${label}`);
  },
});

/** Dispatch on the SDK command class name (or CLI `{action}` shape). */
function byCommand(handlers: Record<string, (input: never) => unknown>): AwsClient {
  return {
    async send(command: unknown): Promise<unknown> {
      const cli = command as { action?: string };
      const name =
        typeof cli.action === 'string' ? cli.action : (command as object).constructor.name;
      const handler = handlers[name];
      if (!handler) throw new Error(`no fake handler for ${name}`);
      const input = (command as { input?: unknown }).input ?? command;
      return handler(input as never);
    },
  };
}

function fakeClients(overrides: Partial<VerifyClients> = {}): VerifyClients {
  return {
    cloudFormation: deny('cloudFormation'),
    ecs: deny('ecs'),
    elbv2: deny('elbv2'),
    ec2: deny('ec2'),
    s3: deny('s3'),
    secretsManager: deny('secretsManager'),
    dynamoDb: deny('dynamoDb'),
    sqs: deny('sqs'),
    sns: deny('sns'),
    scheduler: deny('scheduler'),
    wafv2: deny('wafv2'),
    iam: deny('iam'),
    bedrock: deny('bedrock'),
    bedrockRuntime: deny('bedrockRuntime'),
    ecr: deny('ecr'),
    codeBuild: deny('codeBuild'),
    ...overrides,
  };
}

const denyFetch: FetchFn = async (input) => {
  throw new Error(`unexpected fetch to ${String(input)}`);
};

const baseEnv: Record<string, string> = {
  AWS_ACCOUNT_ID: '123456789012',
  AWS_REGION: 'us-east-1',
  CDK_STACK_NAME: 'CCE',
  DEPLOY_TIER: '1',
  BEDROCK_DEFAULT_MODEL: 'us.anthropic.claude-sonnet-4-6',
  DASHBOARD_TOKEN: 'a-real-dashboard-token',
  DOMAIN_NAME: 'claw.example.com',
};

function makeCtx(
  envOverrides: Record<string, string> = {},
  clientOverrides: Partial<VerifyClients> = {},
  opts: Omit<BuildVerifyContextOptions, 'clients'> = {},
): VerifyContext {
  const env = { ...baseEnv, ...envOverrides };
  for (const [k, v] of Object.entries(envOverrides)) {
    if (v === '') delete env[k]; // '' override means "unset"
  }
  return buildVerifyContext(env, {
    clients: fakeClients(clientOverrides),
    fetchFn: opts.fetchFn ?? denyFetch,
    strict: opts.strict ?? false,
    bedrockForRegion: opts.bedrockForRegion,
  });
}

async function runOne(ctx: VerifyContext, id: string) {
  const [result] = await runVerify(ctx, [checkById(id)]);
  return result;
}

const awsError = (name: string, message: string): Error =>
  Object.assign(new Error(message), { name });

/** Minimal Response-shaped fake for the injected fetch. */
function fakeResponse(status: number, body = ''): Response {
  return {
    status,
    text: async () => body,
    json: async () => (body ? JSON.parse(body) : {}),
  } as unknown as Response;
}

/** A minimal but parseManifest-valid manifest JSON string. */
function manifestJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    appSchemaVersion: 1,
    deployId: 'CCE-20260611-abc1234-x9',
    gitSha: 'abc1234',
    cleanTree: true,
    account: '123456789012',
    region: 'us-east-1',
    tier: 1,
    mode: 'chat',
    featureFlags: {},
    imageTag: 'deploy-abc1234',
    ecrRepo: 'claudeclaw-orchestrator',
    images: [],
    cdkVersion: '2.0.0',
    synthInputs: {},
    stacks: ['CCE-Network'],
    stackTemplateHashes: {},
    secretVersions: [],
    deployedAt: '2026-06-11T00:00:00.000Z',
    ...overrides,
  });
}

/** S3 fake whose GetObject returns the given manifest body (or throws). */
function s3WithManifest(body: string): AwsClient {
  return byCommand({
    GetObjectCommand: () => ({ Body: body }),
  });
}

// ─────────────────────────────────────────────────────────────────────
// ecs-service-steady
// ─────────────────────────────────────────────────────────────────────

describe('ecs-service-steady', () => {
  it('fails when runningCount != desiredCount', async () => {
    const ctx = makeCtx(
      {},
      {
        ecs: byCommand({
          DescribeServicesCommand: () => ({
            services: [{ status: 'ACTIVE', runningCount: 1, desiredCount: 2, deployments: [] }],
          }),
        }),
      },
    );
    const result = await runOne(ctx, 'ecs-service-steady');
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('runningCount 1 != desiredCount 2');
  });

  it('fails on a FAILED deployment even when counts match', async () => {
    const ctx = makeCtx(
      {},
      {
        ecs: byCommand({
          DescribeServicesCommand: () => ({
            services: [
              {
                status: 'ACTIVE',
                runningCount: 2,
                desiredCount: 2,
                deployments: [{ rolloutState: 'FAILED', rolloutStateReason: 'tasks crash-looping' }],
              },
            ],
          }),
        }),
      },
    );
    const result = await runOne(ctx, 'ecs-service-steady');
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('tasks crash-looping');
  });

  it('passes when steady', async () => {
    const ctx = makeCtx(
      {},
      {
        ecs: byCommand({
          DescribeServicesCommand: () => ({
            services: [
              {
                status: 'ACTIVE',
                runningCount: 2,
                desiredCount: 2,
                deployments: [{ rolloutState: 'COMPLETED' }],
              },
            ],
          }),
        }),
      },
    );
    const result = await runOne(ctx, 'ecs-service-steady');
    expect(result.status).toBe('pass');
  });

  it('fails when the service does not exist', async () => {
    const ctx = makeCtx(
      {},
      {
        ecs: byCommand({
          DescribeServicesCommand: () => ({ services: [], failures: [{ reason: 'MISSING' }] }),
        }),
      },
    );
    const result = await runOne(ctx, 'ecs-service-steady');
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('not found');
  });
});

// ─────────────────────────────────────────────────────────────────────
// dashboard-endpoint (mode-aware)
// ─────────────────────────────────────────────────────────────────────

describe('dashboard-endpoint', () => {
  it('chat mode: /ready 503 = FAIL "not ready for traffic"', async () => {
    const fetchFn: FetchFn = async (input) => {
      expect(String(input)).toBe('https://claw.example.com/ready');
      return fakeResponse(503);
    };
    const ctx = makeCtx({}, {}, { fetchFn });
    const result = await runOne(ctx, 'dashboard-endpoint');
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('NOT ready for traffic');
  });

  it('chat mode: /ready 200 = pass', async () => {
    const ctx = makeCtx({}, {}, { fetchFn: async () => fakeResponse(200) });
    const result = await runOne(ctx, 'dashboard-endpoint');
    expect(result.status).toBe('pass');
  });

  it('infra-only with domain: /health 200 + dashboard auth round-trip', async () => {
    const seen: string[] = [];
    const fetchFn: FetchFn = async (input) => {
      seen.push(String(input));
      return fakeResponse(200);
    };
    const ctx = makeCtx({ CCE_DEPLOY_MODE: 'infra-only' }, {}, { fetchFn });
    const result = await runOne(ctx, 'dashboard-endpoint');
    expect(result.status).toBe('pass');
    expect(seen).toContain('https://claw.example.com/health');
    expect(seen).toContain('https://claw.example.com/api/agents');
  });

  it('infra-only WITHOUT domain: no public fetch; detail points at tunnel + posture scan', async () => {
    const ctx = makeCtx({ CCE_DEPLOY_MODE: 'infra-only', DOMAIN_NAME: '' }, {}, { fetchFn: denyFetch });
    const result = await runOne(ctx, 'dashboard-endpoint');
    expect(result.status).toBe('skip');
    expect(result.detail).toContain('private-posture');
    expect(result.detail).toContain('dashboard:tunnel');
  });
});

// ─────────────────────────────────────────────────────────────────────
// private-posture (infra-only without domain)
// ─────────────────────────────────────────────────────────────────────

const PRIVATE_ENV = { CCE_DEPLOY_MODE: 'infra-only', DOMAIN_NAME: '' };

function albClients(opts: {
  scheme: string;
  openIngress: boolean;
}): Partial<VerifyClients> {
  return {
    elbv2: byCommand({
      DescribeLoadBalancersCommand: () => ({
        LoadBalancers: [
          {
            LoadBalancerArn: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/claudeclaw-alb/abc',
            DNSName: 'claudeclaw-alb-1.us-east-1.elb.amazonaws.com',
            Scheme: opts.scheme,
            SecurityGroups: ['sg-12345'],
          },
        ],
      }),
      DescribeListenersCommand: () => ({ Listeners: [{ Port: 80, Protocol: 'HTTP' }] }),
    }),
    ec2: byCommand({
      DescribeSecurityGroupsCommand: () => ({
        SecurityGroups: [
          {
            IpPermissions: opts.openIngress
              ? [
                  {
                    IpProtocol: 'tcp',
                    FromPort: 80,
                    ToPort: 80,
                    IpRanges: [{ CidrIp: '0.0.0.0/0' }],
                    Ipv6Ranges: [],
                  },
                ]
              : [
                  {
                    IpProtocol: 'tcp',
                    FromPort: 80,
                    ToPort: 80,
                    IpRanges: [{ CidrIp: '10.0.0.0/16' }],
                    Ipv6Ranges: [],
                  },
                ],
          },
        ],
      }),
    }),
  };
}

describe('private-posture', () => {
  it('is skipped outside the no-domain infra-only mode', async () => {
    const ctx = makeCtx(); // chat mode with a domain
    const result = await runOne(ctx, 'private-posture');
    expect(result.status).toBe('skip');
  });

  it('FAILS an internet-facing ALB with the exact private-access reason', async () => {
    const ctx = makeCtx(PRIVATE_ENV, albClients({ scheme: 'internet-facing', openIngress: true }));
    const result = await runOne(ctx, 'private-posture');
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('private access means not reachable from the internet');
    // world-open ingress reaching the dashboard target is called out too
    expect(result.detail).toContain('0.0.0.0/0');
  });

  it('passes an internal ALB with no world-open ingress, naming what it scanned', async () => {
    const ctx = makeCtx(PRIVATE_ENV, albClients({ scheme: 'internal', openIngress: false }));
    const result = await runOne(ctx, 'private-posture');
    expect(result.status).toBe('pass');
    expect(result.detail).toContain('scanned 1 listener(s)');
    expect(result.detail).toContain('dashboard:tunnel');
  });

  it('warns when the ALB is internal but a security group is still world-open', async () => {
    const ctx = makeCtx(PRIVATE_ENV, albClients({ scheme: 'internal', openIngress: true }));
    const result = await runOne(ctx, 'private-posture');
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('world-open ingress');
  });

  it('fails when the ALB cannot be found at all', async () => {
    const ctx = makeCtx(PRIVATE_ENV, {
      elbv2: byCommand({
        DescribeLoadBalancersCommand: () => {
          throw awsError('LoadBalancerNotFoundException', 'no such load balancer');
        },
      }),
    });
    const result = await runOne(ctx, 'private-posture');
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('not found');
  });
});

// ─────────────────────────────────────────────────────────────────────
// dashboard-plain-http (every mode)
// ─────────────────────────────────────────────────────────────────────

describe('dashboard-plain-http', () => {
  const albOnly: Partial<VerifyClients> = {
    elbv2: byCommand({
      DescribeLoadBalancersCommand: () => ({
        LoadBalancers: [
          { DNSName: 'claudeclaw-alb-1.us-east-1.elb.amazonaws.com', Scheme: 'internet-facing' },
        ],
      }),
    }),
  };

  it('FAILS when dashboard auth answers 200 over plain HTTP', async () => {
    const fetchFn: FetchFn = async (input, init) => {
      expect(String(input)).toBe('http://claudeclaw-alb-1.us-east-1.elb.amazonaws.com/api/agents');
      expect((init as { redirect?: string }).redirect).toBe('manual');
      return fakeResponse(200, '[]');
    };
    const ctx = makeCtx({}, albOnly, { fetchFn });
    const result = await runOne(ctx, 'dashboard-plain-http');
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('dashboard auth must never ride plain HTTP');
  });

  it('passes when plain HTTP redirects instead of serving (301)', async () => {
    const ctx = makeCtx({}, albOnly, { fetchFn: async () => fakeResponse(301) });
    const result = await runOne(ctx, 'dashboard-plain-http');
    expect(result.status).toBe('pass');
  });

  it('passes when plain HTTP is unreachable (internal ALB / no :80 listener)', async () => {
    const ctx = makeCtx({}, albOnly, {
      fetchFn: async () => {
        throw new Error('connect ETIMEDOUT');
      },
    });
    const result = await runOne(ctx, 'dashboard-plain-http');
    expect(result.status).toBe('pass');
    expect(result.detail).toContain('not reachable');
  });

  it('skips when DASHBOARD_TOKEN is not configured', async () => {
    const ctx = makeCtx({ DASHBOARD_TOKEN: '' });
    const result = await runOne(ctx, 'dashboard-plain-http');
    expect(result.status).toBe('skip');
  });
});

// ─────────────────────────────────────────────────────────────────────
// manifest-present (layer B)
// ─────────────────────────────────────────────────────────────────────

describe('manifest-present', () => {
  it('fails on a schema-version mismatch with the deploy remediation', async () => {
    const ctx = makeCtx({}, { s3: s3WithManifest(manifestJson({ schemaVersion: 99 })) });
    const result = await runOne(ctx, 'manifest-present');
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('schema version 99');
    expect(result.remediation).toContain('Run a deploy with this version');
  });

  it('fails when no manifest was ever promoted', async () => {
    const ctx = makeCtx(
      {},
      {
        s3: byCommand({
          GetObjectCommand: () => {
            throw awsError('NoSuchKey', 'not found');
          },
        }),
      },
    );
    const result = await runOne(ctx, 'manifest-present');
    expect(result.status).toBe('fail');
    expect(result.remediation).toContain('Run a deploy with this version');
  });

  it('passes and surfaces deployId/gitSha/imageTag', async () => {
    const ctx = makeCtx({}, { s3: s3WithManifest(manifestJson()) });
    const result = await runOne(ctx, 'manifest-present');
    expect(result.status).toBe('pass');
    expect(result.detail).toContain('CCE-20260611-abc1234-x9');
    expect(result.detail).toContain('deploy-abc1234');
  });
});

// ─────────────────────────────────────────────────────────────────────
// secret-versions-fresh (layer B — DescribeSecret only)
// ─────────────────────────────────────────────────────────────────────

describe('secret-versions-fresh', () => {
  const withRecorded = manifestJson({
    secretVersions: [{ secretId: '/claudeclaw/slack', versionId: 'v-recorded', label: 'CCE-x' }],
  });

  it('warns when AWSCURRENT drifted off the recorded version', async () => {
    const ctx = makeCtx(
      {},
      {
        s3: s3WithManifest(withRecorded),
        secretsManager: byCommand({
          DescribeSecretCommand: () => ({
            VersionIdsToStages: { 'v-recorded': ['AWSPREVIOUS'], 'v-new': ['AWSCURRENT'] },
          }),
        }),
      },
    );
    const result = await runOne(ctx, 'secret-versions-fresh');
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('AWSCURRENT is v-new');
    expect(result.detail).toContain('naming drift');
  });

  it('fails when the recorded version no longer exists', async () => {
    const ctx = makeCtx(
      {},
      {
        s3: s3WithManifest(withRecorded),
        secretsManager: byCommand({
          DescribeSecretCommand: () => ({
            VersionIdsToStages: { 'v-new': ['AWSCURRENT'] },
          }),
        }),
      },
    );
    const result = await runOne(ctx, 'secret-versions-fresh');
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('v-recorded no longer exists');
  });

  it('passes when AWSCURRENT matches and SAYS placeholder detection rides /ready', async () => {
    const ctx = makeCtx(
      {},
      {
        s3: s3WithManifest(withRecorded),
        secretsManager: byCommand({
          DescribeSecretCommand: () => ({
            VersionIdsToStages: { 'v-recorded': ['AWSCURRENT'] },
          }),
        }),
      },
    );
    const result = await runOne(ctx, 'secret-versions-fresh');
    expect(result.status).toBe('pass');
    expect(result.detail).toContain('never GetSecretValue');
    expect(result.detail).toContain('/ready');
  });

  it('skips (with reason) when no manifest is readable', async () => {
    const ctx = makeCtx(
      {},
      {
        s3: byCommand({
          GetObjectCommand: () => {
            throw awsError('NoSuchKey', 'not found');
          },
        }),
      },
    );
    const result = await runOne(ctx, 'secret-versions-fresh');
    expect(result.status).toBe('skip');
    expect(result.detail).toContain('manifest');
  });
});

// ─────────────────────────────────────────────────────────────────────
// runtime-config-seed (layer B)
// ─────────────────────────────────────────────────────────────────────

describe('runtime-config-seed', () => {
  it('fails listing missing rows with the seed remediation', async () => {
    const ctx = makeCtx(
      {},
      { dynamoDb: byCommand({ GetItemCommand: () => ({}) }) }, // no Item → all missing
    );
    const result = await runOne(ctx, 'runtime-config-seed');
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('memory/ingest_every_n_turns');
    expect(result.remediation).toContain('npm run seed');
  });

  it('passes when every seed row exists', async () => {
    const ctx = makeCtx(
      {},
      { dynamoDb: byCommand({ GetItemCommand: () => ({ Item: { value: { S: 'x' } } }) }) },
    );
    const result = await runOne(ctx, 'runtime-config-seed');
    expect(result.status).toBe('pass');
  });
});

// ─────────────────────────────────────────────────────────────────────
// Bedrock probes — strict gating, feature gating, inference profiles
// ─────────────────────────────────────────────────────────────────────

describe('bedrock probes', () => {
  it('paid probes are skipped in non-strict mode with a "run --strict" detail', async () => {
    const ctx = makeCtx(); // strict: false
    const claude = await runOne(ctx, 'bedrock-probe-claude');
    expect(claude.status).toBe('skip');
    expect(claude.detail).toContain('--strict');
    const titan = await runOne(ctx, 'bedrock-probe-titan-embed');
    expect(titan.status).toBe('skip');
    expect(titan.detail).toContain('--strict');
  });

  it('disabled feature probes are skipped even under --strict', async () => {
    const ctx = makeCtx(
      {
        CCE_KNOWLEDGE_ENABLED: '0',
        CCE_IMAGE_GEN_ENABLED: '0',
        CCE_TTS_ENABLED: '0',
        // JARVIS_LAUNCH_ENABLED unset → jarvisVoice off
      },
      {},
      { strict: true },
    );
    for (const id of [
      'bedrock-probe-titan-embed',
      'bedrock-availability-image',
      'bedrock-availability-nova-sonic',
    ]) {
      const result = await runOne(ctx, id);
      expect(result.status).toBe('skip');
      expect(result.detail).toContain('not applicable');
    }
  });

  it('inference-profile resolution probes EACH destination region and stays honest', async () => {
    const probedRegions: string[] = [];
    const converseInputs: unknown[] = [];
    const ctx = makeCtx(
      { BEDROCK_GUARDRAIL_ID: 'gr-123', BEDROCK_GUARDRAIL_VERSION: '2' },
      {
        bedrock: byCommand({
          GetInferenceProfileCommand: () => ({
            models: [
              { modelArn: 'arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-sonnet-4-6' },
              { modelArn: 'arn:aws:bedrock:us-west-2::foundation-model/anthropic.claude-sonnet-4-6' },
            ],
          }),
        }),
        bedrockRuntime: byCommand({
          ConverseCommand: (input) => {
            converseInputs.push(input);
            return { output: {} };
          },
        }),
      },
      {
        strict: true,
        bedrockForRegion: (region) =>
          byCommand({
            GetFoundationModelCommand: () => {
              probedRegions.push(region);
              return { modelDetails: {} };
            },
          }),
      },
    );
    const result = await runOne(ctx, 'bedrock-probe-claude');
    expect(result.status).toBe('pass');
    expect(probedRegions.sort()).toEqual(['us-east-1', 'us-west-2']);
    expect(result.detail).toContain('destination us-east-1');
    expect(result.detail).toContain('destination us-west-2');
    expect(result.detail).toContain('cannot force Bedrock to exercise every routed region');
    expect(result.detail).toContain('PAID');
    // The one paid Converse probe carries the configured guardrail.
    expect(converseInputs).toHaveLength(1);
    expect(converseInputs[0]).toMatchObject({
      modelId: 'us.anthropic.claude-sonnet-4-6',
      inferenceConfig: { maxTokens: 16 },
      guardrailConfig: { guardrailIdentifier: 'gr-123', guardrailVersion: '2' },
    });
  });

  it('fails naming the exact console grant when a destination region lacks access', async () => {
    const ctx = makeCtx(
      {},
      {
        bedrock: byCommand({
          GetInferenceProfileCommand: () => ({
            models: [
              { modelArn: 'arn:aws:bedrock:us-west-2::foundation-model/anthropic.claude-sonnet-4-6' },
            ],
          }),
        }),
        bedrockRuntime: deny('bedrockRuntime'), // probe must not run after a region failure
      },
      {
        strict: true,
        bedrockForRegion: () =>
          byCommand({
            GetFoundationModelCommand: () => {
              throw awsError('AccessDeniedException', 'no model access');
            },
          }),
      },
    );
    const result = await runOne(ctx, 'bedrock-probe-claude');
    expect(result.status).toBe('fail');
    expect(result.remediation).toContain('us-west-2');
    expect(result.remediation).toContain('#/model-catalog');
  });

  it('a failed Converse probe names the console model-access grant', async () => {
    const ctx = makeCtx(
      { BEDROCK_DEFAULT_MODEL: 'anthropic.claude-sonnet-4-6' }, // not profile-shaped
      {
        bedrockRuntime: byCommand({
          ConverseCommand: () => {
            throw awsError('AccessDeniedException', 'You do not have access to the model');
          },
        }),
      },
      { strict: true },
    );
    const result = await runOne(ctx, 'bedrock-probe-claude');
    expect(result.status).toBe('fail');
    expect(result.remediation).toContain('anthropic.claude-sonnet-4-6');
    expect(result.remediation).toContain('#/model-catalog');
  });

  it('titan embedding probe runs under strict when knowledge is enabled', async () => {
    let invoked = 0;
    const ctx = makeCtx(
      {},
      {
        bedrockRuntime: byCommand({
          InvokeModelCommand: () => {
            invoked += 1;
            return { body: new Uint8Array() };
          },
        }),
      },
      { strict: true },
    );
    const result = await runOne(ctx, 'bedrock-probe-titan-embed');
    expect(result.status).toBe('pass');
    expect(invoked).toBe(1);
  });

  it('image availability lists the SERVING region and is honest that invocation is NOT exercised', async () => {
    // Default image model is the Stability generator, which lives in
    // us-west-2 — the check must consult that region, not the home region.
    const regions: string[] = [];
    const ctx = makeCtx(
      {},
      {},
      {
        bedrockForRegion: (region) => {
          regions.push(region);
          return byCommand({
            ListFoundationModelsCommand: () => ({
              modelSummaries: [{ modelId: 'stability.stable-image-core-v1:1' }],
            }),
          });
        },
      },
    );
    const result = await runOne(ctx, 'bedrock-availability-image');
    expect(result.status).toBe('pass');
    expect(result.detail).toContain('stability.stable-image-core-v1:1');
    expect(result.detail).toContain('NOT exercised');
    expect(regions).toEqual(['us-west-2']);
  });

  it('a pinned Nova Canvas that is no longer accessible fails with the Legacy remediation', async () => {
    const ctx = makeCtx(
      { BEDROCK_IMAGE_MODEL: 'amazon.nova-canvas-v1:0' },
      {
        bedrock: byCommand({
          ListFoundationModelsCommand: () => ({ modelSummaries: [] }),
        }),
      },
    );
    const result = await runOne(ctx, 'bedrock-availability-image');
    expect(result.status).toBe('fail');
    expect(result.remediation).toContain('provider-Legacy');
  });

  it('isInferenceProfileId recognizes prefixes and ARNs but not vendor ids', () => {
    expect(isInferenceProfileId('us.anthropic.claude-sonnet-4-6')).toBe(true);
    expect(isInferenceProfileId('eu.amazon.nova-canvas-v1:0')).toBe(true);
    expect(isInferenceProfileId('arn:aws:bedrock:us-east-1:123456789012:inference-profile/x')).toBe(true);
    expect(isInferenceProfileId('anthropic.claude-sonnet-4-6')).toBe(false);
    expect(isInferenceProfileId('amazon.titan-embed-text-v2:0')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Sampling honesty + external checks gating
// ─────────────────────────────────────────────────────────────────────

describe('messaging-queues-topics (sampling honesty)', () => {
  it('says it SAMPLED when it probes one queue/topic of several', async () => {
    const ctx = makeCtx(
      {},
      {
        cloudFormation: byCommand({
          ListStackResourcesCommand: () => ({
            StackResourceSummaries: [
              {
                LogicalResourceId: 'IngestQueue',
                PhysicalResourceId: 'https://sqs.us-east-1.amazonaws.com/123456789012/claudeclaw-ingest',
                ResourceType: 'AWS::SQS::Queue',
                ResourceStatus: 'CREATE_COMPLETE',
              },
              {
                LogicalResourceId: 'FireQueue',
                PhysicalResourceId: 'https://sqs.us-east-1.amazonaws.com/123456789012/claudeclaw-scheduled-fire',
                ResourceType: 'AWS::SQS::Queue',
                ResourceStatus: 'UPDATE_COMPLETE',
              },
              {
                LogicalResourceId: 'FanoutTopic',
                PhysicalResourceId: 'arn:aws:sns:us-east-1:123456789012:claudeclaw-warroom-fanout',
                ResourceType: 'AWS::SNS::Topic',
                ResourceStatus: 'CREATE_COMPLETE',
              },
            ],
          }),
        }),
        sqs: byCommand({ GetQueueAttributesCommand: () => ({ Attributes: { QueueArn: 'arn' } }) }),
        sns: byCommand({ GetTopicAttributesCommand: () => ({ Attributes: {} }) }),
      },
    );
    const result = await runOne(ctx, 'messaging-queues-topics');
    expect(result.status).toBe('pass');
    expect(result.detail).toContain('SAMPLED');
    expect(result.detail).toContain('1 of 2 queue(s)');
    expect(result.detail).toContain('1 of 1 topic(s)');
    expect(result.detail).toContain('not live probes');
  });
});

describe('ddb-tables-active (CFN-enumerated, not hardcoded)', () => {
  it('fails when a stack-declared table is not ACTIVE', async () => {
    const ctx = makeCtx(
      {},
      {
        cloudFormation: byCommand({
          ListStackResourcesCommand: () => ({
            StackResourceSummaries: [
              {
                PhysicalResourceId: 'claudeclaw-sessions',
                ResourceType: 'AWS::DynamoDB::Table',
                ResourceStatus: 'CREATE_COMPLETE',
              },
              {
                PhysicalResourceId: 'claudeclaw-agents',
                ResourceType: 'AWS::DynamoDB::Table',
                ResourceStatus: 'CREATE_COMPLETE',
              },
            ],
          }),
        }),
        dynamoDb: byCommand({
          DescribeTableCommand: (input: { TableName?: string }) => ({
            Table: { TableStatus: input.TableName === 'claudeclaw-agents' ? 'DELETING' : 'ACTIVE' },
          }),
        }),
      },
    );
    const result = await runOne(ctx, 'ddb-tables-active');
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('claudeclaw-agents: DELETING');
  });
});

describe('external deliverability checks (layer C gating)', () => {
  it('configured Slack surface is skipped without --strict, with the strict hint', async () => {
    const ctx = makeCtx({ SLACK_BOT_TOKEN: 'xoxb-real' });
    const result = await runOne(ctx, 'external-slack');
    expect(result.status).toBe('skip');
    expect(result.detail).toContain('--strict');
  });

  it('unconfigured surfaces are skipped as not applicable even under --strict', async () => {
    const ctx = makeCtx({}, {}, { strict: true }); // no SLACK_BOT_TOKEN / TELEGRAM_TOKENS_JSON
    const slack = await runOne(ctx, 'external-slack');
    expect(slack.status).toBe('skip');
    expect(slack.detail).toContain('not applicable');
    const telegram = await runOne(ctx, 'external-telegram');
    expect(telegram.status).toBe('skip');
  });

  it('telegram check never mutates: a webhook mismatch fails with manual remediation', async () => {
    const calls: string[] = [];
    const fetchFn: FetchFn = async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.includes('/getMe')) {
        return fakeResponse(200, JSON.stringify({ ok: true, result: { username: 'cce_bot' } }));
      }
      if (url.includes('/getWebhookInfo')) {
        return fakeResponse(200, JSON.stringify({ ok: true, result: { url: 'https://old.example.com/hook' } }));
      }
      throw new Error(`unexpected URL ${url}`);
    };
    const ctx = makeCtx(
      { TELEGRAM_TOKENS_JSON: JSON.stringify({ main: '123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }) },
      {},
      { strict: true, fetchFn },
    );
    const result = await runOne(ctx, 'external-telegram');
    expect(result.status).toBe('fail');
    expect(result.remediation).toContain('setWebhook');
    // register:false — verify must never call setWebhook itself.
    expect(calls.some((u) => u.includes('/setWebhook'))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────
// CI checks (layer C, flag-gated)
// ─────────────────────────────────────────────────────────────────────

describe('github-oidc / codebuild-credential', () => {
  it('both skip when the CI flags are off', async () => {
    const ctx = makeCtx();
    expect((await runOne(ctx, 'github-oidc')).status).toBe('skip');
    expect((await runOne(ctx, 'codebuild-credential')).status).toBe('skip');
  });

  it('github-oidc fails when the audience list lacks sts.amazonaws.com', async () => {
    const ctx = makeCtx(
      { CCE_CICD_ENABLED: '1' },
      {
        iam: byCommand({
          GetOpenIDConnectProviderCommand: () => ({ ClientIDList: ['something-else'] }),
        }),
      },
    );
    const result = await runOne(ctx, 'github-oidc');
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('sts.amazonaws.com');
  });

  it('codebuild-credential fails without a GITHUB source credential', async () => {
    const ctx = makeCtx(
      { CCE_CODEBUILD_ENABLED: '1' },
      {
        codeBuild: byCommand({
          'list-source-credentials': () => ({ sourceCredentialsInfos: [] }),
        }),
      },
    );
    const result = await runOne(ctx, 'codebuild-credential');
    expect(result.status).toBe('fail');
    expect(result.remediation).toContain('import-source-credentials');
  });
});

// ─────────────────────────────────────────────────────────────────────
// ecr-image (manifest-pinned)
// ─────────────────────────────────────────────────────────────────────

describe('ecr-image', () => {
  it('fails when the manifest image tag is missing from ECR', async () => {
    const ctx = makeCtx(
      {},
      {
        s3: s3WithManifest(manifestJson()),
        ecr: byCommand({
          'describe-repositories': () => ({ repositories: [{}] }),
          'describe-images': () => {
            throw awsError('ImageNotFoundException', 'the image with tag deploy-abc1234 does not exist');
          },
        }),
      },
    );
    const result = await runOne(ctx, 'ecr-image');
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('deploy-abc1234');
  });

  it('warns (not fails) when the repo exists but no manifest pins a tag', async () => {
    const ctx = makeCtx(
      {},
      {
        s3: byCommand({
          GetObjectCommand: () => {
            throw awsError('NoSuchKey', 'not found');
          },
        }),
        ecr: byCommand({ 'describe-repositories': () => ({ repositories: [{}] }) }),
      },
    );
    const result = await runOne(ctx, 'ecr-image');
    expect(result.status).toBe('warn');
  });
});

// ─────────────────────────────────────────────────────────────────────
// waf-cloudfront (tier-gated)
// ─────────────────────────────────────────────────────────────────────

describe('waf-cloudfront', () => {
  it('is skipped with a reason below tier 2', async () => {
    const ctx = makeCtx({ DEPLOY_TIER: '1' });
    const result = await runOne(ctx, 'waf-cloudfront');
    expect(result.status).toBe('skip');
  });

  it('fails at tier 2 when the regional WebACL is missing', async () => {
    const ctx = makeCtx(
      { DEPLOY_TIER: '2' },
      { wafv2: byCommand({ ListWebACLsCommand: () => ({ WebACLs: [] }) }) },
    );
    const result = await runOne(ctx, 'waf-cloudfront');
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('claudeclaw-web-acl');
  });
});
