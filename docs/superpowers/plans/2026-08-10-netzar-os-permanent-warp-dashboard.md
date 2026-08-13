# Netzar OS Permanent WARP Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the PGN Consulting production dashboard privately reachable from enrolled devices without a local AWS/SSM session or `salessly.io`.

**Architecture:** Add an opt-in `cloudflared` sidecar to the existing production Fargate task, an AWS private DNS alias for `dashboard.pgn.internal`, and a dedicated Secrets Manager entry for the tunnel token. The connected Cloudflare API creates the remotely managed tunnel; a lifecycle helper obtains browser authorization and passes that tunnel's token directly into Secrets Manager without printing it. The existing SSM tunnel remains available for break-glass access.

**Tech Stack:** TypeScript, AWS CDK, ECS Fargate, Secrets Manager, Route 53 private DNS, Cloudflare Tunnel, Cloudflare One Client/WARP, Vitest.

## Global Constraints

- The feature flag is `CCE_WARP_PRIVATE_ACCESS=1`; it defaults off for every existing client.
- The default private hostname is exactly `dashboard.pgn.internal`.
- The Cloudflare tunnel name is exactly `netzar-production-private`.
- Do not reuse, modify, or delete the existing `claudeclaw` tunnel or any `salessly.io` resource.
- Never print, persist in `.env`, commit, or include the Cloudflare tunnel token in synth output, logs, or a deploy manifest.
- Use `cloudflare/cloudflared:2026.7.3@sha256:e39ee8da81ad5e05d77f38d2f51c60ca51bf2a8450ac3abab50c17fdb91d91bf` (multi-architecture digest; includes ARM64).
- Before any AWS mutation, `netzer-root` must resolve to AWS account `239887088812`.
- Use only Netzar lifecycle commands for deployment; never run bare `cdk deploy`.
- Stop at typed blockers and cost gates; never run `npm run destroy`.
- Keep `npm run dashboard:tunnel` working as the emergency fallback.

## File responsibility map

- `infra/lib/warp-private-access.ts`: pure feature/configuration resolver.
- `scripts/lib/warp/setup.ts`: secret-safe Cloudflare CLI and Secrets Manager orchestration.
- `scripts/warp-setup.ts`: typed operator command; no secret arguments.
- `infra/lib/secrets-stack.ts` and `infra/lib/interfaces.ts`: encrypted tunnel-token secret contract.
- `infra/lib/compute-stack.ts` and `infra/lib/network-stack.ts`: sidecar, private DNS, and least-privilege network wiring.
- `infra/lib/observability-stack.ts`: always-on running-task alarm.
- `scripts/deploy.ts`: feature env forwarding and secret-readiness gate between foundation and compute.
- `scripts/lib/preflight/checks.ts`: typed prerequisite blockers.
- `scripts/lib/verify/checks.ts`: AWS-side connector/private-posture verification.
- `docs/deployment.md`, `README.md`, `docs/out-of-band-catalog.md`, and `docs/data-flows.json`: operator, ownership, and processor documentation.

---

### Task 1: Define the opt-in configuration contract

**Files:**
- Create: `infra/lib/warp-private-access.ts`
- Create: `infra/lib/warp-private-access.test.ts`
- Modify: `scripts/deploy.ts`
- Modify: `scripts/lib/lifecycle/manifest.ts`

**Interfaces:**
- Produces: `resolveWarpPrivateAccess(env: Record<string, string | undefined>): WarpPrivateAccessConfig`.
- `WarpPrivateAccessConfig` contains `enabled`, `hostname`, `zoneName`, `recordName`, `tunnelName`.

- [ ] **Step 1: Write failing resolver tests**

