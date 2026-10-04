import type { Plugin } from 'vite';
import { approvals as seedApprovals, cases, pipeline } from './work-fixtures';

const decideErrors: Record<string, number> = {
  comment_required: 400, comment_too_long: 400, body_too_large: 413, invalid_body: 400,
  invalid_query: 400, unauthorized: 401, internal_error: 500, dashboard_read_disabled: 503,
  forbidden: 403, no_user_session: 403, not_an_approver: 403, class_not_entitled: 403,
  approver_inactive: 403, not_found: 404, not_a_netzer_approval: 404,
  stale_payload: 409, not_pending: 409, payload_unavailable: 409, payload_mismatch: 409,
  paperclip_rejected: 409, work_disabled: 503, paperclip_disabled: 503,
  paperclip_unavailable: 503, paperclip_locked: 503, paperclip_ratelimited: 429,
  key_unavailable: 503, attribution_mismatch: 500,
  decision_outcome_unknown: 503,
};

const SLOW_REPLY_MS = 2500;

export function mockWorkPlugin(): Plugin {
  const approvals = structuredClone(seedApprovals);
  return {
    name: 'mock-work',
    apply: 'serve',
    configureServer(server) {
      // This phone-trial sign-in exists only in the dev mock plugin, never production.
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (url.pathname !== '/__work-trial' || req.method !== 'GET') return next();
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><html><body><p>Starting work trial…</p><script>
          localStorage.setItem('cce_token', 'local-dev-dashboard-token');
          localStorage.setItem('cce_onboarded', 'true');
          localStorage.setItem('cce_role', 'admin');
          localStorage.setItem('cce_capabilities', JSON.stringify(['overview:read', 'work:read', 'work:approve', 'missions:read']));
          fetch('/api/work/__reset', { method: 'POST' }).then(() => { location.href = '/dashboard/work'; });
        </script></body></html>`);
      });
      server.middlewares.use('/api/work', async (req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const path = url.pathname;
        const mock = url.searchParams.get('mock');
        const send = (code: number, body: unknown) => {
          res.writeHead(code, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(body));
        };
        if (path === '/__reset' && req.method === 'POST') {
          approvals.splice(0, approvals.length, ...structuredClone(seedApprovals));
          return send(200, { ok: true });
        }
        if (mock === 'forbidden' && path !== '/status')
          return send(403, {
            error: 'forbidden',
            requiredCapability: req.method === 'POST' ? 'work:approve' : 'work:read',
          });
        if (mock?.startsWith('error:')) {
          const code = mock.slice(6);
          return send(decideErrors[code] ?? 500, { error: code });
        }
        if (path === '/status' && req.method === 'GET') return send(200, { enabled: mock !== 'disabled' });
        if (path === '/inbox' && req.method === 'GET') {
          const emptyInbox = mock === 'empty' || mock === 'empty-not-set-up';
          return send(200, {
            // mock=empty: nothing waits, set up. mock=empty-not-set-up: nothing, and not set up.
            // mock=not-set-up: items exist but this person cannot approve.
            approverSetUp: mock !== 'not-set-up' && mock !== 'empty-not-set-up',
            approvals: emptyInbox ? [] : approvals.filter((a) => a.status === 'pending' && a.canDecide),
            blocked: emptyInbox ? [] : cases.filter((c) => c.status === 'blocked'),
            mine: emptyInbox ? [] : cases.slice(0, 2),
          });
        }
        if (path === '/cases' && req.method === 'GET') {
          const status = url.searchParams.get('status') ?? 'active';
          if (!['active', 'blocked', 'done', 'all'].includes(status))
            return send(400, { error: 'invalid_query' });
          const filtered = cases.filter(
            (c) =>
              (!url.searchParams.get('pipeline') || c.pipeline.id === url.searchParams.get('pipeline')) &&
              (!url.searchParams.get('stage') || c.stage.key === url.searchParams.get('stage')) &&
              (status === 'all' ||
                (status === 'active' && !['done', 'cancelled'].includes(c.status)) ||
                (status === 'blocked' && c.status === 'blocked') ||
                (status === 'done' && ['done', 'cancelled'].includes(c.status))),
          );
          return send(200, {
            cases: filtered.map(({ summary: _s, fields: _f, blockers: _b, timeline: _t, ...c }) => c),
            pipelines: [pipeline],
            truncated: mock === 'truncated',
          });
        }
        const caseId = path.match(/^\/cases\/([^/]+)$/)?.[1];
        if (caseId && req.method === 'GET') {
          const c = cases.find((x) => x.id === caseId);
          return c
            ? send(200, {
                case: {
                  ...c,
                  approvals: approvals
                    .filter((a) => a.caseId === c.id)
                    .map(
                      ({
                        payloadSha256: _h,
                        payload: _p,
                        cannotDecideReason: _r,
                        decidedBy: _d,
                        decisionComment: _n,
                        ...summary
                      }) => summary,
                    ),
                },
              })
            : send(404, { error: 'not_found' });
        }
        if (path === '/approvals' && req.method === 'GET') {
          const status = url.searchParams.get('status') ?? 'pending';
          if (!['pending', 'all'].includes(status)) return send(400, { error: 'invalid_query' });
          return send(200, {
            approvals: approvals
              .filter((a) => status === 'all' || a.status === 'pending')
              .map(
                ({
                  payloadSha256: _h,
                  payload: _p,
                  cannotDecideReason: _r,
                  decidedBy: _d,
                  decisionComment: _n,
                  ...summary
                }) => summary,
              ),
            truncated: false,
          });
        }
        const approvalId = path.match(/^\/approvals\/([^/]+)$/)?.[1];
        if (approvalId && req.method === 'GET') {
          const a = approvals.find((x) => x.id === approvalId);
          return a ? send(200, { approval: a }) : send(404, { error: 'not_found' });
        }
        const decideId = path.match(/^\/approvals\/([^/]+)\/decision$/)?.[1];
        if (decideId && req.method === 'POST') {
          if (mock?.startsWith('decide:')) {
            const code = mock.slice(7);
            return send(decideErrors[code] ?? 500, { error: code });
          }
          // mock=slow: the reply comes after a pause, so the sending state can be seen.
          if (mock === 'slow') await new Promise((resolve) => setTimeout(resolve, SLOW_REPLY_MS));
          const a = approvals.find((x) => x.id === decideId);
          if (!a) return send(404, { error: 'not_found' });
          let raw = '';
          for await (const chunk of req) raw += chunk;
          let body: { decision?: string; comment?: string; payloadSha256?: string };
          try {
            body = JSON.parse(raw);
          } catch {
            return send(400, { error: 'invalid_body' });
          }
          if (body.payloadSha256 !== a.payloadSha256) return send(409, { error: 'stale_payload' });
          if (a.status !== 'pending') return send(409, { error: 'not_pending' });
          if (!a.canDecide || a.payload.state !== 'verified')
            return send(409, { error: a.cannotDecideReason ?? 'not_an_approver' });
          if (!['approve', 'reject', 'request_changes'].includes(body.decision ?? ''))
            return send(400, { error: 'invalid_body' });
          if (body.decision !== 'approve' && !body.comment?.trim())
            return send(400, { error: 'comment_required' });
          if ((body.comment?.length ?? 0) > 4000) return send(400, { error: 'comment_too_long' });
          a.status =
            body.decision === 'approve'
              ? 'approved'
              : body.decision === 'reject'
                ? 'rejected'
                : 'revision_requested';
          a.canDecide = false;
          a.cannotDecideReason = 'not_pending';
          a.decidedAt = new Date().toISOString();
          a.decidedBy = 'approver.b@example.test';
          a.decisionComment = body.comment ?? null;
          return send(200, { ok: true, approvalId: a.id, decision: body.decision });
        }
        next();
      });
    },
  };
}
