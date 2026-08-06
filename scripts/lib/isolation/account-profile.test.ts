import { describe, it, expect } from 'vitest';
import {
  detectAccountProfile,
  type AwsClient,
  type AccountProfileClients,
} from './account-profile.js';

// ─────────────────────────────────────────────────────────────────────
// Test helpers: fake AwsClient that routes by CLI action.
// ─────────────────────────────────────────────────────────────────────

type Handler = (cmd: { action: string; args: string[] }) => unknown;

function clientFrom(handler: Handler): AwsClient {
  return {
    async send(command: unknown): Promise<unknown> {
      return handler(command as { action: string; args: string[] });
    },
  };
}

function awsError(name: string, message = name): Error {
  const e = new Error(message);
  e.name = name;
  return e;
}

function clients(orgs: AwsClient, ct: AwsClient): AccountProfileClients {
  return { organizations: orgs, controlTower: ct };
}

const notInOrgClient = clientFrom(() => {
  throw awsError('AWSOrganizationsNotInUseException');
});

const ctEmptyClient = clientFrom((cmd) => {
  if (cmd.action === 'list-landing-zones') return { landingZones: [] };
  return {};
});

// ─────────────────────────────────────────────────────────────────────

describe('detectAccountProfile', () => {
  it('returns standalone + supported when not-in-org AND control tower absent', async () => {
    const res = await detectAccountProfile(clients(notInOrgClient, ctEmptyClient));
    expect(res.profile).toBe('standalone');
    expect(res.supported).toBe(true);
    expect(res.reasons.some((r) => /not in an organization/i.test(r))).toBe(true);
  });

  it('returns org-member + unsupported when in an organization', async () => {
    const orgClient = clientFrom((cmd) => {
      if (cmd.action === 'describe-organization') {
        return { Organization: { Id: 'o-abc123', MasterAccountId: '111111111111' } };
      }
      return {};
    });
    const res = await detectAccountProfile(clients(orgClient, ctEmptyClient));
    expect(res.profile).toBe('org-member');
    expect(res.supported).toBe(false);
    expect(res.reasons.some((r) => /o-abc123/.test(r))).toBe(true);
  });

  it('returns control-tower + unsupported when a landing zone is present (even in an org)', async () => {
    const orgClient = clientFrom((cmd) => {
      if (cmd.action === 'describe-organization') {
        return { Organization: { Id: 'o-zzz', MasterAccountId: '222222222222' } };
      }
      return {};
    });
    const ctClient = clientFrom((cmd) => {
      if (cmd.action === 'list-landing-zones') return { landingZones: ['arn:aws:controltower:lz/1'] };
      return {};
    });
    const res = await detectAccountProfile(clients(orgClient, ctClient));
    expect(res.profile).toBe('control-tower');
    expect(res.supported).toBe(false);
  });

  it('fails closed to unknown + unsupported when DescribeOrganization is AccessDenied', async () => {
    const orgClient = clientFrom(() => {
      throw awsError('AccessDeniedException');
    });
    const res = await detectAccountProfile(clients(orgClient, ctEmptyClient));
    expect(res.profile).toBe('unknown');
    expect(res.supported).toBe(false);
  });

  it('fails closed to unknown when control tower probe is unevaluable, even if org says standalone', async () => {
    const ctDenied = clientFrom(() => {
      throw awsError('AccessDeniedException');
    });
    const res = await detectAccountProfile(clients(notInOrgClient, ctDenied));
    expect(res.profile).toBe('unknown');
    expect(res.supported).toBe(false);
    expect(res.reasons.some((r) => /failing closed/i.test(r))).toBe(true);
  });

  it('fails closed when DescribeOrganization returns an empty body (no exception)', async () => {
    const orgEmptyBody = clientFrom((cmd) => {
      if (cmd.action === 'describe-organization') return {};
      return {};
    });
    const res = await detectAccountProfile(clients(orgEmptyBody, ctEmptyClient));
    expect(res.profile).toBe('unknown');
    expect(res.supported).toBe(false);
  });

  it('names control-tower when org is unevaluable but a landing zone is observed', async () => {
    const orgDenied = clientFrom(() => {
      throw awsError('ThrottlingException');
    });
    const ctPresent = clientFrom((cmd) => {
      if (cmd.action === 'list-landing-zones') return { landingZones: ['lz-1'] };
      return {};
    });
    const res = await detectAccountProfile(clients(orgDenied, ctPresent));
    expect(res.profile).toBe('control-tower');
    expect(res.supported).toBe(false);
  });
});
