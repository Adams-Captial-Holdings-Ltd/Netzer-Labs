import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { TokenPrincipal } from '../../lib/auth/dashboard-auth.js';

/**
 * Cost router authorizes on the CAPABILITY, not the legacy role rank. A custom
 * profile that holds cost:read / cost:write is minted with a low role rank, so a
 * coarse ROLE_RANK >= operator gate would have denied it before the capability
 * check. These tests lock that reads need cost:read and /evaluate needs
 * cost:write, using the templated tiers (viewer lacks both; operator holds both).
 */

const {
  readCostSummary,
  readCostRisks,
  runCostWatchOnce,
  generateCostReport,
  getEffectiveCostCap,
  remediate,
  getConfig,
  writeAudit,
  startReportJob,
  getReportJob,
  authenticateDashboardToken,
} = vi.hoisted(() => ({
  readCostSummary: vi.fn(async () => ({ available: true, monthToDateUsd: 1 })),
  readCostRisks: vi.fn(async () => ({ available: true, risks: [] })),
  runCostWatchOnce: vi.fn(async () => ({ ran: true })),
  generateCostReport: vi.fn(async () => ({ available: true, headline: 'ok', drivers: [] })),
  getEffectiveCostCap: vi.fn(async () => 50),
  remediate: vi.fn(async () => ({ status: 'applied', verified: true, message: 'done' })),
  getConfig: vi.fn(async () => undefined as string | undefined),
  writeAudit: vi.fn(),
  startReportJob: vi.fn(async () => ({ jobId: 'job-1', status: 'pending' })),
  getReportJob: vi.fn(async () => ({ status: 'pending' })),
  authenticateDashboardToken: vi.fn(),
}));

function principalFor(raw: string): TokenPrincipal | null {
  const role = raw.replace(/^Bearer\s+/i, '');
  if (role !== 'viewer' && role !== 'operator' && role !== 'admin') return null;
  return { tokenHash: `hash-${role}`, label: role, hashPrefix16: role, role };
}

vi.mock('../../lib/auth/dashboard-auth.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/auth/dashboard-auth.js')>();
  return {
    ...actual,
    extractBearerToken: (h?: string) => (h ?? '').replace(/^Bearer\s+/i, ''),
    authenticateDashboardToken: (raw: string) => authenticateDashboardToken(raw),
  };
});

vi.mock('../../lib/aws/cost-reader.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/aws/cost-reader.js')>();
  return { ...actual, readCostSummary, readCostRisks };
});

vi.mock('../../lib/aws/cost-analyst.js', () => ({ generateCostReport }));
vi.mock('../../lib/state/cost-cap-repo.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/state/cost-cap-repo.js')>();
  return { ...actual, getEffectiveCostCap };
});
vi.mock('../../lib/aws/cost-remediation.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/aws/cost-remediation.js')>();
  return { ...actual, remediate };
});
vi.mock('../../lib/state/runtime-config-repo.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/state/runtime-config-repo.js')>();
  return { ...actual, getConfig };
});
vi.mock('../../lib/audit/audit-writer.js', () => ({ writeAudit }));
vi.mock('../../lib/aws/cost-report-jobs.js', () => ({ startReportJob, getReportJob }));
vi.mock('../../workers/cost-watch.js', () => ({ runCostWatchOnce }));
vi.mock('../../observability/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {} },
}));

import { buildCostRouter } from './cost.js';

