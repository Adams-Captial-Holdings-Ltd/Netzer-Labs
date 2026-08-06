/**
 * Compliance router (SOC 2 + HIPAA gap analysis). Mounted at /api/compliance
 * (see src/server.ts).
 *
 *   GET  /summary          (compliance:read)  Full SOC 2 + HIPAA control catalog
 *                          scored against LIVE posture evidence — the "see your
 *                          gaps at all times" view. Read-only, fails soft.
 *   POST /analyze          (compliance:read)  { controlId } -> the read-only AI
 *                          analyst's latest-guidance requirement + assessment +
 *                          remediation for that one control. Invokes Bedrock.
 *
 * Both routes are operator-tier reads (compliance:read; held by operator/admin/
 * owner). Neither mutates anything and no secret VALUE is ever returned — the
 * evidence is the same posture metadata the Security Posture tab already shows.
 */

import { Hono } from 'hono';
import {
  authenticateDashboardToken,
  extractBearerToken,
  type TokenPrincipal,
} from '../../lib/auth/dashboard-auth.js';
import { principalHasRouteCapability } from '../../lib/auth/route-capability.js';
import { logger } from '../../observability/logger.js';
import { collectComplianceEvidence } from '../../lib/compliance/evidence.js';
import {
  buildComplianceSummary,
  controlById,
  evaluateControl,
} from '../../lib/compliance/control-catalog.js';
import { analyzeControl } from '../../lib/compliance/analyst.js';
import { buildRemediationBrief } from '../../lib/compliance/brief.js';

type ComplianceEnv = { Variables: { principal: TokenPrincipal } };

export function buildComplianceRouter(): Hono<ComplianceEnv> {
  const router = new Hono<ComplianceEnv>();

  // Authenticate + gate every route on compliance:read (operator+). The backend
  // is the authority; the UI hides the tab too, but we re-check here.
  router.use('*', async (c, next) => {
    const raw = extractBearerToken(c.req.header('authorization'));
    const principal = await authenticateDashboardToken(raw);
    if (!principal) return c.json({ error: 'unauthorized' }, 401);
    if (!(await principalHasRouteCapability(principal, 'compliance:read'))) {
      return c.json(
        { error: 'forbidden', requiredCapability: 'compliance:read' },
        403,
      );
    }
    c.set('principal', principal);
    await next();
  });

  // Full scored summary. collectComplianceEvidence is internally fail-soft per
  // source, but guard the whole call too: a compliance page must never 500.
  router.get('/summary', async (c) => {
    const generatedAt = new Date().toISOString();
    try {
      const evidence = await collectComplianceEvidence();
      return c.json(buildComplianceSummary(evidence, generatedAt));
    } catch (err) {
      logger.warn(
        { errMessage: err instanceof Error ? err.message : String(err) },
        'compliance: summary assembly failed',
      );
      // Degrade to an evidence-less summary (every automated control shows
      // 'unknown') rather than erroring the page.
      return c.json(buildComplianceSummary([], generatedAt));
    }
  });

  // Remediation brief — the paste-ready "meta-prompt" for Claude Code, built
  // deterministically from the current scan (no model call, always available).
  // Fails soft to a brief over an evidence-less summary rather than 500-ing.
  router.get('/brief', async (c) => {
    const generatedAt = new Date().toISOString();
    try {
      const evidence = await collectComplianceEvidence();
      const summary = buildComplianceSummary(evidence, generatedAt);
      return c.json(buildRemediationBrief(summary));
    } catch (err) {
      logger.warn(
        { errMessage: err instanceof Error ? err.message : String(err) },
        'compliance: brief assembly failed',
      );
      return c.json(buildRemediationBrief(buildComplianceSummary([], generatedAt)));
    }
  });

  // Per-control AI analysis (latest guidance + remediation). Read-only but it
  // invokes Bedrock, so a model/parse failure returns 502.
  router.post('/analyze', async (c) => {
    const parsed = await c.req.json<{ controlId?: string }>().catch(() => null);
    const body = (parsed && typeof parsed === 'object' ? parsed : {}) as { controlId?: string };
    const controlId = (body.controlId ?? '').trim();
    if (!controlId) return c.json({ error: 'controlId is required' }, 400);

    const def = controlById(controlId);
    if (!def) return c.json({ error: `unknown controlId: ${controlId}` }, 404);

    try {
      // Grade the control against current evidence so the analyst's assessment
      // is grounded in live state, then ask the model for the latest guidance.
      const evidence = await collectComplianceEvidence();
      const evaluated = evaluateControl(def, evidence);
      const analysis = await analyzeControl(def, evaluated);
      return c.json(analysis);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ errMessage: msg, controlId }, 'compliance: analyze failed');
      return c.json({ error: `analysis failed: ${msg}` }, 502);
    }
  });

  return router;
}
