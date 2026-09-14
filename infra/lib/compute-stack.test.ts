/**
 * Synth-level assertions for ComputeStack. Both suites below share one
 * seven-stack harness, `synthCompute`.
 *
 * War Room table wiring (WRT-9, M12). `infra/lib/compute-stack.ts:395-421`
 * exports 25 `TABLE_*` environment variables to the orchestrator container and
 * none of the three War Room ones, so `src/lib/warroom/*` falls back to the
 * unsuffixed literals compiled into `meetings-repo.ts:14-15` and
 * `publisher.ts:6-7`. Production answers correctly only because its `${app}`
 * prefix happens to equal that fallback; a suffixed environment asks for
 * production's table names and is denied, which is why every War Room read on
 * staging returns 500.
 *
 * Orchestrator image pin (release plan P5). The task definition pins the image
 * by DIGEST wherever one is supplied, falls back to the tag chain wherever one
 * is not, and refuses a malformed digest at synth instead of letting CDK render
 * it as a tag that no deploy ever pushed.
 *
 * The expectations below are LITERAL strings, per the A20 convention recorded in
 * `paperclip-stack.test.ts:18-21`: asserting against
 * `RESOURCE_NAMES.ddb.warroomMeetings` would compare the constant the stack used
 * to synthesize the value with itself, and would keep passing under any rename —
 * which is precisely the class of fault this test exists to catch.
 *
 * The synth is hermetic and needs no AWS credentials: `CCE_NAME_SUFFIX` is pinned
 * empty so this is the production name set regardless of the developer's ambient
 * environment, and `DOMAIN_NAME` is pinned empty because a non-empty value takes
 * the `HostedZone.fromLookup` branch at `compute-stack.ts:1103` and would reach
 * AWS. `CCE_IMAGE_DIGEST` is pinned empty too, so a digest exported in the
 * developer's shell cannot change what any case synthesizes. All three are read
 * at import time or during synthesis, so they are stubbed before the stack
 * modules are loaded.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';

const ENV = { account: '637423318609', region: 'us-east-1' };

/**
 * The `TABLE_*` block is a flat literal on the orchestrator container
 * (`compute-stack.ts:323`), not gated on tier, so either tier proves the same
 * wiring. Tier 1 matches the existing orchestrator env assertions in
 * `paperclip-stack.test.ts`.
 */
const TIER = 1;

// Seven stacks are synthesized per case, which takes far longer than Vitest's
// 5 s default. The other infra suites never needed a timeout because they are
// synchronous: a blocked event loop never lets the timer fire. These must be
// async to load the stack modules *after* the environment is stubbed, so the
// timer is live and the budget has to be stated. Observed 9-62 s depending on
// whether the transform cache is warm, hence the generous ceiling.
const BUDGET = 180_000;

interface ContainerDef {
  Name?: string;
  Image?: unknown;
  Environment?: { Name: string; Value: string }[];
}

interface TaskDefProps {
  ContainerDefinitions: ContainerDef[];
}

/**
 * Every container definition in a freshly synthesized ComputeStack.
 *
 * `stubs` override the hermetic defaults, and all of them are applied BEFORE the
 * stack modules are imported: `APP_NAME_SUFFIX` is read when constants.ts is
 * first evaluated (constants.ts:16) and `RESOURCE_NAMES` is frozen from it
 * (constants.ts:236), so a stub set after a static import would arrive too late.
 * Each suite resets the module registry around every case.
 */
async function synthCompute(stubs: Record<string, string> = {}): Promise<ContainerDef[]> {
  const stubbed = { CCE_NAME_SUFFIX: '', DOMAIN_NAME: '', CCE_IMAGE_DIGEST: '', ...stubs };
  for (const [name, value] of Object.entries(stubbed)) vi.stubEnv(name, value);

  const [
    { NetworkStack },
    { StorageStack },
    { SecretsStack },
    { DynamoStack },
    { MessagingStack },
    { IamStack },
    { ComputeStack },
  ] = await Promise.all([
    import('./network-stack.js'),
    import('./storage-stack.js'),
    import('./secrets-stack.js'),
    import('./dynamo-stack.js'),
    import('./messaging-stack.js'),
    import('./iam-stack.js'),
    import('./compute-stack.js'),
  ]);

  const app = new App();
  const net = new NetworkStack(app, 'CCE-Network', { tier: TIER, env: ENV });
  const storage = new StorageStack(app, 'CCE-Storage', { tier: TIER, env: ENV });
  const secrets = new SecretsStack(app, 'CCE-Secrets', {
    tier: TIER,
    env: ENV,
    dataKey: storage.dataKey,
  });
  const dynamo = new DynamoStack(app, 'CCE-Dynamo', {
    tier: TIER,
    env: ENV,
    dataKey: storage.dataKey,
  });
  const messaging = new MessagingStack(app, 'CCE-Messaging', {
    tier: TIER,
    env: ENV,
    configBucket: storage.configBucket,
  });
  const iam = new IamStack(app, 'CCE-Iam', {
    tier: TIER,
    env: ENV,
    storage,
    secrets,
    dynamo,
    messaging,
  });
  const compute = new ComputeStack(app, 'CCE-Compute', {
    tier: TIER,
    env: ENV,
    vpc: net.vpc,
    albSecurityGroup: net.albSecurityGroup,
    fargateSecurityGroup: net.fargateSecurityGroup,
    taskRole: iam.taskRole,
    secrets,
    logsBucket: storage.logsBucket,
    messaging,
  });

  return Object.values(Template.fromStack(compute).findResources('AWS::ECS::TaskDefinition')).flatMap(
    (r) => (r.Properties as TaskDefProps).ContainerDefinitions ?? [],
  );
}

