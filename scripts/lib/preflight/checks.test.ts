import { describe, it, expect } from 'vitest';
import {
  buildContext,
  checkById,
  runPreflight,
  summarize,
  isPlaceholder,
  stripInferenceProfilePrefix,
  certNameCovers,
  type AwsClient,
  type PreflightClients,
  type PreflightContext,
} from './checks.js';

// ─────────────────────────────────────────────────────────────────────
// Fakes — every AWS client in tests is an injected `{ send }` fake.
// No real AWS call is ever made from this file.
// ─────────────────────────────────────────────────────────────────────

const deny = (label: string): AwsClient => ({
  send: async () => {
    throw new Error(`unexpected AWS call to ${label}`);
  },
});

function fakeClients(overrides: Partial<PreflightClients> = {}): PreflightClients {
  return {
    sts: deny('sts'),
    cloudFormation: deny('cloudFormation'),
    bedrock: deny('bedrock'),
    ec2: deny('ec2'),
    elbv2: deny('elbv2'),
    s3: deny('s3'),
    secretsManager: deny('secretsManager'),
    iam: deny('iam'),
    costExplorer: deny('costExplorer'),
    ssm: deny('ssm'),
    serviceQuotas: deny('serviceQuotas'),
    acm: deny('acm'),
    route53: deny('route53'),
    codeBuild: deny('codeBuild'),
    ...overrides,
  };
}

const baseEnv: Record<string, string> = {
  AWS_ACCOUNT_ID: '123456789012',
  AWS_REGION: 'us-east-1',
  CDK_STACK_NAME: 'CCE',
  DEPLOY_TIER: '1',
  BEDROCK_SONNET_MODEL: 'us.anthropic.claude-sonnet-4-20250514-v1:0',
  SLACK_BOT_TOKEN: 'xoxb-real-token',
  DASHBOARD_TOKEN: 'a-real-dashboard-token',
};

function makeCtx(
  envOverrides: Record<string, string> = {},
  clientOverrides: Partial<PreflightClients> = {},
  execProbe?: PreflightContext['execProbe'],
): PreflightContext {
  const env = { ...baseEnv, ...envOverrides };
  for (const [k, v] of Object.entries(envOverrides)) {
    if (v === '') delete env[k]; // '' override means "unset"
  }
  const clients = fakeClients(clientOverrides);
  return buildContext(env, {
    clients,
    // Cross-region listings (the image model's serving region) reuse the same
    // fake bedrock client so a test never opens a real regional SDK client.
    bedrockForRegion: () => clients.bedrock,
    execProbe: execProbe ?? (async () => ({ code: 0, stdout: 'fake 1.2.0', stderr: '' })),
  });
}

const awsError = (name: string, message: string): Error =>
  Object.assign(new Error(message), { name });

// ─────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────

describe('isPlaceholder', () => {
  it('rejects placeholder-shaped values', () => {
    expect(isPlaceholder(undefined)).toBe(true);
    expect(isPlaceholder('')).toBe(true);
    expect(isPlaceholder('  ')).toBe(true);
    expect(isPlaceholder('REPLACE_ME')).toBe(true);
    expect(isPlaceholder('replace_me_now')).toBe(true);
    expect(isPlaceholder('<your-token-here>')).toBe(true);
  });
  it('accepts real values', () => {
    expect(isPlaceholder('xoxb-abc123')).toBe(false);
    expect(isPlaceholder('anthropic.claude-sonnet-4-20250514-v1:0')).toBe(false);
  });
});

describe('stripInferenceProfilePrefix', () => {
  it('strips cross-region prefixes but never vendor prefixes', () => {
    expect(stripInferenceProfilePrefix('us.anthropic.claude-sonnet-4-20250514-v1:0')).toBe(
      'anthropic.claude-sonnet-4-20250514-v1:0',
    );
    expect(stripInferenceProfilePrefix('eu.amazon.nova-canvas-v1:0')).toBe('amazon.nova-canvas-v1:0');
    expect(stripInferenceProfilePrefix('anthropic.claude-sonnet-4-20250514-v1:0')).toBe(
      'anthropic.claude-sonnet-4-20250514-v1:0',
    );
    expect(stripInferenceProfilePrefix('amazon.titan-embed-text-v2:0')).toBe(
      'amazon.titan-embed-text-v2:0',
    );
  });
});

