/**
 * The stack-set acceptance test for ADR 0010 Phase 9 ("Paperclip installs as
 * part of a standard install").
 *
 * WHY THIS EXISTS, and why it synthesizes the real app instead of reading it:
 *
 * Until Phase 9, `infra/bin/app.ts` OMITTED the Database, Filesystem and
 * Paperclip stacks unless CCE_PAPERCLIP_ENABLED=1. That is the single most
 * dangerous shape a stack list can have, because `cdk deploy A B C` errors
 * only when the TOTAL selected count is zero: a phase-a list naming
 * CCE-Database while synth had omitted it EXITED 0 AND CREATED NO AURORA.
 * A green deploy with nothing behind it (M22), which is how the gate got its
 * reputation for failing silently in one home of five.
 *
 * The Phase 9 shape removes that failure mode by construction: the three
 * stacks are ALWAYS constructed and gated INSIDE (`paperclipProvisioned`),
 * the way SecurityStack gates WAF and BackupStack gates its export Lambda. So
 * the property worth pinning is not "the flag works" but "the stack-name SET
 * does not depend on the flag at all".
 *
 * Nothing else in the tree checks that. The only stack-list assertion before
 * this file was a HAND-TRANSCRIBED literal in
 * `scripts/lib/lifecycle/teardown-plan.test.ts` — a copy of what someone
 * believed `cdk ls` printed, which cannot notice the app disagreeing with it.
 * This test runs the app (`node --import tsx infra/bin/app.ts` with
 * CDK_OUTDIR, which is exactly what the CDK CLI does under `cdk ls`) and reads
 * the cloud assembly manifest, so it compares against the real assembly.
 *
 * It is deliberately slow — a dozen-odd full synths — because the alternative is
 * asserting nothing about the artifact that actually deploys.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const APP_ENTRY = join(REPO_ROOT, 'infra', 'bin', 'app.ts');

/** One synth is ~10-20s on a cold tsx; several of them need real headroom. */
const SYNTH_TIMEOUT_MS = 300_000;

const outDirs: string[] = [];
afterAll(() => {
  for (const dir of outDirs) rmSync(dir, { recursive: true, force: true });
});

interface Assembly {
  outDir: string;
  stackNames: string[];
}

interface TemplateResource {
  Type: string;
  Properties?: Record<string, unknown>;
}

/**
 * Synthesize the app with an explicit environment and return its stack names.
 *
 * The vars this test varies are DELETED first, not merely overwritten: the
 * developer running the suite may well have CCE_PAPERCLIP_ENABLED or a tier
 * exported, and "unset" has to mean unset or the first case tests nothing.
 */
function synth(overrides: Record<string, string>): Assembly {
  const outDir = mkdtempSync(join(tmpdir(), 'cce-stackset-'));
  outDirs.push(outDir);
  const env: NodeJS.ProcessEnv = { ...process.env, CDK_OUTDIR: outDir };
  for (const key of [
    'CCE_PAPERCLIP_ENABLED',
    'CCE_TIER',
    'DEPLOY_TIER',
    'CDK_STACK_NAME',
    'CCE_PAPERCLIP_TEARDOWN',
    'CCE_PAPERCLIP_PROVISION_ENV_OVERRIDE',
  ]) {
    delete env[key];
  }
  Object.assign(env, overrides);
  execFileSync(process.execPath, ['--import', 'tsx', APP_ENTRY], {
    cwd: REPO_ROOT,
    env,
    encoding: 'utf8',
    stdio: 'pipe',
  });
  const manifest = JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf8')) as {
    artifacts: Record<string, { type: string }>;
  };
  const stackNames = Object.entries(manifest.artifacts)
    .filter(([, artifact]) => artifact.type === 'aws:cloudformation:stack')
    .map(([name]) => name)
    .sort();
  return { outDir, stackNames };
}