```ts
it('defaults off without changing existing deploys', () => {
  expect(resolveWarpPrivateAccess({})).toEqual({ enabled: false });
});

it('accepts only no-domain infra-only mode', () => {
  expect(() => resolveWarpPrivateAccess({
    CCE_WARP_PRIVATE_ACCESS: '1',
    CCE_DEPLOY_MODE: 'chat',
  })).toThrow(/requires CCE_DEPLOY_MODE=infra-only/);
});

it('derives the private zone and record', () => {
  expect(resolveWarpPrivateAccess({
    CCE_WARP_PRIVATE_ACCESS: '1',
    CCE_DEPLOY_MODE: 'infra-only',
  })).toEqual({
    enabled: true,
    hostname: 'dashboard.pgn.internal',
    zoneName: 'pgn.internal',
    recordName: 'dashboard',
    tunnelName: 'netzar-production-private',
  });
});

it('rejects salessly.io and public-domain mode', () => {
  for (const env of [
    { CCE_WARP_PRIVATE_ACCESS: '1', CCE_DEPLOY_MODE: 'infra-only', DOMAIN_NAME: 'pgn.example.com' },
    { CCE_WARP_PRIVATE_ACCESS: '1', CCE_DEPLOY_MODE: 'infra-only', CCE_WARP_PRIVATE_HOSTNAME: 'dashboard.salessly.io' },
  ]) expect(() => resolveWarpPrivateAccess(env)).toThrow();
});
```

- [ ] **Step 2: Run the resolver test and confirm RED**

Run: `npm test -- infra/lib/warp-private-access.test.ts`

Expected: FAIL because `warp-private-access.ts` does not exist.

- [ ] **Step 3: Implement the pure resolver**

```ts
export type WarpPrivateAccessConfig =
  | { enabled: false }
  | {
      enabled: true;
      hostname: string;
      zoneName: string;
      recordName: string;
      tunnelName: 'netzar-production-private';
    };

export function resolveWarpPrivateAccess(
  env: Record<string, string | undefined>,
): WarpPrivateAccessConfig {
  if (env.CCE_WARP_PRIVATE_ACCESS !== '1') return { enabled: false };
  if (env.CCE_DEPLOY_MODE !== 'infra-only' || env.DOMAIN_NAME?.trim()) {
    throw new Error('CCE_WARP_PRIVATE_ACCESS=1 requires CCE_DEPLOY_MODE=infra-only and no DOMAIN_NAME');
  }
  const hostname = (env.CCE_WARP_PRIVATE_HOSTNAME ?? 'dashboard.pgn.internal')
    .trim().toLowerCase();
  const labels = hostname.split('.');
  if (labels.length < 3 || labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    throw new Error(`invalid CCE_WARP_PRIVATE_HOSTNAME: ${hostname}`);
  }
  if (hostname === 'salessly.io' || hostname.endsWith('.salessly.io')) {
    throw new Error('salessly.io is prohibited for Netzar private access');
  }
  return {
    enabled: true,
    hostname,
    recordName: labels[0],
    zoneName: labels.slice(1).join('.'),
    tunnelName: 'netzar-production-private',
  };
}
```

- [ ] **Step 4: Forward only non-secret configuration to synth and manifests**

Add these entries to `cdkEnvBag()` in `scripts/deploy.ts` and to the safe input allowlist in `scripts/lib/lifecycle/manifest.ts`:

```ts
CCE_WARP_PRIVATE_ACCESS: env.CCE_WARP_PRIVATE_ACCESS ?? '',
CCE_WARP_PRIVATE_HOSTNAME: env.CCE_WARP_PRIVATE_HOSTNAME ?? '',
```

Do not add a token variable or Cloudflare credential path.

- [ ] **Step 5: Run focused tests and commit**

Run: `npm test -- infra/lib/warp-private-access.test.ts scripts/lib/lifecycle/manifest.test.ts`

Expected: PASS.

```bash
git add infra/lib/warp-private-access.ts infra/lib/warp-private-access.test.ts scripts/deploy.ts scripts/lib/lifecycle/manifest.ts
git commit -m "feat: define private WARP access contract"
```

---

### Task 2: Add the secret-safe WARP setup command

**Files:**
- Create: `scripts/lib/warp/setup.ts`
- Create: `scripts/lib/warp/setup.test.ts`
- Create: `scripts/warp-setup.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `syncWarpTunnelSecret(opts: SyncWarpTunnelSecretOptions): Promise<WarpTunnelResult>`.
- `WarpTunnelResult` is `{ tunnelId: string; tunnelName: 'netzar-production-private'; secretVersionId: string }`.
- Consumes a Cloudflare CLI adapter and a Secrets Manager `{ send }` client so tests never invoke external systems.

- [ ] **Step 1: Write failing tests for idempotency, account safety, and redaction**

```ts
it('reuses the exact tunnel name and writes its token without logging it', async () => {
  const logs: string[] = [];
  const result = await syncWarpTunnelSecret({
    expectedAccountId: '239887088812',
    actualAccountId: '239887088812',
    secretId: '/claudeclaw/cloudflare-tunnel',
    cloudflared: fakeCloudflared({
      tunnels: [{ id: '11111111-1111-4111-8111-111111111111', name: 'netzar-production-private' }],
      token: 'sensitive-tunnel-token',
    }),
    secrets: fakeSecrets(),
    log: (line) => logs.push(line),
  });
  expect(result.tunnelId).toBe('11111111-1111-4111-8111-111111111111');
  expect(logs.join('\n')).not.toContain('sensitive-tunnel-token');
});

