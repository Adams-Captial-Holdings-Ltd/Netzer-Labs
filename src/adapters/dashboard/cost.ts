/**
 * Tier B read-only AWS cost router. Mounted at /api/cost (see src/server.ts).
 *
 *   GET /summary  month-to-date spend, by-service breakdown, ~30-day daily
 *                 trend, last-month total, and a straight-line projection.
 *   GET /risks    waste scan: idle/duplicate NAT, redundant VPC endpoints,
 *                 unattached EIPs, orphaned EBS, surplus load balancers, each
 *                 with an approximate recoverable amount.
 *   POST /report  on-demand AI cost report: a Bedrock analyst explains the bill
 *                 in plain English (what each service does + whether you need
 *                 it), ranks optimizations, and emits a paste-ready AWS CLI plan
 *                 for Claude Code. Read-only (cost:read); not cached.
 *   GET  /report/mode    (cost:read) whether the async report path is on.
 *   POST /report/start   (cost:read) start a background (rich) report job.
 *   GET  /report/result  (cost:read) poll the background report job.
 *   GET  /remediation/status  (cost:read) whether Apply is armed.
 *   POST /remediate           (cost:write + arm flag + confirm) the ONLY route
 *                 that mutates AWS: deletes/releases ONE idle resource after a
 *                 pre-flight idleness re-check and confirms it via a post-verify.
 *                 Audited. Disabled by default; IAM perms live in a detached policy.
 *
 * Reads are operator+ (same bar as the cost cap). The only write path is
 * /remediate, gated as above. The readers fail soft: a denied API returns
 * `available: false` with a note, never a 500.
 *
 * Both responses are cached in-process. Cost Explorer bills ~$0.01 per call
 * and its data only settles daily, so re-querying on every page load would be
 * pure waste on a tool whose entire point is to stop waste. The cache is
 * per-task; a fresh task (deploy/scale) simply repopulates it on first hit.
 */

import { Hono } from 'hono';
import {
  authenticateDashboardToken,
  extractBearerToken,
  type TokenPrincipal,
} from '../../lib/auth/dashboard-auth.js';
import { principalHasRouteCapability } from '../../lib/auth/route-capability.js';
import { logger } from '../../observability/logger.js';
import {
  readCostSummary,
  readCostRisks,
  type CostSummary,
  type CostRisksResult,
} from '../../lib/aws/cost-reader.js';
import { generateCostReport, type CostReport } from '../../lib/aws/cost-analyst.js';
import { startReportJob, getReportJob } from '../../lib/aws/cost-report-jobs.js';
import {
  remediate,
  REMEDIATION_ACTIONS,
  type RemediationAction,
  type RemediationRequest,
} from '../../lib/aws/cost-remediation.js';
import { getEffectiveCostCap } from '../../lib/state/cost-cap-repo.js';
import { getConfig } from '../../lib/state/runtime-config-repo.js';
import { writeAudit } from '../../lib/audit/audit-writer.js';
import { runCostWatchOnce } from '../../workers/cost-watch.js';

type CostEnv = { Variables: { principal: TokenPrincipal } };

const SUMMARY_TTL_MS = 60 * 60 * 1000; // 1h: CE settles ~daily
const RISKS_TTL_MS = 30 * 60 * 1000; // 30m: resource topology changes slowly

let summaryCache: { at: number; data: CostSummary } | null = null;
let risksCache: { at: number; data: CostRisksResult } | null = null;
// Single-flight: a report is an expensive multi-second Bedrock call. If a second
// request lands while one is generating (double-click, two operators), share the
// in-flight promise instead of firing another paid model call — cost control on
// the cost tab itself. Not a time cache: a fresh click after one settles still
// generates a new report.
let reportInFlight: Promise<CostReport> | null = null;

async function cachedSummary(): Promise<CostSummary> {
  if (summaryCache && Date.now() - summaryCache.at < SUMMARY_TTL_MS) return summaryCache.data;
  const data = await readCostSummary();
  // Only cache a successful read so a transient denial doesn't pin an empty
  // payload for an hour.
  if (data.available) summaryCache = { at: Date.now(), data };
  return data;
}

async function cachedRisks(): Promise<CostRisksResult> {
  if (risksCache && Date.now() - risksCache.at < RISKS_TTL_MS) return risksCache.data;
  const data = await readCostRisks();
  if (data.available) risksCache = { at: Date.now(), data };
  return data;
}

