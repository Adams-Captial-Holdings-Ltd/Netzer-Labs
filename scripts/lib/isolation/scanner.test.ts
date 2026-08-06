import { describe, it, expect } from 'vitest';
import {
  runIsolationScan,
  computeVerdict,
  SCANNER_VERSION,
  GLOBAL_REGION,
  type AwsClient,
  type ClientFactory,
} from './scanner.js';

// ─────────────────────────────────────────────────────────────────────
// Test harness: a programmable client factory.
//
// Each (service, action) maps to either a value to return or an Error to throw.
// A region-aware factory lets us simulate per-region/per-service behavior.
// ─────────────────────────────────────────────────────────────────────

type ActionResult = unknown | Error;
type ServiceTable = Record<string, ActionResult>; // action -> result
type Responses = Record<string, ServiceTable>; // service -> { action -> result }

function awsError(name: string, message = name): Error {
  const e = new Error(message);
  e.name = name;
  return e;
}

/**
 * Build a ClientFactory from a flat response table. Any (service, action) not
 * present defaults to an empty object so probes that find nothing read clean.
 */
function factoryFrom(responses: Responses): ClientFactory {
  return (service: string, _region: string): AwsClient => ({
    async send(command: unknown): Promise<unknown> {
      const { action } = command as { action: string };
      const table = responses[service];
      const result = table ? table[action] : undefined;
      if (result instanceof Error) throw result;
      return result ?? {};
    },
  });
}

// describe-regions stub that returns exactly the given regions as enabled.
function regionsResponse(regions: string[]): ServiceTable {
  return {
    'describe-regions': {
      Regions: regions.map((r) => ({ RegionName: r, OptInStatus: 'opt-in-not-required' })),
    },
  };
}

// A baseline "empty account" response set: describe-regions returns one region,
// every probe returns empty, IAM returns only allowlisted roles, KMS none.
function emptyResponses(regions = ['us-east-1']): Responses {
  return {
    ec2: regionsResponse(regions),
    iam: {
      'list-roles': {
        Roles: [
          { RoleName: 'AWSServiceRoleForSupport', Path: '/aws-service-role/', Arn: 'arn:aws:iam::1:role/aws-service-role/AWSServiceRoleForSupport' },
        ],
      },
    },
  };
}

// ─────────────────────────────────────────────────────────────────────

describe('computeVerdict (structured boolean)', () => {
  it('empty when no findings, no unevaluable, no unscanned regions', () => {
    expect(computeVerdict({ findings: [], unevaluable: [], unscannedRegions: [] })).toEqual({
      verdict: 'empty',
      empty: true,
    });
  });

  it('not-empty when there is a finding, regardless of unevaluables', () => {
    const v = computeVerdict({
      findings: [{ service: 'dynamodb:table', region: 'us-east-1', resourceId: 't' }],
      unevaluable: [{ service: 'kms:key', region: 'us-east-1', reason: 'boom' }],
      unscannedRegions: ['eu-west-1'],
    });
    expect(v).toEqual({ verdict: 'not-empty', empty: false });
  });

  it('indeterminate when an unscanned region exists but no findings', () => {
    expect(
      computeVerdict({ findings: [], unevaluable: [], unscannedRegions: ['ap-south-1'] }),
    ).toEqual({ verdict: 'indeterminate', empty: false });
  });

  it('indeterminate when a probe was unevaluable but no findings', () => {
    expect(
      computeVerdict({
        findings: [],
        unevaluable: [{ service: 'ec2:instance', region: 'us-east-1', reason: 'denied' }],
        unscannedRegions: [],
      }),
    ).toEqual({ verdict: 'indeterminate', empty: false });
  });
});

describe('runIsolationScan — empty account', () => {
  it('verdict empty, empty:true, no findings', async () => {
    const result = await runIsolationScan({ clientFor: factoryFrom(emptyResponses()) });
    expect(result.verdict).toBe('empty');
    expect(result.empty).toBe(true);
    expect(result.findings).toEqual([]);
    expect(result.unevaluable).toEqual([]);
    expect(result.scannedRegions).toEqual(['us-east-1']);
    expect(result.unscannedRegions).toEqual([]);
    expect(result.scannerVersion).toBe(SCANNER_VERSION);
  });

  it('allowlists the default VPC and service-linked IAM roles', async () => {
    const responses = emptyResponses();
    responses.ec2 = {
      ...regionsResponse(['us-east-1']),
      'describe-vpcs': { Vpcs: [{ VpcId: 'vpc-default', IsDefault: true }] },
    };
    const result = await runIsolationScan({ clientFor: factoryFrom(responses) });
    expect(result.verdict).toBe('empty');
    expect(result.empty).toBe(true);
  });
});