it('refuses the wrong AWS account before Cloudflare or Secrets Manager mutation', async () => {
  await expect(syncWarpTunnelSecret({
    expectedAccountId: '239887088812',
    actualAccountId: '000000000000',
    secretId: '/claudeclaw/cloudflare-tunnel',
    cloudflared: denyCloudflared(),
    secrets: denySecrets(),
  })).rejects.toThrow(/expected 239887088812/);
});
```

- [ ] **Step 2: Run the helper test and confirm RED**

Run: `npm test -- scripts/lib/warp/setup.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement direct token transfer without a secret argument**

`syncWarpTunnelSecret()` must:

```ts
const tunnels = JSON.parse(await cloudflared.capture(['tunnel', 'list', '--output', 'json']));
const tunnel = tunnels.find((t: { name?: string }) => t.name === 'netzar-production-private');
if (!tunnel?.id) {
  throw new WarpSetupBlocker(
    'Create the remotely managed `netzar-production-private` tunnel through the connected Cloudflare API, then re-run `npm run warp:setup`.',
  );
}
let token = (await cloudflared.capture(['tunnel', 'token', tunnel.id])).trim();
if (!token || token === 'REPLACE_ME') throw new Error('cloudflared returned no tunnel token');
const put = await secrets.send(new PutSecretValueCommand({
  SecretId: secretId,
  SecretString: JSON.stringify({ token }),
  VersionStages: ['AWSCURRENT', 'CCE-WARP-READY'],
}));
token = '';
```

The real adapter uses `spawn()` with piped stdout, inherited browser/TTY only for `cloudflared tunnel login`, and never includes the token in argv, stderr, progress messages, exceptions, or JSON envelopes.

- [ ] **Step 4: Add the typed operator command**

`scripts/warp-setup.ts` must support `--help`, `--plan`, and `--json`; read `.env`; call STS; fail unless the account is `AWS_ACCOUNT_ID`; and emit this remediation when Cloudflare authorization is missing:

```text
ACTION NEEDED: authorize Cloudflare in the browser with `cloudflared tunnel login`, then re-run `npm run warp:setup`. Do not paste any token into this terminal or chat.
```

If `/claudeclaw[-suffix]/cloudflare-tunnel` does not exist yet, emit:

```text
ACTION NEEDED: run `npm run deploy` once. It will create the retained encrypted tunnel secret during the foundation phase and stop with the exact `npm run warp:setup` remediation. Then re-run this command.
```

If the named remote tunnel is absent, emit the exact connected-API remediation from `WarpSetupBlocker`; do not create a locally managed tunnel as a substitute.

Add to `package.json`:

```json
"warp:setup": "tsx scripts/warp-setup.ts"
```

- [ ] **Step 5: Prove secret redaction and commit**

Run:

```bash
npm test -- scripts/lib/warp/setup.test.ts scripts/ci/secret-scan.test.ts
npm run warp:setup -- --help
npm run warp:setup -- --plan --json
```

Expected: tests PASS; help/plan perform zero external mutations and output no secret value.

```bash
git add package.json scripts/warp-setup.ts scripts/lib/warp/setup.ts scripts/lib/warp/setup.test.ts
git commit -m "feat: add secret-safe WARP setup lifecycle"
```

---

### Task 3: Synthesize the tunnel secret, sidecar, and private DNS

**Files:**
- Modify: `infra/lib/constants.ts`
- Modify: `infra/lib/constants.test.ts`
- Modify: `infra/lib/interfaces.ts`
- Modify: `infra/lib/secrets-stack.ts`
- Modify: `infra/lib/compute-stack.ts`
- Modify: `infra/lib/network-stack.ts`
- Modify: `infra/lib/observability-stack.ts`
- Modify: `infra/bin/app.ts`
- Create: `infra/lib/warp-compute.test.ts`
- Create: `infra/lib/warp-network.test.ts`
- Create: `infra/lib/warp-observability.test.ts`

