import { describe, it, expect } from 'vitest';
import { FORBIDDEN_FOOTHOLD_ACTIONS } from './scoped-role.js';
import {
  buildBoundarySimCases,
  simulateCase,
  summarizeSim,
  broadDeployIdentityPolicy,
  SHOULD_BE_ALLOWED,
  type IamSimClient,
  type SimCase,
} from './boundary-sim.js';

// A fake SimulateCustomPolicyCommand that just captures its input.
class FakeSimCmd {
  constructor(public input: Record<string, unknown>) {}
}

/**
 * A fake IAM that adjudicates like real IAM would for a Deny-over-catalog
 * boundary: an action in `denySet` resolves explicitDeny, anything else allowed.
 * Lets us prove simulateCase maps decisions correctly without touching AWS.
 */
function fakeIam(denySet: Set<string>): { client: IamSimClient; calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  const client: IamSimClient = {
    async send(command: unknown): Promise<unknown> {
      const input = (command as FakeSimCmd).input;
      calls.push(input);
      const actions = input.ActionNames as string[];
      return {
        EvaluationResults: actions.map((a) => ({
          EvalActionName: a,
          EvalDecision: denySet.has(a) ? 'explicitDeny' : 'allowed',
        })),
      };
    },
  };
  return { client, calls };
}

describe('buildBoundarySimCases', () => {
  const cases = buildBoundarySimCases();
  it('covers every forbidden foothold action with expect:denied', () => {
    const denyCase = cases.find((c) => c.id === 'boundary-denies-foothold-catalog')!;
    expect(denyCase.expect).toBe('denied');
    expect(new Set(denyCase.actions)).toEqual(new Set(FORBIDDEN_FOOTHOLD_ACTIONS));
    expect(denyCase.boundary).toBeDefined();
  });
  it('asserts needed actions stay allowed and they are not in the deny catalog', () => {
    const allowCase = cases.find((c) => c.id === 'boundary-allows-needed-actions')!;
    expect(allowCase.expect).toBe('allowed');
    for (const a of SHOULD_BE_ALLOWED) {
      expect(FORBIDDEN_FOOTHOLD_ACTIONS).not.toContain(a);
    }
  });
  it('includes a bootstrap-session deny case', () => {
    expect(cases.some((c) => c.id === 'bootstrap-session-denies-foothold-catalog')).toBe(true);
  });
  it('the broad identity policy allows the service surface (so the boundary is doing the denying)', () => {
    const p = broadDeployIdentityPolicy();
    expect(p.Statement[0].Effect).toBe('Allow');
    expect((p.Statement[0].Action as string[]).length).toBeGreaterThan(10);
  });
});

describe('simulateCase', () => {
  const deny = new Set(FORBIDDEN_FOOTHOLD_ACTIONS);

  it('passes when forbidden actions resolve to a non-allowed decision', async () => {
    const { client, calls } = fakeIam(deny);
    const denyCase = buildBoundarySimCases().find((c) => c.id === 'boundary-denies-foothold-catalog')!;
    const results = await simulateCase(client, denyCase, FakeSimCmd as never);
    expect(results.length).toBe(FORBIDDEN_FOOTHOLD_ACTIONS.length);
    expect(results.every((r) => r.ok)).toBe(true);
    // The boundary was passed through to the simulator.
    expect(calls[0].PermissionsBoundaryPolicyInputList).toBeDefined();
    expect(calls[0].PolicyInputList).toBeDefined();
  });

  it('passes when needed actions resolve to allowed', async () => {
    const { client } = fakeIam(deny);
    const allowCase = buildBoundarySimCases().find((c) => c.id === 'boundary-allows-needed-actions')!;
    const results = await simulateCase(client, allowCase, FakeSimCmd as never);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it('FAILS (catches a real boundary hole) when a forbidden action is allowed', async () => {
    // Simulate a boundary that forgot to deny iam:CreateUser.
    const holed = new Set(FORBIDDEN_FOOTHOLD_ACTIONS.filter((a) => a !== 'iam:CreateUser'));
    const { client } = fakeIam(holed);
    const denyCase = buildBoundarySimCases().find((c) => c.id === 'boundary-denies-foothold-catalog')!;
    const results = await simulateCase(client, denyCase, FakeSimCmd as never);
    const summary = summarizeSim(results);
    expect(summary.failed).toBe(1);
    expect(summary.failures[0].action).toBe('iam:CreateUser');
  });

  it('FAILS CLOSED on an undecodable simulation (missing decision => unknown)', async () => {
    const client: IamSimClient = { async send() { return {}; } };
    const c: SimCase = { id: 't', description: 't', policies: ['{}'], actions: ['iam:CreateUser'], expect: 'denied' };
    const results = await simulateCase(client, c, FakeSimCmd as never);
    expect(results[0].decision).toBe('unknown');
    expect(results[0].ok).toBe(false);
  });

  it('batches actions across multiple SimulateCustomPolicy calls (>100 actions)', async () => {
    const many = Array.from({ length: 250 }, (_, i) => `svc:Action${i}`);
    const { client, calls } = fakeIam(new Set());
    const c: SimCase = { id: 'big', description: 'big', policies: ['{}'], actions: many, expect: 'allowed' };
    const results = await simulateCase(client, c, FakeSimCmd as never);
    expect(results.length).toBe(250);
    expect(calls.length).toBe(3); // 100 + 100 + 50
  });
});

describe('summarizeSim', () => {
  it('counts passes and failures', () => {
    const s = summarizeSim([
      { caseId: 'a', action: 'x', decision: 'explicitDeny', expect: 'denied', ok: true },
      { caseId: 'a', action: 'y', decision: 'allowed', expect: 'denied', ok: false },
    ]);
    expect(s).toMatchObject({ total: 2, passed: 1, failed: 1 });
    expect(s.failures).toHaveLength(1);
  });
});