/**
 * Resource types present in one synthesized template.
 *
 * A Tier 0 Paperclip template comes out of THIS harness with no `Resources`
 * member at all, which CloudFormation would reject — but that is an artifact
 * of synthesizing the app directly: the CDK CLI turns version reporting on and
 * therefore adds an `AWS::CDK::Metadata` resource to every stack, so under
 * `cdk deploy` (both drivers) the empty stacks are valid and deploy as empty.
 * Verified with `CCE_TIER=0 npx cdk synth CCE-Database`.
 */
function resourceTypes(assembly: Assembly, stackName: string): string[] {
  const template = JSON.parse(
    readFileSync(join(assembly.outDir, `${stackName}.template.json`), 'utf8'),
  ) as { Resources?: Record<string, { Type: string }> };
  return Object.values(template.Resources ?? {}).map((r) => r.Type);
}

function templateResources(
  assembly: Assembly,
  stackName: string,
): Record<string, TemplateResource> {
  const template = JSON.parse(
    readFileSync(join(assembly.outDir, `${stackName}.template.json`), 'utf8'),
  ) as { Resources?: Record<string, TemplateResource> };
  return template.Resources ?? {};
}

/** Names in one set and not the other, both directions, for the failure text. */
function symmetricDifference(a: string[], b: string[]): string {
  const inA = a.filter((n) => !b.includes(n));
  const inB = b.filter((n) => !a.includes(n));
  return `only in the first: [${inA.join(', ')}] | only in the second: [${inB.join(', ')}]`;
}

