/**
 * IAM copilot router. Mounted at /api/iam (see src/server.ts).
 *
 *   POST /draft   (security:write)  plain-English -> IAM policy JSON +
 *                          explanation + static lint warnings + Access Analyzer
 *                          findings.
 *   GET  /status  (security:write)  { applyEnabled } so the UI knows whether to
 *                          show the Apply controls.
 *   POST /apply   (security:write)  actually writes to IAM. Gated by ALL of: the
 *                          security:write capability (admin/owner-tier),
 *                          runtime-config iam/apply_enabled === 'true', an
 *                          explicit confirm:true, and the iam-copilot guardrails
 *                          (no self-role, no account-wide/IAM-admin unless
 *                          allowDangerous). Every apply is audited.
 *
 * Gate switched from the legacy admin ROLE to the security:write CAPABILITY
 * (same admin/owner tier) so a custom admin-rank profile with security:write
 * stripped is correctly denied.
 *
 * Draft + status never touch IAM state; only /apply does, and only when armed.
 */

import { Hono } from 'hono';
import {
  authenticateDashboardToken,
  extractBearerToken,
  type TokenPrincipal,
} from '../../lib/auth/dashboard-auth.js';
import { principalHasRouteCapability } from '../../lib/auth/route-capability.js';
import { getConfig } from '../../lib/state/runtime-config-repo.js';
import { writeAudit, writeAuditOrThrow } from '../../lib/audit/audit-writer.js';
import { logger } from '../../observability/logger.js';
import {
  draftPolicy,
  validatePolicy,
  applyIam,
  type ApplyRequest,
  type ApplyAction,
} from '../../lib/aws/iam-copilot.js';

type IamEnv = { Variables: { principal: TokenPrincipal } };

const APPLY_ACTIONS: ApplyAction[] = [
  'create_policy',
  'put_role_policy',
  'attach_role_policy',
  'create_user',
  'put_user_policy',
  'attach_user_policy',
];

async function applyEnabled(): Promise<boolean> {
  return (await getConfig('iam', 'apply_enabled')) === 'true';
}

export function buildIamCopilotRouter(): Hono<IamEnv> {
  const router = new Hono<IamEnv>();

  // Every route here requires security:write (admin/owner-only; drafting reveals
  // policy structure, applying mutates IAM). This SWITCHES the gate from the
  // legacy admin ROLE to the security:write CAPABILITY — same admin/owner tier,
  // not a privilege change — so a custom admin-rank profile with security:write
  // stripped is correctly denied. Mirrors the warroom capability + custom-profile
  // resolution (env break-glass / owner token always passes). Authenticate +
  // gate before any handler.
  router.use('*', async (c, next) => {
    const raw = extractBearerToken(c.req.header('authorization'));
    const principal = await authenticateDashboardToken(raw);
    if (!principal) return c.json({ error: 'unauthorized' }, 401);
    c.set('principal', principal);
    if (!(await principalHasRouteCapability(principal, 'security:write'))) {
      return c.json({ error: 'forbidden', requiredCapability: 'security:write' }, 403);
    }
    await next();
  });

  router.get('/status', async (c) => {
    return c.json({ applyEnabled: await applyEnabled() });
  });

  router.post('/draft', async (c) => {
    const body = await c.req
      .json<{ instruction?: string; existingPolicy?: string }>()
      .catch(() => ({}) as { instruction?: string; existingPolicy?: string });
    const instruction = (body.instruction ?? '').trim();
    if (!instruction) return c.json({ error: 'instruction is required' }, 400);
    try {
      const draft = await draftPolicy({ instruction, existingPolicy: body.existingPolicy });
      const findings = await validatePolicy(draft.policyDocument);
      return c.json({ ...draft, findings });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ errMessage: msg }, 'iam-copilot draft failed');
      return c.json({ error: `draft failed: ${msg}` }, 502);
    }
  });

  router.post('/apply', async (c) => {
    const principal = c.get('principal');
    if (!(await applyEnabled())) {
      return c.json(
        { error: 'apply is disabled', hint: "set runtime-config iam/apply_enabled='true' to arm" },
        403,
      );
    }
    const body = await c.req
      .json<ApplyRequest & { confirm?: boolean }>()
      .catch(() => ({}) as ApplyRequest & { confirm?: boolean });

    if (body.confirm !== true) return c.json({ error: 'confirm:true is required' }, 400);
    if (!body.action || !APPLY_ACTIONS.includes(body.action)) {
      return c.json({ error: 'valid action is required', allowed: APPLY_ACTIONS }, 400);
    }

    try {
      const result = await applyIam(body);
      // C5c: an applied IAM mutation with no durable trail is the worst
      // silent failure in the app; await the audit and surface a 500 on
      // total store failure (the IAM change already happened). Its OWN
      // catch, so an audit failure is never misreported as an apply failure
      // by the outer catch below.
      try {
        await writeAuditOrThrow({
          action: 'iam_apply',
          detail: {
            iamAction: body.action,
            roleName: body.roleName,
            userName: body.userName,
            policyName: body.policyName,
            policyArn: body.policyArn,
            allowDangerous: body.allowDangerous === true,
            arn: result.arn,
          },
          userId: principal.hashPrefix16 ?? 'dashboard',
          operatorLabel: principal.label ?? undefined,
          surface: 'dashboard',
          result: 'ok',
        });
      } catch {
        return c.json(
          { error: 'IAM change applied but the audit write failed; investigate the audit stores', applied: result },
          500,
        );
      }
      return c.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ errMessage: msg, action: body.action }, 'iam-copilot apply failed');
      void writeAudit({
        action: 'iam_apply',
        detail: { iamAction: body.action, roleName: body.roleName, userName: body.userName, error: msg },
        userId: principal.hashPrefix16 ?? 'dashboard',
        operatorLabel: principal.label ?? undefined,
        surface: 'dashboard',
        result: 'error',
      });
      return c.json({ error: msg }, 400);
    }
  });

  return router;
}
