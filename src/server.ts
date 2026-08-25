/**
 * Hono HTTP server. Mounts:
 *   - POST /tg/*      Telegram webhook adapter
 *   - POST /slack/*   Slack events + interactive adapter
 *   - GET  /api/*     Dashboard JSON API
 *   - GET  /dashboard SPA shell
 *   - GET  /status    Public status page
 *   - GET  /health    Liveness, always 200 if the process is up
 *   - GET  /ready     Readiness, 200 only when configured to serve traffic
 *   - GET  /          Minimal banner for sanity checks during deploy
 */

import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import { logger } from './observability/logger.js';
import { type Env, isReadyForTraffic } from './config/env.js';
import { buildTelegramRouter } from './adapters/telegram/handler.js';
import { buildSlackRouter } from './adapters/slack/handler.js';
import { buildDashboardRouter, buildAuthRouter } from './adapters/dashboard/handler.js';
import { buildDashboardSpaRouter } from './adapters/dashboard/spa.js';
import { buildStatusRouter } from './adapters/status/handler.js';
import { buildPanicRouter } from './adapters/dashboard/panic.js';
import { buildDlpRouter } from './adapters/dashboard/dlp.js';
import { buildWarroomRouter } from './adapters/dashboard/warroom.js';
import { buildCostCapRouter } from './adapters/dashboard/cost-cap.js';
import { buildCostRouter } from './adapters/dashboard/cost.js';
import { buildTldrRouter } from './adapters/dashboard/tldr.js';
import { buildIamCopilotRouter } from './adapters/dashboard/iam-copilot.js';
import { buildPowerRouter } from './adapters/dashboard/power.js';
import { buildDriftRouter } from './adapters/dashboard/drift.js';
import { buildRateLimitsRouter } from './adapters/dashboard/rate-limits.js';
import { buildSeatAdminRouter } from './adapters/dashboard/seat-admin.js';
import { buildNetworkPostureRouter } from './adapters/dashboard/posture-network.js';
import { buildSecurityPostureRouter } from './adapters/dashboard/posture-security.js';
import { buildIamPostureRouter } from './adapters/dashboard/posture-iam.js';
import { buildObservabilityPostureRouter } from './adapters/dashboard/posture-observability.js';
import { buildAlertsRouter } from './adapters/dashboard/alerts.js';
import { buildIntegrationsRouter } from './adapters/dashboard/integrations.js';
import { buildOAuthRouter } from './adapters/dashboard/oauth.js';
import { buildComplianceRouter } from './adapters/dashboard/compliance.js';
import { buildBrandingRouter } from './adapters/dashboard/branding.js';
import { buildJarvisRouter } from './adapters/dashboard/jarvis.js';
import { buildPaperclipDispatchRouter } from './adapters/dashboard/paperclip-dispatch.js';
// Side-effect imports: register tools into the global ToolRegistry.
// Imported here (not inside registry.ts) to avoid the circular-init
// issue where `tools` was undefined under ESM hoisting.
import './lib/tools/builtin-tools.js';
import './lib/tools/memory-tools.js';
import './lib/tools/schedule-tools.js';
import './lib/tools/agent-tools.js';
import './lib/tools/vector-tools.js';
import './lib/tools/dynamodb-tools.js';
import './lib/tools/mission-tools.js';
import './lib/tools/nova-canvas-tools.js';
import './lib/tools/email-tools.js';
import './lib/tools/web-search-tools.js';
import './lib/tools/privacy-tools.js';
import './lib/tools/document-generation-tools.js';
import './lib/tools/identity-tools.js';
import './lib/tools/salesforce-tools.js';
import './lib/tools/paperclip-tools.js';