**Interfaces:**
- Adds `cloudflareTunnelSecret: ISecret` to `SecretsOutputs`.
- Consumes `resolveWarpPrivateAccess(process.env)` from Task 1.
- Sidecar receives only the Secrets Manager JSON field `token` as `TUNNEL_TOKEN`.

- [ ] **Step 1: Write failing source/synth contract tests**

```ts
it('adds no cloudflared resources when the feature is off', () => {
  expect(resolveWarpPrivateAccess({}).enabled).toBe(false);
});

it('pins cloudflared and injects the token as an ECS secret', () => {
  expect(computeSource).toContain('cloudflare/cloudflared:2026.7.3@sha256:e39ee8da81ad5e05d77f38d2f51c60ca51bf2a8450ac3abab50c17fdb91d91bf');
  expect(computeSource).toMatch(/TUNNEL_TOKEN:\s*EcsSecret\.fromSecretsManager\([^,]+, 'token'\)/);
  expect(computeSource).not.toMatch(/TUNNEL_TOKEN:\s*process\.env/);
});

it('creates only a Route 53 private hosted zone for the WARP name', () => {
  expect(computeSource).toContain('new PrivateHostedZone');
  expect(computeSource).toContain('resolveWarpPrivateAccess(process.env)');
});

it('allows the sidecar security group to reach only the internal ALB HTTP listener', () => {
  expect(networkSource).toMatch(/warp\.enabled[\s\S]*fargateSecurityGroup[\s\S]*Port\.tcp\(80\)/);
  expect(networkSource).toMatch(/else[\s\S]*Peer\.anyIpv4\(\)/);
});
```

- [ ] **Step 2: Run the test and confirm RED**

Run: `npm test -- infra/lib/warp-compute.test.ts`

Expected: FAIL because the secret, sidecar, and zone are absent.

- [ ] **Step 3: Add the encrypted secret shape**

Add `cloudflareTunnel` beside the other deterministic secret names in `RESOURCE_NAMES.secrets`, with value `/${app}/cloudflare-tunnel`. Extend `SecretsOutputs`, add `public readonly cloudflareTunnelSecret`, and create:

```ts
this.cloudflareTunnelSecret = makeSecret(
  'SecretCloudflareTunnel',
  RESOURCE_NAMES.secrets.cloudflareTunnel,
  'Cloudflare Tunnel connector token for private WARP access',
  ['token'],
);
```

Use `RemovalPolicy.RETAIN` and the existing data KMS key through `makeSecret()`.

- [ ] **Step 4: Add the essential ARM64-compatible sidecar**

When `warp.enabled` is true, add:

```ts
taskDef.addContainer('cloudflared', {
  image: ContainerImage.fromRegistry(
    'cloudflare/cloudflared:2026.7.3@sha256:e39ee8da81ad5e05d77f38d2f51c60ca51bf2a8450ac3abab50c17fdb91d91bf',
  ),
  containerName: 'cloudflared',
  essential: true,
  cpu: 64,
  memoryReservationMiB: 128,
  command: ['tunnel', '--no-autoupdate', '--loglevel', 'info', '--metrics', '0.0.0.0:2000', 'run'],
  secrets: {
    TUNNEL_TOKEN: EcsSecret.fromSecretsManager(cloudflareTunnelSecret, 'token'),
  },
  logging: LogDrivers.awsLogs({ streamPrefix: 'cloudflared', logGroup }),
  healthCheck: {
    command: ['CMD', 'cloudflared', 'tunnel', 'ready', '--metrics', 'localhost:2000'],
    interval: Duration.seconds(30),
    timeout: Duration.seconds(5),
    retries: 3,
    startPeriod: Duration.seconds(30),
  },
});
```

- [ ] **Step 5: Add the private DNS alias after the internal ALB exists**

