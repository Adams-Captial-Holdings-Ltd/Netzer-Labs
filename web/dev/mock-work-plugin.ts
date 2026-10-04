import type { Plugin } from 'vite';
import { approvals as seedApprovals, cases, pipeline } from './work-fixtures';

export function mockWorkPlugin(): Plugin {
  const approvals = structuredClone(seedApprovals);
  return {
    name: 'mock-work',
    apply: 'serve',
    configureServer(server) {
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
        if (mock?.startsWith('error:')) return send(503, { error: mock.slice(6) });
        if (path === '/status' && req.method === 'GET') return send(200, { enabled: mock !== 'disabled' });
        if (path === '/inbox' && req.method === 'GET')
          return send(200, {
            approverSetUp: mock !== 'not-set-up',
            approvals: mock === 'empty' ? [] : approvals.filter((a) => a.status === 'pending' && a.canDecide),
            blocked: mock === 'empty' ? [] : cases.filter((c) => c.status === 'blocked'),
            mine: mock === 'empty' ? [] : cases.slice(0, 2),
          });
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
          a.decidedBy = 'Sample Decider B';
          a.decisionComment = body.comment ?? null;
          return send(200, { ok: true, approvalId: a.id, decision: body.decision });
        }
        next();
      });
    },
  };
}