export function buildApp(env: Env): Hono {
  const app = new Hono();

  // Security headers (X-Frame-Options, Referrer-Policy, etc.) on every
  // response. Token-in-URL auth was moved to header-based in the plan,
  // but defense-in-depth here keeps headers tight even on /health.
  app.use('*', secureHeaders());

  app.route('/tg', buildTelegramRouter());
  app.route('/slack', buildSlackRouter());
  // v5.6 routes mounted before /api catch-all so specific paths match first
  app.route('/api/panic', buildPanicRouter());
  app.route('/api/dlp', buildDlpRouter());
  app.route('/api/cost-cap', buildCostCapRouter());
  app.route('/api/cost', buildCostRouter());
  app.route('/api/tldr', buildTldrRouter());
  app.route('/api/iam', buildIamCopilotRouter());
  // Power switch proxy: status for everyone, pause for security:write; wake
  // lives only on the external panel (this app is down while paused).
  app.route('/api/power', buildPowerRouter());
  app.route('/api/drift', buildDriftRouter());
  app.route('/api/rate-limits', buildRateLimitsRouter());
  // Seat administration + seat self-service (absorbed from PR #42, no
  // workspace surface). Mounted before the /api catch-all so /api/seats/*
  // matches first; capability gates are per route group inside the router.
  app.route('/api/seats', buildSeatAdminRouter());
  app.route('/api/oauth', buildOAuthRouter());
  // Tier B read-only posture: GET-only status cards. Mounted before the
  // /api catch-all so the specific posture paths match first.
  app.route('/api/posture/network', buildNetworkPostureRouter());
  app.route('/api/posture/security', buildSecurityPostureRouter());
  app.route('/api/posture/iam', buildIamPostureRouter());
  app.route('/api/posture/observability', buildObservabilityPostureRouter());
  // Alerts (recipient management) and integrations inventory. Mounted before
  // the /api catch-all so the specific paths match first.
  app.route('/api/alerts', buildAlertsRouter());
  app.route('/api/integrations', buildIntegrationsRouter());
  // SOC 2 / HIPAA compliance gap analysis. Read-only: /summary scores the
  // control catalog against live posture evidence, /analyze runs the read-only
  // AI analyst for one control. Mounted before the /api catch-all.
  app.route('/api/compliance', buildComplianceRouter());
  // White-label branding assets. GET /asset/:id is PUBLIC (an <img src> can't send
  // a bearer and the logo renders pre-login); the upload/commit writes are admin.
  // Mounted before the /api catch-all so the specific branding paths match first.
  app.route('/api/branding', buildBrandingRouter());
  // Jarvis voice co-pilot. Mounted before the /api catch-all so the manifest +
  // text-turn routes match first. The live WS relay (attachJarvisWebSocket) is
  // wired in src/index.ts in Phase 1; Phase 0 is the text/SSE path only.
  app.route('/api/jarvis', buildJarvisRouter());
  // War room mounted at /api/warroom so the SPA's /api/warroom/* calls reach
  // the router. Mounted before the /api catch-all so the specific war-room
  // paths match first.
  app.route('/api/warroom', buildWarroomRouter());
  // Wave 4a: magic-link passwordless auth router (login / invite-validate /
  // invite-accept / verify / logout). PUBLIC — no bearer middleware; each route
  // does its own fail-closed rate limiting + constant-work handling. Mounted
  // before the /api catch-all so /api/auth/* matches before the authenticated
  // dashboard router. Member routes (GET/POST/PATCH /api/members*, /api/profiles*)
  // live on the dashboard router below and are reachable through that mount.
  app.route('/api/auth', buildAuthRouter());
  // Paperclip inbound dispatch (ADR 0010). PUBLIC to the dashboard token model:
  // C-17 settled that it authenticates on the shared PAPERCLIP_DISPATCH_SECRET,
  // not a claudeclaw-dashboard-tokens row, so it MUST be mounted before the /api
  // catch-all below — that router's `router.use('*')` bearer middleware would
  // 401 every dispatch and write an auth_failure audit row for each one.
  // Registration order is behavior here, not style; do not tidy it.
  app.route('/api/paperclip', buildPaperclipDispatchRouter());
  app.route('/api', buildDashboardRouter());
  app.route('/dashboard', buildDashboardSpaRouter());
  // D5: public status page. Mounted before /health so the route order
  // remains: webhooks → API → dashboard → status → health → ready.
  app.route('/status', buildStatusRouter());
  // Hono only matches the sub-router's '' path at /dashboard exactly;
  // a trailing-slash request hits the parent. Redirect it back so both
  // shapes serve the SPA shell.
  app.get('/dashboard/', (c) => c.redirect('/dashboard', 301));

  app.get('/health', (c) =>
    c.json({
      status: 'ok',
      uptime: process.uptime(),
      time: new Date().toISOString(),
    }),
  );

  app.get('/ready', (c) => {
    const ready = isReadyForTraffic(env);
    return c.json(
      {
        status: ready ? 'ready' : 'not_ready',
        bedrock: Boolean(env.BEDROCK_DEFAULT_MODEL ?? env.BEDROCK_SONNET_MODEL),
        slack: Boolean(env.SLACK_BOT_TOKEN),
        telegram: Boolean(env.TELEGRAM_TOKENS_JSON),
      },
      ready ? 200 : 503,
    );
  });

  // 302, not the 301 used above: a permanent redirect on the site root is
  // cached indefinitely and could not be walked back if / is ever repurposed.
  app.get('/', (c) => c.redirect('/dashboard', 302));



  app.onError((err, c) => {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, 'unhandled error');
    return c.json({ error: 'internal_error' }, 500);
  });

  app.notFound((c) => c.json({ error: 'not_found', path: c.req.path }, 404));

  return app;
}