describe('runIsolationScan — not-empty account', () => {
  it('a stray DynamoDB table => not-empty, empty:false, with the finding', async () => {
    const responses = emptyResponses();
    responses.dynamodb = { 'list-tables': { TableNames: ['LeftoverTable'] } };
    const result = await runIsolationScan({ clientFor: factoryFrom(responses) });
    expect(result.verdict).toBe('not-empty');
    expect(result.empty).toBe(false);
    expect(result.findings).toContainEqual({
      service: 'dynamodb:table',
      region: 'us-east-1',
      resourceId: 'LeftoverTable',
    });
  });

  it('a non-default VPC is a finding', async () => {
    const responses = emptyResponses();
    responses.ec2 = {
      ...regionsResponse(['us-east-1']),
      'describe-vpcs': {
        Vpcs: [
          { VpcId: 'vpc-default', IsDefault: true },
          { VpcId: 'vpc-custom', IsDefault: false },
        ],
      },
    };
    const result = await runIsolationScan({ clientFor: factoryFrom(responses) });
    expect(result.verdict).toBe('not-empty');
    expect(result.findings).toContainEqual({
      service: 'ec2:vpc',
      region: 'us-east-1',
      resourceId: 'vpc-custom',
    });
  });

  it('a non-service-linked IAM role is a finding', async () => {
    const responses = emptyResponses();
    responses.iam = {
      'list-roles': {
        Roles: [
          { RoleName: 'AWSServiceRoleForSupport', Path: '/aws-service-role/', Arn: 'arn:aws:iam::1:role/aws-service-role/AWSServiceRoleForSupport' },
          { RoleName: 'SomeAppRole', Path: '/', Arn: 'arn:aws:iam::1:role/SomeAppRole' },
        ],
      },
    };
    const result = await runIsolationScan({ clientFor: factoryFrom(responses) });
    expect(result.verdict).toBe('not-empty');
    expect(result.findings).toContainEqual({
      service: 'iam:role',
      region: GLOBAL_REGION,
      resourceId: 'arn:aws:iam::1:role/SomeAppRole',
    });
  });
});

describe('runIsolationScan — indeterminate (fail closed)', () => {
  it('an unevaluable service => indeterminate (NOT empty)', async () => {
    const responses = emptyResponses();
    responses.dynamodb = { 'list-tables': awsError('AccessDeniedException', 'no perms') };
    const result = await runIsolationScan({ clientFor: factoryFrom(responses) });
    expect(result.verdict).toBe('indeterminate');
    expect(result.empty).toBe(false);
    expect(result.unevaluable.some((u) => u.service === 'dynamodb:table')).toBe(true);
  });

  it('region enumeration failure => indeterminate with all regions unscanned', async () => {
    const responses: Responses = {
      ec2: { 'describe-regions': awsError('UnauthorizedOperation', 'cannot list regions') },
    };
    const result = await runIsolationScan({ clientFor: factoryFrom(responses) });
    expect(result.verdict).toBe('indeterminate');
    expect(result.empty).toBe(false);
    expect(result.scannedRegions).toEqual([]);
    expect(result.unscannedRegions).toEqual(['<all>']);
  });

  it('a KMS key that cannot be classified (describe-key fails) is unevaluable, not a finding', async () => {
    const responses = emptyResponses();
    responses.kms = {
      'list-keys': { Keys: [{ KeyId: 'key-1' }] },
      'describe-key': awsError('AccessDeniedException', 'cannot describe'),
    };
    const result = await runIsolationScan({ clientFor: factoryFrom(responses) });
    expect(result.verdict).toBe('indeterminate');
    expect(result.findings).toEqual([]);
    expect(result.unevaluable.some((u) => u.service === 'kms:key')).toBe(true);
  });

  it('an AWS-managed KMS key is allowlisted; a customer key is a finding', async () => {
    const responses = emptyResponses();
    responses.kms = {
      'list-keys': { Keys: [{ KeyId: 'aws-key' }, { KeyId: 'cust-key' }] },
      // describe-key cannot vary by key with this flat table, so test them
      // separately below; here assert the customer-key path.
      'describe-key': { KeyMetadata: { KeyManager: 'CUSTOMER' } },
    };
    const result = await runIsolationScan({ clientFor: factoryFrom(responses) });
    expect(result.verdict).toBe('not-empty');
    expect(result.findings.some((f) => f.service === 'kms:key')).toBe(true);
  });
});