// Remediation is armed by a runtime-config flag (default off, fail-closed) so
// the destructive paths stay inert until the owner deliberately turns them on —
// and even then the IAM permission to delete lives in a detached managed policy.
async function remediationEnabled(): Promise<boolean> {
  return (await getConfig('cost', 'remediation_enabled')) === 'true';
}

// When on (Settings toggle), the UI generates the report via the async job path
// (start + poll) so it is not bound by the 60s edge timeout. Default off → sync.
async function reportAsyncEnabled(): Promise<boolean> {
  return (await getConfig('cost', 'report_async_enabled')) === 'true';
}

async function gatherReportInputs(): Promise<{ summary: CostSummary; risks: CostRisksResult; dailyCapUsd: number }> {
  const [summary, risks, dailyCapUsd] = await Promise.all([cachedSummary(), cachedRisks(), getEffectiveCostCap()]);
  return { summary, risks, dailyCapUsd };
}

export function buildCostRouter(): Hono<CostEnv> {
  const router = new Hono<CostEnv>();

  // Authenticate every request. Authorization is per-route on the CAPABILITY,
  // not the legacy role rank: a custom profile that holds cost:read / cost:write
  // is minted with a low role rank, so a coarse ROLE_RANK >= operator gate here
  // would deny it before the capability check ran. Reads gate on cost:read,
  // /evaluate gates on cost:write (both held by the templated operator tier).
  router.use('*', async (c, next) => {
    const raw = extractBearerToken(c.req.header('authorization'));
    const principal = await authenticateDashboardToken(raw);
    if (!principal) return c.json({ error: 'unauthorized' }, 401);
    c.set('principal', principal);
    await next();
  });

  router.get('/summary', async (c) => {
    if (!(await principalHasRouteCapability(c.get('principal'), 'cost:read'))) {
      return c.json({ error: 'forbidden', requiredCapability: 'cost:read' }, 403);
    }
    try {
      return c.json(await cachedSummary());
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ errMessage: msg }, 'cost/summary failed');
      return c.json({ error: 'cost summary unavailable' }, 502);
    }
  });

  router.get('/risks', async (c) => {
    if (!(await principalHasRouteCapability(c.get('principal'), 'cost:read'))) {
      return c.json({ error: 'forbidden', requiredCapability: 'cost:read' }, 403);
    }
    try {
      return c.json(await cachedRisks());
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ errMessage: msg }, 'cost/risks failed');
      return c.json({ error: 'cost risks unavailable' }, 502);
    }
  });

  // On-demand AI cost report. Read-only: it reads the same cached summary +
  // risks the page already shows plus the effective cap, asks a Bedrock analyst
  // to explain the bill in plain English and produce a paste-ready AWS CLI plan,
  // and mutates nothing — so it gates on cost:read, not cost:write. It is NOT
  // cached (each report is a fresh model call, like compliance/analyze) and
  // returns 502 on a model/parse failure so the UI can show a clean error.
  router.post('/report', async (c) => {
    if (!(await principalHasRouteCapability(c.get('principal'), 'cost:read'))) {
      return c.json({ error: 'forbidden', requiredCapability: 'cost:read' }, 403);
    }
    try {
      if (!reportInFlight) {
        reportInFlight = (async () => {
          const { summary, risks, dailyCapUsd } = await gatherReportInputs();
          return generateCostReport({ summary, risks, dailyCapUsd });
        })().finally(() => {
          reportInFlight = null;
        });
      }
      return c.json(await reportInFlight);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ errMessage: msg }, 'cost/report failed');
      return c.json({ error: 'cost report generation failed' }, 502);
    }
  });

  // Whether the dashboard should use the async report path (Settings toggle).
  router.get('/report/mode', async (c) => {
    if (!(await principalHasRouteCapability(c.get('principal'), 'cost:read'))) {
      return c.json({ error: 'forbidden', requiredCapability: 'cost:read' }, 403);
    }
    return c.json({ async: await reportAsyncEnabled() });
  });

  // Async report: start a background generation and return immediately. The
  // generation produces the RICH (untrimmed) report since it is not bound by the
  // 60s edge timeout. Single-flight is enforced in the job store. cost:read.
  router.post('/report/start', async (c) => {
    if (!(await principalHasRouteCapability(c.get('principal'), 'cost:read'))) {
      return c.json({ error: 'forbidden', requiredCapability: 'cost:read' }, 403);
    }
    try {
      const inputs = await gatherReportInputs();
      const job = await startReportJob(inputs);
      return c.json(job);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ errMessage: msg }, 'cost/report/start failed');
      return c.json({ error: 'could not start report' }, 502);
    }
  });

  // Poll the async report. Returns { status: idle|pending|done|error, report? }.
  router.get('/report/result', async (c) => {
    if (!(await principalHasRouteCapability(c.get('principal'), 'cost:read'))) {
      return c.json({ error: 'forbidden', requiredCapability: 'cost:read' }, 403);
    }
    try {
      return c.json(await getReportJob());
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ errMessage: msg }, 'cost/report/result failed');
      return c.json({ error: 'could not read report status' }, 502);
    }
  });

  // Tells the UI whether the Apply controls should be shown at all. Read-only.
  router.get('/remediation/status', async (c) => {
    if (!(await principalHasRouteCapability(c.get('principal'), 'cost:read'))) {
      return c.json({ error: 'forbidden', requiredCapability: 'cost:read' }, 403);
    }
    return c.json({ enabled: await remediationEnabled() });
  });

  // Apply ONE remediation against the real AWS account. This is the only cost
  // route that mutates, so it is gated by ALL of: cost:write, the runtime-config
  // arm flag, and an explicit confirm:true. The executor itself re-verifies the
  // resource is idle before touching it and confirms the change afterward, and
  // every attempt is audited. A successful apply busts the risks cache so the
  // next scan reflects true AWS state rather than the pre-deletion snapshot.
  router.post('/remediate', async (c) => {
    const principal = c.get('principal');
    if (!(await principalHasRouteCapability(principal, 'cost:write'))) {
      return c.json({ error: 'forbidden', requiredCapability: 'cost:write' }, 403);
    }
    if (!(await remediationEnabled())) {
      void writeAudit({
        action: 'cost_remediation_blocked',
        detail: { reason: 'arm flag off' },
        userId: principal.hashPrefix16 ?? 'dashboard',
        operatorLabel: principal.label ?? undefined,
        surface: 'dashboard',
        result: 'error',
      });
      return c.json(
        { error: 'remediation is disabled', hint: "set runtime-config cost/remediation_enabled='true' to arm, and attach the CCE-CostRemediation policy" },
        403,
      );
    }
    const body = await c.req
      .json<RemediationRequest & { confirm?: boolean }>()
      .catch(() => ({}) as RemediationRequest & { confirm?: boolean });
    if (body.confirm !== true) return c.json({ error: 'confirm:true is required' }, 400);
    if (!body.action || !REMEDIATION_ACTIONS.includes(body.action as RemediationAction)) {
      return c.json({ error: 'valid action is required', allowed: REMEDIATION_ACTIONS }, 400);
    }
    if (!body.resourceId || !body.region) {
      return c.json({ error: 'region and resourceId are required' }, 400);
    }

    try {
      const result = await remediate({
        action: body.action,
        region: body.region,
        resourceId: body.resourceId,
        ...(typeof body.retentionDays === 'number' ? { retentionDays: body.retentionDays } : {}),
      });
      // Only a verified, applied change should move the dashboard's numbers, so
      // bust the cache only then; a refusal/failure leaves the scan as-is.
      if (result.status === 'applied' && result.verified) risksCache = null;
      void writeAudit({
        action: result.status === 'applied' ? 'cost_remediation_applied' : 'cost_remediation_blocked',
        detail: {
          remediationAction: body.action,
          region: body.region,
          resourceId: body.resourceId,
          status: result.status,
          verified: result.verified,
          message: result.message,
        },
        userId: principal.hashPrefix16 ?? 'dashboard',
        operatorLabel: principal.label ?? undefined,
        surface: 'dashboard',
        result: result.status === 'applied' ? 'ok' : 'error',
      });
      return c.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ errMessage: msg, action: body.action }, 'cost/remediate failed');
      return c.json({ error: 'remediation failed', detail: msg }, 502);
    }
  });

  // Run the cost-watch evaluator on demand and (if thresholds are breached)
  // publish the alert now. "Run check now" is a cost control, so it is gated on
  // the cost:write capability (operator-tier) — a product-approved loosen from
  // the prior admin-only role gate. Mirrors the warroom capability +
  // custom-profile resolution (env break-glass / owner token always passes).
  // Bypasses the enabled flag + once-a-day guard so it's useful for testing.
  router.post('/evaluate', async (c) => {
    const principal = c.get('principal');
    if (!(await principalHasRouteCapability(principal, 'cost:write'))) {
      return c.json({ error: 'forbidden', requiredCapability: 'cost:write' }, 403);
    }
    try {
      const result = await runCostWatchOnce({ force: true });
      return c.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ errMessage: msg }, 'cost/evaluate failed');
      return c.json({ error: 'evaluate failed' }, 502);
    }
  });

  return router;
}