function req(path: string, role: string, method: 'GET' | 'POST' = 'GET', body?: unknown) {
  const app = new Hono();
  app.route('/api/cost', buildCostRouter());
  return app.request(`/api/cost${path}`, {
    method,
    headers: { Authorization: `Bearer ${role}`, 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

beforeEach(() => {
  authenticateDashboardToken.mockReset().mockImplementation(async (raw: string) => principalFor(raw));
  runCostWatchOnce.mockReset().mockResolvedValue({ ran: true });
  remediate.mockReset().mockResolvedValue({ status: 'applied', verified: true, message: 'done' });
  getConfig.mockReset().mockResolvedValue(undefined); // remediation/async off by default
  writeAudit.mockReset();
  startReportJob.mockReset().mockResolvedValue({ jobId: 'job-1', status: 'pending' });
  getReportJob.mockReset().mockResolvedValue({ status: 'pending' });
});

describe('cost router authorization', () => {
  it('denies a viewer the cost reads (needs cost:read)', async () => {
    const res = await req('/summary', 'viewer');
    expect(res.status).toBe(403);
    expect(((await res.json()) as { requiredCapability?: string }).requiredCapability).toBe('cost:read');
  });

  it('allows an operator the cost reads (holds cost:read)', async () => {
    expect((await req('/summary', 'operator')).status).toBe(200);
    expect((await req('/risks', 'operator')).status).toBe(200);
  });

  it('denies a viewer /evaluate and allows an operator (cost:write)', async () => {
    expect((await req('/evaluate', 'viewer', 'POST')).status).toBe(403);
    expect((await req('/evaluate', 'operator', 'POST')).status).toBe(200);
    expect(runCostWatchOnce).toHaveBeenCalled();
  });

  it('denies a viewer /report and allows an operator (cost:read, read-only AI)', async () => {
    const denied = await req('/report', 'viewer', 'POST');
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as { requiredCapability?: string }).requiredCapability).toBe('cost:read');
    expect((await req('/report', 'operator', 'POST')).status).toBe(200);
    expect(generateCostReport).toHaveBeenCalled();
  });

  it('async report routes gate on cost:read (viewer denied, operator allowed)', async () => {
    expect((await req('/report/mode', 'viewer')).status).toBe(403);
    const mode = await req('/report/mode', 'operator');
    expect(mode.status).toBe(200);
    expect((await mode.json()) as { async: boolean }).toEqual({ async: false });

    expect((await req('/report/start', 'viewer', 'POST')).status).toBe(403);
    expect((await req('/report/start', 'operator', 'POST')).status).toBe(200);
    expect(startReportJob).toHaveBeenCalled();

    expect((await req('/report/result', 'viewer')).status).toBe(403);
    expect((await req('/report/result', 'operator')).status).toBe(200);
    expect(getReportJob).toHaveBeenCalled();
  });

  it('denies a viewer /remediate (needs cost:write)', async () => {
    const res = await req('/remediate', 'viewer', 'POST', {
      action: 'release-eip',
      region: 'us-east-1',
      resourceId: '1.2.3.4',
      confirm: true,
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { requiredCapability?: string }).requiredCapability).toBe('cost:write');
    expect(remediate).not.toHaveBeenCalled();
  });

  it('refuses /remediate when the arm flag is off, and never mutates', async () => {
    getConfig.mockResolvedValue(undefined); // cost/remediation_enabled unset
    const res = await req('/remediate', 'operator', 'POST', {
      action: 'release-eip',
      region: 'us-east-1',
      resourceId: '1.2.3.4',
      confirm: true,
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error?: string }).error).toMatch(/disabled/i);
    expect(remediate).not.toHaveBeenCalled();
  });

  it('requires confirm:true even when armed', async () => {
    getConfig.mockResolvedValue('true');
    const res = await req('/remediate', 'operator', 'POST', {
      action: 'release-eip',
      region: 'us-east-1',
      resourceId: '1.2.3.4',
    });
    expect(res.status).toBe(400);
    expect(remediate).not.toHaveBeenCalled();
  });

  it('rejects an unknown action even when armed + confirmed', async () => {
    getConfig.mockResolvedValue('true');
    const res = await req('/remediate', 'operator', 'POST', {
      action: 'rm -rf',
      region: 'us-east-1',
      resourceId: 'x',
      confirm: true,
    });
    expect(res.status).toBe(400);
    expect(remediate).not.toHaveBeenCalled();
  });

  it('executes /remediate when armed + confirmed + valid (cost:write), and audits it', async () => {
    getConfig.mockResolvedValue('true');
    const res = await req('/remediate', 'operator', 'POST', {
      action: 'release-eip',
      region: 'us-east-1',
      resourceId: '1.2.3.4',
      confirm: true,
    });
    expect(res.status).toBe(200);
    expect(remediate).toHaveBeenCalledWith({ action: 'release-eip', region: 'us-east-1', resourceId: '1.2.3.4' });
    expect(writeAudit).toHaveBeenCalled();
  });

  it('exposes /remediation/status to an operator (cost:read), denies a viewer', async () => {
    expect((await req('/remediation/status', 'viewer')).status).toBe(403);
    const ok = await req('/remediation/status', 'operator');
    expect(ok.status).toBe(200);
    expect((await ok.json()) as { enabled: boolean }).toEqual({ enabled: false });
  });
});