```ts
const warpZone = new PrivateHostedZone(this, 'WarpPrivateHostedZone', {
  zoneName: warp.zoneName,
  vpc: props.vpc,
});
new ARecord(this, 'WarpPrivateDashboardAlias', {
  zone: warpZone,
  recordName: warp.recordName,
  target: RecordTarget.fromAlias(new LoadBalancerTarget(this.loadBalancer)),
});
new CfnOutput(this, 'WarpPrivateDashboardUrl', {
  value: `http://${warp.hostname}/dashboard`,
});
```

Guard all three resources behind `warp.enabled`; retain the internal ALB and ECS Exec behavior.

- [ ] **Step 6: Restrict the WARP-enabled internal ALB security group**

In `NetworkStack`, resolve WARP configuration after creating both security groups. Preserve today's public rules when the feature is off. When it is on, omit world ingress and allow only the task security group to the internal listener:

```ts
if (warp.enabled) {
  this.albSecurityGroup.addIngressRule(
    this.fargateSecurityGroup,
    Port.tcp(80),
    'cloudflared sidecar to private dashboard ALB',
  );
} else {
  this.albSecurityGroup.addIngressRule(Peer.anyIpv4(), Port.tcp(443), 'HTTPS in');
  this.albSecurityGroup.addIngressRule(Peer.anyIpv4(), Port.tcp(80), 'HTTP redirect in');
}
```

- [ ] **Step 7: Alarm when the production service is not always on**

In `ObservabilityStack`, add a WARP-gated CloudWatch alarm using `ECS/ContainerInsights` `RunningTaskCount`, dimensions `ClusterName=RESOURCE_NAMES.ecsCluster` and `ServiceName=RESOURCE_NAMES.fargateService`, statistic `Minimum`, threshold `1`, comparison `LESS_THAN_THRESHOLD`, and `TreatMissingData.BREACHING`. Attach the existing ops-alert SNS action. Add the alarm name prefix to `PowerSwitchStack.mutedAlarms` in `infra/bin/app.ts` so an explicitly requested manual pause does not create a false incident.

The test must prove the alarm is absent by default and present only with `CCE_WARP_PRIVATE_ACCESS=1`.

- [ ] **Step 8: Run tests, synth both modes, and commit**

Run:

```bash
npm test -- infra/lib/warp-private-access.test.ts infra/lib/warp-compute.test.ts infra/lib/warp-network.test.ts infra/lib/warp-observability.test.ts infra/lib/compute-mode.test.ts infra/lib/constants.test.ts
npm run synth
CCE_WARP_PRIVATE_ACCESS=1 CCE_DEPLOY_MODE=infra-only npm run synth
node scripts/ci/secret-scan.mjs
```

Expected: both synths succeed; only the enabled synth contains the sidecar/private zone; secret scan passes.

```bash
git add infra/bin/app.ts infra/lib/constants.ts infra/lib/constants.test.ts infra/lib/interfaces.ts infra/lib/secrets-stack.ts infra/lib/compute-stack.ts infra/lib/network-stack.ts infra/lib/observability-stack.ts infra/lib/warp-compute.test.ts infra/lib/warp-network.test.ts infra/lib/warp-observability.test.ts
git commit -m "feat: run private WARP connector in ECS"
```

---

### Task 4: Add typed deployment and preflight gates

**Files:**
- Modify: `scripts/lib/preflight/checks.ts`
- Modify: `scripts/lib/preflight/checks.test.ts`
- Modify: `scripts/deploy.ts`
- Modify: `scripts/deploy.test.ts`
- Modify: `scripts/cost-estimate.mjs`

**Interfaces:**
- Produces preflight check id `warp-private-access-prereq`.
- Deploy consumes Secrets Manager stage `CCE-WARP-READY` without reading its value.

- [ ] **Step 1: Write failing typed-blocker tests**

```ts
it('applies only when private WARP access is enabled', () => {
  expect(checkById('warp-private-access-prereq').appliesTo(makeCtx({}))).toBe(false);
  expect(checkById('warp-private-access-prereq').appliesTo(makeCtx({
    CCE_WARP_PRIVATE_ACCESS: '1', CCE_DEPLOY_MODE: 'infra-only',
  }))).toBe(true);
});

it('names the Cloudflare browser login when cloudflared is unavailable', async () => {
  const result = await runWarpPrereqWithMissingCloudflared();
  expect(result.status).toBe('fail');
  expect(result.remediation).toContain('cloudflared tunnel login');
  expect(result.remediation).not.toMatch(/paste|token value/i);
});

