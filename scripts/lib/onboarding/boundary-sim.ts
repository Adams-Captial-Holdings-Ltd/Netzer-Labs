/**
 * Prove the I2/I4 privilege boundary against AWS's REAL policy-evaluation engine
 * using iam:SimulateCustomPolicy. This needs valid AWS credentials but creates
 * NO resource and costs nothing (SimulateCustomPolicy is a read-only reasoning
 * call), so it closes the "does the boundary actually deny" gap without a fresh
 * standalone account and without deploying anything.
 *
 * The rigorous case models how the boundary is actually deployed: a BROAD
 * identity policy (the deploy role's service-level allows) CAPPED by the scoped
 * permission boundary. Every action in FORBIDDEN_FOOTHOLD_ACTIONS must come back
 * NOT allowed even though the identity policy would allow it, and a sample of
 * legitimately-needed actions must come back allowed.
 *
 * This module is pure over an injected IAM client so it unit-tests offline; the
 * CLI scripts/verify-boundary.ts wires the real client and skips without creds.
 */

import {
  buildScopedDeployBoundary,
  buildBootstrapSessionPolicy,
  FORBIDDEN_FOOTHOLD_ACTIONS,
  BOOTSTRAP_ALLOWED_ACTIONS,
  SCOPED_DEPLOY_ALLOWED_SERVICE_PREFIXES,
  type PolicyDocumentJson,
} from './scoped-role.js';

/** Minimal IAM client seam: send(SimulateCustomPolicyCommand) -> result. */
export interface IamSimClient {
  send(command: unknown): Promise<unknown>;
}

export type SimDecision = 'allowed' | 'explicitDeny' | 'implicitDeny' | 'unknown';

export interface SimCase {
  id: string;
  description: string;
  /** Identity policy documents (JSON strings) under simulation. */
  policies: string[];
  /** Optional permission-boundary policy documents (JSON strings). */
  boundary?: string[];
  /** Actions to evaluate. */
  actions: string[];
  /** The required outcome for EVERY action in this case. */
  expect: 'allowed' | 'denied';
}

export interface SimActionResult {
  caseId: string;
  action: string;
  decision: SimDecision;
  expect: 'allowed' | 'denied';
  ok: boolean;
}

const POLICY_VERSION = '2012-10-17';

/** The broad identity policy the deploy role carries (capped by the boundary). */
export function broadDeployIdentityPolicy(): PolicyDocumentJson {
  return {
    Version: POLICY_VERSION,
    Statement: [
      {
        Sid: 'BroadServiceAllow',
        Effect: 'Allow',
        Action: [...SCOPED_DEPLOY_ALLOWED_SERVICE_PREFIXES],
        Resource: '*',
      },
    ],
  };
}

/** A sample of actions the deploy legitimately needs (must stay allowed). */
export const SHOULD_BE_ALLOWED: readonly string[] = [
  'cloudformation:CreateStack',
  'dynamodb:CreateTable',
  's3:CreateBucket',
  'ecs:CreateService',
  'secretsmanager:CreateSecret',
  'logs:CreateLogGroup',
  'sts:AssumeRole', // assume the CDK bootstrap roles
];

/**
 * Build the simulation matrix:
 *  1. every forbidden action is DENIED under a broad identity policy + boundary;
 *  2. the sample of needed actions stays ALLOWED under the same pairing;
 *  3. the bootstrap session policy denies the forbidden catalog;
 *  4. the bootstrap session policy allows a representative bootstrap action.
 */
export function buildBoundarySimCases(): SimCase[] {
  const identity = JSON.stringify(broadDeployIdentityPolicy());
  const boundary = JSON.stringify(buildScopedDeployBoundary());
  const bootstrap = JSON.stringify(buildBootstrapSessionPolicy());
  const forbidden = [...FORBIDDEN_FOOTHOLD_ACTIONS];
  const bootstrapAllowedSample = BOOTSTRAP_ALLOWED_ACTIONS.find(
    (a) => !FORBIDDEN_FOOTHOLD_ACTIONS.includes(a),
  );

  const cases: SimCase[] = [
    {
      id: 'boundary-denies-foothold-catalog',
      description: 'broad identity policy capped by the scoped boundary denies every I4 foothold action',
      policies: [identity],
      boundary: [boundary],
      actions: forbidden,
      expect: 'denied',
    },
    {
      id: 'boundary-allows-needed-actions',
      description: 'the same identity + boundary still allows the actions a deploy legitimately needs',
      policies: [identity],
      boundary: [boundary],
      actions: [...SHOULD_BE_ALLOWED],
      expect: 'allowed',
    },
    {
      id: 'bootstrap-session-denies-foothold-catalog',
      description: 'the bootstrap session policy denies the I4 foothold catalog even during bootstrap',
      policies: [bootstrap],
      actions: forbidden,
      expect: 'denied',
    },
  ];

  if (bootstrapAllowedSample) {
    cases.push({
      id: 'bootstrap-session-allows-named-action',
      description: 'the bootstrap session policy allows a named bootstrap action',
      policies: [bootstrap],
      actions: [bootstrapAllowedSample],
      expect: 'allowed',
    });
  }
  return cases;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Run one case through iam:SimulateCustomPolicy (batching actions) and return a
 * per-action result. A non-'allowed' decision satisfies expect:'denied'; an
 * 'allowed' decision satisfies expect:'allowed'. An undecodable response is
 * 'unknown' and FAILS (we never treat an unreadable simulation as a pass).
 */
export async function simulateCase(
  client: IamSimClient,
  c: SimCase,
  SimulateCustomPolicyCommand: new (input: unknown) => unknown,
): Promise<SimActionResult[]> {
  const results: SimActionResult[] = [];
  for (const batch of chunk(c.actions, 100)) {
    const input: Record<string, unknown> = {
      PolicyInputList: c.policies,
      ActionNames: batch,
    };
    if (c.boundary) input.PermissionsBoundaryPolicyInputList = c.boundary;
    const out = (await client.send(new SimulateCustomPolicyCommand(input))) as {
      EvaluationResults?: Array<{ EvalActionName?: string; EvalDecision?: string }>;
    };
    const byAction = new Map<string, string>();
    for (const r of out.EvaluationResults ?? []) {
      if (r.EvalActionName) byAction.set(r.EvalActionName, r.EvalDecision ?? 'unknown');
    }
    for (const action of batch) {
      const decision = (byAction.get(action) ?? 'unknown') as SimDecision;
      const ok = c.expect === 'allowed' ? decision === 'allowed' : decision !== 'allowed' && decision !== 'unknown';
      results.push({ caseId: c.id, action, decision, expect: c.expect, ok });
    }
  }
  return results;
}

export interface BoundarySimSummary {
  total: number;
  passed: number;
  failed: number;
  failures: SimActionResult[];
}

export function summarizeSim(results: SimActionResult[]): BoundarySimSummary {
  const failures = results.filter((r) => !r.ok);
  return { total: results.length, passed: results.length - failures.length, failed: failures.length, failures };
}