/**
 * The one container with this name. ComputeStack synthesizes more than one task
 * definition (the orchestrator and the consolidation task), and selecting the
 * wrong container would make a test pass or fail for a reason that has nothing
 * to do with what it asserts.
 */
function container(defs: ContainerDef[], name: string): ContainerDef {
  const matches = defs.filter((c) => c.Name === name);
  if (matches.length !== 1) {
    throw new Error(
      `expected one container named "${name}" in the synthesized ComputeStack, found ${matches.length}`,
    );
  }
  return matches[0];
}

describe('ComputeStack — orchestrator War Room table names', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  /**
   * `suffix` is what `CCE_NAME_SUFFIX` would be for the target environment:
   * empty for production, `staging` for staging.
   */
  async function orchestratorEnv(suffix: string): Promise<Record<string, string>> {
    const orchestrator = container(await synthCompute({ CCE_NAME_SUFFIX: suffix }), 'orchestrator');
    return Object.fromEntries((orchestrator.Environment ?? []).map((e) => [e.Name, e.Value]));
  }

  it(
    'exports the three War Room table names to the orchestrator container',
    async () => {
      const env = await orchestratorEnv('');

      expect(env.TABLE_WARROOM_MEETINGS).toBe('claudeclaw-warroom-meetings');
      expect(env.TABLE_WARROOM_TURNS).toBe('claudeclaw-warroom-turns');
      expect(env.TABLE_WARROOM_CONNECTIONS).toBe('claudeclaw-warroom-connections');
    },
    BUDGET,
  );

  /**
   * The reason the fix exists. A suffixed environment has its own War Room
   * tables (`claudeclaw-staging-warroom-*` exist alongside production's), but
   * before this export the orchestrator asked for the unsuffixed production
   * names and the staging task role was denied, so every War Room read 500'd.
   */
  it(
    'carries the suffix through, so a staging deploy reads its own tables',
    async () => {
      const env = await orchestratorEnv('staging');

      expect(env.TABLE_WARROOM_MEETINGS).toBe('claudeclaw-staging-warroom-meetings');
      expect(env.TABLE_WARROOM_TURNS).toBe('claudeclaw-staging-warroom-turns');
      expect(env.TABLE_WARROOM_CONNECTIONS).toBe('claudeclaw-staging-warroom-connections');
    },
    BUDGET,
  );
});

/**
 * Both image consumers are asserted, the `orchestrator` service container
 * (compute-stack.ts:315) and the consolidation `worker` (:804), because a pin
 * that reaches one and not the other leaves half the fleet on a mutable tag.
 * The synthesized `Image` is an `Fn::Join`, so the assertions read its JSON.
 */
describe('ComputeStack — orchestrator image pin (P5)', () => {
  const DIGEST = 'sha256:' + 'a'.repeat(64);

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function images(stubs: Record<string, string>): Promise<string[]> {
    const defs = await synthCompute(stubs);
    return ['orchestrator', 'worker'].map((name) => JSON.stringify(container(defs, name).Image));
  }

  it(
    'pins both image consumers to CCE_IMAGE_DIGEST when one is supplied',
    async () => {
      for (const image of await images({ CCE_IMAGE_DIGEST: DIGEST, CCE_IMAGE_TAG: 'ci' })) {
        expect(image).toContain(`/claudeclaw-orchestrator@${DIGEST}`);
        // The digest replaces the tag; it is never appended to one.
        expect(image).not.toContain('claudeclaw-orchestrator:');
      }
    },
    BUDGET,
  );

  it(
    'refuses a malformed CCE_IMAGE_DIGEST at synth, naming the variable',
    async () => {
      // Only `sha256:` plus 64 lowercase hex is a digest (the release.yml:102
      // pattern). CDK renders anything else as a TAG, so without the guard a
      // pasted tag or a truncated digest would pin an image no deploy pushed.
      // The second value pins the length, not just the prefix.
      for (const malformed of ['bogus', 'sha256:' + 'a'.repeat(63)]) {
        await expect(images({ CCE_IMAGE_DIGEST: malformed, CCE_IMAGE_TAG: 'ci' })).rejects.toThrow(
          /CCE_IMAGE_DIGEST/,
        );
      }
    },
    2 * BUDGET,
  );

  it(
    'keeps the tag chain when the digest is empty',
    async () => {
      // An empty digest is what every driver forwards when it has none, and
      // ci.yml's hermetic synth sets only CCE_IMAGE_TAG=ci. Green before P5.
      for (const image of await images({ CCE_IMAGE_DIGEST: '', CCE_IMAGE_TAG: 'ci' })) {
        expect(image).toContain('/claudeclaw-orchestrator:ci');
        expect(image).not.toContain('@sha256:');
      }
    },
    BUDGET,
  );
});