it('deploy names warp:setup when the foundation secret is not ready', async () => {
  const result = await runDeployWithMissingWarpReadyStage();
  expect(result.error).toContain('npm run warp:setup');
  expect(result.mutatedCompute).toBe(false);
});
```

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `npm test -- scripts/lib/preflight/checks.test.ts scripts/deploy.test.ts`

Expected: FAIL because the check and deploy gate do not exist.

- [ ] **Step 3: Add prerequisite checks**

When enabled, fail with typed remediation if `cloudflared --version` is unavailable or local Cloudflare authorization is missing. Do not inspect the AWS secret here: the first lifecycle run must be allowed to create it in phase a.

- [ ] **Step 4: Gate phase d on secret readiness**

After phase a creates the Secrets stack and before phase d deploys Compute:

```ts
if (env.CCE_WARP_PRIVATE_ACCESS === '1') {
  const ready = await hasSecretStage(secretsClient, `${secretBase}/cloudflare-tunnel`, 'CCE-WARP-READY');
  if (!ready) {
    throw new DeployAbort(
      'ACTION NEEDED: run `npm run warp:setup`; it opens Cloudflare authorization and transfers the connector token directly to AWS Secrets Manager without displaying it. Then re-run `npm run deploy`.',
    );
  }
}
```

Do not accept `CLOUDFLARE_API_TOKEN`, `TUNNEL_TOKEN`, or a token CLI flag.

- [ ] **Step 5: Include the private hosted-zone cost**

When enabled, add the existing `route53HostedZoneMonth` value (`0.5`) to the cost estimate with label `Route 53 private hosted zone`. The sidecar shares the existing task and adds no second Fargate service.

- [ ] **Step 6: Run tests and commit**

Run: `npm test -- scripts/lib/preflight/checks.test.ts scripts/deploy.test.ts`

Expected: PASS.

```bash
git add scripts/lib/preflight/checks.ts scripts/lib/preflight/checks.test.ts scripts/deploy.ts scripts/deploy.test.ts scripts/cost-estimate.mjs
git commit -m "feat: gate deploy on private WARP readiness"
```

---

### Task 5: Extend verification and operator documentation

**Files:**
- Modify: `scripts/lib/verify/checks.ts`
- Modify: `scripts/lib/verify/checks.test.ts`
- Modify: `docs/deployment.md`
- Modify: `README.md`
- Modify: `docs/out-of-band-catalog.md`
- Modify: `docs/data-flows.json`

**Interfaces:**
- Produces verify check id `warp-private-access`.
- Preserves `private-posture` and `dashboard:tunnel` behavior.

- [ ] **Step 1: Write failing verification tests**

```ts
it('passes only when the service is running and the task definition has an essential cloudflared container', async () => {
  const result = await runWarpCheck({
    service: { desiredCount: 1, runningCount: 1 },
    containerDefinitions: [{ name: 'cloudflared', essential: true, healthCheck: { command: ['CMD', 'cloudflared', 'tunnel', 'ready'] } }],
  });
  expect(result.status).toBe('pass');
});

it('fails when WARP is enabled but the connector is absent', async () => {
  const result = await runWarpCheck({ service: { desiredCount: 1, runningCount: 1 }, containerDefinitions: [] });
  expect(result.status).toBe('fail');
  expect(result.remediation).toContain('npm run deploy');
});

it('fails when desiredCount is zero', async () => {
  const result = await runWarpCheck({ service: { desiredCount: 0, runningCount: 0 }, containerDefinitions: [] });
  expect(result.status).toBe('fail');
  expect(result.detail).toContain('always-on floor');
});
```

- [ ] **Step 2: Run the verify test and confirm RED**

Run: `npm test -- scripts/lib/verify/checks.test.ts`

Expected: FAIL because `warp-private-access` does not exist.

- [ ] **Step 3: Implement AWS-side verification**

When enabled, use ECS `DescribeServices` and `DescribeTaskDefinition` to prove desired/running counts are at least one and the deployed revision has an essential `cloudflared` container, a non-literal `TUNNEL_TOKEN` secret reference, and the readiness command. Continue to require the internal-ALB/no-world-ingress `private-posture` check. Do not fetch the Cloudflare secret value.

- [ ] **Step 4: Document access, ownership, and data flow**

Document this exact operator sequence:

```bash
aws login --profile netzer-root
aws sts get-caller-identity --profile netzer-root --query Account --output text
AWS_PROFILE=netzer-root npm run deploy
AWS_PROFILE=netzer-root npm run warp:setup
AWS_PROFILE=netzer-root npm run deploy
AWS_PROFILE=netzer-root npm run verify
```

State that the first deploy may stop after foundation with the `warp:setup` remediation; rerunning is idempotent. Add Cloudflare to `docs/data-flows.json` for identity/network metadata only. Catalog the Cloudflare tunnel, private-hostname route, enrollment policy, and Gateway policy as out-of-band resources owned by the client Cloudflare account.

Document rollback exactly: first prove `npm run dashboard:tunnel` works, set `CCE_WARP_PRIVATE_ACCESS=0`, redeploy with `AWS_PROFILE=netzer-root npm run deploy`, verify the sidecar/private zone are absent, and only then delete the new `dashboard.pgn.internal` route and `netzar-production-private` tunnel. Never run `npm run destroy`, and never touch `claudeclaw` or `salessly.io`.

- [ ] **Step 5: Run verification and documentation checks**

Run:

```bash
npm test -- scripts/lib/verify/checks.test.ts
node scripts/ci/docs-links.mjs
node scripts/ci/runnable-blocks.mjs
node scripts/ci/diagrams-drift.mjs
git diff --check
```

Expected: all checks PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/verify/checks.ts scripts/lib/verify/checks.test.ts docs/deployment.md README.md docs/out-of-band-catalog.md docs/data-flows.json
git commit -m "docs: operate and verify private WARP access"
```