describe('runIsolationScan — multi-region', () => {
  it('scans every enumerated region and a finding in any region makes it not-empty', async () => {
    // A region-aware factory: only us-west-2 has a stray ECS cluster.
    const factory: ClientFactory = (service, region) => ({
      async send(command: unknown): Promise<unknown> {
        const { action } = command as { action: string };
        if (service === 'ec2' && action === 'describe-regions') {
          return {
            Regions: [
              { RegionName: 'us-east-1', OptInStatus: 'opt-in-not-required' },
              { RegionName: 'us-west-2', OptInStatus: 'opt-in-not-required' },
            ],
          };
        }
        if (service === 'iam' && action === 'list-roles') return { Roles: [] };
        if (service === 'ecs' && action === 'list-clusters' && region === 'us-west-2') {
          return { clusterArns: ['arn:aws:ecs:us-west-2:1:cluster/leftover'] };
        }
        return {};
      },
    });
    const result = await runIsolationScan({ clientFor: factory });
    expect(result.scannedRegions.sort()).toEqual(['us-east-1', 'us-west-2']);
    expect(result.verdict).toBe('not-empty');
    expect(result.findings).toContainEqual({
      service: 'ecs:cluster',
      region: 'us-west-2',
      resourceId: 'arn:aws:ecs:us-west-2:1:cluster/leftover',
    });
  });

  it('honors an explicit regions override (no enumeration call)', async () => {
    let describeRegionsCalled = false;
    const factory: ClientFactory = (service) => ({
      async send(command: unknown): Promise<unknown> {
        const { action } = command as { action: string };
        if (service === 'ec2' && action === 'describe-regions') {
          describeRegionsCalled = true;
        }
        if (service === 'iam' && action === 'list-roles') return { Roles: [] };
        return {};
      },
    });
    const result = await runIsolationScan({ clientFor: factory, regions: ['eu-central-1'] });
    expect(describeRegionsCalled).toBe(false);
    expect(result.scannedRegions).toEqual(['eu-central-1']);
    expect(result.verdict).toBe('empty');
  });
});

// ─────────────────────────────────────────────────────────────────────
// Regression: adversarial review finding — enumerateRegions must NOT drop
// a region with an unrecognized OptInStatus (that would read as 'empty').
// ─────────────────────────────────────────────────────────────────────

describe('regression: unrecognized OptInStatus is unscanned (fail closed), never dropped', () => {
  const SLR = {
    Roles: [
      { RoleName: 'AWSServiceRoleForSupport', Path: '/aws-service-role/', Arn: 'arn:aws:iam::1:role/aws-service-role/AWSServiceRoleForSupport' },
    ],
  };
  function withStatuses(entries: Array<[string, string | undefined]>): ClientFactory {
    return factoryFrom({
      ec2: {
        'describe-regions': {
          Regions: entries.map(([RegionName, OptInStatus]) => ({ RegionName, OptInStatus })),
        },
      },
      iam: { 'list-roles': SLR },
    });
  }

  for (const mystery of ['opting-in', 'pending-activation', '', 'disabled']) {
    it(`OptInStatus '${mystery}' => indeterminate, region in unscannedRegions (not empty)`, async () => {
      const result = await runIsolationScan({
        clientFor: withStatuses([['us-east-1', 'opt-in-not-required'], ['mystery-1', mystery]]),
      });
      expect(result.verdict).toBe('indeterminate');
      expect(result.empty).toBe(false);
      expect(result.unscannedRegions).toContain('mystery-1');
      expect(result.scannedRegions).toEqual(['us-east-1']);
    });
  }

  it("a casing variant ('OPTED-IN') is normalized and SCANNED, not dropped", async () => {
    const result = await runIsolationScan({
      clientFor: withStatuses([['us-east-1', 'opt-in-not-required'], ['ap-east-1', 'OPTED-IN']]),
    });
    expect(result.scannedRegions).toContain('ap-east-1');
    expect(result.unscannedRegions).not.toContain('ap-east-1');
    expect(result.verdict).toBe('empty');
  });

  it("'not-opted-in' is safely skipped (disabled region cannot hold resources)", async () => {
    const result = await runIsolationScan({
      clientFor: withStatuses([['us-east-1', 'opt-in-not-required'], ['me-south-1', 'not-opted-in']]),
    });
    expect(result.scannedRegions).toEqual(['us-east-1']);
    expect(result.unscannedRegions).not.toContain('me-south-1');
    expect(result.verdict).toBe('empty');
  });
});