describe('infra/bin/app.ts stack set', () => {
  it(
    'is identical with CCE_PAPERCLIP_ENABLED unset, =0 and =1',
    () => {
      const unset = synth({});
      const off = synth({ CCE_PAPERCLIP_ENABLED: '0' });
      const on = synth({ CCE_PAPERCLIP_ENABLED: '1' });

      // The message carries the symmetric difference rather than a bare
      // boolean, because "18 !== 15" sends the next reader back to `cdk ls`
      // to find out WHICH three moved — which is the whole question.
      expect(off.stackNames, symmetricDifference(unset.stackNames, off.stackNames)).toEqual(
        unset.stackNames,
      );
      expect(on.stackNames, symmetricDifference(unset.stackNames, on.stackNames)).toEqual(
        unset.stackNames,
      );

      // And the set is the one that includes Paperclip, in all three cases —
      // the direction that matters. An app that omitted all three everywhere
      // would also pass the equality above.
      for (const name of ['CCE-Database', 'CCE-Filesystem', 'CCE-Paperclip']) {
        expect(unset.stackNames, `${name} must be in a default install`).toContain(name);
      }
    },
    SYNTH_TIMEOUT_MS,
  );

  it(
    'provisions the Paperclip resources at Tier 1 and none of them at Tier 0',
    () => {
      // The tier is the gate here, so this is where the money decision
      // lives: Tier 0 Hobby gets the three stacks as empty shells (so the
      // stack list, the phase-a deploy list and the teardown plan all stay
      // uniform) and pays for nothing. Assert against the SYNTHESIZED
      // TEMPLATES, not the source, because the source is what we would be
      // guessing about.
      // CCE_PAPERCLIP_TEARDOWN is REQUIRED at Tier 0 now — see the downgrade
      // test below for what it protects. Declaring it here is the honest
      // reading of this case: a Tier 0 install with no substrate to lose.
      const hobby = synth({ CCE_TIER: '0', CCE_PAPERCLIP_TEARDOWN: '1' });
      const standard = synth({ CCE_TIER: '1' });

      expect(hobby.stackNames).toEqual(standard.stackNames);

      expect(resourceTypes(hobby, 'CCE-Database')).not.toContain('AWS::RDS::DBCluster');
      expect(resourceTypes(hobby, 'CCE-Filesystem')).not.toContain('AWS::EFS::FileSystem');
      expect(resourceTypes(hobby, 'CCE-Paperclip')).not.toContain('AWS::ECS::Service');
      // No task definition either: a Tier 0 install must not carry an ECS
      // task pinned to a Paperclip image nobody built for it.
      expect(resourceTypes(hobby, 'CCE-Paperclip')).not.toContain('AWS::ECS::TaskDefinition');

      expect(resourceTypes(standard, 'CCE-Database')).toContain('AWS::RDS::DBCluster');
      expect(resourceTypes(standard, 'CCE-Filesystem')).toContain('AWS::EFS::FileSystem');
      expect(resourceTypes(standard, 'CCE-Paperclip')).toContain('AWS::ECS::Service');
    },
    SYNTH_TIMEOUT_MS,
  );
  it(
    'reads a blank or whitespace tier as Standard, not Hobby',
    () => {
      // `Number('')` is 0 and Tier 0 is the tier that creates NOTHING, so the
      // old bare parse in app.ts read a blank CCE_TIER as Hobby while the
      // deploy driver's clampTier read the same value as Standard: two answers
      // to "does this install provision Aurora". Both now call clampTier.
      //
      // Asserted through the SYNTHESIZED TEMPLATE rather than by unit-testing
      // clampTier alone, because the question is what app.ts does with it.
      for (const blank of ['', ' ']) {
        const assembly = synth({ CCE_TIER: blank });
        expect(
          resourceTypes(assembly, 'CCE-Database'),
          `CCE_TIER=${JSON.stringify(blank)} must synthesize as Tier 1`,
        ).toContain('AWS::RDS::DBCluster');
      }
      // Same rule for the legacy spelling and for an out-of-range value.
      expect(resourceTypes(synth({ DEPLOY_TIER: '' }), 'CCE-Database')).toContain(
        'AWS::RDS::DBCluster',
      );
      expect(resourceTypes(synth({ CCE_TIER: 'banana' }), 'CCE-Database')).toContain(
        'AWS::RDS::DBCluster',
      );
    },
    SYNTH_TIMEOUT_MS,
  );

  it(
    'provisions at Tier 0 when the environment-scoped override is set, same stack set',
    () => {
      // THE REPOSITORY OWNER'S DECISION. Staging stays pinned to Tier 0 so
      // nothing else about it scales up, and provisions the Paperclip substrate
      // anyway — otherwise the tier that CI pins staging to is exactly the tier
      // that provisions no engine, and PRODUCTION would be the first
      // environment ever to run one.
      //
      // Two things are asserted, and the second is the one a tier bump would
      // also satisfy: the stack SET is unchanged (18 names, the property this
      // whole file exists to pin), and CCE-Database is POPULATED — an override
      // that only silenced the guard while still synthesizing an empty Aurora
      // would pass the first check alone.
      const overridden = synth({
        CCE_TIER: '0',
        CCE_PAPERCLIP_PROVISION_ENV_OVERRIDE: '1',
      });
      const standard = synth({ CCE_TIER: '1' });
      expect(
        overridden.stackNames,
        symmetricDifference(standard.stackNames, overridden.stackNames),
      ).toEqual(standard.stackNames);

      expect(resourceTypes(overridden, 'CCE-Database')).toContain('AWS::RDS::DBCluster');
      expect(resourceTypes(overridden, 'CCE-Filesystem')).toContain('AWS::EFS::FileSystem');
      expect(resourceTypes(overridden, 'CCE-Paperclip')).toContain('AWS::ECS::Service');

      // And the guard did NOT fire: reaching this line at all means synth
      // succeeded WITHOUT CCE_PAPERCLIP_TEARDOWN, which the case below proves
      // is otherwise mandatory at Tier 0. The two compose in the only safe
      // direction — the override provisions, so there is no empty substrate to
      // declare.
      const hobby = synth({ CCE_TIER: '0', CCE_PAPERCLIP_TEARDOWN: '1' });
      expect(resourceTypes(hobby, 'CCE-Database')).not.toContain('AWS::RDS::DBCluster');
    },
    SYNTH_TIMEOUT_MS,
  );

  it(
    'makes the Tier 0 staging override reachable through its internal Cloud Map route',
    () => {
      const assembly = synth({
        CCE_TIER: '0',
        CCE_PAPERCLIP_PROVISION_ENV_OVERRIDE: '1',
      });
      const compute = templateResources(assembly, 'CCE-Compute');
      const paperclip = templateResources(assembly, 'CCE-Paperclip');
      const network = templateResources(assembly, 'CCE-Network');

      const orchestrator = Object.values(compute)
        .filter((resource) => resource.Type === 'AWS::ECS::TaskDefinition')
        .flatMap(
          (resource) =>
            (resource.Properties?.ContainerDefinitions ?? []) as Array<{
              Name?: string;
              Environment?: Array<{ Name: string; Value: unknown }>;
            }>,
        )
        .find((container) => container.Name === 'orchestrator');
      expect(orchestrator, 'the real app must synthesize the orchestrator container').toBeDefined();
      expect(
        orchestrator?.Environment?.find((entry) => entry.Name === 'PAPERCLIP_BASE_URL')?.Value,
      ).toBe('http://paperclip.claudeclaw.internal:3100');

      const namespaces = Object.entries(paperclip).filter(
        ([, resource]) => resource.Type === 'AWS::ServiceDiscovery::PrivateDnsNamespace',
      );
      const discoveryServices = Object.entries(paperclip).filter(
        ([, resource]) => resource.Type === 'AWS::ServiceDiscovery::Service',
      );
      expect(namespaces).toHaveLength(1);
      expect(discoveryServices).toHaveLength(1);
      const [namespaceId, namespace] = namespaces[0];
      const [discoveryId, discovery] = discoveryServices[0];
      expect(namespace.Properties?.Name).toBe('claudeclaw.internal');
      expect(discovery.Properties?.Name).toBe('paperclip');
      expect(JSON.stringify(discovery.Properties?.DnsConfig)).toContain(namespaceId);
      const services = Object.values(paperclip).filter(
        (resource) => resource.Type === 'AWS::ECS::Service',
      );
      expect(services).toHaveLength(1);
      expect(JSON.stringify(services[0].Properties?.ServiceRegistries)).toContain(discoveryId);

      const ingress = Object.values(network)
        .filter((resource) => resource.Type === 'AWS::EC2::SecurityGroupIngress')
        .map((resource) => resource.Properties ?? {})
        .filter(
          (properties) =>
            properties.FromPort === 3100 &&
            properties.ToPort === 3100 &&
            /PaperclipSg/.test(JSON.stringify(properties.GroupId)) &&
            /FargateSg/.test(JSON.stringify(properties.SourceSecurityGroupId)),
        );
      expect(ingress).toHaveLength(1);
      expect(ingress[0].IpProtocol).toBe('tcp');
    },
    SYNTH_TIMEOUT_MS,
  );

  it(
    'refuses to synthesize an EMPTY substrate at Tier 0 unless the teardown is declared',
    () => {
      // THE DOWNGRADE DIRECTION, which nothing covered. Making the three
      // stacks unconditional fixed the silent-omission failure (M22) but
      // opened its mirror image: a Tier 0 `cdk deploy --all` no longer SKIPS a
      // provisioned substrate, it UPDATES it to an empty template. The Aurora
      // cluster and EFS are RETAIN + deletion-protected, so they survive as
      // billing orphans outside CloudFormation, and the fixed-name
      // paperclip-db secret enters a 7-day recovery window that blocks
      // re-creating them. Both drivers pass --require-approval never.
      //
      // So the emptying has to be DECLARED, the same way the first armed
      // deploy is. This asserts the refusal, and that the message names the
      // variable that answers it — a throw the reader cannot act on is a
      // deploy that gets unblocked by deleting the check.
      let message = '';
      try {
        synth({ CCE_TIER: '0' });
      } catch (err) {
        message = String((err as { stderr?: Buffer }).stderr ?? '') + String(err);
      }
      expect(message, 'Tier 0 must not synthesize silently').toContain(
        'CCE_PAPERCLIP_TEARDOWN=1',
      );
      expect(message).toContain('EMPTY');
    },
    SYNTH_TIMEOUT_MS,
  );
});