---

### Task 6: Activate production through explicit external gates

**Files:**
- No source changes unless verification reveals a defect.

**Interfaces:**
- Consumes all previous tasks.
- Produces a healthy Cloudflare tunnel and enrolled-device dashboard access.

- [ ] **Step 1: Run the full repository gate before external mutation**

Run:

```bash
AWS_EC2_METADATA_DISABLED=true AWS_CONFIG_FILE=/dev/null AWS_SHARED_CREDENTIALS_FILE=/dev/null npm test
npm run typecheck
npm run build
cd web && npm run typecheck && npm run build
```

Expected: full suite, root typecheck/build, and dashboard typecheck/build PASS.

- [ ] **Step 2: Refresh temporary AWS authentication and verify the account**

Run the browser login, then verify the output is exactly `239887088812`:

```bash
aws login --profile netzer-root
aws sts get-caller-identity --profile netzer-root --query Account --output text
```

If the account differs, stop with no AWS mutation.

- [ ] **Step 3: Run the Netzar lifecycle and obey typed gates**

Run `npm run deploy` with `AWS_PROFILE=netzer-root`. Do not add `--yes`. At the cost confirmation, report the exact new estimate and wait for the user's confirmation unless the lifecycle recognizes the existing approved production gate.

- [ ] **Step 4: Create the remote tunnel and authorize without handling a token**

Using the connected Cloudflare API, create the remotely managed tunnel `netzar-production-private` only if it does not exist. When the typed blocker appears, run `npm run warp:setup`; the user completes only the `cloudflared tunnel login` browser authorization. Confirm the command reports the named tunnel and a Secrets Manager version ID but no token, then rerun `npm run deploy`.

- [ ] **Step 5: Create the private hostname and Zero Trust policies**

Using the connected Cloudflare API, create only:

- a Tunnel Hostname route for `dashboard.pgn.internal` to `netzar-production-private`;
- a WARP enrollment rule for the explicitly approved identity;
- a Gateway network policy allowing that enrolled identity/device to `dashboard.pgn.internal` on TCP 80;
- a deny rule for all other identities/devices to that hostname.

Do not change the `salessly.io` zone, the `claudeclaw` tunnel, or unrelated Access applications.

- [ ] **Step 6: Verify enrolled and unenrolled behavior**

On an enrolled device with the Cloudflare One Client connected, open:

```text
http://dashboard.pgn.internal/dashboard
```

Expected: dashboard token authentication appears and the dashboard loads. On an unenrolled device, the hostname must not resolve or connect.

- [ ] **Step 7: Run final AWS and fallback verification**

Run:

```bash
npm run verify
npm run dashboard:tunnel
```

Expected: verify is green; the SSM fallback still exposes `http://localhost:3000/dashboard`. Stop the fallback after confirming it works; WARP remains available because it runs in ECS.

- [ ] **Step 8: Commit any test-only corrections, request review, and publish**

If no corrections were needed, create no empty commit. Otherwise commit only the verified correction. Use the repository's standard review workflow, then push the implementation branch and open a PR to `development`. Do not merge or promote to production until checks and review are green.