describe('certNameCovers', () => {
  it('handles exact and wildcard SANs', () => {
    expect(certNameCovers('claw.example.com', 'claw.example.com')).toBe(true);
    expect(certNameCovers('*.example.com', 'claw.example.com')).toBe(true);
    expect(certNameCovers('*.example.com', 'example.com')).toBe(false); // wildcard never covers apex
    expect(certNameCovers('*.example.com', 'a.b.example.com')).toBe(false); // one label only
    expect(certNameCovers('other.example.com', 'claw.example.com')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 1. aws-identity
// ─────────────────────────────────────────────────────────────────────

describe('aws-identity', () => {
  it('fails on account mismatch with wrong-account remediation', async () => {
    const ctx = makeCtx({}, {
      sts: {
        send: async () => ({
          Account: '999999999999',
          Arn: 'arn:aws:iam::999999999999:user/intruder',
          UserId: 'AIDA123',
        }),
      },
    });
    const result = await checkById('aws-identity').run(ctx);
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('999999999999');
    expect(result.detail).toContain('123456789012');
    expect(result.remediation).toMatch(/AWS_PROFILE|aws configure/);
  });

  it('passes and echoes account + arn when identities agree', async () => {
    const ctx = makeCtx({}, {
      sts: {
        send: async () => ({
          Account: '123456789012',
          Arn: 'arn:aws:iam::123456789012:user/me',
          UserId: 'AIDA456',
        }),
      },
    });
    const result = await checkById('aws-identity').run(ctx);
    expect(result.status).toBe('pass');
    expect(result.detail).toContain('123456789012');
    expect(result.detail).toContain('arn:aws:iam::123456789012:user/me');
    expect(ctx.resolvedAccount).toBe('123456789012');
  });

  it('fails when STS errors', async () => {
    const ctx = makeCtx({}, {
      sts: { send: async () => { throw awsError('ExpiredTokenException', 'token expired'); } },
    });
    const result = await checkById('aws-identity').run(ctx);
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('token expired');
  });
});

// ─────────────────────────────────────────────────────────────────────
// 2. cdk-bootstrap
// ─────────────────────────────────────────────────────────────────────

describe('cdk-bootstrap', () => {
  it('fails when CDKToolkit is missing and prints the exact bootstrap command', async () => {
    const ctx = makeCtx({}, {
      cloudFormation: {
        send: async () => {
          throw awsError('ValidationError', 'Stack with id CDKToolkit does not exist');
        },
      },
    });
    const result = await checkById('cdk-bootstrap').run(ctx);
    expect(result.status).toBe('fail');
    expect(result.remediation).toBe('npx cdk bootstrap aws://123456789012/us-east-1');
  });

  it('fails (not warn) when the SSM version parameter is missing', async () => {
    const ctx = makeCtx({}, {
      cloudFormation: { send: async () => ({ Stacks: [{ StackName: 'CDKToolkit' }] }) },
      ssm: {
        send: async () => {
          throw awsError('ParameterNotFound', 'parameter not found');
        },
      },
    });
    const result = await checkById('cdk-bootstrap').run(ctx);
    expect(result.status).toBe('fail');
    expect(result.remediation).toContain('npx cdk bootstrap aws://123456789012/us-east-1');
  });

  it('warns when the bootstrap version is older than 6', async () => {
    const ctx = makeCtx({}, {
      cloudFormation: { send: async () => ({ Stacks: [{ StackName: 'CDKToolkit' }] }) },
      ssm: { send: async () => ({ Parameter: { Value: '4' } }) },
    });
    const result = await checkById('cdk-bootstrap').run(ctx);
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('4');
  });

  it('passes on a modern bootstrap', async () => {
    const ctx = makeCtx({}, {
      cloudFormation: { send: async () => ({ Stacks: [{ StackName: 'CDKToolkit' }] }) },
      ssm: { send: async () => ({ Parameter: { Value: '21' } }) },
    });
    const result = await checkById('cdk-bootstrap').run(ctx);
    expect(result.status).toBe('pass');
  });
});

// ─────────────────────────────────────────────────────────────────────
// 3/4. region capability + feature-aware model grants
// ─────────────────────────────────────────────────────────────────────

const grantedBedrock: AwsClient = {
  send: async () => ({
    modelSummaries: [
      { modelId: 'anthropic.claude-sonnet-4-20250514-v1:0' },
      { modelId: 'amazon.titan-embed-text-v2:0' },
      // nova-canvas and nova-sonic deliberately NOT granted
    ],
  }),
};

describe('region-capability', () => {
  it('fails with a region-specific message when Bedrock is unavailable', async () => {
    const ctx = makeCtx({ AWS_REGION: 'eu-south-9' }, {
      bedrock: { send: async () => { throw awsError('UnknownEndpoint', 'no such endpoint'); } },
    });
    const result = await checkById('region-capability').run(ctx);
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('Bedrock is not available in eu-south-9');
  });
});

describe('bedrock model grants (feature-aware)', () => {
  it('passes Claude via inference-profile prefix strip and defers invocation to verify', async () => {
    const ctx = makeCtx({}, { bedrock: grantedBedrock });
    const result = await checkById('bedrock-grant-claude').run(ctx);
    expect(result.status).toBe('pass');
    expect(result.detail).toContain('npm run verify');
  });

  it('fails the configured Claude model when its grant is missing', async () => {
    const ctx = makeCtx(
      { BEDROCK_SONNET_MODEL: 'us.anthropic.claude-opus-9-v1:0' },
      { bedrock: grantedBedrock },
    );
    const result = await checkById('bedrock-grant-claude').run(ctx);
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('us.anthropic.claude-opus-9-v1:0');
    expect(result.remediation).toContain('#/model-catalog');
  });

  it('fails a missing grant for an ENABLED feature and skips a DISABLED feature', async () => {
    // imageGen defaults ON (CCE_IMAGE_GEN_ENABLED != '0'); jarvisVoice
    // defaults OFF (JARVIS_LAUNCH_ENABLED unset). grantedBedrock does not
    // list the Stability default, so the image check fails.
    const ctx = makeCtx({}, { bedrock: grantedBedrock });
    const results = await runPreflight(ctx, [
      checkById('bedrock-grant-image'),
      checkById('bedrock-grant-nova-sonic'),
    ]);
    const image = results.find((r) => r.id === 'bedrock-grant-image');
    const sonic = results.find((r) => r.id === 'bedrock-grant-nova-sonic');
    expect(image?.status).toBe('fail');
    expect(image?.detail).toContain('stability.stable-image-core-v1:1');
    expect(image?.detail).toContain('us-west-2');
    expect(image?.remediation).toContain('BEDROCK_IMAGE_MODEL');
    expect(sonic?.status).toBe('skip');
  });

  it('checks the image model in its SERVING region, mirroring the runtime resolution', async () => {
    // Default (Stability) resolves to us-west-2, not the deploy region.
    const regions: string[] = [];
    const stabilityBedrock: AwsClient = {
      send: async () => ({
        modelSummaries: [{ modelId: 'stability.stable-image-core-v1:1' }],
      }),
    };
    const clients = fakeClients();
    const ctx = buildContext(baseEnv, {
      clients,
      bedrockForRegion: (r) => {
        regions.push(r);
        return stabilityBedrock;
      },
      execProbe: async () => ({ code: 0, stdout: '', stderr: '' }),
    });
    const result = await checkById('bedrock-grant-image').run(ctx);
    expect(result.status).toBe('pass');
    expect(result.detail).toContain('stability.stable-image-core-v1:1');
    expect(result.detail).toContain('us-west-2');
    expect(regions).toEqual(['us-west-2']);
  });

  it('a pinned Nova Canvas checks the deploy region and fails with the Legacy remediation', async () => {
    const regions: string[] = [];
    const clients = fakeClients();
    const ctx = buildContext(
      { ...baseEnv, BEDROCK_NOVA_CANVAS_MODEL: 'amazon.nova-canvas-v1:0' },
      {
        clients,
        bedrockForRegion: (r) => {
          regions.push(r);
          return grantedBedrock; // lists neither canvas nor stability
        },
        execProbe: async () => ({ code: 0, stdout: '', stderr: '' }),
      },
    );
    const result = await checkById('bedrock-grant-image').run(ctx);
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('amazon.nova-canvas-v1:0');
    expect(result.remediation).toContain('provider-Legacy');
    expect(regions).toEqual(['us-east-1']);
  });

  it('a pinned Nova Canvas passes for an account that still has historical access', async () => {
    const canvasBedrock: AwsClient = {
      send: async () => ({
        modelSummaries: [{ modelId: 'amazon.nova-canvas-v1:0' }],
      }),
    };
    const ctx = makeCtx(
      { BEDROCK_IMAGE_MODEL: 'amazon.nova-canvas-v1:0' },
      { bedrock: canvasBedrock },
    );
    const result = await checkById('bedrock-grant-image').run(ctx);
    expect(result.status).toBe('pass');
    expect(result.detail).toContain('us-east-1');
  });

  it('skips knowledge embeddings when knowledge is disabled, checks them when enabled', async () => {
    const disabled = makeCtx({ CCE_KNOWLEDGE_ENABLED: '0' }, { bedrock: grantedBedrock });
    expect(checkById('bedrock-grant-titan-embed').appliesTo(disabled)).toBe(false);

    const enabled = makeCtx({}, { bedrock: grantedBedrock });
    const result = await checkById('bedrock-grant-titan-embed').run(enabled);
    expect(result.status).toBe('pass');
  });

  it('checks nova-sonic when jarvis voice is enabled', async () => {
    const ctx = makeCtx({ JARVIS_LAUNCH_ENABLED: 'true' }, { bedrock: grantedBedrock });
    const check = checkById('bedrock-grant-nova-sonic');
    expect(check.appliesTo(ctx)).toBe(true);
    const result = await check.run(ctx);
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('amazon.nova-sonic');
  });
});

// ─────────────────────────────────────────────────────────────────────
// 5. service-quotas
// ─────────────────────────────────────────────────────────────────────

describe('service-quotas', () => {
  it('warns when headroom is below a fresh deploy needs, with the increase command', async () => {
    const ctx = makeCtx({}, {
      serviceQuotas: { send: async () => ({ Quota: { Value: 5 } }) },
      ec2: {
        send: async (cmd: unknown) => {
          const name = (cmd as object).constructor.name;
          if (name === 'DescribeAddressesCommand') return { Addresses: [1, 2, 3, 4, 5] }; // 0 headroom
          return { Vpcs: [{}] };
        },
      },
      elbv2: { send: async () => ({ LoadBalancers: [] }) },
    });
    const result = await checkById('service-quotas').run(ctx);
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('EC2 EIPs');
    expect(result.remediation).toContain(
      'aws service-quotas request-service-quota-increase --service-code ec2 --quota-code L-0263D0A3',
    );
  });

  it('never fails on a quota READ error — warns with "could not check"', async () => {
    const ctx = makeCtx({}, {
      serviceQuotas: { send: async () => { throw awsError('AccessDeniedException', 'no servicequotas:GetServiceQuota'); } },
      ec2: { send: async () => ({ Addresses: [], Vpcs: [] }) },
      elbv2: { send: async () => ({ LoadBalancers: [] }) },
    });
    const result = await checkById('service-quotas').run(ctx);
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('could not check');
  });

  it('passes with comfortable headroom', async () => {
    const ctx = makeCtx({}, {
      serviceQuotas: { send: async () => ({ Quota: { Value: 50 } }) },
      ec2: { send: async () => ({ Addresses: [], Vpcs: [] }) },
      elbv2: { send: async () => ({ LoadBalancers: [{ Type: 'application' }] }) },
    });
    const result = await checkById('service-quotas').run(ctx);
    expect(result.status).toBe('pass');
  });
});

// ─────────────────────────────────────────────────────────────────────
// 6. name-collisions
// ─────────────────────────────────────────────────────────────────────

describe('name-collisions', () => {
  const noStacks: AwsClient = {
    send: async () => {
      throw awsError('ValidationError', 'Stack with id CCE-Network does not exist');
    },
  };

  it('fails on a cross-account state-bucket collision (403) and suggests a fresh suffix', async () => {
    const ctx = makeCtx({}, {
      cloudFormation: noStacks,
      s3: {
        send: async () => {
          throw Object.assign(new Error('Forbidden'), {
            name: 'Forbidden',
            $metadata: { httpStatusCode: 403 },
          });
        },
      },
    });
    const result = await checkById('name-collisions').run(ctx);
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('claudeclaw-deploy-123456789012-us-east-1');
    expect(result.remediation).toContain('CCE_NAME_SUFFIX');
  });

  it('passes when the bucket name is free (404)', async () => {
    const ctx = makeCtx({}, {
      cloudFormation: noStacks,
      s3: {
        send: async () => {
          throw Object.assign(new Error('NotFound'), {
            name: 'NotFound',
            $metadata: { httpStatusCode: 404 },
          });
        },
      },
    });
    const result = await checkById('name-collisions').run(ctx);
    expect(result.status).toBe('pass');
    expect(result.detail).toContain('is free');
  });

  it('treats an existing reachable stack + bucket as an existing install', async () => {
    const ctx = makeCtx({ CCE_NAME_SUFFIX: 'staging' }, {
      cloudFormation: { send: async () => ({ Stacks: [{}] }) },
      s3: { send: async () => ({}) },
    });
    const result = await checkById('name-collisions').run(ctx);
    expect(result.status).toBe('pass');
    expect(result.detail).toContain('update in place');
    expect(result.detail).toContain('claudeclaw-staging-deploy-123456789012-us-east-1');
  });
});

// ─────────────────────────────────────────────────────────────────────
// 7. domain-tls
// ─────────────────────────────────────────────────────────────────────

describe('domain-tls', () => {
  it('fails chat mode with no DOMAIN_NAME', async () => {
    const ctx = makeCtx();
    const check = checkById('domain-tls');
    expect(check.appliesTo(ctx)).toBe(true);
    const result = await check.run(ctx);
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('chat mode requires HTTPS/domain');
  });

  it('does not apply to infra-only with no domain', () => {
    const ctx = makeCtx({ CCE_DEPLOY_MODE: 'infra-only' });
    expect(checkById('domain-tls').appliesTo(ctx)).toBe(false);
  });

  it('passes with a covering wildcard cert and hosted zone', async () => {
    const ctx = makeCtx({ DOMAIN_NAME: 'claw.example.com' }, {
      acm: {
        send: async () => ({
          CertificateSummaryList: [
            {
              CertificateArn: 'arn:aws:acm:us-east-1:123456789012:certificate/abc',
              DomainName: 'example.com',
              SubjectAlternativeNameSummaries: ['*.example.com'],
            },
          ],
        }),
      },
      route53: { send: async () => ({ HostedZones: [{ Name: 'example.com.' }] }) },
    });
    const result = await checkById('domain-tls').run(ctx);
    expect(result.status).toBe('pass');
  });

  it('fails per missing piece: no covering cert, no hosted zone', async () => {
    const ctx = makeCtx({ DOMAIN_NAME: 'claw.example.com' }, {
      acm: { send: async () => ({ CertificateSummaryList: [] }) },
      route53: { send: async () => ({ HostedZones: [] }) },
    });
    const result = await checkById('domain-tls').run(ctx);
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('no ISSUED ACM certificate');
    expect(result.detail).toContain('no Route 53 hosted zone');
    expect(result.remediation).toContain('aws acm request-certificate');
  });

  it('skips the Route 53 requirement when ACM_CERT_ARN is pre-provided', async () => {
    const ctx = makeCtx(
      {
        DOMAIN_NAME: 'claw.example.com',
        ACM_CERT_ARN: 'arn:aws:acm:us-east-1:123456789012:certificate/abc',
      },
      {
        acm: {
          send: async () => ({
            CertificateSummaryList: [{ DomainName: 'claw.example.com' }],
          }),
        },
        // route53 stays the deny() fake: it must not be called
      },
    );
    const result = await checkById('domain-tls').run(ctx);
    expect(result.status).toBe('pass');
  });

  it('passes bring-your-own-cert when ACM_CERT_ARN is ISSUED in-region (DOMAIN_NAME blank)', async () => {
    const ctx = makeCtx(
      { ACM_CERT_ARN: 'arn:aws:acm:us-east-1:123456789012:certificate/abc' },
      {
        acm: {
          send: async () => ({
            Certificate: { Status: 'ISSUED', DomainName: 'claw.example.com' },
          }),
        },
      },
    );
    const result = await checkById('domain-tls').run(ctx);
    expect(result.status).toBe('pass');
    expect(result.detail).toContain('ISSUED');
    expect(result.detail).toContain('us-east-1');
  });

  it('fails bring-your-own-cert when the cert is not ISSUED (DOMAIN_NAME blank)', async () => {
    const ctx = makeCtx(
      { ACM_CERT_ARN: 'arn:aws:acm:us-east-1:123456789012:certificate/abc' },
      {
        acm: {
          send: async () => ({ Certificate: { Status: 'PENDING_VALIDATION' } }),
        },
      },
    );
    const result = await checkById('domain-tls').run(ctx);
    expect(result.status).toBe('fail');
    expect(result.remediation).toContain('ISSUED');
  });

  it('fails bring-your-own-cert when the cert ARN is in the wrong region (DOMAIN_NAME blank)', async () => {
    // acm stays deny(): the region check returns before any ACM call is made.
    const ctx = makeCtx({
      ACM_CERT_ARN: 'arn:aws:acm:us-west-2:123456789012:certificate/abc',
    });
    const result = await checkById('domain-tls').run(ctx);
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('us-west-2');
    expect(result.detail).toContain('us-east-1');
  });

  it('warns (not fails) when describe-certificate throws (DOMAIN_NAME blank)', async () => {
    const ctx = makeCtx(
      { ACM_CERT_ARN: 'arn:aws:acm:us-east-1:123456789012:certificate/abc' },
      {
        acm: {
          send: async () => {
            throw awsError('AccessDeniedException', 'denied');
          },
        },
      },
    );
    const result = await checkById('domain-tls').run(ctx);
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('deploy-time');
  });
});

// ─────────────────────────────────────────────────────────────────────
// 8. tunnel-prereq
// ─────────────────────────────────────────────────────────────────────

describe('tunnel-prereq', () => {
  it('applies only to no-domain infra-only installs', () => {
    expect(checkById('tunnel-prereq').appliesTo(makeCtx())).toBe(false);
    expect(
      checkById('tunnel-prereq').appliesTo(makeCtx({ CCE_DEPLOY_MODE: 'infra-only' })),
    ).toBe(true);
    expect(
      checkById('tunnel-prereq').appliesTo(
        makeCtx({ CCE_DEPLOY_MODE: 'infra-only', DOMAIN_NAME: 'claw.example.com' }),
      ),
    ).toBe(false);
  });

  it('passes when session-manager-plugin is on PATH', async () => {
    const ctx = makeCtx({ CCE_DEPLOY_MODE: 'infra-only' }, {}, async () => ({
      code: 0,
      stdout: '1.2.650.0\n',
      stderr: '',
    }));
    const result = await checkById('tunnel-prereq').run(ctx);
    expect(result.status).toBe('pass');
    expect(result.detail).toContain('1.2.650.0');
  });

  it('fails with per-OS install remediation when missing', async () => {
    const ctx = makeCtx({ CCE_DEPLOY_MODE: 'infra-only' }, {}, async () => ({
      code: 127,
      stdout: '',
      stderr: 'spawn session-manager-plugin ENOENT',
    }));
    const result = await checkById('tunnel-prereq').run(ctx);
    expect(result.status).toBe('fail');
    expect(result.remediation).toContain('brew install --cask session-manager-plugin');
    expect(result.remediation).toContain('yum');
    expect(result.remediation).toContain('dpkg');
    expect(result.remediation).toContain('docs.aws.amazon.com');
  });
});

// ─────────────────────────────────────────────────────────────────────
// 9. secrets-pending-deletion
// ─────────────────────────────────────────────────────────────────────

describe('secrets-pending-deletion', () => {
  it('fails with the three options when a fixed-name secret is pending deletion', async () => {
    const ctx = makeCtx({}, {
      secretsManager: {
        send: async (cmd: unknown) => {
          const input = (cmd as { input: { SecretId: string } }).input;
          if (input.SecretId === '/claudeclaw/telegram') {
            return { Name: input.SecretId, DeletedDate: new Date('2026-06-01T00:00:00Z') };
          }
          throw awsError('ResourceNotFoundException', 'not found');
        },
      },
    });
    const result = await checkById('secrets-pending-deletion').run(ctx);
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('/claudeclaw/telegram');
    expect(result.remediation).toContain(
      'aws secretsmanager restore-secret --secret-id /claudeclaw/telegram',
    );
    expect(result.remediation).toContain('--force-delete-without-recovery');
    expect(result.remediation).toMatch(/DESTRUCTIVE/);
    expect(result.remediation).toContain('CCE_NAME_SUFFIX');
  });

  it('passes when names are free or secrets exist without DeletedDate', async () => {
    const ctx = makeCtx({}, {
      secretsManager: {
        send: async (cmd: unknown) => {
          const input = (cmd as { input: { SecretId: string } }).input;
          if (input.SecretId === '/claudeclaw/dashboard') return { Name: input.SecretId };
          throw awsError('ResourceNotFoundException', 'not found');
        },
      },
    });
    const result = await checkById('secrets-pending-deletion').run(ctx);
    expect(result.status).toBe('pass');
  });

  it('uses the suffixed secret base when CCE_NAME_SUFFIX is set', async () => {
    const seen: string[] = [];
    const ctx = makeCtx({ CCE_NAME_SUFFIX: 'staging' }, {
      secretsManager: {
        send: async (cmd: unknown) => {
          seen.push((cmd as { input: { SecretId: string } }).input.SecretId);
          throw awsError('ResourceNotFoundException', 'not found');
        },
      },
    });
    await checkById('secrets-pending-deletion').run(ctx);
    expect(seen).toContain('/claudeclaw-staging/slack');
    expect(seen).toContain('/claudeclaw-staging/bedrock-guardrails');
    expect(seen).toHaveLength(6);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 10. ci-coherence
// ─────────────────────────────────────────────────────────────────────

describe('ci-coherence', () => {
  it('does not apply when both CI paths are off', () => {
    expect(checkById('ci-coherence').appliesTo(makeCtx())).toBe(false);
  });

  it('fails naming the missing GitHub vars when CCE_CICD_ENABLED=1', async () => {
    const ctx = makeCtx({ CCE_CICD_ENABLED: '1' }, {
      iam: { send: async () => ({ ClientIDList: ['sts.amazonaws.com'] }) },
    });
    const result = await checkById('ci-coherence').run(ctx);
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('CCE_GITHUB_OWNER');
    expect(result.detail).toContain('CCE_GITHUB_REPO');
    expect(result.detail).toContain('CCE_GITHUB_DEPLOY_REFS');
  });

  it('fails when the OIDC provider audience lacks sts.amazonaws.com', async () => {
    const ctx = makeCtx(
      {
        CCE_CICD_ENABLED: '1',
        CCE_GITHUB_OWNER: 'someorg',
        CCE_GITHUB_REPO: 'somerepo',
        CCE_GITHUB_DEPLOY_REFS: 'refs/heads/main',
      },
      { iam: { send: async () => ({ ClientIDList: ['other-audience'] }) } },
    );
    const result = await checkById('ci-coherence').run(ctx);
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('sts.amazonaws.com');
    expect(result.remediation).toContain('add-client-id-to-open-id-connect-provider');
  });

  it('warns with the oidc-provider.sh remediation when the provider is missing', async () => {
    const ctx = makeCtx(
      {
        CCE_CICD_ENABLED: '1',
        CCE_GITHUB_OWNER: 'someorg',
        CCE_GITHUB_REPO: 'somerepo',
        CCE_GITHUB_DEPLOY_ENVIRONMENTS: 'production',
      },
      { iam: { send: async () => { throw awsError('NoSuchEntityException', 'no provider'); } } },
    );
    const result = await checkById('ci-coherence').run(ctx);
    expect(result.status).toBe('warn');
    expect(result.remediation).toContain('bash scripts/oidc-provider.sh');
  });

  it('fails CodeBuild mode without a GITHUB source credential, with the import command', async () => {
    const ctx = makeCtx(
      {
        CCE_CODEBUILD_ENABLED: '1',
        CCE_GITHUB_OWNER: 'someorg',
        CCE_GITHUB_REPO: 'somerepo',
      },
      { codeBuild: { send: async () => ({ sourceCredentialsInfos: [] }) } },
    );
    const result = await checkById('ci-coherence').run(ctx);
    expect(result.status).toBe('fail');
    expect(result.remediation).toContain('aws codebuild import-source-credentials');
  });

  it('passes a coherent OIDC + CodeBuild setup', async () => {
    const ctx = makeCtx(
      {
        CCE_CICD_ENABLED: '1',
        CCE_CODEBUILD_ENABLED: '1',
        CCE_GITHUB_OWNER: 'someorg',
        CCE_GITHUB_REPO: 'somerepo',
        CCE_GITHUB_DEPLOY_REFS: 'refs/heads/main',
      },
      {
        iam: { send: async () => ({ ClientIDList: ['sts.amazonaws.com'] }) },
        codeBuild: {
          send: async () => ({ sourceCredentialsInfos: [{ serverType: 'GITHUB' }] }),
        },
      },
    );
    const result = await checkById('ci-coherence').run(ctx);
    expect(result.status).toBe('pass');
  });
});

// ─────────────────────────────────────────────────────────────────────
// 11. mode-readiness-inputs
// ─────────────────────────────────────────────────────────────────────

describe('mode-readiness-inputs', () => {
  it('rejects placeholder-shaped surface tokens in chat mode', async () => {
    const ctx = makeCtx({
      SLACK_BOT_TOKEN: 'REPLACE_ME',
      TELEGRAM_TOKENS_JSON: '<your-telegram-tokens-json>',
    });
    const result = await checkById('mode-readiness-inputs').run(ctx);
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('SLACK_BOT_TOKEN');
    expect(result.detail).toContain('TELEGRAM_TOKENS_JSON');
  });

  it('passes chat mode with one real surface token', async () => {
    const ctx = makeCtx({ SLACK_BOT_TOKEN: '', TELEGRAM_TOKENS_JSON: '{"main":"123:abc"}' });
    const result = await checkById('mode-readiness-inputs').run(ctx);
    expect(result.status).toBe('pass');
    expect(result.detail).toContain('Telegram');
  });

  it('fails infra-only naming the missing pieces', async () => {
    const ctx = makeCtx({
      CCE_DEPLOY_MODE: 'infra-only',
      DASHBOARD_TOKEN: 'REPLACE_ME',
      BEDROCK_SONNET_MODEL: '',
    });
    const result = await checkById('mode-readiness-inputs').run(ctx);
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('DASHBOARD_TOKEN');
    expect(result.detail).toContain('Bedrock model id');
  });

  it('passes infra-only with dashboard token + model', async () => {
    const ctx = makeCtx({ CCE_DEPLOY_MODE: 'infra-only' });
    const result = await checkById('mode-readiness-inputs').run(ctx);
    expect(result.status).toBe('pass');
  });
});

// ─────────────────────────────────────────────────────────────────────
// cost-anomaly-monitor
// ─────────────────────────────────────────────────────────────────────

describe('cost-anomaly-monitor', () => {
  const check = checkById('cost-anomaly-monitor');
  const monitor = {
    MonitorArn: 'arn:aws:ce::123456789012:anomalymonitor/abc',
    MonitorName: 'Default-Services-Monitor',
    MonitorType: 'DIMENSIONAL',
    MonitorDimension: 'SERVICE',
  };

  it('passes without an AWS call when CCE_ANOMALY_MONITOR_ARN is pinned', async () => {
    const ctx = makeCtx({ CCE_ANOMALY_MONITOR_ARN: 'arn:aws:ce::123456789012:anomalymonitor/pinned' });
    const result = await check.run(ctx);
    expect(result.status).toBe('pass');
    expect(result.detail).toContain('anomalymonitor/pinned');
  });

  it('passes and names the existing SERVICE monitor the deploy will attach to', async () => {
    const ctx = makeCtx({}, {
      costExplorer: { send: async () => ({ AnomalyMonitors: [monitor] }) },
    });
    const result = await check.run(ctx);
    expect(result.status).toBe('pass');
    expect(result.detail).toContain('Default-Services-Monitor');
    expect(result.detail).toContain('attach');
  });

  it('passes with the create path when the account has no service monitor', async () => {
    const ctx = makeCtx({}, {
      costExplorer: { send: async () => ({ AnomalyMonitors: [] }) },
    });
    const result = await check.run(ctx);
    expect(result.status).toBe('pass');
    expect(result.detail).toContain('will create one');
  });

  it('warns with remediation when ce:GetAnomalyMonitors is denied', async () => {
    const ctx = makeCtx({}, {
      costExplorer: {
        send: async () => {
          throw Object.assign(new Error('not authorized'), { name: 'AccessDeniedException' });
        },
      },
    });
    const result = await check.run(ctx);
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('AccessDeniedException');
    expect(result.remediation).toContain('CCE_ANOMALY_MONITOR_ARN');
  });
});

// ─────────────────────────────────────────────────────────────────────
// magic-link-email
// ─────────────────────────────────────────────────────────────────────

describe('magic-link-email', () => {
  const check = checkById('magic-link-email');

  it('warns on a fresh .env and points at the dashboard token', async () => {
    const result = await check.run(makeCtx());
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('CCE_EMAIL_FROM');
    expect(result.detail).toContain('CCE_DASHBOARD_URL');
    expect(result.detail).toContain('DASHBOARD_TOKEN');
    expect(result.remediation).toContain('invite');
  });

  it('warns naming only the missing half', async () => {
    const result = await check.run(makeCtx({ CCE_EMAIL_FROM: 'no-reply@example.com' }));
    expect(result.status).toBe('warn');
    expect(result.detail).not.toContain('CCE_EMAIL_FROM,');
    expect(result.detail).toContain('CCE_DASHBOARD_URL');
  });

  it('treats placeholder values as unset', async () => {
    const result = await check.run(
      makeCtx({ CCE_EMAIL_FROM: 'REPLACE_ME', CCE_DASHBOARD_URL: 'https://cce.example.com' }),
    );
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('CCE_EMAIL_FROM');
  });

  it('passes when both are set, still noting SES + invite prerequisites', async () => {
    const result = await check.run(
      makeCtx({ CCE_EMAIL_FROM: 'no-reply@example.com', CCE_DASHBOARD_URL: 'https://cce.example.com' }),
    );
    expect(result.status).toBe('pass');
    expect(result.detail).toContain('no-reply@example.com');
    expect(result.detail).toContain('invited');
  });
});

// ─────────────────────────────────────────────────────────────────────
// runner semantics
// ─────────────────────────────────────────────────────────────────────

describe('runPreflight + summarize', () => {
  it('marks non-applicable checks as skip and survives a crashing check', async () => {
    const ctx = makeCtx({}, {
      // bedrock fake that crashes with a non-Error to exercise the guard
      bedrock: { send: async () => { throw 'boom'; } },
    });
    const results = await runPreflight(ctx, [
      checkById('bedrock-grant-claude'), // fails (list crashes) but never throws
      checkById('tunnel-prereq'), // skip: chat mode
    ]);
    expect(results).toHaveLength(2);
    expect(results[0].status).toBe('fail');
    expect(results[1].status).toBe('skip');
    const summary = summarize(results);
    expect(summary).toEqual({ pass: 0, warn: 0, fail: 1, skip: 1 });
  });
});
